//! Folding (folding.cjs): VS Code's indentation strategy with #region markers (pure), and `Folds`, a buffer's
//! collapsed folds with the line <-> view row mapping that skips their hidden lines.

use crate::buffer::Change;
use crate::decorations::lead_cols;

pub const MAX_RANGES: usize = 5000;
const OFF_SIDE: &[&str] = &["source.python", "source.yaml", "source.coffee", "text.pug", "source.sass", "source.fsharp", "source.nim"];

pub fn off_side(scope: Option<&str>) -> bool {
    scope.is_some_and(|s| OFF_SIDE.contains(&s))
}

/// Some(true) for an end marker, Some(false) for a start marker: `// #region`, `#region`, `# region`,
/// `/* #region */`, `<!-- #region -->`, `--#region` and their `endregion`s.
pub fn marker(text: &str) -> Option<bool> {
    let t = text.trim_start();
    let rest = if let Some(r) = ["//", "--", "/*", "<!--"].iter().find_map(|p| t.strip_prefix(p)) {
        let r = r.trim_start();
        r.strip_prefix('#').unwrap_or(r)
    } else {
        t.strip_prefix('#')?.trim_start()
    };
    let (end, rest) = match rest.strip_prefix("end") {
        Some(r) => (true, r),
        None => (false, rest),
    };
    let after = rest.strip_prefix("region")?;
    (!after.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_')).then_some(end)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

/// Foldable ranges sorted by start: `start` stays visible, start+1..=end fold away.
pub fn fold_ranges(lines: &[String], tab: usize, side: bool) -> Vec<Range> {
    struct Frame {
        indent: i64,
        end_above: usize,
        line: usize,
    }
    let n = lines.len();
    let mut out = vec![];
    let mut stack = vec![Frame { indent: -1, end_above: n, line: n }];
    for l in (0..n).rev() {
        let text = &lines[l];
        let indent = lead_cols(text, tab).map_or(-1, |c| c as i64);
        if indent == -1 {
            if side {
                stack.last_mut().unwrap().end_above = l;
            }
            continue;
        }
        let m = if text.len() < 1000 { marker(text) } else { None };
        if m == Some(true) {
            stack.push(Frame { indent: -2, end_above: l, line: l });
            continue;
        }
        if m == Some(false) {
            let mut i = stack.len() - 1;
            while i > 0 && stack[i].indent != -2 {
                i -= 1;
            }
            if i > 0 {
                stack.truncate(i + 1);
                let prev = stack.last_mut().unwrap();
                out.push(Range { start: l, end: prev.line });
                (prev.line, prev.indent, prev.end_above) = (l, indent, l);
                continue;
            }
        }
        if stack.last().unwrap().indent > indent {
            while stack.last().unwrap().indent > indent {
                stack.pop();
            }
            let prev = stack.last().unwrap();
            if prev.end_above >= l + 2 {
                out.push(Range { start: l, end: prev.end_above - 1 });
            }
        }
        let prev = stack.last_mut().unwrap();
        if prev.indent == indent {
            prev.end_above = l;
        } else {
            stack.push(Frame { indent, end_above: l, line: l });
        }
    }
    out.reverse();
    if out.len() > MAX_RANGES {
        outermost(&out, MAX_RANGES)
    } else {
        out
    }
}

fn outermost(ranges: &[Range], max: usize) -> Vec<Range> {
    let mut ends: Vec<usize> = vec![];
    let level: Vec<usize> = ranges
        .iter()
        .map(|r| {
            while ends.last().is_some_and(|e| *e < r.start) {
                ends.pop();
            }
            ends.push(r.end);
            ends.len()
        })
        .collect();
    let mut idx: Vec<usize> = (0..ranges.len()).collect();
    idx.sort_by_key(|&i| (level[i], i));
    idx.truncate(max);
    idx.sort_unstable();
    idx.into_iter().map(|i| ranges[i]).collect()
}

/// The innermost range holding `line` that `ok` accepts.
pub fn innermost(ranges: &[Range], line: usize, ok: impl Fn(&Range) -> bool) -> Option<Range> {
    let mut best = None;
    for r in ranges {
        if r.start > line {
            break;
        }
        if line <= r.end && ok(r) {
            best = Some(*r);
        }
    }
    best
}

/// The range headed by `line`.
pub fn range_at(ranges: &[Range], line: usize) -> Option<Range> {
    ranges.binary_search_by_key(&line, |r| r.start).ok().map(|i| ranges[i])
}

struct Spans {
    a: Vec<usize>,
    b: Vec<usize>,
    before: Vec<usize>,
    total: usize,
}

/// A buffer's collapsed folds (by start; nested ones allowed); view row v shows line line_at_row(v).
#[derive(Default)]
pub struct Folds {
    pub list: Vec<Range>,
    spans: Option<Spans>,
    pub version: u64,
}

impl Folds {
    pub fn any(&self) -> bool {
        !self.list.is_empty()
    }
    fn changed(&mut self) {
        self.spans = None;
        self.version += 1;
    }
    pub fn has(&self, line: usize) -> bool {
        range_at(&self.list, line).is_some()
    }
    pub fn collapse(&mut self, ranges: &[Range]) -> bool {
        let add: Vec<Range> = ranges.iter().filter(|r| r.end > r.start && !self.has(r.start)).copied().collect();
        if add.is_empty() {
            return false;
        }
        self.list.extend(add);
        self.list.sort_by_key(|r| r.start);
        self.list.dedup_by_key(|r| r.start);
        self.changed();
        true
    }
    pub fn expand(&mut self, line: usize) -> bool {
        let n = self.list.len();
        self.list.retain(|f| f.start != line);
        if n == self.list.len() {
            return false;
        }
        self.changed();
        true
    }
    pub fn clear(&mut self) -> bool {
        if !self.any() {
            return false;
        }
        self.list.clear();
        self.changed();
        true
    }
    /// Unfolds every fold hiding `line`.
    pub fn reveal(&mut self, line: usize) -> bool {
        if !self.any() || !self.is_hidden(line) {
            return false;
        }
        self.list.retain(|f| !(f.start < line && line <= f.end));
        self.changed();
        true
    }
    /// Follows recomputed ranges: a fold takes the end of the range its header still heads, and goes when none does.
    pub fn sync(&mut self, ranges: &[Range]) -> bool {
        if !self.any() {
            return false;
        }
        let next: Vec<Range> = self.list.iter().filter_map(|f| range_at(ranges, f.start)).collect();
        if next == self.list {
            return false;
        }
        self.list = next;
        self.changed();
        true
    }
    /// Folds below an edit shift, folds above stay, an edit of a header's line alone keeps it, anything reaching into
    /// hidden lines unfolds them.
    pub fn edited(&mut self, c: Change) {
        if !self.any() {
            return;
        }
        let (s, last) = (c.start as i64, c.start as i64 + c.removed as i64 - 1);
        let delta = c.inserted as i64 - c.removed as i64;
        self.list = self
            .list
            .iter()
            .filter_map(|f| {
                let (fs, fe) = (f.start as i64, f.end as i64);
                if s > fe {
                    Some(*f)
                } else if last < fs {
                    Some(Range { start: (fs + delta) as usize, end: (fe + delta) as usize })
                } else if s == fs && c.removed == 1 && c.inserted == 1 {
                    Some(*f)
                } else {
                    None
                }
            })
            .collect();
        self.changed();
    }
    fn hidden(&mut self) -> &Spans {
        if self.spans.is_none() {
            let mut sp = Spans { a: vec![], b: vec![], before: vec![], total: 0 };
            for f in &self.list {
                let (s, e) = (f.start + 1, f.end);
                if let Some(last) = sp.b.last_mut() {
                    if s <= *last + 1 {
                        if e > *last {
                            sp.total += e - *last;
                            *last = e;
                        }
                        continue;
                    }
                }
                sp.a.push(s);
                sp.b.push(e);
                sp.before.push(sp.total);
                sp.total += e - s + 1;
            }
            self.spans = Some(sp);
        }
        self.spans.as_ref().unwrap()
    }
    fn span_before(&mut self, line: usize) -> Option<usize> {
        self.hidden().a.partition_point(|a| *a <= line).checked_sub(1)
    }
    pub fn is_hidden(&mut self, line: usize) -> bool {
        self.any() && self.span_before(line).is_some_and(|k| line <= self.hidden().b[k])
    }
    /// The visible line a hidden line folds into; a visible line itself.
    pub fn visible(&mut self, line: usize) -> usize {
        if !self.any() {
            return line;
        }
        match self.span_before(line) {
            Some(k) if line <= self.hidden().b[k] => self.hidden().a[k] - 1,
            _ => line,
        }
    }
    pub fn row_of(&mut self, line: usize) -> usize {
        if !self.any() {
            return line;
        }
        let line = self.visible(line);
        match self.span_before(line) {
            None => line,
            Some(k) => {
                let h = self.hidden();
                line - h.before[k] - (h.b[k] - h.a[k] + 1)
            }
        }
    }
    pub fn line_at_row(&mut self, v: usize) -> usize {
        if !self.any() {
            return v;
        }
        let h = self.hidden();
        let (mut lo, mut hi) = (0, h.a.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if h.a[mid] - h.before[mid] <= v {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        match lo.checked_sub(1) {
            None => v,
            Some(k) => v + h.before[k] + (h.b[k] - h.a[k] + 1),
        }
    }
    /// The visible line after `line`.
    pub fn next(&mut self, line: usize) -> usize {
        if !self.any() {
            return line + 1;
        }
        match self.span_before(line + 1) {
            Some(k) if line < self.hidden().b[k] => self.hidden().b[k] + 1,
            _ => line + 1,
        }
    }
    pub fn view_count(&mut self, lines: usize) -> usize {
        lines - if self.any() { self.hidden().total } else { 0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn r(start: usize, end: usize) -> Range {
        Range { start, end }
    }

    #[test]
    fn indentation_ranges_end_before_the_next_line_as_shallow() {
        let l = lines(&["function a() {", "  if (x) {", "    one();", "", "  }", "}", "const z = 1;"]);
        assert_eq!(fold_ranges(&l, 4, false), vec![r(0, 4), r(1, 3)]);
    }

    #[test]
    fn off_side_languages_leave_trailing_blank_lines_out() {
        let l = lines(&["def a():", "    pass", "", "x = 1"]);
        assert_eq!(fold_ranges(&l, 4, true), vec![r(0, 1)]);
        assert_eq!(fold_ranges(&l, 4, false), vec![r(0, 2)]);
    }

    #[test]
    fn region_markers_fold_through_the_end_marker() {
        let l = lines(&["// #region setup", "a", "// #endregion", "b"]);
        assert_eq!(fold_ranges(&l, 4, false), vec![r(0, 2)]);
        assert_eq!(marker("  <!-- #region x -->"), Some(false));
        assert_eq!(marker("# endregion"), Some(true));
        assert_eq!(marker("// regions"), None);
    }

    #[test]
    fn collapsed_folds_map_lines_to_view_rows() {
        let mut f = Folds::default();
        assert!(f.collapse(&[r(1, 3), r(5, 6)]));
        assert_eq!((f.row_of(0), f.row_of(4), f.row_of(5), f.row_of(7)), (0, 2, 3, 4));
        assert_eq!((f.line_at_row(2), f.line_at_row(4)), (4, 7));
        assert_eq!((f.next(1), f.next(5), f.view_count(8)), (4, 7, 5));
        assert!(f.is_hidden(2) && !f.is_hidden(4));
        assert_eq!(f.visible(3), 1);
    }

    #[test]
    fn edits_shift_keep_or_open_folds() {
        let mut f = Folds::default();
        f.collapse(&[r(2, 4)]);
        f.edited(Change { start: 0, removed: 1, inserted: 2 });
        assert_eq!(f.list, vec![r(3, 5)]);
        f.edited(Change { start: 3, removed: 1, inserted: 1 });
        assert_eq!(f.list, vec![r(3, 5)]);
        f.edited(Change { start: 4, removed: 1, inserted: 1 });
        assert!(f.list.is_empty());
    }
}
