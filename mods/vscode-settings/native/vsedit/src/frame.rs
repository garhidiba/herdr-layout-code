//! The screen model for a client that draws the editor itself (serve.rs, for the native mod): the lines shown with
//! their colored runs, decorations and gutter marks; the caret, the selection, the status bar, the find widget's state
//! and the overview ruler. What view.rs paints, as data. Columns are the core's: UTF-8 byte offsets in a line.

use crate::buffer::Pos;
use crate::editor::{visible_column, Editor, Field, Popup};
use crate::folding;
use crate::gitgutter::{self, Kind, Mark};
use crate::width::next_index;
use serde_json::{json, Map, Value};

/// One screen: the lines shown (in order), each line's model, and the rest (keys of the `frame` message).
pub struct Screen {
    pub rows: Vec<usize>,
    pub lines: Vec<Value>,
    pub state: Map<String, Value>,
}

fn at(p: Pos) -> Value {
    json!({ "line": p.line, "col": p.col })
}

fn deco(from: usize, to: usize, kind: &str) -> Value {
    json!({ "from": from, "to": to, "kind": kind })
}

/// 1 error, 2 warning, 3 information, 4 hint (LSP's).
fn severity(s: u8) -> &'static str {
    ["error", "error", "warning", "info", "hint"].get(s as usize).copied().unwrap_or("hint")
}

impl Editor {
    /// The lines shown from `top` down, folded lines skipped, `height()` of them.
    fn shown_lines(&mut self) -> Vec<usize> {
        let n = self.buf.lines.len();
        let (h, mut l) = (self.height(), self.folds.visible(self.top.min(n - 1)));
        let mut out = vec![];
        while out.len() < h && l < n {
            out.push(l);
            l = self.folds.next(l);
        }
        out
    }

