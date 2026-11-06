// AI inline suggestions (VS Code's inline completions, as Copilot / Windsurf show them): the settings, which files and
// positions get one, the request context, the ghost text's rules (typing through it, accept next word), each provider's
// request and reply, the reply checks that pause a misbehaving provider, and the daily usage file (requests, approximate
// tokens, latency). Shared rules with the Rust editor's inline.rs. The editor (vsedit.cjs) owns timers, keys and drawing.
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROVIDERS = ["ollama", "off"];
const LABELS = { ollama: "Ollama", off: "Inline Suggestions" };
const MODELS = { ollama: "qwen2.5-coder:7b" };
const ENDPOINTS = { ollama: "http://127.0.0.1:11434" };
const PAID_DEFAULT_LIMIT = 2000; // requests a day for paid providers when dailyRequestLimit isn't set
const MAX_FILE_CHARS = 1_000_000; // no suggestions in bigger files
const TIMEOUT = 20000;
// Never sent to a provider (file names, or paths when the pattern has a "/"); editor.inlineSuggest.exclude adds to it.
const EXCLUDE = [".env", ".env.*", "*.env", ".envrc", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.asc", "*.gpg",
  "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*", "*.ppk", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd",
  "credentials", "credentials.*", "secrets.*", "*.secret", "*.secrets", "**/.ssh/**", "**/.aws/**", "**/.gnupg/**", "**/github-copilot/**"];

const P = "editor.inlineSuggest.";
const DEFAULTS = {
  [P + "enabled"]: null,           // null: on when the provider can run here (Ollama installed, …)
  [P + "provider"]: "ollama",      // "ollama" | "off"
  [P + "model"]: "",               // "": the provider's default (Ollama: qwen2.5-coder:7b)
  [P + "endpoint"]: "",            // "": the provider's default (Ollama: http://127.0.0.1:11434)
  [P + "trigger"]: "auto",         // "auto" (after typing pauses) | "manual" (Trigger Inline Suggestion only)
  [P + "multiline"]: false,        // false: one line at a time ("\n" stops the reply)
  [P + "debounce"]: 250,           // ms typing must pause before a request
  [P + "maxTokens"]: 64,
  [P + "prefixChars"]: 4000,       // text sent before the cursor
  [P + "suffixChars"]: 1000,       // and after it
  [P + "stopAfter"]: 5,            // empty / repeated replies or errors in a row that pause the provider for this session
  [P + "dailyRequestLimit"]: null, // null: 2000 for paid providers, unlimited for local ones; 0: unlimited
  [P + "keepAlive"]: "30m",        // Ollama: how long the model stays loaded after a request
  [P + "exclude"]: [],             // more file patterns never sent (on top of EXCLUDE)
};
const NUMBERS = { debounce: [0, 5000], maxTokens: [1, 2048], prefixChars: [0, 100000], suffixChars: [0, 100000], stopAfter: [1, 100], dailyRequestLimit: [0, 1e7] };

// Raw settings object -> the inline settings with valid values (invalid ones are the default).
function normalize(raw = {}) {
  const v = { ...DEFAULTS };
  const get = (k) => raw[P + k];
  if (typeof get("enabled") === "boolean") v[P + "enabled"] = get("enabled");
  if (PROVIDERS.includes(get("provider"))) v[P + "provider"] = get("provider");
  for (const k of ["model", "endpoint", "keepAlive"]) if (typeof get(k) === "string") v[P + k] = get(k).trim();
  if (["auto", "manual"].includes(get("trigger"))) v[P + "trigger"] = get("trigger");
  if (typeof get("multiline") === "boolean") v[P + "multiline"] = get("multiline");
  for (const [k, [lo, hi]] of Object.entries(NUMBERS)) {
    const n = get(k);
    if (typeof n === "number" && Number.isFinite(n)) v[P + k] = Math.round(Math.max(lo, Math.min(hi, n)));
  }
  if (Array.isArray(get("exclude"))) v[P + "exclude"] = get("exclude").filter(s => typeof s === "string" && s.trim());
  return v;
}

const isLocal = (url) => { try { return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname); } catch { return false; } };

