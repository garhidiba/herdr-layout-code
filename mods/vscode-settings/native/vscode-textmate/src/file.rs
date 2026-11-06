//! The viewer's `tokenize.cjs`: a file's lines as [text, colorIndex, fontStyle, …] runs with One Dark colors,
//! plus the status-bar facts (EOL, indentation). Same JSON, same color indexes.

use crate::raw::{parse_jsonc, parse_raw_grammar};
use crate::registry::Registry;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

const MAX_LINE: usize = 4000;

fn read(path: &Path) -> Result<String, String> {
    fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| format!("{}: {e}", path.display()))
}

/// tokenize.cjs's `scopeOf`: exact file names, name prefixes, then ever shorter extensions.
pub fn scope_of(index: &Value, name: &str) -> Option<String> {
    let n = name.to_lowercase();
    let get = |table: &str, key: &str| index[table].get(key).and_then(Value::as_str).map(str::to_string);
    if let Some(s) = get("files", &n) {
        return Some(s);
    }
    if let Some(prefixes) = index["prefixes"].as_object() {
        if let Some((_, s)) = prefixes.iter().find(|(p, _)| n.starts_with(p.as_str())) {
            return s.as_str().map(str::to_string);
        }
    }
    let parts: Vec<&str> = n.split('.').collect();
    (1..parts.len()).find_map(|i| get("ext", &parts[i..].join(".")))
}

/// `text.split(/\r\n|\r|\n/)`.
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut out = vec![];
    let (b, mut start, mut i) = (text.as_bytes(), 0, 0);
    while i < b.len() {
        if b[i] == b'\r' || b[i] == b'\n' {
            out.push(&text[start..i]);
            i += if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
            start = i;
        } else {
            i += 1;
        }
    }
    out.push(&text[start..]);
    out
}

/// "Tabs" or "Spaces: n", decided from the first 2,000 lines as tokenize.cjs does.
fn indentation(lines: &[&str]) -> String {
    let (mut tabs, mut steps) = (0usize, HashMap::<usize, usize>::new());
    for l in lines.iter().take(2000) {
        if l.starts_with('\t') {
            tabs += 1;
            continue;
        }
        let spaces = l.bytes().take_while(|c| *c == b' ').count();
        let next = l[spaces..].chars().next();
        if spaces > 0 && spaces <= 8 && next.is_some_and(|c| !crate::rule::js_space(c)) {
            *steps.entry(spaces).or_default() += 1;
        }
    }
    let space_lines: usize = steps.values().sum();
    let mut keys: Vec<usize> = steps.keys().copied().collect();
    keys.sort_unstable();
    let threshold = 2f64.max(space_lines as f64 * 0.1);
    let step = keys.into_iter().find(|k| steps[k] as f64 >= threshold).unwrap_or(4);
    if tabs > space_lines {
        "Tabs".into()
    } else {
        format!("Spaces: {step}")
    }
}

/// How many lines `for (n = 0; n < Math.min(total, MAX_LINES); n++)` shows, MAX_LINES = `Number(arg) || 8000`.
fn shown_lines(total: usize, max_lines: Option<&str>) -> usize {
    let max = max_lines.and_then(|s| s.trim().parse::<f64>().ok()).filter(|m| *m != 0.0 && !m.is_nan()).unwrap_or(8000.0);
    if max <= 0.0 {
        0
    } else {
        total.min(max.ceil() as usize)
    }
}

/// UTF-16 offset → byte offset for `line` (None when the line is ASCII and they are the same).
fn utf16_to_byte(line: &str) -> Option<Vec<usize>> {
    if line.is_ascii() {
        return None;
    }
    let mut map = Vec::with_capacity(line.len() + 1);
    for (i, c) in line.char_indices() {
        map.extend(std::iter::repeat_n(i, c.len_utf16()));
    }
    map.push(line.len());
    Some(map)
}

/// The viewer's setup (tokenize.cjs, highlight.cjs): its index.json, its theme's `colors`, and a registry with
/// that theme loading grammars from `vscode_dir`.
pub struct Viewer {
    pub index: Value,
    pub colors: Value,
    pub registry: Registry,
}

