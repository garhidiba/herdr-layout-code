//! VS Code's auto-closing pairs as pure rules over a line and the cursor (autoclose.cjs): autoClosingBrackets/Quotes
//! "languageDefined", autoClosingOvertype and autoClosingDelete "auto" (only closers the editor inserted), autoSurround.

use crate::decorations::is_word_char;
use crate::highlight::{token_index, token_type_of, Tokens};

const BACKTICK: &[&str] = &["source.js", "source.js.jsx", "source.ts", "source.tsx", "source.go", "source.shell", "source.kotlin", "text.html.markdown"];
const CLOSE_BEFORE: &str = ";:.,=}])> \t";

/// The closer of `open` in a scope's pairs.
pub fn closer(scope: Option<&str>, open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        '"' => Some('"'),
        '\'' if scope != Some("source.rust") => Some('\''),
        '`' if scope.is_some_and(|s| BACKTICK.contains(&s)) => Some('`'),
        _ => None,
    }
}

fn is_quote(c: char) -> bool {
    matches!(c, '"' | '\'' | '`')
}

/// True when the cursor at byte `col` is inside a string or comment by the line's tokens (None: plain code).
pub fn in_string_or_comment(tokens: Option<&Tokens>, text: &str, col: usize) -> bool {
    let Some(t) = tokens.filter(|t| !t.is_empty()) else { return false };
    if col == 0 {
        return false;
    }
    let before = text[..col].chars().next_back().map_or(0, char::len_utf8);
    let k = token_index(t, col - before);
    let ty = token_type_of(t[k].1);
    let end = t.get(k + 1).map_or(text.len(), |n| n.0 as usize);
    if ty == 1 {
        return true;
    }
    if ty != 2 {
        return false;
    }
    let start = t[k].0 as usize;
    let opening = text[start..end].chars().count() == 1 && (k == 0 || token_type_of(t[k - 1].1) != 2);
    col < end || !text[..end].chars().next_back().is_some_and(is_quote) || opening
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Typed {
    /// Step over the auto-inserted closer at the cursor.
    Over,
    /// Surround the selection.
    Wrap,
    /// Insert the character and its closer, the cursor between.
    Pair,
}

pub struct Ctx<'a> {
    pub scope: Option<&'a str>,
    pub text: &'a str,
    pub col: usize,
    pub selected: bool,
    pub in_text: bool,
    /// The character at the cursor was auto-inserted.
    pub closer: bool,
}

/// What typing `ch` does; None for a plain insert.
pub fn on_type(ch: char, c: &Ctx) -> Option<Typed> {
    let pair = closer(c.scope, ch);
    if c.selected {
        return pair.map(|_| Typed::Wrap);
    }
    let next = c.text[c.col..].chars().next();
    if c.closer && next == Some(ch) {
        return Some(Typed::Over);
    }
    pair?;
    if next.is_some_and(|n| !CLOSE_BEFORE.contains(n)) {
        return None;
    }
    if is_quote(ch) && (c.in_text || c.text[..c.col].chars().next_back().is_some_and(is_word_char)) {
        return None;
    }
    Some(Typed::Pair)
}

/// Backspace between an empty pair whose closer was auto-inserted deletes both.
pub fn deletes_pair(scope: Option<&str>, text: &str, col: usize, closer_here: bool) -> bool {
    let before = text[..col].chars().next_back();
    let after = text[col..].chars().next();
    closer_here && before.and_then(|b| closer(scope, b)).is_some_and(|c| Some(c) == after)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(text: &'a str, col: usize) -> Ctx<'a> {
        Ctx { scope: Some("source.ts"), text, col, selected: false, in_text: false, closer: false }
    }

    #[test]
    fn openers_pair_only_before_closing_characters() {
        assert_eq!(on_type('(', &ctx("", 0)), Some(Typed::Pair));
        assert_eq!(on_type('(', &ctx("x", 0)), None);
        assert_eq!(on_type('(', &ctx(";", 0)), Some(Typed::Pair));
        assert_eq!(on_type('a', &ctx("", 0)), None);
    }

    #[test]
    fn quotes_do_not_pair_after_a_word_or_inside_strings() {
        assert_eq!(on_type('"', &ctx("ab", 2)), None);
        assert_eq!(on_type('"', &Ctx { in_text: true, ..ctx("", 0) }), None);
        assert_eq!(on_type('\'', &Ctx { scope: Some("source.rust"), ..ctx("", 0) }), None);
        assert_eq!(on_type('`', &ctx("", 0)), Some(Typed::Pair));
    }

    #[test]
    fn auto_inserted_closers_are_typed_over_and_deleted_with_their_opener() {
        assert_eq!(on_type(')', &Ctx { closer: true, ..ctx("()", 1) }), Some(Typed::Over));
        assert_eq!(on_type(')', &ctx("()", 1)), None);
        assert_eq!(on_type('{', &Ctx { selected: true, ..ctx("a", 0) }), Some(Typed::Wrap));
        assert!(deletes_pair(Some("source.ts"), "[]", 1, true));
        assert!(!deletes_pair(Some("source.ts"), "[]", 1, false));
    }

    #[test]
    fn strings_and_comments_come_from_token_types() {
        // `x = "ab"` with the string (type 2) at 4..8
        let toks: Tokens = vec![(0, 0), (4, 2 << 8)];
        assert!(in_string_or_comment(Some(&toks), "x = \"ab\"", 6));
        assert!(!in_string_or_comment(Some(&toks), "x = \"ab\"", 8));
        assert!(!in_string_or_comment(None, "x", 1));
    }
}
