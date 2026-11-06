//! vsedit: the terminal editor of the herdr-layout-vscode mods (mods/vscode-viewer/editor/vsedit.cjs) in Rust.
//! usage: vsedit <file> [--close-on-exit] [--vscode <dir>] [--fallback <vsedit.cjs>]
//! When it can't take the file (no grammars, or a part still JS-only: binary files, the error page) it execs
//! `node <vsedit.cjs>` with the same arguments before touching the terminal (the launcher, vsedit.sh, passes the
//! path); without --fallback it exits 86 then.

mod autoclose;
mod backup;
mod buffer;
mod commands;
mod decorations;
mod editor;
mod file;
mod find;
mod folding;
mod gitgutter;
mod highlight;
mod keys;
mod language;
mod overlays;
mod paint;
mod scrollbar;
mod settings;
mod term;
mod view;
mod width;

use editor::Editor;
use highlight::Highlight;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{Duration, Instant};
use term::Term;

/// The launcher accepts a binary whose `--api` prints this (bump it when the launch contract changes).
const API: u32 = 1;
const FALLBACK: i32 = 86;

static JS: std::sync::OnceLock<(String, Vec<String>)> = std::sync::OnceLock::new();

fn fallback(why: &str) -> ! {
    if std::env::var_os("VSEDIT_DEBUG").is_some() {
        eprintln!("vsedit: using the JS editor: {why}");
    }
    if let Some((js, args)) = JS.get() {
        use std::os::unix::process::CommandExt;
        if let Some(log) = std::env::var_os("VSEDIT_ENGINE_LOG") {
            let _ = std::fs::OpenOptions::new().append(true).create(true).open(log).and_then(|mut f| std::io::Write::write_all(&mut f, b"js (fallback)\n"));
        }
        let node = term::which("node").unwrap_or_else(|| PathBuf::from("node"));
        let e = std::process::Command::new(node).arg(js).args(args).exec();
        eprintln!("vsedit: cannot start the JS editor: {e}");
    }
    exit(FALLBACK)
}

