// AI inline suggestions (VS Code's inline completions, as Copilot / Windsurf show them): the settings, which files and
// positions get one, the request context, the ghost text's rules (typing through it, accept next word), each provider's
// request and reply, the reply checks that pause a misbehaving provider, and the daily usage file (requests, approximate
// tokens, latency). Shared rules with the Rust editor's inline.rs. The editor (vsedit.cjs) owns timers, keys and drawing.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROVIDERS = ["ollama", "codestral", "deepseek", "mercury", "off"];
const LABELS = { ollama: "Ollama", codestral: "Codestral", deepseek: "DeepSeek", mercury: "Mercury", off: "Inline Suggestions" };
const MODELS = { ollama: "qwen2.5-coder:1.5b-base", codestral: "codestral-latest", deepseek: "deepseek-flash", mercury: "mercury-edit-2" };
const ENDPOINTS = { ollama: "http://127.0.0.1:11434", codestral: "https://api.mistral.ai/v1/fim/completions",
  deepseek: "https://api.deepseek.com/beta/completions", mercury: "https://api.inceptionlabs.ai/v1/fim/completions" };
// Hosted FIM APIs, one adapter (POST {model, prompt, suffix, max_tokens, stop, stream} with a Bearer key): the key's
// environment variable and the price in USD per million input / output tokens (editor.inlineSuggest.price overrides).
const HOSTED = { codestral: { env: "MISTRAL_API_KEY", price: [0.3, 0.9] }, deepseek: { env: "DEEPSEEK_API_KEY", price: [0.3, 1.2] },
  mercury: { env: "INCEPTION_API_KEY", price: [0.25, 0.75] } };
const HOSTED_LIMIT = 2000; // requests a day by default for a paid provider (Ollama: unlimited)
const MAX_FILE_CHARS = 1_000_000; // no suggestions in bigger files
const TIMEOUT = 20000;
// Never sent to a provider (file names, or paths when the pattern has a "/"); editor.inlineSuggest.exclude adds to it.
const EXCLUDE = [".env", ".env.*", "*.env", ".envrc", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.asc", "*.gpg",
  "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*", "*.ppk", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd",
  "credentials", "credentials.*", "secrets.*", "*.secret", "*.secrets", "**/.ssh/**", "**/.aws/**", "**/.gnupg/**", "**/github-copilot/**"];

