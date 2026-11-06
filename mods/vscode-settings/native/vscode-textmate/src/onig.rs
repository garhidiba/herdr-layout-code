//! vscode-oniguruma 1.7.0's `OnigScanner` (src/onig.cc) on the same Oniguruma (6.9.8, bundled by onig_sys
//! 69.8.1): patterns compiled with ONIG_OPTION_CAPTURE_GROUP, UTF-8, ONIG_SYNTAX_DEFAULT; strings under 1,000
//! bytes searched with a RegSet (position lead), longer ones regex by regex with the per-regex result cache
//! (skipped for patterns containing `\G`). Offsets are UTF-8 byte offsets; -1 for a group that did not take part.

use onig_sys as ffi;
use std::os::raw::c_int;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;

const MAX_REGIONS: c_int = 1000;

static INIT: Once = Once::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A string to search, with the id that keys the per-regex cache (vscode-oniguruma's `OnigString`).
pub struct OnigString {
    pub content: String,
    id: u64,
}

impl OnigString {
    pub fn new(content: String) -> Self {
        OnigString { content, id: NEXT_ID.fetch_add(1, Ordering::Relaxed) }
    }
}

pub struct Match {
    pub index: usize,
    /// (start, end) byte offsets per group; (-1, -1) for groups that did not match.
    pub captures: Vec<(i32, i32)>,
}

struct Regex {
    reg: *mut ffi::regex_t,
    region: *mut ffi::OnigRegion,
    has_g_anchor: bool,
    last_id: u64,
    last_pos: i32,
    last_option: ffi::OnigOptionType,
    last_matched: bool,
}

pub struct Scanner {
    rset: *mut ffi::OnigRegSet,
    regexes: Vec<Regex>,
}

fn error_text(code: c_int, info: &ffi::OnigErrorInfo) -> String {
    let mut buf = [0u8; ffi::ONIG_MAX_ERROR_MESSAGE_LEN as usize];
    // SAFETY: the buffer has the documented maximum size; `info` comes from the failed onig_new.
    let n = unsafe { ffi::onig_error_code_to_str(buf.as_mut_ptr(), code, info as *const ffi::OnigErrorInfo) };
    String::from_utf8_lossy(&buf[..n.max(0) as usize]).into_owned()
}

fn encode(region: *const ffi::OnigRegion, index: usize) -> Option<Match> {
    // SAFETY: regions come from Oniguruma after a successful search and hold num_regs entries.
    unsafe {
        let r = &*region;
        if r.num_regs > MAX_REGIONS {
            return None;
        }
        let n = r.num_regs.max(0) as usize;
        let captures = (0..n).map(|i| (*r.beg.add(i), *r.end.add(i))).collect();
        Some(Match { index, captures })
    }
}

impl Scanner {
    pub fn new(patterns: &[String]) -> Result<Scanner, String> {
        INIT.call_once(|| unsafe {
            let mut encs = [ptr::addr_of_mut!(ffi::OnigEncodingUTF8)];
            ffi::onig_initialize(encs.as_mut_ptr(), 1);
        });
        let mut regexes: Vec<Regex> = Vec::with_capacity(patterns.len());
        for p in patterns {
            let bytes = p.as_bytes();
            let mut reg: *mut ffi::regex_t = ptr::null_mut();
            let mut info = ffi::OnigErrorInfo { enc: ptr::null_mut(), par: ptr::null_mut(), par_end: ptr::null_mut() };
            // SAFETY: pattern bounds are the slice's; encoding and syntax are Oniguruma's statics.
            let status = unsafe {
                ffi::onig_new(
                    &mut reg,
                    bytes.as_ptr(),
                    bytes.as_ptr().add(bytes.len()),
                    ffi::ONIG_OPTION_CAPTURE_GROUP,
                    ptr::addr_of_mut!(ffi::OnigEncodingUTF8),
                    ffi::OnigDefaultSyntax,
                    &mut info,
                )
            };
            if status != ffi::ONIG_NORMAL as c_int {
                let msg = error_text(status, &info);
                for r in regexes {
                    // SAFETY: not yet owned by a regset.
                    unsafe {
                        ffi::onig_free(r.reg);
                        ffi::onig_region_free(r.region, 1);
                    }
                }
                return Err(msg);
            }
            regexes.push(Regex {
                reg,
                region: unsafe { ffi::onig_region_new() },
                has_g_anchor: bytes.windows(2).any(|w| w == b"\\G"),
                last_id: 0,
                last_pos: 0,
                last_option: ffi::ONIG_OPTION_NONE,
                last_matched: false,
            });
        }
        let mut regs: Vec<*mut ffi::regex_t> = regexes.iter().map(|r| r.reg).collect();
        let mut rset: *mut ffi::OnigRegSet = ptr::null_mut();
        // SAFETY: the regset takes ownership of the compiled regexes (freed with it in Drop).
        unsafe { ffi::onig_regset_new(&mut rset, regs.len() as c_int, regs.as_mut_ptr()) };
        Ok(Scanner { rset, regexes })
    }

    /// `findNextOnigScannerMatch` with option 0 (vscode-textmate never passes find options).
    pub fn find_next_match(&mut self, s: &OnigString, position: usize) -> Option<Match> {
        let data = s.content.as_bytes();
        let (start, end) = (data.as_ptr(), unsafe { data.as_ptr().add(data.len()) });
        let at = unsafe { start.add(position.min(data.len())) };
        let option = ffi::ONIG_OPTION_NONE;
        if data.len() < 1000 {
            let mut location: c_int = 0;
            // SAFETY: all pointers lie within `data`.
            let best = unsafe { ffi::onig_regset_search(self.rset, start, end, at, end, ffi::OnigRegSetLead_ONIG_REGSET_POSITION_LEAD, option, &mut location) };
            if best < 0 {
                return None;
            }
            return encode(unsafe { ffi::onig_regset_get_region(self.rset, best) }, best as usize);
        }
        let position = position as i32;
        let mut best: Option<(usize, i32)> = None;
        for (i, r) in self.regexes.iter_mut().enumerate() {
            if !r.search(s.id, start, end, at, position, option) {
                continue;
            }
            // SAFETY: a successful search filled the region.
            let location = unsafe {
                let reg = &*r.region;
                if reg.num_regs <= 0 {
                    continue;
                }
                *reg.beg
            };
            if best.is_none_or(|(_, l)| location < l) {
                best = Some((i, location));
            }
            if location == position {
                break;
            }
        }
        best.and_then(|(i, _)| encode(self.regexes[i].region, i))
    }
}

impl Regex {
    /// `searchOnigRegExp`: true when the region holds a match at or after `position`.
    fn search(&mut self, id: u64, start: *const u8, end: *const u8, at: *const u8, position: i32, option: ffi::OnigOptionType) -> bool {
        if !self.has_g_anchor {
            if self.last_id == id && self.last_option == option && self.last_pos <= position {
                if !self.last_matched {
                    return false;
                }
                // SAFETY: last_matched means the region was filled by the previous search.
                if unsafe { *(*self.region).beg } >= position {
                    return true;
                }
            }
            self.last_id = id;
            self.last_pos = position;
            self.last_option = option;
        }
        // SAFETY: all pointers lie within the searched string.
        let status = unsafe { ffi::onig_search(self.reg, start, end, at, end, self.region, option) };
        self.last_matched = status >= 0;
        self.last_matched
    }
}

impl Drop for Scanner {
    fn drop(&mut self) {
        // SAFETY: each pointer was allocated by Oniguruma in `new` and is freed once here.
        unsafe {
            for r in &self.regexes {
                ffi::onig_region_free(r.region, 1);
            }
            ffi::onig_regset_free(self.rset);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(patterns: &[&str], text: &str, pos: usize) -> Option<Match> {
        let mut s = Scanner::new(&patterns.iter().map(|p| p.to_string()).collect::<Vec<_>>()).unwrap();
        s.find_next_match(&OnigString::new(text.into()), pos)
    }

    #[test]
    fn earliest_match_wins_and_ties_go_to_the_first_pattern() {
        let m = scan(&["b", "a", "ab"], "xab", 0).unwrap();
        assert_eq!((m.index, m.captures[0]), (1, (1, 2)));
    }

    #[test]
    fn g_anchors_at_the_search_position_and_unmatched_groups_are_minus_one() {
        let m = scan(&["\\Gb(c)?"], "abd", 1).unwrap();
        assert_eq!(m.captures, vec![(1, 2), (-1, -1)]);
        assert!(scan(&["\\Gd"], "abd", 1).is_none());
    }

    #[test]
    fn long_strings_use_the_per_regex_path_with_the_same_result() {
        let text = format!("{}needle", "x".repeat(2000));
        let m = scan(&["zzz", "need(le)"], &text, 10).unwrap();
        assert_eq!((m.index, m.captures[1]), (1, (2004, 2006)));
    }

    #[test]
    fn invalid_patterns_report_oniguruma_errors() {
        assert!(Scanner::new(&["(".to_string()]).is_err());
    }
}
