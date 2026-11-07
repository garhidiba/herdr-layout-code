//! AI inline suggestions (inline.cjs): the settings, which files and positions get one, the request context, the ghost
//! text's rules (typing through it, accept next word), each provider's request and reply (POSTed with `curl`, killed
//! when a newer request or an edit makes it stale), the reply checks that pause a misbehaving provider, and the daily
//! usage file (requests, approximate tokens, latency). The editor (editor/inline_ui.rs) owns timers, keys and drawing.

use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

pub const PROVIDERS: &[&str] = &["ollama", "lmstudio", "codestral", "mercury", "off"];
/// Providers no longer offered, read as "off" (DeepSeek: its request limits); their stored keys are left alone.
const RETIRED: &[&str] = &["deepseek"];
/// Hosted FIM APIs, one adapter (POST {model, prompt, suffix, max_tokens, stop, stream} with a Bearer key): label, model,
/// URL, the key's environment variable, USD per million input / output tokens (editor.inlineSuggest.price overrides).
pub struct Hosted {
    pub id: &'static str,
    label: &'static str,
    model: &'static str,
    url: &'static str,
    pub env: &'static str,
    price: (f64, f64),
}
pub const HOSTED: &[Hosted] = &[
    Hosted { id: "codestral", label: "Codestral", model: "codestral-latest", url: "https://api.mistral.ai/v1/fim/completions", env: "MISTRAL_API_KEY", price: (0.3, 0.9) },
    Hosted { id: "mercury", label: "Mercury", model: "mercury-edit-2", url: "https://api.inceptionlabs.ai/v1/fim/completions", env: "INCEPTION_API_KEY", price: (0.25, 0.75) },
];
/// Requests a day by default for a paid provider (Ollama: unlimited).
const HOSTED_LIMIT: u64 = 2000;
fn hosted(provider: &str) -> Option<&'static Hosted> {
    HOSTED.iter().find(|h| h.id == provider)
}
/// The environment variable holding the provider's key: a hosted API's, or a local server's optional one (a proxy or a
/// protected server in front of it).
fn key_env(provider: &str) -> &'static str {
    match provider {
        "ollama" => "HERDR_OLLAMA_API_KEY",
        "lmstudio" => "HERDR_LMSTUDIO_API_KEY",
        _ => hosted(provider).map_or("", |h| h.env),
    }
}
/// Ollama's default model: a base (FIM) model; 1.5B answers in ~0.1–0.6 s here, 7B in 0.3–2.5 s (DESIGN.md).
pub const OLLAMA_MODEL: &str = "qwen2.5-coder:1.5b-base";
/// LM Studio's default model: the same base model under LM Studio's name.
pub const LMSTUDIO_MODEL: &str = "qwen2.5-coder-1.5b";
/// No suggestions in bigger files (characters).
pub const MAX_FILE_CHARS: usize = 1_000_000;
const TIMEOUT_S: u32 = 20;
/// Never sent to a provider (file names, or paths when the pattern has a "/"); editor.inlineSuggest.exclude adds to it.
pub const EXCLUDE: &[&str] = &[
    ".env", ".env.*", "*.env", ".envrc", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.asc", "*.gpg", "id_rsa*", "id_dsa*", "id_ecdsa*",
    "id_ed25519*", "*.ppk", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd", "credentials", "credentials.*", "secrets.*", "*.secret", "*.secrets",
    "**/.ssh/**", "**/.aws/**", "**/.gnupg/**", "**/github-copilot/**",
];
/// Template tokens of the FIM models (Qwen, StarCoder, DeepSeek, Codestral, Code Llama) that never belong in a reply.
const FIM_TOKENS: &[&str] = &[
    "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>", "<|endoftext|>", "<|file_sep|>", "<|repo_name|>", "<|im_start|>", "<|im_end|>",
    "<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<file_sep>", "<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<｜end▁of▁sentence｜>", "[PREFIX]",
    "[SUFFIX]", "[MIDDLE]", "<PRE>", "<SUF>", "<MID>", "<EOT>",
];

/// editor.inlineSuggest.* as the file has them (normalized).
#[derive(Clone, Debug, PartialEq)]
pub struct InlineSettings {
    /// None: on when the provider can run here
    pub enabled: Option<bool>,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub manual: bool,
    pub multiline: bool,
    pub debounce: u64,
    pub max_tokens: u64,
    pub prefix_chars: usize,
    pub suffix_chars: usize,
    pub stop_after: u32,
    /// requests a day before suggestions stop until tomorrow; 0: unlimited; None: 2,000 for a paid provider, Ollama 0
    pub daily_limit: Option<u64>,
    /// USD per million input / output tokens for the cost estimate; None: HOSTED's
    pub price: Option<(f64, f64)>,
    pub keep_alive: String,
    pub exclude: Vec<String>,
}

impl Default for InlineSettings {
    fn default() -> Self {
        InlineSettings {
            enabled: None,
            provider: "ollama".into(),
            model: String::new(),
            endpoint: String::new(),
            manual: false,
            multiline: true,
            debounce: 250,
            max_tokens: 256,
            prefix_chars: 4000,
            suffix_chars: 300,
            stop_after: 5,
            daily_limit: None,
            price: None,
            keep_alive: "30m".into(),
            exclude: vec![],
        }
    }
}

/// A raw settings object -> the inline settings with valid values (invalid ones are the default).
pub fn normalize(raw: &Value) -> InlineSettings {
    let get = |k: &str| &raw[format!("editor.inlineSuggest.{k}")];
    let mut v = InlineSettings { enabled: get("enabled").as_bool(), ..InlineSettings::default() };
    match get("provider").as_str() {
        Some(p) if PROVIDERS.contains(&p) => v.provider = p.into(),
        Some(p) if RETIRED.contains(&p) => v.provider = "off".into(),
        _ => {}
    }
    let text = |k: &str| get(k).as_str().map(|s| s.trim().to_string());
    // editor.inlineSuggest.<provider>.model / .endpoint: that provider's own, over the shared ones
    let provider = v.provider.clone();
    let own = |k: &str| text(&format!("{provider}.{k}")).filter(|s| !s.is_empty()).or_else(|| text(k)).unwrap_or_default();
    v.model = own("model");
    v.endpoint = own("endpoint");
    if let Some(k) = text("keepAlive").filter(|k| !k.is_empty()) {
        v.keep_alive = k;
    }
    v.manual = get("trigger").as_str() == Some("manual");
    v.multiline = get("multiline").as_bool().unwrap_or(true);
    let num = |k: &str, lo: f64, hi: f64| get(k).as_f64().filter(|n| n.is_finite()).map(|n| n.clamp(lo, hi).round());
    if let Some(n) = num("debounce", 0.0, 5000.0) {
        v.debounce = n as u64;
    }
    if let Some(n) = num("maxTokens", 1.0, 2048.0) {
        v.max_tokens = n as u64;
    }
    if let Some(n) = num("prefixChars", 0.0, 100000.0) {
        v.prefix_chars = n as usize;
    }
    if let Some(n) = num("suffixChars", 0.0, 100000.0) {
        v.suffix_chars = n as usize;
    }
    if let Some(n) = num("stopAfter", 1.0, 100.0) {
        v.stop_after = n as u32;
    }
    if let Some(n) = num("dailyRequestLimit", 0.0, 1e7) {
        v.daily_limit = Some(n as u64);
    }
    let price = get("price");
    if let (Some(i), Some(o)) = (price["input"].as_f64().filter(|n| *n >= 0.0), price["output"].as_f64().filter(|n| *n >= 0.0)) {
        v.price = Some((i, o));
    }
    v.exclude = get("exclude").as_array().into_iter().flatten().filter_map(Value::as_str).filter(|s| !s.trim().is_empty()).map(String::from).collect();
    v
}

/// What the editor runs with.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub provider: String,
    pub label: &'static str,
    pub model: String,
    pub endpoint: String,
    pub custom_endpoint: bool,
    pub manual: bool,
    pub multiline: bool,
    pub debounce: u64,
    pub max_tokens: u64,
    pub prefix_chars: usize,
    pub suffix_chars: usize,
    pub stop_after: u32,
    pub keep_alive: String,
    pub exclude: Vec<String>,
    /// requests a day, 0: unlimited
    pub limit: u64,
    /// A paid hosted FIM API (HOSTED)
    pub hosted: bool,
    /// USD per million input / output tokens, None: free
    pub price: Option<(f64, f64)>,
    /// provider:model, the usage file's and the pauses' key
    pub key: String,
    pub enabled: bool,
}

/// Settings -> the config; `usable` says whether the provider can run here (the default of `enabled`).
pub fn config(s: &InlineSettings, usable: impl Fn(&Config) -> bool) -> Config {
    let p = s.provider.as_str();
    let h = hosted(p);
    let (label, model, endpoint) = match (p, h) {
        ("ollama", _) => ("Ollama", OLLAMA_MODEL, "http://127.0.0.1:11434"),
        ("lmstudio", _) => ("LM Studio", LMSTUDIO_MODEL, "http://127.0.0.1:1234"),
        (_, Some(h)) => (h.label, h.model, h.url),
        _ => ("Inline Suggestions", "", ""),
    };
    let model = if s.model.is_empty() { model.to_string() } else { s.model.clone() };
    let endpoint = if s.endpoint.is_empty() { endpoint } else { &s.endpoint }.trim_end_matches('/');
    // LM Studio's address as its Developer tab shows it ends in /v1: the requests add their own
    let endpoint = if p == "lmstudio" { endpoint.strip_suffix("/v1").unwrap_or(endpoint) } else { endpoint }.to_string();
    let mut cfg = Config {
        provider: p.into(),
        label,
        key: format!("{p}:{model}"),
        model,
        endpoint,
        custom_endpoint: !s.endpoint.is_empty(),
        manual: s.manual,
        multiline: s.multiline,
        debounce: s.debounce,
        max_tokens: s.max_tokens,
        prefix_chars: s.prefix_chars,
        suffix_chars: s.suffix_chars,
        stop_after: s.stop_after,
        keep_alive: s.keep_alive.clone(),
        exclude: EXCLUDE.iter().map(|e| e.to_string()).chain(s.exclude.iter().cloned()).collect(),
        limit: s.daily_limit.unwrap_or(if h.is_some() { HOSTED_LIMIT } else { 0 }),
        hosted: h.is_some(),
        price: s.price.or(h.map(|h| h.price)),
        enabled: false,
    };
    cfg.enabled = p != "off" && s.enabled.unwrap_or_else(|| usable(&cfg));
    cfg
}

// ---------- a remote editor's suggestions come from the desktop typing in it (VS Code Remote's way) ----------
// On a remote machine (VSEDIT_DESKTOPS: the bundle root's desktops/, remote-vsedit.sh) the editor never asks a provider
// itself: the desktop whose window last focused a remote editor there marks itself `active`, and its tunnel (link.cjs)
// is announced as <id>.json {port, token}. Its provider, model and key are used, the key never leaving that desktop.
// None (no tunnel, another desktop's gone): suggestions are quietly off, said once.

pub const NO_DESKTOP: &str = "Inline suggestions are off here: they come from the Herdr desktop you type on, and none is connected to this machine";

