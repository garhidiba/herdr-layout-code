//! `vsedit --serve`: the whole editor (buffer, commands, undo, find, folds, git gutter, language features) behind a
//! loopback TCP socket, for the native (GPUI) editor mod `vscode-editor-native`, which only draws what it is sent.
//! Herdr mods can't keep a child's stdin open (`exec` waits for the exit), but they can `net.connect`, so the server
//! binds 127.0.0.1:0, prints `{"port":N}`, detaches and serves one client. The protocol is in PROTOCOL.md.
//! It exits when the client disconnects or closes, or 20 s after start without one.

use crate::commands::{self, Act};
use crate::editor::Editor;
use crate::file::{self, Doc, Refusal};
use crate::highlight::Highlight;
use crate::keys::{Ev, Key};
use crate::term;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::FromRawFd;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

pub fn run(vscode: PathBuf) -> ! {
    let (index, theme) = crate::setup(&vscode).unwrap_or_else(|e| fail(&e));
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
        Ok((stream, _)) => serve(stream, Server::new(vscode, index, theme)),
        Err(_) => std::process::exit(1),
    }
    crate::lang::shutdown(); // the language servers end with the editor
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

/// Serves `stream` until the client goes or closes: requests in, replies and frames out; workers (tokenizer, git,
/// language servers, inline suggestions) wake the loop through term::wake.
pub fn serve(stream: TcpStream, mut s: Server) {
    let _ = stream.set_nodelay(true);
    let (tx, rx) = mpsc::channel();
    let reader = stream.try_clone().expect("socket clone");
    let client = tx.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let v = serde_json::from_str(&line).unwrap_or_else(|e| json!({ "op": "bad", "error": e.to_string() }));
            let _ = client.send(Msg::Client(v));
        }
        let _ = client.send(Msg::Closed);
    });
    let mut fds = [0; 2];
    // SAFETY: a pipe we own; the read end goes to a File below, the write end lives as long as the process.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } == 0 {
        term::wake_to(fds[1]);
        // SAFETY: fds[0] is the pipe's read end, owned by nothing else.
        let mut pipe = unsafe { std::fs::File::from_raw_fd(fds[0]) };
        std::thread::spawn(move || {
            let mut b = [0u8; 64];
            while pipe.read(&mut b).is_ok_and(|n| n > 0) {
                if tx.send(Msg::Wake).is_err() {
                    break;
                }
            }
        });
    }
    let mut out = stream;
    loop {
        let wait = s.deadline().map_or(Duration::from_secs(2), |d| d.saturating_duration_since(Instant::now()));
        let mut replies = match rx.recv_timeout(wait) {
            Ok(Msg::Client(v)) => s.request(&v),
            Ok(Msg::Wake) | Err(RecvTimeoutError::Timeout) => vec![],
            Ok(Msg::Closed) | Err(RecvTimeoutError::Disconnected) => break,
        };
        s.poll();
        replies.extend(s.frame());
        let text: String = replies.iter().map(|r| format!("{r}\n")).collect();
        if out.write_all(text.as_bytes()).is_err() || s.done {
            break;
        }
    }
    if let Some(ed) = &s.ed {
        ed.hot_exit(); // the tab went away: unsaved text to a backup, offered when the file opens again
    }
}

/// The editor for one client: requests in, replies and frames (only what changed since the last) out.
pub struct Server {
    vscode: PathBuf,
    index: Value,
    theme: Value,
    pub ed: Option<Editor>,
    /// The client's view: text rows and columns.
    view: (usize, usize),
    /// Each line's model as last sent, for the lines shown then.
    sent: HashMap<usize, Value>,
    rows: Vec<usize>,
    state: Map<String, Value>,
    seq: u64,
    next_poll: Instant,
    /// The client closed (or Quit ran): end after this reply.
    pub done: bool,
}

/// "shift+cmd+k" -> the key (keymap.json's chord syntax; the key itself may be "+").
fn parse_key(chord: &str) -> Key {
    let (mods, name) = match chord.strip_suffix("++") {
        Some(m) => (m, "+"),
        None => chord.rsplit_once('+').unwrap_or(("", chord)),
    };
    let has = |m: &str| mods.split('+').any(|x| x == m);
    Key { name: name.into(), ctrl: has("ctrl"), shift: has("shift"), alt: has("alt"), cmd: has("cmd") }
}