// Settings values -> what the editor runs with. usable(cfg): whether the provider can run here (the default of `enabled`).
function config(values, usable = () => true) {
  const v = (k) => values[P + k];
  const provider = v("provider");
  const cfg = {
    provider, label: LABELS[provider], model: v("model") || MODELS[provider] || "", endpoint: (v("endpoint") || ENDPOINTS[provider] || "").replace(/\/+$/, ""),
    customEndpoint: !!v("endpoint"), trigger: v("trigger"), multiline: v("multiline"), debounce: v("debounce"), maxTokens: v("maxTokens"),
    prefixChars: v("prefixChars"), suffixChars: v("suffixChars"), stopAfter: v("stopAfter"), keepAlive: v("keepAlive") || "30m",
    exclude: [...EXCLUDE, ...v("exclude")],
  };
  cfg.paid = provider !== "off" && provider !== "ollama" && !isLocal(cfg.endpoint);
  cfg.limit = v("dailyRequestLimit") ?? (cfg.paid ? PAID_DEFAULT_LIMIT : 0);
  cfg.key = `${provider}:${cfg.model}`;
  cfg.enabled = provider !== "off" && (v("enabled") ?? !!usable(cfg));
  return cfg;
}

// ---------- which files and positions ----------
// A glob (*, ?, ** across folders) -> RegExp, case-insensitive.
function globRe(p) {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*" && p[i + 1] === "*") { re += ".*"; i++; if (p[i + 1] === "/") i++; }
    else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
// True when the file matches a deny pattern: a name pattern against the file name, a path pattern against the path.
function denied(file, patterns) {
  const full = file.split(path.sep).join("/"), base = path.basename(file);
  return patterns.some(p => (p.includes("/") ? globRe(p.startsWith("/") || p.startsWith("**") ? p : "**/" + p).test(full) : globRe(p).test(base)));
}
// VS Code's rule: a suggestion only where the rest of the line is blank or closing characters (not inside a word).
const CLOSERS = /^[\s)\]}>"'`;,.:]*$/;
const atSuggestable = (lineText, col) => CLOSERS.test(lineText.slice(col));

// The text around the cursor: { prefix, suffix, nextLine } within the configured character caps. The prefix starts at
// a line start (only the cursor line itself is ever cut), so typing on doesn't shift its start and the provider's
// prompt cache (Ollama's) keeps everything before the cursor. nextLine: the cursor ends a finished statement (`;` `{` `}` `)` `,` `:` before it, nothing
// after), so a one-line suggestion may be the next line.
function contextAt(lines, line, col, prefixChars, suffixChars) {
  const nextLine = /[;{}),:]\s*$/.test(lines[line].slice(0, col)) && !lines[line].slice(col).trim();
  let prefix = lines[line].slice(0, col);
  for (let l = line - 1; l >= 0 && prefix.length + lines[l].length + 1 <= prefixChars; l--) prefix = lines[l] + "\n" + prefix;
  let suffix = lines[line].slice(col);
  for (let l = line + 1; l < lines.length && suffix.length < suffixChars; l++) suffix += "\n" + lines[l];
  return { prefix: prefix.slice(Math.max(0, prefix.length - prefixChars)), suffix: suffix.slice(0, suffixChars), nextLine };
}

// ---------- the ghost text ----------
// Typing `text` where a suggestion shows: the suggestions that start with it, less it; null when none does (the
// suggestion goes) or nothing would be left.
function typeThrough(items, text) {
  const left = items.filter(s => s.startsWith(text) && s.length > text.length).map(s => s.slice(text.length));
  return left.length ? left : null;
}
// How much of `text` Accept Next Word takes (VS Code's): a line break with the next line's indent, else spaces and one
// word or one run of punctuation.
function nextWordLength(text) {
  const m = /^(?:\r?\n[\t ]*|[\t ]*[\p{L}\p{N}_$]+|[\t ]*[^\s\p{L}\p{N}_$]+|[\t ]+)/u.exec(text);
  return m ? m[0].length : text.length;
}
// The suggestion less the end of the line it would repeat (`)` an auto-closed pair already put after the cursor).
function trimLineSuffix(text, lineSuffix) {
  const s = lineSuffix.trimEnd();
  if (!s) return text;
  const lines = text.split("\n"), last = lines[lines.length - 1].trimEnd();
  if (last.endsWith(s)) lines[lines.length - 1] = last.slice(0, last.length - s.length);
  return lines.join("\n");
}

