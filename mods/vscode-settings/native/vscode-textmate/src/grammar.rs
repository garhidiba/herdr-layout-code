//! grammar.ts, rule.ts's RuleFactory and tokenizeString.ts. Positions are UTF-8 byte offsets inside the
//! tokenizer (the regex engine's), converted to UTF-16 offsets (vscode-textmate's) in the returned tokens.

use crate::matcher::{create_matchers, Matcher};
use crate::onig::OnigString;
use crate::raw::{RawCaptures, RawGrammar, RawRule, Repository};
use crate::registry::Shared;
use crate::rule::{Captures, RegExpSource, RegExpSourceList, Rule, RuleKind, END_RULE_ID, WHILE_RULE_ID};
use crate::theme::{StyleAttributes, FONT_STYLE_NOT_SET};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, String>;

// ---- encodedTokenAttributes.ts ----

const TOKEN_TYPE_NOT_SET: u32 = 8;

/// `EncodedTokenAttributes.set` (language id is always 0 here: no embedded languages are configured).
fn set_attributes(meta: u32, token_type: u32, font_style: i32, foreground: u32, background: u32) -> u32 {
    let lang = meta & 0xff;
    let mut tt = (meta & 0x300) >> 8;
    let bb = (meta & 0x400) >> 10;
    let mut fs = (meta & 0x7800) >> 11;
    let mut fg = (meta & 0x00ff_8000) >> 15;
    let mut bg = (meta & 0xff00_0000) >> 24;
    if token_type != TOKEN_TYPE_NOT_SET {
        tt = token_type;
    }
    if font_style != FONT_STYLE_NOT_SET {
        fs = font_style as u32;
    }
    if foreground != 0 {
        fg = foreground;
    }
    if background != 0 {
        bg = background;
    }
    lang | tt.wrapping_shl(8) | bb.wrapping_shl(10) | fs.wrapping_shl(11) | fg.wrapping_shl(15) | bg.wrapping_shl(24)
}

/// basicScopesAttributeProvider.ts's standard token type: `\b(comment|string|regex|meta\.embedded)\b`.
fn standard_token_type(scope: &str) -> u32 {
    let b = scope.as_bytes();
    let word = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
    for i in 0..b.len() {
        if i > 0 && word(i - 1) {
            continue;
        }
        for (w, t) in [("comment", 1), ("string", 2), ("regex", 3), ("meta.embedded", 0)] {
            if b[i..].starts_with(w.as_bytes()) && !word(i + w.len()) {
                return t;
            }
        }
    }
    TOKEN_TYPE_NOT_SET
}

/// `AttributedScopeStack.mergeAttributes`.
fn merge_attributes(existing: u32, scope: &str, style: Option<StyleAttributes>) -> u32 {
    let (fs, fg, bg) = style.map_or((FONT_STYLE_NOT_SET, 0, 0), |s| (s.font_style, s.foreground_id, s.background_id));
    set_attributes(existing, standard_token_type(scope), fs, fg, bg)
}

/// utils.ts's `containsRTL` (code points classified R or AL).
fn contains_rtl(s: &str) -> bool {
    const RANGES: &[(u32, u32)] = &[
        (0x5BE, 0x5BE), (0x5C0, 0x5C0), (0x5C3, 0x5C3), (0x5C6, 0x5C6), (0x5D0, 0x5F4), (0x608, 0x608), (0x60B, 0x60B), (0x60D, 0x60D),
        (0x61B, 0x64A), (0x66D, 0x66F), (0x671, 0x6D5), (0x6E5, 0x6E6), (0x6EE, 0x6EF), (0x6FA, 0x710), (0x712, 0x72F), (0x74D, 0x7A5),
        (0x7B1, 0x7EA), (0x7F4, 0x7F5), (0x7FA, 0x7FA), (0x7FE, 0x815), (0x81A, 0x81A), (0x824, 0x824), (0x828, 0x828), (0x830, 0x858),
        (0x85E, 0x88E), (0x8A0, 0x8C9), (0x200F, 0x200F), (0xFB1D, 0xFB1D), (0xFB1F, 0xFB28), (0xFB2A, 0xFD3D), (0xFD50, 0xFDC7),
        (0xFDF0, 0xFDFC), (0xFE70, 0xFEFC), (0x10800, 0x1091B), (0x10920, 0x10A00), (0x10A10, 0x10A35), (0x10A40, 0x10AE4),
        (0x10AEB, 0x10B35), (0x10B40, 0x10BFF), (0x10C00, 0x10D23), (0x10E80, 0x10EA9), (0x10EAD, 0x10F45), (0x10F51, 0x10F81),
        (0x10F86, 0x10FF6), (0x1E800, 0x1E8CF), (0x1E900, 0x1E943), (0x1E94B, 0x1EBFF), (0x1EC00, 0x1EEBB),
    ];
    !s.is_ascii() && s.chars().any(|c| RANGES.iter().any(|&(a, b)| (a..=b).contains(&(c as u32))))
}