pub fn desktops_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(d) = TEST_DESKTOPS.with(|d| d.borrow().clone()) {
        return Some(d);
    }
    std::env::var_os("VSEDIT_DESKTOPS").filter(|d| !d.is_empty()).map(PathBuf::from)
}
#[cfg(test)]
thread_local! {
    /// A test's VSEDIT_DESKTOPS, for its thread only (the environment is the whole test process's).
    pub static TEST_DESKTOPS: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// The active desktop's tunnel: (port, token).
pub fn desktop(dir: &Path) -> Option<(u16, String)> {
    let id = std::fs::read_to_string(dir.join("active")).ok()?;
    let id = id.trim();
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{id}.json"))).ok()?).ok()?;
    let port = u16::try_from(v["port"].as_u64()?).ok().filter(|p| *p > 0)?;
    let token = v["token"].as_str().filter(|t| (16..=128).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))?;
    Some((port, token.to_string()))
}

/// A remote editor's config: the desktop's proxy instead of the provider (its address comes per request from desktop()).
/// On unless the provider is off or suggestions were turned off (`enabled`: the editor.inlineSuggest.enabled setting).
pub fn via_desktop(cfg: Config, enabled: Option<bool>) -> Config {
    Config {
        enabled: cfg.provider != "off" && enabled != Some(false),
        provider: "desktop".into(),
        label: "Desktop",
        model: String::new(),
        endpoint: String::new(),
        custom_endpoint: false,
        hosted: false,
        limit: 0,
        price: None,
        key: "desktop".into(),
        ..cfg
    }
}

// ---------- which files and positions ----------

/// A glob (`*`, `?`, `**` across folders) against `s`, case-insensitive.
pub fn glob(p: &str, s: &str) -> bool {
    fn go(p: &[char], s: &[char]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => {
                let rest = if p.get(2) == Some(&'/') { &p[3..] } else { &p[2..] };
                (0..=s.len()).any(|i| go(rest, &s[i..]))
            }
            Some('*') => (0..=s.len()).take_while(|i| *i == 0 || s[i - 1] != '/').any(|i| go(&p[1..], &s[i..])),
            Some('?') => s.first().is_some_and(|c| *c != '/') && go(&p[1..], &s[1..]),
            Some(c) => s.first() == Some(c) && go(&p[1..], &s[1..]),
        }
    }
    let lower = |t: &str| t.to_lowercase().chars().collect::<Vec<char>>();
    go(&lower(p), &lower(s))
}

/// True when the file matches a deny pattern: a name pattern against the file name, a path pattern against the path.
pub fn denied(file: &Path, patterns: &[String]) -> bool {
    let full = file.to_string_lossy();
    let base = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    patterns.iter().any(|p| {
        if p.contains('/') {
            let p = if p.starts_with('/') || p.starts_with("**") { p.clone() } else { format!("**/{p}") };
            glob(&p, &full)
        } else {
            glob(p, &base)
        }
    })
}

/// VS Code's rule: a suggestion only where the rest of the line is blank or closing characters (not inside a word).
pub fn at_suggestable(line: &str, col: usize) -> bool {
    line[col.min(line.len())..].chars().all(|c| c.is_whitespace() || ")]}>\"'`;,.:".contains(c))
}

/// A blank line after a blank line with nothing below it: no suggestion after typing there (Alt+\ still asks).
pub fn quiet_end(lines: &[String], line: usize) -> bool {
    line > 0 && lines[line - 1].trim().is_empty() && lines[line..].iter().all(|l| l.trim().is_empty())
}

/// The text around the cursor (`col` a byte offset) within the character caps. The prefix starts at a line start (only
/// the cursor line itself is ever cut), so typing on doesn't shift its start and Ollama's prompt cache keeps it.
#[derive(Clone, Default)]
pub struct Context {
    pub prefix: String,
    pub suffix: String,
    /// The file's path (Codestral's prompt_cache_key).
    pub file: String,
    /// A prose or markup file (prose_file): sentences and Markdown fences stay.
    pub prose: bool,
    /// The cursor ends a finished statement (`;` `{` `}` `)` `,` `:` before it, nothing after): a one-line suggestion
    /// may be the next line.
    pub next_line: bool,
}

pub fn context_at(lines: &[String], line: usize, col: usize, prefix_chars: usize, suffix_chars: usize) -> Context {
    let before = lines[line][..col].trim_end();
    let next_line = before.ends_with([';', '{', '}', ')', ',', ':']) && lines[line][col..].trim().is_empty();
    let mut prefix = lines[line][..col].to_string();
    let mut l = line;
    while l > 0 && prefix.chars().count() + lines[l - 1].chars().count() < prefix_chars {
        l -= 1;
        prefix = format!("{}\n{prefix}", lines[l]);
    }
    let mut suffix = lines[line][col..].to_string();
    let mut l = line + 1;
    while l < lines.len() && suffix.chars().count() < suffix_chars {
        suffix.push('\n');
        suffix.push_str(&lines[l]);
        l += 1;
    }
    let n = prefix.chars().count();
    let prefix: String = prefix.chars().skip(n.saturating_sub(prefix_chars)).collect();
    Context { prefix, suffix: suffix.chars().take(suffix_chars).collect(), next_line, ..Context::default() }
}

// ---------- the ghost text ----------