pub fn viewer(vscode_dir: &Path) -> Result<Viewer, String> {
    let index: Value = serde_json::from_str(&read(&vscode_dir.join("index.json"))?).map_err(|e| e.to_string())?;
    let theme = parse_jsonc(&read(&vscode_dir.join("theme.json"))?)?;
    let colors = theme.get("colors").cloned().unwrap_or(Value::Null);
    let mut settings = vec![json!({ "settings": { "foreground": colors.get("editor.foreground"), "background": colors.get("editor.background") } })];
    settings.extend(theme.get("tokenColors").and_then(Value::as_array).cloned().unwrap_or_default());
    let raw_theme = json!({ "name": theme.get("name"), "settings": settings });
    let (dir, scopes) = (vscode_dir.to_path_buf(), index["scopes"].clone());
    let registry = Registry::new(
        &raw_theme,
        Box::new(move |s: &str| match scopes.get(s).and_then(Value::as_str) {
            Some(f) => parse_raw_grammar(&read(&dir.join(f))?, f).map(Some),
            None => Ok(None),
        }),
    );
    Ok(Viewer { index, colors, registry })
}

/// tokenize.cjs's output for `file`, with grammars and theme from `vscode_dir`; `with_stack` adds the rule stack
/// after the last shown line (for the parity tests).
pub fn tokenize_file(vscode_dir: &Path, file: &Path, max_lines: Option<&str>, with_stack: bool) -> Result<Value, String> {
    let text = read(file)?;
    let Viewer { index, colors: colors_of_theme, mut registry } = viewer(vscode_dir)?;

    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let scope = scope_of(&index, &name);
    let lines = split_lines(&text);
    let total = lines.len();
    let eol = if text.contains("\r\n") { "CRLF" } else { "LF" };

    let mut colors: Vec<String> = vec![];
    let mut color_index: HashMap<String, usize> = HashMap::new();
    let mut color_of = |hex: &str| -> usize {
        let hex = String::from_utf16_lossy(&hex.encode_utf16().take(7).collect::<Vec<_>>());
        *color_index.entry(hex.clone()).or_insert_with(|| {
            colors.push(hex);
            colors.len() - 1
        })
    };
    let fg = color_of(colors_of_theme.get("editor.foreground").and_then(Value::as_str).unwrap_or("#abb2bf"));

    let (mut grammar, mut color_map) = (None, vec![]);
    if let Some(scope) = &scope {
        grammar = registry.load_grammar(scope)?;
        color_map = registry.color_map().to_vec();
    }

    let mut out_lines = vec![];
    let mut stack = None;
    for line in lines.iter().take(shown_lines(total, max_lines)) {
        let len16 = line.encode_utf16().count();
        let Some(g) = grammar.as_mut().filter(|_| len16 <= MAX_LINE) else {
            out_lines.push(json!([line, fg, 0]));
            continue;
        };
        let r = g.tokenize_line2(line, stack.as_ref(), Duration::ZERO)?;
        let map = utf16_to_byte(line);
        let at = |u: u32| map.as_ref().map_or(u as usize, |m| m[(u as usize).min(m.len() - 1)]);
        let t = &r.tokens;
        let mut row: Vec<Value> = vec![];
        for i in (0..t.len()).step_by(2) {
            let (start, meta) = (t[i] as usize, t[i + 1]);
            let end = if i + 2 < t.len() { t[i + 2] as usize } else { len16 };
            if end <= start {
                continue;
            }
            let color = color_map.get(((meta & 0x00ff_8000) >> 15) as usize).cloned().flatten().unwrap_or_else(|| "#abb2bf".into());
            row.extend([json!(line[at(start as u32)..at(end as u32)]), json!(color_of(&color)), json!((meta & 0x7800) >> 11)]);
        }
        out_lines.push(if row.is_empty() { json!(["", fg, 0]) } else { Value::Array(row) });
        stack = Some(r.rule_stack);
    }

    let mut out = Map::new();
    out.insert("scope".into(), json!(scope));
    out.insert("total".into(), json!(total));
    out.insert("eol".into(), json!(eol));
    out.insert("indent".into(), json!(indentation(&lines)));
    out.insert("colors".into(), json!(colors));
    out.insert("lines".into(), Value::Array(out_lines));
    out.insert("theme".into(), colors_of_theme);
    if with_stack {
        out.insert("stack".into(), json!(stack.map(|s| s.frames())));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_split_on_any_line_break() {
        assert_eq!(split_lines("a\r\nb\rc\n"), vec!["a", "b", "c", ""]);
    }

    #[test]
    fn indentation_picks_the_smallest_common_step() {
        assert_eq!(indentation(&["a", "  b", "  c", "    d", "    e"]), "Spaces: 2");
        assert_eq!(indentation(&["\ta", "\tb", "  c"]), "Tabs");
        assert_eq!(indentation(&["a"]), "Spaces: 4");
    }

    #[test]
    fn max_lines_follows_number_or_default() {
        assert_eq!(shown_lines(10_000, None), 8000);
        assert_eq!(shown_lines(10, Some("0")), 10);
        assert_eq!(shown_lines(10, Some("2.5")), 3);
        assert_eq!(shown_lines(10, Some("-1")), 0);
    }
}