// ---- AttributedScopeStack ----

/// One scope of the scope list with the token attributes resolved down to it (`AttributedScopeStack`).
pub struct ScopeNode {
    pub parent: Option<Rc<ScopeNode>>,
    pub scope_name: Rc<str>,
    pub token_attributes: u32,
}

impl ScopeNode {
    fn ancestors(self: &Rc<Self>) -> impl Iterator<Item = &ScopeNode> {
        std::iter::successors(Some(&**self), |n| n.parent.as_deref())
    }

    /// The scope names, root first.
    pub fn scope_names(self: &Rc<Self>) -> Vec<&str> {
        let mut v: Vec<&str> = self.ancestors().map(|n| &*n.scope_name).collect();
        v.reverse();
        v
    }

    fn equals(a: &Rc<ScopeNode>, b: &Rc<ScopeNode>) -> bool {
        let (mut a, mut b) = (Some(a), Some(b));
        loop {
            match (a, b) {
                (Some(x), Some(y)) if Rc::ptr_eq(x, y) => return true,
                (None, None) => return true,
                (Some(x), Some(y)) if x.scope_name == y.scope_name && x.token_attributes == y.token_attributes => (a, b) = (x.parent.as_ref(), y.parent.as_ref()),
                _ => return false,
            }
        }
    }
}

// ---- StateStackImpl ----

pub struct StateNode {
    parent: Option<Rc<StateNode>>,
    rule_id: u32,
    enter_pos: Cell<i32>,
    anchor_pos: Cell<i32>,
    depth: u32,
    begin_rule_captured_eol: bool,
    end_rule: Option<Rc<str>>,
    name_scopes: Rc<ScopeNode>,
    content_name_scopes: Rc<ScopeNode>,
}

/// A rule stack (`StateStack`): the state at the end of a line, passed to the next line's tokenization.
#[derive(Clone)]
pub struct StateStack(Rc<StateNode>);

#[allow(clippy::too_many_arguments)]
fn state(parent: Option<Rc<StateNode>>, rule_id: u32, enter: i32, anchor: i32, eol: bool, end_rule: Option<Rc<str>>, names: Rc<ScopeNode>, content: Rc<ScopeNode>) -> Rc<StateNode> {
    let depth = parent.as_ref().map_or(1, |p| p.depth + 1);
    Rc::new(StateNode { parent, rule_id, enter_pos: Cell::new(enter), anchor_pos: Cell::new(anchor), depth, begin_rule_captured_eol: eol, end_rule, name_scopes: names, content_name_scopes: content })
}

impl StateNode {
    #[allow(clippy::too_many_arguments)]
    fn push(self: &Rc<Self>, rule_id: u32, enter: i32, anchor: i32, eol: bool, end_rule: Option<Rc<str>>, names: Rc<ScopeNode>, content: Rc<ScopeNode>) -> Rc<StateNode> {
        state(Some(self.clone()), rule_id, enter, anchor, eol, end_rule, names, content)
    }

    fn with_content_name_scopes(self: &Rc<Self>, content: Rc<ScopeNode>) -> Rc<StateNode> {
        if Rc::ptr_eq(&self.content_name_scopes, &content) {
            return self.clone();
        }
        state(self.parent.clone(), self.rule_id, self.enter_pos.get(), self.anchor_pos.get(), self.begin_rule_captured_eol, self.end_rule.clone(), self.name_scopes.clone(), content)
    }

    fn with_end_rule(self: &Rc<Self>, end_rule: String) -> Rc<StateNode> {
        if self.end_rule.as_deref() == Some(end_rule.as_str()) {
            return self.clone();
        }
        state(self.parent.clone(), self.rule_id, self.enter_pos.get(), self.anchor_pos.get(), self.begin_rule_captured_eol, Some(end_rule.into()), self.name_scopes.clone(), self.content_name_scopes.clone())
    }

    fn safe_pop(self: &Rc<Self>) -> Rc<StateNode> {
        self.parent.clone().unwrap_or_else(|| self.clone())
    }

    fn has_same_rule_as(self: &Rc<Self>, other: &StateNode) -> bool {
        let mut el = Some(self);
        while let Some(e) = el.filter(|e| e.enter_pos.get() == other.enter_pos.get()) {
            if e.rule_id == other.rule_id {
                return true;
            }
            el = e.parent.as_ref();
        }
        false
    }