/// Typing `text` where a suggestion shows: the suggestions that start with it, less it; None when none does or nothing
/// would be left.
pub fn type_through(items: &[String], text: &str) -> Option<Vec<String>> {
    let left: Vec<String> = items.iter().filter(|s| s.starts_with(text) && s.len() > text.len()).map(|s| s[text.len()..].to_string()).collect();
    (!left.is_empty()).then_some(left)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Bytes of `text` Accept Next Word takes (VS Code's): a line break with the next line's indent, else spaces and one
/// word or one run of punctuation.
pub fn next_word_len(text: &str) -> usize {
    let blank = |c: char| c == ' ' || c == '\t';
    let skip = |from: usize, f: &dyn Fn(char) -> bool| text[from..].char_indices().find(|(_, c)| !f(*c)).map_or(text.len(), |(i, _)| from + i);
    let nl = if text.starts_with("\r\n") { 2 } else if text.starts_with('\n') { 1 } else { 0 };
    if nl > 0 {
        return skip(nl, &blank);
    }
    let lead = skip(0, &blank);
    match text[lead..].chars().next() {
        Some(c) if is_word(c) => skip(lead, &is_word),
        Some(c) if !c.is_whitespace() => skip(lead, &|c: char| !c.is_whitespace() && !is_word(c)),
        _ if lead > 0 => lead,
        _ => text.len(),
    }
}

/// Bytes of `text` Accept Next Line takes: up to its next line break (a leading one with the line after it).
pub fn next_line_len(text: &str) -> usize {
    let from = usize::from(text.starts_with('\n'));
    text[from..].find('\n').map_or(text.len(), |i| from + i)
}

/// The suggestion less the end of the line it would repeat (`)` an auto-closed pair already put after the cursor).
pub fn trim_line_suffix(text: &str, line_suffix: &str) -> String {
    let s = line_suffix.trim_end();
    if s.is_empty() {
        return text.to_string();
    }
    let (head, last) = text.rsplit_once('\n').map_or(("", text), |(h, l)| (h, l));
    let last = last.trim_end();
    let last = last.strip_suffix(s).unwrap_or(last);
    if text.contains('\n') { format!("{head}\n{last}") } else { last.to_string() }
}

/// Prose and markup files, where sentences and Markdown fences are what the user writes.
pub fn prose_file(file: &Path) -> bool {
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    name == "COMMIT_EDITMSG" || ["md", "markdown", "mdx", "txt", "text", "rst", "adoc", "asciidoc", "org", "tex", "html", "htm", "xml"].contains(&ext.as_str())
}

/// How a chat model's answer starts ("Here's …", "This file defines …"), matched case-insensitively up to a word end.
const PROSE: &[&str] = &[
    "here's", "here is", "here are", "this file", "this code", "this script", "this docker", "this compose", "this function", "this config", "this configuration", "this is",
    "this will", "this define", "this defines", "the following", "the above", "the code", "the file", "sure", "certainly", "i'm", "i'll", "i am", "i will", "i have",
    "let's", "note:", "explanation:",
];

/// A chat model's answer instead of code: a PROSE start, or a sentence: a capitalized word and 3+ more words (no code
/// characters) up to one ending in . : ! or ?.
fn prose(line: &str) -> bool {
    let low = line.to_lowercase();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    if PROSE.iter().any(|p| low.starts_with(p) && (p.ends_with(':') || !low[p.len()..].starts_with(word))) {
        return true;
    }
    let words: Vec<&str> = line.split(' ').filter(|w| !w.is_empty()).collect();
    let Some(k) = words.iter().position(|w| w.ends_with(['.', ':', '!', '?'])) else { return false };
    let first = words[0].as_bytes();
    k >= 3
        && first[0].is_ascii_uppercase()
        && first.len() > 1
        && first[1..].iter().all(u8::is_ascii_lowercase)
        && words[..=k].iter().all(|w| w.chars().any(|c| c.is_ascii_alphabetic()) && !w.contains(['=', ';', '{', '}', '(', ')', '<', '>', '$', '[', ']']))
}

/// The cursor is in a comment or a string (a sentence may belong there): the line starts a comment, a quote on it is
/// open, or a Python docstring is.
fn in_text(prefix: &str) -> bool {
    let line = prefix.rsplit('\n').next().unwrap_or("");
    let t = line.trim_start();
    ["#", "//", "/*", "*", "--", "<!--"].iter().any(|m| t.starts_with(m))
        || ['"', '\'', '`'].iter().any(|q| line.matches(*q).count() % 2 == 1)
        || ["\"\"\"", "'''"].iter().any(|q| prefix.matches(q).count() % 2 == 1)
}

/// Bytes of a leading Markdown fence line (```` ```lang ````, its line break too), 0 when the text has none.
fn leading_fence(text: &str) -> usize {
    let t = text.trim_start();
    let Some(rest) = t.strip_prefix("```") else { return 0 };
    let lang = rest.find(|c: char| !(c.is_ascii_alphanumeric() || "_+.#-".contains(c))).unwrap_or(rest.len());
    let after = rest[lang..].trim_start_matches([' ', '\t']);
    let n = text.len() - after.len();
    if after.is_empty() {
        n
    } else if after.starts_with('\n') {
        n + 1
    } else {
        0
    }
}

/// Where a block suggestion ends (VS Code / Copilot's rules), over the lines complete so far (all when `last`): before a
/// line less indented than the block's first line, before one closing a bracket opened before the cursor, after the line
/// closing a bracket the first line opened, before two blank lines, before the line the text after the cursor goes on
/// with. At the end of the file a closing line (`}`) ends the block with it. -> (text, a rule cut it)
pub fn block_cut(text: &str, ctx: &Context, last: bool) -> (String, bool) {
    let lines: Vec<&str> = text.split('\n').collect();
    let n = if last { lines.len() } else { lines.len() - 1 };
    let lead = ctx.prefix.rsplit('\n').next().unwrap_or("");
    let next = ctx.suffix.split('\n').map(str::trim).find(|l| !l.is_empty());
    let indent = |l: &str| l.len() - l.trim_start_matches([' ', '\t']).len();
    let up_to = |k: usize| (lines[..k].join("\n").trim_end().to_string(), true);
    let (mut base, mut depth, mut opener, mut blanks) = (None, 0i32, false, 0);
    for (i, line) in lines[..n].iter().enumerate() {
        let t = line.trim();
        if t.is_empty() {
            blanks += 1;
            if i > 0 && blanks == 2 {
                return up_to(i - 1);
            }
            continue;
        }
        blanks = 0;
        let before = depth;
        let mut low = depth;
        for c in line.chars() {
            if "([{".contains(c) {
                depth += 1;
            } else if ")]}".contains(c) {
                depth -= 1;
                low = low.min(depth);
            }
        }
        let Some(b) = base else {
            base = Some(indent(&if i == 0 { format!("{lead}{line}") } else { line.to_string() }));
            depth = depth.max(0);
            opener = depth > 0;
            continue;
        };
        if indent(line) < b || low < 0 {
            return up_to(if ctx.suffix.trim().is_empty() && t.starts_with([')', ']', '}']) { i + 1 } else { i });
        }
        if opener && before > 0 && depth == 0 {
            return up_to(i + 1);
        }
        if before == 0 && Some(t) == next {
            return up_to(i);
        }
    }
    (lines[..n].join("\n"), false)
}

/// The suggestion up to the loop a small model can fall into: before the first block of 1-8 lines (not all blank) written
/// again right after itself (the first copy stays, lines compared without trailing spaces), and less a last line that is
/// the line the text after the cursor goes on with, indent and all (a FIM model writes it again). The text itself when
/// nothing is cut.
pub fn cut_repeats(text: &str, suffix: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let key: Vec<&str> = lines.iter().map(|l| l.trim_end()).collect();
    let n = lines.len();
    let repeats = |i: usize, p: usize| key[i..i + p].iter().any(|l| !l.is_empty()) && key[i..i + p] == key[i + p..i + 2 * p];
    let mut end = (0..n).find_map(|i| (1..=8).take_while(|p| i + 2 * p <= n).find(|&p| repeats(i, p)).map(|p| i + p)).unwrap_or(n);
    let next = suffix.split('\n').map(str::trim_end).find(|l| !l.is_empty());
    if let Some(last) = (1..end).rev().find(|&k| !key[k].is_empty()) {
        if Some(key[last]) == next {
            end = last;
        }
    }
    if end == n { text.to_string() } else { lines[..end].join("\n") }
}

/// A provider's raw text -> (text, anomaly): None when nothing is left; anomaly "fim" (template tokens: pause now),
/// "prose" (sentences, not code), "fence" (a Markdown fence alone), "echo" (the text before or after the cursor repeated)
/// or "empty". Cuts what follows a FIM token, Markdown fences (a leading one with its language), a repeat of the text
/// after the cursor, a loop (cut_repeats), and the end of a block (block_cut) or, in one-line mode, the first line
/// break — after the next line's text when `next_line`. Prose files keep sentences and fences.
pub fn clean(raw: &str, ctx: &Context, multiline: bool) -> (Option<String>, Option<&'static str>) {
    let (prefix, suffix) = (ctx.prefix.as_str(), ctx.suffix.as_str());
    let mut text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut anomaly = None;
    if let Some(i) = FIM_TOKENS.iter().filter_map(|t| text.find(t)).min() {
        text.truncate(i);
        anomaly = Some("fim");
    }
    if !ctx.prose {
        let fence = leading_fence(&text);
        text.drain(..fence);
        let mut at = 0;
        let end = text.split('\n').find_map(|l| {
            let found = l.trim_start_matches([' ', '\t']).starts_with("```").then_some(at);
            at += l.len() + 1;
            found
        });
        if let Some(e) = end {
            text.truncate(e);
        }
        if (fence > 0 || end.is_some()) && text.trim().is_empty() {
            return (None, Some("fence"));
        }
        if !in_text(prefix) && prose(text.trim().split('\n').next().unwrap_or("")) {
            return (None, Some("prose"));
        }
    }
    if !multiline {
        let next = ctx.next_line && text.starts_with('\n');
        let rest = text.trim_start_matches('\n');
        text = if next { format!("\n{}", rest.split('\n').next().unwrap_or("")) } else { text.split('\n').next().unwrap_or("").to_string() };
    } else {
        text = block_cut(&text, ctx, true).0;
    }
    let tail = prefix.rsplit('\n').next().unwrap_or("").trim();
    if tail.chars().count() >= 4 && text.trim_start().starts_with(tail) {
        text = text.trim_start()[tail.len()..].to_string();
        anomaly = anomaly.or(Some("echo"));
    }
    // the text after the cursor written again: a run of its first lines (4 characters at least) from a line of the reply
    // (blocks: block_cut stops at it)
    let after: Vec<&str> = if multiline { vec![] } else { suffix.split('\n').map(str::trim).filter(|l| !l.is_empty()).take(3).collect() };
    let lines: Vec<&str> = text.split('\n').collect();
    for k in 0..lines.len() {
        let (mut j, mut n) = (0, 0);
        while j < after.len() && k + j < lines.len() && lines[k + j].trim() == after[j] {
            n += after[j].encode_utf16().count();
            j += 1;
        }
        if j > 0 && (n >= 4 || (k + j == lines.len() && j == after.len())) {
            text = lines[..k].join("\n");
            if text.trim().is_empty() {
                anomaly = anomaly.or(Some("echo"));
            }
            break;
        }
    }
    let text = trim_line_suffix(cut_repeats(&text, suffix).trim_end(), suffix.split('\n').next().unwrap_or(""));
    if !text.trim().is_empty() && suffix.trim_start().starts_with(text.trim()) {
        return (None, Some("echo")); // only the text after the cursor
    }
    if text.trim().is_empty() {
        return (None, Some(anomaly.unwrap_or("empty")));
    }
    (Some(text), anomaly)
}

/// Why a reply was dropped, for the status bar's tooltip.
fn dropped(anomaly: &str) -> Option<&'static str> {
    match anomaly {
        "echo" => Some("it repeated the text around the cursor"),
        "prose" => Some("it was prose, not code"),
        "fence" => Some("it was a Markdown code fence"),
        _ => None,
    }
}

/// Pauses a provider that keeps misbehaving: FIM tokens at once, `limit` errors in a row, 4 × `limit` dropped replies
/// (prose, fences, repeats) in a row. An empty reply (nothing fits there) counts for nothing. `note`: what happened last.
pub struct Health {
    limit: u32,
    errors: u32,
    dropped: u32,
    pub paused: Option<String>,
    pub note: Option<String>,
}

impl Health {
    pub fn new(limit: u32) -> Health {
        Health { limit, errors: 0, dropped: 0, paused: None, note: None }
    }
    pub fn record(&mut self, anomaly: Option<&str>, error: Option<&str>) -> Option<String> {
        if anomaly == Some("fim") {
            self.paused = Some("the reply had FIM template tokens (wrong model or template?)".into());
            return self.paused.clone();
        }
        if let Some(e) = error {
            self.note = Some(e.to_string());
            self.errors += 1;
            if self.errors >= self.limit {
                self.paused = Some(format!("{} errors in a row: {e}", self.errors));
            }
            return self.paused.clone();
        }
        self.errors = 0;
        let Some(why) = anomaly.and_then(dropped) else {
            self.note = (anomaly == Some("empty")).then(|| "the last reply was empty (nothing to suggest there)".to_string());
            if anomaly.is_none() {
                self.dropped = 0;
            }
            return None;
        };
        self.note = Some(format!("the last reply was dropped: {why}"));
        self.dropped += 1;
        if self.dropped >= self.limit * 4 {
            self.paused = Some(format!("{} replies in a row were dropped (the last: {why}); a base model does better", self.dropped));
        }
        self.paused.clone()
    }
}

// ---------- providers ----------

pub struct Request {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// A FIM prompt template, sent raw (Ollama's `suffix` falls back to the chat template when the text after the cursor is
/// empty, and a chat model answers in prose there). spm: the suffix goes first.
pub struct Template {
    spm: bool,
    pre: &'static str,
    mid: &'static str,
    end: &'static str,
    stop: &'static [&'static str],
}

const QWEN: Template = Template {
    spm: false,
    pre: "<|fim_prefix|>",
    mid: "<|fim_suffix|>",
    end: "<|fim_middle|>",
    stop: &["<|endoftext|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>", "<|file_sep|>", "<|repo_name|>", "<|im_start|>", "<|im_end|>", "<|cursor|>"],
};
const CODESTRAL: Template = Template { spm: true, pre: "[SUFFIX]", mid: "[PREFIX] ", end: "", stop: &["[INST]", "[/INST]", "[PREFIX]", "[SUFFIX]", "[MIDDLE]", "</s>"] };
const DEEPSEEK: Template = Template {
    spm: false,
    pre: "<｜fim▁begin｜>",
    mid: "<｜fim▁hole｜>",
    end: "<｜fim▁end｜>",
    stop: &["<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<｜end▁of▁sentence｜>", "<|EOT|>"],
};
const STARCODER: Template = Template { spm: false, pre: "<fim_prefix>", mid: "<fim_suffix>", end: "<fim_middle>", stop: &["<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<|endoftext|>", "<file_sep>"] };

/// The FIM template of a model's family (Qwen coder, Codestral, DeepSeek Coder, StarCoder); None: Ollama's `suffix`.
pub fn template(model: &str) -> Option<&'static Template> {
    let m = model.to_lowercase();
    let qwen = m.contains("codeqwen")
        || m.match_indices("qwen").any(|(i, _)| {
            let r = m[i + 4..].trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
            r.strip_prefix('-').unwrap_or(r).starts_with("coder")
        });
    if qwen {
        Some(&QWEN)
    } else if m.contains("codestral") {
        Some(&CODESTRAL)
    } else if m.contains("deepseek-coder") {
        Some(&DEEPSEEK)
    } else if m.contains("starcoder") {
        Some(&STARCODER)
    } else {
        None
    }
}

fn fim_prompt(t: &Template, prefix: &str, suffix: &str) -> String {
    let (a, b) = if t.spm { (suffix, prefix) } else { (prefix, suffix) };
    format!("{}{a}{}{b}{}", t.pre, t.mid, t.end)
}

/// A request's headers: a Bearer key only when there is one.
fn headers(key: &str) -> Vec<(String, String)> {
    let mut h = vec![("Content-Type".into(), "application/json".into())];
    if !key.is_empty() {
        h.push(("Authorization".into(), format!("Bearer {key}")));
    }
    h
}

/// Keeps a local model from looping on the same lines (Ollama's options; LM Studio takes repeat_penalty): over the last
/// 128 tokens, about 8 lines (the hosted FIM APIs take no such field).
const REPEAT_PENALTY: f64 = 1.1;
const REPEAT_LAST_N: u64 = 128;

