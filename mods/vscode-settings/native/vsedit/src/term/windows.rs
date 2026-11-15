//! The terminal layer on Windows (hc runs the editor in a ConPTY): console modes for VT input and output, and a wake
//! event that worker threads and the console control handler set. Input comes as VT sequences (key records whose
//! characters spell them), so keys.rs parses it as on Unix; mouse records the console sends instead are written as
//! the SGR reports the editor asked for.

use super::SIGNAL;
use std::io;
use std::process::Command;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetConsoleScreenBufferInfo, GetNumberOfConsoleInputEvents, GetStdHandle, ReadConsoleInputW, SetConsoleCtrlHandler, SetConsoleMode,
    CONSOLE_MODE, CONSOLE_SCREEN_BUFFER_INFO, DISABLE_NEWLINE_AUTO_RETURN, ENABLE_EXTENDED_FLAGS, ENABLE_MOUSE_INPUT, ENABLE_PROCESSED_OUTPUT,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT, INPUT_RECORD, KEY_EVENT, LEFT_ALT_PRESSED,
    LEFT_CTRL_PRESSED, MOUSE_EVENT, MOUSE_EVENT_RECORD, MOUSE_MOVED, MOUSE_WHEELED, RIGHT_ALT_PRESSED, RIGHT_CTRL_PRESSED, SHIFT_PRESSED,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, WINDOW_BUFFER_SIZE_EVENT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, OpenProcess, SetEvent, TerminateProcess, WaitForMultipleObjects, INFINITE, PROCESS_TERMINATE};

static WAKE: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

/// Sets the wake event (the loop's read returns).
pub fn wake() {
    let event = WAKE.load(Ordering::Relaxed);
    if !event.is_null() {
        // SAFETY: an event this process created and never closes.
        unsafe { SetEvent(event) };
    }
}

/// The console is closing (the tab closed) or the process is asked to end: the loop saves a backup and exits. The
/// handler returns only when that takes too long (the system ends the process then anyway).
unsafe extern "system" fn on_ctrl(_kind: u32) -> windows_sys::core::BOOL {
    SIGNAL.store(1, Ordering::Relaxed);
    wake();
    std::thread::sleep(Duration::from_secs(10));
    1
}

pub struct Term {
    input: HANDLE,
    output: HANDLE,
    /// The console modes before raw mode, restored by restore().
    saved: Option<(CONSOLE_MODE, CONSOLE_MODE)>,
    /// Mouse buttons held, from the console's mouse records (to report releases and drags).
    buttons: u32,
    /// A high surrogate whose low half is in the next read.
    high: Option<u16>,
    pub(super) out: io::Stdout,
}

impl Term {
    /// VT input without line editing or echo, VT output, the wake event and the control handler.
    pub fn new() -> io::Result<Term> {
        // SAFETY: console calls on the standard handles with locals they fill.
        unsafe {
            let (input, output) = (GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE));
            let (mut in_mode, mut out_mode) = (0, 0);
            if GetConsoleMode(input, &mut in_mode) == 0 || GetConsoleMode(output, &mut out_mode) == 0 {
                return Err(io::Error::last_os_error());
            }
            let event = CreateEventW(std::ptr::null(), 0, 0, std::ptr::null());
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            let old = WAKE.swap(event, Ordering::Relaxed);
            if !old.is_null() {
                CloseHandle(old);
            }
            SetConsoleCtrlHandler(Some(on_ctrl), 1);
            // ENABLE_EXTENDED_FLAGS without ENABLE_QUICK_EDIT_MODE: clicks go to the editor, not to a console selection
            let raw = ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT | ENABLE_MOUSE_INPUT | ENABLE_EXTENDED_FLAGS;
            if SetConsoleMode(input, raw) == 0 {
                return Err(io::Error::last_os_error());
            }
            SetConsoleMode(output, out_mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN);
            Ok(Term { input, output, saved: Some((in_mode, out_mode)), buttons: 0, high: None, out: io::stdout() })
        }
    }

    pub fn size(&self) -> (i32, i32) {
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: fills a zeroed struct for our output handle.
        let ok = unsafe { GetConsoleScreenBufferInfo(self.output, &mut info) } != 0;
        let w = info.srWindow;
        let (rows, cols) = (w.Bottom as i32 - w.Top as i32 + 1, w.Right as i32 - w.Left as i32 + 1);
        if ok && rows > 0 && cols > 0 {
            (rows, cols)
        } else {
            (24, 80)
        }
    }

    /// Waits for input (or a wake) up to `timeout`; returns the bytes read from the terminal, and None when the
    /// input closed.
    pub fn read(&mut self, timeout: Option<Duration>) -> Option<Vec<u8>> {
        let handles = [self.input, WAKE.load(Ordering::Relaxed)];
        let ms = timeout.map_or(INFINITE, |d| d.as_millis().min(INFINITE as u128 - 1) as u32);
        // SAFETY: waiting on our console input handle and our event.
        let r = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, ms) };
        if r == WAIT_FAILED {
            return None;
        }
        if r != WAIT_OBJECT_0 {
            return Some(vec![]); // woken, or timed out
        }
        let mut count = 0;
        // SAFETY: a count for our input handle.
        if unsafe { GetNumberOfConsoleInputEvents(self.input, &mut count) } == 0 {
            return None;
        }
        let mut records: Vec<INPUT_RECORD> = vec![INPUT_RECORD::default(); count.clamp(1, 512) as usize];
        let mut got = 0;
        // SAFETY: reads at most records.len() records into the vector.
        if unsafe { ReadConsoleInputW(self.input, records.as_mut_ptr(), records.len() as u32, &mut got) } == 0 {
            return None;
        }
        let mut units: Vec<u16> = self.high.take().into_iter().collect();
        for rec in &records[..got as usize] {
            match rec.EventType as u32 {
                KEY_EVENT => {
                    // SAFETY: EventType says which union field is set.
                    let k = unsafe { rec.Event.KeyEvent };
                    let ch = unsafe { k.uChar.UnicodeChar };
                    if k.bKeyDown != 0 && ch != 0 {
                        units.extend(std::iter::repeat_n(ch, k.wRepeatCount.max(1) as usize));
                    }
                }
                MOUSE_EVENT => {
                    // SAFETY: as above.
                    if let Some(seq) = sgr_mouse(unsafe { &rec.Event.MouseEvent }, &mut self.buttons) {
                        units.extend(seq.encode_utf16());
                    }
                }
                WINDOW_BUFFER_SIZE_EVENT => super::RESIZED.store(1, Ordering::Relaxed),
                _ => {}
            }
        }
        if units.last().is_some_and(|u| (0xd800..0xdc00).contains(u)) {
            self.high = units.pop();
        }
        Some(String::from_utf16_lossy(&units).into_bytes())
    }

    /// Back to the console's own modes (the caller writes LEAVE first).
    pub fn restore(&mut self) {
        if let Some((in_mode, out_mode)) = self.saved.take() {
            // SAFETY: the modes GetConsoleMode gave, on the same handles.
            unsafe {
                SetConsoleMode(self.input, in_mode);
                SetConsoleMode(self.output, out_mode);
            }
        }
    }
}

