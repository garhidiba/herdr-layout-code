//! A child process speaking Content-Length framed JSON on stdout (LSP, and tsserver's replies) (lang/rpc.cjs): its own
//! reader thread, requests waited on with a timeout from the thread that asks (never the editor's), every pending
//! request failed when it dies.

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type Reply = Result<Value, String>;

/// `obj` framed for an LSP server's stdin.
pub fn frame(obj: &Value) -> String {
    let s = obj.to_string();
    format!("Content-Length: {}\r\n\r\n{s}", s.len())
}

/// Reads frames from `r` until it ends: each body parsed as JSON (frames that aren't JSON are skipped).
pub fn read_frames(r: impl Read, mut on: impl FnMut(Value)) {
    let mut r = BufReader::new(r);
    let mut len: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        match r.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let head = line.trim_end();
        if head.is_empty() {
            let Some(n) = len.take() else { continue };
            let mut body = vec![0; n];
            if r.read_exact(&mut body).is_err() {
                return;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(String::from_utf8_lossy(&body).trim().as_bytes()) {
                on(v);
            }
        } else if let Some(v) = head.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("content-length")) {
            len = v.1.trim().parse().ok();
        }
    }
}

/// The process and its pending requests. The caller starts a thread on the stdout `spawn` returns.
pub struct Child {
    stdin: Mutex<Option<ChildStdin>>,
    proc: Mutex<std::process::Child>,
    pending: Mutex<HashMap<u64, Sender<Reply>>>,
    dead: Mutex<Option<String>>,
    next: AtomicU64,
    pub name: String,
}

impl Child {
    pub fn spawn(cmd: &Path, args: &[String], cwd: &Path) -> std::io::Result<(Arc<Child>, ChildStdout)> {
        let path = std::env::join_paths(crate::term::search_path()).unwrap_or_default();
        let mut proc = Command::new(cmd).args(args).current_dir(cwd).env("PATH", path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let stdout = proc.stdout.take().expect("piped stdout");
        let name = cmd.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let child = Child { stdin: Mutex::new(proc.stdin.take()), proc: Mutex::new(proc), pending: Mutex::default(), dead: Mutex::default(), next: AtomicU64::new(0), name };
        Ok((Arc::new(child), stdout))
    }
    pub fn dead(&self) -> Option<String> {
        self.dead.lock().ok()?.clone()
    }
    /// Marks it dead (its output ended) and fails every pending request.
    pub fn die(&self, why: String) {
        if let Ok(mut d) = self.dead.lock() {
            d.get_or_insert(why.clone());
        }
        for (_, tx) in self.pending.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default() {
            let _ = tx.send(Err(why.clone()));
        }
        let _ = self.proc.lock().map(|mut p| p.try_wait());
    }
    pub fn write(&self, text: &str) {
        if self.dead().is_some() {
            return;
        }
        if let Ok(mut stdin) = self.stdin.lock() {
            if let Some(s) = stdin.as_mut() {
                let _ = s.write_all(text.as_bytes()).and_then(|_| s.flush());
            }
        }
    }
    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }
    /// Writes `text` (a request with `id`) and waits for its reply at most `timeout`.
    pub fn call(&self, id: u64, text: &str, timeout: Duration) -> Reply {
        if let Some(why) = self.dead() {
            return Err(why);
        }
        let (tx, rx) = channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
        self.write(text);
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => {
                let _ = self.pending.lock().map(|mut p| p.remove(&id));
                Err("The language server did not answer in time".into())
            }
            Err(RecvTimeoutError::Disconnected) => Err(self.dead().unwrap_or_else(|| format!("{} exited", self.name))),
        }
    }
    pub fn settle(&self, id: u64, r: Reply) {
        if let Some(tx) = self.pending.lock().ok().and_then(|mut p| p.remove(&id)) {
            let _ = tx.send(r);
        }
    }
    pub fn kill(&self) {
        if let Ok(mut s) = self.stdin.lock() {
            s.take();
        }
        if let Ok(mut p) = self.proc.lock() {
            let _ = p.kill();
            let _ = p.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_are_read_by_byte_length_and_bad_ones_skipped() {
        let text = format!("{}Content-Length: 3\r\n\r\nnop{}", frame(&json!({ "a": "한" })), frame(&json!([1])));
        let mut got = vec![];
        read_frames(text.as_bytes(), |v| got.push(v));
        assert_eq!(got, vec![json!({ "a": "한" }), json!([1])]);
    }
}