    fn reset(&self) {
        let mut el = Some(self);
        while let Some(e) = el {
            e.enter_pos.set(-1);
            e.anchor_pos.set(-1);
            el = e.parent.as_deref();
        }
    }

    fn nodes(&self) -> impl Iterator<Item = &StateNode> {
        std::iter::successors(Some(self), |n| n.parent.as_deref())
    }
}

impl StateStack {
    pub fn depth(&self) -> u32 {
        self.0.depth
    }

    /// `StateStack.equals`: same rules and end patterns at every depth, and equal content scopes.
    pub fn equals(&self, other: &StateStack) -> bool {
        if Rc::ptr_eq(&self.0, &other.0) {
            return true;
        }
        let mut pairs = self.0.nodes().zip(other.0.nodes());
        let structural = self.0.depth == other.0.depth && pairs.all(|(a, b)| std::ptr::eq(a, b) || (a.depth == b.depth && a.rule_id == b.rule_id && a.end_rule == b.end_rule));
        structural && ScopeNode::equals(&self.0.content_name_scopes, &other.0.content_name_scopes)
    }

    /// Root first: (rule id, end rule, content scopes, content token attributes) — the fields `equals` compares.
    pub fn frames(&self) -> Vec<(u32, Option<String>, String, u32)> {
        let mut v: Vec<_> = self.0.nodes().map(|n| (n.rule_id, n.end_rule.as_deref().map(str::to_string), n.content_name_scopes.scope_names().join(" "), n.content_name_scopes.token_attributes)).collect();
        v.reverse();
        v
    }
}

// ---- LineTokens (binary) ----

struct LineTokens {
    tokens: Vec<i64>,
    last_end: i32,
    merge: bool,
}

impl LineTokens {
    fn produce(&mut self, stack: &StateNode, end: i32) {
        self.produce_from_scopes(&stack.content_name_scopes, end)
    }

    fn produce_from_scopes(&mut self, scopes: &ScopeNode, end: i32) {
        if self.last_end >= end {
            return;
        }
        let meta = scopes.token_attributes as i64;
        if self.merge && self.tokens.last() == Some(&meta) {
            self.last_end = end;
            return;
        }
        self.tokens.push(self.last_end as i64);
        self.tokens.push(meta);
        self.last_end = end;
    }

    fn binary_result(mut self, stack: &StateNode, line_len: i32) -> Vec<i64> {
        let n = self.tokens.len();
        if n > 0 && self.tokens[n - 2] == (line_len - 1) as i64 {
            self.tokens.truncate(n - 2);
        }
        if self.tokens.is_empty() {
            self.last_end = -1;
            self.produce(stack, line_len);
            let n = self.tokens.len();
            self.tokens[n - 2] = 0;
        }
        self.tokens
    }
}

/// Token start byte offsets → UTF-16 offsets (`tokens` holds start, metadata pairs in ascending order).
fn to_utf16(text: &str, tokens: Vec<i64>) -> Vec<u32> {
    let mut out: Vec<u32> = tokens.iter().map(|&t| t as u32).collect();
    if text.is_ascii() {
        return out;
    }
    let (mut byte, mut unit, mut chars) = (0usize, 0u32, text.chars());
    for i in (0..out.len()).step_by(2) {
        let target = out[i] as usize;
        while byte < target {
            let Some(c) = chars.next() else { break };
            byte += c.len_utf8();
            unit += c.len_utf16() as u32;
        }
        out[i] = unit;
    }
    out
}

// ---- Grammar ----

struct Injection {
    matcher: Matcher,
    priority: i32,
    rule_id: u32,
}

/// A grammar after `initGrammar`: its own copy of the rules, with `$self` and `$base` in the repository.
struct InitGrammar {
    repository: Repository,
    injections: Option<Vec<(String, Rc<RawRule>)>>,
}

fn init_grammar(value: &serde_json::Value, base: Option<Rc<RawRule>>) -> InitGrammar {
    let g = RawGrammar::from_value(value);
    let mut repository = g.repository.unwrap_or_default();
    let self_rule = Rc::new(RawRule { patterns: g.patterns, name: Some(g.scope_name).filter(|s| !s.is_empty()), ..Default::default() });
    repository.insert("$base".into(), base.unwrap_or_else(|| self_rule.clone()));
    repository.insert("$self".into(), self_rule);
    InitGrammar { repository, injections: g.injections }
}

pub(crate) enum Include<'a> {
    Base,
    SelfRef,
    Relative(&'a str),
    TopLevel(&'a str),
    TopLevelRepository(&'a str, &'a str),
}

pub(crate) fn parse_include(include: &str) -> Include<'_> {
    match include {
        "$base" => Include::Base,
        "$self" => Include::SelfRef,
        _ => match include.find('#') {
            None => Include::TopLevel(include),
            Some(0) => Include::Relative(&include[1..]),
            Some(k) => Include::TopLevelRepository(&include[..k], &include[k + 1..]),
        },
    }
}

