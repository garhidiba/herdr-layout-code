//! The editor (vsedit.cjs's Editor): one file's buffer, selection and view, its edits and commands, prompts and
//! overlays, save / quit / hot exit and auto save. Drawing and the mouse are in view.rs.

mod lang_ui;

pub use lang_ui::{LangDoc, LangState, MAct, Problem};

use crate::autoclose::{self, Typed};
use crate::backup;
use crate::buffer::{caret, edit, end_of, insert_at, pos, Buffer, Change, Edit, Pos, Sel};
use crate::commands::{Act, FindOption, LiveKeys};
use crate::decorations::{self, is_word_char, Hit};
use crate::file::{self, detect_indent, Doc, Indent};
use crate::find::{self, Opts};
use crate::folding::{self, Folds, Range};
use crate::gitgutter::{self, GitGutter};
use crate::highlight::{token_index, token_type_of, Highlight, SemanticLayer};
use crate::keys::{Ev, Key};
use crate::language::{comment_of, language_name};
use crate::overlays::{button, Dialog, Input, InputOutcome, Menu, Outcome, Picker};
use crate::paint::{Color, Palette};
use crate::scrollbar::Bar;
use crate::settings::{self, AutoSave, Settings};
use crate::term::{self, Term};
use crate::width::{display_col, index_at_col, next_index, prev_index};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Shown for the keys of what neither editor has yet (multiple cursors, suggestions, word wrap).
pub const NOT_YET: &str = "Not yet in the Rust editor";
const WORD_DELAY: Duration = Duration::from_millis(250);

/// VS Code's word classes: spaces, word characters, punctuation.
fn class_of(c: char) -> u8 {
    if c.is_whitespace() {
        0
    } else if is_word_char(c) {
        1
    } else {
        2
    }
}

/// Skip spaces, then one run of word characters or of punctuation.
pub fn word_right(line: &str, mut col: usize) -> usize {
    let at = |i: usize| line[i..].chars().next();
    while let Some(c) = at(col).filter(|c| class_of(*c) == 0) {
        col += c.len_utf8();
    }
    let k = at(col).map_or(0, class_of);
    while let Some(c) = at(col).filter(|c| k != 0 && class_of(*c) == k) {
        col += c.len_utf8();
    }
    col
}

pub fn word_left(line: &str, mut col: usize) -> usize {
    let before = |i: usize| line[..i].chars().next_back();
    while let Some(c) = before(col).filter(|c| class_of(*c) == 0) {
        col -= c.len_utf8();
    }
    let k = before(col).map_or(0, class_of);
    while let Some(c) = before(col).filter(|c| k != 0 && class_of(*c) == k) {
        col -= c.len_utf8();
    }
    col
}

/// VS Code's "Col": characters before the cursor, tabs counted to the next tab stop.
pub fn visible_column(line: &str, index: usize, tab: usize) -> usize {
    line[..index].chars().fold(0, |c, ch| if ch == '\t' { c + tab - c % tab } else { c + 1 })
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `folder › folder › file` relative to the enclosing git repo (else the home folder).
pub fn breadcrumbs(file: &Path) -> Vec<String> {
    let home = settings::home_dir();
    let base = term::git_root(file).unwrap_or_else(|| if file.starts_with(&home) && file != home { home } else { PathBuf::from("/") });
    file.strip_prefix(&base).unwrap_or(file).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).filter(|s| !s.is_empty() && s != "/").collect()
}

#[derive(Clone, Debug)]
pub enum DAct {
    QuitSave,
    QuitDiscard,
    Cancel,
    Overwrite { then_quit: bool },
    /// Save As onto an existing file.
    Replace(PathBuf),
    Reload,
    Restore,
    Discard,
}

#[derive(Clone, Debug)]
pub enum IAct {
    Goto,
    AutoSaveDelay,
    SaveAs,
    /// Rename Symbol from this word.
    Rename(String),
    ChangeAll,
}

#[derive(Clone, Debug)]
pub enum PAct {
    IndentMenu(bool),
    TabSize(bool, usize),
    Eol(bool),
    Language(Option<String>),
    /// Go to File: a path relative to the project root.
    Open(String),
    /// Go to File's ":<line>".
    GotoLine(String),
    /// A command of the palette.
    Command(&'static str),
    /// A symbol: file, line, UTF-16 column.
    Jump(PathBuf, usize, usize),
    /// A code action of the last list.
    Action(usize),
    /// An information row ("Loading symbols…").
    Nothing,
}

pub enum Popup {
    Dialog(Dialog<DAct>),
    Input(Input<IAct>),
    Picker(Picker<PAct>),
    Menu(Menu<MAct>),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Field {
    Query,
    Replace,
}

pub struct Find {
    pub query: String,
    pub replace: String,
    pub field: Field,
    pub opts: Opts,
    pub matches: Vec<Hit>,
    pub error: Option<String>,
    searched: Option<(u64, Opts, String)>,
}

/// The open find widget.
pub struct Prompt {
    pub replace: bool,
    pub origin: Sel,
}

pub struct Message {
    pub text: String,
    pub color: Color,
    pub until: Instant,
}

/// Everything that belongs to one open file (vsedit.cjs DOC_FIELDS); showing another file swaps these with the editor's.
pub struct DocState {
    pub(crate) file: PathBuf,
    doc: Doc,
    pub(crate) buf: Buffer,
    pub(crate) hl: Highlight,
    semantic: SemanticLayer,
    pub(crate) indent: Indent,
    scope: Option<String>,
    language: String,
    crumbs: Vec<String>,
    sel: Sel,
    goal: Option<usize>,
    top: usize,
    left: usize,
    folds: Folds,
    ranges: Option<(u64, usize, Vec<Range>)>,
    git: GitGutter,
    seen_version: u64,
    closers: (u64, Vec<Pos>),
    lang: LangDoc,
}

impl DocState {
    fn new(file: PathBuf, doc: Doc, hl: Highlight, index: &Value, settings: &Settings) -> DocState {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let scope = crate::language::scope_of(index, &name);
        let known = scope.as_deref().filter(|s| index["scopes"].get(*s).is_some());
        let buf = Buffer::new(doc.lines.clone());
        let indent = detect_indent(&buf.lines, Indent { use_tabs: !settings.insert_spaces, size: settings.tab_size });
        let mut semantic = SemanticLayer::default();
        semantic.reset(buf.lines.len());
        DocState {
            crumbs: breadcrumbs(&file),
            language: language_name(known),
            git: GitGutter::new(&file),
            file,
            doc,
            buf,
            hl,
            semantic,
            indent,
            scope,
            sel: Sel::default(),
            goal: None,
            top: 0,
            left: 0,
            folds: Folds::default(),
            ranges: None,
            seen_version: 0,
            closers: (0, vec![]),
            lang: LangDoc::default(),
        }
    }
}

/// Where Go Back / Go Forward return to: (file, cursor, top line).
type NavEntry = (PathBuf, Pos, usize);

pub struct Editor {
    pub file: PathBuf,
    pub doc: Doc,
    pub buf: Buffer,
    pub hl: Highlight,
    pub semantic: SemanticLayer,
    pub indent: Indent,
    pub scope: Option<String>,
    pub language: String,
    pub crumbs: Vec<String>,
    pub sel: Sel,
    goal: Option<usize>,
    pub top: usize,
    pub left: usize,
    pub rows: i32,
    pub cols: i32,
    pub c: Palette,
    pub index: Value,
    pub settings: Settings,
    settings_stamp: Option<file::Stamp>,
    pub keys: LiveKeys,
    pub message: Option<Message>,
    pub popup: Option<Popup>,
    pub prompt: Option<Prompt>,
    /// The first key of a two-step chord, waiting for the second.
    chord_prefix: Option<String>,
    pub find: Find,
    clip: (String, bool),
    closers: (u64, Vec<Pos>),
    pub folds: Folds,
    ranges: Option<(u64, usize, Vec<Range>)>,
    pub git: GitGutter,
    pub vbar: Bar,
    pub hbar: Bar,
    pub marks: Option<Vec<Option<String>>>,
    pub hover_mode: Option<bool>,
    pub gutter_hover: bool,
    pub dragging: bool,
    pub drag: Option<(i32, i32)>,
    pub drag_next: Option<Instant>,
    pub last_click: (Instant, Pos),
    pub status_hits: Vec<(i32, i32, StatusAct)>,
    pub find_box: Option<(i32, i32, i32, i32)>,
    pub find_hits: Vec<(i32, i32, i32, FindAct)>,
    pub word: Option<(String, Instant)>,
    pub hits_cache: Option<(String, Vec<Hit>)>,
    seen_version: u64,
    auto_at: Option<Instant>,
    pub exit: Option<i32>,
    /// The other open files (Go to File, Open Settings JSON, Save All, quit and hot exit go through them).
    pub(crate) docs: Vec<DocState>,
    back: Vec<NavEntry>,
    forward: Vec<NavEntry>,
    /// Go to File's list: (root, files relative to it).
    project: Option<(PathBuf, Vec<String>)>,
    vscode: PathBuf,
    /// The current file's language session, outline and semantic state.
    pub lang: LangDoc,
    /// Language results, overlays and timers.
    pub ls: LangState,
}

#[derive(Clone, Copy, Debug)]
pub enum StatusAct {
    Goto,
    Indent,
    Eol,
    Language,
}

#[derive(Clone, Copy, Debug)]
pub enum FindAct {
    ToggleReplace,
    Field(Field),
    Toggle(FindOption),
    Prev,
    Next,
    Close,
    ReplaceOne,
    ReplaceAll,
}

impl Editor {
    /// `theme`: the theme file (its colors, and semantic token colors when it turns them on).
    pub fn new(file: PathBuf, doc: Doc, hl: Highlight, index: Value, theme: &Value, vscode: PathBuf) -> Editor {
        let settings_path = settings::settings_file();
        let (settings, settings_stamp) = settings::load(&settings_path);
        let st = DocState::new(file, doc, hl, &index, &settings);
        let now = Instant::now();
        Editor {
            crumbs: st.crumbs,
            language: st.language,
            git: st.git,
            file: st.file,
            doc: st.doc,
            buf: st.buf,
            hl: st.hl,
            semantic: st.semantic,
            indent: st.indent,
            scope: st.scope,
            sel: st.sel,
            goal: st.goal,
            top: st.top,
            left: st.left,
            rows: 24,
            cols: 80,
            c: Palette::of(&theme["colors"]),
            index,
            settings,
            settings_stamp,
            keys: LiveKeys::new(),
            message: None,
            popup: None,
            prompt: None,
            chord_prefix: None,
            find: Find { query: String::new(), replace: String::new(), field: Field::Query, opts: Opts::default(), matches: vec![], error: None, searched: None },
            clip: (String::new(), false),
            closers: st.closers,
            folds: st.folds,
            ranges: st.ranges,
            vbar: Bar::new(true),
            hbar: Bar::new(false),
            marks: None,
            hover_mode: None,
            gutter_hover: false,
            dragging: false,
            drag: None,
            drag_next: None,
            last_click: (now - Duration::from_secs(10), pos(usize::MAX, 0)),
            status_hits: vec![],
            find_box: None,
            find_hits: vec![],
            word: None,
            hits_cache: None,
            seen_version: st.seen_version,
            auto_at: None,
            exit: None,
            docs: vec![],
            back: vec![],
            forward: vec![],
            project: None,
            vscode,
            lang: st.lang,
            ls: LangState::new(theme),
        }
    }

    /// Swaps the editor's file fields with `st` (vsedit.cjs activate).
    fn swap_doc(&mut self, st: &mut DocState) {
        use std::mem::swap;
        swap(&mut self.file, &mut st.file);
        swap(&mut self.doc, &mut st.doc);
        swap(&mut self.buf, &mut st.buf);
        swap(&mut self.hl, &mut st.hl);
        swap(&mut self.semantic, &mut st.semantic);
        swap(&mut self.indent, &mut st.indent);
        swap(&mut self.scope, &mut st.scope);
        swap(&mut self.language, &mut st.language);
        swap(&mut self.crumbs, &mut st.crumbs);
        swap(&mut self.sel, &mut st.sel);
        swap(&mut self.goal, &mut st.goal);
        swap(&mut self.top, &mut st.top);
        swap(&mut self.left, &mut st.left);
        swap(&mut self.folds, &mut st.folds);
        swap(&mut self.ranges, &mut st.ranges);
        swap(&mut self.git, &mut st.git);
        swap(&mut self.seen_version, &mut st.seen_version);
        swap(&mut self.closers, &mut st.closers);
        swap(&mut self.lang, &mut st.lang);
    }

    pub fn lines(&self) -> &[String] {
        &self.buf.lines
    }
    pub fn tab(&self) -> usize {
        self.indent.size
    }
    pub fn head(&self) -> Pos {
        self.sel.head
    }
    pub fn empty(&self) -> bool {
        self.sel.is_empty()
    }
    pub fn range(&self) -> (Pos, Pos) {
        self.sel.range()
    }
    pub fn say(&mut self, text: impl Into<String>, color: Option<&str>, ms: u64) {
        let color = color.unwrap_or(&self.c.bar_fg).to_string();
        self.message = Some(Message { text: text.into(), color, until: Instant::now() + Duration::from_millis(ms) });
    }
    pub fn warn(&mut self, text: impl Into<String>) {
        let w = self.c.warn.clone();
        self.say(text, Some(&w), 3000);
    }
    fn error(&mut self, text: impl Into<String>, ms: u64) {
        let e = self.c.error.clone();
        self.say(text, Some(&e), ms);
    }

