//! Drawing and the mouse (vsedit.cjs render/mouse): breadcrumbs, the gutter, colored text with selection, find
//! matches, indent guides, bracket match, occurrences, git bars and folds, the scrollbars with the overview ruler,
//! the status bar, the find widget and the overlays.

use crate::buffer::{pos, Pos, Sel};
use crate::commands::FindOption;
use crate::decorations::{self, Guide, Hit};
use crate::editor::{selected_chars, visible_column, word_left, word_right, Editor, FindAct, Field, Popup, StatusAct};
use crate::folding;
use crate::gitgutter::{self, Mark};
use crate::highlight::{font_style_of, foreground_of, token_index, Tokens};
use crate::keys::{Ev, Mouse};
use crate::overlays::Area;
use crate::paint::{fit, Painter};
use crate::scrollbar::{self, BarMouse};
use crate::term::Term;
use crate::width::{char_width, display_col, index_at_col, next_index, text_width};
use std::time::{Duration, Instant};

const WORD_DELAY: Duration = Duration::from_millis(250);

/// Occurrences to highlight and their colors.
struct Hits {
    list: Vec<Hit>,
    /// documentHighlight: which of `list` write (their colors are the strong ones); empty for plain occurrences.
    writes: Vec<bool>,
    bg: String,
    ruler: String,
}

/// A text row: a line (None past the end) or, on the row above it, that line's CodeLens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Row {
    pub line: Option<usize>,
    pub lens: bool,
    /// k > 0: line k of a multi-line ghost text (inline suggestion), below its line.
    pub ghost: usize,
}

struct Deco<'a> {
    guide: Guide,
    brackets: Vec<usize>,
    hits: &'a [Hit],
    writes: &'a [bool],
    hit_bg: &'a str,
    folded: bool,
    /// On the cursor line while a suggestion shows: (byte col, its lines).
    ghost: Option<(usize, &'a [String])>,
    /// This line's squiggles (bytes [from, to), color), the most severe first.
    problems: Vec<(usize, usize, String)>,
}

fn tw(s: &str) -> i32 {
    text_width(s, 8) as i32
}

impl Editor {
    /// The whole frame as ANSI text.
    pub fn render(&mut self) -> String {
        if self.folds.any() {
            self.fold_ranges();
        }
        let t = self.top.min(self.buf.lines.len() - 1);
        self.top = self.folds.visible(t);
        self.layout_bars();
        let mut p = Painter::default();
        let (height, width, gw) = (self.height(), self.text_width(), self.gutter());
        // each text row: a line (folded lines skipped), its lenses above it, or a line of a multi-line ghost text below
        // the cursor line
        let ghost = self.ghost_view();
        let layout = self.layout_rows(height);
        let rows: Vec<Option<usize>> = layout.iter().filter(|r| !r.lens && r.ghost == 0).map(|r| r.line).collect();
        let end = rows.iter().flatten().max().copied().unwrap_or(self.top) + 1;
        let (ss, se) = self.range();
        let empty = self.empty();
        let show_matches = self.prompt.is_some() && !self.find.query.is_empty();
        let ms: Vec<Hit> = if show_matches { self.matches().to_vec() } else { vec![] };
        let current = if self.prompt.is_some() { self.current_match().map(|i| self.find.matches[i]) } else { None };
        let guides = self.guides_for(&rows);
        let brackets = self.bracket_pair();
        let hits = if show_matches { None } else { self.highlights(height) };
        self.git.start();
        let changes = gitgutter::marks_for(&self.git.hunks, self.top, end - 1);
        let ranges = if self.gutter_hover { Some(self.fold_ranges()) } else { None };
        if self.lang.outline.as_ref().is_none_or(|o| o.version != self.buf.version) {
            self.queue_outline();
        }
        let problems = self.problems();
        let bulb = self.light_bulb_line();
        let c = &self.c;

        // breadcrumbs
        p.move_to(1, 1);
        let crumbs = self.crumb_text();
        let dirty = self.buf.dirty();
        p.text(&fit(&format!("{crumbs}{}", if dirty { " ●" } else { "" }), self.cols as usize), &c.bar_fg, &c.bg);
        if dirty {
            let w = tw(&format!("{crumbs} "));
            if w < self.cols {
                p.move_to(1, w + 1);
                p.text("●", &c.warn, &c.bg);
            }
        }

        let no_hits: Vec<Hit> = vec![];
        let (mut mi, mut hi, mut k_row) = (0, 0, 0);
        for (r, row) in layout.iter().enumerate() {
            p.move_to(r as i32 + 2, 1);
            if row.lens {
                self.paint_lens(&mut p, row.line.unwrap_or(0));
                continue;
            }
            if row.ghost > 0 {
                // a ghost text line below the cursor line
                let g = ghost.as_ref().unwrap();
                p.text(&" ".repeat(gw), &self.c.fg, &self.c.bg);
                let bg = self.c.bg.clone();
                let x = self.paint_ghost_tail(&mut p, g.0, g.1, &g.2, row.ghost, 0, 0, width, &bg, &|_| None, None);
                if x < width {
                    p.text(&" ".repeat(width - x), &self.c.fg, &self.c.bg);
                }
                continue;
            }
            let g_row = k_row; // the line's index in rows (guides)
            k_row += 1;
            let Some(l) = row.line else {
                p.text(&" ".repeat(self.cols as usize), &self.c.fg, &self.c.bg);
                continue;
            };
            let folded = self.folds.has(l);
            let active = l == self.head().line;
            let chevron = if folded { "›" } else if ranges.as_ref().is_some_and(|rs| folding::range_at(rs, l).is_some()) { "⌄" } else { " " };
            let mut spans: Vec<(usize, usize, String, u8)> = vec![];
            for d in &problems {
                if d.start.line > l {
                    break;
                }
                if let Some((f, t)) = Editor::problem_span(d, l, &self.buf.lines[l]) {
                    spans.push((f, t, self.c.diag[d.severity as usize].clone(), d.severity));
                }
            }
            spans.sort_by_key(|s| s.3);
            let mark = if bulb == Some(l) { Some(("◆", self.c.light_bulb.clone())) } else { spans.first().map(|s| ("●", s.2.clone())) };
            self.paint_gutter(&mut p, l, active, changes.get(&l).copied(), chevron, mark);
            let line_bg = if active && empty { self.c.current_line.clone() } else if folded { self.c.fold_background.clone() } else { self.c.bg.clone() };
            while mi < ms.len() && ms[mi].0 < l {
                mi += 1;
            }
            let mut k = mi;
            while k < ms.len() && ms[k].0 == l {
                k += 1;
            }
            let occ = hits.as_ref().map_or(&no_hits, |h| &h.list);
            let writes = hits.as_ref().map_or(&[][..], |h| &h.writes[..]);
            while hi < occ.len() && occ[hi].0 < l {
                hi += 1;
            }
            let mut kh = hi;
            while kh < occ.len() && occ[kh].0 == l {
                kh += 1;
            }
            let deco = Deco {
                ghost: ghost.as_ref().filter(|g| g.0 == l).map(|g| (g.1, g.2.as_slice())),
                guide: guides.get(g_row).copied().unwrap_or_default(),
                brackets: brackets.iter().filter(|b| b.line == l).map(|b| b.col).collect(),
                hits: &occ[hi..kh],
                writes: writes.get(hi..kh).unwrap_or(&[]),
                hit_bg: hits.as_ref().map_or("", |h| h.bg.as_str()),
                folded,
                problems: spans.into_iter().map(|s| (s.0, s.1, s.2)).collect(),
            };
            self.paint_line(&mut p, l, &line_bg, (ss, se), &ms[mi..k], current, width, &deco);
        }
        self.marks = if self.vbar.shown { Some(self.ruler_marks(&ms, hits.as_ref(), &problems)) } else { None };
        self.vbar.paint(&mut p, &self.c, self.marks.as_deref());
        if self.hbar.shown {
            p.move_to(height as i32 + 2, 1);
            p.text(&" ".repeat(self.cols as usize), &self.c.fg, &self.c.bg);
            self.hbar.paint(&mut p, &self.c, None);
        }
        if self.ls.peek.is_some() {
            let v = self.rows_to(self.head().line) as i32 + 3;
            self.ls.peek_row = v.min(height as i32 + 2 - crate::overlays::Peek::HEIGHT).max(2);
            self.render_peek(&mut p);
        }
        let area = Area { c: &self.c, rows: self.rows, cols: self.cols };
        if let Some(pn) = self.ls.panel.as_mut() {
            let root = crate::lang::git_root(&self.file);
            pn.render(&mut p, &area, &root);
        }
        if let Some(h) = self.ls.hover_box.as_mut() {
            h.render(&mut p, &area);
        }
        self.render_status(&mut p);
        let mut cursor = self.render_prompt(&mut p);
        let area = Area { c: &self.c, rows: self.rows, cols: self.cols };
        match self.popup.as_mut() {
            Some(Popup::Dialog(d)) => {
                d.render(&mut p, &area);
                cursor = Some((-1, -1));
            }
            Some(Popup::Input(i)) => {
                i.render(&mut p, &area);
                cursor = Some(i.cursor);
            }
            Some(Popup::Picker(pk)) => {
                pk.render(&mut p, &area);
                cursor = Some(pk.cursor);
            }
            Some(Popup::Menu(m)) => {
                m.render(&mut p, &area);
                cursor = Some((-1, -1));
            }
            None => {}
        }
        p.out.push_str("\x1b[0m");
        let on = self.vbar.shown || self.hbar.shown || self.buf.lines.len() > 1;
        p.out.push_str(scrollbar::hover_mode(&mut self.hover_mode, on));
        match cursor {
            Some((-1, _)) => p.out.push_str("\x1b[?25l"),
            Some((row, col)) => p.out.push_str(&format!("\x1b[{row};{col}H\x1b[?25h")),
            None => {
                let Pos { line, col } = self.head();
                let x = display_col(&self.buf.lines[line], col, self.tab()) as i64 - self.left as i64;
                let row = self.rows_to(line);
                let hidden = self.folds.is_hidden(line);
                if !hidden && row >= 0 && row < height as i64 && x >= 0 && x < width as i64 {
                    p.out.push_str(&format!("\x1b[{};{}H\x1b[?25h", row + 2, gw as i64 + x + 1));
                } else {
                    p.out.push_str("\x1b[?25l");
                }
            }
        }
        p.out
    }

