//! `vsedit --serve`: the tokenizer worker (highlight.rs) behind a loopback TCP socket, for the native (GPUI) editor
//! mod `vscode-editor-native` (a spike). Herdr mods can't keep a child's stdin open (`exec` waits for the exit), but
//! they can `net.connect`, so the server binds 127.0.0.1:0, prints `{"port":N}`, detaches and serves one client.
//!
//! Newline-delimited JSON. Client → server:
//!   {"op":"open","file":path}                         read and tokenize the file (it owns the lines)
//!   {"op":"edit","start":s,"removed":r,"lines":[…]}   lines [s, s+r) became `lines`
//!   {"op":"view","first":a,"last":b}                  the visible lines: tokens are pushed for them (+ a margin)
//! Server → client:
//!   {"op":"opened","lines":[…],"scope":…,"ms":…}
//!   {"op":"colors","colors":["#rrggbb",…]}           once the grammar is loaded
//!   {"op":"tokens","seq":n,"items":[[line,[utf16Start,colorIndex,fontStyle,…]],…]}   n: edits applied so far
//! It exits when the client disconnects, or 20 s after start without one.

use crate::buffer::Change;
use crate::highlight::{font_style_of, foreground_of, Highlight};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const MARGIN: usize = 60;

pub fn run(vscode: PathBuf) -> ! {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| fail(&e.to_string()));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or_else(|e| fail(&e.to_string()));
    println!("{}", json!({ "port": port }));
    let _ = std::io::stdout().flush();
    detach();
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(20));
        std::process::exit(0); // nobody connected
    });
    match listener.accept() {
        Ok((stream, _)) => serve(stream, vscode),
        Err(_) => std::process::exit(1),
    }
    std::process::exit(0)
}

fn fail(why: &str) -> ! {
    println!("{}", json!({ "error": why }));
    std::process::exit(1)
}

/// Double fork + setsid, stdio on /dev/null, so the caller's `exec` returns at once.
fn detach() {
    // SAFETY: called before any thread exists; the children only make async-signal-safe calls until they return.
    unsafe {
        if libc::fork() != 0 {
            libc::_exit(0);
        }
        libc::setsid();
        if libc::fork() != 0 {
            libc::_exit(0);
        }
        let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
        for fd in 0..3 {
            libc::dup2(null, fd);
        }
    }
}

enum Msg {
    Client(Value),
    Wake,
    Closed,
}

struct Session {
    out: TcpStream,
    index: Value,
    lines: Vec<String>,
    sent: Vec<bool>,
    view: (usize, usize),
    colors_sent: bool,
    edits: u64,
}

pub fn serve(stream: TcpStream, vscode: PathBuf) {
    let _ = stream.set_nodelay(true);
    let (tx, rx) = mpsc::channel();
    let reader = stream.try_clone().expect("socket clone");
    let client = tx.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str(&line) {
                let _ = client.send(Msg::Client(v));
            }
        }
        let _ = client.send(Msg::Closed);
    });
    let wake = std::sync::Mutex::new(tx);
    let mut hl = Highlight::start(vscode.clone(), move || {
        let _ = wake.lock().map(|t| t.send(Msg::Wake));
    });
    let index = std::fs::read_to_string(vscode.join("index.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let mut s = Session { out: stream, index, lines: vec![], sent: vec![], view: (0, 0), colors_sent: false, edits: 0 };
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Closed => break,
            Msg::Wake => {
                hl.poll(&s.lines);
            }
            Msg::Client(v) => s.handle(&v, &mut hl),
        }
        if !s.push(&hl) {
            break;
        }
    }
}

impl Session {
    fn send(&mut self, v: &Value) -> bool {
        let mut text = v.to_string();
        text.push('\n');
        self.out.write_all(text.as_bytes()).is_ok()
    }