    // ----- text rows and columns (less the scrollbars of the last frame) -----
    pub fn height(&self) -> usize {
        (self.rows - 2 - self.panel_height() - self.hbar.shown as i32).max(1) as usize
    }
    /// The results panel's rows (0 without one).
    pub fn panel_height(&self) -> i32 {
        if self.ls.panel.is_some() { crate::overlays::Panel::height(self.rows) } else { 0 }
    }
    pub fn gutter(&self) -> usize {
        self.lines().len().to_string().len().max(3) + 3
    }
    pub fn text_width(&self) -> usize {
        (self.cols - self.gutter() as i32 - self.vbar.shown as i32).max(1) as usize
    }
    pub fn row_of(&mut self, line: usize) -> usize {
        self.folds.row_of(line)
    }
    pub fn line_at_row(&mut self, v: usize) -> usize {
        self.folds.line_at_row(v)
    }
    pub fn view_count(&mut self) -> usize {
        let n = self.buf.lines.len();
        self.folds.view_count(n)
    }
    /// The line `rows` view rows from top, clamped to [0, max].
    pub fn scrolled(&mut self, rows: i64, max: Option<usize>) -> usize {
        let max = max.unwrap_or_else(|| self.view_count().saturating_sub(1)) as i64;
        let t = self.row_of(self.top) as i64;
        self.line_at_row((t + rows).clamp(0, max.max(0)) as usize)
    }

    // ----- after edits: the highlighter, folds, git and the semantic layer follow the buffer -----
    fn sync(&mut self) {
        let changes: Vec<Change> = self.buf.take_changes();
        if changes.is_empty() {
            return;
        }
        self.hl.edited(&changes, &self.buf.lines);
        self.semantic.edited(&changes);
        for c in &changes {
            self.folds.edited(*c);
        }
        self.git.changed();
    }
    fn apply(&mut self, edits: Vec<Edit>, before: Sel, after: Option<Sel>, typing: bool) {
        self.buf.edit(edits, Some(before), after, typing);
        self.sync();
    }

    // ----- cursor -----
    pub fn move_to(&mut self, p: Pos, extend: bool) {
        self.move_keep(p, extend, false);
    }
    fn move_keep(&mut self, p: Pos, extend: bool, keep_goal: bool) {
        let p = self.buf.clamp(p);
        self.sel = if extend { Sel { anchor: self.sel.anchor, head: p } } else { caret(p) };
        if !keep_goal {
            self.goal = None;
        }
        self.buf.seal();
        self.reveal();
    }
    pub fn reveal(&mut self) {
        let Pos { line, col } = self.head();
        self.folds.reveal(line);
        let row = self.row_of(line) as i64 - self.row_of(self.top) as i64;
        if row < 0 {
            self.top = line;
        }
        let h = self.height();
        if row >= h as i64 {
            let v = self.row_of(line) + 1 - h;
            self.top = self.line_at_row(v);
        }
        let x = display_col(&self.buf.lines[line], col, self.tab());
        if x < self.left {
            self.left = x.saturating_sub(4);
        }
        if x >= self.left + self.text_width() {
            self.left = x + 5 - self.text_width();
        }
    }
    fn vertical(&mut self, delta: i64, extend: bool) {
        let Pos { line, col } = self.head();
        let goal = *self.goal.get_or_insert_with(|| display_col(&self.buf.lines[line], col, self.indent.size));
        let v = self.row_of(line) as i64 + delta;
        let end = self.view_count() as i64 - 1;
        if v < 0 {
            return self.move_to(pos(0, 0), extend);
        }
        if v > end {
            let l = self.line_at_row(end as usize);
            return self.move_to(pos(l, self.buf.lines[l].len()), extend);
        }
        let target = self.line_at_row(v as usize);
        let col = index_at_col(&self.buf.lines[target], goal, self.tab());
        self.move_keep(pos(target, col), extend, true);
    }
    fn horizontal(&mut self, dir: i32, extend: bool, word: bool) {
        if !extend && !self.empty() && !word {
            let (s, e) = self.range();
            return self.move_to(if dir < 0 { s } else { e }, false);
        }
        let Pos { mut line, mut col } = self.head();
        let text = &self.buf.lines[line];
        if dir < 0 {
            if col == 0 {
                if line > 0 {
                    line -= 1;
                    col = self.buf.lines[line].len();
                }
            } else {
                col = if word { word_left(text, col) } else { prev_index(text, col) };
            }
        } else if col >= text.len() {
            if line + 1 < self.buf.lines.len() {
                line += 1;
                col = 0;
            }
        } else {
            col = if word { word_right(text, col) } else { next_index(text, col) };
        }
        self.move_to(pos(line, col), extend);
    }
    fn home(&mut self, extend: bool) {
        let Pos { line, col } = self.head();
        let t = &self.buf.lines[line];
        let first = t.find(|c: char| !c.is_whitespace()).unwrap_or(t.len());
        self.move_to(pos(line, if col == first { 0 } else { first }), extend);
    }
    fn line_end(&mut self, extend: bool) {
        let l = self.head().line;
        self.move_to(pos(l, self.buf.lines[l].len()), extend);
    }
    fn doc_end(&mut self, extend: bool) {
        let last = self.buf.lines.len() - 1;
        self.move_to(pos(last, self.buf.lines[last].len()), extend);
    }

    // ----- editing -----
    /// Replaces the selection with text, as one undo step (typing keeps grouping).
    fn insert(&mut self, text: &str, typing: bool) {
        let before = self.sel;
        let (s, e) = self.range();
        let at = end_of(s, text);
        self.apply(vec![edit(s, e, text)], before, Some(caret(at)), typing);
        self.sel = caret(at);
        self.goal = None;
        self.reveal();
    }
    fn typed(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        if text.chars().count() > 1 && !text.contains('\n') && text.contains(['(', ')', '[', ']', '{', '}', '"', '\'', '`']) {
            for ch in text.chars() {
                self.typed(&ch.to_string());
            }
            return;
        }
        let closers = self.live_closers();
        let (Pos { line, col }, empty) = (self.head(), self.empty());
        if text.chars().count() == 1 && self.auto_close(text.chars().next().unwrap(), &closers) {
            return;
        }
        self.insert(&text, !text.contains('\n'));
        if empty && !text.contains('\n') {
            self.set_closers(shift_closers(&closers, line, col, text.len() as i64));
        }
    }

    // ----- auto-closing pairs: closers the editor inserted, valid until an edit they weren't moved along with -----
    fn live_closers(&self) -> Vec<Pos> {
        if self.closers.0 == self.buf.version {
            self.closers.1.clone()
        } else {
            vec![]
        }
    }
    fn set_closers(&mut self, at: Vec<Pos>) {
        self.closers = (self.buf.version, at);
    }
    fn auto_close(&mut self, ch: char, closers: &[Pos]) -> bool {
        let Pos { line, col } = self.head();
        if matches!(ch, '"' | '\'' | '`') {
            // the string/comment check needs this line's tokens: give the worker a moment, as the JS tokenizes it inline
            let lines = &self.buf.lines;
            self.hl.wait(lines, Instant::now() + Duration::from_millis(20), |h| !h.has_grammar && h.ready || h.line(line).is_some());
        }
        let text = self.buf.lines[line].clone();
        let is_closer = closers.contains(&pos(line, col));
        let ctx = autoclose::Ctx {
            scope: self.scope.as_deref(),
            text: &text,
            col,
            selected: !self.empty(),
            closer: is_closer,
            in_text: autoclose::in_string_or_comment(self.hl.line(line), &text, col),
        };
        let Some(action) = autoclose::on_type(ch, &ctx) else { return false };
        let close = autoclose::closer(self.scope.as_deref(), ch);
        match action {
            Typed::Over => {
                self.move_to(pos(line, col + ch.len_utf8()), false);
                self.set_closers(closers.iter().copied().filter(|q| *q != pos(line, col)).collect());
            }
            Typed::Wrap => {
                let (s, e) = self.range();
                let before = self.sel;
                let n = ch.len_utf8();
                let shift = |p: Pos| if p.line == s.line { pos(p.line, p.col + n) } else { p };
                let after = Sel { anchor: shift(before.anchor), head: shift(before.head) };
                self.apply(vec![insert_at(e, close.unwrap().to_string()), insert_at(s, ch.to_string())], before, Some(after), false);
                self.sel = after;
                self.buf.seal();
                self.reveal();
            }
            Typed::Pair => {
                let at = pos(line, col + ch.len_utf8());
                let before = self.sel;
                self.apply(vec![insert_at(self.head(), format!("{ch}{}", close.unwrap()))], before, Some(caret(at)), true);
                self.sel = caret(at);
                self.goal = None;
                self.reveal();
                let mut next = shift_closers(closers, line, col, (ch.len_utf8() + close.unwrap().len_utf8()) as i64);
                next.push(at);
                self.set_closers(next);
            }
        }
        true
    }
    fn delete_range(&mut self, s: Pos, e: Pos) {
        if s == e {
            return;
        }
        let before = self.sel;
        self.apply(vec![edit(s, e, "")], before, Some(caret(s)), false);
        self.move_to(s, false);
    }
    fn backspace(&mut self, word: bool) {
        if !self.empty() {
            let (s, e) = self.range();
            return self.delete_range(s, e);
        }
        let Pos { line, col } = self.head();
        let text = self.buf.lines[line].clone();
        let closers = self.live_closers();
        if col == 0 {
            if line > 0 {
                let p = pos(line - 1, self.buf.lines[line - 1].len());
                self.delete_range(p, self.head());
            }
            return;
        }
        let here = closers.contains(&pos(line, col));
        if !word && autoclose::deletes_pair(self.scope.as_deref(), &text, col, here) {
            let b = text[..col].chars().next_back().unwrap().len_utf8();
            let a = text[col..].chars().next().unwrap().len_utf8();
            self.delete_range(pos(line, col - b), pos(line, col + a));
            let rest: Vec<Pos> = closers.into_iter().filter(|q| *q != pos(line, col)).collect();
            self.set_closers(shift_closers(&rest, line, col, -((a + b) as i64)));
            return;
        }
        let mut to = if word { word_left(&text, col) } else { prev_index(&text, col) };
        let lead = &text[..col];
        if !word && !self.indent.use_tabs && !lead.is_empty() && lead.bytes().all(|b| b == b' ') {
            to = col - ((col - 1) % self.tab() + 1); // to the previous tab stop
        }
        self.delete_range(pos(line, to), self.head());
        self.set_closers(shift_closers(&closers, line, col, to as i64 - col as i64));
    }
    fn delete_forward(&mut self, word: bool) {
        if !self.empty() {
            let (s, e) = self.range();
            return self.delete_range(s, e);
        }
        let Pos { line, col } = self.head();
        let text = &self.buf.lines[line];
        if col >= text.len() {
            if line + 1 < self.buf.lines.len() {
                self.delete_range(self.head(), pos(line + 1, 0));
            }
            return;
        }
        let to = if word { word_right(text, col) } else { next_index(text, col) };
        self.delete_range(self.head(), pos(line, to));
    }
    fn unit(&self, at_col: usize) -> String {
        if self.indent.use_tabs {
            "\t".into()
        } else {
            " ".repeat(self.tab() - at_col % self.tab())
        }
    }
    fn enter(&mut self) {
        let (s, e) = self.range();
        let text = &self.buf.lines[s.line];
        let indent: String = text[..s.col].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        let before = text[..s.col].trim_end().chars().last();
        let after = self.buf.lines[e.line][e.col..].trim_start().chars().next();
        let pair = match before {
            Some('{') => Some('}'),
            Some('[') => Some(']'),
            Some('(') => Some(')'),
            _ => None,
        };
        if let Some(pair) = pair {
            let inner = indent.clone() + &self.unit(0);
            if after == Some(pair) {
                let sel = self.sel;
                let at = pos(s.line + 1, inner.len());
                self.apply(vec![edit(s, e, format!("\n{inner}\n{indent}"))], sel, Some(caret(at)), false);
                return self.move_to(at, false);
            }
            return self.insert(&format!("\n{inner}"), false);
        }
        self.insert(&format!("\n{indent}"), false);
    }
    /// Lines touched by the selection (a selection ending at column 0 doesn't include that line).
    fn selected_lines(&self) -> (usize, usize) {
        let (s, e) = self.range();
        (s.line, if e.line > s.line && e.col == 0 { e.line - 1 } else { e.line })
    }
    /// Per-line edits (line, col, remove, text) as one step, shifting the selection along.
    fn line_edits(&mut self, edits: Vec<(usize, usize, usize, String)>) {
        if edits.is_empty() {
            return;
        }
        let shift = |p: Pos| {
            let mut col = p.col;
            for (line, c, remove, text) in &edits {
                if *line == p.line && p.col >= *c {
                    col = (col - (*remove).min(p.col - c)).max(*c) + text.len();
                }
            }
            pos(p.line, col)
        };
        let before = self.sel;
        let after = Sel { anchor: shift(self.sel.anchor), head: shift(self.sel.head) };
        let list = edits.iter().map(|(l, c, r, t)| edit(pos(*l, *c), pos(*l, c + r), t.clone())).collect();
        self.apply(list, before, Some(after), false);
        self.sel = after;
        self.buf.seal();
        self.reveal();
    }
    fn indent_lines(&mut self, out: bool) {
        let (a, b) = self.selected_lines();
        let mut edits = vec![];
        for l in a..=b {
            let text = &self.buf.lines[l];
            if out {
                let n = if text.starts_with('\t') {
                    1
                } else {
                    let max = if self.indent.use_tabs { 4 } else { self.tab() };
                    text.bytes().take(max).take_while(|b| *b == b' ').count()
                };
                if n > 0 {
                    edits.push((l, 0, n, String::new()));
                }
            } else if !text.is_empty() || a == b {
                edits.push((l, 0, 0, self.unit(0)));
            }
        }
        self.line_edits(edits);
    }
    fn tab_key(&mut self, shift: bool) {
        let (s, e) = self.range();
        if shift || s.line != e.line {
            return self.indent_lines(shift);
        }
        let u = self.unit(display_col(&self.buf.lines[s.line], s.col, self.tab()));
        self.insert(&u, false);
    }
    /// mode: None toggles; Some(true) comments the lines, Some(false) uncomments the commented ones (⌘K ⌘C / ⌘K ⌘U).
    fn toggle_comment(&mut self, mode: Option<bool>) {
        let Some((open, close)) = comment_of(self.scope.as_deref()) else {
            return self.warn(format!("No comment syntax known for {}", self.language));
        };
        let (a, b) = self.selected_lines();
        let lead = |t: &str| t.len() - t.trim_start_matches([' ', '\t']).len();
        let lines = &self.buf.lines;
        let is_commented = |l: &usize| {
            let t = &lines[*l];
            t[lead(t)..].starts_with(open) && close.is_none_or(|c| t.trim_end().ends_with(c))
        };
        let mut rows: Vec<usize> = (a..=b).filter(|l| !lines[*l].trim().is_empty()).collect();
        if mode == Some(false) {
            rows.retain(is_commented);
        }
        if rows.is_empty() {
            return;
        }
        let commented = match mode {
            Some(add) => !add,
            None => rows.iter().all(is_commented),
        };
        let mut edits = vec![];
        if commented {
            for &l in &rows {
                let t = &lines[l];
                let at = lead(t);
                let sp = (t.as_bytes().get(at + open.len()) == Some(&b' ')) as usize;
                if let Some(close) = close {
                    let end = t.trim_end().len() - close.len();
                    let sp2 = (end > 0 && t.as_bytes()[end - 1] == b' ') as usize;
                    edits.push((l, end - sp2, close.len() + sp2, String::new()));
                }
                edits.push((l, at, open.len() + sp, String::new()));
            }
        } else {
            let at = rows.iter().map(|l| lead(&lines[*l])).min().unwrap_or(0);
            for &l in &rows {
                if let Some(close) = close {
                    edits.push((l, lines[l].trim_end().len(), 0, format!(" {close}")));
                }
                edits.push((l, at, 0, format!("{open} ")));
            }
        }
        self.line_edits(edits);
    }