const P = "editor.inlineSuggest.";
const DEFAULTS = {
  [P + "enabled"]: null,           // null: on when the provider can run here (Ollama installed, …)
  [P + "provider"]: "ollama",      // "ollama" | "codestral" | "deepseek" | "mercury" | "off"
  [P + "model"]: "",               // "": the provider's default (Ollama: qwen2.5-coder:1.5b-base)
  [P + "endpoint"]: "",            // "": the provider's default (ENDPOINTS: Ollama's server, the hosted APIs' FIM URL)
  [P + "trigger"]: "auto",         // "auto" (after typing pauses) | "manual" (Trigger Inline Suggestion only)
  [P + "multiline"]: true,         // true: a block (cut where it ends: blockCut); false: one line ("\n" stops the reply)
  [P + "debounce"]: 250,           // ms typing must pause before a request
  [P + "maxTokens"]: 256,
  [P + "prefixChars"]: 4000,       // text sent before the cursor
  [P + "suffixChars"]: 300,        // and after it (re-read on every request: Qwen's FIM puts it after the prefix)
  [P + "stopAfter"]: 5,            // errors in a row that pause the provider for this session (4x as many dropped replies)
  [P + "dailyRequestLimit"]: null, // requests a day before suggestions stop until tomorrow; 0: unlimited; null: 2,000 for a paid provider, Ollama 0
  [P + "price"]: null,             // { input, output } USD per million tokens for the cost estimate; null: HOSTED's
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
  const price = get("price");
  if ([price?.input, price?.output].every(n => typeof n === "number" && n >= 0)) v[P + "price"] = { input: price.input, output: price.output };
  return v;
}

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
  cfg.hosted = !!HOSTED[provider];
  cfg.limit = v("dailyRequestLimit") ?? (cfg.hosted ? HOSTED_LIMIT : 0);
  const price = v("price") ?? (cfg.hosted ? { input: HOSTED[provider].price[0], output: HOSTED[provider].price[1] } : null);
  cfg.price = price;
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
// A blank line after a blank line with nothing below it: no suggestion after typing there (Alt+\ still asks).
const quietEnd = (lines, line) => line > 0 && !lines[line - 1].trim() && lines.slice(line).every(l => !l.trim());

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
// How much of `text` Accept Next Line takes: up to its next line break (a leading one with the line after it).
function nextLineLength(text) {
  const i = text.indexOf("\n", text.startsWith("\n") ? 1 : 0);
  return i < 0 ? text.length : i;
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
// Prose and markup files, where sentences and Markdown fences are what the user writes.
const proseFile = (file) => /\.(md|markdown|mdx|txt|text|rst|adoc|asciidoc|org|tex|html?|xml)$/i.test(file) || /(^|[\\/])COMMIT_EDITMSG$/.test(file);
// A chat model's answer instead of code: "Here's …", "This file defines …", or a sentence: a capitalized word and 3+
// more words (no code characters) up to one ending in . : ! or ?.
const PROSE = /^(?:here(?:'s| is| are)\b|this (?:file|code|script|docker|compose|function|config|configuration|is|will|defines?)\b|the (?:following|above|code|file)\b|sure\b|certainly\b|i(?:'m|'ll| am| will| have)\b|let's\b|note:|explanation:)/i;
function sentence(line) {
  const words = line.split(/ +/), k = words.findIndex(w => /[.:!?]$/.test(w));
  return k >= 3 && /^[A-Z][a-z]+$/.test(words[0]) && words.slice(0, k + 1).every(w => /[A-Za-z]/.test(w) && !/[=;{}()<>$[\]]/.test(w));
}
// The cursor is in a comment or a string (a sentence may belong there): the line starts a comment, a quote on it is
// open, or a Python docstring is.
function inText(prefix) {
  const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
  return /^\s*(?:#|\/\/|\/\*|\*|--|<!--)/.test(line) || ['"', "'", "`"].some(q => line.split(q).length % 2 === 0) ||
    ['"""', "'''"].some(q => prefix.split(q).length % 2 === 0);
}
// Where a block suggestion ends (VS Code / Copilot's rules), over the lines complete so far (all when `final`): before a
// line less indented than the block's first line, before one closing a bracket opened before the cursor, after the line
// closing a bracket the first line opened, before two blank lines, before the line the text after the cursor goes on
// with. At the end of the file a closing line (`}`) ends the block with it. -> { text, done: a rule cut it }
function blockCut(text, { prefix, suffix }, final = true) {
  const lines = text.split("\n"), n = final ? lines.length : lines.length - 1;
  const lead = prefix.slice(prefix.lastIndexOf("\n") + 1), next = suffix.split("\n").map(l => l.trim()).find(Boolean);
  const indent = (l) => /^[ \t]*/.exec(l)[0].length;
  const upTo = (k) => ({ text: lines.slice(0, k).join("\n").trimEnd(), done: true });
  let base = -1, depth = 0, opener = false, blanks = 0;
  for (let i = 0; i < n; i++) {
    const t = lines[i].trim();
    if (!t) { if (i && ++blanks === 2) return upTo(i - 1); continue; }
    blanks = 0;
    const before = depth;
    let low = depth;
    for (const c of lines[i]) if ("([{".includes(c)) depth++; else if (")]}".includes(c)) low = Math.min(low, --depth);
    if (base < 0) { base = indent(i ? lines[i] : lead + lines[i]); depth = Math.max(depth, 0); opener = depth > 0; continue; }
    if (indent(lines[i]) < base || low < 0) return upTo(!suffix.trim() && /^[)\]}]/.test(t) ? i + 1 : i);
    if (opener && before > 0 && depth === 0) return upTo(i + 1);
    if (before === 0 && t === next) return upTo(i);
  }
  return { text: lines.slice(0, n).join("\n"), done: false };
}
// A provider's raw text -> { text (null when nothing is left), anomaly: null | "fim" (template tokens: pause now) |
// "prose" (sentences, not code) | "fence" (a Markdown fence alone) | "echo" (the text before or after the cursor
// repeated) | "empty" }. Cuts what follows a FIM token, Markdown fences (a leading one with its language), a repeat of
// the text after the cursor, and the end of a block (blockCut) or, in one-line mode, the first line break — after the
// next line's text when nextLine. Prose files (`prose`) keep sentences and fences.
function clean(raw, { prefix, suffix, multiline, nextLine = false, prose = false }) {
  let text = String(raw ?? "").replace(/\r\n?/g, "\n"), anomaly = null;
  const fim = firstToken(text);
  if (fim !== Infinity) { text = text.slice(0, fim); anomaly = "fim"; }
  if (!prose) {
    const fence = /^\s*```[\w+.#-]*[ \t]*(?:\n|$)/.exec(text), end = (fence ? text.slice(fence[0].length) : text).search(/^[ \t]*```/m);
    if (fence) text = text.slice(fence[0].length);
    if (end >= 0) text = text.slice(0, end);
    if ((fence || end >= 0) && !text.trim()) return { text: null, anomaly: "fence" };
    const first = text.trim().split("\n")[0];
    if (!inText(prefix) && (PROSE.test(first) || sentence(first))) return { text: null, anomaly: "prose" };
  }
  if (!multiline) { const m = nextLine && /^\n+([^\n]*)/.exec(text); text = m ? "\n" + m[1] : text.split("\n")[0]; }
  else text = blockCut(text, { prefix, suffix }).text;
  const tail = prefix.slice(prefix.lastIndexOf("\n") + 1).trim();
  if (tail.length >= 4 && text.trimStart().startsWith(tail)) { text = text.trimStart().slice(tail.length); anomaly ??= "echo"; }
  // the text after the cursor written again: a run of its first lines (4 characters at least) from a line of the reply
  // (blocks: blockCut stops at it)
  const after = multiline ? [] : suffix.split("\n").map(l => l.trim()).filter(Boolean).slice(0, 3), lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    let j = 0, n = 0;
    while (j < after.length && k + j < lines.length && lines[k + j].trim() === after[j]) n += after[j++].length;
    if (j && (n >= 4 || k + j === lines.length && j === after.length)) { text = lines.slice(0, k).join("\n"); if (!text.trim()) anomaly ??= "echo"; break; }
  }
  text = trimLineSuffix(text.trimEnd(), suffix.split("\n")[0]);
  if (text.trim() && suffix.trimStart().startsWith(text.trim())) return { text: null, anomaly: "echo" }; // only the text after the cursor
  if (!text.trim()) return { text: null, anomaly: anomaly ?? "empty" };
  return { text, anomaly };
}

