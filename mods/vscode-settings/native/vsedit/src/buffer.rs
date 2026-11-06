//! Text model (buffer.cjs): lines plus edits with undo/redo. Positions are (line, byte offset in the line).

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default, Hash)]
pub struct Pos {
    pub line: usize,
    pub col: usize,
}

pub const fn pos(line: usize, col: usize) -> Pos {
    Pos { line, col }
}

/// A selection; collapsed when anchor == head.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Sel {
    pub anchor: Pos,
    pub head: Pos,
}

pub fn caret(p: Pos) -> Sel {
    Sel { anchor: p, head: p }
}

impl Sel {
    pub fn range(&self) -> (Pos, Pos) {
        ordered(self.anchor, self.head)
    }
    pub fn is_empty(&self) -> bool {
        self.anchor == self.head
    }
}

pub fn ordered(a: Pos, b: Pos) -> (Pos, Pos) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Where `text` ends when inserted at `start`.
pub fn end_of(start: Pos, text: &str) -> Pos {
    match text.rfind('\n') {
        None => pos(start.line, start.col + text.len()),
        Some(k) => pos(start.line + text.matches('\n').count(), text.len() - k - 1),
    }
}

/// One edit: [start, end) replaced by text (\n line breaks).
pub struct Edit {
    pub start: Pos,
    pub end: Pos,
    pub text: String,
}

pub fn edit(start: Pos, end: Pos, text: impl Into<String>) -> Edit {
    Edit { start, end, text: text.into() }
}

pub fn insert_at(at: Pos, text: impl Into<String>) -> Edit {
    Edit { start: at, end: at, text: text.into() }
}

struct Record {
    start: Pos,
    old: String,
    new: String,
}

struct Step {
    records: Vec<Record>,
    before: Option<Sel>,
    after: Option<Sel>,
    typing: bool,
    sealed: bool,
}

/// Lines [start, start+removed) became `inserted` lines (what buffer.cjs's listeners get).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Change {
    pub start: usize,
    pub removed: usize,
    pub inserted: usize,
}

pub struct Buffer {
    pub lines: Vec<String>,
    undo: Vec<Step>,
    redo: Vec<Step>,
    pub version: u64,
    pub saved_version: Option<u64>,
    /// Line changes since the editor last took them (`take_changes`).
    changes: Vec<Change>,
}

impl Buffer {
    pub fn new(lines: Vec<String>) -> Buffer {
        let lines = if lines.is_empty() { vec![String::new()] } else { lines };
        Buffer { lines, undo: vec![], redo: vec![], version: 0, saved_version: Some(0), changes: vec![] }
    }

    pub fn dirty(&self) -> bool {
        self.saved_version != Some(self.version)
    }
    pub fn mark_saved(&mut self) {
        self.saved_version = Some(self.version);
    }
    pub fn take_changes(&mut self) -> Vec<Change> {
        std::mem::take(&mut self.changes)
    }

    /// A position inside the text on a character boundary.
    pub fn clamp(&self, p: Pos) -> Pos {
        let line = p.line.min(self.lines.len() - 1);
        let t = &self.lines[line];
        let mut col = p.col.min(t.len());
        while !t.is_char_boundary(col) {
            col -= 1;
        }
        pos(line, col)
    }

    pub fn text(&self, a: Pos, b: Pos) -> String {
        let (s, e) = ordered(self.clamp(a), self.clamp(b));
        if s.line == e.line {
            return self.lines[s.line][s.col..e.col].to_string();
        }
        let mut out = self.lines[s.line][s.col..].to_string();
        for l in s.line + 1..e.line {
            out.push('\n');
            out.push_str(&self.lines[l]);
        }
        out.push('\n');
        out.push_str(&self.lines[e.line][..e.col]);
        out
    }

    pub fn all_text(&self) -> String {
        self.lines.join("\n")
    }

    fn replace(&mut self, a: Pos, b: Pos, text: &str) -> Record {
        let (s, e) = ordered(self.clamp(a), self.clamp(b));
        let old = self.text(s, e);
        let head = &self.lines[s.line][..s.col];
        let tail = &self.lines[e.line][e.col..];
        let mut parts: Vec<String> = text.split('\n').map(str::to_string).collect();
        parts[0] = format!("{head}{}", parts[0]);
        let last = parts.len() - 1;
        parts[last].push_str(tail);
        let inserted = parts.len();
        self.lines.splice(s.line..=e.line, parts);
        self.version += 1;
        self.changes.push(Change { start: s.line, removed: e.line - s.line + 1, inserted });
        Record { start: s, old, new: text.to_string() }
    }