    // ----- clipboard -----
    fn copy(&mut self, term: &mut Term, cut: bool) {
        let whole = self.empty();
        let text = if whole { format!("{}\n", self.buf.lines[self.head().line]) } else { self.buf.text(self.sel.anchor, self.sel.head) };
        term::write_clipboard(term, &text);
        self.clip = (text, whole);
        if !cut {
            return;
        }
        if !whole {
            let (s, e) = self.range();
            return self.delete_range(s, e);
        }
        let l = self.head().line;
        let last = self.buf.lines.len() - 1;
        if last == 0 {
            return self.delete_range(pos(0, 0), pos(0, self.buf.lines[0].len()));
        }
        let (s, e) = if l < last { (pos(l, 0), pos(l + 1, 0)) } else { (pos(l - 1, self.buf.lines[l - 1].len()), pos(l, self.buf.lines[l].len())) };
        self.delete_range(s, e);
        self.move_to(pos(l.min(self.buf.lines.len() - 1), 0), false);
    }
    fn paste(&mut self, text: Option<String>) {
        let text = text.or_else(term::read_clipboard).unwrap_or_else(|| self.clip.0.clone()).replace("\r\n", "\n").replace('\r', "\n");
        if text.is_empty() {
            return;
        }
        if self.clip.1 && text == self.clip.0 && self.empty() {
            // a whole line copied with an empty selection goes above the current line
            let p = pos(self.head().line, 0);
            let at = pos(self.head().line + 1, self.head().col);
            let sel = self.sel;
            self.apply(vec![insert_at(p, text)], sel, Some(caret(at)), false);
            return self.move_to(at, false);
        }
        self.insert(&text, false);
    }
    fn undo(&mut self, redo: bool) {
        let s = if redo { self.buf.redo() } else { self.buf.undo() };
        self.sync();
        if let Some(s) = s {
            self.sel = Sel { anchor: self.buf.clamp(s.anchor), head: self.buf.clamp(s.head) };
            self.reveal();
        }
    }
    fn select_all(&mut self) {
        let last = self.buf.lines.len() - 1;
        self.sel = Sel { anchor: pos(0, 0), head: pos(last, self.buf.lines[last].len()) };
        self.buf.seal();
    }
    /// The word under/before p: (text, start, end).
    pub fn word_at(&self, p: Pos) -> Option<(String, Pos, Pos)> {
        let t = &self.buf.lines[p.line];
        let s = t[..p.col].char_indices().rev().take_while(|(_, c)| is_word_char(*c)).last().map_or(p.col, |(i, _)| i);
        let e = p.col + t[p.col..].chars().take_while(|c| is_word_char(*c)).map(char::len_utf8).sum::<usize>();
        (s < e).then(|| (t[s..e].to_string(), pos(p.line, s), pos(p.line, e)))
    }
    fn select_next_occurrence(&mut self) {
        if self.empty() {
            if let Some((_, s, e)) = self.word_at(self.head()) {
                self.sel = Sel { anchor: s, head: e };
                self.buf.seal();
            }
            return;
        }
        let (s, e) = self.range();
        let text = self.buf.text(s, e);
        if text.contains('\n') {
            return;
        }
        let n = self.buf.lines.len();
        for k in 0..=n {
            let l = (e.line + k) % n;
            let from = if k == 0 { e.col } else { 0 };
            if let Some(i) = self.buf.lines[l][from..].find(&text).map(|i| i + from) {
                if !(k == n && i >= s.col) {
                    self.sel = Sel { anchor: pos(l, i), head: pos(l, i + text.len()) };
                    self.buf.seal();
                    self.reveal();
                    return;
                }
            }
        }
    }
    fn delete_lines(&mut self) {
        let (a, b) = self.selected_lines();
        let last = self.buf.lines.len() - 1;
        let col = self.head().col;
        if b < last {
            self.delete_range(pos(a, 0), pos(b + 1, 0));
        } else if a > 0 {
            self.delete_range(pos(a - 1, self.buf.lines[a - 1].len()), pos(b, self.buf.lines[b].len()));
        } else {
            self.delete_range(pos(0, 0), pos(b, self.buf.lines[b].len()));
        }
        self.move_to(pos(a.min(self.buf.lines.len() - 1), col), false);
    }
    fn move_lines(&mut self, dir: i64) {
        let (a, b) = self.selected_lines();
        if (dir < 0 && a == 0) || (dir > 0 && b == self.buf.lines.len() - 1) {
            return;
        }
        let block = self.buf.lines[a..=b].to_vec();
        let (from, to) = if dir < 0 { (a - 1, b) } else { (a, b + 1) };
        let text = if dir < 0 { [block, vec![self.buf.lines[a - 1].clone()]].concat() } else { [vec![self.buf.lines[b + 1].clone()], block].concat() }.join("\n");
        let shift = |p: Pos| pos((p.line as i64 + dir) as usize, p.col);
        let before = self.sel;
        let after = Sel { anchor: shift(self.sel.anchor), head: shift(self.sel.head) };
        let end = pos(to, self.buf.lines[to].len());
        self.apply(vec![edit(pos(from, 0), end, text)], before, Some(after), false);
        self.sel = after;
        self.buf.seal();
        self.reveal();
    }
    fn copy_lines(&mut self, dir: i64) {
        let (a, b) = self.selected_lines();
        let block = self.buf.lines[a..=b].join("\n");
        let n = b - a + 1;
        let shift = |p: Pos| pos(p.line + if dir > 0 { n } else { 0 }, p.col);
        let before = self.sel;
        let after = Sel { anchor: shift(self.sel.anchor), head: shift(self.sel.head) };
        let at = pos(b, self.buf.lines[b].len());
        self.apply(vec![insert_at(at, format!("\n{block}"))], before, Some(after), false);
        self.sel = after;
        self.buf.seal();
        self.reveal();
    }
    fn insert_line(&mut self, below: bool) {
        let l = self.head().line;
        let indent: String = self.buf.lines[l].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        let at = if below { pos(l, self.buf.lines[l].len()) } else { pos(l, 0) };
        let p = pos(if below { l + 1 } else { l }, indent.len());
        let text = if below { format!("\n{indent}") } else { format!("{indent}\n") };
        let before = self.sel;
        self.apply(vec![insert_at(at, text)], before, Some(caret(p)), false);
        self.move_to(p, false);
    }

    /// Join Lines (VS Code's JoinLinesAction): the selected lines, else the cursor line and the next, become one; each
    /// joined line loses its indent and gets one space before it (none after an empty line, trailing whitespace becomes
    /// that space; blank lines vanish). The cursor goes to the last join, a multi-line selection keeps its distance
    /// from the end.
    fn join_lines(&mut self) {
        let (s, e) = self.range();
        let last = self.buf.lines.len() - 1;
        let single = s.line == e.line;
        let end = if single { (s.line + 1).min(last) } else { e.line };
        let end_len = self.buf.lines[end].len();
        let (mut text, mut back) = (self.buf.lines[s.line].clone(), 0);
        for t in &self.buf.lines[s.line + 1..=end] {
            let Some(i) = t.find(|c| c != ' ' && c != '\t') else {
                back = 0;
                continue;
            };
            let mut space = !text.is_empty();
            if space && text.ends_with([' ', '\t']) {
                space = false;
                text = text.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_string() + " ";
            }
            if space {
                text.push(' ');
            }
            text.push_str(&t[i..]);
            back = t.len() - i + space as usize;
        }
        let after = if self.empty() {
            caret(pos(s.line, text.len() - back))
        } else if single {
            Sel { anchor: s, head: e }
        } else {
            Sel { anchor: s, head: pos(s.line, text.len() - (end_len - e.col)) }
        };
        if end > s.line {
            let before = self.sel;
            self.apply(vec![edit(pos(s.line, 0), pos(end, end_len), text)], before, Some(after), false);
        }
        self.sel = after;
        self.buf.seal();
        self.reveal();
    }
    /// Expand Line Selection (⌘L): from the selection's first line start to the start of the line after its last line
    /// (the end of the file on the last line), so pressing it again adds the next line.
    fn expand_line_selection(&mut self) {
        let (s, e) = self.range();
        let last = self.buf.lines.len() - 1;
        let head = if e.line < last { pos(e.line + 1, 0) } else { pos(last, self.buf.lines[last].len()) };
        self.sel = Sel { anchor: pos(s.line, 0), head };
        self.buf.seal();
        self.reveal();
    }
    /// Toggle Block Comment (VS Code's BlockCommentCommand): with the selection between the language's block comment
    /// tokens (on its first and last line) they go, with one space inside each; else they wrap the selection with a
    /// space inside, the text staying selected; an empty selection gets `/*  */` with the cursor in the middle.
    fn block_comment(&mut self) {
        let Some((open, close)) = crate::language::block_comment_of(self.scope.as_deref()) else {
            return self.warn(format!("No block comment syntax known for {}", self.language));
        };
        let (s, e) = self.range();
        let (first, last) = (&self.buf.lines[s.line], &self.buf.lines[e.line]);
        let mut a = last_index_of(first, open, s.col + open.len());
        let from = e.col.saturating_sub(close.len()).max(if s.line == e.line { a.map_or(0, |a| a + open.len()) } else { 0 });
        let mut b = index_of(last, close, from);
        if let (Some(i), Some(j)) = (a, b) {
            let inside = if s.line == e.line { first[i + open.len()..j].to_string() } else { format!("{}\n{}", &first[i + open.len()..], &last[..j]) };
            if inside.contains(close) {
                (a, b) = (None, None); // `/* a */ b /* c */`: not one comment
            }
        }
        let before = self.sel;
        let (edits, after) = match (a, b) {
            (Some(a), Some(mut b)) => {
                let open_n = open.len() + (first.as_bytes().get(a + open.len()) == Some(&b' ')) as usize;
                let mut close_n = close.len();
                if b > 0 && last.as_bytes()[b - 1] == b' ' {
                    close_n += 1;
                    b -= 1;
                }
                if s.line == e.line && a + open_n >= b {
                    // nothing inside (`/*  */`): the whole comment goes
                    (vec![edit(pos(s.line, a), pos(s.line, (a + open_n).max(b + close_n)), "")], caret(pos(s.line, a)))
                } else {
                    let shift = if s.line == e.line { open_n } else { 0 };
                    let edits = vec![edit(pos(e.line, b), pos(e.line, b + close_n), ""), edit(pos(s.line, a), pos(s.line, a + open_n), "")];
                    (edits, Sel { anchor: pos(s.line, a), head: pos(e.line, b - shift) })
                }
            }
            _ if self.empty() => (vec![insert_at(s, format!("{open}  {close}"))], caret(pos(s.line, s.col + open.len() + 1))),
            _ => {
                let shift = if s.line == e.line { open.len() + 1 } else { 0 };
                let edits = vec![insert_at(e, format!(" {close}")), insert_at(s, format!("{open} "))];
                (edits, Sel { anchor: pos(s.line, s.col + open.len() + 1), head: pos(e.line, e.col + shift) })
            }
        };
        self.apply(edits, before, Some(after), false);
        self.sel = after;
        self.buf.seal();
        self.reveal();
    }
    /// False inside strings, comments and regexes (by the token type); lines not tokenized yet count as code.
    pub fn is_code(&self) -> impl Fn(usize, usize) -> bool + '_ {
        let hl = &self.hl;
        move |line: usize, col: usize| hl.line(line).is_none_or(|t| t.is_empty() || token_type_of(t[token_index(t, col)].1) == 0)
    }
    /// Go to Bracket (VS Code's jumpToBracket): from the bracket touching the cursor (the one after it first) to its
    /// partner, else to the closer of the pair around the cursor, else to the next bracket.
    fn jump_to_bracket(&mut self) {
        let p = self.range().0;
        let to = {
            let (lines, code) = (&self.buf.lines, self.is_code());
            match decorations::match_bracket(lines, p, &code, 20000, true) {
                Some((at, other)) => Some(if other.line == p.line && (p.col == other.col || p.col == other.col + 1) { at } else { other }),
                None => decorations::enclosing_brackets(lines, p, &code, 20000).map(|(_, close)| close).or_else(|| decorations::next_bracket(lines, p, &code, 20000)),
            }
        };
        if let Some(to) = to {
            self.move_to(to, false);
        }
    }
    /// Select to Bracket: the pair at the cursor (else around it, else the next one) with its brackets, backwards from
    /// the closer.
    fn select_to_bracket(&mut self) {
        let p = self.range().0;
        let pair = {
            let (lines, code) = (&self.buf.lines, self.is_code());
            decorations::match_bracket(lines, p, &code, 20000, true)
                .or_else(|| decorations::enclosing_brackets(lines, p, &code, 20000))
                .or_else(|| decorations::next_bracket(lines, p, &code, 20000).and_then(|n| decorations::match_bracket(lines, n, &code, 20000, true)))
        };
        let Some((x, y)) = pair else { return };
        let (open, close) = if x < y { (x, y) } else { (y, x) };
        let to = pos(close.line, close.col + 1);
        let back = close.line == p.line && (p.col == close.col || p.col == to.col);
        self.sel = if back { Sel { anchor: to, head: open } } else { Sel { anchor: open, head: to } };
        self.buf.seal();
        self.reveal();
    }

