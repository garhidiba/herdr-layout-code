//! Orders strings as `sort` and shell globs do in the caller's locale (`strcoll` under LC_COLLATE from
//! the environment), so the repo list and the folder listing cut match the mods' shell scripts.

use std::cmp::Ordering;
use std::ffi::{c_char, c_int, CString};
use std::sync::Once;

#[cfg(any(target_os = "macos", windows))]
const LC_COLLATE: c_int = 1;
#[cfg(not(any(target_os = "macos", windows)))]
const LC_COLLATE: c_int = 3;

extern "C" {
    fn setlocale(category: c_int, locale: *const c_char) -> *mut c_char;
    fn strcoll(a: *const c_char, b: *const c_char) -> c_int;
}

pub fn compare(a: &str, b: &str) -> Ordering {
    static INIT: Once = Once::new();
    // SAFETY: called once, before any strcoll, with a valid empty C string (use the environment's locale).
    INIT.call_once(|| unsafe {
        setlocale(LC_COLLATE, c"".as_ptr());
    });
    match (CString::new(a), CString::new(b)) {
        // SAFETY: both are valid NUL-terminated strings that outlive the call.
        (Ok(x), Ok(y)) => unsafe { strcoll(x.as_ptr(), y.as_ptr()) }.cmp(&0).then_with(|| a.cmp(b)),
        _ => a.cmp(b),
    }
}