    /// Applies edits in order as one undo step; typing merges with the previous typing step when it continues where
    /// that one ended.
    pub fn edit(&mut self, edits: Vec<Edit>, before: Option<Sel>, after: Option<Sel>, typing: bool) {
        let records: Vec<Record> = edits.iter().map(|e| self.replace(e.start, e.end, &e.text)).collect();
        let r = &records[0];
        let merge = typing
            && records.len() == 1
            && r.old.is_empty()
            && !r.new.contains('\n')
            && self.undo.last().is_some_and(|last| {
                last.typing && !last.sealed && last.records.len() == 1 && end_of(last.records[0].start, &last.records[0].new) == r.start
            });
        if merge {
            let last = self.undo.last_mut().unwrap();
            last.records[0].new.push_str(&records[0].new);
            last.after = after;
        } else {
            self.undo.push(Step { records, before, after, typing, sealed: false });
        }
        self.redo.clear();
    }

    /// Ends the current typing group.
    pub fn seal(&mut self) {
        if let Some(last) = self.undo.last_mut() {
            last.sealed = true;
        }
    }

    pub fn undo(&mut self) -> Option<Sel> {
        let mut step = self.undo.pop()?;
        for r in step.records.iter().rev() {
            let end = end_of(r.start, &r.new);
            self.replace(r.start, end, &r.old.clone());
        }
        step.sealed = true;
        let sel = step.before.unwrap_or_else(|| caret(step.records[0].start));
        self.redo.push(step);
        Some(sel)
    }

    pub fn redo(&mut self) -> Option<Sel> {
        let step = self.redo.pop()?;
        for r in &step.records {
            let end = end_of(r.start, &r.old);
            self.replace(r.start, end, &r.new.clone());
        }
        let r = step.records.last().unwrap();
        let sel = step.after.unwrap_or_else(|| caret(end_of(r.start, &r.new)));
        self.undo.push(step);
        Some(sel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buf(text: &str) -> Buffer {
        Buffer::new(text.split('\n').map(str::to_string).collect())
    }

    #[test]
    fn an_edit_across_lines_joins_them_and_undo_restores_them() {
        let mut b = buf("one\ntwo\nthree");
        b.edit(vec![edit(pos(0, 1), pos(2, 2), "X")], None, None, false);
        assert_eq!(b.lines, ["oXree"]);
        assert!(b.dirty());
        b.undo();
        assert_eq!(b.all_text(), "one\ntwo\nthree");
        assert!(b.dirty(), "an undo is a change too, as in buffer.cjs");
        b.redo();
        assert_eq!(b.all_text(), "oXree");
    }

    #[test]
    fn typing_in_a_row_is_one_undo_step_until_sealed() {
        let mut b = buf("");
        for (i, ch) in ["a", "b", "c"].iter().enumerate() {
            b.edit(vec![insert_at(pos(0, i), *ch)], None, None, true);
        }
        b.seal();
        b.edit(vec![insert_at(pos(0, 3), "d")], None, None, true);
        b.undo();
        assert_eq!(b.lines, ["abc"]);
        b.undo();
        assert_eq!(b.lines, [""]);
    }

    #[test]
    fn changes_report_the_lines_each_edit_touched() {
        let mut b = buf("a\nb");
        b.edit(vec![insert_at(pos(0, 1), "\nx\ny")], None, None, false);
        assert_eq!(b.take_changes(), [Change { start: 0, removed: 1, inserted: 3 }]);
        assert!(b.take_changes().is_empty());
    }

    #[test]
    fn clamp_keeps_positions_on_character_boundaries() {
        let b = buf("한");
        assert_eq!(b.clamp(pos(5, 2)), pos(0, 0));
        assert_eq!(b.clamp(pos(0, 9)), pos(0, 3));
        assert_eq!(end_of(pos(1, 2), "ab\ncde"), pos(2, 3));
    }
}