    // ----- find / replace -----
    pub fn matches(&mut self) -> &[Hit] {
        let key = (self.buf.version, self.find.opts, self.find.query.clone());
        if self.find.searched.as_ref() != Some(&key) {
            let (m, e) = find::find_matches(&self.buf.lines, &self.find.query, self.find.opts, find::LIMIT);
            (self.find.matches, self.find.error) = (m, e);
            self.find.searched = Some(key);
        }
        &self.find.matches
    }
    fn toggle_find(&mut self, o: FindOption) {
        let opts = &mut self.find.opts;
        match o {
            FindOption::Case => opts.case = !opts.case,
            FindOption::Word => opts.word = !opts.word,
            FindOption::Regex => opts.regex = !opts.regex,
        }
        if let Some(p) = &self.prompt {
            if !self.find.query.is_empty() {
                let from = p.origin.range().0;
                self.find_next(1, Some(from));
            }
        }
    }
    pub fn current_match(&mut self) -> Option<usize> {
        let (s, e) = self.range();
        self.matches().iter().position(|m| m.0 == s.line && m.1 == s.col && e.line == s.line && e.col == m.1 + m.2)
    }
    pub fn find_next(&mut self, dir: i32, from: Option<Pos>) {
        let from = from.unwrap_or(if dir > 0 { self.range().1 } else { self.range().0 });
        let ms = self.matches();
        if ms.is_empty() {
            return;
        }
        let i = if dir > 0 { ms.iter().position(|m| pos(m.0, m.1) >= from).unwrap_or(0) } else { ms.iter().rposition(|m| pos(m.0, m.1 + m.2) <= from).unwrap_or(ms.len() - 1) };
        let m = ms[i];
        self.sel = Sel { anchor: pos(m.0, m.1), head: pos(m.0, m.1 + m.2) };
        self.buf.seal();
        self.reveal();
    }
    fn replacement(&self, m: Hit) -> String {
        find::replacement_of(&self.buf.lines[m.0], m, &self.find.query, self.find.opts, &self.find.replace)
    }
    fn replace_one(&mut self) {
        let Some(i) = self.current_match() else { return self.find_next(1, None) };
        let s = self.range().0;
        let text = self.replacement(self.find.matches[i]);
        self.insert(&text, false);
        self.find_next(1, Some(end_of(s, &text)));
    }
    fn replace_all(&mut self) {
        let ms = self.matches().to_vec();
        if ms.is_empty() {
            return;
        }
        let edits = ms.iter().rev().map(|m| edit(pos(m.0, m.1), pos(m.0, m.1 + m.2), self.replacement(*m))).collect();
        let before = self.sel;
        self.buf.edit(edits, Some(before), None, false);
        self.sync();
        let h = self.buf.clamp(self.head());
        self.move_to(h, false);
        self.say(format!("Replaced {} occurrence{}", ms.len(), if ms.len() == 1 { "" } else { "s" }), None, 3000);
    }
    fn open_find(&mut self, replace: bool) {
        let (s, e) = self.range();
        if !self.empty() && s.line == e.line {
            self.find.query = self.buf.text(s, e);
        }
        self.find.field = if replace && !self.find.query.is_empty() { Field::Replace } else { Field::Query };
        self.prompt = Some(Prompt { replace, origin: self.sel });
    }
    /// The search a selection seeds (VS Code's getSelectionSearchString): a one-line selection, else the word at the
    /// cursor.
    fn selection_search(&self) -> Option<String> {
        let (s, e) = self.range();
        if self.empty() {
            self.word_at(self.head()).map(|w| w.0)
        } else {
            (s.line == e.line).then(|| self.buf.text(s, e))
        }
    }
    /// Find With Selection (⌘E): the find widget with the selection (or the word at the cursor) as the search.
    fn find_with_selection(&mut self) {
        if let Some(q) = self.selection_search() {
            self.find.query = q;
        }
        self.open_find(false);
    }
    /// Find Next / Previous Selection (⌘F3 / ⇧⌘F3): the selection (or the word at the cursor) becomes the search, then
    /// the next / previous match is selected; the find widget is not opened.
    fn find_selection(&mut self, dir: i32) {
        if let Some(q) = self.selection_search() {
            self.find.query = q;
        }
        if !self.find.query.is_empty() {
            self.find_next(dir, None);
        }
    }
    fn find_again(&mut self, dir: i32) {
        let (s, e) = self.range();
        if self.find.query.is_empty() && !self.empty() && s.line == e.line {
            self.find.query = self.buf.text(s, e);
        }
        if self.find.query.is_empty() {
            return self.open_find(false);
        }
        self.find_next(dir, None);
    }
    fn set_field(&mut self, v: String) {
        let replace = self.find.field == Field::Replace;
        if replace {
            self.find.replace = v;
        } else {
            self.find.query = v;
            let from = self.prompt.as_ref().map(|p| p.origin.range().0);
            self.find_next(1, from);
        }
    }
    fn prompt_key(&mut self, ev: &Ev) {
        let field = match self.find.field {
            Field::Query => self.find.query.clone(),
            Field::Replace => self.find.replace.clone(),
        };
        let k = match ev {
            Ev::Text(t) | Ev::Paste(t) => return self.set_field(field + t.split(['\r', '\n']).next().unwrap_or("")),
            Ev::Key(k) => k,
            _ => return,
        };
        let chord = k.chord();
        if k.name == "escape" {
            self.prompt = None;
            return;
        }
        let act = self.keys.keymap.command(&chord).map(|c| c.act);
        if let Some(a @ (Act::ToggleFind(_) | Act::ReplaceOne | Act::ReplaceAll)) = act {
            return self.run_act(a, None);
        }
        let replace = self.prompt.as_ref().is_some_and(|p| p.replace);
        match k.name.as_str() {
            "backspace" => {
                let mut f = field;
                f.pop();
                return self.set_field(f);
            }
            "tab" if replace => {
                self.find.field = if self.find.field == Field::Query { Field::Replace } else { Field::Query };
                return;
            }
            _ => {}
        }
        if let Some(Act::OpenFind(replace)) = act {
            self.prompt.as_mut().unwrap().replace = replace;
            self.find.field = if replace { Field::Replace } else { Field::Query };
            return;
        }
        let dir = if k.shift { -1 } else { 1 };
        match k.name.as_str() {
            "enter" if (k.alt || k.cmd) && replace => self.replace_all(),
            "enter" if self.find.field == Field::Replace => self.replace_one(),
            _ if matches!(act, Some(Act::FindAgain(_))) => self.find_next(if act == Some(Act::FindAgain(1)) { 1 } else { -1 }, None),
            "enter" | "down" => self.find_next(dir, None),
            "up" => self.find_next(-1, None),
            _ => {}
        }
    }
    pub fn find_act(&mut self, a: FindAct) {
        match a {
            FindAct::ToggleReplace => {
                if let Some(p) = self.prompt.as_mut() {
                    p.replace = !p.replace;
                    self.find.field = if p.replace { Field::Replace } else { Field::Query };
                }
            }
            FindAct::Field(f) => self.find.field = f,
            FindAct::Toggle(o) => self.toggle_find(o),
            FindAct::Prev => self.find_next(-1, None),
            FindAct::Next => self.find_next(1, None),
            FindAct::Close => self.prompt = None,
            FindAct::ReplaceOne => self.replace_one(),
            FindAct::ReplaceAll => self.replace_all(),
        }
    }

    // ----- folding -----
    pub fn fold_ranges(&mut self) -> Vec<Range> {
        let key = (self.buf.version, self.tab());
        if self.ranges.as_ref().is_none_or(|r| (r.0, r.1) != key) {
            let list = folding::fold_ranges(&self.buf.lines, self.tab(), folding::off_side(self.scope.as_deref()));
            if self.folds.sync(&list) {
                let l = self.head().line;
                self.folds.reveal(l);
            }
            self.ranges = Some((key.0, key.1, list));
        }
        self.ranges.as_ref().unwrap().2.clone()
    }
    fn collapse(&mut self, ranges: &[Range]) -> bool {
        if !self.folds.collapse(ranges) {
            return false;
        }
        let h = self.head();
        if self.folds.is_hidden(h.line) {
            let l = self.folds.visible(h.line);
            self.move_to(pos(l, h.col), false);
        }
        true
    }
    fn fold(&mut self) {
        let ranges = self.fold_ranges();
        let line = self.head().line;
        let folds = &self.folds;
        if let Some(r) = folding::innermost(&ranges, line, |r| !folds.has(r.start)) {
            self.collapse(&[r]);
        }
    }
    /// A click on line's chevron: expands a collapsed fold, collapses the range it heads.
    pub fn click_fold(&mut self, line: usize) -> bool {
        if self.folds.expand(line) {
            return true;
        }
        let ranges = self.fold_ranges();
        folding::range_at(&ranges, line).is_some_and(|r| self.collapse(&[r]))
    }
    fn goto_change(&mut self, dir: i32) {
        if let Some(h) = gitgutter::next_change(&self.git.hunks, self.head().line, dir) {
            let l = gitgutter::line_of(&h).min(self.buf.lines.len() - 1);
            self.move_to(pos(l, 0), false);
        }
    }

    // ----- other files and navigation -----
    /// Takes what the other open files' tokenizers sent; true when anything arrived.
    pub fn poll_docs(&mut self) -> bool {
        let mut any = false;
        for d in &mut self.docs {
            any |= d.hl.poll(&d.buf.lines);
        }
        any
    }
    /// Shows the open file docs[i]; the file shown until now takes its place in `docs`.
    fn activate(&mut self, i: usize) {
        let mut st = self.docs.remove(i);
        self.swap_doc(&mut st);
        self.docs.push(st);
        // caches keyed by the buffer's version belong to the file shown before
        (self.find.searched, self.hits_cache, self.word) = (None, None, None);
    }
    /// A file's state with its own tokenizer, or None (and a message) when it can't be opened as text.
    fn load_state(&mut self, file: &Path) -> Option<DocState> {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let why = match file::load(file, false) {
            Ok(Ok(doc)) => {
                let hl = Highlight::start(self.vscode.clone(), term::wake);
                let mut st = DocState::new(file.to_path_buf(), doc, hl, &self.index, &self.settings);
                st.hl.reset(st.scope.as_deref(), &st.buf.lines);
                return Some(st);
            }
            Ok(Err(r)) => r.message(),
            Err(e) => format!("Cannot open {name}: {e}"),
        };
        self.error(why, 6000);
        None
    }
    /// Shows `file` (loading it once), optionally at `at`; `record` remembers where we were for Go Back.
    fn open(&mut self, file: &Path, at: Option<Pos>, record: bool) -> bool {
        let file = crate::normalize(file);
        if record {
            self.push_nav();
        }
        if file != self.file {
            let i = match self.docs.iter().position(|d| d.file == file) {
                Some(i) => i,
                None => match self.load_state(&file) {
                    Some(st) => {
                        self.docs.push(st);
                        self.docs.len() - 1
                    }
                    None => {
                        if record {
                            self.back.pop();
                        }
                        return false;
                    }
                },
            };
            let first = self.docs[i].seen_version == 0;
            self.activate(i);
            if first {
                self.offer_backup();
            }
        }
        if let Some(p) = at {
            self.move_to(p, false);
            let v = self.row_of(self.head().line).saturating_sub(self.height() / 3);
            self.top = self.line_at_row(v);
        }
        true
    }
    fn push_nav(&mut self) {
        self.back.push((self.file.clone(), self.head(), self.top));
        if self.back.len() > 50 {
            self.back.remove(0);
        }
        self.forward.clear();
    }
    /// Go Back (-1) / Go Forward (1): the file and position before the last jump to another file.
    fn navigate(&mut self, dir: i32) {
        let Some((file, p, top)) = (if dir < 0 { self.back.pop() } else { self.forward.pop() }) else { return };
        let here = (self.file.clone(), self.head(), self.top);
        if dir < 0 { self.forward.push(here) } else { self.back.push(here) }
        if self.open(&file, None, false) {
            self.move_to(p, false);
            self.top = top.min(self.buf.lines.len() - 1);
        }
    }
    /// The folder Go to File lists: the git root, else the file's folder.
    fn root(&self) -> PathBuf {
        term::git_root(&self.file).or_else(|| self.file.parent().map(Path::to_path_buf)).unwrap_or_default()
    }
    /// Files of the git root (git ls-files), else up to 20,000 files found under the file's folder.
    fn project_files(&mut self) -> Vec<String> {
        let root = self.root();
        if let Some((r, list)) = &self.project {
            if *r == root {
                return list.clone();
            }
        }
        let git = root.join(".git").exists().then(|| std::process::Command::new("git").args(["ls-files", "-co", "--exclude-standard"]).current_dir(&root).stderr(std::process::Stdio::null()).output().ok()).flatten();
        let list = match git.filter(|o| o.status.success()) {
            Some(o) => String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.is_empty()).map(str::to_string).collect(),
            None => {
                let mut list = vec![];
                walk(&root, "", 0, &mut list);
                list
            }
        };
        self.project = Some((root, list.clone()));
        list
    }
    fn open_settings_json(&mut self) {
        let path = settings::settings_file();
        settings::load(&path); // creates it with the defaults
        self.open(&path, None, true);
    }
    fn open_keybindings_json(&mut self) {
        let path = crate::commands::keybindings_file();
        if !path.exists() {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = file::save(&path, "[]\n");
        }
        self.open(&path, None, true);
    }