/// A console mouse record as the SGR report a terminal would send (1-based cells; press `M`, release `m`, drags
/// with 32 added, the wheel as 64/65), tracking the held buttons in `held`; None for moves without a button.
fn sgr_mouse(m: &MOUSE_EVENT_RECORD, held: &mut u32) -> Option<String> {
    let k = m.dwControlKeyState;
    let mods = if k & SHIFT_PRESSED != 0 { 4 } else { 0 }
        + if k & (LEFT_ALT_PRESSED | RIGHT_ALT_PRESSED) != 0 { 8 } else { 0 }
        + if k & (LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED) != 0 { 16 } else { 0 };
    let (x, y) = (m.dwMousePosition.X as i32 + 1, m.dwMousePosition.Y as i32 + 1);
    let report = |code: u32, end: char| Some(format!("\x1b[<{};{x};{y}{end}", code + mods));
    // 1 left, 4 middle, 2 right → SGR 0, 1, 2
    let code_of = |bits: u32| if bits & 1 != 0 { 0 } else if bits & 4 != 0 { 1 } else { 2 };
    if m.dwEventFlags & MOUSE_WHEELED != 0 {
        return report(if (m.dwButtonState as i32 >> 16) > 0 { 64 } else { 65 }, 'M');
    }
    let (before, now) = (*held, m.dwButtonState & 7);
    *held = now;
    if now & !before != 0 {
        report(code_of(now & !before), 'M')
    } else if before & !now != 0 {
        report(code_of(before & !now), 'm')
    } else if m.dwEventFlags & MOUSE_MOVED != 0 && now != 0 {
        report(code_of(now) + 32, 'M')
    } else {
        None
    }
}

/// Whether `meta` is a file this user may run (Windows runs any file by its extension).
pub fn executable(meta: &std::fs::Metadata) -> bool {
    meta.is_file()
}

/// The names `which(name)` looks for in each folder: the programs Windows runs without a shell.
pub fn program_names(name: &str) -> Vec<String> {
    ["exe", "cmd", "bat"].iter().map(|ext| format!("{name}.{ext}")).collect()
}

/// Runs `cmd` in place of this process (Windows can't replace one): waits for it and exits with its code; returns
/// only when it can't start.
pub fn exec(cmd: &mut Command) -> io::Error {
    match cmd.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => e,
    }
}

/// Ends process `pid` (a child this editor started).
pub fn terminate(pid: u32) {
    // SAFETY: a handle to that process, closed after TerminateProcess; a process already gone gives a null handle.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }
}

/// `secs` since the epoch in local time.
pub fn local_time(secs: libc::time_t) -> libc::tm {
    // SAFETY: localtime_s fills a zeroed tm from a valid time_t.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_s(&mut tm, &secs) };
    tm
}
