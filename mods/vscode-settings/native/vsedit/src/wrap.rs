//! Word wrap (wrap.cjs, VS Code's editor.wordWrap): where a line breaks into rows, and positions <-> (row, x) within a
//! line. Row k shows the line's display columns [cols[k], cols[k+1]) after `indent` cells (continuation rows only);
//! columns are the line's own (tabs counted from its start), so painting and measuring agree with the unwrapped line.

use crate::width::{char_width, index_at_col, prev_index, text_width_from};
use std::collections::HashMap;
use std::rc::Rc;

pub const MODES: &[&str] = &["off", "on", "wordWrapColumn", "bounded"];
pub const INDENTS: &[&str] = &["none", "same", "indent", "deepIndent"];

/// A line's rows: the byte offset each starts at and its display column, and the continuation rows' indent.
#[derive(Clone, Debug, PartialEq)]
pub struct Rows {
    pub starts: Vec<usize>,
    pub cols: Vec<usize>,
    pub indent: usize,
}

const BEFORE: u8 = 1;
const AFTER: u8 = 2;
const IDEOGRAPHIC: u8 = 3;
// VS Code's editor.wordWrapBreakBeforeCharacters / wordWrapBreakAfterCharacters defaults.
const BREAK_BEFORE: &str = "([{‘“〈《「『【〔（［｛｢£¥＄￡￥+＋";
const BREAK_AFTER: &str = " \t})]?|/&.,;¢°′″‰℃、。｡､￠，．：；？！％・･ゝゞヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎゕゖㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ々〻ｧｨｩｪｫｬｭｮｯｰ”〉》」』】〕）］｝｣";

fn class_of(ch: char) -> u8 {
    if ch.is_ascii() {
        return match ch {
            '(' | '[' | '{' | '+' => BEFORE,
            ' ' | '\t' | '}' | ')' | ']' | '?' | '|' | '/' | '&' | '.' | ',' | ';' => AFTER,
            _ => 0,
        };
    }
    if BREAK_BEFORE.contains(ch) {
        return BEFORE;
    }
    if BREAK_AFTER.contains(ch) {
        return AFTER;
    }
    let cp = ch as u32;
    let ideographic = (0x3040..=0x30ff).contains(&cp) || (0x3400..=0x4dbf).contains(&cp) || (0x4e00..=0x9fff).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp) || (0xff00..=0xffef).contains(&cp) || (0x20000..=0x3fffd).contains(&cp);
    if ideographic { IDEOGRAPHIC } else { 0 }
}

/// VS Code's canBreak: after a run of break-after characters, before a run of break-before ones, around ideographs;
/// never before a space (spaces stay at the end of the row).
fn can_break(prev: u8, ch: char, cls: u8) -> bool {
    ch != ' ' && ((prev == AFTER && cls != AFTER) || (prev != BEFORE && cls == BEFORE) || (prev == IDEOGRAPHIC && cls != AFTER) || (cls == IDEOGRAPHIC && prev != BEFORE))
}

/// A line that fits whatever it holds: no character is wider than 2 columns or shorter than 1 byte.
fn fits(text: &str, width: usize) -> bool {
    width < 1 || (text.len() * 2 <= width && !text.contains('\t'))
}

/// Continuation rows' indent (editor.wrappingIndent): the line's own indentation, plus one or two tab stops; none when a
/// full-width character wouldn't fit after it (VS Code's computeWrappedTextIndentLength).
fn indent_of(text: &str, tab: usize, mode: &str, width: usize) -> usize {
    let Some(first) = text.find(|c: char| !c.is_whitespace()) else { return 0 };
    if mode == "none" {
        return 0;
    }
    let mut n = text_width_from(&text[..first], tab, 0);
    for _ in 0..match mode { "deepIndent" => 2, "indent" => 1, _ => 0 } {
        n += tab - n % tab;
    }
    if n + 2 > width { 0 } else { n }
}

impl Rows {
    pub fn one() -> Rows {
        Rows { starts: vec![0], cols: vec![0], indent: 0 }
    }

    /// The rows of `text` wrapped at `width` columns (VS Code's monospace line breaks): a row ends at the last break
    /// opportunity that fits, or before the character that doesn't fit when there is none (or what would move to the
    /// next row doesn't fit there either).
    pub fn wrap(text: &str, width: usize, tab: usize, mode: &str) -> Rows {
        if fits(text, width) {
            return Rows::one();
        }
        let indent = indent_of(text, tab, mode, width);
        let (mut starts, mut cols) = (vec![0], vec![0]);
        let (mut col, mut avail, mut start, mut row_col, mut at, mut at_col, mut prev) = (0, width, 0, 0, None::<usize>, 0, 0u8);
        for (i, ch) in text.char_indices() {
            let w = if ch == '\t' { tab - col % tab } else if (ch as u32) < 0x300 { 1 } else { char_width(ch) };
            if w > 0 {
                let cls = class_of(ch);
                if i > start && can_break(prev, ch, cls) {
                    (at, at_col) = (Some(i), col);
                }
                if col + w - row_col > avail && i > start {
                    if at.is_none_or(|a| a <= start) || col + w - at_col > width - indent {
                        (at, at_col) = (Some(i), col); // a hard break
                    }
                    start = at.unwrap_or(i);
                    row_col = at_col;
                    starts.push(start);
                    cols.push(row_col);
                    avail = width - indent;
                    at = None;
                }
                prev = cls;
            }
            col += w;
        }
        if starts.len() == 1 { Rows::one() } else { Rows { starts, cols, indent } }
    }