    // ----- files -----
    /// Saves (trim, final newline from the settings); asks first when the file changed on disk. True when written.
    pub fn save(&mut self, force: bool, auto: bool, then_quit: bool) -> bool {
        if !force && file::changed_on_disk(&self.file, self.doc.stamp).is_some() && self.doc.stamp.is_some() {
            if auto {
                return false;
            }
            let name = self.name();
            self.dialog(
                "The file has been changed on disk.",
                Some(&format!("Overwrite {name} with your version, or reload it?")),
                vec![button("Overwrite", 'o', DAct::Overwrite { then_quit }), button("Reload", 'r', DAct::Reload), cancel_button()],
            );
            return false;
        }
        if self.settings.format_on_save && self.can("format") {
            self.format_then_save(auto, then_quit);
            return false;
        }
        self.write(auto)
    }
    /// Writes the file (trim, final newline from the settings): Save without the checks.
    fn write(&mut self, auto: bool) -> bool {
        if self.settings.trim_trailing_whitespace {
            self.trim_trailing();
        }
        if self.settings.insert_final_newline && self.buf.lines.iter().any(|l| !l.is_empty()) {
            self.doc.final_newline = true;
        }
        match file::save(&self.file, &file::encode(&self.buf.lines, &self.doc)) {
            Ok(stamp) => {
                self.doc.stamp = Some(stamp);
                self.buf.mark_saved();
                self.buf.seal();
                backup::remove(&self.file);
                self.git.saved();
                if let Some(s) = &self.lang.session {
                    s.saved(&self.file);
                }
                if !auto {
                    let ok = self.c.ok.clone();
                    self.say("Saved", Some(&ok), 3000);
                }
                true
            }
            Err(e) => {
                self.error(format!("Failed to save: {e}"), 8000);
                false
            }
        }
    }
    fn trim_trailing(&mut self) {
        let edits = self.buf.lines.iter().enumerate().filter_map(|(l, t)| {
            let n = t.trim_end().len();
            (n < t.len()).then(|| (l, n, t.len() - n, String::new()))
        });
        let edits: Vec<_> = edits.collect();
        self.line_edits(edits);
    }
    fn reload(&mut self) {
        match file::load(&self.file, false) {
            Ok(Ok(doc)) => {
                self.replace_all_text(&doc.lines.join("\n"), None);
                (self.doc.crlf, self.doc.final_newline, self.doc.bom, self.doc.stamp) = (doc.crlf, doc.final_newline, doc.bom, doc.stamp);
                self.buf.mark_saved();
                self.say("Reloaded from disk", None, 3000);
            }
            Ok(Err(r)) => self.error(r.message(), 8000),
            Err(e) => self.error(format!("Failed to reload: {e}"), 8000),
        }
    }
    /// The whole text replaced as one undo step, the cursor at `at` (else where it was).
    fn replace_all_text(&mut self, text: &str, at: Option<Pos>) {
        let last = self.buf.lines.len() - 1;
        let before = self.sel;
        let end = pos(last, self.buf.lines[last].len());
        self.buf.edit(vec![edit(pos(0, 0), end, text)], Some(before), None, false);
        self.sync();
        let p = self.buf.clamp(at.unwrap_or(self.head()));
        self.move_to(p, false);
    }
    fn name(&self) -> String {
        self.file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }
    pub fn dialog(&mut self, title: &str, detail: Option<&str>, buttons: Vec<crate::overlays::Button<DAct>>) {
        self.popup = Some(Popup::Dialog(Dialog::new(title, detail, buttons)));
    }
    /// Asks about each unsaved file (showing it), then exits.
    fn quit(&mut self) {
        if !self.buf.dirty() {
            let Some(i) = self.docs.iter().position(|d| d.buf.dirty()) else {
                self.exit = Some(0);
                return;
            };
            self.activate(i);
        }
        let name = self.name();
        self.dialog(
            &format!("Do you want to save the changes you made to {name}?"),
            Some("Your changes will be lost if you don't save them."),
            vec![button("Save", 's', DAct::QuitSave), button("Don't Save", 'd', DAct::QuitDiscard), cancel_button()],
        );
    }
    /// Hot exit: unsaved files go to backups (runs right before the process ends).
    pub fn hot_exit(&self) {
        let current = (&self.file, &self.buf, self.head());
        for (file, buf, h) in std::iter::once(current).chain(self.docs.iter().map(|d| (&d.file, &d.buf, d.sel.head))) {
            if buf.dirty() {
                let col = utf16_len(&buf.lines[h.line][..h.col]);
                let _ = backup::write(file, &buf.all_text(), (h.line, col));
            }
        }
    }
    /// Writes another open file as it is (Save All, auto save).
    fn write_state(&mut self, i: usize) -> bool {
        let st = &mut self.docs[i];
        match file::save(&st.file, &file::encode(&st.buf.lines, &st.doc)) {
            Ok(stamp) => {
                st.doc.stamp = Some(stamp);
                st.buf.mark_saved();
                backup::remove(&st.file);
                st.git.saved();
                true
            }
            Err(e) => {
                let name = st.file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.error(format!("Failed to save {name}: {e}"), 8000);
                false
            }
        }
    }
    /// File: Save All: the current file as Save does, every other unsaved open file as it is; one changed on disk is
    /// left unsaved.
    fn save_all(&mut self) {
        let mut skipped = vec![];
        for i in 0..self.docs.len() {
            let st = &self.docs[i];
            if !st.buf.dirty() {
                continue;
            }
            if st.doc.stamp.is_some() && file::changed_on_disk(&st.file, st.doc.stamp).is_some() {
                skipped.push(st.file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            } else {
                self.write_state(i);
            }
        }
        if self.buf.dirty() {
            self.save(false, false, false);
        }
        if !skipped.is_empty() {
            let w = self.c.warn.clone();
            self.say(format!("Not saved, changed on disk: {}", skipped.join(", ")), Some(&w), 8000);
        }
    }
    /// File: Save As...: asks for a path (relative to the file's folder, which is prefilled).
    fn ask_save_as(&mut self) {
        let dir = self.file.parent().map(|d| format!("{}/", d.display())).unwrap_or_default();
        let mut input = Input::new("Save As:", &dir, IAct::SaveAs);
        input.select_all = false; // typing goes after the folder
        self.popup = Some(Popup::Input(input));
    }
    /// Confirms replacing a file, then saves the text there and edits that file; the original stays as it is on disk.
    fn save_as(&mut self, text: &str) {
        let v = text.trim();
        let v = match v.strip_prefix('~').filter(|r| r.is_empty() || r.starts_with('/')) {
            Some(rest) => format!("{}{rest}", settings::home_dir().display()),
            None => v.to_string(),
        };
        if v.is_empty() {
            return;
        }
        let target = crate::normalize(&self.file.parent().unwrap_or(Path::new("/")).join(v));
        if target == self.file {
            self.save(false, false, false);
            return;
        }
        let folder = target.parent().map(Path::to_path_buf).unwrap_or_default();
        match std::fs::metadata(&target) {
            Ok(m) if m.is_dir() => self.say(format!("{} is a folder", target.display()), Some(&self.c.warn.clone()), 6000),
            _ if !folder.exists() => self.say(format!("Folder not found: {}", folder.display()), Some(&self.c.warn.clone()), 6000),
            Err(_) => self.save_to(target),
            Ok(_) => {
                let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.dialog(
                    &format!("'{name}' already exists. Do you want to replace it?"),
                    Some("Replacing it will overwrite its contents."),
                    vec![button("Replace", 'r', DAct::Replace(target)), cancel_button()],
                );
            }
        }
    }
    /// The current text becomes `target`'s document (its language from its name) and is saved; the original file's
    /// unsaved changes go with it (VS Code reverts the original).
    fn save_to(&mut self, target: PathBuf) {
        let doc = Doc { lines: self.buf.lines.clone(), stamp: None, ..self.doc.clone() };
        let hl = Highlight::start(self.vscode.clone(), term::wake);
        let mut st = DocState::new(target.clone(), doc, hl, &self.index, &self.settings);
        st.hl.reset(st.scope.as_deref(), &st.buf.lines);
        (st.sel, st.top, st.left, st.indent, st.seen_version) = (self.sel, self.top, self.left, self.indent, st.buf.version);
        st.buf.saved_version = None; // unsaved until written
        let old = self.file.clone();
        self.docs.retain(|d| d.file != target);
        self.docs.push(st);
        self.activate(self.docs.len() - 1);
        self.docs.retain(|d| d.file != old);
        backup::remove(&old);
        self.save(true, false, false);
    }
    /// Offers a hot-exit backup of the file back.
    pub fn offer_backup(&mut self) {
        let Some(b) = backup::read(&self.file) else { return };
        if b.text == self.buf.all_text() {
            return backup::remove(&self.file);
        }
        let detail = if backup::changed_since(&b, &self.file) {
            "Warning: the file has changed on disk since then.".to_string()
        } else {
            format!("Unsaved changes to {} were kept when the editor closed.", self.name())
        };
        self.dialog(
            &format!("Restore unsaved changes from {}?", backup::stamp_text(b.time)),
            Some(&detail),
            vec![button("Restore", 'r', DAct::Restore), button("Discard", 'd', DAct::Discard)],
        );
    }
    fn dialog_act(&mut self, a: DAct) {
        match a {
            DAct::QuitSave => {
                if self.save(false, false, true) {
                    self.quit();
                }
            }
            DAct::QuitDiscard => {
                backup::remove(&self.file);
                self.buf.mark_saved();
                self.quit();
            }
            DAct::Cancel => {}
            DAct::Overwrite { then_quit } => {
                if self.save(true, false, false) && then_quit {
                    self.quit();
                }
            }
            DAct::Replace(target) => self.save_to(target),
            DAct::Reload => self.reload(),
            DAct::Restore => {
                if let Some(b) = backup::read(&self.file) {
                    self.replace_all_text(&b.text, None);
                    if let Some((l, c16)) = b.cursor {
                        let l = l.min(self.buf.lines.len() - 1);
                        let col = utf16_to_byte(&self.buf.lines[l], c16);
                        self.move_to(pos(l, col), false);
                    }
                    self.say("Restored unsaved changes", None, 3000);
                }
            }
            DAct::Discard => backup::remove(&self.file),
        }
    }

    // ----- prompts and pickers -----
    fn open_goto(&mut self) {
        let label = format!("Go to line (1-{}), :col optional:", self.buf.lines.len());
        self.popup = Some(Popup::Input(Input::new(&label, "", IAct::Goto)));
    }
    pub fn goto_text(&mut self, text: &str) {
        let mut parts = text.split([':', ',']).map(|s| s.trim().parse::<f64>().ok());
        let Some(Some(ln)) = parts.next() else { return };
        if ln < 1.0 {
            return;
        }
        let line = (ln as usize).min(self.buf.lines.len()) - 1;
        let col = parts.next().flatten().filter(|c| *c >= 1.0).map_or(0, |c| c as usize - 1);
        let col = utf16_to_byte(&self.buf.lines[line], col);
        self.move_to(pos(line, col), false);
        let v = self.row_of(line).saturating_sub(self.height() / 2);
        self.top = self.line_at_row(v);
    }
    fn input_act(&mut self, a: IAct, text: String) {
        match a {
            IAct::Goto => self.goto_text(&text),
            IAct::Rename(old) => self.rename_to(&old, text),
            IAct::ChangeAll => self.change_all_done(true),
            IAct::AutoSaveDelay => match text.trim().parse::<f64>() {
                Ok(n) if n.is_finite() => self.write_setting("files.autoSaveDelay", settings::js_number(n.clamp(0.1, 3600.0))),
                _ => self.warn(format!("Not a number of seconds: {text}")),
            },
            IAct::SaveAs => self.save_as(&text),
        }
    }
    fn choose(&mut self, placeholder: &str, choices: Vec<(String, String, PAct)>, current: usize) {
        self.popup = Some(Popup::Picker(Picker::new(placeholder, choices, current)));
    }
    pub fn pick_indent(&mut self) {
        self.choose("Select Action", vec![("Indent Using Spaces".into(), String::new(), PAct::IndentMenu(false)), ("Indent Using Tabs".into(), String::new(), PAct::IndentMenu(true))], 0);
    }
    fn pick_tab_size(&mut self, use_tabs: bool) {
        let tab = self.tab();
        let sizes = (1..=8).map(|s| (s.to_string(), if s == tab { "Configured Tab Size".to_string() } else { String::new() }, PAct::TabSize(use_tabs, s))).collect();
        self.choose("Select Tab Size for the Current File", sizes, tab - 1);
    }
    pub fn pick_eol(&mut self) {
        self.choose("Select End of Line Sequence", vec![("LF".into(), String::new(), PAct::Eol(false)), ("CRLF".into(), String::new(), PAct::Eol(true))], self.doc.crlf as usize);
    }
    /// Plain Text and every language a grammar ships for.
    pub fn pick_language(&mut self) {
        let ix = &self.index;
        let mut roots: Vec<String> = vec![];
        for table in ["ext", "files", "prefixes"] {
            for s in ix[table].as_object().into_iter().flat_map(|o| o.values()).filter_map(Value::as_str) {
                if ix["scopes"].get(s).is_some() && !roots.iter().any(|r| r == s) {
                    roots.push(s.to_string());
                }
            }
        }
        let mut langs: Vec<(String, Option<String>)> = roots.into_iter().map(|s| (language_name(Some(&s)), Some(s))).collect();
        langs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
        langs.insert(0, ("Plain Text".into(), None));
        let current = if self.hl.has_grammar { self.scope.clone() } else { None };
        let at = langs.iter().position(|l| l.1 == current).unwrap_or(0);
        let choices = langs.into_iter().map(|(label, s)| (label, s.as_ref().map_or(String::new(), |s| format!("({s})")), PAct::Language(s))).collect();
        self.choose("Select Language Mode", choices, at);
    }
    fn pick_act(&mut self, a: PAct, term: Option<&mut Term>) {
        match a {
            PAct::IndentMenu(tabs) => self.pick_tab_size(tabs),
            PAct::TabSize(use_tabs, size) => {
                self.indent = Indent { use_tabs, size };
                self.reveal();
            }
            PAct::Eol(crlf) => {
                if self.doc.crlf != crlf {
                    self.doc.crlf = crlf;
                    self.buf.saved_version = None;
                }
            }
            PAct::Language(scope) => {
                self.scope = scope;
                self.lang = LangDoc::default();
                self.hl.reset(self.scope.as_deref(), &self.buf.lines);
                self.language = language_name(self.scope.as_deref());
            }
            PAct::Open(rel) => {
                let file = self.root().join(rel);
                self.open(&file, None, true);
            }
            PAct::GotoLine(text) => self.goto_text(&text),
            PAct::Command(id) => {
                if let Some(c) = crate::commands::by_id(id) {
                    self.run_command(c, term);
                }
            }
            PAct::Jump(file, line, col) => self.jump_to(&crate::lang::Loc::at(file, crate::lang::edits::p16(line, col), None)),
            PAct::Action(i) => self.apply_action(i),
            PAct::Nothing => {}
        }
    }

    // ----- settings, auto save -----
    fn write_setting(&mut self, key: &str, value: Value) {
        match settings::update(&settings::settings_file(), key, value) {
            Ok((v, st)) => {
                (self.settings, self.settings_stamp) = (v, st);
                let label = settings::auto_save_label(&self.settings);
                self.say(label, None, 3000);
            }
            Err(e) => self.error(format!("Cannot write settings: {e}"), 6000),
        }
    }
    /// Re-reads settings and keybindings when their files changed (every 2 s); true when anything changed.
    pub fn poll_files(&mut self) -> bool {
        let rebound = self.keys.poll();
        if rebound {
            if let Some(e) = self.keys.error.clone() {
                let w = self.c.warn.clone();
                self.say(e, Some(&w), 6000);
            }
        }
        let path = settings::settings_file();
        let st = file::disk_stamp(&path);
        let changed = st.is_some() && st != self.settings_stamp;
        if changed {
            (self.settings, self.settings_stamp) = settings::load(&path);
        }
        rebound || changed
    }
    fn open_settings_ui(&mut self, keybindings: bool) {
        if std::env::var_os("HC_TERMINAL_ID").is_some() && term::which("herdr-app").is_some() {
            let page = if keybindings { "keybindings" } else { "settings" };
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            let dir = settings::settings_file().parent().map(Path::to_path_buf).unwrap_or_default();
            let _ = std::fs::write(dir.join(".vscode-settings-page"), json!({ "page": page, "at": at }).to_string());
            term::herdr(&["do", "mod.open", "--name", "vscode-settings"], false);
        } else if keybindings {
            self.open_keybindings_json();
        } else {
            self.open_settings_json();
        }
    }
    /// After each input event: restart the auto-save timer when the text changed.
    pub fn after_event(&mut self) {
        self.note_cursor();
        if self.buf.version == self.seen_version {
            return;
        }
        self.seen_version = self.buf.version;
        if self.settings.auto_save == AutoSave::AfterDelay && self.buf.dirty() {
            self.auto_at = Some(Instant::now() + Duration::from_secs_f64(self.settings.auto_save_delay));
        }
    }
    fn auto_save(&mut self) {
        self.auto_at = None;
        if self.exit.is_some() || self.popup.is_some() {
            return;
        }
        for i in 0..self.docs.len() {
            if self.docs[i].buf.dirty() {
                self.write_state(i);
            }
        }
        if self.buf.dirty() {
            self.save(false, true, false);
        }
    }

    /// The earliest time something is due (a message to clear, the word highlight, auto save, the drag, git).
    pub fn deadline(&self) -> Option<Instant> {
        let word = self.word.as_ref().map(|w| w.1 + WORD_DELAY).filter(|t| *t > Instant::now());
        [self.message.as_ref().map(|m| m.until), word, self.auto_at, self.drag_next, self.git.deadline(), self.lang_deadline()].into_iter().flatten().min()
    }
    /// Runs what is due; true when the screen should be drawn again.
    pub fn tick(&mut self) -> bool {
        let now = Instant::now();
        let mut redraw = self.message.as_ref().is_some_and(|m| m.until <= now) | self.lang_tick();
        if self.auto_at.is_some_and(|t| t <= now) {
            self.auto_save();
            redraw = true;
        }
        if self.drag_next.is_some_and(|t| t <= now) {
            self.drag_next = if self.dragging && self.drag_step() { Some(now + Duration::from_millis(40)) } else { None };
            redraw = true;
        }
        if self.git.tick(&self.buf.lines) {
            redraw = true;
        }
        if self.word.as_ref().is_some_and(|w| w.1 + WORD_DELAY <= now && w.1 + WORD_DELAY > now - Duration::from_millis(200)) {
            redraw = true;
        }
        redraw
    }

    // ----- input -----
    pub fn handle(&mut self, ev: &Ev, term: &mut Term) {
        match ev {
            Ev::Focus(focused) => {
                if !focused && self.settings.auto_save == AutoSave::OnFocusChange {
                    self.auto_save();
                }
                return;
            }
            Ev::Mouse(m) => return self.mouse(m, term),
            _ => {}
        }
        if self.chord_prefix.is_some() {
            return self.chord_key(ev, term);
        }
        if self.close_hover_on_key(ev) {
            return; // any key closes the hover; Esc only that
        }
        if self.popup.is_some() {
            return self.popup_event(ev, Some(term));
        }
        if self.prompt.is_some() {
            return self.prompt_key(ev);
        }
        if let (Some(pk), Ev::Key(k)) = (self.ls.peek.as_mut(), ev) {
            match pk.key(k) {
                crate::overlays::PeekOutcome::No => {}
                crate::overlays::PeekOutcome::Stay => return,
                crate::overlays::PeekOutcome::Close => return self.ls.peek = None,
                crate::overlays::PeekOutcome::Open(l) => {
                    self.ls.peek = None;
                    return self.jump_to(&l);
                }
            }
        }
        if let (Some(pn), Ev::Key(k)) = (self.ls.panel.as_mut().filter(|p| p.focused), ev) {
            match pn.key(k, self.rows) {
                crate::overlays::PanelOutcome::No => {}
                crate::overlays::PanelOutcome::Stay => return,
                crate::overlays::PanelOutcome::Close => return self.ls.panel = None,
                crate::overlays::PanelOutcome::Open(l) => return self.jump_to(&l),
                crate::overlays::PanelOutcome::Toggle => return self.panel_toggle(),
            }
        }
        let k = match ev {
            Ev::Text(t) => return self.typed(t),
            Ev::Paste(t) => return self.paste(Some(t.clone())),
            Ev::Key(k) => k.clone(),
            _ => return,
        };
        let chord = k.chord();
        if self.keys.keymap.prefixes.contains(&chord) {
            // the first key of a two-step chord (VS Code's ⌘K …)
            let text = format!("({}) was pressed. Waiting for second key of chord...", self.keys.keymap.key_label(&chord));
            self.chord_prefix = Some(chord);
            return self.say(text, None, 60000);
        }
        if let Some(c) = self.keys.keymap.command(&chord) {
            return self.run_command(c, Some(term));
        }
        self.key(&k);
    }

    pub fn popup_event(&mut self, ev: &Ev, term: Option<&mut Term>) {
        let area = crate::overlays::Area { c: &self.c, rows: self.rows, cols: self.cols };
        match self.popup.as_mut().unwrap() {
            Popup::Dialog(d) => match d.event(ev) {
                Outcome::Stay => {}
                Outcome::Close => self.popup = None,
                Outcome::Run(a) => {
                    self.popup = None;
                    self.dialog_act(a);
                }
            },
            Popup::Input(i) => match i.event(ev) {
                InputOutcome::Stay => {}
                InputOutcome::Changed(text) => {
                    if matches!(i.accept, IAct::ChangeAll) {
                        self.change_all_preview(&text);
                    }
                }
                InputOutcome::Cancel => {
                    self.popup = None;
                    self.ls_cancel_input();
                }
                InputOutcome::Accept(a, text) => {
                    self.popup = None;
                    self.input_act(a, text);
                }
            },
            Popup::Picker(p) => match p.event(ev, &area) {
                Outcome::Stay => self.refresh_picker(false),
                Outcome::Close => self.popup = None,
                Outcome::Run(a) => {
                    self.popup = None;
                    self.pick_act(a, term);
                }
            },
            Popup::Menu(m) => match m.event(ev, &area) {
                Outcome::Stay => {}
                Outcome::Close => self.popup = None,
                Outcome::Run(a) => {
                    self.popup = None;
                    self.menu_act(a, term);
                }
            },
        }
    }
    /// Esc in an inline input: Change All takes its preview back.
    fn ls_cancel_input(&mut self) {
        self.change_all_done(false);
    }

    /// Keys that aren't commands: Enter, Tab and Escape are the editor's own (movement and deletion are keymap.json's).
    fn key(&mut self, k: &Key) {
        if k.cmd || k.ctrl {
            return;
        }
        match k.name.as_str() {
            "enter" if !k.alt => self.enter(),
            "tab" => self.tab_key(k.shift),
            "escape" if !self.empty() => self.move_to(self.head(), false),
            "escape" => self.ls.panel = None,
            _ => {}
        }
    }

    /// The second key of a chord: its command, else VS Code's "not a command" message. A typed character counts as its
    /// key.
    fn chord_key(&mut self, ev: &Ev, term: &mut Term) {
        let second = match ev {
            Ev::Key(k) => k.chord(),
            Ev::Text(t) => match t.chars().next() {
                Some(ch) => {
                    let lower: String = ch.to_lowercase().collect();
                    if lower != ch.to_string() { format!("shift+{lower}") } else { lower }
                }
                None => return,
            },
            _ => return,
        };
        let first = self.chord_prefix.take().unwrap_or_default();
        self.message = None;
        if let Some(c) = self.keys.keymap.command(&format!("{first} {second}")) {
            return self.run_command(c, Some(term));
        }
        let (a, b) = (self.keys.keymap.key_label(&first), self.keys.keymap.key_label(&second));
        self.warn(format!("The key combination ({a}, {b}) is not a command."));
    }

    pub fn run_act(&mut self, act: Act, term: Option<&mut Term>) {
        match act {
            Act::NotYet => self.warn(NOT_YET),
            Act::GoTo(_)
            | Act::PeekAt(_)
            | Act::FindAll(_)
            | Act::CallHierarchy
            | Act::Rename
            | Act::ChangeAll
            | Act::FormatDocument
            | Act::FormatSelection
            | Act::CodeActions(_)
            | Act::QuickFix
            | Act::ShowHover
            | Act::SmartSelect(_)
            | Act::CursorHistory(_)
            | Act::WorkspaceSymbols
            | Act::ShowCommands
            | Act::GotoSymbol
            | Act::NextProblem(_)
            | Act::ContextMenu => self.run_lang(act),
            Act::QuickOpen => self.open_picker(""),
            Act::OpenSettingsJson => self.open_settings_json(),
            Act::OpenKeybindingsJson => self.open_keybindings_json(),
            Act::Navigate(dir) => self.navigate(dir),
            Act::SaveAs => self.ask_save_as(),
            Act::SaveAll => self.save_all(),
            Act::ExpandLineSelection => self.expand_line_selection(),
            Act::BlockComment => self.block_comment(),
            Act::FindWithSelection => self.find_with_selection(),
            Act::FindSelection(dir) => self.find_selection(dir),
            Act::JumpToBracket => self.jump_to_bracket(),
            Act::SelectToBracket => self.select_to_bracket(),
            Act::JoinLines => self.join_lines(),
            Act::Copy(cut) => {
                if let Some(t) = term {
                    self.copy(t, cut)
                }
            }
            Act::Paste => self.paste(None),
            Act::Save => {
                self.save(false, false, false);
            }
            Act::ToggleAutoSave => {
                let v = if self.settings.auto_save == AutoSave::Off { "afterDelay" } else { "off" };
                self.write_setting("files.autoSave", json!(v));
            }
            Act::AskAutoSaveDelay => {
                let text = format!("{}", settings::js_number(self.settings.auto_save_delay));
                self.popup = Some(Popup::Input(Input::new("Auto save delay in seconds (0.1-3600):", &text, IAct::AutoSaveDelay)));
            }
            Act::OpenSettingsUi(kb) => self.open_settings_ui(kb),
            Act::Quit => self.quit(),
            Act::Undo => self.undo(false),
            Act::Redo => self.undo(true),
            Act::SelectAll => self.select_all(),
            Act::Comment(mode) => self.toggle_comment(mode),
            Act::TrimTrailing => self.trim_trailing(),
            Act::Horizontal(dir, extend, word) => self.horizontal(dir, extend, word),
            Act::Vertical(rows, extend) => self.vertical(rows as i64, extend),
            Act::Home(extend) => self.home(extend),
            Act::LineEdge(true, extend) => self.line_end(extend),
            Act::LineEdge(false, extend) => {
                let l = self.head().line;
                self.move_to(pos(l, 0), extend);
            }
            Act::DocEdge(true, extend) => self.doc_end(extend),
            Act::DocEdge(false, extend) => self.move_to(pos(0, 0), extend),
            Act::Page(dir, extend) => {
                let d = dir as i64 * self.height() as i64;
                let max = self.view_count().saturating_sub(self.height());
                self.top = self.scrolled(d, Some(max));
                self.vertical(d, extend);
            }
            Act::ScrollLine(dir) => self.top = self.scrolled(dir as i64, None),
            Act::Backspace(word) => self.backspace(word),
            Act::DeleteForward(word) => self.delete_forward(word),
            Act::DeleteAll(dir) => {
                if !self.empty() {
                    let (s, e) = self.range();
                    return self.delete_range(s, e);
                }
                // to the line's start / end; at the start / end, the line break (VS Code's)
                let (h, len) = (self.head(), self.buf.lines[self.head().line].len());
                if dir < 0 {
                    let s = if h.col == 0 && h.line > 0 { pos(h.line - 1, self.buf.lines[h.line - 1].len()) } else { pos(h.line, 0) };
                    self.delete_range(s, h);
                } else {
                    let e = if h.col == len && h.line + 1 < self.buf.lines.len() { pos(h.line + 1, 0) } else { pos(h.line, len) };
                    self.delete_range(h, e);
                }
            }
            Act::SelectNextOccurrence => self.select_next_occurrence(),
            Act::OpenFind(r) => self.open_find(r),
            Act::ToggleFind(o) => self.toggle_find(o),
            Act::ReplaceOne => self.replace_one(),
            Act::ReplaceAll => self.replace_all(),
            Act::FindAgain(d) => self.find_again(d),
            Act::GotoLine => self.open_goto(),
            Act::DeleteLines => self.delete_lines(),
            Act::MoveLines(d) => self.move_lines(d as i64),
            Act::CopyLines(d) => self.copy_lines(d as i64),
            Act::InsertLine(below) => self.insert_line(below),
            Act::IndentLines(out) => self.indent_lines(out),
            Act::PickTabSize(t) => self.pick_tab_size(t),
            Act::PickEol => self.pick_eol(),
            Act::PickLanguage => self.pick_language(),
            Act::GotoChange(d) => self.goto_change(d),
            Act::Fold => self.fold(),
            Act::Unfold => {
                let l = self.head().line;
                self.folds.expand(l);
            }
            Act::ToggleFold => {
                let l = self.head().line;
                if !self.folds.expand(l) {
                    self.fold();
                }
            }
            Act::FoldAll => {
                let r = self.fold_ranges();
                self.collapse(&r);
            }
            Act::UnfoldAll => {
                self.folds.clear();
            }
        }
    }
}

/// Go to File without git: files under root/dir (8 folders deep, 20,000 at most), skipping .git and node_modules.
fn walk(root: &Path, dir: &str, depth: usize, list: &mut Vec<String>) {
    if list.len() >= 20000 || depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root.join(dir)) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let rel = if dir.is_empty() { name } else { format!("{dir}/{name}") };
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            walk(root, &rel, depth + 1, list);
        } else if list.len() < 20000 {
            list.push(rel);
        }
    }
}

