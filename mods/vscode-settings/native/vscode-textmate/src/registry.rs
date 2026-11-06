//! main.ts's `Registry`, registry.ts's `SyncRegistry` and grammarDependencies.ts: loads a grammar and every grammar
//! its rules reach (the same closure as the JS, so the same includes resolve), and shares the theme.

use crate::grammar::{parse_include, Grammar, Include};
use crate::raw::{RawGrammar, RawRule, Repository};
use crate::theme::Theme;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// A loaded grammar file: the parsed value (cloned into each grammar that uses it) and one rule tree whose rule
/// identities key the dependency walk.
pub(crate) struct Source {
    pub value: Value,
    original: RawGrammar,
}

pub(crate) struct Shared {
    pub theme: Theme,
    sources: RefCell<HashMap<String, Rc<Source>>>,
}

impl Shared {
    pub fn lookup(&self, scope: &str) -> Option<Rc<Source>> {
        self.sources.borrow().get(scope).cloned()
    }
}

/// Loads a grammar's file by scope name; `Ok(None)` when there is none.
pub type Loader = Box<dyn FnMut(&str) -> Result<Option<Value>, String>>;

pub struct Registry {
    shared: Rc<Shared>,
    loader: Loader,
    tried: HashSet<String>,
}

#[derive(Clone)]
enum Reference {
    TopLevel(String),
    Repository(String, String),
}

impl Reference {
    fn scope(&self) -> &str {
        match self {
            Reference::TopLevel(s) | Reference::Repository(s, _) => s,
        }
    }

    fn key(&self) -> String {
        match self {
            Reference::TopLevel(s) => s.clone(),
            Reference::Repository(s, r) => format!("{s}#{r}"),
        }
    }
}

#[derive(Default)]
struct Collector {
    references: Vec<Reference>,
    seen: HashSet<String>,
    visited: HashSet<*const RawRule>,
}

impl Collector {
    fn add(&mut self, r: Reference) {
        if self.seen.insert(r.key()) {
            self.references.push(r);
        }
    }
}

#[derive(Clone, Copy)]
struct Context<'a> {
    base: &'a RawGrammar,
    this: &'a RawGrammar,
    repository: Option<&'a Repository>,
}

fn in_top_level_repository_rule(name: &str, ctx: Context, out: &mut Collector) {
    if let Some(rule) = ctx.repository.and_then(|r| r.get(name)) {
        in_rules(std::slice::from_ref(rule), ctx, out);
    }
}

fn in_top_level_rule(ctx: Context, out: &mut Collector) {
    let ctx = Context { repository: ctx.this.repository.as_ref(), ..ctx };
    if let Some(p) = &ctx.this.patterns {
        in_rules(p, ctx, out);
    }
    if let Some(inj) = &ctx.this.injections {
        let rules: Vec<Rc<RawRule>> = inj.iter().map(|(_, r)| r.clone()).collect();
        in_rules(&rules, ctx, out);
    }
}

fn in_rules(rules: &[Rc<RawRule>], ctx: Context, out: &mut Collector) {
    for rule in rules {
        if !out.visited.insert(Rc::as_ptr(rule)) {
            continue;
        }
        let merged: Repository;
        let repository = match &rule.repository {
            Some(own) => {
                merged = ctx.repository.into_iter().flatten().chain(own).map(|(k, v)| (k.clone(), v.clone())).collect();
                Some(&merged)
            }
            None => ctx.repository,
        };
        if let Some(p) = &rule.patterns {
            in_rules(p, Context { repository, ..ctx }, out);
        }
        let Some(include) = &rule.include else { continue };
        match parse_include(include) {
            Include::Base => in_top_level_rule(Context { this: ctx.base, ..ctx }, out),
            Include::SelfRef => in_top_level_rule(ctx, out),
            Include::Relative(name) => in_top_level_repository_rule(name, Context { repository, ..ctx }, out),
            Include::TopLevel(scope) | Include::TopLevelRepository(scope, _) => {
                let this = if scope == ctx.this.scope_name {
                    Some(ctx.this)
                } else if scope == ctx.base.scope_name {
                    Some(ctx.base)
                } else {
                    None
                };
                match (this, parse_include(include)) {
                    (Some(this), Include::TopLevelRepository(_, name)) => in_top_level_repository_rule(name, Context { base: ctx.base, this, repository }, out),
                    (Some(this), _) => in_top_level_rule(Context { base: ctx.base, this, repository }, out),
                    (None, Include::TopLevelRepository(s, name)) => out.add(Reference::Repository(s.into(), name.into())),
                    (None, _) => out.add(Reference::TopLevel(scope.into())),
                }
            }
        }
    }
}

impl Registry {
    /// `new Registry({ theme, loadGrammar })` (no injection grammars, no fixed color map).
    pub fn new(raw_theme: &Value, loader: Loader) -> Registry {
        Registry { shared: Rc::new(Shared { theme: Theme::from_raw(raw_theme), sources: RefCell::new(HashMap::new()) }), loader, tried: HashSet::new() }
    }

    /// `getColorMap()`: color ids in token metadata index this list (index 0 unused).
    pub fn color_map(&self) -> &[Option<String>] {
        self.shared.theme.color_map()
    }

    fn load_single(&mut self, scope: &str) -> Result<(), String> {
        if !self.tried.insert(scope.to_string()) {
            return Ok(());
        }
        if let Some(value) = (self.loader)(scope)? {
            let original = RawGrammar::from_value(&value);
            let name = original.scope_name.clone();
            self.shared.sources.borrow_mut().insert(name, Rc::new(Source { value, original }));
        }
        Ok(())
    }

    fn collect(&self, r: &Reference, base_scope: &str, out: &mut Collector) -> Result<(), String> {
        let Some(this) = self.shared.lookup(r.scope()) else {
            if r.scope() == base_scope {
                return Err(format!("No grammar provided for <{base_scope}>"));
            }
            return Ok(());
        };
        let base = self.shared.lookup(base_scope).ok_or_else(|| format!("No grammar provided for <{base_scope}>"))?;
        let ctx = Context { base: &base.original, this: &this.original, repository: this.original.repository.as_ref() };
        match r {
            Reference::TopLevel(_) => in_top_level_rule(ctx, out),
            Reference::Repository(_, name) => in_top_level_repository_rule(name, ctx, out),
        }
        Ok(())
    }

    /// `loadGrammar(scopeName)`: the grammar, or `None` when no file provides the scope. Each call returns a new
    /// grammar (the JS caches one per registry; tokens are the same either way).
    pub fn load_grammar(&mut self, initial: &str) -> Result<Option<Grammar>, String> {
        let mut seen_full: HashSet<String> = HashSet::from([initial.to_string()]);
        let mut seen_partial: HashSet<String> = HashSet::new();
        let mut queue = vec![Reference::TopLevel(initial.to_string())];
        while !queue.is_empty() {
            for r in &queue {
                self.load_single(r.scope())?;
            }
            let mut deps = Collector::default();
            for r in std::mem::take(&mut queue) {
                self.collect(&r, initial, &mut deps)?;
            }
            for dep in deps.references {
                if seen_full.contains(dep.scope()) {
                    continue;
                }
                match &dep {
                    Reference::TopLevel(s) => {
                        seen_full.insert(s.clone());
                    }
                    Reference::Repository(..) => {
                        if !seen_partial.insert(dep.key()) {
                            continue;
                        }
                    }
                }
                queue.push(dep);
            }
        }
        Ok(self.shared.lookup(initial).map(|s| Grammar::new(&s.value, self.shared.clone())))
    }
}