// Why a reply was dropped, for the status bar's tooltip.
const DROPPED = { echo: "it repeated the text around the cursor", prose: "it was prose, not code", fence: "it was a Markdown code fence" };
// Pauses a provider that keeps misbehaving: FIM tokens at once, `limit` errors in a row, 4 × `limit` dropped replies
// (prose, fences, repeats) in a row. An empty reply (nothing fits there) counts for nothing. `note`: what happened last.
class Health {
  constructor(limit) { this.limit = limit; this.errors = 0; this.dropped = 0; this.paused = null; this.note = null; }
  record(anomaly, error = null) {
    if (anomaly === "fim") return (this.paused = "the reply had FIM template tokens (wrong model or template?)");
    if (error) {
      this.note = error;
      if (++this.errors >= this.limit) this.paused = `${this.errors} errors in a row: ${error}`;
      return this.paused;
    }
    this.errors = 0;
    if (!DROPPED[anomaly]) { this.note = anomaly === "empty" ? "the last reply was empty (nothing to suggest there)" : null; if (!anomaly) this.dropped = 0; return null; }
    this.note = `the last reply was dropped: ${DROPPED[anomaly]}`;
    if (++this.dropped >= this.limit * 4) this.paused = `${this.dropped} replies in a row were dropped (the last: ${DROPPED[anomaly]}); a base model does better`;
    return this.paused;
  }
}