fn cancel_button() -> crate::overlays::Button<DAct> {
    crate::overlays::Button { label: "Cancel".into(), key: 'c', act: DAct::Cancel, cancel: true }
}

/// Closers on `line` at or after `col` moved by `delta` bytes (an insert or delete there).
fn shift_closers(at: &[Pos], line: usize, col: usize, delta: i64) -> Vec<Pos> {
    at.iter().map(|q| if q.line == line && q.col >= col { pos(line, (q.col as i64 + delta).max(0) as usize) } else { *q }).collect()
}

/// `hay.indexOf(needle, from)`: the first match starting at or after byte `from`.
fn index_of(hay: &str, needle: &str, from: usize) -> Option<usize> {
    hay.as_bytes().get(from..)?.windows(needle.len()).position(|w| w == needle.as_bytes()).map(|i| i + from)
}

/// `hay.lastIndexOf(needle, at_most)`: the last match starting at or before byte `at_most`.
fn last_index_of(hay: &str, needle: &str, at_most: usize) -> Option<usize> {
    let end = (at_most + needle.len()).min(hay.len());
    hay.as_bytes()[..end].windows(needle.len()).rposition(|w| w == needle.as_bytes())
}

/// The byte offset of UTF-16 offset `u` in `line` (clamped).
pub fn utf16_to_byte(line: &str, u: usize) -> usize {
    let mut n = 0;
    for (i, c) in line.char_indices() {
        if n >= u {
            return i;
        }
        n += c.len_utf16();
    }
    line.len()
}

