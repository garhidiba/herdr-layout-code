//! The terminal session (terminal.cjs): raw mode, the alternate screen and input modes, a wake pipe that signals
//! (SIGWINCH, SIGTERM/SIGHUP/SIGINT) and worker threads write to, Herdr right-click routing, the clipboard.

use std::io::{self, Write};
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

/// Alternate screen, bracketed paste, SGR mouse, alternate scroll off (saved first), focus reports, Kitty keyboard
/// "disambiguate", bar cursor; LEAVE undoes each.
pub const ENTER: &str = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007s\x1b[?1007l\x1b[?1004h\x1b[>1u\x1b[5 q";
pub const LEAVE: &str = "\x1b[0m\x1b[<u\x1b[?1004l\x1b[?1007r\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0 q\x1b]112\x07\x1b[?25h\x1b[?1049l";

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

/// `herdr-app <args>`; `wait` blocks until it ends (at most 1.5 s).
pub fn herdr(args: &[&str], wait: bool) {
    let Some(bin) = which("herdr-app") else { return };
    let Ok(mut child) = Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return };
    if wait {
        let end = std::time::Instant::now() + Duration::from_millis(1500);
        while std::time::Instant::now() < end {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
    } else {
        std::thread::spawn(move || child.wait());
    }
}

/// Inside a Herdr terminal, right-clicks go to the program (Shift+right-click stays Herdr's menu) while it runs.
pub fn right_clicks_to(to: &str, wait: bool) {
    if let Ok(id) = std::env::var("HC_TERMINAL_ID") {
        herdr(&["do", "terminal.right_click", "--to", to, "--terminal", &id], wait);
    }
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
    #[test]
    fn base64_pads_like_buffer_to_string() {
        assert_eq!(super::base64(b"hi"), "aGk=");
        assert_eq!(super::base64(b"abc"), "YWJj");
        assert_eq!(super::base64(b"a"), "YQ==");
    }
}
