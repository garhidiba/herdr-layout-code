//! The terminal session (terminal.cjs): raw mode, the alternate screen and input modes, a wake pipe that signals
//! (SIGWINCH, SIGTERM/SIGHUP/SIGINT) and worker threads write to, Herdr right-click routing, the clipboard.

use std::io::{self, Write};
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Alternate screen, bracketed paste, SGR mouse, alternate scroll off (saved first), focus reports, Kitty keyboard
/// "disambiguate", Shift+click reported to the app (XTSHIFTESCAPE: ghostty and xterm keep it for their own selection
/// otherwise; other terminals may still), bar cursor; LEAVE undoes each.
pub const ENTER: &str = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007s\x1b[?1007l\x1b[?1004h\x1b[>1u\x1b[>1s\x1b[5 q";
pub const LEAVE: &str = "\x1b[0m\x1b[>0s\x1b[<u\x1b[?1004l\x1b[?1007r\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0 q\x1b]112\x07\x1b[?25h\x1b[?1049l";

static WAKE_FD: AtomicI32 = AtomicI32::new(-1);
/// The last terminating signal received (0 for none).
pub static SIGNAL: AtomicI32 = AtomicI32::new(0);
static RESIZED: AtomicI32 = AtomicI32::new(0);

/// Writes one byte to the wake pipe (async-signal-safe).
pub fn wake() {
    let fd = WAKE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        // SAFETY: a one-byte write to a pipe we own; errors (full pipe) are fine to drop.
        unsafe { libc::write(fd, b"!".as_ptr().cast(), 1) };
    }
}

/// Sends wake() to `fd`, for a loop without a terminal (serve.rs).
pub fn wake_to(fd: RawFd) {
    WAKE_FD.store(fd, Ordering::Relaxed);
}

extern "C" fn on_signal(sig: libc::c_int) {
    if sig == libc::SIGWINCH {
        RESIZED.store(1, Ordering::Relaxed);
    } else {
        SIGNAL.store(sig, Ordering::Relaxed);
    }
    wake();
}

pub fn take_resized() -> bool {
    RESIZED.swap(0, Ordering::Relaxed) != 0
}

pub struct Term {
    saved: Option<libc::termios>,
    wake_read: RawFd,
    out: io::Stdout,
}

pub fn is_tty() -> bool {
    // SAFETY: isatty on the standard descriptors.
    unsafe { libc::isatty(0) == 1 && libc::isatty(1) == 1 }
}

impl Term {
    /// Raw mode, the wake pipe and the signal handlers (nothing is written yet).
    pub fn new() -> io::Result<Term> {
        let mut fds = [0; 2];
        // SAFETY: plain libc calls on our own descriptors and a zeroed termios filled by tcgetattr.
        unsafe {
            if libc::pipe(fds.as_mut_ptr()) != 0 {
                return Err(io::Error::last_os_error());
            }
            for fd in fds {
                libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK);
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            WAKE_FD.store(fds[1], Ordering::Relaxed);
            for sig in [libc::SIGWINCH, libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
                libc::signal(sig, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
            }
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
            let mut t: libc::termios = std::mem::zeroed();
            let saved = if libc::tcgetattr(0, &mut t) == 0 {
                let orig = t;
                libc::cfmakeraw(&mut t);
                libc::tcsetattr(0, libc::TCSANOW, &t);
                Some(orig)
            } else {
                None
            };
            Ok(Term { saved, wake_read: fds[0], out: io::stdout() })
        }
    }

    pub fn write(&mut self, s: &str) {
        let mut lock = self.out.lock();
        let _ = lock.write_all(s.as_bytes());
        let _ = lock.flush();
    }

    pub fn size(&self) -> (i32, i32) {
        // SAFETY: TIOCGWINSZ fills a zeroed winsize.
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        let ok = unsafe { libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) } == 0;
        if ok && ws.ws_row > 0 && ws.ws_col > 0 {
            (ws.ws_row as i32, ws.ws_col as i32)
        } else {
            (24, 80)
        }
    }

    /// Waits for input (or a wake) up to `timeout`; returns the bytes read from the terminal, and None when the
    /// input closed.
    pub fn read(&mut self, timeout: Option<Duration>) -> Option<Vec<u8>> {
        let mut fds = [libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 }, libc::pollfd { fd: self.wake_read, events: libc::POLLIN, revents: 0 }];
        let ms = timeout.map_or(-1, |d| d.as_millis().min(i32::MAX as u128) as i32);
        // SAFETY: poll on two valid descriptors.
        let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, ms) };
        if n <= 0 {
            return Some(vec![]);
        }
        let mut buf = [0u8; 4096];
        if fds[1].revents != 0 {
            // SAFETY: draining our non-blocking pipe.
            while unsafe { libc::read(self.wake_read, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
        }
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            // SAFETY: reading into our buffer.
            let r = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
            if r <= 0 {
                let e = io::Error::last_os_error().raw_os_error();
                return if r < 0 && matches!(e, Some(libc::EINTR) | Some(libc::EAGAIN)) { Some(vec![]) } else { None };
            }
            return Some(buf[..r as usize].to_vec());
        }
        Some(vec![])
    }

    /// Back to the terminal's own mode (the caller writes LEAVE first).
    pub fn restore(&mut self) {
        if let Some(t) = self.saved.take() {
            // SAFETY: restoring the attributes tcgetattr gave.
            unsafe { libc::tcsetattr(0, libc::TCSANOW, &t) };
        }
    }
}

impl Drop for Term {
    fn drop(&mut self) {
        self.restore();
    }
}

/// VSEDIT_LOG_INPUT=<file>: each raw input chunk is appended as `<ms> <JSON string>`.
pub fn log_input(chunk: &[u8]) {
    let Some(file) = std::env::var_os("VSEDIT_LOG_INPUT") else { return };
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let text = serde_json::to_string(&String::from_utf8_lossy(chunk)).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(file) {
        let _ = writeln!(f, "{ms} {text}");
    }
}

/// The caller's PATH plus the usual tool folders it lacks (lang/proc.cjs env()).
pub fn search_path() -> Vec<PathBuf> {
    let own: Vec<PathBuf> = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()).split(':').map(PathBuf::from).collect();
    let home = crate::settings::home_dir();
    let extra = [PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), home.join(".local/bin"), home.join(".cargo/bin")];
    let mut all = own.clone();
    all.extend(extra.into_iter().filter(|d| !own.contains(d)));
    all
}