    fn handle(&mut self, v: &Value, hl: &mut Highlight) {
        let num = |k: &str| v[k].as_u64().unwrap_or(0) as usize;
        match v["op"].as_str() {
            Some("open") => {
                let t0 = Instant::now();
                let path = Path::new(v["file"].as_str().unwrap_or(""));
                let text = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                self.lines = vscode_textmate::split_lines(&text).into_iter().map(str::to_string).collect();
                self.sent = vec![false; self.lines.len()];
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let scope = crate::language::scope_of(&self.index, name);
                hl.reset(scope.as_deref(), &self.lines);
                self.colors_sent = false;
                let reply = json!({ "op": "opened", "lines": self.lines, "scope": scope, "ms": t0.elapsed().as_secs_f64() * 1000.0 });
                self.send(&reply);
            }
            Some("edit") => {
                let (start, removed) = (num("start").min(self.lines.len()), num("removed"));
                let removed = removed.min(self.lines.len() - start);
                let new: Vec<String> = v["lines"].as_array().map(|a| a.iter().map(|l| l.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
                let inserted = new.len();
                self.lines.splice(start..start + removed, new);
                self.sent.splice(start..start + removed, std::iter::repeat_n(false, inserted));
                hl.edited(&[Change { start, removed, inserted }], &self.lines);
                self.edits += 1;
            }
            Some("view") => self.view = (num("first"), num("last")),
            _ => {}
        }
    }

    /// Sends the colors once ready, then the tokens of the lines around the view not sent since they last changed.
    fn push(&mut self, hl: &Highlight) -> bool {
        if hl.ready && !self.colors_sent {
            self.colors_sent = true;
            let colors = json!({ "op": "colors", "colors": hl.color_map });
            if !self.send(&colors) {
                return false;
            }
        }
        let (first, last) = (self.view.0.saturating_sub(MARGIN), (self.view.1 + MARGIN).min(self.lines.len()));
        let mut items = vec![];
        for l in first..last {
            if self.sent[l] {
                continue;
            }
            let Some(toks) = hl.line(l) else { continue };
            let text = &self.lines[l];
            let mut row = Vec::with_capacity(toks.len() * 3);
            for &(byte, meta) in toks {
                row.push(text.get(..byte as usize).map_or(0, |p| p.encode_utf16().count()));
                row.push(foreground_of(meta));
                row.push(font_style_of(meta) as usize);
            }
            items.push(json!([l, row]));
            self.sent[l] = true;
        }
        items.is_empty() || self.send(&json!({ "op": "tokens", "seq": self.edits, "items": items }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn read_until(r: &mut BufReader<TcpStream>, op: &str) -> Value {
        loop {
            let mut line = String::new();
            assert!(r.read_line(&mut line).unwrap() > 0, "closed before {op}");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["op"] == op {
                return v;
            }
        }
    }

    #[test]
    fn opens_tokenizes_the_view_and_follows_edits() {
        let dir = std::env::temp_dir().join(format!("vsedit-serve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.ts");
        std::fs::write(&file, "const 한 = \"x\";\n// note\n").unwrap();
        let vscode = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vscode-viewer/vscode");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || serve(listener.accept().unwrap().0, vscode));
        let mut c = TcpStream::connect(addr).unwrap();
        let mut r = BufReader::new(c.try_clone().unwrap());
        writeln!(c, "{}", json!({ "op": "open", "file": file })).unwrap();
        writeln!(c, "{}", json!({ "op": "view", "first": 0, "last": 3 })).unwrap();
        let opened = read_until(&mut r, "opened");
        assert_eq!(opened["lines"], json!(["const 한 = \"x\";", "// note", ""]));
        assert_eq!(opened["scope"], "source.ts");
        let colors = read_until(&mut r, "colors");
        let tokens = read_until(&mut r, "tokens");
        let line0 = tokens["items"].as_array().unwrap().iter().find(|i| i[0] == 0).unwrap()[1].as_array().unwrap().clone();
        // `const` (0), then UTF-16 offsets: the string starts at 10 (한 is one unit).
        assert_eq!(line0[0], 0);
        assert!(line0.chunks(3).any(|t| t[0] == 10), "{line0:?}");
        let keyword = colors["colors"][line0[1].as_u64().unwrap() as usize].clone();
        assert_ne!(keyword, colors["colors"][1]); // not the default foreground
        writeln!(c, "{}", json!({ "op": "edit", "start": 1, "removed": 1, "lines": ["let b = 1;"] })).unwrap();
        let edited = loop {
            let t = read_until(&mut r, "tokens"); // the first view's later batches may still come (seq 0)
            if t["seq"] == 1 {
                break t;
            }
        };
        assert_eq!((edited["seq"].as_u64(), edited["items"][0][0].as_u64()), (Some(1), Some(1)));
        drop((c, r));
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
