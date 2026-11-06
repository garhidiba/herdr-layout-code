//! theme.ts: raw theme → sorted rules → a trie keyed on scope segments, a color map whose ids are assigned in
//! the same order as the JS (so `getColorMap()` indexes match), and parent-scope matching.

use serde_json::Value;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::rc::Rc;

pub const FONT_STYLE_NOT_SET: i32 = -1;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StyleAttributes {
    pub font_style: i32,
    pub foreground_id: u32,
    pub background_id: u32,
}

struct ParsedRule {
    scope: String,
    parent_scopes: Option<Vec<String>>,
    index: usize,
    font_style: i32,
    foreground: Option<String>,
    background: Option<String>,
}

#[derive(Clone)]
struct TrieRule {
    scope_depth: usize,
    parent_scopes: Rc<Vec<String>>,
    font_style: i32,
    foreground: u32,
    background: u32,
}

#[derive(Clone)]
struct TrieElement {
    main: TrieRule,
    with_parents: Vec<TrieRule>,
    children: HashMap<String, TrieElement>,
}

pub struct Theme {
    color_map: Vec<Option<String>>,
    defaults: StyleAttributes,
    root: TrieElement,
    cache: RefCell<HashMap<String, Rc<Vec<TrieRule>>>>,
}

/// JavaScript string comparison (UTF-16 code units).
fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn str_arr_cmp(a: Option<&[String]>, b: Option<&[String]>) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, _) => Ordering::Less,
        (_, None) => Ordering::Greater,
        (Some(a), Some(b)) if a.len() == b.len() => a.iter().zip(b).map(|(x, y)| js_cmp(x, y)).find(|o| o.is_ne()).unwrap_or(Ordering::Equal),
        (Some(a), Some(b)) => a.len().cmp(&b.len()),
    }
}

fn is_valid_hex_color(s: &str) -> bool {
    s.strip_prefix('#').is_some_and(|h| matches!(h.len(), 3 | 4 | 6 | 8) && h.bytes().all(|c| c.is_ascii_hexdigit()))
}

fn parse_theme(raw: &Value) -> Vec<ParsedRule> {
    let Some(settings) = raw.get("settings").and_then(Value::as_array) else { return vec![] };
    let mut out = vec![];
    for (i, entry) in settings.iter().enumerate() {
        let Some(s) = entry.get("settings").filter(|s| !matches!(s, Value::Null | Value::Bool(false))) else { continue };
        let scopes: Vec<String> = match entry.get("scope") {
            Some(Value::String(sc)) => sc.trim_start_matches(',').trim_end_matches(',').split(',').map(str::to_string).collect(),
            Some(Value::Array(a)) => a.iter().map(|v| v.as_str().unwrap_or_default().to_string()).collect(),
            _ => vec![String::new()],
        };
        let font_style = match s.get("fontStyle").and_then(Value::as_str) {
            Some(fs) => fs.split(' ').fold(0, |acc, seg| {
                acc | match seg {
                    "italic" => 1,
                    "bold" => 2,
                    "underline" => 4,
                    "strikethrough" => 8,
                    _ => 0,
                }
            }),
            None => FONT_STYLE_NOT_SET,
        };
        let color = |k: &str| s.get(k).and_then(Value::as_str).filter(|c| is_valid_hex_color(c)).map(str::to_string);
        let (foreground, background) = (color("foreground"), color("background"));
        for scope in scopes {
            let segments: Vec<&str> = scope.trim_matches(crate::rule::js_space).split(' ').collect();
            let parent_scopes = (segments.len() > 1).then(|| segments[..segments.len() - 1].iter().rev().map(|s| s.to_string()).collect());
            out.push(ParsedRule { scope: segments[segments.len() - 1].to_string(), parent_scopes, index: i, font_style, foreground: foreground.clone(), background: background.clone() });
        }
    }
    out
}

struct ColorMap {
    id2color: Vec<Option<String>>,
    color2id: HashMap<String, u32>,
}