// ---------- providers ----------
// FIM prompts per model family, sent raw (Ollama's `suffix` falls back to the chat template when the text after the
// cursor is empty, and a chat model answers in prose there). spm: the suffix goes first. Other models use `suffix`.
const TEMPLATES = [
  { re: /qwen[\d.]*-?coder|codeqwen/i, pre: "<|fim_prefix|>", mid: "<|fim_suffix|>", end: "<|fim_middle|>",
    stop: ["<|endoftext|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>", "<|file_sep|>", "<|repo_name|>", "<|im_start|>", "<|im_end|>", "<|cursor|>"] },
  { re: /codestral/i, spm: true, pre: "[SUFFIX]", mid: "[PREFIX] ", end: "", stop: ["[INST]", "[/INST]", "[PREFIX]", "[SUFFIX]", "[MIDDLE]", "</s>"] },
  { re: /deepseek-coder/i, pre: "<｜fim▁begin｜>", mid: "<｜fim▁hole｜>", end: "<｜fim▁end｜>", stop: ["<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<｜end▁of▁sentence｜>", "<|EOT|>"] },
  { re: /starcoder/i, pre: "<fim_prefix>", mid: "<fim_suffix>", end: "<fim_middle>", stop: ["<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<|endoftext|>", "<file_sep>"] },
];
const template = (model) => TEMPLATES.find(t => t.re.test(model)) ?? null;
const fimPrompt = (t, prefix, suffix) => t.spm ? t.pre + suffix + t.mid + prefix + t.end : t.pre + prefix + t.mid + suffix + t.end;
const JSON_HEADERS = { "Content-Type": "application/json" };
// A short stable id of a file (FNV-1a), Codestral's prompt_cache_key: the same file reuses the provider's prompt cache.
function cacheKey(file) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(file)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `vsedit-${h.toString(16).padStart(8, "0")}`;
}
// The HTTP request for a suggestion: { url, headers, body } (stream: Ollama's NDJSON lines or the hosted APIs' SSE
// events, read by postStream). key: a hosted provider's API key.
function request(cfg, ctx, stream = false, key = "") {
  if (cfg.hosted) {
    const stop = cfg.multiline || ctx.nextLine ? [] : ["\n"];
    return { url: cfg.endpoint, headers: { ...JSON_HEADERS, Authorization: `Bearer ${key}` },
      body: { model: cfg.model, prompt: ctx.prefix, suffix: ctx.suffix, max_tokens: cfg.maxTokens, stream, ...(stop.length ? { stop } : {}),
        ...(cfg.provider === "codestral" && ctx.file ? { prompt_cache_key: cacheKey(ctx.file) } : {}) } };
  }
  if (cfg.provider === "ollama") {
    const t = template(cfg.model), stop = [...(t?.stop ?? []), ...(cfg.multiline || ctx.nextLine ? [] : ["\n"])];
    const prompt = t ? { prompt: fimPrompt(t, ctx.prefix, ctx.suffix), raw: true } : { prompt: ctx.prefix, suffix: ctx.suffix };
    return { url: `${cfg.endpoint}/api/generate`, headers: JSON_HEADERS,
      body: { model: cfg.model, ...prompt, stream, keep_alive: cfg.keepAlive, options: { num_predict: cfg.maxTokens, temperature: 0.2, ...(stop.length ? { stop } : {}) } } };
  }
  throw new Error(`Unknown inline suggestion provider: ${cfg.provider}`);
}
// Loads the model ahead of the first suggestion (Ollama keeps it keepAlive): null when the provider needs none.
function warmup(cfg) {
  if (cfg.provider !== "ollama") return null;
  return { url: `${cfg.endpoint}/api/generate`, headers: JSON_HEADERS,
    body: { model: cfg.model, prompt: "", stream: false, keep_alive: cfg.keepAlive, options: { num_predict: 1 } } };
}
// Asks Ollama about the model (/api/show), before the warm-up: null when the provider has nothing to ask.
const show = (cfg) => cfg.provider === "ollama" ? { url: `${cfg.endpoint}/api/show`, headers: JSON_HEADERS, body: { model: cfg.model } } : null;
// show's reply -> { missing: not pulled, chat: a chat template (.Messages) } | null (the server didn't say).
function modelInfo(status, json) {
  if (status === 404 || /not found/i.test(json?.error ?? "")) return { missing: true, chat: false };
  if (status >= 400 || typeof json?.template !== "string") return null;
  return { missing: false, chat: /\.Messages\b/.test(json.template) };
}
// Whether to recommend a base model: the template says chat, or (Ollama said nothing) the name has no "base".
const chatModel = (cfg, info) => info === undefined ? false : info ? info.chat : !/base/i.test(cfg.model);
const missingText = (cfg) => `${cfg.label}: model ${cfg.model} not found (run: ollama pull ${cfg.model})`;
const chatHint = (cfg) => `${cfg.model} is a chat model and often answers in prose; a base model completes code (ollama pull ${MODELS.ollama}, then set editor.inlineSuggest.model)`;
// The text of one reply or streamed event: Ollama's `response`, a completion's `choices[0].text`, a chat-shaped one's
// `delta.content` / `message.content` (Mistral's FIM).
const replyText = (j) => { const c = j?.choices?.[0]; return j?.response ?? c?.text ?? c?.delta?.content ?? c?.message?.content ?? null; };
// An error body's message: OpenAI's {error: {message}}, Ollama's {error}, Mistral's {message} / {detail}.
const errorText = (j) => { const e = j?.error?.message ?? j?.error ?? (j?.object === "error" || j?.detail ? j?.message ?? j?.detail : null);
  return e == null ? null : typeof e === "string" ? e : JSON.stringify(e); };
