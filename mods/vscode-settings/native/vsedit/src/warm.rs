//! `--warm <key>`: started ahead of time with no file (vscode-explorer's hidden warm tab), as terminal.cjs
//! waitForFile: it shows "Ready" and waits. Once its SIGUSR2 handler is set (Term::new) it writes its pid to
//! <key>.pid (the launcher signals only then); the launcher writes "<file>\n<folder>\n" to <key> and sends SIGUSR2.
//! Nothing else starts while it waits: no grammar, no language server.

use crate::term::{self, Term};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

fn with_ext(key: &Path, ext: &str) -> PathBuf {
    let mut p = key.as_os_str().to_owned();
    p.push(ext);
    PathBuf::from(p)
}

/// Says the editor can take a file now: its pid in <key>.pid, written whole (renamed into place).
pub fn ready(key: &Path) -> std::io::Result<()> {
    if let Some(dir) = key.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = with_ext(key, ".pid.tmp");
    std::fs::write(&tmp, std::process::id().to_string())?;
    std::fs::rename(tmp, with_ext(key, ".pid"))
}

/// The (file, folder) the launcher handed over, with both files removed; None without a file (a close request).
pub fn handoff(key: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(key).unwrap_or_default();
    let _ = std::fs::remove_file(key);
    let _ = std::fs::remove_file(with_ext(key, ".pid"));
    let mut lines = text.split('\n');
    let file = lines.next().filter(|f| !f.is_empty())?.to_string();
    Some((file, lines.next().unwrap_or_default().to_string()))
}

/// Waits for the handoff (input is dropped); None when there is no file or it can't say it is ready. A terminating
/// signal or the terminal going away ends the editor, as in the editor's own loop.
pub fn wait(term: &mut Term, key: &Path) -> Option<(String, String)> {
    term.write("\x1b[2J\x1b[H\x1b[?25l  Ready");
    ready(key).ok()?;
    loop {
        let sig = term::SIGNAL.load(Ordering::Relaxed);
        if sig != 0 {
            term.restore();
            std::process::exit(128 + sig);
        }
        if term::take_close_request() {
            return handoff(key);
        }
        if term.read(None).is_none() {
            term.restore();
            std::process::exit(129);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_key(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vsedit-warm-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("warm").join("tbX")
    }

    #[test]
    fn ready_writes_this_process_pid_next_to_the_key() {
        let key = temp_key("ready");
        ready(&key).unwrap();
        assert_eq!(std::fs::read_to_string(with_ext(&key, ".pid")).unwrap(), std::process::id().to_string());
        assert!(!with_ext(&key, ".pid.tmp").exists());
        let _ = std::fs::remove_dir_all(key.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn handoff_reads_the_file_and_folder_then_removes_both_files() {
        let key = temp_key("handoff");
        ready(&key).unwrap();
        std::fs::write(&key, "/p/a b.ts\n/p\n").unwrap();
        assert_eq!(handoff(&key), Some(("/p/a b.ts".into(), "/p".into())));
        assert!(!key.exists() && !with_ext(&key, ".pid").exists());
        let _ = std::fs::remove_dir_all(key.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn a_request_without_a_file_is_a_close_request() {
        let key = temp_key("close");
        ready(&key).unwrap();
        assert_eq!(handoff(&key), None);
        assert!(!with_ext(&key, ".pid").exists());
        std::fs::write(&key, "\n/p\n").unwrap();
        assert_eq!(handoff(&key), None);
        let _ = std::fs::remove_dir_all(key.parent().unwrap().parent().unwrap());
    }
}
