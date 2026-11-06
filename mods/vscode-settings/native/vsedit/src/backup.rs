//! Hot exit (backup.cjs): unsaved text kept in <herdr home>/mods/vscode-viewer/.backups/<path hash>.json when the
//! editor is closed from outside, offered back the next time the file opens. Same format and folder as the JS editor:
//! { path, text, cursor: { line, col (UTF-16) }, time (ms), mtimeMs, size }.

use crate::file::disk_stamp;
use crate::settings::herdr_home;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub fn backup_dir() -> PathBuf {
    std::env::var_os("VSEDIT_BACKUPS").map(PathBuf::from).unwrap_or_else(|| herdr_home().join("mods/vscode-viewer/.backups"))
}

/// djb2-xor over UTF-16 units in base 36 (main.js's hash).
pub fn path_hash(s: &str) -> String {
    let mut h: u32 = 5381;
    for u in s.encode_utf16() {
        h = h.wrapping_mul(33) ^ u as u32;
    }
    let mut out = vec![];
    loop {
        out.push(std::char::from_digit(h % 36, 36).unwrap());
        h /= 36;
        if h == 0 {
            break;
        }
    }
    out.iter().rev().collect()
}

pub fn backup_file(file: &Path) -> PathBuf {
    backup_dir().join(format!("{}.json", path_hash(&file.to_string_lossy())))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// Synchronous: it runs right before the process ends. `cursor` is (line, UTF-16 col).
pub fn write(file: &Path, text: &str, cursor: (usize, usize)) -> std::io::Result<()> {
    let st = disk_stamp(file);
    let out = backup_file(file);
    let tmp = out.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::create_dir_all(backup_dir())?;
    let v = json!({ "path": file.to_string_lossy(), "text": text, "cursor": { "line": cursor.0, "col": cursor.1 }, "time": now_ms() as u64,
        "mtimeMs": st.map(|s| s.mtime_ms), "size": st.map(|s| s.size) });
    fs::write(&tmp, v.to_string())?;
    fs::rename(&tmp, &out)
}

pub struct Backup {
    pub text: String,
    pub cursor: Option<(usize, usize)>,
    pub time: f64,
    mtime_ms: Option<f64>,
    size: Option<u64>,
}

/// The backup for this exact path.
pub fn read(file: &Path) -> Option<Backup> {
    let v: Value = serde_json::from_str(&fs::read_to_string(backup_file(file)).ok()?).ok()?;
    if v.get("path").and_then(Value::as_str) != Some(&*file.to_string_lossy()) {
        return None;
    }
    let cursor = v.get("cursor").and_then(|c| Some((c.get("line")?.as_u64()? as usize, c.get("col")?.as_u64()? as usize)));
    Some(Backup {
        text: v.get("text")?.as_str()?.to_string(),
        cursor,
        time: v.get("time").and_then(Value::as_f64).unwrap_or(0.0),
        mtime_ms: v.get("mtimeMs").and_then(Value::as_f64),
        size: v.get("size").and_then(Value::as_u64),
    })
}

pub fn remove(file: &Path) {
    let _ = fs::remove_file(backup_file(file));
}

/// True when the file on disk is no longer what it was when the backup was written (to the second).
pub fn changed_since(b: &Backup, file: &Path) -> bool {
    let st = disk_stamp(file);
    match (b.mtime_ms, st) {
        (None, st) => st.is_some(),
        (Some(_), None) => true,
        (Some(m), Some(s)) => (s.mtime_ms / 1000.0).floor() != (m / 1000.0).floor() || Some(s.size) != b.size,
    }
}

/// "2026-11-06 14:03" in local time.
pub fn stamp_text(ms: f64) -> String {
    let secs = (ms / 1000.0) as libc::time_t;
    // SAFETY: localtime_r fills a zeroed tm from a valid time_t.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!("{}-{:02}-{:02} {:02}:{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hash_matches_main_js() {
        // node -e 'let h=5381;for(const c of "/tmp/a.txt")h=(h*33^c.charCodeAt(0))>>>0;console.log(h.toString(36))'
        assert_eq!(path_hash("/tmp/a.txt"), "1c9ga7v");
    }
}
