//! AI inline suggestions (inline.cjs): the settings, which files and positions get one, the request context, the ghost
//! text's rules (typing through it, accept next word), each provider's request and reply (POSTed with `curl`, killed
//! when a newer request or an edit makes it stale), the reply checks that pause a misbehaving provider, and the daily
//! usage file (requests, approximate tokens, latency). The editor (editor/inline_ui.rs) owns timers, keys and drawing.

use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

pub const PROVIDERS: &[&str] = &["ollama", "off"];
/// No suggestions in bigger files (characters).
pub const MAX_FILE_CHARS: usize = 1_000_000;
const PAID_DEFAULT_LIMIT: u64 = 2000;
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
    /// None: 2000 for paid providers, unlimited for local ones; Some(0): unlimited
    pub daily_limit: Option<u64>,
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
            multiline: false,
            debounce: 250,
            max_tokens: 64,
            prefix_chars: 4000,
            suffix_chars: 1000,
            stop_after: 5,
            daily_limit: None,
            keep_alive: "30m".into(),
            exclude: vec![],
        }
    }
}

/// A raw settings object -> the inline settings with valid values (invalid ones are the default).
pub fn normalize(raw: &Value) -> InlineSettings {
    let get = |k: &str| &raw[format!("editor.inlineSuggest.{k}")];
    let mut v = InlineSettings { enabled: get("enabled").as_bool(), ..InlineSettings::default() };
    if let Some(p) = get("provider").as_str().filter(|p| PROVIDERS.contains(p)) {
        v.provider = p.into();
    }
    let text = |k: &str| get(k).as_str().map(|s| s.trim().to_string());
    v.model = text("model").unwrap_or_default();
    v.endpoint = text("endpoint").unwrap_or_default();
    if let Some(k) = text("keepAlive").filter(|k| !k.is_empty()) {
        v.keep_alive = k;
    }
    v.manual = get("trigger").as_str() == Some("manual");
    v.multiline = get("multiline").as_bool().unwrap_or(false);
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
    v.daily_limit = num("dailyRequestLimit", 0.0, 1e7).map(|n| n as u64);
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
    pub paid: bool,
    /// requests a day, 0: unlimited
    pub limit: u64,
    /// provider:model, the usage file's and the pauses' key
    pub key: String,
    pub enabled: bool,
}