/// `parseInt(s, 10)` for capture keys: leading whitespace, a sign, digits; `None` when it is NaN.
fn js_parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(crate::rule::js_space);
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let n = digits.bytes().take_while(u8::is_ascii_digit).count();
    let v: i64 = digits[..n].parse().ok()?;
    Some(if neg { -v } else { v })
}

pub struct TokenizeLineResult2 {
    /// (start offset in UTF-16 code units, encoded metadata) pairs, as `tokenizeLine2` returns them.
    pub tokens: Vec<u32>,
    pub rule_stack: StateStack,
    pub stopped_early: bool,
}

type MatchResult = (i32, Vec<(i32, i32)>);

pub struct Grammar {
    shared: Rc<Shared>,
    grammar: Rc<InitGrammar>,
    included: HashMap<String, Rc<InitGrammar>>,
    rules: Vec<Option<Rule>>,
    root_id: Option<u32>,
    injections: Vec<Injection>,
}

impl Grammar {
    pub(crate) fn new(value: &serde_json::Value, shared: Rc<Shared>) -> Grammar {
        Grammar { shared, grammar: Rc::new(init_grammar(value, None)), included: HashMap::new(), rules: vec![None], root_id: None, injections: vec![] }
    }

    fn rule(&self, id: u32) -> &Rule {
        self.rules[id as usize].as_ref().expect("rule compiled")
    }

    // ---- RuleFactory ----

    fn external_grammar(&mut self, scope: &str, repository: &Repository) -> Option<Rc<InitGrammar>> {
        if let Some(g) = self.included.get(scope) {
            return Some(g.clone());
        }
        let source = self.shared.lookup(scope)?;
        let g = Rc::new(init_grammar(&source.value, repository.get("$base").cloned()));
        self.included.insert(scope.to_string(), g.clone());
        Some(g)
    }

    fn compiled_rule_id(&mut self, desc: &Rc<RawRule>, repository: &Repository) -> u32 {
        if desc.id.get() != 0 {
            return desc.id.get();
        }
        let id = self.rules.len() as u32;
        self.rules.push(None);
        desc.id.set(id);
        let rule = if let Some(m) = &desc.match_ {
            let captures = self.compile_captures(desc.captures.as_ref(), repository);
            Rule::new(desc.name.clone(), None, RuleKind::Match { regex: RegExpSource::new(m, id as i32), captures })
        } else if desc.begin.is_none() {
            let merged;
            let repository = match &desc.repository {
                Some(own) => {
                    merged = repository.iter().chain(own).map(|(k, v)| (k.clone(), v.clone())).collect();
                    &merged
                }
                None => repository,
            };
            let synthetic;
            let patterns = match (&desc.patterns, &desc.include) {
                (None, Some(include)) => {
                    synthetic = vec![Rc::new(RawRule { include: Some(include.clone()), ..Default::default() })];
                    Some(&synthetic)
                }
                (p, _) => p.as_ref(),
            };
            let (patterns, has_missing) = self.compile_patterns(patterns.map(Vec::as_slice), repository);
            Rule::new(desc.name.clone(), desc.content_name.clone(), RuleKind::IncludeOnly { patterns, has_missing })
        } else {
            let begin = RegExpSource::new(desc.begin.as_deref().unwrap_or_default(), id as i32);
            let begin_captures = self.compile_captures(desc.begin_captures.as_ref().or(desc.captures.as_ref()), repository);
            let kind = if let Some(w) = &desc.while_ {
                let while_captures = self.compile_captures(desc.while_captures.as_ref().or(desc.captures.as_ref()), repository);
                let (patterns, has_missing) = self.compile_patterns(desc.patterns.as_deref(), repository);
                RuleKind::BeginWhile { begin, begin_captures, while_: RegExpSource::new(w, WHILE_RULE_ID), while_captures, patterns, has_missing }
            } else {
                let end_captures = self.compile_captures(desc.end_captures.as_ref().or(desc.captures.as_ref()), repository);
                let (patterns, has_missing) = self.compile_patterns(desc.patterns.as_deref(), repository);
                let end = RegExpSource::new(desc.end.as_deref().unwrap_or("\u{FFFF}"), END_RULE_ID);
                RuleKind::BeginEnd { begin, begin_captures, end, end_captures, apply_end_last: desc.apply_end_pattern_last, patterns, has_missing }
            };
            Rule::new(desc.name.clone(), desc.content_name.clone(), kind)
        };
        self.rules[id as usize] = Some(rule);
        id
    }

