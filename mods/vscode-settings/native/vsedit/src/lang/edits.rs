//! Workspace edits (lang/edits.cjs): per file, text edits in 0-based lines and UTF-16 columns (the language servers'
//! positions). Files open in the editor take the edits through a callback; the rest are rewritten on disk keeping
//! EOL, BOM and the final newline.

use crate::file;
use crate::gitgutter::{line_hunks, MAX_EDITS};
use std::path::{Path, PathBuf};

/// A position as the servers give it: line, UTF-16 column.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct P16 {
    pub line: usize,
    pub col: usize,
}

pub const fn p16(line: usize, col: usize) -> P16 {
    P16 { line, col }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextEdit {
    pub start: P16,
    pub end: P16,
    pub text: String,
}

/// Files in the order the server named them, each with its edits.
pub type WorkspaceEdit = Vec<(PathBuf, Vec<TextEdit>)>;

/// Adds edits for `file` (after any it already has).
pub fn add(ws: &mut WorkspaceEdit, file: PathBuf, edits: Vec<TextEdit>) {
    match ws.iter_mut().find(|(f, _)| *f == file) {
        Some((_, es)) => es.extend(edits),
        None => ws.push((file, edits)),
    }
}

/// The byte offset of UTF-16 column `u` in `line` (clamped to the line).
pub fn byte_of(line: &str, u: usize) -> usize {
    let mut n = 0;
    for (i, c) in line.char_indices() {
        if n >= u {
            return i;
        }
        n += c.len_utf16();
    }
    line.len()
}

/// The UTF-16 column of byte offset `b` in `line`.
pub fn u16_of(line: &str, b: usize) -> usize {
    line.get(..b.min(line.len())).map_or(0, |s| s.encode_utf16().count())
}

/// Edits sorted last-first, so applying them in order never shifts a later one.
pub fn last_first(edits: &[TextEdit]) -> Vec<TextEdit> {
    let mut out = edits.to_vec();
    out.sort_by(|a, b| b.start.cmp(&a.start).then(b.end.cmp(&a.end)));
    out
}

/// Lines with the edits applied.
pub fn apply_to_lines(lines: &[String], edits: &[TextEdit]) -> Vec<String> {
    let mut out = lines.to_vec();
    for e in last_first(edits) {
        let clamp = |out: &[String], p: P16| {
            let line = p.line.min(out.len() - 1);
            (line, byte_of(&out[line], p.col))
        };
        let ((sl, sc), (el, ec)) = (clamp(&out, e.start), clamp(&out, e.end));
        let text = e.text.replace("\r\n", "\n").replace('\r', "\n");
        let mut parts: Vec<String> = text.split('\n').map(str::to_string).collect();
        parts[0] = format!("{}{}", &out[sl][..sc], parts[0]);
        let last = parts.len() - 1;
        let tail = out[el.max(sl)][if el < sl { 0 } else { ec }..].to_string();
        parts[last].push_str(&tail);
        out.splice(sl..=el.max(sl), parts);
    }
    out
}

/// Format Selection with a document formatter: its edits restricted to lines [a, b] as one edit replacing them
/// (empty when it changes none of them); None when a changed run of lines crosses a or b.
pub fn edits_within(lines: &[String], edits: &[TextEdit], a: usize, b: usize) -> Option<Vec<TextEdit>> {
    let after = apply_to_lines(lines, edits);
    let (mut block, mut i, mut changed) = (vec![], a, false);
    for (a0, a1, b0, b1) in line_hunks(lines, &after, MAX_EDITS) {
        let outside = if a0 == a1 { a0 <= a || a0 > b } else { a1 <= a || a0 > b };
        if outside {
            continue;
        }
        if a0 < a || a1 > b + 1 {
            return None;
        }
        block.extend_from_slice(&lines[i..a0]);
        block.extend_from_slice(&after[b0..b1]);
        i = a1;
        changed = true;
    }
    if !changed {
        return Some(vec![]);
    }
    block.extend_from_slice(&lines[i..=b]);
    Some(vec![TextEdit { start: p16(a, 0), end: p16(b, lines[b].encode_utf16().count()), text: block.join("\n") }])
}

pub struct Applied {
    pub files: usize,
    pub edits: usize,
    pub failed: Vec<(PathBuf, String)>,
}

/// Applies a workspace edit; `open(file, edits)` takes them when the file is open in the editor.
pub fn apply_workspace_edit(ws: &WorkspaceEdit, mut open: impl FnMut(&Path, &[TextEdit]) -> bool) -> Applied {
    let mut r = Applied { files: 0, edits: 0, failed: vec![] };
    for (f, edits) in ws {
        if edits.is_empty() {
            continue;
        }
        let done = open(f, edits) || {
            match file::load(f, false) {
                Ok(Ok(doc)) => match file::save(f, &file::encode(&apply_to_lines(&doc.lines, edits), &doc)) {
                    Ok(_) => true,
                    Err(e) => {
                        r.failed.push((f.clone(), e.to_string()));
                        false
                    }
                },
                Ok(Err(why)) => {
                    r.failed.push((f.clone(), why.message()));
                    false
                }
                Err(e) => {
                    r.failed.push((f.clone(), e.to_string()));
                    false
                }
            }
        };
        if done {
            r.files += 1;
            r.edits += edits.len();
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn te(sl: usize, sc: usize, el: usize, ec: usize, text: &str) -> TextEdit {
        TextEdit { start: p16(sl, sc), end: p16(el, ec), text: text.into() }
    }

    #[test]
    fn edits_apply_last_first_in_utf16_columns() {
        let l = lines(&["한 a b", "c"]);
        let out = apply_to_lines(&l, &[te(0, 2, 0, 3, "X"), te(0, 4, 1, 1, "Y\nZ")]);
        assert_eq!(out, ["한 X Y", "Z"]);
    }

    #[test]
    fn format_selection_keeps_only_changes_inside_the_lines() {
        let l = lines(&["a = 1", "b  = 2", "c  = 3", "d = 4"]);
        let all = vec![te(0, 0, 3, 5, "a = 1\nb = 2\nc = 3\nd = 4")];
        assert_eq!(edits_within(&l, &all, 1, 1), None, "lines 1 and 2 change together");
        let all = vec![te(1, 0, 1, 6, "b = 2"), te(3, 0, 3, 5, "d  = 4")];
        assert_eq!(edits_within(&l, &all, 1, 2), Some(vec![te(1, 0, 2, 6, "b = 2\nc  = 3")]));
        assert_eq!(edits_within(&l, &[], 1, 1), Some(vec![]));
        let joined = vec![te(0, 0, 1, 6, "a = 1 b = 2")];
        assert_eq!(edits_within(&l, &joined, 1, 1), None, "a change crossing the selection can't be split");
    }

    #[test]
    fn utf16_columns_convert_both_ways() {
        assert_eq!(byte_of("한a😀b", 2), 4);
        assert_eq!(byte_of("한a😀b", 4), 8);
        assert_eq!(u16_of("한a😀b", 8), 4);
        assert_eq!(byte_of("ab", 9), 2);
    }
}
