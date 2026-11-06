//! The editor's language features (vsedit.cjs "language features" … "Go to Symbol in Workspace"): definitions,
//! references and calls (peek, panel), rename and Change All Occurrences, formatting, code actions and quick fixes with
//! the light bulb, hover, diagnostics, document and workspace symbols, smart select, cursor undo, the context menu and
//! the command palette. Every server request runs on a thread of its own; its result comes back as a job the editor
//! runs between input events, dropped when the text (or the file) changed meanwhile.

use super::{Editor, IAct, PAct, Popup};
use crate::buffer::{edit, pos, Edit, Pos, Sel};
use crate::commands::{self, Act, Command};
use crate::lang::edits::{self as E, byte_of, p16, u16_of, TextEdit, WorkspaceEdit, P16};
use crate::lang::fallback::word_occurrences;
use crate::lang::semantic::SemanticTheme;
use crate::lang::{self, Action, Ctx, Diag, Loc, Session, WsSymbol};
use crate::overlays::{filter, fuzzy, item, sep, step_menu, Hover, Input, Item, Menu, Panel, Peek, Picker, Row};
use crate::smartselect;
use crate::symbols::{symbol_path, Symbol};
use crate::term::Term;
use crate::width::display_col;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub type Job = Box<dyn FnOnce(&mut Editor) + Send>;

const WORD_DELAY: Duration = Duration::from_millis(250);
const HOVER_DELAY: Duration = Duration::from_millis(300);
const OUTLINE_DELAY: Duration = Duration::from_millis(300);
const INSTALL_POLL: Duration = Duration::from_secs(3);
const CURSOR_STACK: usize = 50;

/// VS Code's default editor context menu: groups, with Peek as a submenu.
const MENU: &[&[&str]] = &[
    &["editor.action.revealDefinition", "editor.action.goToTypeDefinition", "editor.action.goToImplementation", "editor.action.goToReferences", "Peek"],
    &["references-view.findReferences", "references-view.findImplementations", "references-view.showCallHierarchy"],
    &["editor.action.rename", "editor.action.changeAll", "editor.action.formatDocument", "editor.action.refactor", "editor.action.sourceAction"],
    &["editor.action.clipboardCutAction", "editor.action.clipboardCopyAction", "editor.action.clipboardPasteAction"],
    &["workbench.action.showCommands"],
];
const PEEK: &[&str] = &["editor.action.peekDefinition", "editor.action.referenceSearch.trigger", "editor.action.peekImplementation", "editor.action.peekTypeDefinition"];

/// What a menu row runs.
#[derive(Clone, Debug)]
pub enum MAct {
    Command(&'static str),
    /// One of the quick fix menu's actions.
    Action(usize),
}

fn not_found(kind: &str) -> &'static str {
    match kind {
        "definition" => "definition",
        "typeDefinition" => "type definition",
        "implementation" => "implementation",
        _ => "references",
    }
}
fn peek_title(kind: &str) -> &'static str {
    match kind {
        "definition" => "Definition",
        "typeDefinition" => "Type Definition",
        "implementation" => "Implementations",
        _ => "References",
    }
}
fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// One file's symbols as of a text version.
pub struct Outline {
    pub version: u64,
    pub items: Vec<Symbol>,
}

/// A CodeLens in the buffer: at its declaration's name, its title, what a click peeks.
#[derive(Clone, Debug, PartialEq)]
pub struct LensItem {
    pub at: Pos,
    pub title: String,
    pub kind: &'static str,
}

/// Per open file (swapped with the file like DocState's other fields).
#[derive(Default)]
pub struct LangDoc {
    pub session: Option<Session>,
    pub outline: Option<Outline>,
    /// The text version the semantic tokens were last asked for.
    pub sem_version: Option<u64>,
    /// CodeLens as of a text version, moved along with edits until new ones come.
    pub lenses: Vec<LensItem>,
    pub lens_version: Option<u64>,
}

/// Line decorations after an edit replaced lines [start, start+removed) with `inserted` lines: the ones below move
/// along, one on the edited first line stays, the ones on the other replaced lines go.
pub fn shift_lenses(items: &mut Vec<LensItem>, c: crate::buffer::Change) {
    items.retain(|it| it.at.line <= c.start || it.at.line >= c.start + c.removed);
    for it in items.iter_mut().filter(|it| it.at.line >= c.start + c.removed && it.at.line > c.start) {
        it.at.line = it.at.line + c.inserted - c.removed;
    }
}

/// A diagnostic in the buffer's byte positions.
#[derive(Clone)]
pub struct Problem {
    pub start: Pos,
    pub end: Pos,
    pub severity: u8,
    pub message: String,
    pub source: String,
    pub diag: Diag,
}

struct CursorHist {
    file: PathBuf,
    version: u64,
    last: (Sel, usize, usize),
    undo: Vec<(Sel, usize, usize)>,
    redo: Vec<(Sel, usize, usize)>,
}

struct Bulb {
    key: (PathBuf, u64, usize, usize),
    fixes: bool,
    ask_at: Option<Instant>,
}

/// Go to Symbol in Workspace: the query asked (once per query and root) and its answer when it came.
struct WsQuery {
    query: String,
    root: PathBuf,
    result: Option<Result<Vec<WsSymbol>, String>>,
}

struct ChangeAll {
    word: String,
    occ: Vec<Edit>,
    origin: Sel,
    applied: bool,
    count: usize,
}