    fn compile_captures(&mut self, captures: Option<&RawCaptures>, repository: &Repository) -> Vec<Option<u32>> {
        let Some(captures) = captures else { return vec![] };
        let max = captures.iter().filter_map(|(k, _)| js_parse_int(k)).fold(0, i64::max);
        let mut r = vec![None; max as usize + 1];
        for (key, capture) in captures {
            let retokenize = if capture.patterns.is_some() { self.compiled_rule_id(capture, repository) } else { 0 };
            let id = self.rules.len() as u32;
            self.rules.push(Some(Rule::new(capture.name.clone(), capture.content_name.clone(), RuleKind::Capture { retokenize })));
            if let Some(n) = js_parse_int(key).filter(|n| *n >= 0) {
                r[n as usize] = Some(id);
            }
        }
        r
    }

    fn compile_patterns(&mut self, patterns: Option<&[Rc<RawRule>]>, repository: &Repository) -> (Vec<u32>, bool) {
        let mut r = vec![];
        let all = patterns.unwrap_or_default();
        for pattern in all {
            let id = match &pattern.include {
                Some(include) => match parse_include(include) {
                    Include::Base | Include::SelfRef => repository.get(include.as_str()).cloned().map(|d| self.compiled_rule_id(&d, repository)),
                    Include::Relative(name) => repository.get(name).cloned().map(|d| self.compiled_rule_id(&d, repository)),
                    Include::TopLevel(scope) | Include::TopLevelRepository(scope, _) => {
                        let rule_name = match parse_include(include) {
                            Include::TopLevelRepository(_, name) if !name.is_empty() => Some(name),
                            _ => None,
                        };
                        self.external_grammar(scope, repository).and_then(|ext| {
                            let desc = ext.repository.get(rule_name.unwrap_or("$self"))?.clone();
                            Some(self.compiled_rule_id(&desc, &ext.repository))
                        })
                    }
                },
                None => Some(self.compiled_rule_id(pattern, repository)),
            };
            let Some(id) = id else { continue };
            let skip = self.rules[id as usize].as_ref().and_then(Rule::patterns).is_some_and(|(p, missing)| missing && p.is_empty());
            if !skip {
                r.push(id);
            }
        }
        let missing = all.len() != r.len();
        (r, missing)
    }

    fn ensure_compiled(&mut self) {
        if self.root_id.is_some() {
            return;
        }
        let g = self.grammar.clone();
        let root = self.compiled_rule_id(&g.repository["$self"], &g.repository);
        self.root_id = Some(root);
        let mut injections = vec![];
        for (selector, rule) in g.injections.iter().flatten() {
            let matchers = create_matchers(selector);
            let rule_id = self.compiled_rule_id(rule, &g.repository);
            injections.extend(matchers.into_iter().map(|m| Injection { matcher: m.matcher, priority: m.priority, rule_id }));
        }
        injections.sort_by_key(|i| i.priority);
        self.injections = injections;
    }

    // ---- compiled patterns (RegExpSourceList caches) ----

    fn collect_patterns(&self, id: u32, out: &mut RegExpSourceList) {
        match &self.rule(id).kind {
            RuleKind::Match { regex, .. } => out.push(regex.clone()),
            RuleKind::IncludeOnly { patterns, .. } => patterns.iter().for_each(|p| self.collect_patterns(*p, out)),
            RuleKind::BeginEnd { begin, .. } | RuleKind::BeginWhile { begin, .. } => out.push(begin.clone()),
            RuleKind::Capture { .. } => {}
        }
    }

    /// `prepareRuleSearch` + `findNextMatchSync`.
    fn find(&self, id: u32, end_rule: Option<&str>, allow_a: bool, allow_g: bool, line: &OnigString, pos: i32) -> Result<Option<MatchResult>> {
        let rule = self.rule(id);
        let mut cache = rule.cache.borrow_mut();
        let list = cache.get_or_insert_with(|| {
            let mut list = RegExpSourceList::default();
            match &rule.kind {
                RuleKind::Match { regex, .. } => list.push(regex.clone()),
                RuleKind::IncludeOnly { patterns, .. } | RuleKind::BeginWhile { patterns, .. } => patterns.iter().for_each(|p| self.collect_patterns(*p, &mut list)),
                RuleKind::BeginEnd { patterns, end, apply_end_last, .. } => {
                    patterns.iter().for_each(|p| self.collect_patterns(*p, &mut list));
                    if *apply_end_last {
                        list.push(end.clone())
                    } else {
                        list.unshift(end.clone())
                    }
                }
                RuleKind::Capture { .. } => {}
            }
            list
        });
        if let RuleKind::BeginEnd { end, apply_end_last, .. } = &rule.kind {
            if end.has_back_references {
                let index = if *apply_end_last { list.len() - 1 } else { 0 };
                list.set_source(index, end_rule.unwrap_or_default());
            }
        }
        Ok(list.compile_ag(allow_a, allow_g)?.find_next_match(line, pos as usize))
    }

