//! Semantic tokens (not in the JS editor): LSP `textDocument/semanticTokens` (relative 5-tuples, with /delta edits) and
//! tsserver's `encodedSemanticClassifications-full` (format 2020) decoded to one list, and their colors from the
//! theme: `semanticTokenColors`, else VS Code's default semantic token -> TextMate scope map through `tokenColors`.
//! Only for a theme with `"semanticHighlighting": true`, as VS Code does.

use super::edits::byte_of;
use crate::highlight::Span;
use serde_json::Value;
use std::collections::HashMap;
use vscode_textmate::{Theme, FONT_STYLE_NOT_SET};

/// Decoded tokens: (line, UTF-16 start, UTF-16 length, type name index, modifier bits) with the legend's names.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tokens {
    pub types: Vec<String>,
    pub modifiers: Vec<String>,
    pub items: Vec<(usize, usize, usize, usize, u32)>,
}

/// LSP relative data (deltaLine, deltaStart, length, type, modifiers)* -> absolute tokens.
pub fn decode_lsp(data: &[u32], types: &[String], modifiers: &[String]) -> Tokens {
    let (mut line, mut start, mut items) = (0usize, 0usize, Vec::with_capacity(data.len() / 5));
    for t in data.chunks_exact(5) {
        if t[0] > 0 {
            line += t[0] as usize;
            start = 0;
        }
        start += t[1] as usize;
        items.push((line, start, t[2] as usize, t[3] as usize, t[4]));
    }
    Tokens { types: types.to_vec(), modifiers: modifiers.to_vec(), items }
}

/// SemanticTokensDelta edits ({ start, deleteCount, data }) applied to the previous data.
pub fn apply_delta(prev: &[u32], edits: &Value) -> Vec<u32> {
    let mut out = prev.to_vec();
    let mut list: Vec<&Value> = edits.as_array().into_iter().flatten().collect();
    list.sort_by_key(|e| std::cmp::Reverse(e["start"].as_u64().unwrap_or(0)));
    for e in list {
        let start = (e["start"].as_u64().unwrap_or(0) as usize).min(out.len());
        let end = (start + e["deleteCount"].as_u64().unwrap_or(0) as usize).min(out.len());
        let data: Vec<u32> = e["data"].as_array().into_iter().flatten().filter_map(Value::as_u64).map(|v| v as u32).collect();
        out.splice(start..end, data);
    }
    out
}

/// tsserver's token types and modifiers (VS Code's TypeScript extension legend).
pub const TS_TYPES: [&str; 12] = ["class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable", "enumMember", "property", "function", "method"];
pub const TS_MODIFIERS: [&str; 6] = ["declaration", "static", "async", "readonly", "defaultLibrary", "local"];

/// tsserver spans [offset, length, classification]* over the whole text (UTF-16 offsets, "\n" line breaks) -> tokens.
pub fn decode_ts(spans: &[u64], lines: &[String]) -> Tokens {
    let mut starts = Vec::with_capacity(lines.len()); // UTF-16 offset of each line
    let mut at = 0usize;
    for l in lines {
        starts.push(at);
        at += l.encode_utf16().count() + 1;
    }
    let mut items = vec![];
    for s in spans.chunks_exact(3) {
        let (off, len, class) = (s[0] as usize, s[1] as usize, s[2] as u32);
        let ty = (class >> 8) as usize;
        if ty == 0 || ty > TS_TYPES.len() {
            continue;
        }
        let line = starts.partition_point(|&x| x <= off).saturating_sub(1);
        items.push((line, off - starts[line], len, ty - 1, class & 255));
    }
    Tokens { types: TS_TYPES.map(String::from).to_vec(), modifiers: TS_MODIFIERS.map(String::from).to_vec(), items }
}

