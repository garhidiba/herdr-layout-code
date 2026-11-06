//! Decorations from the text (decorations.cjs), computed for the visible lines: indent guides with the active one,
//! the matching bracket, word / selection occurrences. Pure functions over lines.

use crate::buffer::{pos, Pos};
use std::cell::RefCell;
use std::collections::HashMap;

const SCAN: usize = 1000;

/// Display columns of a line's leading whitespace, or None for a blank line.
pub fn lead_cols(text: &str, tab: usize) -> Option<usize> {
    let mut c = 0;
    for ch in text.chars() {
        match ch {
            ' ' => c += 1,
            '\t' => c += tab - c % tab,
            _ => return Some(c),
        }
    }
    None
}

/// level(l): how many guides line l has; a blank line takes VS Code's rule from the content lines around it.
pub struct Levels<'a> {
    lines: &'a [String],
    size: usize,
    tab: usize,
    memo: RefCell<HashMap<usize, Option<usize>>>,
}

impl<'a> Levels<'a> {
    pub fn new(lines: &'a [String], size: usize, tab: usize) -> Levels<'a> {
        Levels { lines, size, tab, memo: RefCell::new(HashMap::new()) }
    }
    fn content(&self, l: usize) -> Option<usize> {
        *self.memo.borrow_mut().entry(l).or_insert_with(|| lead_cols(&self.lines[l], self.tab).map(|c| c.div_ceil(self.size)))
    }
    fn near(&self, l: usize, up: bool) -> Option<usize> {
        let mut k = l;
        for _ in 0..SCAN {
            if up {
                k = k.checked_sub(1)?;
            } else {
                k += 1;
                if k >= self.lines.len() {
                    return None;
                }
            }
            if let Some(v) = self.content(k) {
                return Some(v);
            }
        }
        None
    }
    pub fn level(&self, l: usize) -> usize {
        if let Some(v) = self.content(l) {
            return v;
        }
        match (self.near(l, true), self.near(l, false)) {
            (Some(up), Some(down)) => match up.cmp(&down) {
                std::cmp::Ordering::Less => up + 1,
                std::cmp::Ordering::Equal => down,
                std::cmp::Ordering::Greater => down + 1,
            },
            _ => 0,
        }
    }
}

/// The active guide for the cursor on line c: (index, from, to).
pub fn active_guide(lv: &Levels, c: usize, n: usize) -> Option<(usize, usize, usize)> {
    let at = lv.level(c) as i64;
    let down = if c + 1 < n { lv.level(c + 1) as i64 } else { -1 };
    let up = if c > 0 { lv.level(c - 1) as i64 } else { -1 };
    let (mut indent, mut from, mut to, mut go_up, mut go_down) = (at, c, c, true, true);
    if down == at + 1 {
        (indent, from, to, go_up) = (down, c + 1, c + 1, false);
    } else if up == at + 1 {
        (indent, from, to, go_down) = (up, c - 1, c - 1, false);
    } else if at == 0 {
        return None;
    }
    let mut k = 0;
    while go_up && from > 0 && k < SCAN && lv.level(from - 1) as i64 >= indent {
        from -= 1;
        k += 1;
    }
    k = 0;
    while go_down && to + 1 < n && k < SCAN && lv.level(to + 1) as i64 >= indent {
        to += 1;
        k += 1;
    }
    Some((indent as usize - 1, from, to))
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Guide {
    pub count: usize,
    /// The index drawn in the active color.
    pub active: Option<usize>,
}

/// Guides of lines [first, last].
pub fn indent_guides(lines: &[String], first: usize, last: usize, size: usize, tab: usize, cursor_line: usize) -> Vec<Guide> {
    let lv = Levels::new(lines, size, tab);
    let act = active_guide(&lv, cursor_line, lines.len());
    (first..=last.min(lines.len() - 1))
        .map(|l| {
            let count = lv.level(l);
            Guide { count, active: act.filter(|a| l >= a.1 && l <= a.2 && a.0 < count).map(|a| a.0) }
        })
        .collect()
}

fn partner_of(b: u8) -> Option<(u8, bool)> {
    match b {
        b'(' => Some((b')', true)),
        b'[' => Some((b']', true)),
        b'{' => Some((b'}', true)),
        b')' => Some((b'(', false)),
        b']' => Some((b'[', false)),
        b'}' => Some((b'{', false)),
        _ => None,
    }
}

/// The bracket touching p (the one before it first) and its partner. `code(line, col)` is false inside strings and
/// comments. At most `limit` characters are scanned.
pub fn match_bracket(lines: &[String], p: Pos, code: &dyn Fn(usize, usize) -> bool, limit: usize) -> Option<(Pos, Pos)> {
    let t = lines.get(p.line)?.as_bytes();
    for col in [p.col.checked_sub(1), Some(p.col)].into_iter().flatten() {
        let Some(&ch) = t.get(col) else { continue };
        if partner_of(ch).is_none() || !code(p.line, col) {
            continue;
        }
        if let Some(o) = partner(lines, pos(p.line, col), ch, code, limit) {
            return Some((pos(p.line, col), o));
        }
    }
    None
}

fn partner(lines: &[String], at: Pos, ch: u8, code: &dyn Fn(usize, usize) -> bool, limit: usize) -> Option<Pos> {
    let (other, forward) = partner_of(ch)?;
    let (mut depth, mut line, mut col) = (0i64, at.line as i64, at.col as i64);
    let mut budget = limit as i64;
    while budget > 0 {
        let t = lines[line as usize].as_bytes();
        while col >= 0 && (col as usize) < t.len() && budget > 0 {
            let c = t[col as usize];
            if (c == ch || c == other) && code(line as usize, col as usize) {
                depth += if c == ch { 1 } else { -1 };
                if depth == 0 {
                    return Some(pos(line as usize, col as usize));
                }
            }
            col += if forward { 1 } else { -1 };
            budget -= 1;
        }
        line += if forward { 1 } else { -1 };
        budget -= 1;
        if line < 0 || line as usize >= lines.len() {
            return None;
        }
        col = if forward { 0 } else { lines[line as usize].len() as i64 - 1 };
    }
    None
}

pub fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Whole-word occurrences of `word` in `text`: byte offsets.
pub fn word_hits(text: &str, word: &str) -> Vec<usize> {
    let mut out = vec![];
    if word.is_empty() {
        return out;
    }
    let mut from = 0;
    while let Some(k) = text[from..].find(word) {
        let i = from + k;
        let before = text[..i].chars().next_back();
        let after = text[i + word.len()..].chars().next();
        if !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char) {
            out.push(i);
        }
        from = i + word[..].chars().next().map_or(1, char::len_utf8);
    }
    out
}

/// A match on one line: (line, byte col, byte len).
pub type Hit = (usize, usize, usize);

/// Whole-word matches of `word` on lines [first, last].
pub fn word_matches(lines: &[String], first: usize, last: usize, word: &str) -> Vec<Hit> {
    (first..=last.min(lines.len() - 1)).flat_map(|l| word_hits(&lines[l], word).into_iter().map(move |c| (l, c, word.len()))).collect()
}

/// Exact (case-sensitive), non-overlapping matches of `text` on lines [first, last].
pub fn text_matches(lines: &[String], first: usize, last: usize, text: &str) -> Vec<Hit> {
    let mut out = vec![];
    if text.is_empty() {
        return out;
    }
    for (l, line) in lines.iter().enumerate().take(last.min(lines.len() - 1) + 1).skip(first) {
        out.extend(line.match_indices(text).map(|(i, _)| (l, i, text.len())));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn guides_count_indent_steps_and_blank_lines_take_their_neighbours() {
        let l = lines(&["func main() {", "\tif true {", "\t\tprintln(1)", "", "\t\tx", "\t}", "}"]);
        let g = indent_guides(&l, 0, 6, 4, 4, 2);
        assert_eq!(g.iter().map(|g| g.count).collect::<Vec<_>>(), [0, 1, 2, 2, 2, 1, 0]);
        assert_eq!(g[2].active, Some(1));
        assert_eq!(g[1].active, None);
    }

    #[test]
    fn a_header_lines_active_guide_is_the_block_below_it() {
        let l = lines(&["a:", "  b", "  c", "d"]);
        let lv = Levels::new(&l, 2, 4);
        assert_eq!(active_guide(&lv, 0, 4), Some((0, 1, 2)));
    }

    #[test]
    fn brackets_match_across_lines_skipping_non_code() {
        let l = lines(&["f(a, (b)", ")"]);
        let all = |_: usize, _: usize| true;
        assert_eq!(match_bracket(&l, pos(0, 2), &all, 20000), Some((pos(0, 1), pos(1, 0))));
        let not_col5 = |line: usize, col: usize| !(line == 0 && col == 5);
        assert_eq!(match_bracket(&l, pos(0, 8), &not_col5, 20000), Some((pos(0, 7), pos(0, 1))));
        assert_eq!(match_bracket(&l, pos(0, 0), &all, 20000), None);
    }

    #[test]
    fn occurrences_are_whole_words_or_exact_text() {
        let l = lines(&["main mainly _main main", "x main"]);
        assert_eq!(word_matches(&l, 0, 1, "main"), vec![(0, 0, 4), (0, 18, 4), (1, 2, 4)]);
        assert_eq!(text_matches(&l, 0, 0, "main"), vec![(0, 0, 4), (0, 5, 4), (0, 13, 4), (0, 18, 4)]);
    }
}
