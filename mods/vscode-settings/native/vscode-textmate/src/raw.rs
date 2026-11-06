//! Raw grammars (rawGrammar.ts, parseRawGrammar.ts, plist.ts): JSON and plist `.tmLanguage` files to a tree of
//! rules. Rules are `Rc`s because vscode-textmate keys compiled rule ids on the rule *objects* (`desc.id`): a rule
//! shared through a merged repository is compiled once, and `initGrammar`'s deep clone gives each grammar its own.

use serde_json::{Map, Value};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

pub type Repository = HashMap<String, Rc<RawRule>>;
pub type RawCaptures = Vec<(String, Rc<RawRule>)>;

#[derive(Default)]
pub struct RawRule {
    /// The compiled rule id (0: not compiled yet).
    pub id: Cell<u32>,
    pub include: Option<String>,
    pub name: Option<String>,
    pub content_name: Option<String>,
    pub match_: Option<String>,
    pub captures: Option<RawCaptures>,
    /// `Some` when the key is present (vscode-textmate tests `typeof begin === 'undefined'`).
    pub begin: Option<String>,
    pub begin_captures: Option<RawCaptures>,
    pub end: Option<String>,
    pub end_captures: Option<RawCaptures>,
    pub while_: Option<String>,
    pub while_captures: Option<RawCaptures>,
    pub patterns: Option<Vec<Rc<RawRule>>>,
    pub repository: Option<Repository>,
    pub apply_end_pattern_last: bool,
}

pub struct RawGrammar {
    pub scope_name: String,
    pub patterns: Option<Vec<Rc<RawRule>>>,
    pub repository: Option<Repository>,
    pub injections: Option<Vec<(String, Rc<RawRule>)>>,
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// A string field that vscode-textmate reads with `x || null` / `if (x)`.
fn text(o: &Map<String, Value>, key: &str) -> Option<String> {
    o.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn rules(v: Option<&Value>) -> Option<Vec<Rc<RawRule>>> {
    v.and_then(Value::as_array).map(|a| a.iter().map(RawRule::from_value).collect())
}

/// An object's entries in JavaScript `for…in` order: array-index keys ascending, then the rest as written.
/// It decides which compiled rule gets which id, so the rule stacks match the JS ones id for id.
fn js_entries(o: &Map<String, Value>) -> Vec<(String, Rc<RawRule>)> {
    let index = |k: &str| k.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == k);
    let mut keys: Vec<(&String, &Value)> = o.iter().collect();
    keys.sort_by_key(|(k, _)| index(k).map_or((1, 0), |n| (0, n)));
    keys.into_iter().map(|(k, v)| (k.clone(), RawRule::from_value(v))).collect()
}

fn captures(v: Option<&Value>) -> Option<RawCaptures> {
    match v? {
        Value::Object(o) => Some(js_entries(o)),
        Value::Array(a) => Some(a.iter().enumerate().map(|(i, v)| (i.to_string(), RawRule::from_value(v))).collect()),
        _ => None,
    }
}

fn repository(v: Option<&Value>) -> Option<Repository> {
    v.and_then(Value::as_object).map(|o| o.iter().map(|(k, v)| (k.clone(), RawRule::from_value(v))).collect())
}

impl RawRule {
    pub fn from_value(v: &Value) -> Rc<RawRule> {
        let Some(o) = v.as_object() else { return Rc::new(RawRule::default()) };
        Rc::new(RawRule {
            id: Cell::new(0),
            include: text(o, "include"),
            name: text(o, "name"),
            content_name: text(o, "contentName"),
            match_: text(o, "match"),
            captures: captures(o.get("captures")),
            begin: o.get("begin").map(|b| b.as_str().unwrap_or_default().to_string()),
            begin_captures: captures(o.get("beginCaptures")),
            end: text(o, "end"),
            end_captures: captures(o.get("endCaptures")),
            while_: text(o, "while"),
            while_captures: captures(o.get("whileCaptures")),
            patterns: rules(o.get("patterns")),
            repository: repository(o.get("repository")),
            apply_end_pattern_last: o.get("applyEndPatternLast").is_some_and(truthy),
        })
    }
}

impl RawGrammar {
    /// A fresh tree (new rule identities) from the parsed file.
    pub fn from_value(v: &Value) -> RawGrammar {
        let empty = Map::new();
        let o = v.as_object().unwrap_or(&empty);
        RawGrammar {
            scope_name: o.get("scopeName").and_then(Value::as_str).unwrap_or_default().to_string(),
            patterns: rules(o.get("patterns")),
            repository: repository(o.get("repository")),
            injections: o.get("injections").and_then(Value::as_object).map(js_entries),
        }
    }
}

/// `parseRawGrammar(content, path)`: JSON for `*.json`, plist otherwise.
pub fn parse_raw_grammar(content: &str, path: &str) -> Result<Value, String> {
    if path.ends_with(".json") {
        serde_json::from_str(content).map_err(|e| format!("{path}: {e}"))
    } else {
        parse_plist(content).map_err(|e| format!("{path}: {e}"))
    }
}

/// vscode-textmate's `loose` reader for VS Code's JSONC (theme.json): comments outside strings removed, then
/// every `,` before `}`/`]` dropped (even inside strings, as the JS regex does).
pub fn parse_jsonc(s: &str) -> Result<Value, String> {
    let s = s.strip_prefix('\u{feff}').unwrap_or(s);
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => match s[i + 2..].find("*/") {
                Some(k) => {
                    out.push_str(&s[last..i]);
                    i += k + 4;
                    last = i;
                }
                None => i += 1,
            },
            b'/' if b.get(i + 1) == Some(&b'/') => {
                out.push_str(&s[last..i]);
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                last = i;
            }
            _ => i += 1,
        }
    }
    out.push_str(&s[last.min(s.len())..]);
    let mut cleaned = String::with_capacity(out.len());
    let ob = out.as_bytes();
    let mut j = 0;
    while j < ob.len() {
        if ob[j] == b',' {
            let k = j + 1 + ob[j + 1..].iter().take_while(|c| c.is_ascii_whitespace() || **c == 0x0b || **c == 0x0c).count();
            if matches!(ob.get(k), Some(b'}') | Some(b']')) {
                j += 1;
                continue;
            }
        }
        let ch_len = out[j..].chars().next().map_or(1, char::len_utf8);
        cleaned.push_str(&out[j..j + ch_len]);
        j += ch_len;
    }
    serde_json::from_str(&cleaned).map_err(|e| e.to_string())
}