/// `--vscode <dir>`, else <exe dir>/../mods/vscode-viewer/vscode (the installed layout).
fn vscode_dir(arg: Option<String>) -> PathBuf {
    if let Some(d) = arg {
        return PathBuf::from(d);
    }
    let exe = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)).unwrap_or_default();
    exe.join("../mods/vscode-viewer/vscode")
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut file, mut vscode, mut js, mut rest) = (None, None, None, vec![]);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--api" => {
                println!("{API}");
                return;
            }
            "--version" => {
                println!("vsedit {} (api {API})", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--vscode" => vscode = args.next(),
            "--fallback" => js = args.next(),
            _ => {
                if file.is_none() && !a.starts_with("--") {
                    file = Some(a.clone());
                }
                rest.push(a);
            }
        }
    }
    if let Some(js) = js {
        let _ = JS.set((js, rest));
    }
    let Some(arg) = file else {
        eprintln!("usage: vsedit <file> [--close-on-exit] [--vscode <dir>]");
        exit(2)
    };
    if !term::is_tty() {
        eprintln!("vsedit: needs a terminal");
        exit(1);
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let file = normalize(&cwd.join(arg));
    let vscode = vscode_dir(vscode);
    let Ok(index) = std::fs::read_to_string(vscode.join("index.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else {
        fallback("no grammars at --vscode");
    };
    let colors = std::fs::read_to_string(vscode.join("theme.json"))
        .ok()
        .and_then(|t| vscode_textmate::parse_jsonc(&t).ok())
        .and_then(|t| t.get("colors").cloned())
        .unwrap_or(serde_json::Value::Null);

    // Binary files and files that can't be opened stay with the JS editor (its hex viewer and error page).
    let doc = match file::load(&file, false) {
        Ok(Ok(doc)) => doc,
        Ok(Err(_)) => fallback("binary or too large"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !term::close_on_exit() => file::Doc::empty(),
        Err(_) => fallback("cannot open the file"),
    };
    run(file, doc, vscode, index, &colors);
}

/// The path with `.` and `..` resolved lexically (as path.resolve does).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

fn run(file: PathBuf, doc: file::Doc, vscode: PathBuf, index: serde_json::Value, colors: &serde_json::Value) {
    let hl = Highlight::start(vscode, term::wake);
    let mut ed = Editor::new(file, doc, hl, index, colors);
    let Ok(mut term) = Term::new() else { fallback("no raw mode") };
    term.write(&format!("{}\x1b]12;{}\x07", term::ENTER, ed.c.cursor));
    term::right_clicks_to("program", false);
    if let Some(e) = ed.keys.error.clone() {
        let w = ed.c.warn.clone();
        ed.say(e, Some(&w), 6000);
    }

    let draw = |ed: &mut Editor, term: &mut Term| {
        (ed.rows, ed.cols) = term.size();
        let out = ed.render();
        term.write(&format!("\x1b[?25l{out}"));
    };
    ed.offer_backup();
    let scope = ed.scope.clone();
    ed.hl.reset(scope.as_deref(), &ed.buf.lines);
    draw(&mut ed, &mut term); // the text at once, uncolored
    let (top, rows) = (ed.top, ed.height());
    let lines = std::mem::take(&mut ed.buf.lines);
    ed.hl.wait(&lines, Instant::now() + Duration::from_millis(1000), |h| h.has_lines(top, top + rows));
    ed.buf.lines = lines;
    draw(&mut ed, &mut term); // the first colored screen waits for its colors

    let mut pending = String::new();
    let mut raw: Vec<u8> = vec![];
    let mut escape_at: Option<Instant> = None;
    let mut next_poll = Instant::now() + Duration::from_secs(2);
    loop {
        let sig = term::SIGNAL.load(std::sync::atomic::Ordering::Relaxed);
        if sig != 0 {
            quit(&ed, &mut term, 128 + sig);
        }
        let deadline = [ed.deadline(), Some(next_poll), escape_at].into_iter().flatten().min();
        let timeout = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        let Some(chunk) = term.read(timeout) else { quit(&ed, &mut term, 129) };
        let mut changed = false;
        if !chunk.is_empty() {
            term::log_input(&chunk);
            raw.extend_from_slice(&chunk);
            let valid = match std::str::from_utf8(&raw) {
                Ok(_) => raw.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => raw.len(),
            };
            pending.push_str(&String::from_utf8_lossy(&raw[..valid]));
            raw.drain(..valid);
            let (events, rest) = keys::parse(&pending);
            pending = rest;
            escape_at = (!pending.is_empty()).then(|| Instant::now() + Duration::from_millis(50));
            changed |= events.is_empty();
            for ev in events {
                match ed.hover(&ev) {
                    Some(out) => {
                        if !out.is_empty() {
                            term.write(&out);
                        }
                    }
                    None => {
                        ed.handle(&ev, &mut term);
                        ed.after_event();
                        changed = true;
                    }
                }
            }
        }
        if escape_at.is_some_and(|t| t <= Instant::now()) {
            // a split escape sequence that never completed was a plain Esc
            escape_at = None;
            pending.clear();
            ed.handle(&keys::key("escape"), &mut term);
            changed = true;
        }
        if term::take_resized() {
            changed = true;
        }
        let lines = std::mem::take(&mut ed.buf.lines);
        changed |= ed.hl.poll(&lines);
        ed.buf.lines = lines;
        changed |= ed.tick();
        if Instant::now() >= next_poll {
            next_poll = Instant::now() + Duration::from_secs(2);
            changed |= ed.poll_files();
        }
        if let Some(code) = ed.exit {
            leave(&mut term);
            exit(code);
        }
        if changed {
            draw(&mut ed, &mut term);
        }
    }
}

fn leave(term: &mut Term) {
    term.write(term::LEAVE);
    term.restore();
    term::right_clicks_to("menu", true);
}

/// Closed from outside (tab closed, terminal gone): unsaved text goes to a backup, then leave.
fn quit(ed: &Editor, term: &mut Term, code: i32) -> ! {
    ed.hot_exit();
    leave(term);
    exit(code)
}