/// A short stable id of a file (FNV-1a), Codestral's prompt_cache_key: the same file reuses the provider's prompt cache.
pub fn cache_key(file: &str) -> String {
    format!("vsedit-{:08x}", file.bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x01000193)))
}

/// The HTTP request for a suggestion (stream: Ollama's NDJSON lines or the hosted APIs' SSE events, read by
/// post_stream); `key`: the provider's API key (optional for a local server: "" sends none).
pub fn request(cfg: &Config, ctx: &Context, stream: bool, key: &str) -> Request {
    // the desktop's proxy (key: its token) builds the provider's request itself
    if cfg.provider == "desktop" {
        let body = json!({ "prefix": ctx.prefix, "suffix": ctx.suffix, "nextLine": ctx.next_line, "file": ctx.file, "stream": stream });
        return Request { url: format!("{}/fim", cfg.endpoint), headers: headers(key), body };
    }
    if cfg.hosted {
        let mut body = json!({ "model": cfg.model, "prompt": ctx.prefix, "suffix": ctx.suffix, "max_tokens": cfg.max_tokens, "stream": stream });
        if !cfg.multiline && !ctx.next_line {
            body["stop"] = json!(["\n"]);
        }
        if cfg.provider == "codestral" && !ctx.file.is_empty() {
            body["prompt_cache_key"] = json!(cache_key(&ctx.file));
        }
        return Request { url: cfg.endpoint.clone(), headers: headers(key), body };
    }
    let t = template(&cfg.model);
    let mut stop: Vec<&str> = t.map_or(vec![], |t| t.stop.to_vec());
    if !cfg.multiline && !ctx.next_line {
        stop.push("\n");
    }
    // LM Studio's OpenAI-compatible /v1/completions applies no prompt template, so the FIM prompt goes as is; its docs
    // name no `suffix`, sent only for a model without a known template.
    if cfg.provider == "lmstudio" {
        let mut body = json!({ "model": cfg.model, "max_tokens": cfg.max_tokens, "temperature": 0.2, "repeat_penalty": REPEAT_PENALTY, "stream": stream });
        match t {
            Some(t) => body["prompt"] = json!(fim_prompt(t, &ctx.prefix, &ctx.suffix)),
            None => {
                body["prompt"] = json!(ctx.prefix);
                body["suffix"] = json!(ctx.suffix);
            }
        }
        if !stop.is_empty() {
            body["stop"] = json!(stop);
        }
        return Request { url: format!("{}/v1/completions", cfg.endpoint), headers: headers(key), body };
    }
    let mut options = json!({ "num_predict": cfg.max_tokens, "temperature": 0.2, "repeat_penalty": REPEAT_PENALTY, "repeat_last_n": REPEAT_LAST_N });
    if !stop.is_empty() {
        options["stop"] = json!(stop);
    }
    let mut body = json!({ "model": cfg.model, "stream": stream, "keep_alive": cfg.keep_alive, "options": options });
    match t {
        Some(t) => {
            body["prompt"] = json!(fim_prompt(t, &ctx.prefix, &ctx.suffix));
            body["raw"] = json!(true);
        }
        None => {
            body["prompt"] = json!(ctx.prefix);
            body["suffix"] = json!(ctx.suffix);
        }
    }
    Request { url: format!("{}/api/generate", cfg.endpoint), headers: headers(key), body }
}

/// Loads the model ahead of the first suggestion (Ollama keeps it keepAlive); None when the provider needs none.
pub fn warmup(cfg: &Config, key: &str) -> Option<Request> {
    (cfg.provider == "ollama").then(|| Request {
        url: format!("{}/api/generate", cfg.endpoint),
        headers: headers(key),
        body: json!({ "model": cfg.model, "prompt": "", "stream": false, "keep_alive": cfg.keep_alive, "options": { "num_predict": 1 } }),
    })
}

/// Asks Ollama about the model (/api/show), before the warm-up; None when the provider has nothing to ask.
pub fn show(cfg: &Config, key: &str) -> Option<Request> {
    (cfg.provider == "ollama").then(|| Request { url: format!("{}/api/show", cfg.endpoint), headers: headers(key), body: json!({ "model": cfg.model }) })
}

/// What Ollama said about the model: not pulled, or a chat template (.Messages).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelInfo {
    pub missing: bool,
    pub chat: bool,
}

/// show's reply -> the model's info, None when the server didn't say.
pub fn model_info(status: u16, json: &Value) -> Option<ModelInfo> {
    if status == 404 || json["error"].as_str().is_some_and(|e| e.to_lowercase().contains("not found")) {
        return Some(ModelInfo { missing: true, chat: false });
    }
    let template = json["template"].as_str().filter(|_| status < 400)?;
    Some(ModelInfo { missing: false, chat: template.contains(".Messages") })
}

/// Whether to recommend a base model: the template says chat, or (Ollama said nothing) the name has no "base". `info`:
/// None before the model was asked about.
pub fn chat_model(cfg: &Config, info: Option<&Option<ModelInfo>>) -> bool {
    match info {
        None => false,
        Some(Some(i)) => i.chat,
        Some(None) => !cfg.model.to_lowercase().contains("base"),
    }
}

/// Whether the provider is a local server (Ollama, LM Studio), and how to get a missing model there.
fn get_model(provider: &str, model: &str) -> Option<String> {
    match provider {
        "ollama" => Some(format!("run: ollama pull {model}")),
        "lmstudio" => Some(format!("download and load it in LM Studio, or run: lms get {model}")),
        _ => None,
    }
}

pub fn missing_text(cfg: &Config) -> String {
    let get = get_model(&cfg.provider, &cfg.model).unwrap_or_else(|| format!("run: ollama pull {}", cfg.model));
    format!("{}: model {} not found ({get})", cfg.label, cfg.model)
}

pub fn chat_hint(cfg: &Config) -> String {
    format!("{} is a chat model and often answers in prose; a base model completes code (ollama pull {OLLAMA_MODEL}, then set editor.inlineSuggest.model)", cfg.model)
}

/// The text of one reply or streamed event: Ollama's `response`, a completion's `choices[0].text`, a chat-shaped one's
/// `delta.content` / `message.content` (Mistral's FIM).
fn reply_text(j: &Value) -> Option<&str> {
    let c = &j["choices"][0];
    j["response"].as_str().or(c["text"].as_str()).or(c["delta"]["content"].as_str()).or(c["message"]["content"].as_str())
}

/// An error body's message: OpenAI's {error: {message}}, Ollama's {error}, Mistral's {message} / {detail}.
fn error_text(j: &Value) -> Option<String> {
    let e = if !j["error"]["message"].is_null() {
        &j["error"]["message"]
    } else if !j["error"].is_null() {
        &j["error"]
    } else if j["object"] == "error" || !j["detail"].is_null() {
        if j["message"].is_null() { &j["detail"] } else { &j["message"] }
    } else {
        return None;
    };
    Some(e.as_str().map_or_else(|| e.to_string(), String::from))
}

/// A reply (status, parsed JSON) -> the suggestion texts, or a message for the status bar.
pub fn reply(cfg: &Config, status: u16, json: &Value) -> Result<Vec<String>, String> {
    let err = error_text(json);
    if status >= 400 || err.is_some() {
        let lower = err.as_deref().unwrap_or("").to_lowercase();
        if get_model(&cfg.provider, "").is_some() && (lower.contains("not found") || lower.contains("invalid model")) {
            return Err(missing_text(cfg));
        }
        // a hosted API refused the key; a local server (behind a proxy, or protected) wants one or refused it
        if status == 401 || status == 403 {
            return Err(if cfg.hosted {
                format!("{}: the API key was refused (HTTP {status}); {}", cfg.label, key_help(&cfg.provider))
            } else {
                format!("{}: the server needs an API key or refused it (HTTP {status}); add one: {}", cfg.label, key_how(&cfg.provider))
            });
        }
        return Err(match err {
            Some(e) => format!("{}: {}", cfg.label, e.chars().take(160).collect::<String>()),
            None => format!("{}: HTTP {status}", cfg.label),
        });
    }
    Ok(vec![reply_text(json).unwrap_or("").to_string()])
}

// ---------- API keys: the macOS keychain, then <herdr home>/vscode-secrets.json (mode 600), then the environment ----------

fn secrets_file() -> PathBuf {
    std::env::var_os("VSEDIT_SECRETS").map(PathBuf::from).unwrap_or_else(|| crate::settings::herdr_home().join("vscode-secrets.json"))
}

fn security_bin() -> Option<PathBuf> {
    std::env::var_os("VSEDIT_SECURITY").map(PathBuf::from).or_else(|| cfg!(target_os = "macos").then(|| PathBuf::from("/usr/bin/security")))
}

/// How to give a provider its key, for the status bar.
pub fn key_help(provider: &str) -> String {
    format!("no API key: {}", key_how(provider))
}
fn key_how(provider: &str) -> String {
    format!(
        "security add-generic-password -U -s herdr-vscode-{provider} -a herdr -w <key> (or Settings › Inline Suggestions; elsewhere {} with {{\"{provider}\": \"<key>\"}}, chmod 600; or {})",
        secrets_file().display(),
        key_env(provider)
    )
}

/// The provider's key and where it came from ("keychain", "file", "env"); Err(the secrets file is readable by others)
/// when there is none. The file is read only when no one else may read it.
pub fn api_key(provider: &str) -> Result<(String, &'static str), bool> {
    if let Some(sec) = security_bin() {
        let service = format!("herdr-vscode-{provider}");
        if let Ok(out) = Command::new(sec).args(["find-generic-password", "-s", &service, "-w"]).stdin(Stdio::null()).stderr(Stdio::null()).output() {
            let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !key.is_empty() {
                return Ok((key, "keychain"));
            }
        }
    }
    let file = secrets_file();
    let mut loose = false;
    if let Ok(meta) = std::fs::metadata(&file) {
        use std::os::unix::fs::PermissionsExt;
        loose = meta.permissions().mode() & 0o077 != 0;
        let key = (!loose).then(|| std::fs::read_to_string(&file).ok()).flatten().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v[provider].as_str().map(|k| k.trim().to_string()));
        if let Some(key) = key.filter(|k| !k.is_empty()) {
            return Ok((key, "file"));
        }
    }
    match std::env::var(key_env(provider)).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(key) => Ok((key, "env")),
        None => Err(loose),
    }
}

/// A request in flight that a newer one (or an edit) cancels: the curl process is killed.
#[derive(Default)]
pub struct Cancel {
    pid: AtomicI32,
    cancelled: AtomicBool,
}

