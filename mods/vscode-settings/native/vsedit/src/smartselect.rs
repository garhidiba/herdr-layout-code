//! Expand / Shrink Selection (smartselect.cjs, VS Code's smart select): ranges around a position from the word, the
//! string, the brackets, the line and the whole text, and the chain a selection walks through, each containing the one
//! before. Positions are byte offsets.

use crate::buffer::{pos, Pos};
use crate::decorations::{enclosing_brackets, is_word_char};

pub type Range = (Pos, Pos);

fn contains(o: Range, i: Range) -> bool {
    o.0 <= i.0 && i.1 <= o.1
}

/// Grows with nesting: a range containing another is never smaller.
fn size(r: Range) -> u128 {
    (r.1.line - r.0.line) as u128 * 1_000_000_000 + r.1.col as u128 - r.0.col as u128
}

/// `sel`, then each of `ranges` that contains the previous one and is larger, smallest first.
pub fn chain(sel: Range, ranges: &[Range]) -> Vec<Range> {
    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|r| size(*r));
    let mut out = vec![sel];
    for r in sorted {
        let last = *out.last().unwrap();
        if r.0 <= r.1 && contains(r, last) && r != last {
            out.push(r);
        }
    }
    out
}

/// Candidate ranges around `p` without a language server. `code(line, col)`: false inside strings and comments;
/// `string(line, col)`: the [from, to) bytes of the string token at col, quotes included.
pub fn fallback_ranges(lines: &[String], p: Pos, code: &dyn Fn(usize, usize) -> bool, string: &dyn Fn(usize, usize) -> Option<(usize, usize)>) -> Vec<Range> {
    let t = &lines[p.line];
    let mut out = vec![];
    let (mut s, mut e) = (p.col, p.col);
    while let Some(c) = t[..s].chars().next_back().filter(|c| is_word_char(*c)) {
        s -= c.len_utf8();
    }
    while let Some(c) = t[e..].chars().next().filter(|c| is_word_char(*c)) {
        e += c.len_utf8();
    }
    if s < e {
        out.push((pos(p.line, s), pos(p.line, e)));
    }
    let before = t[..p.col].chars().next_back().map(|c| p.col - c.len_utf8());
    if let Some((a, b)) = string(p.line, p.col).or_else(|| before.and_then(|k| string(p.line, k))).filter(|(a, b)| b - a >= 2) {
        out.push((pos(p.line, a + 1), pos(p.line, b - 1)));
        out.push((pos(p.line, a), pos(p.line, b)));
    }
    let mut at = p;
    for _ in 0..100 {
        let Some((open, close)) = enclosing_brackets(lines, at, code, 20000) else { break };
        out.push((pos(open.line, open.col + 1), close));
        out.push((open, pos(close.line, close.col + 1)));
        let lead = lines[open.line].find(|c: char| !c.is_whitespace()).unwrap_or(0);
        if open.line != close.line && lead < open.col {
            out.push((pos(open.line, lead), pos(close.line, close.col + 1)));
        }
        at = open;
    }
    let lead = t.find(|c: char| !c.is_whitespace()).unwrap_or(t.len());
    let trail = t.trim_end().len();
    if lead < trail {
        out.push((pos(p.line, lead), pos(p.line, trail)));
    }
    out.push((pos(p.line, 0), pos(p.line, t.len())));
    let last = lines.len() - 1;
    out.push((pos(0, 0), pos(last, lines[last].len())));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chain_grows_from_the_word_through_the_string_and_brackets_to_the_text() {
        let lines: Vec<String> = ["f(\"hi there\", x);", "y"].iter().map(|s| s.to_string()).collect();
        let string = |_: usize, c: usize| (2..12).contains(&c).then_some((2, 12));
        let code = |_: usize, c: usize| !(2..12).contains(&c);
        let p = pos(0, 5);
        let ranges = fallback_ranges(&lines, p, &code, &string);
        let ch = chain((p, p), &ranges);
        let cols: Vec<(usize, usize, usize, usize)> = ch.iter().map(|r| (r.0.line, r.0.col, r.1.line, r.1.col)).collect();
        assert_eq!(cols, [(0, 5, 0, 5), (0, 3, 0, 5), (0, 3, 0, 11), (0, 2, 0, 12), (0, 2, 0, 15), (0, 1, 0, 16), (0, 0, 0, 17), (0, 0, 1, 1)]);
    }
}
