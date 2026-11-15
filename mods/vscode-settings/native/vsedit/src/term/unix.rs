//! The terminal layer on Unix: termios raw mode, and a wake pipe that signals (SIGWINCH, SIGTERM/SIGHUP/SIGINT,
//! SIGUSR2) and worker threads write to.

use super::{CLOSE, RESIZED, SIGNAL};
use std::io;
use std::os::fd::RawFd;
use std::process::Command;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

static WAKE_FD: AtomicI32 = AtomicI32::new(-1);

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
    } else if sig == libc::SIGUSR2 {
        CLOSE.store(1, Ordering::Relaxed);
    } else {
        SIGNAL.store(sig, Ordering::Relaxed);
    }
    wake();
}

pub struct Term {
    saved: Option<libc::termios>,
    wake_read: RawFd,
    pub(super) out: io::Stdout,
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
            for sig in [libc::SIGWINCH, libc::SIGTERM, libc::SIGHUP, libc::SIGINT, libc::SIGUSR2] {
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

/// Whether `meta` is a file this user may run.
pub fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

/// The names `which(name)` looks for in each folder.
pub fn program_names(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

/// Replaces this process with `cmd`; returns only when that fails.
pub fn exec(cmd: &mut Command) -> io::Error {
    use std::os::unix::process::CommandExt;
    cmd.exec()
}

/// Ends process `pid` (a child this editor started).
pub fn terminate(pid: u32) {
    // SAFETY: kill(2) on a child this editor started; a pid already reaped is harmless here.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
}

/// `secs` since the epoch in local time.
pub fn local_time(secs: libc::time_t) -> libc::tm {
    // SAFETY: localtime_r fills a zeroed tm from a valid time_t.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    tm
}