impl Cancel {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let pid = self.pid.load(Ordering::SeqCst);
        if pid > 0 {
            // SAFETY: kill(2) on the curl child this request started; a pid already reaped is harmless here.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// A string for curl's config file (double quoted; `\` and `"` escaped, line breaks as `\n`).
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t"))
}

/// Starts curl POSTing `req` (its config on stdin, so headers never show in `ps`); `stream`: its output unbuffered.
fn curl(req: &Request, cancel: &Cancel, stream: bool) -> Result<std::process::Child, Option<String>> {
    let mut config = format!("url = {}\nrequest = \"POST\"\nsilent\nshow-error\nmax-time = {TIMEOUT_S}\nwrite-out = \"\\n%{{http_code}}\"\n", quoted(&req.url));
    if stream {
        config += "no-buffer\n";
    }
    for (k, v) in &req.headers {
        config += &format!("header = {}\n", quoted(&format!("{k}: {v}")));
    }
    config += &format!("data-binary = {}\n", quoted(&req.body.to_string()));
    let path = std::env::join_paths(crate::term::search_path()).unwrap_or_default();
    let mut child = Command::new("curl").args(["--config", "-"]).env("PATH", path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| Some(format!("curl: {e}")))?;
    cancel.pid.store(child.id() as i32, Ordering::SeqCst);
    if cancel.cancelled() {
        let _ = child.kill();
    }
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(config.as_bytes());
    }
    Ok(child)
}

/// Waits for curl: Err(None) when cancelled, Err(Some(message)) when it failed.
fn finish(child: std::process::Child, cancel: &Cancel, stopped: bool) -> Result<std::process::Output, Option<String>> {
    let out = child.wait_with_output().map_err(|e| Some(format!("curl: {e}")))?;
    cancel.pid.store(0, Ordering::SeqCst);
    if cancel.cancelled() {
        return Err(None);
    }
    if !out.status.success() && !stopped {
        let err = String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("curl: ").to_string();
        return Err(Some(if out.status.code() == Some(7) { "connection refused".into() } else { err }));
    }
    Ok(out)
}

/// POSTs `req` with curl: Ok((status, JSON)), Err(None) when cancelled, Err(Some(message)) when it failed.
pub fn post(req: &Request, cancel: &Cancel) -> Result<(u16, Value), Option<String>> {
    let out = finish(curl(req, cancel, false)?, cancel, false)?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (body, code) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
    Ok((code.trim().parse().unwrap_or(0), serde_json::from_str(body).unwrap_or(Value::Null)))
}

/// POSTs a streaming request: reads Ollama's NDJSON lines, calling on_text(the text so far) after each; on_text
/// returning true stops reading (the block is complete) and kills curl. Ok((status, {"response": text} or
/// {"error": …})) like post.
pub fn post_stream(req: &Request, cancel: &Cancel, mut on_text: impl FnMut(&str) -> bool) -> Result<(u16, Value), Option<String>> {
    let mut child = curl(req, cancel, true)?;
    let (mut text, mut error, mut status, mut stopped) = (String::new(), None, 200, false);
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            let line = line.strip_prefix("data:").map_or(line.as_str(), str::trim_start);
            match serde_json::from_str::<Value>(line) {
                Ok(v) if error_text(&v).is_some() => error = Some(v),
                Ok(v) if reply_text(&v).is_some() => {
                    text += reply_text(&v).unwrap_or("");
                    if on_text(&text) {
                        stopped = true;
                        let _ = child.kill();
                        break;
                    }
                }
                _ => status = line.trim().parse().unwrap_or(status),
            }
        }
    }
    finish(child, cancel, stopped)?;
    Ok((status, error.unwrap_or_else(|| json!({ "response": text }))))
}

/// A failed request -> the status bar's words.
pub fn failure(cfg: &Config, e: &str) -> String {
    // the desktop's tunnel gone (its own errors come back as replies)
    if cfg.provider == "desktop" {
        return NO_DESKTOP.into();
    }
    if e == "connection refused" {
        return match cfg.provider.as_str() {
            "ollama" => format!("Ollama is not running at {} (start it: ollama serve)", cfg.endpoint),
            "lmstudio" => format!("LM Studio is not running at {} (start its server: the Developer tab, or lms server start)", cfg.endpoint),
            _ => format!("{}: nothing answers at {}", cfg.label, cfg.endpoint),
        };
    }
    format!("{}: {e}", cfg.label)
}

// ---------- usage: <herdr home>/.vscode-inline-usage.json, per local date and provider:model ----------

pub fn usage_file() -> PathBuf {
    std::env::var_os("VSEDIT_INLINE_USAGE").map(PathBuf::from).unwrap_or_else(|| crate::settings::herdr_home().join(".vscode-inline-usage.json"))
}

/// The local date, YYYY-MM-DD.
pub fn today() -> String {
    // SAFETY: time(2) and localtime_r(3) into a zeroed tm owned here.
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
    }
}

const KEEP_DAYS: usize = 14;
const KEEP_MS: usize = 200;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub requests: u64,
    pub in_chars: u64,
    pub out_chars: u64,
    pub ms: Vec<u64>,
}

fn read_usage(file: &Path) -> Map<String, Value> {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn usage_from(v: &Value) -> Usage {
    Usage {
        requests: v["requests"].as_u64().unwrap_or(0),
        in_chars: v["inChars"].as_u64().unwrap_or(0),
        out_chars: v["outChars"].as_u64().unwrap_or(0),
        ms: v["ms"].as_array().into_iter().flatten().filter_map(Value::as_u64).collect(),
    }
}

/// `day`'s usage for `key`.
pub fn usage_of(key: &str, file: &Path, day: &str) -> Usage {
    read_usage(file).get(day).map(|d| usage_from(&d[key])).unwrap_or_default()
}

/// Adds one request (a failed one has no ms); keeps the last KEEP_DAYS dates.
pub fn record_usage(key: &str, in_chars: usize, out_chars: usize, ms: Option<u64>, file: &Path, day: &str) -> Usage {
    let mut all = read_usage(file);
    let mut u = all.get(day).map(|d| usage_from(&d[key])).unwrap_or_default();
    u.requests += 1;
    u.in_chars += in_chars as u64;
    u.out_chars += out_chars as u64;
    if let Some(ms) = ms {
        u.ms.push(ms);
        let n = u.ms.len();
        u.ms.drain(..n.saturating_sub(KEEP_MS));
    }
    let entry = all.entry(day.to_string()).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    entry[key] = json!({ "requests": u.requests, "inChars": u.in_chars, "outChars": u.out_chars, "ms": u.ms });
    let mut days: Vec<String> = all.keys().cloned().collect();
    days.sort();
    for d in days.iter().take(days.len().saturating_sub(KEEP_DAYS)) {
        all.remove(d);
    }
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, Value::Object(all).to_string());
    u
}

pub fn percentile(xs: &[u64], p: f64) -> Option<u64> {
    let mut s = xs.to_vec();
    s.sort_unstable();
    (!s.is_empty()).then(|| s[((p / 100.0 * s.len() as f64).ceil() as usize).clamp(1, s.len()) - 1])
}

fn tokens(chars: u64) -> String {
    let t = (chars as f64 / 4.0).round() as u64;
    if t >= 1000 { format!("{:.1}k", t as f64 / 1000.0) } else { t.to_string() }
}

/// Today's approximate cost in USD (tokens: characters ÷ 4) at cfg.price; None for a free provider.
pub fn cost(cfg: &Config, u: &Usage) -> Option<f64> {
    cfg.price.map(|(i, o)| (u.in_chars as f64 / 4.0 * i + u.out_chars as f64 / 4.0 * o) / 1e6)
}

/// "Ollama qwen2.5-coder:7b · today 12 requests (limit 2000) · ~3.1k in / 40 out tokens · ~$0.0012 · p50 140 ms, p95 900 ms"
pub fn usage_text(cfg: &Config, u: &Usage) -> String {
    let mut s = format!("{} {} · today {} request{}", cfg.label, cfg.model, u.requests, if u.requests == 1 { "" } else { "s" });
    if cfg.limit > 0 {
        s += &format!(" (limit {})", cfg.limit);
    }
    s += &format!(" · ~{} in / {} out tokens", tokens(u.in_chars), tokens(u.out_chars));
    if let Some(usd) = cost(cfg, u) {
        s += &if usd < 0.1 { format!(" · ~${usd:.4}") } else { format!(" · ~${usd:.2}") };
    }
    if let (Some(a), Some(b)) = (percentile(&u.ms, 50.0), percentile(&u.ms, 95.0)) {
        s += &format!(" · p50 {a} ms, p95 {b} ms");
    }
    s
}

/// Tests that set the process's environment (usage file, keys) run one at a time.
#[cfg(test)]
pub fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// A fake `security` keeping its items in $FAKE_KEYCHAIN (its arguments logged to $FAKE_KEYCHAIN.argv): VSEDIT_SECURITY
/// for tests, so no test reads or writes the real keychain. The same script as inline.test.cjs's.
#[cfg(test)]
pub fn fake_security(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = r#"#!/bin/sh
echo "$*" >> "$FAKE_KEYCHAIN.argv"
case "$1" in
  find-generic-password) k=$(grep "^$3	" "$FAKE_KEYCHAIN" 2>/dev/null | tail -1 | cut -f2); [ -n "$k" ] && echo "$k" && exit 0; exit 44;;
  delete-generic-password) grep -v "^$3	" "$FAKE_KEYCHAIN" > "$FAKE_KEYCHAIN.tmp" 2>/dev/null; mv "$FAKE_KEYCHAIN.tmp" "$FAKE_KEYCHAIN"; exit 0;;
