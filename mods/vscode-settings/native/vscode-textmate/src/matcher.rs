//! matcher.ts: scope selectors (`L:text.html - comment, source.js`) for injections, matched with grammar.ts's
//! `nameMatcher` against a scope list (root first).

pub enum Matcher {
    Names(Vec<String>),
    /// `-x`; `None` when nothing followed the `-` (never matches).
    Not(Option<Box<Matcher>>),
    And(Vec<Matcher>),
    Or(Vec<Matcher>),
}

pub struct MatcherWithPriority {
    pub matcher: Matcher,
    /// -1 for `L:`, 1 for `R:`, 0 otherwise.
    pub priority: i32,
}

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b':'
}

/// The selector's tokens: `[LR]:`, `[\w.:][\w.:-]*`, or one of `,|-()`; anything else is skipped.
fn tokens(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let (mut out, mut i) = (vec![], 0);
    while i < b.len() {
        if (b[i] == b'L' || b[i] == b'R') && b.get(i + 1) == Some(&b':') {
            out.push(&s[i..i + 2]);
            i += 2;
        } else if word(b[i]) {
            let n = b[i..].iter().take_while(|c| word(**c) || **c == b'-').count();
            out.push(&s[i..i + n]);
            i += n;
        } else if b",|-()".contains(&b[i]) {
            out.push(&s[i..i + 1]);
            i += 1;
        } else {
            i += 1;
        }
    }
    out
}

fn is_identifier(t: Option<&str>) -> bool {
    t.is_some_and(|t| t.bytes().any(word))
}

struct Parser<'a> {
    tokens: Vec<&'a str>,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn token(&self) -> Option<&'a str> {
        self.tokens.get(self.pos).copied()
    }

    fn next(&mut self) {
        self.pos += 1;
    }

    fn operand(&mut self) -> Option<Matcher> {
        match self.token() {
            Some("-") => {
                self.next();
                Some(Matcher::Not(self.operand().map(Box::new)))
            }
            Some("(") => {
                self.next();
                let inner = self.inner();
                if self.token() == Some(")") {
                    self.next();
                }
                Some(inner)
            }
            t if is_identifier(t) => {
                let mut names = vec![];
                while is_identifier(self.token()) {
                    names.push(self.token().unwrap().to_string());
                    self.next();
                }
                Some(Matcher::Names(names))
            }
            _ => None,
        }
    }

    fn conjunction(&mut self) -> Matcher {
        let mut all = vec![];
        while let Some(m) = self.operand() {
            all.push(m);
        }
        Matcher::And(all)
    }

    fn inner(&mut self) -> Matcher {
        let mut any = vec![self.conjunction()];
        while matches!(self.token(), Some("|") | Some(",")) {
            while matches!(self.token(), Some("|") | Some(",")) {
                self.next();
            }
            any.push(self.conjunction());
        }
        Matcher::Or(any)
    }
}

pub fn create_matchers(selector: &str) -> Vec<MatcherWithPriority> {
    let mut p = Parser { tokens: tokens(selector), pos: 0 };
    let mut out = vec![];
    while p.token().is_some() {
        let mut priority = 0;
        if let Some(t) = p.token().filter(|t| t.len() == 2 && t.ends_with(':')) {
            priority = match t {
                "R:" => 1,
                "L:" => -1,
                _ => 0,
            };
            p.next();
        }
        out.push(MatcherWithPriority { matcher: p.conjunction(), priority });
        if p.token() != Some(",") {
            break;
        }
        p.next();
    }
    out
}

fn scopes_are_matching(this: &str, name: &str) -> bool {
    !this.is_empty() && (this == name || (this.len() > name.len() && this.starts_with(name) && this.as_bytes()[name.len()] == b'.'))
}

/// grammar.ts's `nameMatcher`: the identifiers appear in order along the scopes.
fn name_matcher(identifiers: &[String], scopes: &[&str]) -> bool {
    if scopes.len() < identifiers.len() {
        return false;
    }
    let mut last = 0;
    identifiers.iter().all(|id| match (last..scopes.len()).find(|&i| scopes_are_matching(scopes[i], id)) {
        Some(i) => {
            last = i + 1;
            true
        }
        None => false,
    })
}

impl Matcher {
    pub fn matches(&self, scopes: &[&str]) -> bool {
        match self {
            Matcher::Names(ids) => name_matcher(ids, scopes),
            Matcher::Not(m) => m.as_ref().is_some_and(|m| !m.matches(scopes)),
            Matcher::And(all) => all.iter().all(|m| m.matches(scopes)),
            Matcher::Or(any) => any.iter().any(|m| m.matches(scopes)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_with_priorities_negation_and_alternatives() {
        let ms = create_matchers("L:source.js - comment, R:(text.html | string) meta");
        assert_eq!(ms.iter().map(|m| m.priority).collect::<Vec<_>>(), vec![-1, 1]);
        assert!(ms[0].matcher.matches(&["source.js", "meta.x"]));
        assert!(!ms[0].matcher.matches(&["source.js", "comment.line"]));
        assert!(ms[1].matcher.matches(&["text.html.basic", "meta.tag"]));
        assert!(!ms[1].matcher.matches(&["source.js", "meta.tag"]));
    }
}