// A reply (status, parsed JSON) -> the suggestion texts; throws a message for the status bar.
function reply(cfg, status, json) {
  const err = errorText(json);
  if (status >= 400 || err) {
    if (cfg.provider === "ollama" && /not found/i.test(err ?? "")) throw new Error(missingText(cfg));
    if (cfg.hosted && (status === 401 || status === 403)) throw new Error(`${cfg.label}: the API key was refused (HTTP ${status}); ${keyHelp(cfg.provider)}`);
    throw new Error(`${cfg.label}: ${err ? err.slice(0, 160) : `HTTP ${status}`}`);
  }
  return [replyText(json) ?? ""];
}
// A failed connection -> the status bar's words.
function failure(cfg, e) {
  if (e?.name === "AbortError") return null;
  const code = e?.cause?.code ?? e?.code;
  if (code === "ECONNREFUSED") return cfg.provider === "ollama" ? `Ollama is not running at ${cfg.endpoint} (start it: ollama serve)` : `${cfg.label}: nothing answers at ${cfg.endpoint}`;
  return e?.message?.startsWith(cfg.label) || e?.message?.startsWith("Ollama") ? e.message : `${cfg.label}: ${e?.message ?? e}`;
}

// Sends a request with fetch (POST unless req.method); `signal` aborts it. Resolves { status, json }.
async function post(req, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT);
  const res = await fetch(req.url, { method: req.method ?? "POST", headers: req.headers, body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
// POSTs a streaming request: reads Ollama's NDJSON lines or SSE `data:` events, calling onText(the text so far) after
// each chunk; onText returning true stops reading (the block is complete) and closes the connection. Resolves
// { status, json } like post, json.response holding the text read (or the error body).
async function postStream(req, signal, onText) {
  const stop = new AbortController();
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body),
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(TIMEOUT), ...(signal ? [signal] : [])]) });
  const dec = new TextDecoder();
  let text = "", rest = "", error = null;
  const take = (line) => {
    let j = null;
    try { j = JSON.parse(line.replace(/^data:\s*/, "")); } catch {}
    if (errorText(j)) error = j; else if (typeof replyText(j) === "string") text += replyText(j);
  };
  try {
    for await (const chunk of res.body) {
      const lines = (rest + dec.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop();
      lines.forEach(take);
      if (!error && onText(text)) { stop.abort(); rest = ""; break; }
    }
  } catch (e) { if (!stop.signal.aborted) throw e; }
  if (rest.trim()) take(rest);
  return { status: res.status, json: error ?? { response: text } };
}