pub fn selected_chars(text: &str) -> usize {
    utf16_len(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_motion_skips_spaces_then_one_class() {
        assert_eq!(word_right("foo.bar baz", 0), 3);
        assert_eq!(word_right("foo.bar baz", 3), 4);
        assert_eq!(word_right("  한글 x", 0), 8);
        assert_eq!(word_left("foo.bar baz", 11), 8);
        assert_eq!(word_left("foo.bar ", 8), 4);
    }

    use crate::commands::act_of;
    use crate::keys::key;
    use std::fs;

    /// Settings, keybindings and backups in a temp folder (once per test run), the repository's grammars.
    fn scratch() -> &'static PathBuf {
        static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        DIR.get_or_init(|| {
            let d = std::env::temp_dir().join(format!("vsedit-unit-{}", std::process::id()));
            fs::create_dir_all(&d).unwrap();
            std::env::set_var("VSEDIT_SETTINGS", d.join("vscode-settings.json"));
            std::env::set_var("VSEDIT_KEYBINDINGS", d.join("vscode-keybindings.json"));
            std::env::set_var("VSEDIT_BACKUPS", d.join("backups"));
            d
        })
    }
    fn vscode() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vscode-viewer/vscode")
    }
    /// An editor on `file` (its language from the name), every line tokenized.
    fn editor_on(file: &Path, doc: Doc) -> Editor {
        scratch();
        let index: Value = serde_json::from_str(&fs::read_to_string(vscode().join("index.json")).unwrap()).unwrap();
        let mut ed = Editor::new(file.to_path_buf(), doc, Highlight::start(vscode(), || {}), index, &Value::Null, vscode());
        let lines = ed.buf.lines.clone();
        ed.hl.reset(ed.scope.as_deref(), &lines);
        assert!(ed.hl.wait(&lines, Instant::now() + Duration::from_secs(10), |h| h.has_lines(0, lines.len() - 1)));
        ed
    }
    fn editor(file: &str, lines: &[&str]) -> Editor {
        editor_on(Path::new(file), Doc { lines: lines.iter().map(|s| s.to_string()).collect(), ..Doc::empty() })
    }
    fn run(ed: &mut Editor, id: &str) {
        ed.run_act(act_of(id).unwrap(), None);
    }
    fn sel(ed: &Editor) -> [usize; 4] {
        [ed.sel.anchor.line, ed.sel.anchor.col, ed.sel.head.line, ed.sel.head.col]
    }
    fn text(ed: &Editor) -> Vec<&str> {
        ed.buf.lines.iter().map(String::as_str).collect()
    }

    #[test]
    fn expand_line_selection_adds_a_line_per_press_and_the_last_line_to_its_end() {
        let mut ed = editor("/tmp/x.txt", &["ab", "cd", "ef"]);
        ed.move_to(pos(0, 1), false);
        let mut got = vec![];
        for _ in 0..4 {
            run(&mut ed, "expandLineSelection");
            got.push(sel(&ed));
        }
        assert_eq!(got, [[0, 0, 1, 0], [0, 0, 2, 0], [0, 0, 2, 2], [0, 0, 2, 2]]);
    }

    #[test]
    fn join_lines_uses_one_space_drops_indent_and_blank_lines_and_keeps_a_selections_end() {
        let mut ed = editor("/tmp/x.txt", &["foo", "    bar", "x  ", "y"]);
        run(&mut ed, "editor.action.joinLines");
        assert_eq!((text(&ed), sel(&ed)), (vec!["foo bar", "x  ", "y"], [0, 3, 0, 3]));
        ed.move_to(pos(1, 0), false);
        ed.join_lines();
        assert_eq!((text(&ed), sel(&ed)), (vec!["foo bar", "x y"], [1, 2, 1, 2])); // trailing whitespace is the space
        ed.join_lines(); // the last line: the cursor goes to its end
        assert_eq!((text(&ed), sel(&ed)), (vec!["foo bar", "x y"], [1, 3, 1, 3]));
        let mut multi = editor("/tmp/x.txt", &["a", "", "  bc", "d"]);
        multi.sel = Sel { anchor: pos(0, 0), head: pos(2, 3) };
        multi.join_lines();
        assert_eq!((text(&multi), sel(&multi)), (vec!["a bc", "d"], [0, 0, 0, 3]));
        multi.undo(false);
        assert_eq!(text(&multi), ["a", "", "  bc", "d"]);
    }

    #[test]
    fn delete_all_right_and_left_take_the_line_break_at_the_edges() {
        let mut ed = editor("/tmp/x.txt", &["ab", "cd"]);
        ed.move_to(pos(0, 1), false);
        run(&mut ed, "deleteAllRight");
        assert_eq!(text(&ed), ["a", "cd"]);
        run(&mut ed, "deleteAllRight");
        assert_eq!(text(&ed), ["acd"]);
        ed.move_to(pos(0, 0), false);
        run(&mut ed, "deleteAllLeft");
        assert_eq!(text(&ed), ["acd"]);
        let mut two = editor("/tmp/x.txt", &["ab", "cd"]);
        two.move_to(pos(1, 0), false);
        run(&mut two, "deleteAllLeft");
        assert_eq!((text(&two), sel(&two)), (vec!["abcd"], [0, 2, 0, 2]));
    }

    #[test]
    fn block_comment_wraps_the_selection_and_takes_the_comment_off_again() {
        let mut ed = editor("/tmp/x.js", &["let x = 1;"]);
        ed.sel = Sel { anchor: pos(0, 4), head: pos(0, 5) };
        run(&mut ed, "editor.action.blockComment");
        assert_eq!((text(&ed), sel(&ed)), (vec!["let /* x */ = 1;"], [0, 7, 0, 8]));
        ed.block_comment();
        assert_eq!((text(&ed), sel(&ed)), (vec!["let x = 1;"], [0, 4, 0, 5]));
        ed.move_to(pos(0, 10), false);
        ed.block_comment();
        assert_eq!((text(&ed), sel(&ed)), (vec!["let x = 1;/*  */"], [0, 13, 0, 13]));
        ed.block_comment();
        assert_eq!(text(&ed), ["let x = 1;"]);
        let mut multi = editor("/tmp/x.js", &["a", "b"]);
        multi.sel = Sel { anchor: pos(0, 0), head: pos(1, 1) };
        multi.block_comment();
        assert_eq!(text(&multi), ["/* a", "b */"]);
        multi.block_comment();
        assert_eq!(text(&multi), ["a", "b"]);
        let mut py = editor("/tmp/x.py", &["x"]);
        py.select_all();
        py.block_comment();
        assert_eq!(text(&py), ["\"\"\" x \"\"\""]);
        let mut plain = editor("/tmp/x.txt", &["x"]);
        plain.select_all();
        plain.block_comment();
        assert_eq!(text(&plain), ["x"]);
        assert!(plain.message.unwrap().text.contains("No block comment syntax known for Plain Text"));
    }

    #[test]
    fn go_to_bracket_jumps_between_partners_to_the_closer_around_else_the_next_bracket() {
        let mut ed = editor("/tmp/x.js", &["foo(a, [b]) ", "f(\")\")"]);
        let go = |ed: &mut Editor, line: usize, col: usize| {
            ed.move_to(pos(line, col), false);
            run(ed, "editor.action.jumpToBracket");
            (ed.head().line, ed.head().col)
        };
        assert_eq!(go(&mut ed, 0, 4), (0, 10));
        ed.jump_to_bracket();
        assert_eq!((ed.head().line, ed.head().col), (0, 3));
        assert_eq!(go(&mut ed, 0, 8), (0, 9));
        assert_eq!(go(&mut ed, 0, 5), (0, 10));
        assert_eq!(go(&mut ed, 0, 0), (0, 3));
        assert_eq!(go(&mut ed, 1, 2), (1, 5)); // the `)` in the string doesn't count
    }

    #[test]
    fn select_to_bracket_selects_the_pair_backwards_from_the_closer() {
        let mut ed = editor("/tmp/x.js", &["foo(a, [b]) x"]);
        ed.move_to(pos(0, 5), false);
        run(&mut ed, "editor.action.selectToBracket");
        assert_eq!(sel(&ed), [0, 3, 0, 11]);
        ed.move_to(pos(0, 11), false);
        ed.select_to_bracket();
        assert_eq!(sel(&ed), [0, 11, 0, 3]);
        ed.move_to(pos(0, 12), false);
        ed.select_to_bracket();
        assert_eq!(sel(&ed), [0, 12, 0, 12]);
    }

    #[test]
    fn find_with_selection_opens_find_and_find_next_selection_moves_without_it() {
        let mut ed = editor("/tmp/x.txt", &["foo bar foo", "bar"]);
        ed.move_to(pos(0, 1), false);
        run(&mut ed, "actions.findWithSelection");
        assert!(ed.find.query == "foo" && ed.prompt.is_some());
        ed.prompt = None;
        ed.sel = Sel { anchor: pos(0, 4), head: pos(0, 7) };
        run(&mut ed, "editor.action.nextSelectionMatchFindAction");
        assert_eq!((ed.find.query.as_str(), sel(&ed), ed.prompt.is_none()), ("bar", [1, 0, 1, 3], true));
        ed.move_to(pos(0, 9), false);
        run(&mut ed, "editor.action.previousSelectionMatchFindAction");
        assert_eq!((ed.find.query.as_str(), sel(&ed)), ("foo", [0, 0, 0, 3]));
        ed.find_selection(-1); // wraps
        assert_eq!(sel(&ed), [0, 8, 0, 11]);
    }

    fn temp_folder(name: &str) -> PathBuf {
        let d = scratch().join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn on_disk(file: &Path) -> Editor {
        editor_on(file, file::load(file, false).unwrap().unwrap())
    }
    /// Types into the open input box and presses Enter.
    fn answer(ed: &mut Editor, typed: Option<&str>, replace: Option<&str>) {
        let Some(Popup::Input(i)) = ed.popup.as_mut() else { panic!("no input box") };
        if let Some(t) = replace {
            i.text = t.into();
            i.select_all = false;
        }
        if let Some(t) = typed {
            i.event(&Ev::Text(t.into()));
        }
        let InputOutcome::Accept(a, text) = i.event(&key("enter")) else { panic!("not accepted") };
        ed.popup = None;
        ed.input_act(a, text);
    }

    #[test]
    fn save_as_asks_in_the_files_folder_saves_there_and_edits_that_file() {
        let dir = temp_folder("save-as");
        let file = dir.join("a.txt");
        fs::write(&file, "one\n").unwrap();
        let mut ed = on_disk(&file);
        ed.typed("x");
        run(&mut ed, "workbench.action.files.saveAs");
        let Some(Popup::Input(i)) = &ed.popup else { panic!() };
        assert_eq!(i.text, format!("{}/", dir.display()));
        answer(&mut ed, Some("b.js"), None); // typed after the folder, not over it
        assert_eq!(fs::read_to_string(dir.join("b.js")).unwrap(), "xone\n");
        assert_eq!(fs::read_to_string(&file).unwrap(), "one\n");
        assert_eq!((ed.file.clone(), ed.language.as_str(), ed.buf.dirty()), (dir.join("b.js"), "JavaScript", false));
        assert!(ed.docs.iter().all(|d| d.file != file));
        run(&mut ed, "workbench.action.files.saveAs"); // an existing file: asks first
        answer(&mut ed, None, Some(&file.display().to_string()));
        let Some(Popup::Dialog(d)) = &ed.popup else { panic!("no dialog") };
        assert!(d.title.contains("'a.txt' already exists"));
        ed.popup = None;
        assert_eq!(fs::read_to_string(&file).unwrap(), "one\n");
        run(&mut ed, "workbench.action.files.saveAs");
        answer(&mut ed, None, Some(&dir.join("missing/c.txt").display().to_string()));
        assert!(ed.message.as_ref().unwrap().text.contains("Folder not found"));
    }

    #[test]
    fn save_all_writes_every_unsaved_open_file_but_one_changed_on_disk() {
        let dir = temp_folder("save-all");
        let [a, b, c] = ["a.txt", "b.txt", "c.txt"].map(|n| dir.join(n));
        for f in [&a, &b, &c] {
            fs::write(f, "1\n").unwrap();
        }
        let mut ed = on_disk(&a);
        for f in [&b, &c, &a] {
            assert!(ed.open(f, None, true));
            ed.typed("x");
        }
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&c, "changed elsewhere\n").unwrap();
        run(&mut ed, "workbench.action.files.saveAll");
        let read = |f: &Path| fs::read_to_string(f).unwrap();
        assert_eq!((read(&a), read(&b), read(&c)), ("x1\n".into(), "x1\n".into(), "changed elsewhere\n".into()));
        assert!(ed.message.as_ref().unwrap().text.contains("Not saved, changed on disk: c.txt"));
    }

    #[test]
    fn go_back_and_forward_return_to_the_file_and_position_before_a_jump() {
        let dir = temp_folder("navigate");
        let (a, b) = (dir.join("a.txt"), dir.join("b.txt"));
        fs::write(&a, "a1\na2\n").unwrap();
        fs::write(&b, "b1\n").unwrap();
        let mut ed = on_disk(&a);
        ed.move_to(pos(1, 1), false);
        assert!(ed.open(&b, Some(pos(0, 2)), true));
        assert_eq!((ed.file.clone(), sel(&ed)), (b.clone(), [0, 2, 0, 2]));
        run(&mut ed, "workbench.action.navigateBack");
        assert_eq!((ed.file.clone(), sel(&ed)), (a.clone(), [1, 1, 1, 1]));
        run(&mut ed, "workbench.action.navigateBack"); // nothing further back
        assert_eq!(ed.file, a);
        run(&mut ed, "workbench.action.navigateForward");
        assert_eq!((ed.file.clone(), sel(&ed)), (b.clone(), [0, 2, 0, 2]));
        assert!(!ed.open(&dir.join("gone.txt"), None, true)); // a file that can't open: no history entry
        run(&mut ed, "workbench.action.navigateBack");
        assert_eq!(ed.file, a);
    }

    #[test]
    fn go_to_file_lists_the_folder_and_goes_to_a_line() {
        let dir = temp_folder("quick-open");
        fs::create_dir_all(dir.join("sub/node_modules")).unwrap();
        for f in ["a.txt", "sub/b.rs", "sub/node_modules/c.js"] {
            fs::write(dir.join(f), "1\n2\n3\n").unwrap();
        }
        let mut ed = on_disk(&dir.join("a.txt"));
        let mut files = ed.project_files();
        files.sort();
        assert_eq!(files, ["a.txt", "sub/b.rs"]);
        run(&mut ed, "workbench.action.quickOpen");
        ed.popup_event(&Ev::Text("b.rs".into()), None);
        let Some(Popup::Picker(p)) = ed.popup.as_ref() else { panic!("no picker") };
        assert_eq!(p.items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["sub/b.rs"]);
        ed.popup_event(&key("enter"), None);
        assert_eq!(ed.file, dir.join("sub/b.rs"));
        run(&mut ed, "workbench.action.quickOpen");
        ed.popup_event(&Ev::Text(":3".into()), None);
        let Some(Popup::Picker(p)) = ed.popup.as_ref() else { panic!() };
        assert_eq!(p.items[0].label, "Go to line 3");
        ed.popup_event(&key("enter"), None);
        assert_eq!(ed.head().line, 2);
    }

    #[test]
    fn cursor_undo_goes_back_through_cursor_moves_and_redo_comes_forward() {
        let mut ed = editor("/tmp/cu.txt", &["one two", "three"]);
        ed.note_cursor();
        for p in [pos(1, 0), pos(1, 5)] {
            ed.move_to(p, false);
            ed.after_event();
        }
        run(&mut ed, "cursorUndo");
        assert_eq!(ed.head(), pos(1, 0));
        run(&mut ed, "cursorUndo");
        assert_eq!(ed.head(), pos(0, 0));
        run(&mut ed, "cursorRedo");
        assert_eq!(ed.head(), pos(1, 0));
        ed.insert("x", false);
        ed.after_event();
        run(&mut ed, "cursorUndo");
        assert_eq!(ed.head(), pos(1, 1), "a text change empties the history");
    }

    #[test]
    fn change_all_previews_as_typed_and_esc_puts_the_word_back() {
        let mut ed = editor("/tmp/ca.js", &["foo(foo);", "foofoo"]);
        run(&mut ed, "editor.action.changeAll");
        ed.popup_event(&Ev::Text("bar".into()), None);
        assert_eq!(text(&ed), ["bar(bar);", "foofoo"], "whole words only");
        ed.popup_event(&key("escape"), None);
        assert_eq!(text(&ed), ["foo(foo);", "foofoo"]);
        run(&mut ed, "editor.action.changeAll");
        ed.popup_event(&Ev::Text("x".into()), None);
        ed.popup_event(&key("enter"), None);
        assert_eq!(text(&ed), ["x(x);", "foofoo"]);
        assert_eq!(ed.message.as_ref().map(|m| m.text.as_str()), Some("Changed 2 occurrences"));
        run(&mut ed, "undo");
        assert_eq!(text(&ed), ["foo(foo);", "foofoo"], "one undo step");
    }

    #[test]
    fn the_context_menu_greys_out_what_no_provider_offers_and_runs_the_rest() {
        let mut ed = editor("/tmp/menu.txt", &["a b", "c"]);
        run(&mut ed, "editor.action.showContextMenu");
        let Some(Popup::Menu(m)) = ed.popup.as_ref() else { panic!("no menu") };
        let row = |t: &str| m.rows.iter().find(|r| r.title == t).unwrap_or_else(|| panic!("{t}"));
        assert!(row("Go to Definition").enabled, "the search fallback");
        assert!(!row("Format Document").enabled, "no formatter for plain text");
        assert!(row("Peek").enabled && row("Peek").submenu.len() == 4);
        assert!(row("Command Palette...").enabled);
        assert_eq!(m.rows.iter().filter(|r| r.sep).count(), 4);
        ed.popup = None;
        run(&mut ed, "workbench.action.showCommands");
        ed.popup_event(&Ev::Text("join lines".into()), None);
        let Some(Popup::Picker(p)) = ed.popup.as_ref() else { panic!("no palette") };
        assert_eq!((p.text.as_str(), p.items[0].label.as_str()), (">join lines", "Join Lines"));
        ed.popup_event(&key("enter"), None);
        assert_eq!(text(&ed), ["a b c"]);
    }

    #[test]
    fn go_to_definition_without_a_server_searches_the_folder() {
        let dir = temp_folder("definition");
        fs::write(dir.join("a.go"), "package main\n\nfunc greet() {}\n").unwrap();
        fs::write(dir.join("b.go"), "package main\n\nfunc main() { greet() }\n").unwrap();
        let mut ed = on_disk(&dir.join("b.go"));
        ed.move_to(pos(2, 16), false);
        run(&mut ed, "editor.action.revealDefinition");
        assert!(ed.wait_jobs(5000), "no answer");
        assert_eq!((ed.file.clone(), ed.head()), (dir.join("a.go"), pos(2, 5)));
        run(&mut ed, "workbench.action.gotoSymbol");
        assert!(ed.wait_jobs(5000));
        let Some(Popup::Picker(p)) = ed.popup.as_ref() else { panic!("no symbols") };
        assert_eq!((p.note.as_str(), p.items[0].label.as_str(), p.items[0].key.as_str()), ("regex outline (no language server)", "greet", "3"));
    }

    #[test]
    fn expand_selection_grows_through_the_string_and_shrink_goes_back() {
        let mut ed = editor("/tmp/s.go", &["f(\"hi there\", x)"]);
        ed.move_to(pos(0, 4), false);
        let mut got = vec![];
        for id in ["editor.action.smartSelect.expand", "editor.action.smartSelect.expand", "editor.action.smartSelect.expand", "editor.action.smartSelect.shrink"] {
            run(&mut ed, id);
            got.push(sel(&ed));
        }
        assert_eq!(got, [[0, 3, 0, 5], [0, 3, 0, 11], [0, 2, 0, 12], [0, 3, 0, 11]]);
    }

    #[test]
    fn columns_count_characters_and_tab_stops() {
        assert_eq!(visible_column("\t한x", 4, 4), 5);
        assert_eq!(utf16_to_byte("a한b", 2), 4);
        assert_eq!(shift_closers(&[pos(0, 3), pos(1, 3)], 0, 2, 2), vec![pos(0, 5), pos(1, 3)]);
    }
}