impl ColorMap {
    fn id(&mut self, color: Option<&str>) -> u32 {
        let Some(color) = color else { return 0 };
        let color = color.to_uppercase();
        if let Some(&v) = self.color2id.get(&color) {
            return v;
        }
        let v = self.id2color.len() as u32;
        self.color2id.insert(color.clone(), v);
        self.id2color.push(Some(color));
        v
    }
}

impl TrieRule {
    fn accept_overwrite(&mut self, depth: usize, font_style: i32, fg: u32, bg: u32) {
        self.scope_depth = self.scope_depth.max(depth);
        if font_style != FONT_STYLE_NOT_SET {
            self.font_style = font_style;
        }
        if fg != 0 {
            self.foreground = fg;
        }
        if bg != 0 {
            self.background = bg;
        }
    }
}

fn cmp_by_specificity(a: &TrieRule, b: &TrieRule) -> Ordering {
    if a.scope_depth != b.scope_depth {
        return b.scope_depth.cmp(&a.scope_depth);
    }
    let (mut ai, mut bi) = (0, 0);
    loop {
        if a.parent_scopes.get(ai).is_some_and(|s| s == ">") {
            ai += 1;
        }
        if b.parent_scopes.get(bi).is_some_and(|s| s == ">") {
            bi += 1;
        }
        if ai >= a.parent_scopes.len() || bi >= b.parent_scopes.len() {
            break;
        }
        let diff = b.parent_scopes[bi].encode_utf16().count() as i64 - a.parent_scopes[ai].encode_utf16().count() as i64;
        if diff != 0 {
            return diff.cmp(&0);
        }
        ai += 1;
        bi += 1;
    }
    b.parent_scopes.len().cmp(&a.parent_scopes.len())
}

fn split_head(scope: &str) -> (&str, &str) {
    scope.split_once('.').unwrap_or((scope, ""))
}

impl TrieElement {
    fn matches(&self, scope: &str) -> Vec<TrieRule> {
        if !scope.is_empty() {
            let (head, tail) = split_head(scope);
            if let Some(child) = self.children.get(head) {
                return child.matches(tail);
            }
        }
        let mut rules: Vec<TrieRule> = self.with_parents.iter().cloned().chain(std::iter::once(self.main.clone())).collect();
        rules.sort_by(cmp_by_specificity);
        rules
    }

    fn insert(&mut self, depth: usize, scope: &str, parents: Option<&[String]>, font_style: i32, fg: u32, bg: u32) {
        if scope.is_empty() {
            return self.insert_here(depth, parents, font_style, fg, bg);
        }
        let (head, tail) = split_head(scope);
        if !self.children.contains_key(head) {
            let child = TrieElement { main: self.main.clone(), with_parents: self.with_parents.clone(), children: HashMap::new() };
            self.children.insert(head.to_string(), child);
        }
        self.children.get_mut(head).unwrap().insert(depth + 1, tail, parents, font_style, fg, bg);
    }

    fn insert_here(&mut self, depth: usize, parents: Option<&[String]>, mut font_style: i32, mut fg: u32, mut bg: u32) {
        let Some(parents) = parents else { return self.main.accept_overwrite(depth, font_style, fg, bg) };
        if let Some(rule) = self.with_parents.iter_mut().find(|r| str_arr_cmp(Some(&r.parent_scopes), Some(parents)).is_eq()) {
            return rule.accept_overwrite(depth, font_style, fg, bg);
        }
        if font_style == FONT_STYLE_NOT_SET {
            font_style = self.main.font_style;
        }
        if fg == 0 {
            fg = self.main.foreground;
        }
        if bg == 0 {
            bg = self.main.background;
        }
        self.with_parents.push(TrieRule { scope_depth: depth, parent_scopes: Rc::new(parents.to_vec()), font_style, foreground: fg, background: bg });
    }
}

fn matches_scope(name: &str, pattern: &str) -> bool {
    name == pattern || (name.starts_with(pattern) && name.as_bytes().get(pattern.len()) == Some(&b'.'))
}