    /// Breadcrumbs: the file's folders and name, then the symbols around the cursor; only the name when off.
    fn crumb_text(&self) -> String {
        if !self.settings.breadcrumbs {
            return format!(" {}", self.crumbs.last().map_or("", String::as_str));
        }
        let names: Vec<String> = self.crumbs.iter().cloned().chain(self.crumb_symbols()).collect();
        format!(" {}", names.join(" › "))
    }

    /// The peek box: the result's file and ~8 lines around it, the result highlighted.
    fn render_peek(&mut self, p: &mut Painter) {
        let Some(pk) = self.ls.peek.as_ref() else { return };
        let (it, title, n, index) = (pk.items[pk.index].clone(), pk.title.clone(), pk.items.len(), pk.index);
        let (row, w) = (self.ls.peek_row, self.cols);
        let doc = if it.file == self.file { None } else { self.doc_index(&it.file) };
        let c = &self.c;
        let right = format!("{}Enter open · Esc close ", if n > 1 { format!("{} of {n} · ↑↓ · ", index + 1) } else { String::new() });
        let root = crate::lang::git_root(&self.file);
        let dir = it.file.parent().and_then(|d| d.strip_prefix(&root).ok()).map(|d| d.to_string_lossy().into_owned()).filter(|d| !d.is_empty()).unwrap_or_else(|| ".".into());
        let head = format!(" {}  {dir}  — {title}", it.file.file_name().map_or_else(String::new, |f| f.to_string_lossy().into_owned()));
        p.move_to(row, 1);
        p.text(&fit(&head, (w - tw(&right)).max(0) as usize), &c.fg, &c.widget);
        if tw(&right) < w {
            p.text(&right, &c.bar_fg, &c.widget);
        }
        let loaded = it.file == self.file || doc.is_some();
        let (lines, hl, tab) = match doc {
            Some(i) => (&self.docs[i].buf.lines, &self.docs[i].hl, self.docs[i].indent.size),
            None => (&self.buf.lines, &self.hl, self.tab()),
        };
        let first = it.line.saturating_sub(2);
        let gw = 7usize;
        for r in 0..crate::overlays::Peek::LINES {
            p.move_to(row + 1 + r, 1);
            let l = first + r as usize;
            if !loaded || l >= lines.len() {
                p.text(&fit(if r == 0 && !loaded { "  Loading…" } else { "" }, w as usize), &c.line_number, &c.peek);
                continue;
            }
            let target = l == it.line;
            let bg = if target { c.peek_line.as_str() } else { c.peek.as_str() };
            p.text(&format!("{:>5}  ", l + 1), if target { &c.line_number_active } else { &c.line_number }, bg);
            let text = &lines[l];
            let from = crate::lang::edits::byte_of(text, it.col);
            let to = it.end.filter(|e| e.line == l).map_or(from, |e| crate::lang::edits::byte_of(text, e.col));
            let bg_at = |i: usize| -> Option<&str> { (target && i >= from && i < to).then_some(c.find_match.as_str()) };
            let (x, _) = self.paint_text(p, None, text, hl.line(l), (w as usize).saturating_sub(gw), 0, bg, &bg_at, tab, None, None, None);
            if x < (w as usize).saturating_sub(gw) {
                p.text(&" ".repeat(w as usize - gw - x), &c.fg, bg);
            }
        }
        p.move_to(row + crate::overlays::Peek::LINES + 1, 1);
        p.text(&"─".repeat(w.max(0) as usize), &c.accent, &c.bg);
    }