/// VS Code's default semantic token -> TextMate scopes (tokenClassificationRegistry), most specific first.
fn default_scopes(ty: &str, mods: &[&str]) -> &'static [&'static str] {
    let has = |m: &str| mods.contains(&m);
    match ty {
        "variable" if has("readonly") && has("defaultLibrary") => &["support.constant"],
        "property" if has("readonly") && has("defaultLibrary") => &["support.constant.property"],
        "variable" if has("readonly") => &["variable.other.constant"],
        "property" if has("readonly") => &["variable.other.constant.property"],
        "type" if has("defaultLibrary") => &["support.type"],
        "class" if has("defaultLibrary") => &["support.class"],
        "function" if has("defaultLibrary") => &["support.function"],
        "variable" if has("defaultLibrary") => &["support.variable"],
        "comment" => &["comment"],
        "string" => &["string"],
        "keyword" => &["keyword.control"],
        "number" => &["constant.numeric"],
        "regexp" => &["constant.regexp"],
        "operator" => &["keyword.operator"],
        "namespace" => &["entity.name.namespace"],
        "type" => &["entity.name.type", "support.type"],
        "struct" => &["entity.name.type.struct"],
        "class" => &["entity.name.type.class", "support.class"],
        "interface" => &["entity.name.type.interface"],
        "enum" => &["entity.name.type.enum"],
        "typeParameter" => &["entity.name.type.parameter"],
        "function" => &["entity.name.function", "support.function"],
        "member" | "method" => &["entity.name.function.member", "support.function"],
        "macro" => &["entity.name.function.preprocessor"],
        "variable" => &["variable.other.readwrite", "entity.name.variable"],
        "parameter" => &["variable.parameter"],
        "property" => &["variable.other.property"],
        "enumMember" => &["variable.other.enummember"],
        "event" => &["variable.other.event"],
        "decorator" => &["entity.name.decorator", "entity.name.function"],
        _ => &[],
    }
}

/// (foreground, font style bits) of a style value: "#rrggbb" or { foreground, fontStyle | bold, italic, … }.
fn style_of(v: &Value) -> (Option<String>, Option<u32>) {
    if let Some(c) = v.as_str() {
        return (crate::paint::opaque(Some(c)), None);
    }
    let fg = crate::paint::opaque(v["foreground"].as_str());
    let mut style = v["fontStyle"].as_str().map(|s| {
        s.split(' ').fold(0, |acc, seg| acc | match seg {
            "italic" => 1,
            "bold" => 2,
            "underline" => 4,
            "strikethrough" => 8,
            _ => 0,
        })
    });
    for (k, bit) in [("italic", 1), ("bold", 2), ("underline", 4), ("strikethrough", 8)] {
        if let Some(on) = v[k].as_bool() {
            let s = style.get_or_insert(0);
            *s = if on { *s | bit } else { *s & !bit };
        }
    }
    (fg, style)
}

/// The theme's semantic colors, None when it doesn't enable semantic highlighting.
pub struct SemanticTheme {
    rules: Vec<(String, Vec<String>, Option<String>, Value)>,
    theme: Theme,
    cache: HashMap<(String, String), Option<(String, u32)>>,
}

impl SemanticTheme {
    pub fn of(theme: &Value) -> Option<SemanticTheme> {
        if theme["semanticHighlighting"] != Value::Bool(true) {
            return None;
        }
        let mut rules = vec![];
        for (sel, v) in theme["semanticTokenColors"].as_object().into_iter().flatten() {
            let (sel, lang) = match sel.split_once(':') {
                Some((s, l)) => (s, Some(l.to_string())),
                None => (sel.as_str(), None),
            };
            let mut parts = sel.split('.');
            let ty = parts.next().unwrap_or("*").to_string();
            rules.push((ty, parts.map(str::to_string).collect(), lang, v.clone()));
        }
        let colors = &theme["colors"];
        let mut settings = vec![serde_json::json!({ "settings": { "foreground": colors.get("editor.foreground"), "background": colors.get("editor.background") } })];
        settings.extend(theme["tokenColors"].as_array().cloned().unwrap_or_default());
        let theme = Theme::from_raw(&serde_json::json!({ "settings": settings }));
        Some(SemanticTheme { rules, theme, cache: HashMap::new() })
    }

    /// Each line's colored spans (byte offsets) for `tokens`; tokens without a style keep the TextMate colors.
    pub fn spans(&mut self, tokens: &Tokens, lines: &[String], language: &str) -> Vec<Vec<Span>> {
        let mut out: Vec<Vec<Span>> = vec![vec![]; lines.len()];
        for &(line, start, len, ty, bits) in &tokens.items {
            let (Some(text), Some(name)) = (lines.get(line), tokens.types.get(ty)) else { continue };
            let mods: Vec<&str> = tokens.modifiers.iter().enumerate().filter(|(i, _)| bits & (1 << i) != 0).map(|(_, m)| m.as_str()).collect();
            if let Some((fg, style)) = self.style(name, &mods, language) {
                out[line].push(Span { start: byte_of(text, start), end: byte_of(text, start + len), fg, style });
            }
        }
        out
    }

    /// The color and font style of a token, None to keep the TextMate colors.
    pub fn style(&mut self, ty: &str, mods: &[&str], language: &str) -> Option<(String, u32)> {
        let key = (ty.to_string(), format!("{}:{language}", mods.join(".")));
        if let Some(v) = self.cache.get(&key) {
            return v.clone();
        }
        let v = self.compute(ty, mods, language);
        self.cache.insert(key, v.clone());
        v
    }

