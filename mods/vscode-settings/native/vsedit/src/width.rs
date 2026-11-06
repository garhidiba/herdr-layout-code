//! Terminal display width (width.cjs): East Asian Wide/Fullwidth and emoji take 2 columns, combining marks 0, tabs
//! expand. Columns in the buffer are byte offsets into a line's UTF-8; display columns come from these helpers.

const WIDE: &[(u32, u32)] = &[
    (0x1100, 0x115f), (0x231a, 0x231b), (0x2329, 0x232a), (0x23e9, 0x23ec), (0x23f0, 0x23f0), (0x23f3, 0x23f3),
    (0x25fd, 0x25fe), (0x2614, 0x2615), (0x2648, 0x2653), (0x267f, 0x267f), (0x2693, 0x2693), (0x26a1, 0x26a1),
    (0x26aa, 0x26ab), (0x26bd, 0x26be), (0x26c4, 0x26c5), (0x26ce, 0x26ce), (0x26d4, 0x26d4), (0x26ea, 0x26ea),
    (0x26f2, 0x26f3), (0x26f5, 0x26f5), (0x26fa, 0x26fa), (0x26fd, 0x26fd), (0x2705, 0x2705), (0x270a, 0x270b),
    (0x2728, 0x2728), (0x274c, 0x274c), (0x274e, 0x274e), (0x2753, 0x2755), (0x2757, 0x2757), (0x2795, 0x2797),
    (0x27b0, 0x27b0), (0x27bf, 0x27bf), (0x2b1b, 0x2b1c), (0x2b50, 0x2b50), (0x2b55, 0x2b55), (0x2e80, 0x303e),
    (0x3041, 0x33ff), (0x3400, 0x4dbf), (0x4e00, 0x9fff), (0xa000, 0xa4cf), (0xa960, 0xa97f), (0xac00, 0xd7a3),
    (0xf900, 0xfaff), (0xfe10, 0xfe19), (0xfe30, 0xfe6f), (0xff00, 0xff60), (0xffe0, 0xffe6), (0x16fe0, 0x16fe4),
    (0x17000, 0x18aff), (0x1b000, 0x1b2ff), (0x1f004, 0x1f004), (0x1f0cf, 0x1f0cf), (0x1f18e, 0x1f18e),
    (0x1f191, 0x1f19a), (0x1f200, 0x1f251), (0x1f300, 0x1f64f), (0x1f680, 0x1f6ff), (0x1f7e0, 0x1f7eb),
    (0x1f90c, 0x1f9ff), (0x1fa70, 0x1faff), (0x20000, 0x2fffd), (0x30000, 0x3fffd),
];
const ZERO: &[(u32, u32)] = &[
    (0x0300, 0x036f), (0x0483, 0x0489), (0x0591, 0x05bd), (0x0610, 0x061a), (0x064b, 0x065f), (0x1160, 0x11ff),
    (0x1ab0, 0x1aff), (0x1dc0, 0x1dff), (0x200b, 0x200f), (0x2028, 0x202e), (0x2060, 0x2064), (0x20d0, 0x20ff),
    (0xd7b0, 0xd7ff), (0xfe00, 0xfe0f), (0xfe20, 0xfe2f), (0xfeff, 0xfeff), (0x1f3fb, 0x1f3ff), (0xe0000, 0xe01ef),
];

fn in_ranges(ranges: &[(u32, u32)], cp: u32) -> bool {
    ranges.binary_search_by(|&(a, b)| if cp < a { std::cmp::Ordering::Greater } else if cp > b { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }).is_ok()
}

/// Width of one character (tabs are handled by the callers that know the column).
pub fn char_width(c: char) -> usize {
    let cp = c as u32;
    if cp < 0x300 {
        return 1; // control characters show as control pictures
    }
    if in_ranges(ZERO, cp) {
        0
    } else if in_ranges(WIDE, cp) {
        2
    } else {
        1
    }
}

/// Width of `ch` at display column `col`.
pub fn width_at(ch: char, col: usize, tab: usize) -> usize {
    if ch == '\t' {
        tab - col % tab
    } else {
        char_width(ch)
    }
}

/// Display width of text starting at display column `col`.
pub fn text_width_from(text: &str, tab: usize, mut col: usize) -> usize {
    let start = col;
    for ch in text.chars() {
        col += width_at(ch, col, tab);
    }
    col - start
}

pub fn text_width(text: &str, tab: usize) -> usize {
    text_width_from(text, tab, 0)
}

/// Display column of byte offset `index` in `line`.
pub fn display_col(line: &str, index: usize, tab: usize) -> usize {
    text_width(&line[..index.min(line.len())], tab)
}

/// Byte offset of the character boundary nearest display column `col` (the right half of a wide char goes after it),
/// walking from a known byte offset `from` at display column `from_col` (0, 0: the line's start; a wrapped row's start).
pub fn index_at_col(line: &str, col: usize, tab: usize, from: usize, from_col: usize) -> usize {
    let mut c = from_col;
    for (i, ch) in line[from.min(line.len())..].char_indices() {
        let w = width_at(ch, c, tab);
        if c + w > col && w > 0 {
            return from + if (col - c) * 2 >= w { i + ch.len_utf8() } else { i };
        }
        c += w;
    }
    line.len()
}

/// Next cursor stop: steps over the zero-width marks that follow a character.
pub fn next_index(line: &str, i: usize) -> usize {
    let mut it = line[i.min(line.len())..].char_indices();
    let Some((_, first)) = it.next() else { return line.len() };
    let mut end = i + first.len_utf8();
    for (k, ch) in it {
        if char_width(ch) != 0 {
            break;
        }
        end = i + k + ch.len_utf8();
    }
    end
}

/// Previous cursor stop.
pub fn prev_index(line: &str, i: usize) -> usize {
    let mut i = i.min(line.len());
    while i > 0 {
        let ch = line[..i].chars().next_back().unwrap();
        i -= ch.len_utf8();
        if char_width(ch) != 0 {
            break;
        }
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hangul_and_emoji_are_two_columns_and_marks_zero() {
        assert_eq!(text_width("한글", 4), 4);
        assert_eq!(text_width("a\u{301}", 4), 1);
        assert_eq!(text_width("\tx", 4), 5);
    }

    #[test]
    fn cursor_steps_over_combining_marks() {
        let s = "e\u{301}x";
        assert_eq!(next_index(s, 0), 3);
        assert_eq!(prev_index(s, 3), 0);
    }

    #[test]
    fn a_column_inside_a_wide_char_rounds_to_the_nearer_edge() {
        assert_eq!(index_at_col("한글", 1, 4, 0, 0), 3);
        assert_eq!(index_at_col("한글", 2, 4, 0, 0), 3);
        assert_eq!(index_at_col("ab", 9, 4, 0, 0), 2);
    }
}