// ---------- replies ----------
// Template tokens of the FIM models (Qwen, StarCoder, DeepSeek, Codestral, Code Llama) that never belong in a reply.
const FIM_TOKENS = ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>", "<|endoftext|>", "<|file_sep|>", "<|repo_name|>",
  "<|im_start|>", "<|im_end|>", "<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<file_sep>", "<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>",
  "<｜end▁of▁sentence｜>", "[PREFIX]", "[SUFFIX]", "[MIDDLE]", "<PRE>", "<SUF>", "<MID>", "<EOT>"];
const firstToken = (text) => Math.min(...FIM_TOKENS.map(t => text.indexOf(t)).filter(i => i >= 0));
// A provider's raw text -> { text (null when nothing is left), anomaly: null | "fim" (template tokens: pause now) |
// "echo" (the text before or after the cursor repeated) | "empty" }. Cuts what follows a FIM token, a repeat of the
// text after the cursor, and (one-line mode) the first line break — after the next line's text when nextLine.
function clean(raw, { prefix, suffix, multiline, nextLine = false }) {
  let text = String(raw ?? "").replace(/\r\n?/g, "\n"), anomaly = null;
  const fim = firstToken(text);
  if (fim !== Infinity) { text = text.slice(0, fim); anomaly = "fim"; }
  if (!multiline) { const m = nextLine && /^\n+([^\n]*)/.exec(text); text = m ? "\n" + m[1] : text.split("\n")[0]; }
  const tail = prefix.slice(prefix.lastIndexOf("\n") + 1).trim();
  if (tail.length >= 4 && text.trimStart().startsWith(tail)) { text = text.trimStart().slice(tail.length); anomaly ??= "echo"; }
  // the text after the cursor written again: a run of its first lines (4 characters at least) from a line of the reply
  const after = suffix.split("\n").map(l => l.trim()).filter(Boolean).slice(0, 3), lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    let j = 0, n = 0;
    while (j < after.length && k + j < lines.length && lines[k + j].trim() === after[j]) n += after[j++].length;
    if (j && (n >= 4 || k + j === lines.length && j === after.length)) { text = lines.slice(0, k).join("\n"); if (!text.trim()) anomaly ??= "echo"; break; }
  }
  text = trimLineSuffix(text.trimEnd(), suffix.split("\n")[0]);
  if (!text.trim()) return { text: null, anomaly: anomaly ?? "empty" };
  return { text, anomaly };
}

// Pauses a provider that keeps misbehaving: FIM tokens at once, `limit` empty/repeated replies or errors in a row.
class Health {
  constructor(limit) { this.limit = limit; this.bad = 0; this.paused = null; }
  record(anomaly, error = null) {
    if (anomaly === "fim") return (this.paused = "the reply had FIM template tokens (wrong model or template?)");
    if (!anomaly && !error) { this.bad = 0; return null; }
    if (++this.bad >= this.limit) this.paused = error ? `${this.bad} errors in a row: ${error}` : `${this.bad} empty or repeated replies in a row`;
    return this.paused;
  }
}