    /// `prepareRuleWhileSearch` + `findNextMatchSync`.
    fn find_while(&self, id: u32, end_rule: Option<&str>, allow_a: bool, allow_g: bool, line: &OnigString, pos: i32) -> Result<Option<MatchResult>> {
        let rule = self.rule(id);
        let RuleKind::BeginWhile { while_, .. } = &rule.kind else { return Ok(None) };
        let mut cache = rule.while_cache.borrow_mut();
        let list = cache.get_or_insert_with(|| {
            let mut list = RegExpSourceList::default();
            list.push(while_.clone());
            list
        });
        if while_.has_back_references {
            list.set_source(0, end_rule.unwrap_or("\u{FFFF}"));
        }
        Ok(list.compile_ag(allow_a, allow_g)?.find_next_match(line, pos as usize))
    }

    // ---- scopes ----

    fn push_one(&self, target: &Rc<ScopeNode>, scope: &str) -> Rc<ScopeNode> {
        let style = self.shared.theme.match_scope(scope, target.ancestors().map(|n| &*n.scope_name));
        Rc::new(ScopeNode { parent: Some(target.clone()), scope_name: scope.into(), token_attributes: merge_attributes(target.token_attributes, scope, style) })
    }

    /// `AttributedScopeStack.pushAttributed`.
    fn push_attributed(&self, target: &Rc<ScopeNode>, path: Option<&str>) -> Rc<ScopeNode> {
        let Some(path) = path else { return target.clone() };
        if !path.contains(' ') {
            return self.push_one(target, path);
        }
        path.split(' ').fold(target.clone(), |t, s| self.push_one(&t, s))
    }

    fn initial_state(&self) -> Rc<StateNode> {
        let root = self.root_id.unwrap();
        let d = self.shared.theme.defaults();
        let default_meta = set_attributes(0, TOKEN_TYPE_NOT_SET, d.font_style, d.foreground_id, d.background_id);
        let scopes = match self.rule(root).name(None, None) {
            Some(name) => {
                let style = self.shared.theme.match_scope(&name, std::iter::empty());
                Rc::new(ScopeNode { parent: None, scope_name: (*name).into(), token_attributes: merge_attributes(default_meta, &name, style) })
            }
            None => Rc::new(ScopeNode { parent: None, scope_name: "unknown".into(), token_attributes: default_meta }),
        };
        state(None, root, -1, -1, false, None, scopes.clone(), scopes)
    }

    // ---- tokenizeString.ts ----

    /// `tokenizeLine2(lineText, prevState, timeLimit)`; `time_limit` of zero means none.
    pub fn tokenize_line2(&mut self, line: &str, prev: Option<&StateStack>, time_limit: Duration) -> Result<TokenizeLineResult2> {
        self.ensure_compiled();
        let (is_first_line, prev) = match prev {
            Some(p) => {
                p.0.reset();
                (false, p.0.clone())
            }
            None => (true, self.initial_state()),
        };
        let text = OnigString::new(format!("{line}\n"));
        let line_len = text.content.len() as i32;
        let mut tokens = LineTokens { tokens: vec![], last_end: 0, merge: !contains_rtl(&text.content) };
        let (stack, stopped_early) = self.tokenize_string(&text, is_first_line, 0, prev, &mut tokens, true, time_limit)?;
        let tokens = to_utf16(&text.content, tokens.binary_result(&stack, line_len));
        Ok(TokenizeLineResult2 { tokens, rule_stack: StateStack(stack), stopped_early })
    }