impl Server {
    pub fn new(vscode: PathBuf, index: Value, theme: Value) -> Server {
        Server { vscode, index, theme, ed: None, view: (40, 120), sent: HashMap::new(), rows: vec![], state: Map::new(), seq: 0, next_poll: Instant::now(), done: false }
    }

    /// One request; returns its replies (the frame comes from `frame`).
    pub fn request(&mut self, v: &Value) -> Vec<Value> {
        let op = v["op"].as_str().unwrap_or("");
        if op == "open" {
            return self.open(v["path"].as_str().unwrap_or(""));
        }
        let Some(ed) = self.ed.as_mut() else { return vec![json!({ "op": "error", "for": op, "message": "no file is open" })] };
        let num = |k: &str| v[k].as_u64().unwrap_or(0) as usize;
        let mut replies = vec![];
        match op {
            "command" => {
                let id = v["id"].as_str().unwrap_or("");
                match commands::by_id(id) {
                    // a paste with the client's clipboard text
                    Some(c) if c.act == Act::Paste && v["args"]["text"].is_string() => ed.handle(&Ev::Paste(v["args"]["text"].as_str().unwrap().into()), None),
                    Some(c) => ed.run_command(c, None),
                    None => replies.push(json!({ "op": "error", "for": op, "message": format!("unknown command {id}") })),
                }
            }
            "key" => ed.handle(&Ev::Key(parse_key(v["key"].as_str().unwrap_or(""))), None),
            "insert" => ed.handle(&Ev::Text(v["text"].as_str().unwrap_or("").into()), None),
            "click" | "drag" => {
                let line = num("line").min(ed.buf.lines.len() - 1);
                let text = &ed.buf.lines[line];
                let mut col = num("col").min(text.len());
                while !text.is_char_boundary(col) {
                    col -= 1;
                }
                let p = crate::buffer::pos(line, col);
                let has = |m: &str| v["mods"].as_array().is_some_and(|a| a.iter().any(|x| x == m));
                match (op, v["on"].as_str()) {
                    ("drag", _) => ed.sel.head = p,
                    (_, Some("fold")) => {
                        ed.click_fold(line);
                    }
                    (_, on) => ed.click(p, on == Some("gutter"), has("shift"), has("cmd"), v["count"].as_u64().unwrap_or(1) as u32),
                }
            }
            "view" | "scroll" => {
                let (first, last) = (num("first"), num("last"));
                self.view = (last.saturating_sub(first) + 1, v["cols"].as_u64().map_or(self.view.1, |c| c.max(1) as usize));
                (ed.top, ed.top_sub) = (first.min(ed.buf.lines.len() - 1), 0);
            }
            "save" => ed.run_act(Act::Save, None),
            "close" => {
                self.done = true;
                return vec![json!({ "op": "closed" })];
            }
            _ => replies.push(json!({ "op": "error", "for": op, "message": v["error"].as_str().map_or(format!("unknown op {op:?}"), String::from) })),
        }
        ed.after_event();
        if let Some(text) = ed.copied.take() {
            replies.push(json!({ "op": "clipboard", "text": text }));
        }
        if ed.exit.is_some() {
            self.done = true;
            replies.push(json!({ "op": "closed" }));
        }
        replies
    }

    /// Opens `path` (the first file starts the editor; later ones open beside it, as Go to File does).
    fn open(&mut self, path: &str) -> Vec<Value> {
        let file = crate::normalize(&std::env::current_dir().unwrap_or_default().join(path));
        let opened = match self.ed.as_mut() {
            Some(ed) => ed.open(&file, None, true).then_some(()).ok_or_else(|| ed.message.as_ref().map_or(String::new(), |m| m.text.clone())),
            None => self.start(&file),
        };
        if let Err(message) = opened {
            return vec![json!({ "op": "error", "for": "open", "message": message })];
        }
        self.sent.clear();
        self.state.clear();
        self.rows.clear();
        let ed = self.ed.as_mut().unwrap();
        let c = &ed.c;
        let palette = json!({
            "bg": c.bg, "fg": c.fg, "selection": c.selection, "currentLine": c.current_line, "cursor": c.cursor,
            "lineNumber": c.line_number, "lineNumberActive": c.line_number_active,
            "findMatch": c.find_match, "findOther": c.match_other, "findRange": c.find_range,
            "bracket": c.bracket_match, "word": c.word_highlight, "wordWrite": c.word_highlight_strong, "selectionMatch": c.selection_highlight,
            "gitAdded": c.git_added, "gitModified": c.git_modified, "gitDeleted": c.git_deleted,
            "foldControl": c.fold_control, "foldBackground": c.fold_background, "foldPlaceholder": c.fold_placeholder,
            "ghost": c.ghost, "guide": c.guide, "guideActive": c.guide_active, "lightBulb": c.light_bulb,
            "error": c.diag[1], "warning": c.diag[2], "info": c.diag[3],
            "statusBar": c.bar, "statusBarFg": c.bar_fg,
        });
        vec![json!({ "op": "opened", "path": ed.file, "language": ed.language, "lines": ed.buf.lines.len(), "palette": palette })]
    }