// ---------- providers ----------
// The HTTP request for a suggestion: { url, headers, body }.
function request(cfg, ctx) {
  if (cfg.provider === "ollama") {
    return { url: `${cfg.endpoint}/api/generate`, headers: { "Content-Type": "application/json" },
      body: { model: cfg.model, prompt: ctx.prefix, suffix: ctx.suffix, stream: false, keep_alive: cfg.keepAlive,
        options: { num_predict: cfg.maxTokens, temperature: 0.2, ...(cfg.multiline || ctx.nextLine ? {} : { stop: ["\n"] }) } } };
  }
  throw new Error(`Unknown inline suggestion provider: ${cfg.provider}`);
}
// Loads the model ahead of the first suggestion (Ollama keeps it keepAlive): null when the provider needs none.
function warmup(cfg) {
  if (cfg.provider !== "ollama") return null;
  return { url: `${cfg.endpoint}/api/generate`, headers: { "Content-Type": "application/json" },
    body: { model: cfg.model, prompt: "", stream: false, keep_alive: cfg.keepAlive, options: { num_predict: 1 } } };
}
// A reply (status, parsed JSON) -> the suggestion texts; throws a message for the status bar.
function reply(cfg, status, json) {
  const err = json?.error?.message ?? json?.error;
  if (status >= 400 || err) {
    if (cfg.provider === "ollama" && /not found/i.test(err ?? "")) throw new Error(`Ollama: model ${cfg.model} not found (run: ollama pull ${cfg.model})`);
    throw new Error(`${cfg.label}: ${err ? String(err).slice(0, 160) : `HTTP ${status}`}`);
  }
  if (cfg.provider === "ollama") return [json?.response ?? ""];
  return [];
}
// A failed connection -> the status bar's words.
function failure(cfg, e) {
  if (e?.name === "AbortError") return null;
  const code = e?.cause?.code ?? e?.code;
  if (code === "ECONNREFUSED") return cfg.provider === "ollama" ? `Ollama is not running at ${cfg.endpoint} (start it: ollama serve)` : `${cfg.label}: nothing answers at ${cfg.endpoint}`;
  return e?.message?.startsWith(cfg.label) || e?.message?.startsWith("Ollama") ? e.message : `${cfg.label}: ${e?.message ?? e}`;
}

// POSTs a request with fetch; `signal` aborts it. Resolves { status, json }.
async function post(req, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT);
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

// ---------- usage: <herdr home>/.vscode-inline-usage.json, per local date and provider:model ----------
const usageFile = () => process.env.VSEDIT_INLINE_USAGE
  ?? path.join(process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app"), ".vscode-inline-usage.json");
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const KEEP_DAYS = 14, KEEP_MS = 200;
function readUsage(file = usageFile()) { try { const o = JSON.parse(fs.readFileSync(file, "utf8")); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
// Today's { requests, inChars, outChars, ms: [latencies] } for `key`.
const usageOf = (key, file = usageFile(), day = today()) => ({ requests: 0, inChars: 0, outChars: 0, ms: [], ...readUsage(file)[day]?.[key] });
// Adds one request (a failed one has no ms); keeps the last KEEP_DAYS dates.
function recordUsage(key, { inChars, outChars = 0, ms = null }, file = usageFile(), day = today()) {
  const all = readUsage(file), d = (all[day] ??= {}), u = (d[key] ??= { requests: 0, inChars: 0, outChars: 0, ms: [] });
  u.requests++; u.inChars += inChars; u.outChars += outChars;
  if (ms != null) u.ms = [...(u.ms ?? []), Math.round(ms)].slice(-KEEP_MS);
  for (const k of Object.keys(all).sort().slice(0, -KEEP_DAYS)) delete all[k];
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all)); } catch {}
  return u;
}
const percentile = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const tokens = (chars) => { const t = Math.round(chars / 4); return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t); };
// "Ollama qwen2.5-coder:7b · today 12 requests (limit 2000) · ~3.1k in / 40 out tokens · p50 140 ms, p95 900 ms"
function usageText(cfg, u) {
  const p50 = percentile(u.ms ?? [], 50), p95 = percentile(u.ms ?? [], 95);
  return `${cfg.label} ${cfg.model} · today ${u.requests} request${u.requests === 1 ? "" : "s"}${cfg.limit ? ` (limit ${cfg.limit})` : ""}` +
    ` · ~${tokens(u.inChars)} in / ${tokens(u.outChars)} out tokens` + (p50 == null ? "" : ` · p50 ${p50} ms, p95 ${p95} ms`);
}

module.exports = { PROVIDERS, DEFAULTS, EXCLUDE, MAX_FILE_CHARS, normalize, config, isLocal, globRe, denied, atSuggestable, contextAt,
  typeThrough, nextWordLength, trimLineSuffix, clean, Health, request, warmup, reply, failure, post,
  usageFile, today, usageOf, recordUsage, percentile, usageText };
