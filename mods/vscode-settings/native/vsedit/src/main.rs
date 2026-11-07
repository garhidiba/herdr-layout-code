//! vsedit: the terminal editor of the herdr-layout-vscode mods (mods/vscode-viewer/editor/vsedit.cjs) in Rust.
//! usage: vsedit <file> [--close-on-exit] [--vscode <dir>] [--fallback <vsedit.cjs>]
//!        vsedit --serve [--vscode <dir>]   (the editor for the native editor mod, over a socket: serve.rs)
//! When it can't start (no grammars, no raw mode) it execs `node <vsedit.cjs>` with the same arguments before
//! touching the terminal (the launcher, vsedit.sh, passes the path); without --fallback it exits 86 then.

mod app;
mod autoclose;
mod backup;
mod buffer;
mod commands;
mod decorations;
mod editor;
mod errorpage;
mod file;
mod find;
mod folding;
mod frame;
mod gitgutter;
mod hexview;
mod highlight;
mod inline;
mod keys;
mod lang;
mod language;
mod overlays;
mod paint;
mod scrollbar;
mod serve;
mod settings;
mod smartselect;
mod symbols;
mod term;
mod view;
mod width;
mod wrap;

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

/// Loads the shared key table; returns the grammar index and the theme (Null when it can't be read).
fn setup(vscode: &Path) -> Result<(serde_json::Value, serde_json::Value), String> {
    commands::load_commands(&vscode.join("../editor/keymap.json"))?;
    let Ok(index) = std::fs::read_to_string(vscode.join("index.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else {
        return Err("no grammars at --vscode".into());
    };
    let theme = std::fs::read_to_string(vscode.join("theme.json")).ok().and_then(|t| vscode_textmate::parse_jsonc(&t).ok()).unwrap_or(serde_json::Value::Null);
    Ok((index, theme))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut file, mut vscode, mut js, mut rest, mut serve) = (None, None, None, vec![], false);
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
            "--serve" => serve = true,
            _ => {
                if file.is_none() && !a.starts_with("--") {
                    file = Some(a.clone());
                }
                rest.push(a);
            }
        }
    }
    if serve {
        serve::run(vscode_dir(vscode));
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
    // a key table this binary doesn't know (or none), no grammars: the JS editor
    let (index, theme) = setup(&vscode).unwrap_or_else(|e| fallback(&e));
    let colors = theme.get("colors").cloned().unwrap_or(serde_json::Value::Null);

    let Ok(mut term) = Term::new() else { fallback("no raw mode") };
    let doc = open(&mut term, &file, &paint::Palette::of(&colors));
    let hl = Highlight::start(vscode.clone(), term::wake);
    let mut ed = Editor::new(file.clone(), doc, hl, index, &theme, vscode);
    ed.install_lang_hooks();
    let message = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let m = message.clone();
    std::panic::set_hook(Box::new(move |info| {
        let text = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_default();
        *m.lock().unwrap() = format!("{text}{}", info.location().map(|l| format!(" ({}:{})", l.file(), l.line())).unwrap_or_default());
    }));
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut term, &mut ed))).is_err() {
        // a crash: unsaved text to a backup, then the error page; Try Again starts the editor again in this terminal
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ed.hot_exit()));
        leave(&mut term);
        let reason = format!("vsedit crashed: {}", message.lock().map(|m| m.clone()).unwrap_or_default());
        let mut page = errorpage::ErrorPage::new(&file, &reason, editor::breadcrumbs(&file), ed.c.clone());
        if app::run(&mut term, &mut page) == errorpage::Choice::Retry {
            term.restore();
            lang::shutdown();
            use std::os::unix::process::CommandExt;
            let e = std::process::Command::new(std::env::current_exe().unwrap_or_default()).args(std::env::args().skip(1)).exec();
            eprintln!("vsedit: {e}");
        }
        close(&mut term, &file, &reason);
    }
}

/// The document to edit: binary files go to the hex viewer (after asking, unless the name says binary; Open Anyway
/// decodes them as text), files that can't be opened to the error page (Try Again comes back here).
fn open(term: &mut Term, file: &Path, c: &paint::Palette) -> file::Doc {
    loop {
        let crumbs = editor::breadcrumbs(file);
        let named = hexview::binary_name(file);
        let reason = match if named { Ok(Err(file::Refusal::Binary)) } else { file::load(file, false) } {
            Ok(Ok(doc)) => return doc,
            Ok(Err(file::Refusal::Binary)) => match hex(term, file, !named, crumbs.clone(), c) {
                Ok(()) => match file::load(file, true) {
                    Ok(Ok(doc)) => return doc,
                    Ok(Err(r)) => r.message(),
                    Err(e) => errorpage::reason_of(&e),
                },
                Err(e) => errorpage::reason_of(&e),
            },
            Ok(Err(r)) => r.message(),
            // started by hand, a missing file is a new one; the Explorer only opens files that exist
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !term::close_on_exit() => return file::Doc::empty(),
            Err(e) => errorpage::reason_of(&e),
        };
        let mut page = errorpage::ErrorPage::new(file, &reason, crumbs, c.clone());
        if app::run(term, &mut page) == errorpage::Choice::Close {
            close(term, file, &reason);
        }
    }
}