    fn layout_bars(&mut self) {
        let base = (self.rows - 2 - self.panel_height()).max(1) as usize;
        let n = self.view_count();
        let widest = self.widest(self.top, base);
        let gw = self.gutter();
        // A file with problems always shows the bar: its overview ruler carries their marks, as VS Code's always does.
        let mut v = n > base || self.top > 0 || !self.problems().is_empty();
        let h = widest as i64 > self.cols as i64 - gw as i64 - v as i64 || self.left > 0;
        if h {
            v = v || n > base - 1;
        }
        let height = (base - h as usize).max(1);
        let width = (self.cols - gw as i32 - v as i32).max(1);
        let tv = self.row_of(self.top);
        self.vbar.layout(v, 2, self.cols, height as i64, height as i64, (n + height - 1) as i64, tv as i64);
        self.hbar.layout(h, height as i32 + 2, gw as i32 + 1, width as i64, width as i64, widest as i64 + 5, self.left as i64);
    }

    /// Display width of the widest of `count` lines from `top` (a very long line counts its length).
    pub fn widest(&mut self, top: usize, count: usize) -> usize {
        let (mut w, mut l) = (0, top);
        for _ in 0..count {
            if l >= self.buf.lines.len() {
                break;
            }
            let t = &self.buf.lines[l];
            w = w.max(if t.len() > 1000 { t.len() } else { text_width(t, self.indent.size) });
            l = self.folds.next(l);
        }
        w
    }

    fn ruler_marks(&mut self, ms: &[Hit], hits: Option<&Hits>, problems: &[crate::editor::Problem]) -> Vec<Option<String>> {
        let n = self.view_count();
        let len = self.vbar.length.max(0) as usize;
        let mut marks: Vec<Option<String>> = vec![None; len];
        if len == 0 {
            return marks;
        }
        let hunks = self.git.hunks.clone();
        // A file that fits puts each line's mark beside its row.
        let cell = |ed: &mut Editor, line: usize| scrollbar::mark_cell(ed.row_of(line), n.max(len), len);
        for h in &hunks {
            let color = match h.kind {
                gitgutter::Kind::Added => self.c.ruler_added.clone(),
                gitgutter::Kind::Modified => self.c.ruler_modified.clone(),
                gitgutter::Kind::Deleted => self.c.ruler_deleted.clone(),
            };
            let a = gitgutter::line_of(h);
            let (from, to) = (cell(self, a), cell(self, a.max(h.end.saturating_sub(1))));
            for m in &mut marks[from..=to] {
                *m = Some(color.clone());
            }
        }
        for m in ms {
            let k = cell(self, m.0);
            marks[k] = Some(self.c.ruler_find.clone());
        }
        if let Some(h) = hits {
            for (i, m) in h.list.iter().enumerate() {
                let k = cell(self, m.0);
                marks[k] = Some(if h.writes.get(i) == Some(&true) { self.c.ruler_word_strong.clone() } else { h.ruler.clone() });
            }
        }
        if !self.empty() {
            let k = cell(self, self.sel.anchor.line);
            marks[k] = Some(self.c.ruler_selection.clone());
        }
        let k = cell(self, self.head().line);
        marks[k] = Some(self.c.ruler_cursor.clone());
        let mut ps: Vec<&crate::editor::Problem> = problems.iter().collect();
        ps.sort_by_key(|d| std::cmp::Reverse(d.severity)); // errors win, over everything else
        for d in ps {
            let k = cell(self, d.start.line);
            marks[k] = Some(self.c.ruler_diag[d.severity as usize].clone());
        }
        marks
    }

    /// Indent guides of the visible rows (runs of consecutive lines between folds at once).
    fn guides_for(&self, rows: &[Option<usize>]) -> Vec<Guide> {
        let mut out = vec![];
        let mut r = 0;
        while r < rows.len() {
            let Some(first) = rows[r] else { break };
            let mut k = r;
            while k + 1 < rows.len() && rows[k + 1] == Some(rows[k].unwrap() + 1) {
                k += 1;
            }
            out.extend(decorations::indent_guides(&self.buf.lines, first, rows[k].unwrap(), self.tab(), self.tab(), self.head().line));
            r = k + 1;
        }
        out
    }

    /// The bracket at the cursor and its partner, brackets in strings and comments not counting.
    fn bracket_pair(&self) -> Vec<Pos> {
        let code = self.is_code();
        decorations::match_bracket(&self.buf.lines, self.head(), &code, 20000, false).map_or(vec![], |(a, b)| vec![a, b])
    }

    /// The word whose occurrences highlight once the cursor rested on it WORD_DELAY.
    fn resting_word(&mut self) -> Option<String> {
        let w = if self.empty() { self.word_at(self.head()) } else { None };
        let key = w.as_ref().map(|(t, s, _)| format!("{}:{}:{}:{t}", self.buf.version, s.line, s.col));
        match (&self.word, key) {
            (Some((k, since)), Some(key)) if *k == key => (since.elapsed() >= WORD_DELAY).then(|| w.unwrap().0),
            (_, key) => {
                self.word = key.map(|k| (k, Instant::now()));
                None
            }
        }
    }

    /// Exact matches of a one-line selection, else whole-word matches of the resting word: the whole file up to
    /// 20,000 lines (for the overview ruler), else the visible lines.
    fn highlights(&mut self, height: usize) -> Option<Hits> {
        let (s, e) = self.range();
        let sel = (!self.empty() && s.line == e.line).then(|| self.buf.text(s, e)).filter(|t| !t.trim().is_empty());
        let word = self.resting_word();
        if sel.is_none() && word.is_none() {
            return None;
        }
        if sel.is_none() {
            let key = self.word.as_ref().map(|w| format!("{}:{}", self.file.display(), w.0)).unwrap_or_default();
            if let Some((list, writes)) = self.reference_hits(&key) {
                return Some(Hits { list, writes, bg: self.c.word_highlight.clone(), ruler: self.c.ruler_word.clone() });
            }
        }
        let whole = self.buf.lines.len() <= 20000;
        let (a, b) = if whole { (0, self.buf.lines.len() - 1) } else { (self.top, self.top + height - 1) };
        let key = format!("{}:{a}:{b}:{}", self.buf.version, sel.as_ref().map_or(format!("w{}", word.as_deref().unwrap_or("")), |t| format!("s{t}")));
        if self.hits_cache.as_ref().is_none_or(|h| h.0 != key) {
            let list = match &sel {
                Some(t) => decorations::text_matches(&self.buf.lines, a, b, t),
                None => decorations::word_matches(&self.buf.lines, a, b, word.as_deref().unwrap()),
            };
            self.hits_cache = Some((key, list));
        }
        let list = self.hits_cache.as_ref().unwrap().1.clone();
        Some(if sel.is_some() {
            Hits { list, writes: vec![], bg: self.c.selection_highlight.clone(), ruler: self.c.ruler_selection.clone() }
        } else {
            Hits { list, writes: vec![], bg: self.c.word_highlight.clone(), ruler: self.c.ruler_word.clone() }
        })
    }

