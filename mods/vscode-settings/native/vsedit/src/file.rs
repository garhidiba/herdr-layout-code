//! File boundary (file.cjs): decode into lines (remembering EOL and the trailing newline), detect indentation, save
//! atomically.

use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const MAX_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Stamp {
    pub mtime_ms: f64,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct Doc {
    pub lines: Vec<String>,
    pub crlf: bool,
    pub final_newline: bool,
    pub bom: bool,
    pub stamp: Option<Stamp>,
}

impl Doc {
    pub fn empty() -> Doc {
        Doc { lines: vec![String::new()], crlf: false, final_newline: true, bom: false, stamp: None }
    }
}

/// Why a file is not shown as text.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    Binary,
    TooLarge(u64),
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::Binary => "File seems to be binary (contains NUL bytes).".into(),
            Refusal::TooLarge(n) => format!("File is larger than 50 MB ({:.1} MB).", *n as f64 / 1048576.0),
        }
    }
}

pub fn stamp_of(meta: &fs::Metadata) -> Stamp {
    let mtime_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    Stamp { mtime_ms, size: meta.len() }
}

pub fn disk_stamp(file: &Path) -> Option<Stamp> {
    fs::metadata(file).ok().map(|m| stamp_of(&m))
}

/// `text.split(/\r\n|\n|\r/)`.
pub fn split_lines(text: &str) -> Vec<String> {
    vscode_textmate::split_lines(text).into_iter().map(str::to_string).collect()
}

pub fn decode(bytes: &[u8], lossy: bool) -> Result<Doc, Refusal> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Refusal::TooLarge(bytes.len() as u64));
    }
    if !lossy && bytes.contains(&0) {
        return Err(Refusal::Binary);
    }
    let text = String::from_utf8_lossy(bytes);
    let bom = text.starts_with('\u{feff}');
    let text = if bom { &text[3..] } else { &text[..] };
    let crlf = match (text.find("\r\n"), text.find('\n')) {
        (Some(c), Some(l)) => c < l,
        _ => false,
    };
    let mut lines = split_lines(text);
    let final_newline = lines.len() > 1 && lines.last().is_some_and(String::is_empty);
    if final_newline {
        lines.pop();
    }
    Ok(Doc { lines, crlf, final_newline, bom, stamp: None })
}

pub fn encode(lines: &[String], doc: &Doc) -> String {
    let eol = if doc.crlf { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(lines.iter().map(|l| l.len() + 2).sum());
    if doc.bom {
        out.push('\u{feff}');
    }
    out.push_str(&lines.join(eol));
    if doc.final_newline {
        out.push_str(eol);
    }
    out
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Indent {
    pub use_tabs: bool,
    pub size: usize,
}

/// VS Code-style guess: tabs when most indented lines start with a tab, else the most common small space step;
/// `fallback` when no line is indented.
pub fn detect_indent(lines: &[String], fallback: Indent) -> Indent {
    let (mut tabs, mut steps) = (0usize, std::collections::BTreeMap::<usize, usize>::new());
    for l in lines.iter().take(2000) {
        if l.starts_with('\t') {
            tabs += 1;
            continue;
        }
        let n = l.bytes().take_while(|b| *b == b' ').count();
        if n > 0 && n <= 8 && l[n..].chars().next().is_some_and(|c| !c.is_whitespace()) {
            *steps.entry(n).or_default() += 1;
        }
    }
    let space_lines: usize = steps.values().sum();
    if tabs == 0 && space_lines == 0 {
        return fallback;
    }
    let need = (space_lines.min(2) as f64).max(space_lines as f64 * 0.1);
    let size = steps.iter().find(|(_, n)| **n as f64 >= need).map_or(4, |(k, _)| *k);
    if tabs > space_lines {
        Indent { use_tabs: true, size: 4 }
    } else {
        Indent { use_tabs: false, size }
    }
}

fn head_is_binary(file: &Path) -> io::Result<bool> {
    let mut head = vec![0u8; 8192];
    let n = fs::File::open(file)?.read(&mut head)?;
    Ok(head[..n].contains(&0))
}

/// Ok(Ok(doc)) when it opens as text, Ok(Err(refusal)) when it is binary or too large, Err on an I/O error.
pub fn load(file: &Path, lossy: bool) -> io::Result<Result<Doc, Refusal>> {
    let meta = fs::metadata(file)?;
    if meta.is_dir() {
        return Err(io::Error::from_raw_os_error(libc::EISDIR));
    }
    if meta.len() > MAX_BYTES {
        return Ok(Err(if !lossy && head_is_binary(file)? { Refusal::Binary } else { Refusal::TooLarge(meta.len()) }));
    }
    let bytes = fs::read(file)?;
    Ok(decode(&bytes, lossy).map(|mut doc| {
        doc.stamp = disk_stamp(file);
        doc
    }))
}

/// The new stamp when the file changed since `known` (None when it's gone or the same).
pub fn changed_on_disk(file: &Path, known: Option<Stamp>) -> Option<Stamp> {
    let now = disk_stamp(file)?;
    (Some(now) != known).then_some(now)
}

/// Writes to a temp file next to the target, keeps its mode, then renames over it. Returns the new stamp.
pub fn save(file: &Path, text: &str) -> io::Result<Stamp> {
    let file: PathBuf = fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf()); // a symlink keeps pointing at it
    let mode = fs::metadata(&file).map(|m| m.permissions().mode() & 0o7777).unwrap_or(0o644);
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = file.with_file_name(format!(".{name}.vsedit-{}.tmp", std::process::id()));
    let result = (|| {
        fs::write(&tmp, text)?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        fs::rename(&tmp, &file)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(disk_stamp(&file).unwrap_or(Stamp { mtime_ms: 0.0, size: 0 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn crlf_bom_and_final_newline_round_trip() {
        let doc = decode("\u{feff}one\r\ntwo\r\n".as_bytes(), false).unwrap();
        assert_eq!((doc.lines.clone(), doc.crlf, doc.bom, doc.final_newline), (lines(&["one", "two"]), true, true, true));
        assert_eq!(encode(&doc.lines, &doc), "\u{feff}one\r\ntwo\r\n");
        assert_eq!(decode(b"a\0b", false).unwrap_err(), Refusal::Binary);
        assert_eq!(decode(b"a\0b", true).unwrap().lines, lines(&["a\0b"]));
    }

    #[test]
    fn indentation_is_tabs_or_the_common_space_step() {
        let fb = Indent { use_tabs: false, size: 4 };
        assert_eq!(detect_indent(&lines(&["a", "  b", "  c", "    d"]), fb), Indent { use_tabs: false, size: 2 });
        assert_eq!(detect_indent(&lines(&["\ta", "\tb"]), fb), Indent { use_tabs: true, size: 4 });
        assert_eq!(detect_indent(&lines(&["a"]), Indent { use_tabs: true, size: 8 }), Indent { use_tabs: true, size: 8 });
    }
}