pub fn is_local(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?']).next().unwrap_or("");
    let host = if host.starts_with('[') { host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { host.split(':').next().unwrap_or("").to_string() };
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

/// Settings -> the config; `usable` says whether the provider can run here (the default of `enabled`).
pub fn config(s: &InlineSettings, usable: impl Fn(&Config) -> bool) -> Config {
    let p = s.provider.as_str();
    let (label, model, endpoint) = match p {
        "ollama" => ("Ollama", "qwen2.5-coder:7b", "http://127.0.0.1:11434"),
        _ => ("Inline Suggestions", "", ""),
    };
    let model = if s.model.is_empty() { model.to_string() } else { s.model.clone() };
    let endpoint = if s.endpoint.is_empty() { endpoint } else { &s.endpoint }.trim_end_matches('/').to_string();
    let paid = p != "off" && p != "ollama" && !is_local(&endpoint);
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
        paid,
        limit: s.daily_limit.unwrap_or(if paid { PAID_DEFAULT_LIMIT } else { 0 }),
        enabled: false,
    };
    cfg.enabled = p != "off" && s.enabled.unwrap_or_else(|| usable(&cfg));
    cfg
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

/// The text around the cursor (`col` a byte offset) within the character caps. The prefix starts at a line start (only
/// the cursor line itself is ever cut), so typing on doesn't shift its start and Ollama's prompt cache keeps it.
pub struct Context {
    pub prefix: String,
    pub suffix: String,
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
    Context { prefix, suffix: suffix.chars().take(suffix_chars).collect(), next_line }
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

/// A provider's raw text -> (text, anomaly): None when nothing is left; anomaly "fim" (template tokens: pause now),
/// "echo" (the text before or after the cursor repeated) or "empty". Cuts what follows a FIM token, a repeat of the
/// text after the cursor, and (one-line mode) the first line break — after the next line's text when `next_line`.
pub fn clean(raw: &str, ctx: &Context, multiline: bool) -> (Option<String>, Option<&'static str>) {
    let (prefix, suffix) = (ctx.prefix.as_str(), ctx.suffix.as_str());
    let mut text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut anomaly = None;
    if let Some(i) = FIM_TOKENS.iter().filter_map(|t| text.find(t)).min() {
        text.truncate(i);
        anomaly = Some("fim");
    }
    if !multiline {
        let next = ctx.next_line && text.starts_with('\n');
        let rest = text.trim_start_matches('\n');
        text = if next { format!("\n{}", rest.split('\n').next().unwrap_or("")) } else { text.split('\n').next().unwrap_or("").to_string() };
    }
    let tail = prefix.rsplit('\n').next().unwrap_or("").trim();
    if tail.chars().count() >= 4 && text.trim_start().starts_with(tail) {
        text = text.trim_start()[tail.len()..].to_string();
        anomaly = anomaly.or(Some("echo"));
    }
    // the text after the cursor written again: a run of its first lines (4 characters at least) from a line of the reply
    let after: Vec<&str> = suffix.split('\n').map(str::trim).filter(|l| !l.is_empty()).take(3).collect();
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
    let text = trim_line_suffix(text.trim_end(), suffix.split('\n').next().unwrap_or(""));
    if text.trim().is_empty() {
        return (None, Some(anomaly.unwrap_or("empty")));
    }
    (Some(text), anomaly)
}

/// Pauses a provider that keeps misbehaving: FIM tokens at once, `limit` empty/repeated replies or errors in a row.
pub struct Health {
    limit: u32,
    bad: u32,
    pub paused: Option<String>,
}

impl Health {
    pub fn new(limit: u32) -> Health {
        Health { limit, bad: 0, paused: None }
    }
    pub fn record(&mut self, anomaly: Option<&str>, error: Option<&str>) -> Option<String> {
        if anomaly == Some("fim") {
            self.paused = Some("the reply had FIM template tokens (wrong model or template?)".into());
            return self.paused.clone();
        }
        if anomaly.is_none() && error.is_none() {
            self.bad = 0;
            return None;
        }
        self.bad += 1;
        if self.bad >= self.limit {
            self.paused = Some(match error {
                Some(e) => format!("{} errors in a row: {e}", self.bad),
                None => format!("{} empty or repeated replies in a row", self.bad),
            });
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

/// The HTTP request for a suggestion.
pub fn request(cfg: &Config, ctx: &Context) -> Request {
    let mut options = json!({ "num_predict": cfg.max_tokens, "temperature": 0.2 });
    if !cfg.multiline && !ctx.next_line {
        options["stop"] = json!(["\n"]);
    }
    Request {
        url: format!("{}/api/generate", cfg.endpoint),
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: json!({ "model": cfg.model, "prompt": ctx.prefix, "suffix": ctx.suffix, "stream": false, "keep_alive": cfg.keep_alive, "options": options }),
    }
}

/// Loads the model ahead of the first suggestion (Ollama keeps it keepAlive); None when the provider needs none.
pub fn warmup(cfg: &Config) -> Option<Request> {
    (cfg.provider == "ollama").then(|| Request {
        url: format!("{}/api/generate", cfg.endpoint),
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: json!({ "model": cfg.model, "prompt": "", "stream": false, "keep_alive": cfg.keep_alive, "options": { "num_predict": 1 } }),
    })
}

/// A reply (status, parsed JSON) -> the suggestion texts, or a message for the status bar.
pub fn reply(cfg: &Config, status: u16, json: &Value) -> Result<Vec<String>, String> {
    let err = json["error"]["message"].as_str().or(json["error"].as_str());
    if status >= 400 || err.is_some() {
        if cfg.provider == "ollama" && err.is_some_and(|e| e.to_lowercase().contains("not found")) {
            return Err(format!("Ollama: model {} not found (run: ollama pull {})", cfg.model, cfg.model));
        }
        return Err(match err {
            Some(e) => format!("{}: {}", cfg.label, e.chars().take(160).collect::<String>()),
            None => format!("{}: HTTP {status}", cfg.label),
        });
    }
    Ok(if cfg.provider == "ollama" { vec![json["response"].as_str().unwrap_or("").to_string()] } else { vec![] })
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

/// POSTs `req` with curl (its config on stdin, so headers never show in `ps`): Ok((status, JSON)), Err(None) when
/// cancelled, Err(Some(message)) when it failed.
pub fn post(req: &Request, cancel: &Cancel) -> Result<(u16, Value), Option<String>> {
    let mut config = format!("url = {}\nrequest = \"POST\"\nsilent\nshow-error\nmax-time = {TIMEOUT_S}\nwrite-out = \"\\n%{{http_code}}\"\n", quoted(&req.url));
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
    let out = child.wait_with_output().map_err(|e| Some(format!("curl: {e}")))?;
    cancel.pid.store(0, Ordering::SeqCst);
    if cancel.cancelled() {
        return Err(None);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (body, code) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("curl: ").to_string();
        return Err(Some(if out.status.code() == Some(7) { "connection refused".into() } else { err }));
    }
    Ok((code.trim().parse().unwrap_or(0), serde_json::from_str(body).unwrap_or(Value::Null)))
}

/// A failed request -> the status bar's words.
pub fn failure(cfg: &Config, e: &str) -> String {
    if e == "connection refused" {
        return if cfg.provider == "ollama" { format!("Ollama is not running at {} (start it: ollama serve)", cfg.endpoint) } else { format!("{}: nothing answers at {}", cfg.label, cfg.endpoint) };
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

/// "Ollama qwen2.5-coder:7b · today 12 requests (limit 2000) · ~3.1k in / 40 out tokens · p50 140 ms, p95 900 ms"
pub fn usage_text(cfg: &Config, u: &Usage) -> String {
    let mut s = format!("{} {} · today {} request{}", cfg.label, cfg.model, u.requests, if u.requests == 1 { "" } else { "s" });
    if cfg.limit > 0 {
        s += &format!(" (limit {})", cfg.limit);
    }
    s += &format!(" · ~{} in / {} out tokens", tokens(u.in_chars), tokens(u.out_chars));
    if let (Some(a), Some(b)) = (percentile(&u.ms, 50.0), percentile(&u.ms, 95.0)) {
        s += &format!(" · p50 {a} ms, p95 {b} ms");
    }
    s
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
        let ctx = |p: &str, s: &str, next_line: bool| Context { prefix: p.into(), suffix: s.into(), next_line };
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
    fn a_provider_pauses_after_n_bad_replies_and_at_once_on_fim_tokens() {
        let mut h = Health::new(3);
        assert_eq!(h.record(Some("empty"), None), None);
        assert_eq!(h.record(None, None), None);
        h.record(Some("empty"), None);
        h.record(Some("echo"), None);
        assert!(h.record(None, Some("Ollama is not running")).unwrap().contains("3 errors in a row"));
        assert!(Health::new(5).record(Some("fim"), None).unwrap().contains("FIM template tokens"));
    }

    #[test]
    fn defaults_are_ollama_qwen_on_localhost_without_a_daily_limit() {
        let cfg = config(&normalize(&json!({})), |_| true);
        assert_eq!((cfg.provider.as_str(), cfg.model.as_str(), cfg.endpoint.as_str(), cfg.enabled, cfg.limit, cfg.max_tokens, cfg.debounce, cfg.manual), ("ollama", "qwen2.5-coder:7b", "http://127.0.0.1:11434", true, 0, 64, 250, false));
        assert!(!config(&normalize(&json!({})), |_| false).enabled);
        assert!(config(&normalize(&json!({ "editor.inlineSuggest.enabled": true })), |_| false).enabled);
        assert!(!config(&normalize(&json!({ "editor.inlineSuggest.provider": "off" })), |_| true).enabled);
        let r = request(&cfg, &Context { prefix: "p".into(), suffix: "s".into(), next_line: false });
        assert!(request(&cfg, &Context { prefix: String::new(), suffix: String::new(), next_line: true }).body["options"]["stop"].is_null());
        assert_eq!((r.body["prompt"].clone(), r.body["suffix"].clone(), r.body["keep_alive"].clone(), r.body["options"]["num_predict"].clone(), r.body["options"]["stop"].clone()), (json!("p"), json!("s"), json!("30m"), json!(64), json!(["\n"])));
        assert_eq!(warmup(&cfg).unwrap().body["options"]["num_predict"], json!(1));
        assert!(is_local("http://localhost:8080/v1") && !is_local("https://openrouter.ai/api/v1"));
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
        let (status, v) = post(&request(&cfg, &Context { prefix: "say \"hi\"\\n\n".into(), suffix: "\t}".into(), next_line: false }), &Cancel::default()).unwrap();
        assert_eq!((status, reply(&cfg, status, &v).unwrap()), (200, vec![" a + b;".to_string()]));
        let req = got.join().unwrap();
        let body: Value = serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!((body["prompt"].as_str(), body["suffix"].as_str()), (Some("say \"hi\"\\n\n"), Some("\t}")));
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
        assert_eq!(post(&request(&cfg, &Context { prefix: String::new(), suffix: String::new(), next_line: false }), &cancel).err(), Some(None));
        assert!(t0.elapsed() < std::time::Duration::from_secs(5));
    }
}