    /// The gutter: a problem's mark `●` or the light bulb `◆` (`mark`: glyph and color), the line number, the git
    /// change bar, the fold chevron.
    fn paint_gutter(&self, p: &mut Painter, l: usize, active: bool, change: Option<Mark>, fold: &str, mark: Option<(&str, String)>) {
        let c = &self.c;
        match &mark {
            Some((g, color)) => p.text(g, color, &c.bg),
            None => p.text(" ", &c.line_number, &c.bg),
        }
        p.text(&format!("{:>w$}", l + 1, w = self.gutter() - 3), if active { &c.line_number_active } else { &c.line_number }, &c.bg);
        let (glyph, color) = match change {
            Some(Mark::Added) => ("▎", &c.git_added),
            Some(Mark::Modified) => ("▎", &c.git_modified),
            Some(Mark::DeletedBelow) => ("▁", &c.git_deleted),
            Some(Mark::DeletedAbove) => ("▔", &c.git_deleted),
            None => (" ", &c.fg),
        };
        p.text(glyph, color, &c.bg);
        p.text(fold, &c.fold_control, &c.bg);
    }

    #[allow(clippy::too_many_arguments)]
    fn paint_line<'a>(&'a self, p: &mut Painter, l: usize, line_bg: &'a str, (ss, se): (Pos, Pos), matches: &[Hit], current: Option<Hit>, width: usize, deco: &'a Deco) {
        let c = &self.c;
        let text = &self.buf.lines[l];
        let size = self.tab();
        let sel_from = if l < ss.line || l > se.line { None } else { Some(if l == ss.line { ss.col } else { 0 }) };
        let sel_to = if l == se.line { se.col } else { usize::MAX };
        let scope = self.find.scope.filter(|_| self.prompt.is_some());
        let scope_from = scope.and_then(|(s, e)| (l >= s.line && l <= e.line).then_some(if l == s.line { s.col } else { 0 }));
        let scope_to = scope.map_or(usize::MAX, |(_, e)| if l == e.line { e.col } else { usize::MAX });
        let bg_at = |i: usize| -> Option<&str> {
            if let Some(m) = matches.iter().find(|m| i >= m.1 && i < m.1 + m.2) {
                return Some(if current.is_some_and(|cm| cm.0 == l && cm.1 == m.1) { &c.find_match } else { &c.match_other });
            }
            if sel_from.is_some_and(|f| i >= f && i < sel_to) {
                return Some(&c.selection);
            }
            if deco.brackets.contains(&i) {
                return Some(&c.bracket_match);
            }
            if let Some(k) = deco.hits.iter().position(|h| i >= h.1 && i < h.1 + h.2) {
                return Some(if deco.writes.get(k) == Some(&true) { &c.word_highlight_strong } else { deco.hit_bg });
            }
            scope_from.is_some_and(|f| i >= f && i < scope_to).then_some(c.find_range.as_str())
        };
        let g = deco.guide;
        let guide_at = |k: usize| -> Option<&str> {
            (g.count > 0 && k.is_multiple_of(size) && k / size < g.count).then(|| if Some(k / size) == g.active { c.guide_active.as_str() } else { c.guide.as_str() })
        };
        let curly_at = |i: usize| -> Option<&'a str> { deco.problems.iter().find(|s| i >= s.0 && i < s.1).map(|s| s.2.as_str()) };
        let curly: Option<&dyn Fn(usize) -> Option<&'a str>> = if deco.problems.is_empty() { None } else { Some(&curly_at) };
        if let Some((gc, lines)) = deco.ghost {
            // the line up to the cursor, the ghost text, then the rest of the line
            let cx = display_col(text, gc, size);
            let mut x = if cx > self.left { self.paint_text(p, Some(l), text, self.hl.line(l), width.min(cx - self.left), self.left, line_bg, &bg_at, size, Some(&guide_at), curly, None).0 } else { 0 };
            x = self.paint_ghost_tail(p, l, gc, lines, 0, cx, x, width, line_bg, &bg_at, curly);
            if x < width {
                p.text(&" ".repeat(width - x), &c.fg, line_bg);
            }
            return;
        }
        let link = self.ls.link.filter(|k| k.0 == l).map(|k| (k.1, k.2));
        let (mut x, col) = self.paint_text(p, Some(l), text, self.hl.line(l), width, self.left, line_bg, &bg_at, size, Some(&guide_at), curly, link);
        if x < width && sel_from.is_some() && sel_to > text.len() && col >= self.left {
            p.text(" ", &c.fg, &c.selection);
            x += 1;
        }
        if deco.folded && x < width && col >= self.left {
            let m: String = " ⋯".chars().take(width - x).collect();
            p.text(&m, &c.fold_placeholder, line_bg);
            x += m.chars().count();
        }
        if x >= width {
            return;
        }
        if g.count == 0 {
            return p.text(&" ".repeat(width - x), &c.fg, line_bg);
        }
        let mut pad = String::new();
        for k in self.left + x..self.left + width {
            match guide_at(k) {
                None => pad.push(' '),
                Some(gc) => {
                    if !pad.is_empty() {
                        p.text(&pad, &c.fg, line_bg);
                        pad.clear();
                    }
                    p.text("│", gc, line_bg);
                }
            }
        }
        if !pad.is_empty() {
            p.text(&pad, &c.fg, line_bg);
        }
    }

    /// Paints a line's visible part [left, left+width) with token colors (and, for a line of the current file, the
    /// semantic layer over them); `curly_at`: the squiggle color at a byte. Returns (cells painted, display width).
    #[allow(clippy::too_many_arguments)]
    fn paint_text<'a>(
        &'a self,
        p: &mut Painter,
        line: Option<usize>,
        text: &str,
        tokens: Option<&Tokens>,
        width: usize,
        left: usize,
        line_bg: &'a str,
        bg_at: &dyn Fn(usize) -> Option<&'a str>,
        tab: usize,
        guide_at: Option<&dyn Fn(usize) -> Option<&'a str>>,
        curly_at: Option<&dyn Fn(usize) -> Option<&'a str>>,
        link: Option<(usize, usize)>,
    ) -> (usize, usize) {
        let c = &self.c;
        let (mut col, mut ti, mut x, mut start) = (0usize, 0usize, 0usize, 0usize);
        let mut lead = guide_at.is_some();
        let right = left + width;
        let tokens = tokens.filter(|t| !t.is_empty());
        // a long line of single-width characters: start at the first visible one
        if left > 0 && text.len() > 1000 && text.bytes().all(|b| (0x20..0x7f).contains(&b)) {
            start = left.min(text.len());
            col = start;
            if let Some(t) = tokens {
                ti = token_index(t, start);
            }
        }
        for (k, ch) in text[start..].char_indices() {
            let i = start + k;
            if col >= right {
                break;
            }
            let (mut fg, mut style) = (c.fg.as_str(), 0);
            if let Some(t) = tokens {
                while ti + 1 < t.len() && t[ti + 1].0 as usize <= i {
                    ti += 1;
                }
                let meta = t[ti].1;
                fg = self.hl.color_map.get(foreground_of(meta)).and_then(|o| o.as_deref()).unwrap_or(c.fg.as_str());
                style = font_style_of(meta);
            }
            if let Some(span) = line.and_then(|l| self.semantic.at(l, i)) {
                (fg, style) = (span.fg.as_str(), span.style);
            }
            if link.is_some_and(|(a, b)| i >= a && i < b) {
                (fg, style) = (c.link.as_str(), style | 4); // a Ctrl (⌘) hovered word: underlined like a link
            }
            let bg = bg_at(i).unwrap_or(line_bg);
            let curly = curly_at.and_then(|f| f(i));
            let (w, mut glyph) = if ch == '\t' {
                let w = tab - col % tab;
                (w, " ".repeat(w))
            } else {
                let cp = ch as u32;
                let g = if cp < 0x20 { char::from_u32(0x2400 + cp).unwrap().to_string() } else if cp == 0x7f { "␡".into() } else { ch.to_string() };
                (char_width(ch), g)
            };
            if lead && ch != ' ' && ch != '\t' {
                lead = false;
            }
            let mut fgc = fg.to_string();
            if lead && bg != c.selection {
                if let Some(ga) = guide_at {
                    let mut gl = String::new();
                    let mut gc: Option<&str> = None;
                    for k in 0..w {
                        let kc = ga(col + k);
                        gl.push(if kc.is_some() { '│' } else { ' ' });
                        gc = gc.or(kc);
                    }
                    if let Some(gc) = gc {
                        glyph = gl;
                        fgc = gc.to_string();
                    }
                }
            }
            if w == 0 {
                if col > left && col <= right {
                    p.out.push(ch);
                }
            } else if col >= left && col + w <= right {
                p.styled(&glyph, &fgc, bg, style, curly);
                x += w;
            } else if col + w > left {
                let vis = (col + w).min(right) - col.max(left);
                p.styled(&" ".repeat(vis), &fgc, bg, style, curly);
                x += vis;
            }
            col += w;
        }
        (x, col)
    }

    /// Paints ghost text line k (of the suggestion at line `l`, byte `gc`) from display column `start` after `x` painted
    /// cells, in the ghost color with tabs to the next stop, then on its last line the rest of line `l`, moved after it;
    /// returns the cells painted.
    #[allow(clippy::too_many_arguments)]
    fn paint_ghost_tail<'a>(
        &'a self,
        p: &mut Painter,
        l: usize,
        gc: usize,
        lines: &[String],
        k: usize,
        start: usize,
        mut x: usize,
        width: usize,
        line_bg: &'a str,
        bg_at: &dyn Fn(usize) -> Option<&'a str>,
        curly: Option<&dyn Fn(usize) -> Option<&'a str>>,
    ) -> usize {
        let (tab, right) = (self.tab(), self.left + width);
        let mut col = start;
        for ch in lines[k].chars() {
            let w = if ch == '\t' { tab - col % tab } else { char_width(ch) };
            if w > 0 && col >= self.left && col + w <= right {
                let glyph = if ch == '\t' { " ".repeat(w) } else if (ch as u32) < 0x20 { " ".into() } else { ch.to_string() };
                p.text(&glyph, &self.c.ghost, line_bg);
                x += w;
            }
            col += w;
        }
        if k + 1 == lines.len() && x < width {
            let text = &self.buf.lines[l];
            let cx = display_col(text, gc, tab);
            x += self.paint_text(p, Some(l), text, self.hl.line(l), width - x, cx + self.left.saturating_sub(col), line_bg, bg_at, tab, None, curly, None).0;
        }
        x
    }

    fn render_status(&mut self, p: &mut Painter) {
        let Pos { line, col } = self.head();
        let (s, e) = self.range();
        let selected = if self.empty() { 0 } else { selected_chars(&self.buf.text(s, e)) };
        let mut parts: Vec<(String, Option<StatusAct>)> = vec![
            (format!("Ln {}, Col {}{}", line + 1, visible_column(&self.buf.lines[line], col, self.tab()) + 1, if selected > 0 { format!(" ({selected} selected)") } else { String::new() }), Some(StatusAct::Goto)),
            (if self.indent.use_tabs { format!("Tab Size: {}", self.tab()) } else { format!("Spaces: {}", self.tab()) }, Some(StatusAct::Indent)),
            ((if self.doc.bom { "UTF-8 with BOM" } else { "UTF-8" }).into(), None),
            ((if self.doc.crlf { "CRLF" } else { "LF" }).into(), Some(StatusAct::Eol)),
            (self.language.clone(), Some(StatusAct::Language)),
        ];
        if self.settings.auto_save != crate::settings::AutoSave::Off {
            parts.insert(0, ("Auto Save".into(), None));
        }
        if let Some(text) = self.inline_status() {
            parts.push((text, Some(StatusAct::Inline)));
        }
        let right = parts.iter().map(|p| p.0.as_str()).collect::<Vec<_>>().join("   ") + "  ";
        let (mut left_text, mut left_color) = (String::new(), self.c.bar_fg.clone());
        if let Some(m) = self.message.as_ref().filter(|m| m.until > Instant::now()) {
            (left_text, left_color) = (m.text.clone(), m.color.clone());
        } else {
            self.message = None;
        }
        if left_text.is_empty() {
            // the problem at the cursor, else the file's problem counts
            if let Some(d) = self.problems_at(self.head()).into_iter().next() {
                left_text = format!("{}{}", d.message.split('\n').next().unwrap_or(""), if d.source.is_empty() { String::new() } else { format!("  {}", d.source) });
                left_color = self.c.diag[d.severity as usize].clone();
            } else {
                let ps = self.problems();
                if !ps.is_empty() {
                    let n = |sev: u8| ps.iter().filter(|p| p.severity == sev).count();
                    left_text = format!("⊗ {}  ⚠ {}{}", n(1), n(2), if n(3) > 0 { format!("  ℹ {}", n(3)) } else { String::new() });
                }
            }
        }
        let offer = if left_text.is_empty() { self.install_offer() } else { None };
        if let Some(h) = &offer {
            left_text = format!("Install {} ({})?", h.label, h.command);
        }
        if self.prompt.is_some() && !self.find.query.is_empty() {
            let n = self.matches().len();
            let k = self.current_match();
            left_text = if n > 0 { format!("Find: {} of {n}{}", k.map_or("?".into(), |k| (k + 1).to_string()), if n >= 20000 { "+" } else { "" }) } else { "Find: No results".into() };
            left_color = if n > 0 { self.c.bar_fg.clone() } else { self.c.warn.clone() };
        }
        let rw = tw(&right);
        p.move_to(self.rows, 1);
        p.text(&fit(&format!("  {left_text}"), (self.cols - rw).max(0) as usize), &left_color, &self.c.bar);
        self.status_hits.clear();
        if offer.is_some() && self.prompt.is_none() {
            self.status_hits.push((3, tw(&left_text).min((self.cols - rw - 2).max(0)), StatusAct::Install));
        }
        if rw > self.cols {
            return;
        }
        p.text(&right, &self.c.bar_fg, &self.c.bar);
        let mut x = self.cols - rw + 1;
        for (text, act) in parts {
            let w = tw(&text);
            if let Some(a) = act {
                self.status_hits.push((x, w, a));
            }
            x += w + 3;
        }
    }

    /// The find widget, top right like VS Code's; returns where the terminal cursor sits in it.
    fn render_prompt(&mut self, p: &mut Painter) -> Option<(i32, i32)> {
        let replace = self.prompt.as_ref()?.replace;
        let w = self.cols.min(60);
        let x = self.cols - w + 1;
        let compact = w < 40;
        let fw = w - 3 - if compact { 0 } else { 28 };
        self.find_box = Some((x, 2, w, if replace { 2 } else { 1 }));
        let mut hits: Vec<(i32, i32, i32, FindAct)> = vec![];
        let mut cursor = None;
        let (mut row, mut col) = (2, x);
        let c = &self.c;
        let mut cells = |p: &mut Painter, row: i32, col: &mut i32, text: &str, fg: &str, bg: &str, act: Option<FindAct>| {
            let n = tw(text);
            if let Some(a) = act {
                hits.push((*col, row, n, a));
            }
            p.text(text, fg, bg);
            *col += n;
        };
        let field = |name: Field, value: &str, placeholder: &str, row: i32, col: i32| -> (String, Option<(i32, i32)>) {
            let shown = if tw(value) > fw - 1 {
                let tail: Vec<char> = value.chars().collect();
                format!("…{}", tail[tail.len().saturating_sub((fw - 2).max(0) as usize)..].iter().collect::<String>())
            } else {
                value.to_string()
            };
            let cur = (self.find.field == name).then(|| (row, col + 1 + (fw - 2).min(tw(&shown))));
            (fit(&format!(" {}", if shown.is_empty() { placeholder } else { &shown }), fw.max(0) as usize), cur)
        };
        p.move_to(row, col);
        cells(p, row, &mut col, if replace { " ▾" } else { " ▸" }, &c.bar_fg, &c.widget, Some(FindAct::ToggleReplace));
        let (q, cur) = field(Field::Query, &self.find.query, "Find", row, col);
        cursor = cursor.or(cur);
        let selected = self.find.fresh && self.find.field == Field::Query && !self.find.query.is_empty(); // typing replaces it
        cells(p, row, &mut col, &q, if self.find.query.is_empty() { &c.line_number } else { &c.fg }, if selected { &c.selection } else { &c.input }, Some(FindAct::Field(Field::Query)));
        if !compact {
            let n = self.find.matches.len();
            let count = if self.find.query.is_empty() {
                String::new()
            } else if n > 0 {
                let k = self.current_match_cached();
                format!("{} of {n}{}", k.map_or("?".into(), |k| (k + 1).to_string()), if n >= 20000 { "+" } else { "" })
            } else {
                "No results".into()
            };
            let o = self.find.opts;
            for (label, on, opt) in [("Aa", o.case, FindOption::Case), ("ab", o.word, FindOption::Word), (".*", o.regex, FindOption::Regex)] {
                cells(p, row, &mut col, " ", &c.fg, &c.widget, None);
                cells(p, row, &mut col, label, if on { &c.toggle_fg } else { &c.bar_fg }, if on { &c.toggle_on } else { &c.widget }, Some(FindAct::Toggle(opt)));
            }
            cells(p, row, &mut col, " ", &c.fg, &c.widget, None);
            let on = self.find.scope.is_some();
            cells(p, row, &mut col, "≡", if on { &c.toggle_fg } else { &c.bar_fg }, if on { &c.toggle_on } else { &c.widget }, Some(FindAct::InSelection));
            cells(p, row, &mut col, " ", &c.fg, &c.widget, None);
            cells(p, row, &mut col, &fit(&count, 10), if !self.find.query.is_empty() && n == 0 { &c.error } else { &c.fg }, &c.widget, None);
            cells(p, row, &mut col, " ↑", &c.bar_fg, &c.widget, Some(FindAct::Prev));
            cells(p, row, &mut col, " ↓", &c.bar_fg, &c.widget, Some(FindAct::Next));
            cells(p, row, &mut col, " ×", &c.bar_fg, &c.widget, Some(FindAct::Close));
        }
        cells(p, row, &mut col, " ", &c.fg, &c.widget, None);
        if replace {
            row = 3;
            col = x;
            p.move_to(row, col);
            cells(p, row, &mut col, "  ", &c.fg, &c.widget, None);
            let (r, cur) = field(Field::Replace, &self.find.replace, "Replace", row, col);
            cursor = cursor.or(cur);
            cells(p, row, &mut col, &r, if self.find.replace.is_empty() { &c.line_number } else { &c.fg }, &c.input, Some(FindAct::Field(Field::Replace)));
            if !compact {
                cells(p, row, &mut col, " ", &c.fg, &c.widget, None);
                cells(p, row, &mut col, " Replace ", &c.fg, &c.widget, Some(FindAct::ReplaceOne));
                cells(p, row, &mut col, " ", &c.fg, &c.widget, None);
                cells(p, row, &mut col, " All ", &c.fg, &c.widget, Some(FindAct::ReplaceAll));
                cells(p, row, &mut col, &" ".repeat((w - 2 - fw - 16).max(0) as usize), &c.fg, &c.widget, None);
            } else {
                cells(p, row, &mut col, " ", &c.fg, &c.widget, None);
            }
        }
        self.find_hits = hits;
        cursor
    }

    fn current_match_cached(&self) -> Option<usize> {
        let (s, e) = self.range();
        self.find.matches.iter().position(|m| m.0 == s.line && m.1 == s.col && e.line == s.line && e.col == m.1 + m.2)
    }

    // ----- the mouse -----

    /// A buttonless motion: the changed bar alone, "" when nothing changed, None for a whole frame (or not a hover).
    pub fn hover(&mut self, ev: &Ev) -> Option<String> {
        if self.popup.is_some() {
            return None;
        }
        let Ev::Mouse(m) = ev else { return None };
        if !m.motion || m.button != 3 {
            return None;
        }
        if m.y == self.rows && self.status_hits.iter().any(|h| matches!(h.2, StatusAct::Inline) && m.x >= h.0 && m.x < h.0 + h.1) {
            // the inline suggestion item: today's usage
            let text = self.inline_usage();
            if self.message.as_ref().is_none_or(|msg| msg.text != text) {
                self.say(text, None, 6000);
                return None;
            }
        }
        let over = m.x <= self.gutter() as i32 && m.y >= 2 && m.y <= self.height() as i32 + 1;
        let mut frame = self.mouse_hover(m);
        if over != self.gutter_hover {
            self.gutter_hover = over;
            frame = true;
        }
        let mut out = String::new();
        if self.vbar.hovering(m) {
            out += &self.vbar.repaint(&self.c, self.marks.as_deref());
        }
        if self.hbar.hovering(m) {
            out += &self.hbar.repaint(&self.c, None);
        }
        if frame || (!out.is_empty() && (self.prompt.is_some() || self.ls.peek.is_some())) {
            return None;
        }
        Some(out)
    }

    /// Terminal cell -> buffer position (rows: 1 breadcrumbs, 2.. text); a lens row gives its line's start, a ghost text
    /// row its line, a row past the end the last line.
    pub fn cell_to_pos(&mut self, x: i32, y: i32) -> Pos {
        let max = self.view_count() as i64 - 1;
        let row = if y >= 2 && y <= self.height() as i32 + 1 { self.layout_rows(y as usize - 1).get(y as usize - 2).copied() } else { None };
        let line = match row {
            Some(Row { line: Some(l), lens: true, .. }) => return pos(l, 0),
            Some(Row { line: Some(l), .. }) => l,
            Some(Row { line: None, .. }) => self.line_at_row(max.max(0) as usize),
            None => {
                let v = (self.row_of(self.top) as i64 + y as i64 - 2).clamp(0, max.max(0)) as usize;
                self.line_at_row(v)
            }
        };
        let col = (self.left as i64 + x as i64 - 1 - self.gutter() as i64).max(0) as usize;
        pos(line, index_at_col(&self.buf.lines[line], col, self.tab()))
    }

    /// How far past the text area a drag pointer is.
    fn drag_overflow(&self, x: i32, y: i32) -> (i32, i32) {
        let gw = self.gutter() as i32;
        let right = gw + self.text_width() as i32;
        let h = self.height() as i32;
        let dx = if x <= gw { x - gw - 1 } else if x >= right { x - right + 1 } else { 0 };
        let dy = if y < 2 { y - 2 } else if y > h + 1 { y - h - 1 } else { 0 };
        (dx, dy)
    }

    /// Extends the dragged selection to the pointer; past an edge, first scrolls toward it. True while outside.
    pub fn drag_step(&mut self) -> bool {
        let Some((x, y)) = self.drag else { return false };
        let (dx, dy) = self.drag_overflow(x, y);
        if dy != 0 {
            self.top = self.scrolled(dy as i64, None);
        }
        if dx != 0 {
            let h = self.height();
            let widest = self.widest(self.top, h);
            let max = self.left.max((widest + 5).saturating_sub(self.text_width()));
            self.left = (self.left as i64 + dx as i64 * 2).clamp(0, max as i64) as usize;
        }
        let gw = self.gutter() as i32;
        let px = x.clamp(gw + 1, gw + self.text_width() as i32);
        let py = y.clamp(2, self.height() as i32 + 1);
        let p = self.cell_to_pos(px, py);
        self.sel = Sel { anchor: self.sel.anchor, head: p };
        dx != 0 || dy != 0
    }

    /// Presses, drags and wheels on the scrollbars; true when the event was theirs.
    fn bar_mouse(&mut self, m: &Mouse) -> bool {
        if self.dragging {
            return false;
        }
        if m.wheel() && self.hbar.contains(m) {
            self.left = (self.left as i64 + if m.button == 64 { -6 } else { 6 }).max(0) as usize;
            return true;
        }
        let peek = self.ls.peek.is_some() && m.y >= self.ls.peek_row && m.y < self.ls.peek_row + crate::overlays::Peek::HEIGHT;
        let covered = peek || self.prompt.as_ref().is_some_and(|pr| m.y < if pr.replace { 4 } else { 3 } && m.x >= self.find_box.map_or(self.cols - 47, |b| b.0));
        if !(covered && self.vbar.drag.is_none()) {
            match self.vbar.mouse(m) {
                BarMouse::No => {}
                BarMouse::Took => return true,
                BarMouse::To(v) => {
                    self.top = self.line_at_row(v.max(0) as usize);
                    return true;
                }
            }
        }
        if !(covered && self.hbar.drag.is_none()) {
            match self.hbar.mouse(m) {
                BarMouse::No => {}
                BarMouse::Took => return true,
                BarMouse::To(v) => {
                    self.left = v.max(0) as usize;
                    return true;
                }
            }
        }
        false
    }

    /// Clicks on the find widget; true when the event was over it.
    fn find_mouse(&mut self, m: &Mouse) -> bool {
        let Some((bx, by, bw, bh)) = self.find_box.filter(|_| self.prompt.is_some()) else { return false };
        if self.dragging || self.vbar.drag.is_some() || self.hbar.drag.is_some() {
            return false;
        }
        if m.x < bx || m.x >= bx + bw || m.y < by || m.y >= by + bh {
            return false;
        }
        if m.press() {
            if let Some(&(_, _, _, a)) = self.find_hits.iter().find(|h| m.y == h.1 && m.x >= h.0 && m.x < h.0 + h.2) {
                self.find_act(a);
            }
        }
        true
    }

    pub fn mouse(&mut self, m: &Mouse, term: &mut Term) {
        if self.popup.is_some() {
            return self.popup_event(&Ev::Mouse(*m), Some(term));
        }
        if self.ls.hover_box.is_some() && !m.motion && !m.release {
            self.ls.hover_box = None; // a click or the wheel closes the hover
        }
        if self.find_mouse(m) || self.bar_mouse(m) {
            return;
        }
        if let Some(pn) = self.ls.panel.as_mut() {
            match pn.mouse(m, self.rows) {
                crate::overlays::PanelOutcome::No => {}
                crate::overlays::PanelOutcome::Open(l) => {
                    self.jump_to(&l);
                    if let Some(pn) = self.ls.panel.as_mut() {
                        pn.focused = true;
                    }
                    return;
                }
                _ => return,
            }
        }
        if m.wheel() && !m.shift {
            self.top = self.scrolled(if m.button == 64 { -3 } else { 3 }, None);
            return;
        }
        if m.wheel() || m.button == 66 || m.button == 67 {
            let left = m.button == 66 || m.button == 64;
            self.left = (self.left as i64 + if left { -6 } else { 6 }).max(0) as usize;
            return;
        }
        if m.release {
            self.dragging = false;
            self.drag_next = None;
            return;
        }
        if m.motion && self.dragging && m.button == 0 {
            self.drag = Some((m.x, m.y));
            if !self.drag_step() {
                self.drag_next = None;
            } else if self.drag_next.is_none() {
                self.drag_next = Some(Instant::now() + Duration::from_millis(40));
            }
            return;
        }
        if m.y == self.rows {
            if m.press() {
                if let Some(&(_, _, a)) = self.status_hits.iter().find(|h| m.x >= h.0 && m.x < h.0 + h.1) {
                    match a {
                        StatusAct::Install => self.install_server(),
                        StatusAct::Goto => self.run_act(crate::commands::Act::GotoLine, None),
                        StatusAct::Indent => self.pick_indent(),
                        StatusAct::Eol => self.pick_eol(),
                        StatusAct::Language => self.pick_language(),
                        StatusAct::Inline => self.toggle_inline(),
                    }
                }
            }
            return;
        }
        if m.y == 1 {
            if m.press() && self.settings.breadcrumbs {
                self.run_act(crate::commands::Act::GotoSymbol, None);
            }
            return;
        }
        if m.y < 2 || m.y > self.height() as i32 + 1 {
            return;
        }
        if let Some(line) = self.lens_row_at(m.y) {
            if m.press() && !self.dragging {
                self.ls.peek = None;
                self.click_lens(line, m.x);
            }
            return;
        }
        let p = self.cell_to_pos(m.x, m.y);
        if m.button == 2 && !m.motion {
            let (s, e) = self.range();
            if self.empty() || p < s || p > e {
                self.move_to(p, false);
            }
            return self.open_menu(m.x, m.y);
        }
        if m.button != 0 {
            return;
        }
        if let Some(pn) = self.ls.panel.as_mut() {
            pn.focused = false;
        }
        if self.ls.peek.is_some() && !m.motion {
            if m.y >= self.ls.peek_row && m.y < self.ls.peek_row + crate::overlays::Peek::HEIGHT {
                return;
            }
            self.ls.peek = None;
        }
        if m.motion {
            return;
        }
        if m.x == self.gutter() as i32 && self.click_fold(p.line) {
            return;
        }
        if m.ctrl && !m.shift && m.x > self.gutter() as i32 {
            // VS Code's ⌘-click / Ctrl+click: Go to Definition
            self.ls.link = None;
            self.move_to(p, false);
            return self.run_act(crate::commands::Act::GoTo("definition"), None);
        }
        let now = Instant::now();
        let double = now.duration_since(self.last_click.0) < Duration::from_millis(400) && self.last_click.1 == p;
        self.last_click = (now, p);
        self.dragging = true;
        if double && !m.shift {
            let t = &self.buf.lines[p.line];
            let s = word_left(t, next_index(t, p.col).min(t.len()));
            let e = word_right(t, s);
            self.sel = Sel { anchor: pos(p.line, s), head: pos(p.line, e) };
            self.buf.seal();
            return;
        }
        self.move_to(p, m.shift);
    }
}