// ---------- API keys: the macOS keychain, then <herdr home>/vscode-secrets.json (mode 600), then the environment ----------
const herdrHome = () => process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app");
const secretsFile = () => process.env.VSEDIT_SECRETS ?? path.join(herdrHome(), "vscode-secrets.json");
const securityBin = () => process.env.VSEDIT_SECURITY ?? (process.platform === "darwin" ? "/usr/bin/security" : null);
const service = (provider) => `herdr-vscode-${provider}`;
// How to give a provider its key, for the status bar.
const keyHelp = (provider) => `no API key: security add-generic-password -U -s ${service(provider)} -a herdr -w <key> ` +
  `(or Settings › Inline Suggestions; elsewhere ${secretsFile()} with {"${provider}": "<key>"}, chmod 600; or ${HOSTED[provider].env})`;
// The provider's key: { key, from: "keychain" | "file" | "env" } | { key: null, loose: the file is readable by others }.
// The file is read only when no one else may read it.
function apiKey(provider) {
  const sec = securityBin();
  if (sec) {
    const r = spawnSync(sec, ["find-generic-password", "-s", service(provider), "-w"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) return { key: r.stdout.trim(), from: "keychain" };
  }
  let loose = false;
  try {
    if (fs.statSync(secretsFile()).mode & 0o077) loose = true;
    else { const k = JSON.parse(fs.readFileSync(secretsFile(), "utf8"))?.[provider]; if (typeof k === "string" && k.trim()) return { key: k.trim(), from: "file" }; }
  } catch {}
  const env = process.env[HOSTED[provider].env];
  return env?.trim() ? { key: env.trim(), from: "env" } : { key: null, loose };
}
// The key with its middle hidden, for the Settings dialog: "sk-a…9xQz".
const maskKey = (key) => (key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "••••");
// Stores a key: the keychain (`security -i` reads the command on stdin, so the key is in no process's arguments), else
// the 600 file. -> where it went.
function saveKey(provider, key) {
  if (!/^[\x21-\x7e]+$/.test(key) || /["\\]/.test(key)) throw new Error("the key has characters an API key doesn't (spaces, quotes or backslashes)");
  const sec = securityBin();
  if (sec && spawnSync(sec, ["-i"], { input: `add-generic-password -U -s ${service(provider)} -a herdr -w "${key}"\n`, timeout: 5000 }).status === 0) return "keychain";
  const file = secretsFile();
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...all, [provider]: key }, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return "file";
}
// Removes the provider's key from the keychain and the file.
function removeKey(provider) {
  const sec = securityBin();
  if (sec) spawnSync(sec, ["delete-generic-password", "-s", service(provider), "-a", "herdr"], { timeout: 5000 });
  try {
    const file = secretsFile(), all = JSON.parse(fs.readFileSync(file, "utf8"));
    if (all && provider in all) { delete all[provider]; fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 }); }
  } catch {}
}

// ---------- usage: <herdr home>/.vscode-inline-usage.json, per local date and provider:model ----------
const usageFile = () => process.env.VSEDIT_INLINE_USAGE ?? path.join(herdrHome(), ".vscode-inline-usage.json");
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
// Today's approximate cost in USD (tokens: characters ÷ 4) at cfg.price; null for a free provider.
const cost = (cfg, u) => cfg.price ? (u.inChars / 4 * cfg.price.input + u.outChars / 4 * cfg.price.output) / 1e6 : null;
function usageText(cfg, u) {
  const p50 = percentile(u.ms ?? [], 50), p95 = percentile(u.ms ?? [], 95), usd = cost(cfg, u);
  return `${cfg.label} ${cfg.model} · today ${u.requests} request${u.requests === 1 ? "" : "s"}${cfg.limit ? ` (limit ${cfg.limit})` : ""}` +
    ` · ~${tokens(u.inChars)} in / ${tokens(u.outChars)} out tokens` + (usd == null ? "" : ` · ~$${usd.toFixed(usd < 0.1 ? 4 : 2)}`) +
    (p50 == null ? "" : ` · p50 ${p50} ms, p95 ${p95} ms`);
}