    /// The editor on `file`: as main.rs starts it, without a terminal.
    fn start(&mut self, file: &Path) -> Result<(), String> {
        let doc = match file::load(file, false) {
            Ok(Ok(doc)) => doc,
            Ok(Err(r @ Refusal::Binary)) | Ok(Err(r @ Refusal::TooLarge(_))) => return Err(r.message()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Doc::empty(), // a new file
            Err(e) => return Err(crate::errorpage::reason_of(&e)),
        };
        let hl = Highlight::start(self.vscode.clone(), term::wake);
        let mut ed = Editor::new(file.to_path_buf(), doc, hl, self.index.clone(), &self.theme, self.vscode.clone());
        ed.install_lang_hooks();
        ed.offer_backup();
        ed.note_cursor();
        let scope = ed.scope.clone();
        ed.hl.reset(scope.as_deref(), &ed.buf.lines);
        self.ed = Some(ed);
        Ok(())
    }

    /// When `poll` has something to run next.
    pub fn deadline(&self) -> Option<Instant> {
        let ed = self.ed.as_ref()?;
        Some(ed.deadline().map_or(self.next_poll, |d| d.min(self.next_poll)))
    }

    /// Takes the tokens that came, runs what is due (timers, files changed on disk, settings).
    pub fn poll(&mut self) {
        let Some(ed) = self.ed.as_mut() else { return };
        ed.hl.poll(&ed.buf.lines);
        ed.tick();
        if Instant::now() >= self.next_poll {
            self.next_poll = Instant::now() + Duration::from_secs(2);
            if ed.poll_files() {
                ed.inline_warmup();
            }
        }
        if ed.exit.is_some() {
            self.done = true;
        }
    }

    /// The next frame: what changed since the last one (None when nothing did).
    pub fn frame(&mut self) -> Option<Value> {
        let ed = self.ed.as_mut()?;
        ed.rows = self.view.0 as i32 + 2; // height(): the rows less the breadcrumbs and the status bar
        ed.cols = (self.view.1 + ed.gutter()) as i32;
        let screen = ed.screen();
        let mut out = Map::new();
        let mut sent = HashMap::with_capacity(screen.rows.len());
        let mut lines = vec![];
        for (l, v) in screen.rows.iter().zip(screen.lines) {
            if self.sent.get(l) != Some(&v) {
                lines.push(v.clone());
            }
            sent.insert(*l, v);
        }
        self.sent = sent;
        if screen.rows != self.rows {
            out.insert("rows".into(), json!(screen.rows));
            self.rows = screen.rows;
        }
        if !lines.is_empty() {
            out.insert("lines".into(), json!(lines));
        }
        for (k, v) in screen.state {
            if self.state.get(&k) != Some(&v) {
                out.insert(k.clone(), v.clone());
                self.state.insert(k, v);
            }
        }
        if out.is_empty() {
            return None;
        }
        self.seq += 1;
        out.insert("op".into(), json!("frame"));
        out.insert("seq".into(), json!(self.seq));
        Some(Value::Object(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::tests::scratch;
    use std::fs;

    fn vscode() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vscode-viewer/vscode")
    }
    fn server() -> Server {
        scratch();
        let (index, theme) = crate::setup(&vscode()).unwrap();
        Server::new(vscode(), index, theme)
    }
    /// A file with `text` in its own temp folder.
    fn file(name: &str, text: &str) -> PathBuf {
        let dir = scratch().join(format!("serve-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join(name);
        fs::write(&f, text).unwrap();
        f
    }
    /// A server on `name` with a 10-row view, every line tokenized, its first frame taken.
    fn opened(name: &str, text: &str) -> (Server, PathBuf, Value) {
        let mut s = server();
        let f = file(name, text);
        let r = s.request(&json!({ "op": "open", "path": f }));
        assert_eq!(r[0]["op"], "opened", "{r:?}");
        s.request(&json!({ "op": "view", "first": 0, "last": 9, "cols": 80 }));
        let ed = s.ed.as_mut().unwrap();
        let lines = ed.buf.lines.clone();
        assert!(ed.hl.wait(&lines, Instant::now() + Duration::from_secs(10), |h| h.has_lines(0, lines.len() - 1)));
        let first = s.frame().unwrap();
        (s, f, first)
    }
    /// A request, then the frame after it (Null when nothing changed).
    fn send(s: &mut Server, v: Value) -> Value {
        let replies = s.request(&v);
        assert!(replies.iter().all(|r| r["op"] != "error"), "{replies:?}");
        s.poll();
        s.frame().unwrap_or(Value::Null)
    }
    fn text_of(line: &Value) -> String {
        line["runs"].as_array().unwrap().iter().map(|r| r["text"].as_str().unwrap()).collect()
    }
    fn line(frame: &Value, l: usize) -> &Value {
        frame["lines"].as_array().unwrap().iter().find(|x| x["l"] == l).unwrap_or_else(|| panic!("line {l} not in {frame}"))
    }
    fn caret(frame: &Value) -> (u64, u64) {
        (frame["caret"]["line"].as_u64().unwrap(), frame["caret"]["col"].as_u64().unwrap())
    }

    #[test]
    fn the_first_frame_has_every_line_shown_colored_and_the_state() {
        let (_s, _f, fr) = opened("a.ts", "const a = \"x\";\n// note\n");
        assert_eq!((fr["op"].as_str(), fr["seq"].as_u64()), (Some("frame"), Some(1)));
        assert_eq!(fr["rows"], json!([0, 1]));
        let l0 = line(&fr, 0);
        assert_eq!(text_of(l0), "const a = \"x\";");
        let runs = l0["runs"].as_array().unwrap();
        assert_eq!(runs[0]["text"], "const");
        assert_ne!(runs[0]["fg"], runs[1]["fg"], "the keyword has its own color: {runs:?}");
        assert_eq!((caret(&fr), fr["status"]["ln"].as_u64(), fr["status"]["language"].as_str()), ((0, 0), Some(1), Some("TypeScript")));
        assert_eq!(fr["status"]["dirty"], false);
    }

    #[test]
    fn typing_sends_only_the_changed_line_and_moves_the_caret() {
        let (mut s, _f, _) = opened("t.txt", "one\ntwo\n");
        let fr = send(&mut s, json!({ "op": "click", "line": 1, "col": 3 }));
        assert_eq!((caret(&fr), fr.get("lines").is_none()), ((1, 3), true), "a caret move resends no line: {fr}");
        let fr = send(&mut s, json!({ "op": "insert", "text": "s" }));
        assert_eq!(fr["lines"].as_array().unwrap().len(), 1);
        assert_eq!((text_of(line(&fr, 1)), caret(&fr), fr["status"]["dirty"].as_bool()), ("twos".into(), (1, 4), Some(true)));
        let fr = send(&mut s, json!({ "op": "key", "key": "enter" }));
        assert_eq!((caret(&fr), fr["rows"].as_array().map(Vec::len)), ((2, 0), Some(3)));
        assert_eq!(send(&mut s, json!({ "op": "view", "first": 0, "last": 9, "cols": 80 })), Value::Null, "nothing changed");
    }

    #[test]
    fn korean_text_from_the_ime_counts_bytes_in_the_caret_and_characters_in_the_status() {
        let (mut s, f, _) = opened("k.txt", "\n");
        send(&mut s, json!({ "op": "insert", "text": "한글" }));
        let fr = send(&mut s, json!({ "op": "key", "key": "left" }));
        assert_eq!((caret(&fr), fr["status"]["col"].as_u64()), ((0, 3), Some(2)), "UTF-8 bytes; Col counts characters");
        let fr = send(&mut s, json!({ "op": "insert", "text": "x" }));
        assert_eq!(text_of(line(&fr, 0)), "한x글");
        send(&mut s, json!({ "op": "save" }));
        assert_eq!(fs::read_to_string(f).unwrap(), "한x글\n");
    }

    #[test]
    fn click_drag_shift_click_and_double_click_select() {
        let (mut s, _f, _) = opened("sel.txt", "alpha beta\ngamma\n");
        send(&mut s, json!({ "op": "click", "line": 0, "col": 1 }));
        let fr = send(&mut s, json!({ "op": "drag", "line": 1, "col": 2 }));
        assert_eq!(fr["selections"], json!([{ "anchor": { "line": 0, "col": 1 }, "head": { "line": 1, "col": 2 } }]));
        let fr = send(&mut s, json!({ "op": "click", "line": 0, "col": 8, "mods": ["shift"] }));
        assert_eq!(fr["selections"][0]["head"], json!({ "line": 0, "col": 8 }));
        let fr = send(&mut s, json!({ "op": "click", "line": 0, "col": 7, "count": 2 }));
        assert_eq!(fr["selections"], json!([{ "anchor": { "line": 0, "col": 6 }, "head": { "line": 0, "col": 10 } }]));
        assert_eq!(fr["status"]["items"][0]["text"], "Ln 1, Col 11 (4 selected)");
        let fr = send(&mut s, json!({ "op": "command", "id": "cursorLeftSelect" }));
        assert_eq!(fr["selections"][0]["head"], json!({ "line": 0, "col": 9 }));
        let fr = send(&mut s, json!({ "op": "click", "line": 0, "col": 99, "count": 3 }));
        assert_eq!(fr["selections"], json!([{ "anchor": { "line": 0, "col": 0 }, "head": { "line": 1, "col": 0 } }]), "a triple click takes the line");
    }

    #[test]
    fn undo_and_redo_take_back_a_typing_run_at_once() {
        let (mut s, _f, _) = opened("u.txt", "x\n");
        for ch in ["a", "b", "c"] {
            send(&mut s, json!({ "op": "insert", "text": ch }));
        }
        let fr = send(&mut s, json!({ "op": "command", "id": "undo" }));
        assert_eq!((text_of(line(&fr, 0)), caret(&fr)), ("x".into(), (0, 0)));
        let fr = send(&mut s, json!({ "op": "command", "id": "redo" }));
        assert_eq!(text_of(line(&fr, 0)), "abcx");
    }

    #[test]
    fn save_writes_the_file_and_says_saved() {
        let (mut s, f, _) = opened("s.txt", "old\n");
        send(&mut s, json!({ "op": "command", "id": "editor.action.selectAll" }));
        send(&mut s, json!({ "op": "insert", "text": "new" }));
        let fr = send(&mut s, json!({ "op": "command", "id": "workbench.action.files.save" }));
        assert_eq!((fr["status"]["dirty"].as_bool(), fr["status"]["left"].as_str()), (Some(false), Some("Saved")));
        assert_eq!(fs::read_to_string(f).unwrap(), "new\n");
    }

    #[test]
    fn find_counts_marks_and_steps_through_matches() {
        let (mut s, _f, _) = opened("f.txt", "foo bar\nfood foo\n");
        let fr = send(&mut s, json!({ "op": "command", "id": "actions.find" }));
        assert_eq!((fr["find"]["query"].as_str(), fr["find"]["count"].as_u64()), (Some("foo"), Some(3)), "seeded with the word at the caret");
        assert_eq!(fr["ruler"]["find"], json!([0, 1]));
        let fr = send(&mut s, json!({ "op": "insert", "text": "food" }));
        assert_eq!((fr["find"]["count"].as_u64(), fr["ruler"]["find"].clone()), (Some(1), json!([1])), "typing replaced the seed");
        send(&mut s, json!({ "op": "key", "key": "backspace" }));
        let fr = send(&mut s, json!({ "op": "key", "key": "backspace" }));
        assert_eq!((fr["find"]["query"].as_str(), fr["find"]["current"].as_u64()), (Some("fo"), Some(0)));
        assert_eq!(line(&fr, 0)["decos"][0], json!({ "from": 0, "to": 2, "kind": "findCurrent" }));
        send(&mut s, json!({ "op": "insert", "text": "o" }));
        let fr = send(&mut s, json!({ "op": "key", "key": "enter" }));
        assert_eq!((fr["find"]["current"].as_u64(), caret(&fr)), (Some(1), (1, 3)));
        let fr = send(&mut s, json!({ "op": "key", "key": "escape" }));
        assert_eq!(fr["find"], Value::Null);
    }

    #[test]
    fn toggle_line_comment_and_auto_closing_pairs_follow_the_language() {
        let (mut s, _f, _) = opened("c.ts", "let a = 1;\n");
        let fr = send(&mut s, json!({ "op": "command", "id": "editor.action.commentLine" }));
        assert_eq!(text_of(line(&fr, 0)), "// let a = 1;");
        send(&mut s, json!({ "op": "command", "id": "editor.action.commentLine" }));
        send(&mut s, json!({ "op": "command", "id": "cursorEnd" }));
        let fr = send(&mut s, json!({ "op": "insert", "text": "(" }));
        assert_eq!((text_of(line(&fr, 0)), caret(&fr)), ("let a = 1;()".into(), (0, 11)));
    }

    #[test]
    fn copy_gives_the_client_the_text_and_paste_takes_the_clients() {
        let (mut s, _f, _) = opened("p.txt", "one\n");
        send(&mut s, json!({ "op": "click", "line": 0, "col": 0, "count": 2 }));
        let r = s.request(&json!({ "op": "command", "id": "editor.action.clipboardCopyAction" }));
        assert_eq!(r, vec![json!({ "op": "clipboard", "text": "one" })]);
        send(&mut s, json!({ "op": "command", "id": "cursorEnd" }));
        let fr = send(&mut s, json!({ "op": "command", "id": "editor.action.clipboardPasteAction", "args": { "text": " two" } }));
        assert_eq!(text_of(line(&fr, 0)), "one two");
    }

    #[test]
    fn a_fold_hides_its_lines_from_the_rows_and_marks_its_header() {
        let (mut s, _f, fr) = opened("fold.ts", "function f() {\n  a();\n  b();\n}\nx;\n");
        assert_eq!(line(&fr, 0)["gutter"]["fold"], "expanded");
        let fr = send(&mut s, json!({ "op": "click", "line": 0, "col": 0, "on": "fold" }));
        assert_eq!((fr["rows"].clone(), line(&fr, 0)["gutter"]["fold"].clone()), (json!([0, 3, 4]), json!("collapsed")));
    }

    #[test]
    fn unknown_ops_and_commands_and_requests_before_open_are_errors() {
        let mut s = server();
        assert_eq!(s.request(&json!({ "op": "insert", "text": "a" }))[0]["message"], "no file is open");
        let (mut s, _f, _) = opened("e.txt", "x\n");
        assert_eq!(s.request(&json!({ "op": "command", "id": "no.such" }))[0]["op"], "error");
        assert_eq!(s.request(&json!({ "op": "nope" }))[0]["op"], "error");
        assert_eq!(s.request(&json!({ "op": "close" })), vec![json!({ "op": "closed" })]);
        assert!(s.done);
    }

    #[test]
    fn the_socket_loop_opens_pushes_frames_and_ends_when_closed() {
        let f = file("sock.ts", "const 한 = 1;\n");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || serve(listener.accept().unwrap().0, server()));
        let mut c = TcpStream::connect(addr).unwrap();
        let mut r = BufReader::new(c.try_clone().unwrap());
        // messages until one that `ok` takes
        let mut until = |ok: &dyn Fn(&Value) -> bool| loop {
            let mut l = String::new();
            assert!(r.read_line(&mut l).unwrap() > 0, "closed early");
            let v: Value = serde_json::from_str(&l).unwrap();
            if ok(&v) {
                return v;
            }
        };
        let line0 = |v: &Value| v["lines"].as_array().and_then(|ls| ls.iter().find(|l| l["l"] == 0).cloned());
        writeln!(c, "{}", json!({ "op": "open", "path": f })).unwrap();
        assert_eq!(until(&|v| v["op"] != "frame")["op"], "opened");
        // the text at once, its colors when the tokens come (the keyword gets its own run)
        until(&|v| line0(v).is_some_and(|l| l["runs"].as_array().unwrap().len() > 1));
        writeln!(c, "{}", json!({ "op": "insert", "text": "x" })).unwrap();
        until(&|v| line0(v).is_some_and(|l| l["runs"][0]["text"].as_str().is_some_and(|t| t.starts_with("xconst"))));
        writeln!(c, "{}", json!({ "op": "close" })).unwrap();
        until(&|v| v["op"] == "closed");
        thread.join().unwrap();
    }
}