    pub fn last(&self) -> usize {
        self.starts.len() - 1
    }
    /// Row of byte offset `col`: the last row starting at or before it.
    pub fn row_of(&self, col: usize) -> usize {
        self.starts.partition_point(|&s| s <= col).saturating_sub(1)
    }
    /// Where row k's caret stops end: the line's end on the last row, else before the row's last character.
    pub fn row_end(&self, k: usize, text: &str) -> usize {
        if k < self.last() { prev_index(text, self.starts[k + 1]) } else { text.len() }
    }
    /// Cells from row k's left edge to byte offset `col` on it (the wrap indent included).
    pub fn x_of(&self, k: usize, text: &str, col: usize, tab: usize) -> usize {
        let (s, e) = (self.starts[k].min(text.len()), col.min(text.len()).max(self.starts[k].min(text.len())));
        (if k > 0 { self.indent } else { 0 }) + text_width_from(&text[s..e], tab, self.cols[k])
    }
    /// The caret stop on row k nearest x cells from its left edge.
    pub fn col_at(&self, k: usize, text: &str, x: usize, tab: usize) -> usize {
        let ind = if k > 0 { self.indent } else { 0 };
        index_at_col(text, self.cols[k] + x.saturating_sub(ind), tab, self.starts[k], self.cols[k]).min(self.row_end(k, text))
    }
}

/// Rows per line text for one width/tab/indent mode at a time (a new one clears it); kept under ~4M bytes so a long line
/// edited key by key doesn't pile up its old versions.
#[derive(Default)]
pub struct Cache {
    key: (usize, usize, &'static str),
    map: HashMap<String, Rc<Rows>>,
    bytes: usize,
    one: Option<Rc<Rows>>,
}

impl Cache {
    pub fn get(&mut self, text: &str, width: usize, tab: usize, mode: &'static str) -> Rc<Rows> {
        if fits(text, width) {
            return self.one.get_or_insert_with(|| Rc::new(Rows::one())).clone();
        }
        if self.key != (width, tab, mode) {
            self.key = (width, tab, mode);
            self.map.clear();
            self.bytes = 0;
        }
        if let Some(r) = self.map.get(text) {
            return r.clone();
        }
        if self.bytes > 4_000_000 {
            self.map.clear();
            self.bytes = 0;
        }
        let r = Rc::new(Rows::wrap(text, width, tab, mode));
        self.bytes += text.len();
        self.map.insert(text.to_string(), r.clone());
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(text: &str, width: usize) -> Vec<&str> {
        let r = Rows::wrap(text, width, 4, "same");
        r.starts.iter().enumerate().map(|(k, &s)| &text[s..r.starts.get(k + 1).copied().unwrap_or(text.len())]).collect()
    }

    #[test]
    fn breaks_after_spaces_and_punctuation_and_before_brackets() {
        assert_eq!(rows("hello world foo bar baz qux", 10), ["hello ", "world foo ", "bar baz ", "qux"]);
        assert_eq!(rows("gamma.delta(epsilon);", 12), ["gamma.delta", "(epsilon);"]);
    }

    #[test]
    fn a_long_token_breaks_where_it_does_not_fit() {
        assert_eq!(rows(&"a".repeat(25), 10), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
    }

    #[test]
    fn cjk_is_two_columns_and_breaks_between_ideographs_hangul_at_spaces() {
        assert_eq!(rows("漢字漢字漢字漢字漢字漢字", 10), ["漢字漢字漢", "字漢字漢字", "漢字"]);
        assert_eq!(rows("한글 단어 줄바꿈 테스트", 10), ["한글 단어 ", "줄바꿈 ", "테스트"]);
    }

    #[test]
    fn continuation_rows_get_the_wrapping_indent() {
        let line = "    call(alpha, beta, gamma)";
        let ind = |m| Rows::wrap(line, 20, 4, m).indent;
        assert_eq!([ind("none"), ind("same"), ind("indent"), ind("deepIndent")], [0, 4, 8, 12]);
        assert_eq!(rows(line, 20), ["    call(alpha, ", "beta, gamma)"]);
        assert_eq!(Rows::wrap(&format!("{}{}", " ".repeat(19), "x".repeat(10)), 20, 4, "same").indent, 0);
    }

    #[test]
    fn positions_map_to_row_and_x_and_back() {
        let text = "  aaaa bbbb cccc";
        let r = Rows::wrap(text, 8, 4, "same");
        assert_eq!(r.starts, [0, 7, 12]);
        assert_eq!(r.row_of(7), 1);
        assert_eq!(r.x_of(1, text, 9, 4), 4);
        assert_eq!(r.col_at(1, text, 4, 4), 9);
        assert_eq!(r.col_at(1, text, 0, 4), 7);
        assert_eq!(r.col_at(0, text, 99, 4), 6);
        assert_eq!(r.col_at(2, text, 99, 4), text.len());
    }

    #[test]
    fn a_line_that_fits_is_one_row_and_the_cache_keeps_rows_per_text() {
        assert_eq!(Rows::wrap("short", 10, 4, "same"), Rows::one());
        let mut c = Cache::default();
        let t = "x ".repeat(20);
        assert!(Rc::ptr_eq(&c.get(&t, 10, 4, "same"), &c.get(&t, 10, 4, "same")));
        assert_ne!(c.get(&t, 12, 4, "same").starts, c.get(&t, 10, 4, "same").starts);
    }
}