/// An executable on that PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    search_path().into_iter().map(|d| d.join(name)).find(|f| std::fs::metadata(f).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// Waits for `child` at most 1.5 s, then kills it.
fn wait_briefly(child: &mut Child) {
    let end = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < end {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// `herdr-app <args>`; `wait` blocks until it ends (at most 1.5 s).
pub fn herdr(args: &[&str], wait: bool) {
    let Some(bin) = which("herdr-app") else { return };
    let Ok(mut child) = Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return };
    if wait {
        wait_briefly(&mut child);
    } else {
        std::thread::spawn(move || child.wait());
    }
}

/// herdr-app's JSON answer: `{"ok": ...}` is true; `{"error": ...}` or no answer is false.
fn answered_ok(out: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(out).ok().and_then(|v| v.get("ok").cloned()).is_some_and(|ok| !ok.is_null() && ok != false)
}

/// Bumped by each routing start and each `--to menu`: an older retry loop stops at its next attempt.
static ROUTE: AtomicUsize = AtomicUsize::new(0);
/// Held around each routing call, so a `--to menu` lands after an attempt in progress.
static ROUTE_CALL: Mutex<()> = Mutex::new(());

/// Inside a Herdr terminal, right-clicks go to the program (Shift+right-click stays Herdr's menu) while it runs.
/// A tab started with `hc run` is adopted a moment after the program starts, and until then Herdr answers
/// `{"error": "no such running terminal"}`: "program" is asked again every 150 ms on a thread until it is ok or 10 s
/// passed (and again on focus-in); "menu" stops that first.
pub fn right_clicks_to(to: &str, wait: bool) {
    let Ok(id) = std::env::var("HC_TERMINAL_ID") else { return };
    let args = ["do", "terminal.right_click", "--to", to, "--terminal", &id];
    if to != "program" {
        let _call = stop_routing();
        return herdr(&args, wait);
    }
    if let Some(bin) = which("herdr-app") {
        route(bin, args.map(String::from).to_vec(), Duration::from_millis(150), Duration::from_secs(10));
    }
}

/// Stops a retry loop; holding the guard keeps a new attempt from starting.
fn stop_routing() -> std::sync::MutexGuard<'static, ()> {
    ROUTE.fetch_add(1, Ordering::SeqCst);
    ROUTE_CALL.lock().unwrap_or_else(|e| e.into_inner())
}