/// plist.ts's `escapeVal`.
fn unescape_xml(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(k) = rest.find('&') {
        out.push_str(&rest[..k]);
        rest = &rest[k..];
        let end = rest.find(';').unwrap_or(0);
        let entity = &rest[1..end.max(1)];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32),
            _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) if end > 0 => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A plist reader for TextMate grammars: dict, array, key, string, integer, real, true, false.
pub fn parse_plist(content: &str) -> Result<Value, String> {
    let mut p = Plist { s: content.strip_prefix('\u{feff}').unwrap_or(content), pos: 0 };
    loop {
        let tag = p.next_tag()?.ok_or("no root dict")?;
        if tag.0 == "dict" || tag.0 == "array" {
            return p.value(tag);
        }
    }
}

struct Plist<'a> {
    s: &'a str,
    pos: usize,
}

impl Plist<'_> {
    /// The next element tag as (name, self-closing), skipping `<?…?>`, `<!…>` and `<plist>`; `/name` for a close.
    fn next_tag(&mut self) -> Result<Option<(String, bool)>, String> {
        loop {
            let Some(k) = self.s[self.pos..].find('<') else { return Ok(None) };
            self.pos += k;
            let rest = &self.s[self.pos..];
            if rest.starts_with("<?") || rest.starts_with("<!") {
                let close = if rest.starts_with("<!--") { "-->" } else { ">" };
                self.pos += rest.find(close).ok_or("unclosed markup")? + close.len();
                continue;
            }
            let end = rest.find('>').ok_or("unclosed tag")?;
            let inner = &rest[1..end];
            self.pos += end + 1;
            let closed = inner.ends_with('/');
            let name = inner.trim_end_matches('/').split_whitespace().next().unwrap_or("").to_string();
            if name == "plist" || name == "/plist" {
                continue;
            }
            return Ok(Some((name, closed)));
        }
    }

    fn text_until_close(&mut self, name: &str) -> Result<String, String> {
        let close = format!("</{name}>");
        let k = self.s[self.pos..].find(&close).ok_or_else(|| format!("missing {close}"))?;
        let t = unescape_xml(&self.s[self.pos..self.pos + k]);
        self.pos += k + close.len();
        Ok(t)
    }

    fn value(&mut self, (name, closed): (String, bool)) -> Result<Value, String> {
        Ok(match name.as_str() {
            "dict" => {
                let mut m = Map::new();
                if !closed {
                    loop {
                        let tag = self.next_tag()?.ok_or("unclosed dict")?;
                        if tag.0 == "/dict" {
                            break;
                        }
                        if tag.0 != "key" {
                            return Err(format!("expected key, got {}", tag.0));
                        }
                        let key = if tag.1 { String::new() } else { self.text_until_close("key")? };
                        let v = self.next_tag()?.ok_or("missing value")?;
                        m.insert(key, self.value(v)?);
                    }
                }
                Value::Object(m)
            }
            "array" => {
                let mut a = vec![];
                if !closed {
                    loop {
                        let tag = self.next_tag()?.ok_or("unclosed array")?;
                        if tag.0 == "/array" {
                            break;
                        }
                        a.push(self.value(tag)?);
                    }
                }
                Value::Array(a)
            }
            "string" | "key" | "data" | "date" => Value::String(if closed { String::new() } else { self.text_until_close(&name)? }),
            "integer" | "real" => {
                let t = if closed { String::new() } else { self.text_until_close(&name)? };
                t.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
            }
            "true" | "false" => {
                if !closed {
                    self.text_until_close(&name)?;
                }
                Value::Bool(name == "true")
            }
            other => return Err(format!("unexpected tag {other}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc_drops_comments_outside_strings_and_trailing_commas() {
        let v = parse_jsonc("\u{feff}{ // c\n \"a\": \"x//y\", /* b */ \"b\": [1, 2,],\n}").unwrap();
        assert_eq!(v, serde_json::json!({ "a": "x//y", "b": [1, 2] }));
    }

    #[test]
    fn plist_reads_nested_dicts_arrays_and_entities() {
        let v = parse_plist("<?xml version=\"1.0\"?><!DOCTYPE plist><plist><dict><key>a</key><string>x &lt;y&gt; &#65;</string><key>b</key><array><true/><dict/></array><key>n</key><integer>3</integer></dict></plist>").unwrap();
        assert_eq!(v, serde_json::json!({ "a": "x <y> A", "b": [true, {}], "n": 3.0 }));
    }

    #[test]
    fn rules_follow_javascript_truthiness() {
        let r = RawRule::from_value(&serde_json::json!({ "match": "", "name": "", "begin": "", "applyEndPatternLast": 1, "captures": ["x"] }));
        assert!(r.match_.is_none() && r.name.is_none());
        assert_eq!(r.begin.as_deref(), Some(""));
        assert!(r.apply_end_pattern_last);
        assert_eq!(r.captures.as_ref().unwrap()[0].0, "0");
    }
}