    pub fn screen(&mut self) -> Screen {
        if self.folds.any() {
            self.fold_ranges();
        }
        self.top = self.folds.visible(self.top.min(self.buf.lines.len() - 1));
        let rows = self.shown_lines();
        let (first, last) = (rows.first().copied().unwrap_or(0), rows.last().copied().unwrap_or(0));
        let finding = self.prompt.is_some() && !self.find.query.is_empty();
        let ms = if finding { self.matches().to_vec() } else { vec![] };
        let current = if self.prompt.is_some() { self.current_match().map(|i| self.find.matches[i]) } else { None };
        let brackets = self.bracket_pair();
        let hits = if finding { None } else { self.highlights(self.height()) };
        let hit_kind = if self.empty() { "word" } else { "selectionMatch" };
        self.git.start();
        let changes = gitgutter::marks_for(&self.git.hunks, first, last);
        let ranges = self.fold_ranges();
        if self.lang.outline.as_ref().is_none_or(|o| o.version != self.buf.version) {
            self.queue_outline();
        }
        let problems = self.problems();
        let bulb = self.light_bulb_line();
        let ghost = self.ghost_view();
        let scope = self.find.scope.filter(|_| self.prompt.is_some());

        let mut lines = Vec::with_capacity(rows.len());
        for &l in &rows {
            let text = &self.buf.lines[l];
            let tokens = self.hl.line(l).filter(|t| !t.is_empty());
            let (mut runs, mut ti, mut start, mut cur) = (vec![], 0, 0, None);
            for (i, _) in text.char_indices() {
                let st = self.style_at(Some(l), tokens, &mut ti, i);
                if cur != Some(st) {
                    if let Some((fg, style)) = cur {
                        runs.push(json!({ "text": &text[start..i], "fg": fg, "style": style }));
                    }
                    (start, cur) = (i, Some(st));
                }
            }
            if let Some((fg, style)) = cur {
                runs.push(json!({ "text": &text[start..], "fg": fg, "style": style }));
            }
            let mut decos = vec![];
            for m in ms.iter().filter(|m| m.0 == l) {
                decos.push(deco(m.1, m.1 + m.2, if current == Some(*m) { "findCurrent" } else { "find" }));
            }
            if let Some((s, e)) = scope.filter(|(s, e)| l >= s.line && l <= e.line) {
                decos.push(deco(if l == s.line { s.col } else { 0 }, if l == e.line { e.col } else { text.len() }, "findScope"));
            }
            for b in brackets.iter().filter(|b| b.line == l) {
                decos.push(deco(b.col, next_index(text, b.col), "bracket"));
            }
            if let Some(h) = &hits {
                for (k, m) in h.list.iter().enumerate().filter(|(_, m)| m.0 == l) {
                    decos.push(deco(m.1, m.1 + m.2, if h.writes.get(k) == Some(&true) { "wordWrite" } else { hit_kind }));
                }
            }
            let mut worst: Option<u8> = None;
            for d in &problems {
                if let Some((f, t)) = Editor::problem_span(d, l, text) {
                    decos.push(deco(f, t, severity(d.severity)));
                    worst = Some(worst.map_or(d.severity, |w| w.min(d.severity)));
                }
            }
            let git = changes.get(&l).map(|m| match m {
                Mark::Added => "added",
                Mark::Modified => "modified",
                Mark::DeletedBelow => "deletedBelow",
                Mark::DeletedAbove => "deletedAbove",
            });
            let fold = if self.folds.has(l) {
                Some("collapsed")
            } else {
                folding::range_at(&ranges, l).map(|_| "expanded")
            };
            let mut line = json!({
                "l": l,
                "runs": runs,
                "decos": decos,
                "gutter": { "git": git, "fold": fold, "diag": worst.map(severity), "bulb": bulb == Some(l) },
            });
            if let Some(g) = ghost.as_ref().filter(|g| g.0 == l) {
                line["ghost"] = json!({ "col": g.1, "lines": g.2 });
            }
            lines.push(line);
        }

        let mut state = Map::new();
        let head = self.head();
        state.insert("top".into(), json!(self.top));
        state.insert("caret".into(), at(head));
        state.insert("selections".into(), json!([{ "anchor": at(self.sel.anchor), "head": at(head) }]));
        let st = self.status();
        let items: Vec<Value> = st.parts.iter().map(|(text, act)| json!({ "text": text, "act": act.map(|a| format!("{a:?}")) })).collect();
        state.insert(
            "status".into(),
            json!({
                "ln": head.line + 1,
                "col": visible_column(&self.buf.lines[head.line], head.col, self.tab()) + 1,
                "dirty": self.buf.dirty(),
                "language": self.language,
                "wrap": self.word_wrap(),
                "left": st.left,
                "leftColor": st.left_color,
                "offer": st.offer,
                "items": items,
            }),
        );
        let find = self.prompt.as_ref().map(|p| p.replace).map(|replace| {
            json!({
                "query": self.find.query,
                "replace": self.find.replace,
                "replaceShown": replace,
                "field": if self.find.field == Field::Query { "query" } else { "replace" },
                "case": self.find.opts.case,
                "word": self.find.opts.word,
                "regex": self.find.opts.regex,
                "inSelection": self.find.scope.is_some(),
                "count": ms.len(),
                "current": self.current_match(),
                "error": self.find.error,
            })
        });
        state.insert("find".into(), find.unwrap_or(Value::Null));
        let popup = self.popup.as_ref().map(|p| match p {
            Popup::Dialog(_) => "dialog",
            Popup::Input(_) => "input",
            Popup::Picker(_) => "picker",
            Popup::Menu(_) => "menu",
        });
        state.insert("popup".into(), json!(popup));
        let mut hunks = vec![];
        for h in &self.git.hunks {
            let kind = match h.kind {
                Kind::Added => "added",
                Kind::Modified => "modified",
                Kind::Deleted => "deleted",
            };
            let a = gitgutter::line_of(h);
            hunks.push(json!([a, a.max(h.end.saturating_sub(1)), kind]));
        }
        let lines_of = |list: &[(usize, usize, usize)]| {
            let mut v: Vec<usize> = list.iter().map(|m| m.0).collect();
            v.dedup();
            v
        };
        state.insert(
            "ruler".into(),
            json!({
                "git": hunks,
                "find": lines_of(&ms),
                "word": hits.as_ref().map_or(vec![], |h| lines_of(&h.list)),
                "problems": problems.iter().map(|d| json!([d.start.line, severity(d.severity)])).collect::<Vec<_>>(),
            }),
        );
        Screen { rows, lines, state }
    }
}
