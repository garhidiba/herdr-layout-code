//! The editor (vsedit.cjs's Editor): one file's buffer, selection and view, its edits and commands, prompts and
//! overlays, save / quit / hot exit and auto save. Drawing and the mouse are in view.rs.

use crate::autoclose::{self, Typed};
use crate::backup;
use crate::buffer::{caret, edit, end_of, insert_at, pos, Buffer, Change, Edit, Pos, Sel};
use crate::commands::{Act, FindOption, LiveKeys};
use crate::decorations::{is_word_char, Hit};
use crate::file::{self, detect_indent, Doc, Indent};
use crate::find::{self, Opts};
use crate::folding::{self, Folds, Range};
use crate::gitgutter::{self, GitGutter};
use crate::highlight::{Highlight, SemanticLayer};
use crate::keys::{Ev, Key};
use crate::language::{comment_of, language_name};
use crate::overlays::{button, Dialog, Input, InputOutcome, Outcome, Picker};
use crate::paint::{Color, Palette};
use crate::scrollbar::Bar;
use crate::settings::{self, AutoSave, Settings};
use crate::term::{self, Term};
use crate::width::{display_col, index_at_col, next_index, prev_index};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Shown for the keys of features still in the JS editor (language features, the context menu, the palette).
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
    Reload,
    Restore,
    Discard,
}

#[derive(Clone, Copy, Debug)]
pub enum IAct {
    Goto,
    AutoSaveDelay,
}

#[derive(Clone, Debug)]
pub enum PAct {
    IndentMenu(bool),
    TabSize(bool, usize),
    Eol(bool),
    Language(Option<String>),
}

