//! The find widget's rules (find.cjs): matches of a query per line with Match Case, Match Whole Word and Use Regular
//! Expression (Oniguruma, the tokenizer's engine, standing in for JavaScript's RegExp), and a match's replacement
//! ($1, $&, $<name>, \n and \t with a regex). Matches never span lines; empty matches are skipped.

use crate::decorations::Hit;
use vscode_textmate::{OnigString, Scanner};

pub const LIMIT: usize = 20000;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Opts {
    pub case: bool,
    pub word: bool,
    pub regex: bool,
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if ".*+?^${}()|[]\\/".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The search pattern, None for an empty query.
pub fn pattern(query: &str, o: Opts) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    let src = if o.regex { query.to_string() } else { escape(query) };
    let w = "[\\p{L}\\p{N}_$]";
    let body = if o.word { format!("(?<!{w})(?:{src})(?!{w})") } else { src };
    Some(if o.case { body } else { format!("(?i){body}") })
}

/// Matches (at most `limit`) and the regex error, if any.
pub fn find_matches(lines: &[String], query: &str, o: Opts, limit: usize) -> (Vec<Hit>, Option<String>) {
    let Some(p) = pattern(query, o) else { return (vec![], None) };
    let mut scanner = match Scanner::new(&[p]) {
        Ok(s) => s,
        Err(e) => return (vec![], Some(e)),
    };
    let mut out = vec![];
    for (l, text) in lines.iter().enumerate() {
        if out.len() >= limit {
            break;
        }
        if text.is_empty() && !o.regex {
            continue;
        }
        let s = OnigString::new(text.clone());
        let mut at = 0;
        while out.len() < limit && at <= text.len() {
            let Some(m) = scanner.find_next_match(&s, at) else { break };
            let (a, b) = (m.captures[0].0 as usize, m.captures[0].1 as usize);
            if a == b {
                at = a + text[a..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            out.push((l, a, b - a));
            at = b;
        }
    }
    (out, None)
}

/// The text that replaces match `m` on `line`: the replace string as is, or with a regex its groups substituted.
pub fn replacement_of(line: &str, m: Hit, query: &str, o: Opts, replace: &str) -> String {
    if !o.regex {
        return replace.to_string();
    }
    let Some(p) = pattern(query, o) else { return replace.to_string() };
    let Ok(mut scanner) = Scanner::new(&[format!("\\G(?:{p})")]) else { return replace.to_string() };
    let Some(found) = scanner.find_next_match(&OnigString::new(line.to_string()), m.1) else { return replace.to_string() };
    let group = |k: usize| -> &str {
        match found.captures.get(k) {
            Some(&(a, b)) if a >= 0 && b >= a => &line[a as usize..b as usize],
            _ => "",
        }
    };
    let names = group_names(&p);
    let mut out = String::new();
    let mut it = replace.chars().peekable();
    while let Some(c) = it.next() {
        match (c, it.peek().copied()) {
            ('\\', Some('n')) => {
                it.next();
                out.push('\n');
            }
            ('\\', Some('t')) => {
                it.next();
                out.push('\t');
            }
            ('\\', Some('\\')) => {
                it.next();
                out.push('\\');
            }
            ('$', Some('&')) => {
                it.next();
                out.push_str(group(0));
            }
            ('$', Some('$')) => {
                it.next();
                out.push('$');
            }
            ('$', Some(d)) if d.is_ascii_digit() => {
                it.next();
                let mut n = d.to_digit(10).unwrap() as usize;
                if let Some(e) = it.peek().and_then(|e| e.to_digit(10)) {
                    if n * 10 + (e as usize) < found.captures.len() {
                        n = n * 10 + e as usize;
                        it.next();
                    }
                }
                if n > 0 && n < found.captures.len() {
                    out.push_str(group(n));
                } else {
                    out.push('$');
                    out.push(d);
                }
            }
            ('$', Some('<')) => {
                let rest: String = it.clone().collect();
                match rest[1..].find('>') {
                    Some(k) => {
                        let name = &rest[1..k + 1];
                        if let Some(i) = names.iter().position(|n| n == name) {
                            out.push_str(group(i + 1));
                        }
                        for _ in 0..k + 2 {
                            it.next();
                        }
                    }
                    None => out.push('$'),
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Capture group names in order (unnamed groups as ""), as numbered with ONIG_OPTION_CAPTURE_GROUP.
fn group_names(p: &str) -> Vec<String> {
    let b = p.as_bytes();
    let (mut out, mut i, mut class) = (vec![], 0, false);
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'[' => class = true,
            b']' => class = false,
            b'(' if !class => {
                if b.get(i + 1) != Some(&b'?') {
                    out.push(String::new());
                } else if b.get(i + 2) == Some(&b'<') && !matches!(b.get(i + 3), Some(b'=') | Some(b'!')) {
                    let end = p[i + 3..].find('>').map_or(p.len(), |k| i + 3 + k);
                    out.push(p[i + 3..end].to_string());
                }
            }
            _ => {}
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn case_and_whole_word_narrow_the_matches() {
        let l = lines(&["Foo foo food", "bar foo"]);
        let n = |o| find_matches(&l, "foo", o, LIMIT).0.len();
        assert_eq!(n(Opts::default()), 4);
        assert_eq!(n(Opts { case: true, ..Default::default() }), 3);
        assert_eq!(n(Opts { case: true, word: true, ..Default::default() }), 2);
    }

    #[test]
    fn plain_queries_are_literal_and_bad_regexes_report_an_error() {
        let l = lines(&["a.b axb (x)"]);
        assert_eq!(find_matches(&l, "a.b", Opts::default(), LIMIT).0, vec![(0, 0, 3)]);
        assert_eq!(find_matches(&l, "a.b", Opts { regex: true, ..Default::default() }, LIMIT).0.len(), 2);
        assert!(find_matches(&l, "(", Opts { regex: true, ..Default::default() }, LIMIT).1.is_some());
        assert_eq!(find_matches(&l, "x*", Opts { regex: true, ..Default::default() }, LIMIT).0, vec![(0, 5, 1), (0, 9, 1)]);
    }

    #[test]
    fn regex_replacements_substitute_groups() {
        let o = Opts { regex: true, ..Default::default() };
        let line = "let width = 10;";
        let m = find_matches(&lines(&[line]), "(\\w+) = (?<n>\\d+)", o, LIMIT).0[0];
        assert_eq!(replacement_of(line, m, "(\\w+) = (?<n>\\d+)", o, "$<n>:$1\\t$&"), "10:width\twidth = 10");
        assert_eq!(replacement_of(line, m, "x", Opts::default(), "$1"), "$1");
    }
}