esac
exit 1
"#;
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join("security");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("VSEDIT_SECURITY", &path);
    std::env::set_var("FAKE_KEYCHAIN", dir.join("keychain"));
    std::env::set_var("VSEDIT_SECRETS", dir.join("secrets.json"));
    for env in PROVIDERS.iter().map(|p| key_env(p)).filter(|e| !e.is_empty()) {
        std::env::remove_var(env);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn secret_files_are_never_sent() {
        let cfg = config(&normalize(&json!({ "editor.inlineSuggest.exclude": ["*.tfvars"] })), |_| true);
        for f in ["/p/.env", "/p/.env.local", "/p/key.pem", "/h/.ssh/config", "/h/id_rsa", "/h/id_ed25519.pub", "/p/prod.tfvars", "/p/.npmrc"] {
            assert!(denied(Path::new(f), &cfg.exclude), "{f}");
        }
        for f in ["/p/main.ts", "/p/env.ts", "/p/README.md"] {
            assert!(!denied(Path::new(f), &cfg.exclude), "{f}");
        }
    }

    #[test]
    fn positions_and_context_follow_the_js_rules() {
        assert!(at_suggestable("foo(", 4) && at_suggestable("call(x);", 6));
        assert!(!at_suggestable("value", 2) && !at_suggestable("a + b", 2));
        let lines = strings(&["0123456789", "abcdefghij", "KLMNOPQRST"]);
        let c = context_at(&lines, 1, 5, 8, 7);
        assert_eq!((c.prefix.as_str(), c.suffix.as_str(), c.next_line), ("abcde", "fghij\nK", false));
        assert_eq!(context_at(&lines, 1, 5, 16, 0).prefix, "0123456789\nabcde");
        assert_eq!(context_at(&lines, 1, 5, 3, 0).prefix, "cde");
        assert!(context_at(&strings(&["  x = 1;", "}"]), 0, 8, 100, 100).next_line);
        assert!(!context_at(&strings(&["  x = ", "}"]), 0, 6, 100, 100).next_line);
    }

    #[test]
    fn ghost_text_rules() {
        assert_eq!(type_through(&strings(&["return a;", "rest"]), "re"), Some(strings(&["turn a;", "st"])));
        assert_eq!(type_through(&strings(&["return"]), "x"), None);
        assert_eq!(type_through(&strings(&["ab"]), "ab"), None);
        assert_eq!((next_word_len(" foo(bar)"), next_word_len("(bar)"), next_word_len("\n  next")), (4, 1, 3));
    }

    #[test]
    fn replies_are_cut_like_the_js() {
        let ctx = |p: &str, s: &str, next_line: bool| Context { prefix: p.into(), suffix: s.into(), next_line, ..Context::default() };
        let c = ctx("function add(a, b) {\n  ", "\n}\nconsole.log(add(1, 2));", false);
        assert_eq!(clean("return a + b;<|fim_suffix|>junk", &c, false), (Some("return a + b;".into()), Some("fim")));
        assert_eq!(clean("return a + b;\n}", &c, false), (Some("return a + b;".into()), None));
        assert_eq!(clean("return a + b;\n}\nconsole.log(add(1, 2));", &c, true), (Some("return a + b;".into()), None));
        assert_eq!(clean("}\nconsole.log(add(1, 2));", &c, true), (None, Some("echo")));
        assert_eq!(clean("   \n", &c, false), (None, Some("empty")));
        assert_eq!(clean("const total = 1;", &ctx("  const total = ", "", false), false), (Some(" 1;".into()), Some("echo")));
        assert_eq!(clean("a, b)", &ctx("f(", ")", false), false), (Some("a, b".into()), None));
        assert_eq!(clean("\n  return x;\n}", &ctx("  x();", "\n}", true), false), (Some("\n  return x;".into()), None));
    }

    #[test]
    fn a_provider_pauses_after_n_errors_or_4n_dropped_replies_and_at_once_on_fim_tokens() {
        let mut h = Health::new(3);
        let down = Some("Ollama is not running");
        h.record(None, down);
        h.record(None, down);
        assert_eq!(h.record(None, None), None, "a good reply resets the count");
        h.record(None, down);
        h.record(None, down);
        assert!(h.record(None, down).unwrap().contains("3 errors in a row"));
        let mut d = Health::new(3);
        for _ in 0..50 {
            assert_eq!(d.record(Some("empty"), None), None);
        }
        assert!(d.note.as_deref().unwrap().contains("empty"));
        for i in 0..11 {
            assert_eq!(d.record(Some(if i % 2 == 1 { "prose" } else { "fence" }), None), None);
        }
        assert_eq!(d.note.as_deref(), Some("the last reply was dropped: it was a Markdown code fence"));
        assert!(d.record(Some("prose"), None).unwrap().contains("12 replies in a row were dropped (the last: it was prose, not code); a base model does better"));
        assert!(Health::new(5).record(Some("fim"), None).unwrap().contains("FIM template tokens"));
    }

    fn cx(prefix: &str, suffix: &str) -> Context {
        Context { prefix: prefix.into(), suffix: suffix.into(), ..Context::default() }
    }

    #[test]
    fn fim_prompts_per_model_family_go_raw_with_their_stops() {
        let cfg = config(&normalize(&json!({})), |_| true);
        let body = |model: &str, multiline: bool| request(&Config { model: model.into(), multiline, ..cfg.clone() }, &cx("a(", ")"), true, "").body;
        let q = body("qwen2.5-coder:1.5b-base", true);
        assert_eq!((q["prompt"].as_str(), q["raw"].as_bool(), q["stream"].as_bool()), (Some("<|fim_prefix|>a(<|fim_suffix|>)<|fim_middle|>"), Some(true), Some(true)));
        assert!(body("qwen2.5-coder:7b", true)["options"]["stop"].as_array().unwrap().contains(&json!("<|endoftext|>")));
        assert_eq!(body("codestral:22b", true)["prompt"], json!("[SUFFIX])[PREFIX] a("));
        assert_eq!(body("deepseek-coder:6.7b-base", true)["prompt"], json!("<｜fim▁begin｜>a(<｜fim▁hole｜>)<｜fim▁end｜>"));
        assert_eq!(body("starcoder2:3b", true)["prompt"], json!("<fim_prefix>a(<fim_suffix>)<fim_middle>"));
        let l = body("llama3", true);
        assert_eq!((l["prompt"].as_str(), l["suffix"].as_str(), l["raw"].is_null(), l["options"]["stop"].is_null()), (Some("a("), Some(")"), true, true));
        assert_eq!(body("llama3", false)["options"]["stop"], json!(["\n"]));
        assert_eq!(body("qwen2.5-coder:7b", false)["options"]["stop"].as_array().unwrap().last(), Some(&json!("\n")));
    }

    #[test]
    fn prose_and_fences_are_dropped_or_stripped_except_in_prose_files_comments_and_strings() {
        let c = |raw: &str, prefix: &str| clean(raw, &cx(prefix, ""), true);
        let yml = "services:\n  app:\n\n";
        assert_eq!(c("This Docker Compose file defines two services: `selenium` and `app`. Here's a breakdown:", yml), (None, Some("prose")));
        assert_eq!(c("\nThis `docker-compose.yml` file defines two services: `selenium` and `app`.", yml), (None, Some("prose")));
        assert_eq!(c("Here's the updated file:\n```yaml\nfoo: 1\n```", yml), (None, Some("prose")));
        assert_eq!(c("```dockerfile", yml), (None, Some("fence")));
        assert_eq!(c(" ```yaml\n", yml), (None, Some("fence")));
        assert_eq!(c("```dockerfile\nCMD [\"python\", \"app.py\"]\n```\nThat runs it.", yml), (Some("CMD [\"python\", \"app.py\"]".into()), None));
        assert_eq!(c("Return the lines without breaks.", "    \"\"\""), (Some("Return the lines without breaks.".into()), None), "a docstring");
        assert_eq!(c("Starts the app and waits for it.", "  # "), (Some("Starts the app and waits for it.".into()), None), "a comment");
        assert_eq!(clean("Here's how it works.", &Context { prose: true, ..cx("# Notes\n", "") }, true), (Some("Here's how it works.".into()), None), "Markdown");
        assert_eq!(c("SELECT name FROM users WHERE id = 1;", ""), (Some("SELECT name FROM users WHERE id = 1;".into()), None));
        assert_eq!(c("RUN apt-get update && apt-get install -y curl", ""), (Some("RUN apt-get update && apt-get install -y curl".into()), None));
        assert_eq!(clean("}", &cx("  x();\n", "\n}\n"), true), (None, Some("echo")), "only the text after the cursor");
        assert!(prose_file(Path::new("/p/README.md")) && prose_file(Path::new("/p/notes.txt")) && !prose_file(Path::new("/p/compose.yml")));
    }

    #[test]
    fn a_block_ends_at_a_shallower_line_a_closed_bracket_two_blank_lines_or_the_text_after_the_cursor() {
        let cut = |text: &str, prefix: &str, suffix: &str| block_cut(text, &cx(prefix, suffix), true);
        let own = |t: &str| (t.to_string(), true);
        assert_eq!(cut("const s = xs.sort();\n  return s[0];\n}\n\nfunction g() {", "function f(xs) {\n  ", "\n}"), own("const s = xs.sort();\n  return s[0];"));
        assert_eq!(cut("if (a) {\n    go();\n  }\n  stop();", "  ", ""), own("if (a) {\n    go();\n  }"));
        assert_eq!(cut("let n = 0;\n  for (const x of xs) {\n    n += x;\n  }\n  return n;\n}", "  ", "\n}").0, "let n = 0;\n  for (const x of xs) {\n    n += x;\n  }\n  return n;");
        assert_eq!(cut("\n  return 1;\n}\nnext();", "function f() {", "\nmore();"), own("\n  return 1;"));
        assert_eq!(cut("\n  return 1;\n}\nnext();", "function f() {", ""), own("\n  return 1;\n}"));
        assert_eq!(cut("    with open(p) as f:\n        return f.read()\n\ndef main():", "def read(p):\n", "").0, "    with open(p) as f:\n        return f.read()");
        assert_eq!(cut("  db:\n    image: postgres\n  cache:\n    image: redis\nvolumes:\n  data:", "services:\n  app:\n    build: .\n", "").0, "  db:\n    image: postgres\n  cache:\n    image: redis");
        assert_eq!(cut("a = 1\n\n\nb = 2", "", ""), own("a = 1"));
        assert_eq!(cut("xs.reduce((a, b) => a + b, 0);\n  return sum / xs.length;", "  const sum = ", "\n  return sum / xs.length;\n}"), own("xs.reduce((a, b) => a + b, 0);"));
        assert_eq!(block_cut("if (a) {\n    go();\n  }", &cx("  ", ""), false), ("if (a) {\n    go();".to_string(), false), "while streaming only complete lines count");
        assert_eq!(clean("if (a) {\n    go();\n  }\n  stop();", &cx("  ", ""), true), (Some("if (a) {\n    go();\n  }".into()), None));
    }

    #[test]
    fn quiet_ends_accept_next_line_and_the_model_probe() {
        assert!(quiet_end(&strings(&["a: 1", "", ""]), 2));
        assert!(!quiet_end(&strings(&["a: 1", ""]), 1));
        assert!(!quiet_end(&strings(&["a: 1", "", "", "b: 2"]), 2));
        assert_eq!((next_line_len("abc\n  d"), next_line_len("\n  d\n  e"), next_line_len("abc")), (3, 4, 3));
        let cfg = config(&normalize(&json!({})), |_| true);
        assert_eq!(model_info(404, &json!({ "error": "model 'x' not found" })), Some(ModelInfo { missing: true, chat: false }));
        assert_eq!(model_info(200, &json!({ "template": "{{- if .Suffix }}<|fim_prefix|>…{{ else }}{{ .Prompt }}{{ end }}" })), Some(ModelInfo { missing: false, chat: false }));
        assert_eq!(model_info(200, &json!({ "template": "{{- range $i, $_ := .Messages }}…" })), Some(ModelInfo { missing: false, chat: true }));
        assert_eq!(model_info(500, &Value::Null), None);
        let instruct = Config { model: "qwen2.5-coder:7b".into(), ..cfg.clone() };
        assert!(!chat_model(&instruct, None), "not asked yet");
        assert!(chat_model(&instruct, Some(&None)), "unknown: by its name");
        assert!(!chat_model(&cfg, Some(&None)));
        assert_eq!(show(&cfg, "").unwrap().url, "http://127.0.0.1:11434/api/show");
    }

    #[test]
    fn a_looping_reply_stops_before_its_first_repeated_block_and_similar_lines_stay() {
        // the reported case: a Gitea env block, then two lines alternating until max tokens
        let pair = "      GITEA__auth__LOGIN_URL: \"/login\"\n      GITEA__auth__LOGIN_REDIRECT_URL: \"/user/profile\"";
        let head = "\n      GITEA__server__SSH_PORT: \"2222\"\n      GITEA__server__DOMAIN_SANITIZED: \"true\"\n\n      # ===== 로그인 =====\n";
        let raw = format!("{head}{}\n      GITEA__auth", vec![pair; 8].join("\n"));
        let want = format!("{head}{pair}");
        assert_eq!(cut_repeats(&raw, "\n    volumes:"), want);
        let prefix = "services:\n  gitea:\n    environment:\n      GITEA__server__HTTP_PORT: \"3000\"";
        assert_eq!(clean(&raw, &cx(prefix, "\n    volumes:"), true), (Some(want), None));
        // one line again, a 3-line block again (trailing spaces ignored); the first copy stays
        assert_eq!(cut_repeats("a()\nb()\nb()\nb()", ""), "a()\nb()");
        assert_eq!(cut_repeats("x: 1\ny: 2\n\nz: 3\nx: 1\ny: 2  \n\nz: 3\nx: 1", ""), "x: 1\ny: 2\n\nz: 3");
        // similar but different lines, a block that comes back later, and blank lines alone stay
        for t in ["a: 1\nb: 2\nc: 3", "x = 1\ny = 2\nx = 1", "a\n\n\nb", "if a:\n    go()\nif b:\n    go()"] {
            assert_eq!(cut_repeats(t, ""), t);
        }
        // a last line the document already has next goes, the only line stays (the echo check owns it)
        assert_eq!(cut_repeats("  a: 1\n  b: 2\n", "\n\n  b: 2\nc: 3"), "  a: 1");
        assert_eq!(cut_repeats("b: 2", "\nb: 2"), "b: 2");
        assert_eq!(cut_repeats("if (a) {\n    go();\n  }", "\n}"), "if (a) {\n    go();\n  }", "an inner brace, not the outer one");
    }

    #[test]
    fn defaults_are_ollama_qwen_base_on_localhost_in_blocks_without_a_daily_limit() {
        let cfg = config(&normalize(&json!({})), |_| true);
        assert_eq!((cfg.provider.as_str(), cfg.model.as_str(), cfg.endpoint.as_str(), cfg.enabled, cfg.limit, cfg.max_tokens, cfg.debounce, cfg.manual, cfg.multiline), ("ollama", "qwen2.5-coder:1.5b-base", "http://127.0.0.1:11434", true, 0, 256, 250, false, true));
        assert_eq!((cfg.prefix_chars, cfg.suffix_chars), (4000, 300));
        assert!(!config(&normalize(&json!({})), |_| false).enabled);
        assert!(config(&normalize(&json!({ "editor.inlineSuggest.enabled": true })), |_| false).enabled);
        assert!(!config(&normalize(&json!({ "editor.inlineSuggest.provider": "off" })), |_| true).enabled);
        let r = request(&cfg, &cx("p", "s"), false, "");
        assert_eq!((r.body["prompt"].clone(), r.body["raw"].clone(), r.body["stream"].clone(), r.body["keep_alive"].clone(), r.body["options"]["num_predict"].clone()), (json!("<|fim_prefix|>p<|fim_suffix|>s<|fim_middle|>"), json!(true), json!(false), json!("30m"), json!(256)));
        assert!(!r.body["options"]["stop"].as_array().unwrap().contains(&json!("\n")));
        let one = Config { multiline: false, ..cfg.clone() };
        assert!(!request(&one, &Context { next_line: true, ..cx("", "") }, false, "").body["options"]["stop"].as_array().unwrap().contains(&json!("\n")));
        assert_eq!(warmup(&cfg, "").unwrap().body["options"]["num_predict"], json!(1));
        assert_eq!((&r.body["options"]["repeat_penalty"], &r.body["options"]["repeat_last_n"]), (&json!(1.1), &json!(128)), "a looping model is held back");
    }

    #[test]
    fn usage_is_kept_per_day_and_provider() {
        let file = std::env::temp_dir().join(format!("vsedit-inline-usage-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&file);
        record_usage("ollama:m", 400, 40, Some(100), &file, "2026-01-01");
        let u = record_usage("ollama:m", 400, 0, None, &file, "2026-01-01");
        assert_eq!(usage_of("ollama:m", &file, "2026-01-01"), u);
        assert_eq!((u.requests, u.in_chars, u.out_chars, u.ms.clone()), (2, 800, 40, vec![100]));
        assert_eq!(usage_of("ollama:m", &file, "2026-01-02").requests, 0);
        assert_eq!((percentile(&[5, 1, 3, 2, 4], 50.0), percentile(&[1, 2, 3, 4, 100], 95.0)), (Some(3), Some(100)));
        let cfg = Config { label: "Ollama", model: "m".into(), limit: 0, ..config(&InlineSettings::default(), |_| true) };
        assert!(usage_text(&cfg, &u).contains("today 2 requests · ~200 in / 10 out tokens · p50 100 ms, p95 100 ms"));
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn post_reaches_a_local_server_and_cancel_kills_curl() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let got = std::thread::spawn(move || {
            let (mut s, _) = server.accept().unwrap();
            let mut buf = vec![0; 65536];
            let mut req = String::new();
            while !req.contains("\r\n\r\n") || !req.ends_with('}') {
                let n = s.read(&mut buf).unwrap();
                req += &String::from_utf8_lossy(&buf[..n]);
            }
            let body = r#"{"response":" a + b;","done":true}"#;
            write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            req
        });
        let cfg = config(&normalize(&json!({ "editor.inlineSuggest.endpoint": format!("http://127.0.0.1:{port}") })), |_| true);
        let (status, v) = post(&request(&cfg, &cx("say \"hi\"\\n\n", "\t}"), false, ""), &Cancel::default()).unwrap();
        assert_eq!((status, reply(&cfg, status, &v).unwrap()), (200, vec![" a + b;".to_string()]));
        let req = got.join().unwrap();
        let body: Value = serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["prompt"].as_str(), Some("<|fim_prefix|>say \"hi\"\\n\n<|fim_suffix|>\t}<|fim_middle|>"));
        // a server that never answers: cancel kills curl
        let silent = TcpListener::bind("127.0.0.1:0").unwrap();
        let cfg = config(&normalize(&json!({ "editor.inlineSuggest.endpoint": format!("http://127.0.0.1:{}", silent.local_addr().unwrap().port()) })), |_| true);
        let cancel = std::sync::Arc::new(Cancel::default());
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            c2.cancel();
        });
        let t0 = std::time::Instant::now();
        assert_eq!(post_stream(&request(&cfg, &cx("", ""), true, ""), &cancel, |_| false).err(), Some(None));
        assert!(t0.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn hosted_providers_share_one_fim_request_with_a_bearer_key() {
        let cfg_of = |p: &str, extra: Value| {
            let mut raw = json!({ "editor.inlineSuggest.provider": p });
            raw.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            config(&normalize(&raw), |_| true)
        };
        for (p, url, model) in [
            ("codestral", "https://api.mistral.ai/v1/fim/completions", "codestral-latest"),
            ("mercury", "https://api.inceptionlabs.ai/v1/fim/completions", "mercury-edit-2"),
        ] {
            let cfg = cfg_of(p, json!({}));
            let r = request(&cfg, &Context { file: "/p/x.ts".into(), ..cx("a(", ")") }, true, "sk-test");
            assert_eq!((r.url.as_str(), &r.body["model"], &r.body["prompt"], &r.body["suffix"], &r.body["max_tokens"], &r.body["stream"]), (url, &json!(model), &json!("a("), &json!(")"), &json!(256), &json!(true)), "{p}");
            assert!(r.body["stop"].is_null() && r.headers.contains(&("Authorization".into(), "Bearer sk-test".into())), "{p}");
            assert_eq!(r.body["prompt_cache_key"].is_string(), p == "codestral", "{p}");
            assert!(r.body.get("repeat_penalty").is_none(), "no field a hosted FIM API may refuse: {p}");
            assert_eq!((cfg.limit, cfg.hosted), (2000, true), "{p}");
        }
        assert_eq!(request(&cfg_of("mercury", json!({ "editor.inlineSuggest.multiline": false })), &cx("", ""), false, "k").body["stop"], json!(["\n"]));
        let retired = cfg_of("deepseek", json!({}));
        assert_eq!((retired.provider.as_str(), retired.enabled, PROVIDERS.contains(&"deepseek")), ("off", false, false), "DeepSeek, no longer offered, is off");
        assert_eq!(cache_key("/p/x.ts"), "vsedit-".to_string() + &format!("{:08x}", "/p/x.ts".bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x01000193))));
        assert_eq!(cache_key("/a/b.ts"), "vsedit-cf0c965f", "the JS editor's key for the same file");
        assert_eq!(cfg_of("codestral", json!({ "editor.inlineSuggest.dailyRequestLimit": 0 })).limit, 0);
        assert_eq!(cfg_of("ollama", json!({})).limit, 0);
        let cfg = cfg_of("codestral", json!({}));
        assert_eq!(reply(&cfg, 200, &json!({ "choices": [{ "message": { "content": "x" } }] })), Ok(vec!["x".to_string()]));
        assert_eq!(reply(&cfg, 200, &json!({ "choices": [{ "text": "y" }] })), Ok(vec!["y".to_string()]));
        assert!(reply(&cfg, 401, &json!({ "message": "Unauthorized" })).unwrap_err().starts_with("Codestral: the API key was refused (HTTP 401); no API key: security add-generic-password -U -s herdr-vscode-codestral"));
        assert_eq!(reply(&cfg, 429, &json!({ "error": { "message": "Rate limit" } })), Err("Codestral: Rate limit".into()));
        assert_eq!(reply(&cfg, 422, &json!({ "object": "error", "message": "bad suffix" })), Err("Codestral: bad suffix".into()));
        let u = Usage { requests: 2, in_chars: 4_000_000, out_chars: 400_000, ms: vec![] };
        assert!(usage_text(&cfg, &u).ends_with("today 2 requests (limit 2000) · ~1000.0k in / 100.0k out tokens · ~$0.39"), "{}", usage_text(&cfg, &u));
        assert!(usage_text(&cfg_of("codestral", json!({ "editor.inlineSuggest.price": { "input": 1, "output": 10 } })), &u).ends_with("~$2.00"));
        assert_eq!(cost(&cfg_of("ollama", json!({})), &u), None);
    }

    #[test]
    fn api_keys_come_from_the_keychain_then_a_600_file_then_the_environment() {
        use std::os::unix::fs::PermissionsExt;
        let _env = test_env_lock();
        let dir = std::env::temp_dir().join(format!("vsedit-keys-{}", std::process::id()));
        fake_security(&dir);
        let file = dir.join("secrets.json");
        assert_eq!(api_key("codestral"), Err(false));
        std::env::set_var("MISTRAL_API_KEY", "env-key");
        assert_eq!(api_key("codestral"), Ok(("env-key".into(), "env")));
        std::fs::write(&file, r#"{"codestral": "file-key"}"#).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(api_key("codestral"), Ok(("env-key".into(), "env")), "a file others can read is ignored");
        std::env::remove_var("MISTRAL_API_KEY");
        assert_eq!(api_key("codestral"), Err(true));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(api_key("codestral"), Ok(("file-key".into(), "file")));
        std::fs::write(dir.join("keychain"), "herdr-vscode-codestral\tkc-key\n").unwrap();
        assert_eq!(api_key("codestral"), Ok(("kc-key".into(), "keychain")));
        assert!(key_help("mercury").contains("security add-generic-password -U -s herdr-vscode-mercury -a herdr -w <key>") && key_help("mercury").contains("INCEPTION_API_KEY"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn each_provider_keeps_its_own_server_address_and_model() {
        let raw = json!({
            "editor.inlineSuggest.ollama.endpoint": "http://192.168.1.20:11434/", "editor.inlineSuggest.ollama.model": "starcoder2:3b",
            "editor.inlineSuggest.lmstudio.endpoint": "http://127.0.0.1:4321/v1", "editor.inlineSuggest.lmstudio.model": "qwen2.5-coder-7b",
        });
        let of = |p: &str, extra: Value| {
            let mut r = raw.clone();
            r["editor.inlineSuggest.provider"] = json!(p);
            r.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            config(&normalize(&r), |_| true)
        };
        let ollama = of("ollama", json!({}));
        assert_eq!((ollama.endpoint.as_str(), ollama.model.as_str(), ollama.custom_endpoint), ("http://192.168.1.20:11434", "starcoder2:3b", true));
        let lm = of("lmstudio", json!({}));
        assert_eq!((lm.endpoint.as_str(), lm.model.as_str(), lm.label), ("http://127.0.0.1:4321", "qwen2.5-coder-7b", "LM Studio"), "LM Studio's /v1 is the requests' own");
        assert_eq!(of("lmstudio", json!({ "editor.inlineSuggest.lmstudio.model": " " })).model, LMSTUDIO_MODEL);
        let codestral = of("codestral", json!({}));
        assert_eq!((codestral.endpoint.as_str(), codestral.model.as_str()), ("https://api.mistral.ai/v1/fim/completions", "codestral-latest"), "nothing crosses to another provider");
        assert_eq!(of("ollama", json!({ "editor.inlineSuggest.model": "shared" })).model, "starcoder2:3b", "the provider's own model wins");
        assert_eq!(of("codestral", json!({ "editor.inlineSuggest.model": "codestral-2508" })).model, "codestral-2508", "the shared one where a provider has none");
        assert_eq!(config(&normalize(&json!({ "editor.inlineSuggest.provider": "lmstudio" })), |_| true).endpoint, "http://127.0.0.1:1234");
    }

    #[test]
    fn lm_studio_request_is_a_raw_fim_completion_and_its_errors_say_what_to_do() {
        let cfg = config(&normalize(&json!({ "editor.inlineSuggest.provider": "lmstudio", "editor.inlineSuggest.multiline": false })), |_| true);
        let r = request(&cfg, &cx("a = ", "\nb"), true, "");
        assert_eq!(r.url, "http://127.0.0.1:1234/v1/completions");
        assert_eq!(r.headers, vec![("Content-Type".to_string(), "application/json".to_string())]);
        assert_eq!(r.body["prompt"], "<|fim_prefix|>a = <|fim_suffix|>\nb<|fim_middle|>");
        assert_eq!((&r.body["model"], &r.body["max_tokens"], &r.body["stream"]), (&json!(LMSTUDIO_MODEL), &json!(256), &json!(true)));
        assert!(r.body.get("suffix").is_none() && r.body["stop"].as_array().unwrap().last() == Some(&json!("\n")));
        assert_eq!(r.body["repeat_penalty"], json!(1.1));
        let plain = request(&Config { model: "llama-3.2-1b".into(), ..cfg.clone() }, &cx("a = ", "\nb"), false, "");
        assert_eq!((&plain.body["prompt"], &plain.body["suffix"], &plain.body["stop"]), (&json!("a = "), &json!("\nb"), &json!(["\n"])));
        assert_eq!(failure(&cfg, "connection refused"), "LM Studio is not running at http://127.0.0.1:1234 (start its server: the Developer tab, or lms server start)");
        assert_eq!(
            reply(&cfg, 404, &json!({ "error": { "message": "Model 'x' not found" } })),
            Err("LM Studio: model qwen2.5-coder-1.5b not found (download and load it in LM Studio, or run: lms get qwen2.5-coder-1.5b)".into())
        );
        assert!(warmup(&cfg, "").is_none() && show(&cfg, "").is_none());
    }

    /// A protected local server for `n` requests: 401 unless `Bearer <need>`; returns each request's Authorization header.
    fn guarded_server(need: &'static str, n: usize) -> (String, std::thread::JoinHandle<Vec<Option<String>>>) {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://127.0.0.1:{}", server.local_addr().unwrap().port());
        let seen = std::thread::spawn(move || {
            (0..n)
                .map(|_| {
                    let (mut s, _) = server.accept().unwrap();
                    let (mut buf, mut req) = (vec![0; 65536], String::new());
                    while !req.contains("\r\n\r\n") || !req.ends_with('}') {
                        let n = s.read(&mut buf).unwrap();
                        req += &String::from_utf8_lossy(&buf[..n]);
                    }
                    let auth = req.lines().find_map(|l| l.strip_prefix("Authorization: ").map(String::from));
                    let (status, body) = if auth.as_deref() == Some(&format!("Bearer {need}")) { ("200 OK", r#"{"response":" 1","done":true}"#) } else { ("401 Unauthorized", r#"{"error":"Unauthorized"}"#) };
                    write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
                    auth
                })
                .collect()
        });
        (endpoint, seen)
    }

    #[test]
    fn a_local_server_gets_its_own_bearer_key_only_when_one_is_stored_and_a_401_says_it_needs_one() {
        let _env = test_env_lock();
        let dir = std::env::temp_dir().join(format!("vsedit-local-keys-{}", std::process::id()));
        fake_security(&dir);
        for p in ["ollama", "lmstudio"] {
            let cfg = config(&normalize(&json!({ "editor.inlineSuggest.provider": p })), |_| true);
            assert_eq!(request(&cfg, &cx("a = ", ""), true, "").headers, vec![("Content-Type".to_string(), "application/json".to_string())], "{p}: no key, no header");
            assert!(request(&cfg, &cx("a = ", ""), true, "fake-key").headers.contains(&("Authorization".into(), "Bearer fake-key".into())), "{p}");
            let e = reply(&cfg, 403, &json!({})).unwrap_err();
            assert!(e.starts_with(&format!("{}: the server needs an API key or refused it (HTTP 403); add one: security add-generic-password -U -s herdr-vscode-{p} ", cfg.label)), "{e}");
        }
        let ollama = config(&normalize(&json!({})), |_| true);
        assert!(show(&ollama, "fake-key").unwrap().headers.contains(&("Authorization".into(), "Bearer fake-key".into())));
        assert!(warmup(&ollama, "fake-key").unwrap().headers.contains(&("Authorization".into(), "Bearer fake-key".into())));
        assert!(key_help("ollama").ends_with("or HERDR_OLLAMA_API_KEY)") && key_help("lmstudio").ends_with("or HERDR_LMSTUDIO_API_KEY)"));
        // each provider's own key: LM Studio's keychain item is not Ollama's, nor Ollama's variable LM Studio's
        std::fs::write(dir.join("keychain"), "herdr-vscode-lmstudio\tlm-fake\n").unwrap();
        assert_eq!(api_key("ollama"), Err(false));
        std::env::set_var("OLLAMA_API_KEY", "cloud-fake"); // Ollama's own ollama.com key never goes to a server here
        assert_eq!(api_key("ollama"), Err(false));
        std::env::remove_var("OLLAMA_API_KEY");
        std::env::set_var("HERDR_OLLAMA_API_KEY", "ol-fake");
        assert_eq!((api_key("ollama"), api_key("lmstudio")), (Ok(("ol-fake".into(), "env")), Ok(("lm-fake".into(), "keychain"))));
        std::env::remove_var("HERDR_OLLAMA_API_KEY");
        // through curl: no key sends no header and the 401 says why; the stored key passes
        let (endpoint, seen) = guarded_server("lm-fake", 2);
        let cfg = config(&normalize(&json!({ "editor.inlineSuggest.provider": "lmstudio", "editor.inlineSuggest.lmstudio.endpoint": endpoint })), |_| true);
        let (status, v) = post(&request(&cfg, &cx("a = ", ""), false, ""), &Cancel::default()).unwrap();
        assert!(reply(&cfg, status, &v).unwrap_err().starts_with("LM Studio: the server needs an API key or refused it (HTTP 401)"));
        let (status, v) = post(&request(&cfg, &cx("a = ", ""), false, &api_key("lmstudio").unwrap().0), &Cancel::default()).unwrap();
        assert_eq!(reply(&cfg, status, &v), Ok(vec![" 1".to_string()]));
        assert_eq!(seen.join().unwrap(), vec![None, Some("Bearer lm-fake".to_string())]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_active_desktops_announcement_is_its_tunnel_anything_else_is_no_desktop() {
        let token = "ab".repeat(24);
        let dir = std::env::temp_dir().join(format!("vsedit-desktops-{}", std::process::id()));
        let at = |active: Option<&str>, announced: Value| {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(a) = active {
                std::fs::write(dir.join("active"), format!("{a}\n")).unwrap();
            }
            std::fs::write(dir.join("d1.json"), announced.to_string()).unwrap();
            desktop(&dir)
        };
        assert_eq!(at(Some("d1"), json!({ "port": 4100, "token": token })), Some((4100, token.clone())));
        assert_eq!(at(None, json!({ "port": 4100, "token": token })), None, "no desktop marked active");
        assert_eq!(at(Some("d2"), json!({ "port": 4100, "token": token })), None, "the active desktop's tunnel is gone");
        assert_eq!(at(Some("../d1"), json!({ "port": 4100, "token": token })), None);
        assert_eq!(at(Some("d1"), json!({ "port": 70000, "token": token })), None);
        assert_eq!(at(Some("d1"), json!({ "port": 4100, "token": "short" })), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_remote_editor_asks_the_desktops_proxy_never_its_own_provider_address() {
        let codestral = normalize(&json!({ "editor.inlineSuggest.provider": "codestral" }));
        let cfg = via_desktop(config(&codestral, |_| false), codestral.enabled);
        assert_eq!((cfg.provider.as_str(), cfg.hosted, cfg.limit, cfg.enabled), ("desktop", false, 0, true));
        let ctx = Context { prefix: "a".into(), suffix: "b".into(), next_line: true, file: "/x.js".into(), ..Context::default() };
        let req = request(&Config { endpoint: "http://127.0.0.1:4100".into(), ..cfg.clone() }, &ctx, true, "tok");
        assert_eq!(req.url, "http://127.0.0.1:4100/fim");
        assert!(req.headers.contains(&("Authorization".into(), "Bearer tok".into())));
        assert_eq!(req.body, json!({ "prefix": "a", "suffix": "b", "nextLine": true, "file": "/x.js", "stream": true }));
        assert_eq!(failure(&cfg, "connection refused"), NO_DESKTOP, "the tunnel gone");
        let off = normalize(&json!({ "editor.inlineSuggest.provider": "off" }));
        assert!(!via_desktop(config(&off, |_| true), off.enabled).enabled);
        let turned_off = normalize(&json!({ "editor.inlineSuggest.enabled": false }));
        assert!(!via_desktop(config(&turned_off, |_| true), turned_off.enabled).enabled);
    }
}