/// The hex viewer (after the binary prompt when `ask`): Ok when the user picked Open Anyway; quitting exits.
fn hex(term: &mut Term, file: &Path, ask: bool, crumbs: Vec<String>, c: &paint::Palette) -> std::io::Result<()> {
    let reader = hexview::Reader::open(file)?;
    if ask {
        match app::run(term, &mut hexview::BinaryPrompt::new(crumbs.clone(), c.clone())) {
            None => exit(0),
            Some(hexview::Choice::Text) => return Ok(()),
            Some(hexview::Choice::Hex) => {}
        }
    }
    app::run(term, &mut hexview::HexView::new(reader, crumbs, c.clone()))?;
    term.restore();
    exit(0)
}

/// Close on the error page: the tab closes when the Explorer opened it; otherwise one line on stderr.
fn close(term: &mut Term, file: &Path, reason: &str) -> ! {
    term.restore();
    if !term::close_on_exit() {
        eprintln!("vsedit: {}: {reason}", file.file_name().map(|n| n.to_string_lossy()).unwrap_or_default());
    }
    exit(1)
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

fn run(term: &mut Term, ed: &mut Editor) {
    term.write(&format!("{}{}\x1b]12;{}\x07", term::ENTER, ed.settings.cursor_seq(), ed.c.cursor));
    term::right_clicks_to("program", false);
    if let Some(e) = ed.keys.error.clone() {
        let w = ed.c.warn.clone();
        ed.say(e, Some(&w), 6000);
    }

    let mut title = String::new(); // written only when it changes
    let mut draw = |ed: &mut Editor, term: &mut Term| {
        (ed.rows, ed.cols) = term.size();
        let now = ed.title();
        let mut out = if now == title { String::new() } else { format!("\x1b]2;{now}\x07") };
        title = now;
        out.push_str(&ed.render());
        // The cursor shape goes out with every frame: Herdr resets it on focus, tab switches and resizes, and a setting may have changed.
        // one synchronized update (mode 2026): the terminal shows the frame whole, never the text under a box before the box
        term.write(&format!("\x1b[?2026h\x1b[?25l{}{out}\x1b[?2026l", ed.settings.cursor_seq()));
    };
    ed.offer_backup();
    ed.note_cursor(); // where Cursor Undo goes back to first
    let scope = ed.scope.clone();
    ed.hl.reset(scope.as_deref(), &ed.buf.lines);
    draw(ed, term); // the text at once, uncolored
    let (top, rows) = (ed.top, ed.height());
    let lines = std::mem::take(&mut ed.buf.lines);
    ed.hl.wait(&lines, Instant::now() + Duration::from_millis(1000), |h| h.has_lines(top, top + rows));
    ed.buf.lines = lines;
    draw(ed, term); // the first colored screen waits for its colors
    ed.inline_warmup();

    let mut pending = String::new();
    let mut raw: Vec<u8> = vec![];
    let mut escape_at: Option<Instant> = None;
    let mut next_poll = Instant::now() + Duration::from_secs(2);
    loop {
        let sig = term::SIGNAL.load(std::sync::atomic::Ordering::Relaxed);
        if sig != 0 {
            quit(ed, term, 128 + sig);
        }
        let deadline = [ed.deadline(), Some(next_poll), escape_at].into_iter().flatten().min();
        let timeout = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        let Some(chunk) = term.read(timeout) else { quit(ed, term, 129) };
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
                        ed.handle(&ev, Some(term));
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
            ed.handle(&keys::key("escape"), Some(term));
            changed = true;
        }
        if term::take_resized() {
            changed = true;
        }
        let lines = std::mem::take(&mut ed.buf.lines);
        changed |= ed.hl.poll(&lines);
        ed.buf.lines = lines;
        if ed.ls.peek.is_some() {
            changed |= ed.poll_docs(); // the peek box colors lines of other files
        }
        changed |= ed.tick();
        if Instant::now() >= next_poll {
            next_poll = Instant::now() + Duration::from_secs(2);
            if ed.poll_files() {
                ed.inline_warmup();
                changed = true;
            }
        }
        if let Some(code) = ed.exit {
            leave(term);
            exit(code);
        }
        if changed {
            draw(ed, term);
        }
    }
}

/// Leaves the terminal as it was; the language servers end with the editor.
fn leave(term: &mut Term) {
    lang::shutdown();
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
