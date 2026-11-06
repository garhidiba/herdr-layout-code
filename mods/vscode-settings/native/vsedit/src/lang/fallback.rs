//! Without a language server (lang/fallback.cjs): definitions and references by searching the project for the word,
//! formatting with the language's own formatter (gofmt, rustfmt, prettier).

use super::edits::{p16, u16_of, TextEdit};
use super::{run, Ctx, Loc};
use crate::term::which;
use std::path::{Path, PathBuf};
use std::time::Duration;
use vscode_textmate::{OnigString, Scanner};

const KEYWORDS: &str = "func|def|class|fn|const|let|var|type|interface|struct|enum|trait|impl|fun|val|object|typealias|protocol|extension|module|function|static|macro_rules!";
const MAX: usize = 500;

/// grep -E pattern for a definition of `word` (`func (r *T) word`, `def word`, `class word`...).
pub fn definition_pattern(word: &str) -> String {
    format!(r"({KEYWORDS})[[:space:]]+(\([^)]*\)[[:space:]]*)?\*?{word}")
}

fn word_regex(word: &str) -> Option<Scanner> {
    let w = word.replace('$', "\\$");
    Scanner::new(&[format!(r"(?<![\p{{L}}\p{{N}}_$]){w}(?![\p{{L}}\p{{N}}_$])")]).ok()
}

/// `file:line:text` lines -> locations (col: the word's first whole-word match).
pub fn parse_grep(out: &str, root: &Path, word: &str) -> Vec<Loc> {
    let mut re = word_regex(word);
    let mut found = vec![];
    for line in out.lines() {
        let mut parts = line.splitn(3, ':');
        let (Some(f), Some(n), Some(text)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let Ok(n) = n.parse::<usize>() else { continue };
        let col = re.as_mut().and_then(|r| r.find_next_match(&OnigString::new(text.to_string()), 0)).map_or(0, |m| m.captures[0].0.max(0) as usize);
        found.push(Loc { file: root.join(f), line: n.saturating_sub(1), col: u16_of(text, col), end: None, preview: Some(text.to_string()), name: None, detail: String::new() });
        if found.len() >= MAX {
            break;
        }
    }
    found
}

/// Whole-word search under the root (git grep in a repo, else grep -r); `extended` for a regex.
fn search(root: &Path, pattern: &str, extended: bool) -> String {
    let flag = if extended { "-E" } else { "-F" };
    let r = if root.join(".git").exists() {
        run("git", &["grep", "-nIw", flag, "-e", pattern, "--", "."], root, None)
    } else {
        run("grep", &["-rnIw", flag, "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", pattern, "."], root, None)
    };
    r.1.lines().map(|l| l.strip_prefix("./").unwrap_or(l)).collect::<Vec<_>>().join("\n")
}

/// Whole-word occurrences of `word` in lines (UTF-16 columns), as edits replacing it with `text`.
pub fn word_occurrences(lines: &[String], word: &str, text: &str) -> Vec<TextEdit> {
    let Some(mut re) = word_regex(word).filter(|_| !word.is_empty()) else { return vec![] };
    let mut out = vec![];
    for (line, l) in lines.iter().enumerate() {
        let s = OnigString::new(l.clone());
        let mut at = 0;
        while let Some(m) = re.find_next_match(&s, at) {
            let (a, b) = (m.captures[0].0 as usize, m.captures[0].1 as usize);
            out.push(TextEdit { start: p16(line, u16_of(l, a)), end: p16(line, u16_of(l, b)), text: text.into() });
            at = b.max(a + 1);
        }
    }
    out
}

fn prettier_file(file: &Path) -> bool {
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    ["js", "jsx", "ts", "tsx", "mjs", "mts", "mjsx", "mtsx", "cjs", "cts", "css", "scss", "less", "json", "jsonc", "htm", "html", "vue", "yml", "yaml", "md", "markdown", "graphql"].contains(&ext.as_str())
}

/// The formatter for a file: (command, args) reading stdin and writing stdout.
pub fn formatter_for(file: &Path, scope: Option<&str>, root: &Path) -> Option<(PathBuf, Vec<String>)> {
    match scope {
        Some("source.go") => return which("gofmt").map(|g| (g, vec![])),
        Some("source.rust") => return which("rustfmt").map(|r| (r, ["--emit", "stdout", "--edition", "2021"].map(String::from).to_vec())),
        _ => {}
    }
    if !prettier_file(file) {
        return None;
    }
    let local = [root.join("node_modules/.bin/prettier"), file.parent().unwrap_or(root).join("node_modules/.bin/prettier")];
    let p = local.into_iter().find(|p| p.is_file()).or_else(|| which("prettier"))?;
    Some((p, vec!["--stdin-filepath".into(), file.to_string_lossy().into_owned()]))
}

pub struct Fallback {
    root: PathBuf,
    formatter: Option<(PathBuf, Vec<String>)>,
}

impl Fallback {
    pub const LABEL: &'static str = "regex outline";
    pub fn new(file: &Path, scope: Option<&str>, root: &Path) -> Fallback {
        Fallback { root: root.to_path_buf(), formatter: formatter_for(file, scope, root) }
    }
    pub fn can(&self, op: &str) -> bool {
        matches!(op, "definition" | "references" | "rename" | "symbols") || (op == "format" && self.formatter.is_some())
    }
    pub fn definition(&self, ctx: &Ctx) -> Vec<Loc> {
        if ctx.word.is_empty() {
            return vec![];
        }
        let mut all = parse_grep(&search(&self.root, &definition_pattern(&ctx.word), true), &self.root, &ctx.word);
        all.sort_by_key(|l| l.file != ctx.file);
        all
    }
    pub fn references(&self, ctx: &Ctx) -> Vec<Loc> {
        if ctx.word.is_empty() {
            return vec![];
        }
        parse_grep(&search(&self.root, &ctx.word, false), &self.root, &ctx.word)
    }
    pub fn format(&self, ctx: &Ctx) -> Result<Vec<TextEdit>, String> {
        let Some((cmd, args)) = &self.formatter else { return Err(format!("There is no formatter for '{}' files installed.", ctx.language)) };
        let text = ctx.lines.join("\n") + "\n";
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let dir = ctx.file.parent().unwrap_or(&self.root);
        let (code, out, err) = run(&cmd.to_string_lossy(), &args, dir, Some(&text));
        let name = cmd.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        if code != 0 {
            let first = err.trim().lines().next().unwrap_or("failed").to_string();
            return Err(format!("{name}: {}", if first.is_empty() { "failed".into() } else { first }));
        }
        let out = out.replace("\r\n", "\n").replace('\r', "\n");
        let out = out.strip_suffix('\n').unwrap_or(&out);
        let last = ctx.lines.len() - 1;
        Ok(vec![TextEdit { start: p16(0, 0), end: p16(last, ctx.lines[last].encode_utf16().count()), text: out.into() }])
    }
}

pub const TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grep_lines_become_locations_at_the_whole_word() {
        let got = parse_grep("a.go:3:\tx := greeting(greet)\nbad\n", Path::new("/p"), "greet");
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].file.clone(), got[0].line, got[0].col), (PathBuf::from("/p/a.go"), 2, 15));
        let occ = word_occurrences(&["a ab a".into()], "a", "b");
        assert_eq!(occ.iter().map(|e| e.start.col).collect::<Vec<_>>(), [0, 5]);
    }
}