/// `bin <args>` every `every` until it answers ok or `until` passed, unless a newer start or a stop came meanwhile.
fn route(bin: PathBuf, args: Vec<String>, every: Duration, until: Duration) -> std::thread::JoinHandle<()> {
    let turn = ROUTE.fetch_add(1, Ordering::SeqCst) + 1;
    let end = Instant::now() + until;
    std::thread::spawn(move || loop {
        let ok = {
            let _call = ROUTE_CALL.lock().unwrap_or_else(|e| e.into_inner());
            if ROUTE.load(Ordering::SeqCst) != turn {
                return;
            }
            let Ok(mut child) = Command::new(&bin).args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return };
            wait_briefly(&mut child);
            let mut out = String::new();
            let _ = child.stdout.take().map(|mut o| io::Read::read_to_string(&mut o, &mut out));
            answered_ok(&out)
        };
        if ok || Instant::now() + every > end {
            return;
        }
        std::thread::sleep(every);
    })
}

/// Started by the Explorer with `--close-on-exit`: the tab closes when the editor exits, and a missing file is an
/// error rather than a new file.
pub fn close_on_exit() -> bool {
    std::env::args().any(|a| a == "--close-on-exit")
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            out.push(if k <= c.len() { T[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

fn pipe_to(cmd: &str, text: &str) {
    if let Ok(mut child) = Command::new(cmd).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
    }
}

/// pbcopy on macOS, and OSC 52 (the terminal's clipboard) everywhere.
pub fn write_clipboard(term: &mut Term, text: &str) {
    if cfg!(target_os = "macos") {
        pipe_to("pbcopy", text);
    }
    term.write(&format!("\x1b]52;c;{}\x07", base64(text.as_bytes())));
}

pub fn read_clipboard() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("pbpaste").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The folder holding .git above `file`, else None.
pub fn git_root(file: &Path) -> Option<PathBuf> {
    let mut d = file.parent()?;
    loop {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        d = d.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    #[test]
    fn base64_pads_like_buffer_to_string() {
        assert_eq!(super::base64(b"hi"), "aGk=");
        assert_eq!(super::base64(b"abc"), "YWJj");
        assert_eq!(super::base64(b"a"), "YQ==");
    }

    #[test]
    fn herdr_answer_is_ok_only_for_an_ok_object() {
        assert!(super::answered_ok("{\"ok\": true}\n"));
        assert!(!super::answered_ok("{\"error\": \"no such running terminal\"}"));
        assert!(!super::answered_ok(""));
        assert!(!super::answered_ok("null"));
        assert!(!super::answered_ok("{\"ok\": false}"));
    }

    /// A fake herdr-app: logs its arguments, answers `{"error"}` to the first `fails` calls, then `{"ok": true}`.
    fn fake_herdr(fails: usize) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("vsedit-herdr-{}-{fails}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (bin, log, count) = (dir.join("herdr-app"), dir.join("log"), dir.join("count"));
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> '{}'\nn=$(cat '{c}' 2>/dev/null || echo 0); echo $((n + 1)) > '{c}'\n\
             if [ \"$n\" -lt {fails} ]; then echo '{{\"error\": \"no such running terminal\"}}'; else echo '{{\"ok\": true}}'; fi\n",
            log.display(),
            c = count.display()
        );
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (bin, log)
    }

    fn calls(log: &std::path::Path) -> usize {
        std::fs::read_to_string(log).map(|s| s.lines().count()).unwrap_or(0)
    }

    /// One test: the retry loops share the routing turn, so they must not run side by side.
    #[test]
    fn right_click_routing_retries_until_ok_gives_up_and_stops_on_menu() {
        let args = || vec!["do".to_string(), "x".into()];
        let ms = Duration::from_millis;
        // asked again until Herdr knows the terminal, then no more
        let (bin, log) = fake_herdr(2);
        super::route(bin, args(), ms(20), Duration::from_secs(10)).join().unwrap();
        assert_eq!(calls(&log), 3);
        // gives up after `until`
        let (bin, log) = fake_herdr(1_000_000);
        super::route(bin, args(), ms(20), ms(1000)).join().unwrap();
        let n = calls(&log);
        assert!((2..60).contains(&n), "{n} calls");
        // --to menu stops a loop in progress
        let (bin, log) = fake_herdr(1_000_000);
        let routing = super::route(bin, args(), ms(20), Duration::from_secs(10));
        while calls(&log) < 2 {
            std::thread::sleep(ms(10));
        }
        drop(super::stop_routing());
        routing.join().unwrap();
        let n = calls(&log);
        std::thread::sleep(ms(200));
        assert_eq!(calls(&log), n);
    }
}