    #[allow(clippy::too_many_arguments)]
    fn tokenize_string(&self, line: &OnigString, mut is_first_line: bool, mut line_pos: i32, mut stack: Rc<StateNode>, tokens: &mut LineTokens, check_while: bool, time_limit: Duration) -> Result<(Rc<StateNode>, bool)> {
        let line_len = line.content.len() as i32;
        let mut anchor = -1;
        if check_while {
            (stack, line_pos, anchor, is_first_line) = self.check_while_conditions(line, is_first_line, line_pos, stack, tokens)?;
        }
        let start = Instant::now();
        loop {
            if !time_limit.is_zero() && start.elapsed() > time_limit {
                return Ok((stack, true));
            }
            let Some((rule_id, caps)) = self.match_rule_or_injections(line, is_first_line, line_pos, &stack, anchor)? else {
                tokens.produce(&stack, line_len);
                return Ok((stack, false));
            };
            let (c0s, c0e) = caps[0];
            let has_advanced = c0e > line_pos;
            if rule_id == END_RULE_ID {
                let RuleKind::BeginEnd { end_captures, .. } = &self.rule(stack.rule_id).kind else { return Err("end matched outside a begin/end rule".into()) };
                tokens.produce(&stack, c0s);
                stack = stack.with_content_name_scopes(stack.name_scopes.clone());
                self.handle_captures(line, is_first_line, &stack, tokens, end_captures, &caps)?;
                tokens.produce(&stack, c0e);
                let popped = stack.clone();
                stack = popped.parent.clone().ok_or("popped the root state")?;
                anchor = popped.anchor_pos.get();
                if !has_advanced && popped.enter_pos.get() == line_pos {
                    stack = popped;
                    tokens.produce(&stack, line_len);
                    return Ok((stack, false));
                }
            } else {
                let rule = self.rule(rule_id as u32);
                tokens.produce(&stack, c0s);
                let before_push = stack.clone();
                let names = self.push_attributed(&stack.content_name_scopes, rule.name(Some(&line.content), Some(&caps)).as_deref());
                stack = stack.push(rule_id as u32, line_pos, anchor, c0e == line_len, None, names.clone(), names.clone());
                match &rule.kind {
                    RuleKind::BeginEnd { begin_captures: bc, end: back, .. } | RuleKind::BeginWhile { begin_captures: bc, while_: back, .. } => {
                        self.handle_captures(line, is_first_line, &stack, tokens, bc, &caps)?;
                        tokens.produce(&stack, c0e);
                        anchor = c0e;
                        let content = self.push_attributed(&names, rule.content_name(&line.content, &caps).as_deref());
                        stack = stack.with_content_name_scopes(content);
                        if back.has_back_references {
                            stack = stack.with_end_rule(back.resolve_back_references(&line.content, &caps));
                        }
                        if !has_advanced && before_push.has_same_rule_as(&stack) {
                            stack = stack.parent.clone().unwrap();
                            tokens.produce(&stack, line_len);
                            return Ok((stack, false));
                        }
                    }
                    RuleKind::Match { captures, .. } => {
                        self.handle_captures(line, is_first_line, &stack, tokens, captures, &caps)?;
                        tokens.produce(&stack, c0e);
                        stack = stack.parent.clone().unwrap();
                        if !has_advanced {
                            stack = stack.safe_pop();
                            tokens.produce(&stack, line_len);
                            return Ok((stack, false));
                        }
                    }
                    _ => return Err("matched a rule without a pattern".into()),
                }
            }
            if c0e > line_pos {
                line_pos = c0e;
                is_first_line = false;
            }
        }
    }

    fn check_while_conditions(&self, line: &OnigString, mut is_first_line: bool, mut line_pos: i32, mut stack: Rc<StateNode>, tokens: &mut LineTokens) -> Result<(Rc<StateNode>, i32, i32, bool)> {
        let mut anchor = if stack.begin_rule_captured_eol { 0 } else { -1 };
        let mut nodes: Vec<Rc<StateNode>> = vec![];
        let mut node = Some(stack.clone());
        while let Some(n) = node {
            if matches!(self.rule(n.rule_id).kind, RuleKind::BeginWhile { .. }) {
                nodes.push(n.clone());
            }
            node = n.parent.clone();
        }
        while let Some(n) = nodes.pop() {
            let RuleKind::BeginWhile { while_captures, .. } = &self.rule(n.rule_id).kind else { unreachable!() };
            match self.find_while(n.rule_id, n.end_rule.as_deref(), is_first_line, line_pos == anchor, line, line_pos)? {
                Some((id, caps)) => {
                    if id != WHILE_RULE_ID {
                        stack = n.parent.clone().unwrap();
                        break;
                    }
                    if !caps.is_empty() {
                        tokens.produce(&n, caps[0].0);
                        self.handle_captures(line, is_first_line, &n, tokens, while_captures, &caps)?;
                        tokens.produce(&n, caps[0].1);
                        anchor = caps[0].1;
                        if caps[0].1 > line_pos {
                            line_pos = caps[0].1;
                            is_first_line = false;
                        }
                    }
                }
                None => {
                    stack = n.parent.clone().unwrap();
                    break;
                }
            }
        }
        Ok((stack, line_pos, anchor, is_first_line))
    }

    fn match_rule_or_injections(&self, line: &OnigString, is_first_line: bool, line_pos: i32, stack: &StateNode, anchor: i32) -> Result<Option<MatchResult>> {
        let matched = self.find(stack.rule_id, stack.end_rule.as_deref(), is_first_line, line_pos == anchor, line, line_pos)?;
        if self.injections.is_empty() {
            return Ok(matched);
        }
        let Some((priority_match, injected)) = self.match_injections(line, is_first_line, line_pos, stack, anchor)? else { return Ok(matched) };
        let Some(m) = matched else { return Ok(Some(injected)) };
        let (ms, is) = (m.1[0].0, injected.1[0].0);
        Ok(Some(if is < ms || (priority_match && is == ms) { injected } else { m }))
    }