/// `_scopePathMatchesParentScopes`, over the scope names from the parent up to the root.
fn parent_scopes_match<'a>(mut path: impl Iterator<Item = &'a str>, parents: &[String]) -> bool {
    let mut index = 0;
    while index < parents.len() {
        let mut pattern = parents[index].as_str();
        let mut must_match = false;
        if pattern == ">" {
            if index == parents.len() - 1 {
                return false;
            }
            index += 1;
            pattern = &parents[index];
            must_match = true;
        }
        loop {
            match path.next() {
                None => return false,
                Some(name) if matches_scope(name, pattern) => break,
                Some(_) if must_match => return false,
                Some(_) => {}
            }
        }
        index += 1;
    }
    true
}

impl Theme {
    /// `Theme.createFromRawTheme(source)` (no fixed color map).
    pub fn from_raw(raw: &Value) -> Theme {
        let mut rules = parse_theme(raw);
        rules.sort_by(|a, b| js_cmp(&a.scope, &b.scope).then_with(|| str_arr_cmp(a.parent_scopes.as_deref(), b.parent_scopes.as_deref())).then(a.index.cmp(&b.index)));
        let (mut font_style, mut fg, mut bg) = (0, "#000000".to_string(), "#ffffff".to_string());
        let mut first = 0;
        while first < rules.len() && rules[first].scope.is_empty() {
            let d = &rules[first];
            if d.font_style != FONT_STYLE_NOT_SET {
                font_style = d.font_style;
            }
            if let Some(c) = &d.foreground {
                fg = c.clone();
            }
            if let Some(c) = &d.background {
                bg = c.clone();
            }
            first += 1;
        }
        let mut colors = ColorMap { id2color: vec![None], color2id: HashMap::new() };
        let defaults = StyleAttributes { font_style, foreground_id: colors.id(Some(&fg)), background_id: colors.id(Some(&bg)) };
        let main = TrieRule { scope_depth: 0, parent_scopes: Rc::new(vec![]), font_style: FONT_STYLE_NOT_SET, foreground: 0, background: 0 };
        let mut root = TrieElement { main, with_parents: vec![], children: HashMap::new() };
        for r in &rules[first..] {
            let (f, b) = (colors.id(r.foreground.as_deref()), colors.id(r.background.as_deref()));
            root.insert(0, &r.scope, r.parent_scopes.as_deref(), r.font_style, f, b);
        }
        Theme { color_map: colors.id2color, defaults, root, cache: RefCell::new(HashMap::new()) }
    }

    /// `getColorMap()`: index 0 is unused (`undefined` in the JS array).
    pub fn color_map(&self) -> &[Option<String>] {
        &self.color_map
    }

    pub fn defaults(&self) -> StyleAttributes {
        self.defaults
    }

    /// `match(scopePath)` for the path `parents…, scope_name`; `parents` yields names from the nearest up.
    pub fn match_scope<'a>(&self, scope_name: &str, parents: impl Iterator<Item = &'a str>) -> Option<StyleAttributes> {
        let rules = {
            let mut cache = self.cache.borrow_mut();
            match cache.get(scope_name) {
                Some(r) => r.clone(),
                None => cache.entry(scope_name.to_string()).or_insert_with(|| Rc::new(self.root.matches(scope_name))).clone(),
            }
        };
        // The parent path is walked only when a rule has parent scopes (most don't).
        let (mut parents, mut path) = (Some(parents), None::<Vec<&str>>);
        rules
            .iter()
            .find(|r| r.parent_scopes.is_empty() || parent_scopes_match(path.get_or_insert_with(|| parents.take().into_iter().flatten().collect()).iter().copied(), &r.parent_scopes))
            .map(TrieRule::style)
    }
}

impl TrieRule {
    fn style(&self) -> StyleAttributes {
        StyleAttributes { font_style: self.font_style, foreground_id: self.foreground, background_id: self.background }
    }
}