pub enum Popup {
    Dialog(Dialog<DAct>),
    Input(Input<IAct>),
    Picker(Picker<PAct>),
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
    pub fn new(file: PathBuf, doc: Doc, hl: Highlight, index: Value, colors: &Value) -> Editor {
        let settings_path = settings::settings_file();
        let (settings, settings_stamp) = settings::load(&settings_path);
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let scope = crate::language::scope_of(&index, &name);
        let known = scope.as_deref().filter(|s| index["scopes"].get(*s).is_some());
        let buf = Buffer::new(doc.lines.clone());
        let indent = detect_indent(&buf.lines, Indent { use_tabs: !settings.insert_spaces, size: settings.tab_size });
        let mut semantic = SemanticLayer::default();
        semantic.reset(buf.lines.len());
        let now = Instant::now();
        Editor {
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
            rows: 24,
            cols: 80,
            c: Palette::of(colors),
            index,
            settings,
            settings_stamp,
            keys: LiveKeys::new(),
            message: None,
            popup: None,
            prompt: None,
            find: Find { query: String::new(), replace: String::new(), field: Field::Query, opts: Opts::default(), matches: vec![], error: None, searched: None },
            clip: (String::new(), false),
            closers: (0, vec![]),
            folds: Folds::default(),
            ranges: None,
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
            seen_version: 0,
            auto_at: None,
            exit: None,
        }
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
        (self.rows - 2 - self.hbar.shown as i32).max(1) as usize
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
    fn toggle_comment(&mut self) {
        let Some((open, close)) = comment_of(self.scope.as_deref()) else {
            return self.warn(format!("No comment syntax known for {}", self.language));
        };
        let (a, b) = self.selected_lines();
        let rows: Vec<usize> = (a..=b).filter(|l| !self.buf.lines[*l].trim().is_empty()).collect();
        if rows.is_empty() {
            return;
        }
        let lead = |t: &str| t.len() - t.trim_start_matches([' ', '\t']).len();
        let lines = &self.buf.lines;
        let commented = rows.iter().all(|l| {
            let t = &lines[*l];
            t[lead(t)..].starts_with(open) && close.is_none_or(|c| t.trim_end().ends_with(c))
        });
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
        if let Some(c) = self.keys.keymap.command(&chord) {
            if matches!(c.act, Act::ToggleFind(_) | Act::ReplaceOne | Act::ReplaceAll) {
                return self.run_act(c.act, None);
            }
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
        if chord == "ctrl+h" || chord == "alt+cmd+f" {
            self.prompt.as_mut().unwrap().replace = true;
            self.find.field = Field::Replace;
            return;
        }
        if chord == "ctrl+f" || chord == "cmd+f" {
            self.prompt.as_mut().unwrap().replace = false;
            self.find.field = Field::Query;
            return;
        }
        let dir = if k.shift { -1 } else { 1 };
        match k.name.as_str() {
            "enter" if (k.alt || k.cmd) && replace => self.replace_all(),
            "enter" if self.find.field == Field::Replace => self.replace_one(),
            "g" if k.cmd => self.find_next(dir, None),
            "enter" | "f3" | "down" => self.find_next(dir, None),
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
        if self.settings.trim_trailing_whitespace {
            let edits = self.buf.lines.iter().enumerate().filter_map(|(l, t)| {
                let n = t.trim_end().len();
                (n < t.len()).then(|| (l, n, t.len() - n, String::new()))
            });
            let edits: Vec<_> = edits.collect();
            self.line_edits(edits);
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
    /// Asks about unsaved changes, then exits.
    fn quit(&mut self) {
        if !self.buf.dirty() {
            self.exit = Some(0);
            return;
        }
        let name = self.name();
        self.dialog(
            &format!("Do you want to save the changes you made to {name}?"),
            Some("Your changes will be lost if you don't save them."),
            vec![button("Save", 's', DAct::QuitSave), button("Don't Save", 'd', DAct::QuitDiscard), cancel_button()],
        );
    }
    /// Hot exit: unsaved text goes to a backup (runs right before the process ends).
    pub fn hot_exit(&self) {
        if self.buf.dirty() {
            let h = self.head();
            let col = utf16_len(&self.buf.lines[h.line][..h.col]);
            let _ = backup::write(&self.file, &self.buf.all_text(), (h.line, col));
        }
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
    fn dialog_act(&mut self, a: DAct, term: &mut Term) {
        let _ = term;
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
            IAct::AutoSaveDelay => match text.trim().parse::<f64>() {
                Ok(n) if n.is_finite() => self.write_setting("files.autoSaveDelay", settings::js_number(n.clamp(0.1, 3600.0))),
                _ => self.warn(format!("Not a number of seconds: {text}")),
            },
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
    fn pick_act(&mut self, a: PAct) {
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
                self.hl.reset(self.scope.as_deref(), &self.buf.lines);
                self.language = language_name(self.scope.as_deref());
            }
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
        } else {
            self.warn(NOT_YET);
        }
    }
    /// After each input event: restart the auto-save timer when the text changed.
    pub fn after_event(&mut self) {
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
        if self.exit.is_none() && self.popup.is_none() && self.buf.dirty() {
            self.save(false, true, false);
        }
    }

    /// The earliest time something is due (a message to clear, the word highlight, auto save, the drag, git).
    pub fn deadline(&self) -> Option<Instant> {
        let word = self.word.as_ref().map(|w| w.1 + WORD_DELAY).filter(|t| *t > Instant::now());
        [self.message.as_ref().map(|m| m.until), word, self.auto_at, self.drag_next, self.git.deadline()].into_iter().flatten().min()
    }
    /// Runs what is due; true when the screen should be drawn again.
    pub fn tick(&mut self) -> bool {
        let now = Instant::now();
        let mut redraw = self.message.as_ref().is_some_and(|m| m.until <= now);
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
        if self.popup.is_some() {
            return self.popup_event(ev, term);
        }
        if self.prompt.is_some() {
            return self.prompt_key(ev);
        }
        let k = match ev {
            Ev::Text(t) => return self.typed(t),
            Ev::Paste(t) => return self.paste(Some(t.clone())),
            Ev::Key(k) => k.clone(),
            _ => return,
        };
        if let Some(c) = self.keys.keymap.command(&k.chord()) {
            return self.run_act(c.act, Some(term));
        }
        self.key(&k);
    }

    pub fn popup_event(&mut self, ev: &Ev, term: &mut Term) {
        let area = crate::overlays::Area { c: &self.c, rows: self.rows, cols: self.cols };
        match self.popup.as_mut().unwrap() {
            Popup::Dialog(d) => match d.event(ev) {
                Outcome::Stay => {}
                Outcome::Close => self.popup = None,
                Outcome::Run(a) => {
                    self.popup = None;
                    self.dialog_act(a, term);
                }
            },
            Popup::Input(i) => match i.event(ev) {
                InputOutcome::Stay => {}
                InputOutcome::Cancel => self.popup = None,
                InputOutcome::Accept(a, text) => {
                    self.popup = None;
                    self.input_act(a, text);
                }
            },
            Popup::Picker(p) => match p.event(ev, &area) {
                Outcome::Stay => {}
                Outcome::Close => self.popup = None,
                Outcome::Run(a) => {
                    self.popup = None;
                    self.pick_act(a);
                }
            },
        }
    }

    fn key(&mut self, k: &Key) {
        let (name, shift, alt) = (k.name.as_str(), k.shift, k.alt);
        let h = self.head();
        if k.cmd {
            match name {
                "left" => self.home(shift),
                "right" => self.line_end(shift),
                "up" => self.move_to(pos(0, 0), shift),
                "down" => self.doc_end(shift),
                "backspace" if self.empty() => self.delete_range(pos(h.line, 0), h),
                "backspace" => self.backspace(false),
                "delete" if self.empty() => self.delete_range(h, pos(h.line, self.buf.lines[h.line].len())),
                "delete" => self.delete_forward(false),
                _ => {}
            }
            return;
        }
        if k.ctrl {
            match name {
                "home" => self.move_to(pos(0, 0), shift),
                "end" => self.doc_end(shift),
                "left" | "right" => self.horizontal(if name == "left" { -1 } else { 1 }, shift, true),
                "up" | "down" => self.top = self.scrolled(if name == "up" { -1 } else { 1 }, None),
                "backspace" | "w" => self.backspace(true),
                "delete" => self.delete_forward(true),
                "u" if self.empty() => self.delete_range(pos(h.line, 0), h),
                "u" => self.backspace(false),
                "e" => self.line_end(shift),
                _ => {}
            }
            return;
        }
        match name {
            "left" | "right" => self.horizontal(if name == "left" { -1 } else { 1 }, shift, alt),
            "up" | "down" => self.vertical(if name == "up" { -1 } else { 1 }, shift),
            "pageup" | "pagedown" => {
                let h = self.height() as i64;
                let d = if name == "pageup" { -h } else { h };
                let max = self.view_count().saturating_sub(self.height());
                self.top = self.scrolled(d, Some(max));
                self.vertical(d, shift);
            }
            "home" => self.home(shift),
            "end" => self.line_end(shift),
            "enter" if !alt => self.enter(),
            "tab" => self.tab_key(shift),
            "backspace" => self.backspace(alt),
            "delete" => self.delete_forward(alt),
            "escape" if !self.empty() => self.move_to(self.head(), false),
            _ => {}
        }
    }

    pub fn run_act(&mut self, act: Act, term: Option<&mut Term>) {
        match act {
            Act::Lang | Act::QuickOpen | Act::OpenSettingsJson | Act::OpenKeybindingsJson | Act::Navigate(_) => self.warn(NOT_YET),
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
            Act::ToggleComment => self.toggle_comment(),
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

fn cancel_button() -> crate::overlays::Button<DAct> {
    crate::overlays::Button { label: "Cancel".into(), key: 'c', act: DAct::Cancel, cancel: true }
}

/// Closers on `line` at or after `col` moved by `delta` bytes (an insert or delete there).
fn shift_closers(at: &[Pos], line: usize, col: usize, delta: i64) -> Vec<Pos> {
    at.iter().map(|q| if q.line == line && q.col >= col { pos(line, (q.col as i64 + delta).max(0) as usize) } else { *q }).collect()
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

    #[test]
    fn columns_count_characters_and_tab_stops() {
        assert_eq!(visible_column("\t한x", 4, 4), 5);
        assert_eq!(utf16_to_byte("a한b", 2), 4);
        assert_eq!(shift_closers(&[pos(0, 3), pos(1, 3)], 0, 2, 2), vec![pos(0, 5), pos(1, 3)]);
    }
}