/// The editor's language state.
pub struct LangState {
    pub(super) jobs: (Sender<Job>, Receiver<Job>),
    pub panel: Option<Panel>,
    /// Call hierarchy's panel: the ctx and direction, for Tab.
    calls: Option<(Ctx, &'static str)>,
    pub peek: Option<Peek>,
    pub peek_row: i32,
    pub hover_box: Option<Hover>,
    hover_token: u64,
    hover_key: Option<(usize, usize)>,
    hover_at: Option<(Instant, Pos)>,
    outline_at: Option<Instant>,
    outline_busy: bool,
    problems: Option<(usize, u64, Vec<Problem>)>,
    diag_seen: u64,
    bulb: Option<Bulb>,
    cursor: Option<CursorHist>,
    smart: Option<(PathBuf, u64, Vec<smartselect::Range>, usize)>,
    ws: Option<WsQuery>,
    file_lines: HashMap<PathBuf, Vec<String>>,
    pub sem_theme: Option<SemanticTheme>,
    actions: Vec<Action>,
    /// Show CodeLens Commands' choices.
    lens_pick: Vec<LensItem>,
    rename: Option<Ctx>,
    change_all: Option<ChangeAll>,
    /// After an install was started: (kind, label, next look for the server, when to stop looking).
    installing: Option<(&'static str, &'static str, Instant, Instant)>,
    lens_busy: bool,
    /// documentHighlight for a resting word's key: None while the server answers, Some(None) when it failed.
    refs: Option<(String, Option<Option<Vec<lang::Reference>>>)>,
    /// The word a Ctrl (⌘) hover underlines: line, bytes [from, to).
    pub link: Option<(usize, usize, usize)>,
}

impl LangState {
    pub fn new(theme: &serde_json::Value) -> LangState {
        LangState {
            jobs: channel(),
            panel: None,
            calls: None,
            peek: None,
            peek_row: 2,
            hover_box: None,
            hover_token: 0,
            hover_key: None,
            hover_at: None,
            outline_at: None,
            outline_busy: false,
            problems: None,
            diag_seen: 0,
            bulb: None,
            cursor: None,
            smart: None,
            ws: None,
            file_lines: HashMap::new(),
            sem_theme: SemanticTheme::of(theme),
            actions: vec![],
            lens_pick: vec![],
            rename: None,
            change_all: None,
            installing: None,
            lens_busy: false,
            refs: None,
            link: None,
        }
    }
}

impl Editor {
    // ----- jobs: work on a thread, its result applied between input events -----
    pub(super) fn spawn<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static, then: impl FnOnce(&mut Editor, T) + Send + 'static) {
        let tx = self.ls.jobs.0.clone();
        std::thread::spawn(move || {
            let r = work();
            let _ = tx.send(Box::new(move |ed: &mut Editor| then(ed, r)));
            crate::term::wake();
        });
    }
    /// Like spawn; an error becomes the status message (vsedit.cjs track).
    fn track<T: Send + 'static>(&self, work: impl FnOnce() -> Result<T, String> + Send + 'static, then: impl FnOnce(&mut Editor, T) + Send + 'static) {
        self.spawn(work, |ed, r| match r {
            Ok(v) => then(ed, v),
            Err(e) => {
                let w = ed.c.warn.clone();
                ed.say(e, Some(&w), 5000);
            }
        });
    }
    /// Runs the jobs that finished; true when any did (or diagnostics changed).
    pub fn run_jobs(&mut self) -> bool {
        let mut any = false;
        while let Ok(job) = self.ls.jobs.1.try_recv() {
            job(self);
            any = true;
        }
        let g = lang::diag_generation();
        if g != self.ls.diag_seen {
            self.ls.diag_seen = g;
            any = true;
        }
        if any {
            self.refresh_picker(true);
        }
        any
    }
    /// Waits (tests) until a job arrives or `ms` passed, then runs the jobs.
    #[cfg(test)]
    pub fn wait_jobs(&mut self, ms: u64) -> bool {
        match self.ls.jobs.1.recv_timeout(Duration::from_millis(ms)) {
            Ok(job) => {
                job(self);
                self.run_jobs();
                true
            }
            Err(_) => false,
        }
    }
    /// Where a server's workspace/applyEdit goes: a job applying it, waited for by the server's reader thread.
    pub fn install_lang_hooks(&self) {
        let tx = self.ls.jobs.0.clone();
        lang::set_hooks(crate::term::wake, move |ws: WorkspaceEdit| {
            let (done, wait) = channel();
            let job: Job = Box::new(move |ed: &mut Editor| {
                ed.apply_edit(&ws);
                let _ = done.send(true);
            });
            if tx.send(job).is_err() {
                return false;
            }
            crate::term::wake();
            wait.recv_timeout(Duration::from_secs(10)).unwrap_or(false)
        });
    }

    /// The current file's language session (created on first use).
    pub fn session(&mut self) -> Session {
        if self.lang.session.is_none() {
            self.lang.session = Some(Session::new(&self.file, self.scope.as_deref()));
        }
        self.lang.session.clone().unwrap()
    }
    pub fn can(&mut self, op: &str) -> bool {
        self.session().can(op)
    }

    // ----- positions: the servers count UTF-16 columns -----
    pub fn p16(&self, p: Pos) -> P16 {
        let l = p.line.min(self.buf.lines.len() - 1);
        p16(l, u16_of(&self.buf.lines[l], p.col))
    }
    pub fn pos16(&self, p: P16) -> Pos {
        let l = p.line.min(self.buf.lines.len() - 1);
        pos(l, byte_of(&self.buf.lines[l], p.col))
    }
    pub fn lang_ctx(&mut self, p: Pos) -> Ctx {
        let (s, e) = self.range();
        Ctx {
            file: self.file.clone(),
            lines: Arc::new(self.buf.lines.clone()),
            line: p.line,
            col: self.p16(p).col,
            sel: (self.p16(s), self.p16(e)),
            tab_size: self.tab(),
            insert_spaces: !self.indent.use_tabs,
            word: self.word_at(p).map_or(String::new(), |w| w.0),
            language: self.language.clone(),
            diagnostics: vec![],
        }
    }

    // ----- commands -----
    /// A command from a key, the menu or the palette: one that needs a language operation says so when there is none.
    pub fn run_command(&mut self, c: &Command, term: Option<&mut Term>) {
        if let Some(cap) = commands::cap_of(c.act) {
            if !self.can(cap) {
                let what = c.title.trim_end_matches("...").to_lowercase();
                return self.warn(format!("No {what} support for {}", self.language));
            }
        }
        self.run_act(c.act, term);
    }
    /// The language commands of run_act.
    pub(super) fn run_lang(&mut self, act: Act) {
        match act {
            Act::GoTo(k) => self.go_to(k, 0),
            Act::PeekAt(k) => self.go_to(k, 1),
            Act::FindAll(k) => self.go_to(k, 2),
            Act::CallHierarchy => {
                let ctx = self.lang_ctx(self.head());
                self.call_hierarchy("incoming", ctx);
            }
            Act::Rename => self.rename_symbol(),
            Act::ChangeAll => self.change_all("Change All Occurrences"),
            Act::FormatDocument => self.format_document(),
            Act::FormatSelection => self.format_selection(),
            Act::CodeActions(k) => self.code_actions(k),
            Act::QuickFix => self.quick_fix(),
            Act::ShowHover => self.show_hover(self.head(), false),
            Act::SmartSelect(d) => self.smart_select(d),
            Act::CursorHistory(d) => self.cursor_history(d),
            Act::WorkspaceSymbols => self.open_picker("#"),
            Act::ShowCommands => self.open_picker(">"),
            Act::GotoSymbol => self.go_to_symbol(),
            Act::NextProblem(d) => self.next_problem(d),
            Act::ShowLenses => self.show_lenses(),
            Act::ContextMenu => self.open_menu_at_cursor(),
            _ => {}
        }
    }

    // ----- definitions, references, calls -----
    /// mode 0: go (a list of several in the panel), 1: peek, 2: the panel.
    fn go_to(&mut self, kind: &'static str, mode: u8) {
        let (s, ctx) = (self.session(), self.lang_ctx(self.head()));
        self.track(
            move || s.locate(kind, &ctx),
            move |ed, locs| {
                if locs.is_empty() {
                    let w = ed.word_at(ed.head()).map(|w| w.0);
                    return ed.warn(format!("No {} found{}", not_found(kind), w.map_or(String::new(), |w| format!(" for '{w}'"))));
                }
                match mode {
                    0 if locs.len() == 1 => ed.jump_to(&locs[0]),
                    // several: editor.gotoLocation.multiple*'s default, "peek"
                    0 | 1 => {
                        ed.ls.peek = Some(Peek { title: peek_title(kind).into(), items: locs, index: 0 });
                        // keep the box on screen below the cursor line
                        let (row, h) = (ed.rows_to(ed.head().line), ed.height() as i64);
                        if row + Peek::HEIGHT as i64 >= h {
                            let v = (ed.row_of(ed.head().line) as i64 - (h - Peek::HEIGHT as i64 - 1).max(0)).max(0);
                            ed.top = ed.line_at_row(v as usize);
                        }
                    }
                    _ => ed.show_panel(peek_title(kind), locs, None),
                }
            },
        );
    }
    fn call_hierarchy(&mut self, dir: &'static str, ctx: Ctx) {
        let s = self.session();
        let c = ctx.clone();
        self.track(
            move || s.calls(&c, dir),
            move |ed, mut items| {
                for it in &mut items {
                    if let Some(n) = it.name.as_mut().filter(|n| n.contains('/')) {
                        *n = Path::new(n.as_str()).file_name().map_or(n.clone(), |f| f.to_string_lossy().into_owned());
                    }
                }
                let other = if dir == "incoming" { "outgoing" } else { "incoming" };
                let title = format!("{} calls · {}", if dir == "incoming" { "Incoming" } else { "Outgoing" }, ctx.word);
                ed.show_panel(&title, items, Some(format!("{other} calls")));
                ed.ls.calls = Some((ctx, other));
            },
        );
    }
    /// The text of `line` in `file` (open files from their buffer).
    fn line_of(&mut self, file: &Path, line: usize) -> String {
        if file == self.file {
            return self.buf.lines.get(line).cloned().unwrap_or_default();
        }
        if let Some(d) = self.docs.iter().find(|d| d.file == file) {
            return d.buf.lines.get(line).cloned().unwrap_or_default();
        }
        let lines = self.ls.file_lines.entry(file.to_path_buf()).or_insert_with(|| match crate::file::load(file, true) {
            Ok(Ok(doc)) => doc.lines,
            _ => vec![],
        });
        lines.get(line).cloned().unwrap_or_default()
    }
    fn show_panel(&mut self, title: &str, mut items: Vec<Loc>, toggle: Option<String>) {
        self.ls.file_lines.clear();
        for it in &mut items {
            if it.preview.is_none() {
                it.preview = Some(self.line_of(&it.file.clone(), it.line));
            }
        }
        self.ls.calls = None;
        self.ls.panel = Some(Panel::new(title, items, toggle));
        self.reveal();
    }
    pub fn panel_toggle(&mut self) {
        if let Some((ctx, dir)) = self.ls.calls.take() {
            self.call_hierarchy(dir, ctx);
        }
    }
    /// Opens a result (UTF-16 column), remembering where we were.
    pub fn jump_to(&mut self, l: &Loc) {
        if self.open(&l.file, None, true) {
            let line = l.line.min(self.buf.lines.len() - 1);
            let at = pos(line, byte_of(&self.buf.lines[line], l.col));
            self.move_to(at, false);
            let v = self.row_of(at.line).saturating_sub(self.height() / 3);
            self.top = self.line_at_row(v);
        }
    }
    /// An open file's state for drawing (the peek box), loading it once.
    pub fn doc_index(&mut self, file: &Path) -> Option<usize> {
        if let Some(i) = self.docs.iter().position(|d| d.file == file) {
            return Some(i);
        }
        let st = self.load_state(file)?;
        self.docs.push(st);
        Some(self.docs.len() - 1)
    }

    // ----- rename, change all -----
    /// The inline box's cell under a buffer position.
    fn inline_at(&mut self, p: Pos) -> (i32, i32) {
        let (row, col) = self.screen_of(p);
        ((self.rows - 3).min(row + 1), (col - 1).max(1))
    }
    pub fn screen_of(&mut self, p: Pos) -> (i32, i32) {
        let row = self.rows_to(p.line) as i32 + 2;
        (row, self.gutter() as i32 + display_col(&self.buf.lines[p.line], p.col, self.tab()) as i32 - self.left as i32 + 1)
    }
    fn rename_symbol(&mut self) {
        let Some((word, start, _)) = self.word_at(self.head()) else { return self.warn("The element can't be renamed.") };
        if !self.session().renames() {
            return self.change_all("Rename (whole word, this file)");
        }
        self.ls.rename = Some(self.lang_ctx(self.head()));
        let mut input = Input::new("Enter to Rename, Esc to Cancel", &word, IAct::Rename(word.clone()));
        input.at = Some(self.inline_at(start));
        self.popup = Some(Popup::Input(input));
    }
    pub(super) fn rename_to(&mut self, old: &str, name: String) {
        let Some(ctx) = self.ls.rename.take() else { return };
        if name.is_empty() || name == old {
            return;
        }
        let s = self.session();
        self.track(move || s.rename(&ctx, &name), |ed, ws| {
            let r = ed.apply_edit(&ws);
            ed.report_edit(&r, "Renamed");
        });
    }
    fn report_edit(&mut self, r: &E::Applied, verb: &str) {
        if !r.failed.is_empty() {
            let names: Vec<String> = r.failed.iter().map(|(f, _)| f.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned())).collect();
            return self.error(format!("{verb} {}; failed: {}", plural(r.edits, "occurrence"), names.join(", ")), 8000);
        }
        let ok = self.c.ok.clone();
        self.say(format!("{verb} {} in {}", plural(r.edits, "occurrence"), plural(r.files, "file")), Some(&ok), 5000);
    }
    /// Whole-word replace in this file with a live preview (VS Code's Change All Occurrences is file-local too).
    fn change_all(&mut self, label: &str) {
        let (s, e) = self.range();
        let word = if !self.empty() && s.line == e.line { Some(self.buf.text(s, e)) } else { self.word_at(self.head()).map(|w| w.0) };
        let Some(word) = word.filter(|w| !w.is_empty()) else { return };
        let whole = self.empty() || word.chars().all(crate::decorations::is_word_char);
        let occ: Vec<Edit> = if whole { word_occurrences(&self.buf.lines, &word, "").iter().map(|o| edit(self.pos16(o.start), self.pos16(o.end), "")).collect() } else { vec![] };
        if occ.is_empty() {
            return;
        }
        let at = self.word_at(self.head()).map_or(s, |w| w.1);
        let count = occ.len();
        self.ls.change_all = Some(ChangeAll { word: word.clone(), occ, origin: self.sel, applied: false, count });
        let mut input = Input::new(&format!("{label} · {}", plural(count, "occurrence")), &word, IAct::ChangeAll);
        input.at = Some(self.inline_at(at));
        self.popup = Some(Popup::Input(input));
    }
    /// The preview of Change All with `v` (the word itself: none).
    pub(super) fn change_all_preview(&mut self, v: &str) {
        let Some(mut st) = self.ls.change_all.take() else { return };
        if st.applied {
            self.undo(false);
            st.applied = false;
        }
        if !v.is_empty() && v != st.word {
            let mut edits: Vec<Edit> = st.occ.iter().map(|o| edit(o.start, o.end, v)).collect();
            edits.reverse();
            self.apply(edits, st.origin, Some(st.origin), false);
            st.applied = true;
        }
        self.sel = Sel { anchor: self.buf.clamp(st.origin.anchor), head: self.buf.clamp(st.origin.head) };
        self.ls.change_all = Some(st);
    }
    pub(super) fn change_all_done(&mut self, accept: bool) {
        if !accept {
            let w = self.ls.change_all.as_ref().map(|s| s.word.clone()).unwrap_or_default();
            self.change_all_preview(&w);
        }
        let Some(st) = self.ls.change_all.take() else { return };
        if accept {
            self.buf.seal();
            if st.applied {
                let ok = self.c.ok.clone();
                self.say(format!("Changed {}", plural(st.count, "occurrence")), Some(&ok), 3000);
            }
        }
    }

    // ----- edits from the servers -----
    fn byte_edits(lines: &[String], edits: &[TextEdit]) -> Vec<Edit> {
        let at = |p: P16| {
            let l = p.line.min(lines.len() - 1);
            pos(l, byte_of(&lines[l], p.col))
        };
        E::last_first(edits).into_iter().map(|e| edit(at(e.start), at(e.end), e.text.replace("\r\n", "\n").replace('\r', "\n"))).collect()
    }
    /// Text edits on the current file as one undo step.
    pub fn apply_local_edits(&mut self, edits: &[TextEdit]) {
        if edits.is_empty() {
            return;
        }
        let (before, at) = (self.sel, self.head());
        let list = Editor::byte_edits(&self.buf.lines, edits);
        self.apply(list, before, None, false);
        let p = self.buf.clamp(at);
        self.move_to(p, false);
    }
    /// Workspace edits: the current file stays unsaved (one undo step), other open files are edited and saved, the
    /// rest rewritten on disk.
    pub fn apply_edit(&mut self, ws: &WorkspaceEdit) -> E::Applied {
        let r = E::apply_workspace_edit(ws, |file, edits| {
            if file == self.file {
                self.apply_local_edits(edits);
                return true;
            }
            let Some(i) = self.docs.iter().position(|d| d.file == file) else { return false };
            let mut st = self.docs.remove(i);
            self.swap_doc(&mut st); // edit it as the current file, so its tokenizer, folds and git follow
            let before = self.sel;
            let list = Editor::byte_edits(&self.buf.lines, edits);
            self.apply(list, before, None, false);
            self.sel = Sel { anchor: self.buf.clamp(self.sel.anchor), head: self.buf.clamp(self.sel.head) };
            self.swap_doc(&mut st);
            self.docs.insert(i, st);
            self.write_state(i)
        });
        let s = self.session();
        for (file, _) in ws {
            if *file != self.file {
                let text = self.docs.iter().find(|d| d.file == *file).map(|d| d.buf.lines.join("\n"));
                s.touch(file, text);
            }
        }
        r
    }

    // ----- formatting -----
    fn format_document(&mut self) {
        let (s, ctx, version) = (self.session(), self.lang_ctx(self.head()), self.buf.version);
        let file = self.file.clone();
        self.track(move || s.format(&ctx), move |ed, edits| {
            if ed.file == file && ed.buf.version == version {
                ed.apply_local_edits(&edits);
            }
        });
    }
    /// Format on save: the formatter's edits, then the save (and the quit it was for).
    pub(super) fn format_then_save(&mut self, auto: bool, then_quit: bool) {
        let (s, ctx, version, file) = (self.session(), self.lang_ctx(self.head()), self.buf.version, self.file.clone());
        self.spawn(
            move || s.format(&ctx),
            move |ed, r| {
                if ed.file != file {
                    return;
                }
                match r {
                    Ok(edits) if ed.buf.version == version => ed.apply_local_edits(&edits),
                    Ok(_) => {}
                    Err(e) => {
                        let w = ed.c.warn.clone();
                        ed.say(format!("Format on save: {e}"), Some(&w), 5000);
                    }
                }
                if ed.write(auto) && then_quit {
                    ed.quit();
                }
            },
        );
    }
    /// Format Selection: the range formatter on the selection (the cursor line when nothing is selected); without one,
    /// the document formatter's changes to the selected lines, unless one of them crosses their edges.
    fn format_selection(&mut self) {
        let h = self.head();
        let (s, e) = if self.empty() { (pos(h.line, 0), pos(h.line, self.buf.lines[h.line].len())) } else { self.range() };
        let (a, b) = if self.empty() { (h.line, h.line) } else { self.selected_lines() };
        let mut ctx = self.lang_ctx(h);
        ctx.sel = (self.p16(s), self.p16(e));
        let (session, version, file, can_format) = (self.session(), self.buf.version, self.file.clone(), self.can("format"));
        let language = self.language.clone();
        self.track(
            move || {
                if let Some(edits) = session.format_range(&ctx)? {
                    return Ok(Ok(edits));
                }
                if !can_format {
                    return Ok(Err(format!("No format selection support for {language}")));
                }
                let all = session.format(&ctx)?;
                Ok(E::edits_within(&ctx.lines, &all, a, b).ok_or_else(|| "Format Selection isn't supported here: the formatter also changes lines around the selection".to_string()))
            },
            move |ed, r: Result<Vec<TextEdit>, String>| {
                if ed.file != file || ed.buf.version != version {
                    return;
                }
                match r {
                    Ok(edits) => ed.apply_local_edits(&edits),
                    Err(m) => {
                        let w = ed.c.warn.clone();
                        ed.say(m, Some(&w), 5000);
                    }
                }
            },
        );
    }

    // ----- code actions, quick fix, the light bulb -----
    pub(super) fn apply_action(&mut self, i: usize) {
        let Some(a) = self.ls.actions.get(i).cloned() else { return };
        let s = self.session();
        self.track(move || s.resolve(&a), |ed, ws| {
            let r = ed.apply_edit(&ws);
            if !r.failed.is_empty() {
                ed.report_edit(&r, "Applied");
            }
        });
    }
    fn code_actions(&mut self, kind: &'static str) {
        let (s, ctx) = (self.session(), self.lang_ctx(self.head()));
        self.track(move || s.actions(kind, &ctx), move |ed, list| {
            if list.is_empty() {
                return ed.warn(if kind == "refactor" { "No refactorings available" } else { "No source actions available" });
            }
            let choices = list.iter().enumerate().map(|(i, a)| (a.title.clone(), String::new(), PAct::Action(i))).collect();
            ed.ls.actions = list;
            ed.popup = Some(Popup::Picker(Picker::new(if kind == "refactor" { "Select a refactoring" } else { "Select a source action" }, choices, 0)));
        });
    }
    /// The problems a quick fix is for: those at the cursor, else the nearest one on its line; the request covers that
    /// problem when nothing is selected.
    fn quick_fix_ctx(&mut self) -> Ctx {
        let mut ctx = self.lang_ctx(self.head());
        let h = self.head();
        let at = self.problems_at(h);
        let near: Vec<Problem> = if !at.is_empty() {
            at.clone()
        } else {
            let dist = |d: &Problem| (if d.start.line == h.line { d.start.col } else { 0 }).abs_diff(h.col);
            let mut on: Vec<Problem> = self.problems().into_iter().filter(|d| d.start.line <= h.line && d.end.line >= h.line).collect();
            on.sort_by_key(dist);
            on.truncate(1);
            on
        };
        if at.is_empty() && !near.is_empty() && self.empty() {
            ctx.sel = (near[0].diag.start, near[0].diag.end);
        }
        ctx.diagnostics = near.into_iter().map(|p| p.diag).collect();
        ctx
    }
    /// Quick Fix (⌘.): a menu at the cursor of the fixes for its problems (preferred first), then the refactorings.
    fn quick_fix(&mut self) {
        let ctx = self.quick_fix_ctx();
        let (s, version, file) = (self.session(), self.buf.version, self.file.clone());
        let (fixes_ok, refactor_ok) = (!ctx.diagnostics.is_empty() && self.can("quickFix"), self.can("refactor"));
        self.track(
            move || {
                let fixes = if fixes_ok { s.actions("quickFix", &ctx)? } else { vec![] };
                let refactors = if refactor_ok { s.actions("refactor", &ctx).unwrap_or_default() } else { vec![] };
                Ok((fixes, refactors))
            },
            move |ed, (mut fixes, refactors)| {
                if ed.file != file || ed.buf.version != version {
                    return;
                }
                fixes.sort_by_key(|a| !a.preferred);
                let n = fixes.len();
                let mut rows: Vec<Row<MAct>> = vec![];
                for (i, a) in fixes.iter().chain(&refactors).enumerate() {
                    if i == n && n > 0 {
                        rows.push(sep());
                    }
                    rows.push(Row { sep: false, title: a.title.clone(), key: String::new(), enabled: true, act: Some(MAct::Action(i)), submenu: vec![] });
                }
                if rows.is_empty() {
                    return ed.warn("No code actions available");
                }
                ed.ls.actions = fixes.into_iter().chain(refactors).collect();
                let (row, col) = ed.screen_of(ed.head());
                let mut m = Menu::new(rows, col.max(1), (row + 1).min(ed.rows));
                m.index = step_menu(&m.rows, None, 1);
                ed.popup = Some(Popup::Menu(m));
            },
        );
    }
    /// The light bulb's line: the cursor line once its problems' quick fixes came back non-empty. They are asked
    /// WORD_DELAY after the cursor line, its problems or the text last changed, and only from a running server.
    pub fn light_bulb_line(&mut self) -> Option<usize> {
        let line = self.head().line;
        let n = self.problems().iter().filter(|d| d.start.line <= line && d.end.line >= line).count();
        let key = (self.file.clone(), self.buf.version, line, n);
        if let Some(b) = self.ls.bulb.as_ref().filter(|b| b.key == key) {
            return b.fixes.then_some(line);
        }
        let live = n > 0 && self.lang.session.as_ref().is_some_and(|s| s.diagnostics().is_some()) && self.can("quickFix");
        self.ls.bulb = Some(Bulb { key, fixes: false, ask_at: live.then(|| Instant::now() + WORD_DELAY) });
        None
    }
    fn ask_bulb(&mut self) {
        let Some(b) = self.ls.bulb.as_mut() else { return };
        b.ask_at = None;
        let key = b.key.clone();
        let line = self.head().line;
        let mut ctx = self.lang_ctx(self.head());
        ctx.diagnostics = self.problems().into_iter().filter(|d| d.start.line <= line && d.end.line >= line).map(|p| p.diag).collect();
        ctx.sel = (p16(line, 0), self.p16(pos(line, self.buf.lines[line].len())));
        let s = self.session();
        self.spawn(move || s.actions("quickFix", &ctx), move |ed, r| {
            if let (Some(b), Ok(f)) = (ed.ls.bulb.as_mut(), r) {
                if b.key == key && !f.is_empty() {
                    b.fixes = true;
                }
            }
        });
    }

    // ----- hover -----
    /// The problems at p, then the server's hover there, in a box at the word; dropped when another hover was asked
    /// for or the text changed meanwhile.
    pub fn show_hover(&mut self, p: Pos, mouse: bool) {
        self.ls.hover_token += 1;
        let (token, version, file) = (self.ls.hover_token, self.buf.version, self.file.clone());
        let at = self.word_at(p).map_or(p, |w| w.1);
        let problems: Vec<String> = self.problems_at(p).iter().map(|d| format!("{}{}", d.message, if d.source.is_empty() { String::new() } else { format!("  {}", d.source) })).collect();
        let cell = self.screen_of(at);
        let show = move |ed: &mut Editor, h: Option<String>| {
            if token != ed.ls.hover_token || ed.file != file || ed.buf.version != version {
                return;
            }
            let md: Vec<String> = problems.into_iter().chain(h.filter(|h| !h.is_empty())).collect();
            let md = md.join("\n\n---\n\n");
            ed.ls.hover_box = (!md.is_empty()).then(|| Hover::new(md, cell, mouse));
            if ed.ls.hover_box.is_none() && !mouse {
                ed.warn("No hover information");
            }
        };
        if !self.can("hover") {
            return show(self, None);
        }
        let (s, ctx) = (self.session(), self.lang_ctx(p));
        self.spawn(move || s.hover(&ctx), move |ed, r| show(ed, r.ok().flatten()));
    }
    /// A buttonless motion: resting HOVER_DELAY on a word (or a problem) shows its hover; moving off closes a mouse
    /// hover, unless onto the box. True when the frame must be drawn again.
    pub fn mouse_hover(&mut self, m: &crate::keys::Mouse) -> bool {
        if self.ls.hover_box.as_ref().is_some_and(|h| h.contains(m)) {
            return false;
        }
        let gw = self.gutter() as i32;
        let over_text = self.prompt.is_none() && self.ls.peek.is_none() && m.x > gw && m.y >= 2 && m.y <= self.height() as i32 + 1 && self.lens_row_at(m.y).is_none();
        let mut w = None;
        if over_text {
            let p = self.cell_to_pos(m.x, m.y);
            let t = &self.buf.lines[p.line];
            let over = p.col < t.len() && display_col(t, p.col, self.tab()) as i64 == self.left as i64 + m.x as i64 - 1 - gw as i64;
            if over {
                let word = t[p.col..].chars().next().is_some_and(crate::decorations::is_word_char);
                w = if word { self.word_at(p).map(|w| (p, w.1)) } else if !self.problems_at(p).is_empty() { Some((p, p)) } else { None };
            }
        }
        // Ctrl (⌘ when the terminal reports it) over a word: underlined like a link, a click goes to its definition
        let on_word = |ed: &Editor, p: Pos| ed.buf.lines[p.line][p.col..].chars().next().is_some_and(crate::decorations::is_word_char);
        let link = w.filter(|(p, _)| m.ctrl && on_word(self, *p) && self.can("definition")).and_then(|(p, _)| self.word_at(p)).map(|(_, s, e)| (s.line, s.col, e.col));
        let mut frame = link != self.ls.link;
        self.ls.link = link;
        let key = w.map(|(p, s)| (p.line, s.col));
        if key == self.ls.hover_key {
            return frame;
        }
        self.ls.hover_key = key;
        self.ls.hover_at = None;
        if self.ls.hover_box.as_ref().is_some_and(|h| h.mouse) {
            self.ls.hover_box = None;
            self.ls.hover_token += 1;
            frame = true;
        }
        if let Some((p, _)) = w.filter(|_| self.settings.hover) {
            self.ls.hover_at = Some((Instant::now() + HOVER_DELAY, p));
        }
        frame
    }
    /// Any key closes the hover (true: the key was Escape, taken by it).
    pub fn close_hover_on_key(&mut self, ev: &crate::keys::Ev) -> bool {
        if self.ls.hover_box.is_none() || self.popup.is_some() {
            return false;
        }
        self.ls.hover_box = None;
        matches!(ev, crate::keys::Ev::Key(k) if k.name == "escape")
    }

    // ----- diagnostics -----
    /// Errors, warnings and information (hints aren't drawn) in document order, clamped to the text.
    pub fn problems(&mut self) -> Vec<Problem> {
        let Some(list) = self.lang.session.as_ref().and_then(|s| s.diagnostics()) else { return vec![] };
        let id = Arc::as_ptr(&list) as usize;
        if let Some((i, v, items)) = &self.ls.problems {
            if *i == id && *v == self.buf.version {
                return items.clone();
            }
        }
        let mut items: Vec<Problem> = list
            .iter()
            .filter(|d| d.severity <= 3)
            .map(|d| Problem { start: self.pos16(d.start), end: self.pos16(d.end), severity: d.severity, message: d.message.clone(), source: d.source.clone(), diag: d.clone() })
            .collect();
        items.sort_by(|a, b| a.start.cmp(&b.start).then(a.severity.cmp(&b.severity)));
        self.ls.problems = Some((id, self.buf.version, items.clone()));
        items
    }
    /// The bytes [from, to) a problem underlines on `line` (an empty range takes the character at it, or before it).
    pub fn problem_span(d: &Problem, line: usize, text: &str) -> Option<(usize, usize)> {
        if line < d.start.line || line > d.end.line {
            return None;
        }
        let mut from = if line == d.start.line { d.start.col } else { 0 };
        let mut to = if line == d.end.line { d.end.col } else { text.len() };
        if from >= to && d.start.line == d.end.line {
            if from < text.len() {
                to = crate::width::next_index(text, from);
            } else {
                from = crate::width::prev_index(text, text.len());
                to = text.len();
            }
        }
        (from < to).then_some((from, to))
    }
    /// The problems at p (ends included), the most severe first.
    pub fn problems_at(&mut self, p: Pos) -> Vec<Problem> {
        let text = self.buf.lines[p.line].clone();
        let mut out: Vec<Problem> = self.problems().into_iter().filter(|d| Editor::problem_span(d, p.line, &text).is_some_and(|(f, t)| p.col >= f && p.col <= t)).collect();
        out.sort_by_key(|d| d.severity);
        out
    }
    /// F8 / ⇧F8: the next / previous problem's start (wrapping); its message shows in the status bar.
    fn next_problem(&mut self, dir: i32) {
        let ps = self.problems();
        if ps.is_empty() {
            return self.say("No problems in this file", None, 3000);
        }
        let h = self.head();
        let d = if dir > 0 { ps.iter().find(|p| p.start > h).unwrap_or(&ps[0]) } else { ps.iter().rev().find(|p| p.start < h).unwrap_or(&ps[ps.len() - 1]) };
        let at = d.start;
        self.push_nav();
        self.move_to(at, false);
        let v = self.row_of(at.line).saturating_sub(self.height() / 3);
        self.top = self.line_at_row(v);
    }

    // ----- document symbols: Go to Symbol, breadcrumbs -----
    fn go_to_symbol(&mut self) {
        self.load_outline(true);
    }
    /// Asks for the current file's symbols (they also give the server the current text, so its diagnostics follow);
    /// `pick` opens Go to Symbol with them.
    fn load_outline(&mut self, pick: bool) {
        let (s, ctx, version, file) = (self.session(), self.lang_ctx(self.head()), self.buf.version, self.file.clone());
        self.ls.outline_busy = true;
        self.spawn(move || (s.symbols(&ctx), crate::lang::offer(&s)), move |ed, ((source, items), _)| {
            ed.ls.outline_busy = false;
            if ed.file != file || ed.buf.version != version {
                return ed.queue_outline();
            }
            let note = if source == crate::lang::fallback::Fallback::LABEL { "regex outline (no language server)".to_string() } else { format!("from {source}") };
            ed.lang.outline = Some(Outline { version, items });
            ed.ask_semantic();
            ed.ask_lenses();
            if pick {
                ed.popup = Some(Popup::Picker(Picker::computed("@", "", &note)));
                ed.refresh_picker(false);
            }
        });
    }
    /// The outline again OUTLINE_DELAY after the text last changed (breadcrumbs follow the cursor through it).
    pub fn queue_outline(&mut self) {
        if self.ls.outline_at.is_none() && !self.ls.outline_busy {
            self.ls.outline_at = Some(Instant::now() + OUTLINE_DELAY);
        }
    }
    /// The breadcrumbs' symbols at the cursor.
    pub fn crumb_symbols(&self) -> Vec<String> {
        let at = self.p16(self.head());
        self.lang.outline.as_ref().map_or(vec![], |o| symbol_path(&o.items, at).iter().map(|s| s.name.clone()).collect())
    }
    fn symbol_items(&mut self, query: &str) -> Vec<Item<PAct>> {
        if self.lang.outline.as_ref().is_none_or(|o| o.version != self.buf.version) {
            self.queue_outline();
        }
        let file = self.file.clone();
        match &self.lang.outline {
            Some(o) if !o.items.is_empty() => {
                let names: Vec<&str> = o.items.iter().map(|s| s.name.as_str()).collect();
                filter(&names, query)
                    .into_iter()
                    .map(|(i, hits)| {
                        let s = &o.items[i];
                        Item {
                            label: s.name.clone(),
                            detail: format!("{}{}", s.kind, if s.container.is_empty() { String::new() } else { format!(" · {}", s.container) }),
                            key: (s.at.line + 1).to_string(),
                            hits,
                            act: PAct::Jump(file.clone(), s.at.line, s.at.col),
                        }
                    })
                    .collect()
            }
            o => vec![item(if o.is_some() { "No symbols found" } else { "Loading symbols…" }, PAct::Nothing)],
        }
    }

    // ----- workspace symbols (⌘T: "#") -----
    fn workspace_symbol_items(&mut self, query: &str) -> Vec<Item<PAct>> {
        let root = self.root();
        if self.ls.ws.as_ref().is_none_or(|w| w.query != query || w.root != root) {
            self.ls.ws = Some(WsQuery { query: query.to_string(), root: root.clone(), result: None });
            let (s, ctx, q) = (self.session(), self.lang_ctx(self.head()), query.to_string());
            let asked = q.clone();
            self.spawn(move || s.workspace_symbols(&ctx, &asked), move |ed, r| {
                if let Some(w) = ed.ls.ws.as_mut().filter(|w| w.query == q) {
                    w.result = Some(r);
                }
            });
        }
        match &self.ls.ws.as_ref().unwrap().result {
            None => vec![item("Searching symbols…", PAct::Nothing)],
            Some(Err(e)) => vec![item(e.clone(), PAct::Nothing)],
            Some(Ok(list)) => list
                .iter()
                .map(|it| {
                    let rel = it.loc.file.strip_prefix(&root).unwrap_or(&it.loc.file).to_string_lossy().into_owned();
                    let detail = [it.container.clone(), rel].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
                    Item { label: it.name.clone(), detail, key: it.kind.clone(), hits: fuzzy(query, &it.name).map_or(vec![], |f| f.1), act: PAct::Jump(it.loc.file.clone(), it.loc.line, it.loc.col) }
                })
                .collect(),
        }
    }

    // ----- the quick pick: files, ">" commands, "@" symbols, "#" workspace symbols, ":" line -----
    pub fn open_picker(&mut self, prefix: &str) {
        self.popup = Some(Popup::Picker(Picker::computed(prefix, "Search files by name (: to go to a line, > for commands)", "")));
        self.refresh_picker(false);
    }
    /// Recomputes a computed picker's rows when its text changed (`force`: also when results came in).
    pub fn refresh_picker(&mut self, force: bool) {
        let Some(Popup::Picker(p)) = &self.popup else { return };
        if !(p.changed || force && p.is_computed()) {
            return;
        }
        let text = p.text.clone();
        let items = self.pick_items(&text);
        if let Some(Popup::Picker(p)) = self.popup.as_mut() {
            let index = if force && !p.changed { p.index.min(items.len().saturating_sub(1)) } else { 0 };
            p.set_items(items);
            p.index = index;
        }
    }
    fn pick_items(&mut self, text: &str) -> Vec<Item<PAct>> {
        if let Some(q) = text.strip_prefix('>') {
            let cmds: Vec<&'static Command> = commands::commands().iter().filter(|c| !c.title.is_empty()).collect();
            let titles: Vec<&str> = cmds.iter().map(|c| c.title.as_str()).collect();
            return filter(&titles, q.trim())
                .into_iter()
                .map(|(i, hits)| {
                    let c = cmds[i];
                    let detail = if matches!(c.act, Act::ToggleAutoSave | Act::AskAutoSaveDelay) { crate::settings::auto_save_label(&self.settings) } else { String::new() };
                    Item { label: c.title.clone(), detail, key: self.keys.keymap.label(&c.id), hits, act: PAct::Command(&c.id) }
                })
                .collect();
        }
        if let Some(q) = text.strip_prefix('@') {
            return self.symbol_items(q.trim());
        }
        if let Some(q) = text.strip_prefix('#') {
            return self.workspace_symbol_items(q.trim());
        }
        if let Some(l) = text.strip_prefix(':') {
            let label = if l.is_empty() { "Type a line number to go to".to_string() } else { format!("Go to line {l}") };
            return vec![item(label, PAct::GotoLine(l.to_string()))];
        }
        let files = self.project_files();
        let names: Vec<&str> = files.iter().map(String::as_str).collect();
        filter(&names, text.trim()).into_iter().take(300).map(|(i, hits)| Item { label: files[i].clone(), detail: String::new(), key: String::new(), hits, act: PAct::Open(files[i].clone()) }).collect()
    }

    // ----- the context menu -----
    pub fn open_menu(&mut self, x: i32, y: i32) {
        let session = self.session();
        let row = |ed: &Editor, id: &'static str| -> Row<MAct> {
            let c = commands::by_id(id);
            let enabled = c.and_then(|c| commands::cap_of(c.act)).is_none_or(|cap| session.can(cap));
            Row { sep: false, title: c.map_or(id.to_string(), |c| c.title.clone()), key: ed.keys.keymap.label(id), enabled, act: Some(MAct::Command(id)), submenu: vec![] }
        };
        let mut rows = vec![];
        for (i, g) in MENU.iter().enumerate() {
            if i > 0 {
                rows.push(sep());
            }
            for id in *g {
                if *id == "Peek" {
                    let sub: Vec<Row<MAct>> = PEEK.iter().map(|id| row(self, id)).collect();
                    rows.push(Row { sep: false, title: "Peek".into(), key: String::new(), enabled: sub.iter().any(|r| r.enabled), act: None, submenu: sub });
                } else {
                    rows.push(row(self, id));
                }
            }
        }
        self.popup = Some(Popup::Menu(Menu::new(rows, x, y)));
    }
    fn open_menu_at_cursor(&mut self) {
        let (row, col) = self.screen_of(self.head());
        self.open_menu(col.max(1), (row + 1).min(self.rows));
    }
    pub(super) fn menu_act(&mut self, a: MAct, term: Option<&mut Term>) {
        match a {
            MAct::Command(id) => {
                if let Some(c) = commands::by_id(id) {
                    self.run_command(c, term);
                }
            }
            MAct::Action(i) => self.apply_action(i),
        }
    }

    // ----- Cursor Undo / Redo (VS Code's CursorUndoRedoController) -----
    /// After each event: a selection change without a text change records the selection (and scroll) before it;
    /// a text change or another file empties both stacks.
    pub fn note_cursor(&mut self) {
        let now = (self.sel, self.top, self.left);
        match self.ls.cursor.as_mut() {
            Some(h) if h.file == self.file && h.version == self.buf.version => {
                if h.last.0 != self.sel {
                    let last = h.last;
                    h.undo.push(last);
                    h.redo.clear();
                    if h.undo.len() > CURSOR_STACK {
                        h.undo.remove(0);
                    }
                }
                h.last = now;
            }
            _ => self.ls.cursor = Some(CursorHist { file: self.file.clone(), version: self.buf.version, last: now, undo: vec![], redo: vec![] }),
        }
    }
    fn cursor_history(&mut self, dir: i32) {
        self.note_cursor();
        let Some(h) = self.ls.cursor.as_mut() else { return };
        let Some(st) = (if dir < 0 { h.undo.pop() } else { h.redo.pop() }) else { return };
        let last = h.last;
        if dir < 0 { h.redo.push(last) } else { h.undo.push(last) }
        h.last = st;
        (self.sel, self.top, self.left) = st;
        self.goal = None;
        self.buf.seal();
    }

    // ----- Expand / Shrink Selection -----
    fn smart_select(&mut self, dir: i32) {
        let (a, b) = self.range();
        if let Some((file, version, chain, index)) = self.ls.smart.as_mut() {
            if *file == self.file && *version == self.buf.version && chain[*index] == (a, b) {
                let i = *index as i64 + dir as i64;
                if i < 0 || i as usize >= chain.len() {
                    return;
                }
                *index = i as usize;
                let r = chain[*index];
                self.sel = Sel { anchor: r.0, head: r.1 };
                self.buf.seal();
                return self.reveal();
            }
        }
        if dir < 0 {
            return;
        }
        let own = {
            let (code, hl) = (self.is_code(), &self.hl);
            let lines = &self.buf.lines;
            let string = |line: usize, col: usize| string_at(hl.line(line), &lines[line], col);
            smartselect::fallback_ranges(lines, self.head(), &code, &string)
        };
        let (version, file, sel) = (self.buf.version, self.file.clone(), self.sel);
        let then = move |ed: &mut Editor, server: Vec<(P16, P16)>| {
            if ed.file != file || ed.buf.version != version || ed.sel != sel {
                return; // the cursor moved meanwhile
            }
            let mut ranges: Vec<smartselect::Range> = server.into_iter().map(|(s, e)| (ed.pos16(s), ed.pos16(e))).collect();
            ranges.extend(own);
            ed.ls.smart = Some((file, version, smartselect::chain((a, b), &ranges), 0));
            ed.smart_select(1);
        };
        if !self.can("selectionRange") {
            return then(self, vec![]);
        }
        let (s, ctx) = (self.session(), self.lang_ctx(self.head()));
        self.spawn(move || s.selection_ranges(&ctx).unwrap_or_default(), then);
    }

    // ----- semantic tokens (only for a theme with semanticHighlighting) -----
    fn ask_semantic(&mut self) {
        if self.ls.sem_theme.is_none() || self.lang.sem_version == Some(self.buf.version) {
            return;
        }
        self.lang.sem_version = Some(self.buf.version);
        let (s, ctx, version, file) = (self.session(), self.lang_ctx(self.head()), self.buf.version, self.file.clone());
        self.spawn(move || s.semantic_tokens(&ctx), move |ed, tokens| {
            let Some(t) = tokens.filter(|_| ed.file == file && ed.buf.version == version) else { return };
            let language = ed.language.to_lowercase();
            let Some(theme) = ed.ls.sem_theme.as_mut() else { return };
            let by_line = theme.spans(&t, &ed.buf.lines, &language);
            ed.semantic.reset(ed.buf.lines.len());
            for (l, spans) in by_line.into_iter().enumerate() {
                if !spans.is_empty() {
                    ed.semantic.set(l, spans);
                }
            }
        });
    }

    // ----- CodeLens (editor.codeLens): "N references" on a row of its own above each declaration, VS Code's -----
    /// Asked of the running server after each outline (so OUTLINE_DELAY after the text last changed), one request at a
    /// time, never on the input thread; the last ones stay, moved along with edits, until the new ones come.
    fn ask_lenses(&mut self) {
        if !self.settings.code_lens || self.ls.lens_busy || self.lang.lens_version == Some(self.buf.version) || !self.session().live_can("codeLens") {
            return;
        }
        self.ls.lens_busy = true;
        let (s, ctx, version, file) = (self.session(), self.lang_ctx(self.head()), self.buf.version, self.file.clone());
        self.spawn(move || s.lenses(&ctx), move |ed, r| {
            ed.ls.lens_busy = false;
            if ed.file != file || ed.buf.version != version {
                return;
            }
            ed.lang.lens_version = Some(version);
            if let Some(Ok(list)) = r {
                let mut items: Vec<LensItem> = list.into_iter().map(|l| LensItem { at: ed.pos16(l.at), title: l.title, kind: l.kind }).collect();
                items.sort_by(|a, b| a.at.cmp(&b.at));
                ed.lang.lenses = items;
            }
        });
    }
    /// The lenses shown (none while editor.codeLens is off), by position.
    pub fn lens_items(&self) -> &[LensItem] {
        if self.settings.code_lens { &self.lang.lenses } else { &[] }
    }
    /// A click on a lens (or Show CodeLens Commands): its peek (VS Code's showReferences) at the declaration.
    pub fn run_lens(&mut self, it: &LensItem) {
        self.move_to(it.at, false);
        self.go_to(it.kind, 1);
    }
    pub(super) fn pick_lens(&mut self, i: usize) {
        if let Some(it) = self.ls.lens_pick.get(i).cloned() {
            self.run_lens(&it);
        }
    }
    /// Show CodeLens Commands for Current Line: the cursor line's lens (a pick of them when there are several).
    fn show_lenses(&mut self) {
        let line = self.head().line;
        let items: Vec<LensItem> = self.lens_items().iter().filter(|l| l.at.line == line).cloned().collect();
        match items.len() {
            0 => self.say("No CodeLens on this line", None, 3000),
            1 => self.run_lens(&items[0]),
            _ => {
                self.ls.lens_pick = items.clone();
                let choices = items.iter().enumerate().map(|(i, l)| (l.title.clone(), String::new(), PAct::Lens(i))).collect();
                self.choose("Select a command", choices, 0);
            }
        }
    }

    // ----- reference highlights (documentHighlight) -----
    /// The resting word's references from the running server (reads in editor.wordHighlightBackground, writes in
    /// editor.wordHighlightStrongBackground), asked once per resting word: (list, write flags); empty while it answers,
    /// None (the plain word occurrences instead) without a server or when it fails.
    pub fn reference_hits(&mut self, key: &str) -> Option<(Vec<crate::decorations::Hit>, Vec<bool>)> {
        if !self.session().live_can("documentHighlight") {
            return None;
        }
        if self.ls.refs.as_ref().is_none_or(|r| r.0 != key) {
            self.ls.refs = Some((key.to_string(), None));
            let (s, ctx, k) = (self.session(), self.lang_ctx(self.head()), key.to_string());
            self.spawn(move || s.references_at(&ctx), move |ed, r| {
                if let Some(refs) = ed.ls.refs.as_mut().filter(|r| r.0 == k) {
                    refs.1 = Some(r.and_then(Result::ok));
                }
            });
        }
        let list = match &self.ls.refs.as_ref()?.1 {
            None => return Some((vec![], vec![])),
            Some(None) => return None,
            Some(Some(list)) => list.clone(),
        };
        let mut out: Vec<(crate::decorations::Hit, bool)> = list
            .iter()
            .filter(|r| r.start.line == r.end.line && r.end.col > r.start.col && r.start.line < self.buf.lines.len())
            .map(|r| {
                let (a, b) = (self.pos16(r.start), self.pos16(r.end));
                ((a.line, a.col, b.col.saturating_sub(a.col)), r.write)
            })
            .collect();
        out.sort();
        Some(out.into_iter().unzip())
    }

    // ----- timers -----
    pub fn lang_deadline(&self) -> Option<Instant> {
        [self.ls.outline_at, self.ls.hover_at.map(|h| h.0), self.ls.bulb.as_ref().and_then(|b| b.ask_at), self.ls.installing.map(|i| i.2)].into_iter().flatten().min()
    }

    // ----- missing language servers (VS Code's extension recommendations) -----
    /// The status bar's offer to install this file's missing server (once per language a session), unless turned off.
    pub fn install_offer(&self) -> Option<crate::lang::InstallHint> {
        if self.settings.ignore_recommendations {
            return None;
        }
        crate::lang::offered(self.lang.session.as_ref()?.kind()?)
    }
    /// Runs the offer's install in a new terminal tab (herdr-app terminal.open), so it is seen; never on its own. Outside
    /// Herdr, or without herdr-app (a remote machine), the status bar says what to run. Then it looks for the server
    /// every 3 s, 10 minutes at most, and starts it once it is there.
    pub fn install_server(&mut self) {
        let Some(h) = self.install_offer() else { return };
        crate::lang::take_offer(h.kind);
        if std::env::var_os("HC_TERMINAL_ID").is_none() || crate::term::which("herdr-app").is_none() {
            return self.say(format!("Run in a terminal: {}", h.command), None, 15000);
        }
        let root = crate::lang::git_root(&self.file).to_string_lossy().into_owned();
        let argv = serde_json::to_string(&crate::lang::install_argv(h.command)).unwrap_or_default();
        crate::term::herdr(&["do", "terminal.open", "--place", "tab", "--name", &format!("Install {}", h.label), "--folder", &root, "--argv", &argv], false);
        self.say(format!("Installing {} in a new terminal tab…", h.label), None, 5000);
        let now = Instant::now();
        self.ls.installing = Some((h.kind, h.label, now + INSTALL_POLL, now + Duration::from_secs(600)));
    }
    /// After an install: true when the server turned up (it starts with the next outline).
    fn install_tick(&mut self, now: Instant) -> bool {
        let Some((kind, label, next, end)) = self.ls.installing.filter(|i| i.2 <= now) else { return false };
        if crate::lang::found(kind) {
            self.ls.installing = None;
            crate::lang::retry(kind);
            self.queue_outline();
            self.say(format!("{label} is installed"), None, 3000);
            return true;
        }
        self.ls.installing = (now < end).then_some((kind, label, next.max(now) + INSTALL_POLL, end));
        false
    }
    /// Runs the language timers that are due; true to draw again.
    pub fn lang_tick(&mut self) -> bool {
        let now = Instant::now();
        let mut redraw = self.run_jobs();
        if self.ls.outline_at.is_some_and(|t| t <= now) {
            self.ls.outline_at = None;
            if self.exit.is_none() {
                self.load_outline(false);
            }
        }
        if let Some((_, p)) = self.ls.hover_at.filter(|h| h.0 <= now) {
            self.ls.hover_at = None;
            if p.line < self.buf.lines.len() {
                self.show_hover(p, true);
            }
            redraw = true;
        }
        if self.ls.bulb.as_ref().and_then(|b| b.ask_at).is_some_and(|t| t <= now) {
            self.ask_bulb();
        }
        redraw | self.install_tick(now)
    }
}

/// The [from, to) bytes of the string token at `col` (quotes included), or None.
fn string_at(tokens: Option<&crate::highlight::Tokens>, text: &str, col: usize) -> Option<(usize, usize)> {
    use crate::highlight::{token_index, token_type_of};
    let tk = tokens.filter(|t| !t.is_empty())?;
    if col >= text.len() {
        return None;
    }
    let is_string = |k: usize| token_type_of(tk[k].1) == 2;
    let (mut s, mut e) = (token_index(tk, col), token_index(tk, col));
    if !is_string(s) {
        return None;
    }
    while s > 0 && is_string(s - 1) {
        s -= 1;
    }
    while e + 1 < tk.len() && is_string(e + 1) {
        e += 1;
    }
    Some((tk[s].0 as usize, tk.get(e + 1).map_or(text.len(), |t| t.0 as usize)))
}