// ----- CodeLens rows -----
impl Editor {
    fn has_lens(&self, line: usize) -> bool {
        self.lens_items().iter().any(|l| l.at.line == line)
    }
    /// Text rows from the top line to `line`'s row: view rows plus the lens rows above the lines in between (and
    /// `line`).
    pub fn rows_to(&mut self, line: usize) -> i64 {
        let mut n = self.row_of(line) as i64 - self.row_of(self.top) as i64;
        if n >= 0 {
            let mut lines: Vec<usize> = self.lens_items().iter().map(|l| l.at.line).filter(|&l| l >= self.top && l <= line).collect();
            lines.dedup();
            n += lines.into_iter().filter(|&l| !self.folds.is_hidden(l)).count() as i64;
            if let Some(g) = self.ghost_view().filter(|g| g.0 >= self.top && g.0 < line) {
                n += g.2.len() as i64 - 1; // a multi-line ghost text's rows below its line
            }
        }
        n
    }
    /// The first `count` text rows from the top line.
    pub fn layout_rows(&mut self, count: usize) -> Vec<Row> {
        let ghost = self.ghost_view().map(|g| (g.0, g.2.len()));
        let mut rows = Vec::with_capacity(count);
        let mut l = self.top;
        let row = |line, lens, ghost| Row { line, lens, ghost };
        while rows.len() < count {
            if l >= self.buf.lines.len() {
                rows.push(row(None, false, 0));
                continue;
            }
            if self.has_lens(l) {
                rows.push(row(Some(l), true, 0));
            }
            if rows.len() < count {
                rows.push(row(Some(l), false, 0));
            }
            if let Some((_, n)) = ghost.filter(|g| g.0 == l) {
                for k in 1..n {
                    if rows.len() < count {
                        rows.push(row(Some(l), false, k));
                    }
                }
            }
            l = self.folds.next(l);
        }
        rows
    }
    /// The line whose lens row is at screen row y.
    pub fn lens_row_at(&mut self, y: i32) -> Option<usize> {
        if y < 2 || y > self.height() as i32 + 1 || self.lens_items().is_empty() {
            return None;
        }
        self.layout_rows(y as usize - 1).get(y as usize - 2).filter(|r| r.lens).and_then(|r| r.line)
    }
    /// A lens row's text: the titles joined by " | " from the line's indentation, and each lens's display columns.
    fn lens_text(&self, line: usize) -> (String, Vec<(usize, usize, crate::editor::LensItem)>) {
        let t = &self.buf.lines[line];
        let indent = display_col(t, t.len() - t.trim_start().len(), self.tab());
        let mut text = " ".repeat(indent);
        let mut parts = vec![];
        for it in self.lens_items().iter().filter(|l| l.at.line == line) {
            if !parts.is_empty() {
                text += " | ";
            }
            let from = text_width(&text, self.tab());
            text += &it.title;
            parts.push((from, text_width(&text, self.tab()), it.clone()));
        }
        (text, parts)
    }
    fn paint_lens(&self, p: &mut Painter, line: usize) {
        let (text, _) = self.lens_text(line);
        p.text(&" ".repeat(self.gutter()), &self.c.fg, &self.c.bg);
        let shown: String = text.chars().skip(self.left).collect();
        p.text(&fit(&shown, self.text_width()), &self.c.code_lens, &self.c.bg);
    }
    /// A click on a lens row: that lens's peek.
    fn click_lens(&mut self, line: usize, x: i32) {
        let col = (self.left as i64 + x as i64 - 1 - self.gutter() as i64).max(0) as usize;
        if let Some((_, _, it)) = self.lens_text(line).1.into_iter().find(|(a, b, _)| col >= *a && col < *b) {
            self.run_lens(&it);
        }
    }
}
