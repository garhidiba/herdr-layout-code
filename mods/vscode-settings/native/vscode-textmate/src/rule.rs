//! rule.ts and the regex-source helpers of utils.ts. Offsets are UTF-8 byte offsets into the line.

use crate::onig::{OnigString, Scanner};
use std::borrow::Cow;
use std::cell::RefCell;

pub const END_RULE_ID: i32 = -1;
pub const WHILE_RULE_ID: i32 = -2;

pub type Captures = [(i32, i32)];

/// `lineText.substring(start, end)`: negative offsets clamp to 0, reversed bounds swap.
pub fn substring(s: &str, start: i32, end: i32) -> &str {
    let clamp = |x: i32| (x.max(0) as usize).min(s.len());
    let (a, b) = (clamp(start), clamp(end));
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    s.get(a..b).unwrap_or("")
}

/// JavaScript's `\s`.
pub fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `escapeRegExpCharacters`.
pub fn escape_regexp(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for c in value.chars() {
        if "-\\{}*+?|^$.,[]()#".contains(c) || js_space(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// One `$n` / `${n:/downcase}` / `${n:/upcase}` at the start of `s`: (length, group, command).
fn capture_ref(s: &str) -> Option<(usize, &str, &str)> {
    let b = s.as_bytes();
    if b.first() != Some(&b'$') {
        return None;
    }
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let n = digits(1);
    if n > 0 {
        return Some((1 + n, &s[1..1 + n], ""));
    }
    if b.get(1) != Some(&b'{') {
        return None;
    }
    let n = digits(2);
    let rest = &s[2 + n..];
    if n == 0 || !rest.starts_with(":/") {
        return None;
    }
    let cmd = ["downcase", "upcase"].into_iter().find(|c| rest[2..].starts_with(c) && rest[2 + c.len()..].starts_with('}'))?;
    Some((2 + n + 2 + cmd.len() + 1, &s[2..2 + n], cmd))
}

/// `RegexSource.hasCaptures`.
pub fn has_captures(s: &str) -> bool {
    s.char_indices().any(|(i, _)| capture_ref(&s[i..]).is_some())
}

/// `RegexSource.replaceCaptures`.
pub fn replace_captures(source: &str, line: &str, captures: &Captures) -> String {
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < source.len() {
        if let Some((len, group, cmd)) = capture_ref(&source[i..]) {
            match group.parse::<usize>().ok().and_then(|g| captures.get(g)) {
                Some(&(start, end)) => {
                    let text = substring(line, start, end).trim_start_matches('.');
                    match cmd {
                        "downcase" => out.push_str(&text.to_lowercase()),
                        "upcase" => out.push_str(&text.to_uppercase()),
                        _ => out.push_str(text),
                    }
                }
                None => out.push_str(&source[i..i + len]),
            }
            i += len;
        } else {
            let c = source[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// `\` followed by digits (`/\\(\d+)/`), as (byte range, digits).
fn back_references(s: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    let b = s.as_bytes();
    (0..b.len()).filter_map(move |i| {
        if b[i] != b'\\' {
            return None;
        }
        let n = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        (n > 0).then(|| (i, i + 1 + n, &s[i + 1..i + 1 + n]))
    })
}

#[derive(Clone)]
pub struct RegExpSource {
    pub source: String,
    pub rule_id: i32,
    has_anchor: bool,
    pub has_back_references: bool,
    /// Sources for (allowA, allowG) = (0,0), (0,1), (1,0), (1,1): disallowed `\A`/`\G` become U+FFFF.
    anchor_cache: Option<Box<[String; 4]>>,
}

impl RegExpSource {
    pub fn new(source: &str, rule_id: i32) -> Self {
        let mut has_anchor = false;
        let mut out = String::new();
        let mut last = 0;
        let mut it = source.char_indices().peekable();
        while let Some((pos, ch)) = it.next() {
            if ch != '\\' {
                continue;
            }
            if let Some(&(_, next)) = it.peek() {
                if next == 'z' {
                    out.push_str(&source[last..pos]);
                    out.push_str("$(?!\\n)(?<!\\n)");
                    last = pos + 2;
                } else if next == 'A' || next == 'G' {
                    has_anchor = true;
                }
                it.next();
            }
        }
        let source = if last == 0 { source.to_string() } else { out + &source[last..] };
        let has_back_references = back_references(&source).next().is_some();
        let mut r = RegExpSource { has_back_references, source, rule_id, has_anchor, anchor_cache: None };
        r.build_anchor_cache();
        r
    }

    pub fn set_source(&mut self, source: &str) {
        if self.source != source {
            self.source = source.to_string();
            self.build_anchor_cache();
        }
    }

    fn build_anchor_cache(&mut self) {
        if !self.has_anchor {
            return;
        }
        let mut r: [String; 4] = Default::default();
        let mut it = self.source.chars().peekable();
        while let Some(ch) = it.next() {
            r.iter_mut().for_each(|s| s.push(ch));
            if ch != '\\' {
                continue;
            }
            if let Some(next) = it.next() {
                let x = '\u{FFFF}';
                let v = match next {
                    'A' => [x, x, 'A', 'A'],
                    'G' => [x, 'G', x, 'G'],
                    c => [c; 4],
                };
                r.iter_mut().zip(v).for_each(|(s, c)| s.push(c));
            }
        }
        self.anchor_cache = Some(Box::new(r));
    }

    fn resolve_anchors(&self, allow_a: bool, allow_g: bool) -> &str {
        match &self.anchor_cache {
            Some(c) => &c[allow_a as usize * 2 + allow_g as usize],
            None => &self.source,
        }
    }

    pub fn resolve_back_references(&self, line: &str, captures: &Captures) -> String {
        let mut out = String::with_capacity(self.source.len());
        let mut last = 0;
        for (a, b, digits) in back_references(&self.source) {
            if a < last {
                continue;
            }
            out.push_str(&self.source[last..a]);
            let value = digits.parse::<usize>().ok().and_then(|g| captures.get(g)).map_or("", |&(s, e)| substring(line, s, e));
            out.push_str(&escape_regexp(value));
            last = b;
        }
        out.push_str(&self.source[last..]);
        out
    }
}

pub struct CompiledRule {
    scanner: Scanner,
    rules: Vec<i32>,
}

impl CompiledRule {
    fn new(sources: Vec<String>, rules: Vec<i32>) -> Result<Self, String> {
        Ok(CompiledRule { scanner: Scanner::new(&sources)?, rules })
    }

    pub fn find_next_match(&mut self, s: &OnigString, pos: usize) -> Option<(i32, Vec<(i32, i32)>)> {
        self.scanner.find_next_match(s, pos).map(|m| (self.rules[m.index], m.captures))
    }
}

#[derive(Default)]
pub struct RegExpSourceList {
    items: Vec<RegExpSource>,
    has_anchors: bool,
    cached: Option<CompiledRule>,
    anchor_cache: [Option<CompiledRule>; 4],
}

impl RegExpSourceList {
    pub fn push(&mut self, item: RegExpSource) {
        self.has_anchors |= item.has_anchor;
        self.items.push(item);
    }

    pub fn unshift(&mut self, item: RegExpSource) {
        self.has_anchors |= item.has_anchor;
        self.items.insert(0, item);
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn set_source(&mut self, index: usize, source: &str) {
        if self.items[index].source != source {
            self.cached = None;
            self.anchor_cache = Default::default();
            self.items[index].set_source(source);
        }
    }

    pub fn compile_ag(&mut self, allow_a: bool, allow_g: bool) -> Result<&mut CompiledRule, String> {
        let rules = || self.items.iter().map(|e| e.rule_id).collect::<Vec<_>>();
        if !self.has_anchors {
            if self.cached.is_none() {
                self.cached = Some(CompiledRule::new(self.items.iter().map(|e| e.source.clone()).collect(), rules())?);
            }
            return Ok(self.cached.as_mut().unwrap());
        }
        let k = allow_a as usize * 2 + allow_g as usize;
        if self.anchor_cache[k].is_none() {
            self.anchor_cache[k] = Some(CompiledRule::new(self.items.iter().map(|e| e.resolve_anchors(allow_a, allow_g).to_string()).collect(), rules())?);
        }
        Ok(self.anchor_cache[k].as_mut().unwrap())
    }
}

pub enum RuleKind {
    Capture { retokenize: u32 },
    Match { regex: RegExpSource, captures: Vec<Option<u32>> },
    IncludeOnly { patterns: Vec<u32>, has_missing: bool },
    BeginEnd { begin: RegExpSource, begin_captures: Vec<Option<u32>>, end: RegExpSource, end_captures: Vec<Option<u32>>, apply_end_last: bool, patterns: Vec<u32>, has_missing: bool },
    BeginWhile { begin: RegExpSource, begin_captures: Vec<Option<u32>>, while_: RegExpSource, while_captures: Vec<Option<u32>>, patterns: Vec<u32>, has_missing: bool },
}

pub struct Rule {
    name: Option<String>,
    name_is_capturing: bool,
    content_name: Option<String>,
    content_name_is_capturing: bool,
    pub kind: RuleKind,
    /// `_cachedCompiledPatterns`.
    pub cache: RefCell<Option<RegExpSourceList>>,
    /// `_cachedCompiledWhilePatterns` (begin/while rules).
    pub while_cache: RefCell<Option<RegExpSourceList>>,
}

impl Rule {
    pub fn new(name: Option<String>, content_name: Option<String>, kind: RuleKind) -> Self {
        Rule {
            name_is_capturing: name.as_deref().is_some_and(has_captures),
            content_name_is_capturing: content_name.as_deref().is_some_and(has_captures),
            name,
            content_name,
            kind,
            cache: RefCell::new(None),
            while_cache: RefCell::new(None),
        }
    }

    pub fn name<'a>(&'a self, line: Option<&str>, captures: Option<&Captures>) -> Option<Cow<'a, str>> {
        let name = self.name.as_deref()?;
        match (self.name_is_capturing, line, captures) {
            (true, Some(l), Some(c)) => Some(Cow::Owned(replace_captures(name, l, c))),
            _ => Some(Cow::Borrowed(name)),
        }
    }

    pub fn content_name<'a>(&'a self, line: &str, captures: &Captures) -> Option<Cow<'a, str>> {
        let name = self.content_name.as_deref()?;
        Some(if self.content_name_is_capturing { Cow::Owned(replace_captures(name, line, captures)) } else { Cow::Borrowed(name) })
    }

    /// (patterns, hasMissingPatterns) for rules that have patterns.
    pub fn patterns(&self) -> Option<(&[u32], bool)> {
        match &self.kind {
            RuleKind::IncludeOnly { patterns, has_missing } | RuleKind::BeginEnd { patterns, has_missing, .. } | RuleKind::BeginWhile { patterns, has_missing, .. } => Some((patterns, *has_missing)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z_becomes_an_end_of_string_check_and_anchors_are_tracked() {
        let r = RegExpSource::new("a\\z|\\Gb\\\\G", 1);
        assert_eq!(r.source, "a$(?!\\n)(?<!\\n)|\\Gb\\\\G");
        assert_eq!(r.resolve_anchors(false, false), "a$(?!\\n)(?<!\\n)|\\\u{FFFF}b\\\\G");
        assert_eq!(r.resolve_anchors(true, true), r.source);
    }

    #[test]
    fn back_references_resolve_to_escaped_captured_text() {
        let r = RegExpSource::new("\\1\\2x", -1);
        assert!(r.has_back_references);
        assert_eq!(r.resolve_back_references("a.b c", &[(0, 5), (0, 3), (-1, -1)]), "a\\.bx");
    }

    #[test]
    fn capture_names_replace_groups_strip_leading_dots_and_change_case() {
        let caps = [(0, 6), (0, 3), (3, 6)];
        assert_eq!(replace_captures("x.$1.${2:/upcase}.$9", "..aBcD", &caps), "x.a.BCD.$9");
        assert!(has_captures("a.${1:/downcase}") && !has_captures("a.${1:/lower}"));
    }
}