    fn compute(&self, ty: &str, mods: &[&str], language: &str) -> Option<(String, u32)> {
        // semanticTokenColors: the most specific matching selector wins, per attribute
        let (mut fg, mut style, mut best_fg, mut best_style) = (None, None, -1i32, -1i32);
        for (rt, rm, rl, v) in &self.rules {
            let ok = (rt == "*" || rt == ty) && rm.iter().all(|m| mods.contains(&m.as_str())) && rl.as_deref().is_none_or(|l| l == language);
            if !ok {
                continue;
            }
            let score = if rt == "*" { 0 } else { 100 } + if rl.is_some() { 10 } else { 0 } + rm.len() as i32;
            let (f, s) = style_of(v);
            if f.is_some() && score > best_fg {
                (fg, best_fg) = (f, score);
            }
            if s.is_some() && score > best_style {
                (style, best_style) = (s, score);
            }
        }
        if fg.is_none() && style.is_none() {
            let set = |a: &vscode_textmate::StyleAttributes| a.foreground_id != 0 || a.font_style != FONT_STYLE_NOT_SET;
            let attrs = default_scopes(ty, mods).iter().find_map(|s| self.theme.match_scope(s, std::iter::empty()).filter(set))?;
            let color = self.theme.color_map().get(attrs.foreground_id as usize).cloned().flatten();
            fg = color.map(|c| c[..7.min(c.len())].to_lowercase()).filter(|_| attrs.foreground_id != 0);
            style = (attrs.font_style != FONT_STYLE_NOT_SET).then_some(attrs.font_style as u32);
        }
        let fg = fg?;
        Some((fg, style.unwrap_or(0)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lsp_data_and_deltas_decode_to_absolute_tokens() {
        let types = vec!["variable".to_string(), "function".to_string()];
        let t = decode_lsp(&[0, 4, 3, 1, 0, 0, 5, 1, 0, 1, 2, 2, 2, 0, 0], &types, &[]);
        assert_eq!(t.items, [(0, 4, 3, 1, 0), (0, 9, 1, 0, 1), (2, 2, 2, 0, 0)]);
        let d = apply_delta(&[1, 2, 3, 4, 5], &json!([{ "start": 1, "deleteCount": 2, "data": [9] }]));
        assert_eq!(d, [1, 9, 4, 5]);
    }

    #[test]
    fn tsserver_offsets_land_on_their_lines() {
        let lines = vec!["let a;".to_string(), "f(a);".to_string()];
        let t = decode_ts(&[4, 1, (8 << 8) | 1, 7, 1, 11 << 8], &lines);
        assert_eq!(t.items, [(0, 4, 1, 7, 1), (1, 0, 1, 10, 0)]);
        assert_eq!(t.types[7], "variable");
    }

    #[test]
    fn colors_come_from_semantic_token_colors_else_the_scope_map_and_only_when_enabled() {
        let theme = json!({
            "semanticHighlighting": true,
            "colors": { "editor.foreground": "#abb2bf" },
            "semanticTokenColors": { "variable.readonly": "#ff0000", "parameter": { "foreground": "#00ff00", "italic": true } },
            "tokenColors": [{ "scope": "entity.name.function", "settings": { "foreground": "#61afef", "fontStyle": "bold" } }]
        });
        let mut st = SemanticTheme::of(&theme).unwrap();
        assert_eq!(st.style("variable", &["readonly", "local"], "typescript"), Some(("#ff0000".into(), 0)));
        assert_eq!(st.style("parameter", &[], "rust"), Some(("#00ff00".into(), 1)));
        assert_eq!(st.style("function", &[], "rust"), Some(("#61afef".into(), 2)));
        assert_eq!(st.style("variable", &[], "rust"), None, "no rule: the TextMate colors stay");
        assert!(SemanticTheme::of(&json!({ "tokenColors": [] })).is_none(), "off unless the theme turns it on");
        let lines = vec!["let 한 = f(p);".to_string()];
        let t = Tokens { types: vec!["variable".into(), "function".into(), "parameter".into()], modifiers: vec!["readonly".into()], items: vec![(0, 4, 1, 0, 1), (0, 8, 1, 1, 0), (0, 10, 1, 2, 0), (0, 0, 3, 0, 0)] };
        let spans = st.spans(&t, &lines, "rust");
        let got: Vec<(usize, usize, &str, u32)> = spans[0].iter().map(|s| (s.start, s.end, s.fg.as_str(), s.style)).collect();
        assert_eq!(got, [(4, 7, "#ff0000", 0), (10, 11, "#61afef", 2), (12, 13, "#00ff00", 1)], "byte offsets; `let` (a plain variable) keeps its TextMate color");
    }
}