module.exports = { PROVIDERS, MODELS, DEFAULTS, EXCLUDE, MAX_FILE_CHARS, normalize, config, globRe, denied, atSuggestable, quietEnd, contextAt,
  typeThrough, nextWordLength, nextLineLength, trimLineSuffix, proseFile, blockCut, clean, Health, template, request, warmup, show, modelInfo,
  chatModel, missingText, chatHint, reply, failure, post, postStream, HOSTED, apiKey, keyHelp, maskKey, saveKey, removeKey, cacheKey, cost,
  usageFile, today, usageOf, recordUsage, percentile, usageText };

// ---------- the Settings dialog's helper: node inline.cjs <command> <provider> … (a key is never an argument) ----------
// --key P: {from, masked} | {from: null, help}; --save-key P <file>: stores the key the file holds, deletes the file;
// --remove-key P; --test P [model] [endpoint]: one short FIM request, {ok, ms} | {ok: false, error};
// --models P [endpoint]: {models, recommended} (Ollama's pulled models from /api/tags, base ones recommended).
const CATALOG = { codestral: ["codestral-latest", "codestral-2508"], deepseek: ["deepseek-flash"], mercury: ["mercury-edit-2"] };
async function cli([cmd, provider, ...args]) {
  if (!PROVIDERS.includes(provider) || provider === "off") throw new Error(`unknown provider: ${provider}`);
  const cfg = config(normalize({ [P + "provider"]: provider, [P + "model"]: args[0] ?? "", [P + "endpoint"]: (cmd === "--models" ? args[0] : args[1]) ?? "", [P + "multiline"]: false, [P + "maxTokens"]: 16 }));
  if (cmd === "--models") {
    if (provider !== "ollama") return { models: CATALOG[provider], recommended: [MODELS[provider]] };
    const { json } = await post({ url: `${cfg.endpoint}/api/tags`, method: "GET", headers: {} }).catch(() => ({ json: null }));
    const pulled = (json?.models ?? []).map(m => m.name).filter(Boolean);
    return { models: [...new Set([MODELS.ollama, ...pulled])], recommended: [...new Set([MODELS.ollama, ...pulled.filter(m => /base/i.test(m) && template(m))])], pulled };
  }
  if (!cfg.hosted) throw new Error(`${cfg.label} needs no API key`);
  if (cmd === "--key") { const k = apiKey(provider); return k.key ? { from: k.from, masked: maskKey(k.key) } : { from: null, help: keyHelp(provider), loose: k.loose }; }
  if (cmd === "--save-key") {
    const file = args[0], key = fs.readFileSync(file, "utf8").trim();
    fs.rmSync(file, { force: true });
    try { fs.rmdirSync(path.dirname(file)); } catch {}
    return { from: saveKey(provider, key), masked: maskKey(key) };
  }
  if (cmd === "--remove-key") { removeKey(provider); return { removed: true }; }
  if (cmd === "--test") {
    const k = apiKey(provider);
    if (!k.key) return { ok: false, error: keyHelp(provider) };
    const t0 = Date.now();
    try {
      const { status, json } = await post(request(cfg, { prefix: "def add(a, b):\n    return", suffix: "\n", file: "test.py" }, false, k.key));
      reply(cfg, status, json);
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) { return { ok: false, error: failure(cfg, e) }; }
  }
  throw new Error(`unknown command: ${cmd}`);
}
if (require.main === module) {
  cli(process.argv.slice(2)).then(o => process.stdout.write(JSON.stringify(o) + "\n"),
    e => { process.stdout.write(JSON.stringify({ error: e.message }) + "\n"); process.exitCode = 1; });
}