    fn match_injections(&self, line: &OnigString, is_first_line: bool, line_pos: i32, stack: &StateNode, anchor: i32) -> Result<Option<(bool, MatchResult)>> {
        let scopes = stack.content_name_scopes.scope_names();
        let mut best: Option<(i32, MatchResult)> = None;
        for inj in &self.injections {
            if !inj.matcher.matches(&scopes) {
                continue;
            }
            let Some(m) = self.find(inj.rule_id, None, is_first_line, line_pos == anchor, line, line_pos)? else { continue };
            let rating = m.1[0].0;
            if best.as_ref().is_some_and(|(_, b)| rating >= b.1[0].0) {
                continue;
            }
            best = Some((inj.priority, m));
            if rating == line_pos {
                break;
            }
        }
        Ok(best.map(|(p, m)| (p == -1, m)))
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_captures(&self, line: &OnigString, is_first_line: bool, stack: &Rc<StateNode>, tokens: &mut LineTokens, captures: &[Option<u32>], caps: &Captures) -> Result<()> {
        if captures.is_empty() {
            return Ok(());
        }
        let text = &line.content;
        let max_end = caps[0].1;
        let mut local: Vec<(Rc<ScopeNode>, i32)> = vec![];
        for (capture, &(start, end)) in captures.iter().zip(caps) {
            let Some(rule_id) = *capture else { continue };
            if end - start == 0 {
                continue;
            }
            if start > max_end {
                break;
            }
            while local.last().is_some_and(|(_, e)| *e <= start) {
                let (scopes, e) = local.pop().unwrap();
                tokens.produce_from_scopes(&scopes, e);
            }
            match local.last() {
                Some((scopes, _)) => tokens.produce_from_scopes(scopes, start),
                None => tokens.produce(stack, start),
            }
            let rule = self.rule(rule_id);
            let RuleKind::Capture { retokenize } = rule.kind else { continue };
            if retokenize != 0 {
                let names = self.push_attributed(&stack.content_name_scopes, rule.name(Some(text), Some(caps)).as_deref());
                let content = self.push_attributed(&names, rule.content_name(text, caps).as_deref());
                let pushed = stack.push(retokenize, start, -1, false, None, names, content);
                let sub = OnigString::new(text[..end as usize].to_string());
                self.tokenize_string(&sub, is_first_line && start == 0, start, pushed, tokens, false, Duration::ZERO)?;
                continue;
            }
            if let Some(name) = rule.name(Some(text), Some(caps)) {
                let base = local.last().map_or(&stack.content_name_scopes, |(s, _)| s);
                let scopes = self.push_attributed(base, Some(&name));
                local.push((scopes, end));
            }
        }
        while let Some((scopes, e)) = local.pop() {
            tokens.produce_from_scopes(&scopes, e);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_types_follow_the_standard_scope_words() {
        assert_eq!(standard_token_type("comment.line.double-slash"), 1);
        assert_eq!(standard_token_type("punctuation.definition.string.begin"), 2);
        assert_eq!(standard_token_type("string.regexp"), 2);
        assert_eq!(standard_token_type("meta.embedded.block"), 0);
        assert_eq!(standard_token_type("xcomment.stringy"), TOKEN_TYPE_NOT_SET);
    }

    #[test]
    fn attributes_keep_unset_fields() {
        let m = set_attributes(0, 2, 1, 5, 2);
        assert_eq!(set_attributes(m, TOKEN_TYPE_NOT_SET, FONT_STYLE_NOT_SET, 0, 0), m);
        assert_eq!(((m & 0x00ff_8000) >> 15, (m & 0x7800) >> 11, (m & 0x300) >> 8), (5, 1, 2));
    }

    #[test]
    fn utf16_offsets_count_surrogate_pairs_and_multibyte_text() {
        let text = "a😀한b\n";
        assert_eq!(to_utf16(text, vec![0, 7, 1, 8, 5, 9, 8, 10]), vec![0, 7, 1, 8, 3, 9, 4, 10]);
    }

    #[test]
    fn rtl_text_is_detected() {
        assert!(contains_rtl("abc שלום"));
        assert!(!contains_rtl("한글 😀"));
    }

    #[test]
    fn capture_keys_parse_like_parse_int() {
        assert_eq!(js_parse_int(" 12x"), Some(12));
        assert_eq!(js_parse_int("-1"), Some(-1));
        assert_eq!(js_parse_int("name"), None);
    }
}
