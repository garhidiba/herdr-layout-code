// Pure rules for <herdr home>/vscode-settings.json (shared with the terminal editor's settings.cjs and the viewer):
// defaults, valid ranges, read-modify-write that keeps unknown keys. No I/O except through the `io` passed in.

export const FILE = "vscode-settings.json";

export const DEFAULTS = {
  "core.engine": "js",                // "js" | "rust" (the Rust core in <herdr home>/vscode-core/)
  "files.autoSave": "off",            // "off" | "afterDelay" | "onFocusChange"
  "files.autoSaveDelay": 1,           // seconds (VS Code uses milliseconds), 0.1-3600
  "files.trimTrailingWhitespace": false,
  "files.insertFinalNewline": false,
  "editor.formatOnSave": false,
  "editor.tabSize": 4,                // 1-16, for files without indentation to detect
  "editor.insertSpaces": true,
  "editor.cursorStyle": "line",       // the terminal editor's cursor shape; thin variants draw like the plain ones
  "editor.cursorBlinking": "blink",   // "solid" is steady, the others blink
  "editor.inlineSuggest.provider": "ollama", // the editor's inline suggestions (mods/vscode-viewer/editor/inline.cjs)
  "editor.inlineSuggest.model": "",          // "": the provider's default
  "editor.wordWrap": "off",           // "off" | "on" | "wordWrapColumn" | "bounded" (mods/vscode-viewer/editor/wrap.cjs)
  "editor.wordWrapColumn": 80,        // 1-500
  "editor.wrappingIndent": "same",    // "none" | "same" | "indent" | "deepIndent"
  "explorer.autoReveal": true,        // the Explorer reveals and highlights the active editor's file (vscode-explorer)
  "workbench.editor.preloadEditor": true, // each local space keeps an editor started off screen, so a file opens at once (vscode-explorer warm.js)
};
export const CHOICES = { "core.engine": ["js", "rust"], "editor.engine": ["js", "rust"], "files.autoSave": ["off", "afterDelay", "onFocusChange"],
  "editor.inlineSuggest.provider": ["ollama", "lmstudio", "codestral", "mercury", "off"],
  "editor.cursorStyle": ["line", "block", "underline", "line-thin", "underline-thin", "block-outline"],
  "editor.cursorBlinking": ["blink", "smooth", "phase", "expand", "solid"],
  "editor.wordWrap": ["off", "on", "wordWrapColumn", "bounded"], "editor.wrappingIndent": ["none", "same", "indent", "deepIndent"] };
// editor.inlineSuggest.enabled: absent, the editor turns suggestions on when the provider can run there (Ollama
// installed); the dialog shows that as on, and Reset to defaults removes the key again.
const INLINE_ENABLED = "editor.inlineSuggest.enabled";
// Inline keys present only when set (absent: the provider's default; Reset to defaults removes them): the shared server
// address and each provider's own model and address, which win over the shared ones (inline.cjs).
const PROVIDER = "editor.inlineSuggest.provider";
// Inline suggestion providers no longer offered, read as "off" so another one gets picked (DeepSeek: its request limits).
const RETIRED = ["deepseek"];
export const ownKey = (provider, k) => `editor.inlineSuggest.${provider}.${k}`;
function optional(key) {
  const m = /^editor\.inlineSuggest\.(?:(\w+)\.)?(model|endpoint)$/.exec(key);
  return m && (!m[1] || (m[1] !== "off" && CHOICES[PROVIDER].includes(m[1]))) && !(key in DEFAULTS) ? m[2] : null;
}
const NUMBERS = { "files.autoSaveDelay": [0.1, 3600, false], "editor.tabSize": [1, 16, true], "editor.wordWrapColumn": [1, 500, true] }; // [min, max, integer]

// VS Code settings files allow comments and trailing commas (same rule as the editor's highlight.cjs `loose`).
export const loose = (s) => JSON.parse(s.replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));

// File text -> raw object. Missing/empty file -> {}; text that isn't a JSON object throws (never overwrite it).
export function parse(text) {
  if (text == null || !text.trim()) return {};
  const o = loose(text);
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("vscode-settings.json is not a JSON object");
  return o;
}

// A known setting's value made valid, or undefined when it can't be (wrong type, not a number, unknown choice).
export function coerce(key, value) {
  if (key === PROVIDER && RETIRED.includes(value)) return "off";
  const opt = optional(key);
  if (opt) return typeof value === "string" && (opt !== "endpoint" || !endpointProblem(value)) ? value.trim().replace(/\/+$/, "") : undefined;
  if (key === INLINE_ENABLED) return typeof value === "boolean" ? value : undefined;
  if (CHOICES[key]) return CHOICES[key].includes(value) ? value : undefined;
  if (NUMBERS[key]) {
    const [lo, hi, int] = NUMBERS[key], n = Number(value);
    if (value == null || value === "" || typeof value === "boolean" || !Number.isFinite(n) || (int && !Number.isInteger(n))) return undefined;
    return Math.round(Math.max(lo, Math.min(hi, n)) * 1000) / 1000;
  }
  if (typeof DEFAULTS[key] === "boolean") return typeof value === "boolean" ? value : undefined;
  if (typeof DEFAULTS[key] === "string") return typeof value === "string" ? value.trim() : undefined;
  return value;
}

// A server address the editor can ask: "" (the provider's default) or http(s)://host[:port][/path], on this machine or
// another one. -> what is wrong with it, or null.
export function endpointProblem(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return "Start the address with http:// or https://, e.g. http://192.168.0.10:11434";
  const m = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(\/[^\s?#]*)?$/i.exec(s);
  if (!m) return "Not a server address: http://host:port";
  if (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return "The port is 1–65535";
  return null;
}
// raw switched to another provider: the shared model and address (which the previous provider used) move to its own
// keys, so they don't follow the switch.
export function withProvider(raw, provider) {
  const old = raw[PROVIDER] ?? DEFAULTS[PROVIDER];
  if (old === provider) return withSetting(raw, PROVIDER, provider);
  const next = { ...raw };
  for (const k of ["model", "endpoint"]) {
    const shared = `editor.inlineSuggest.${k}`, value = coerce(shared, raw[shared]);
    if (value && optional(ownKey(old, k)) && !coerce(ownKey(old, k), raw[ownKey(old, k)])) next[ownKey(old, k)] = value;
    delete next[shared];
  }
  return withSetting({ ...next, "editor.inlineSuggest.model": "" }, PROVIDER, provider);
}
// raw with the provider's own model / address set ("": its default); the shared one goes, as it no longer applies.
export const withOwn = (raw, provider, k, value) => {
  const { [`editor.inlineSuggest.${k}`]: _, ...rest } = withSetting(raw, ownKey(provider, k), value);
  return k === "model" ? { ...rest, "editor.inlineSuggest.model": "" } : rest;
};
// The model / address in effect for a provider in normalized values: its own, else the shared one ("": the default).
export const ownValue = (v, provider, k) => v[ownKey(provider, k)] || v[`editor.inlineSuggest.${k}`] || "";

// ----- the Inline Suggestions rows (their data: `node mods/vscode-viewer/editor/inline.cjs --models / --key`) -----
export const HOSTED_PROVIDERS = ["codestral", "mercury"];
// Local servers: their default address (the Server row's placeholder).
export const LOCAL_PROVIDERS = { ollama: "http://127.0.0.1:11434", lmstudio: "http://127.0.0.1:1234" };
// The Model row's choices [value, label]: the provider's default first (value "": none in the file), the models it
// lists (Ollama: the pulled ones, base models recommended), and the file's model when it is none of them.
export function modelChoices(current, listed, provider) {
  const { models = [], recommended = [] } = listed ?? {};
  const def = defaultModel(listed);
  const tag = (m) => [recommended.includes(m) && m !== def && "recommended", modelStatus(provider, m, listed) === "missing" && "not installed"].filter(Boolean).join(", ");
  const label = (m, extra = []) => { const t = [...extra, tag(m)].filter(Boolean).join(", "); return t ? `${m} (${t})` : m; };
  const rows = def ? [["", label(def, ["default"])]] : [["", "Default"]];
  for (const m of models) if (m !== def) rows.push([m, label(m)]);
  if (current && current !== def && !models.includes(current)) rows.push([current, current]);
  return rows;
}
// Which choice the file's model picks (the default's own name picks the default).
export const chosenModel = (current, listed) => (current === defaultModel(listed) ? "" : current);
// The model the "" choice stands for.
export const defaultModel = (listed) => listed?.recommended?.[0] ?? listed?.models?.[0];
// Whether a local server's model name is this one: Ollama's `foo` is `foo:latest`; other names compare exactly.
const sameModel = (provider, a, b) => a === b || (provider === "ollama" && a.replace(/:latest$/, "") === b.replace(/:latest$/, ""));
// A model on a local server (`listed.pulled`: its models, null when it didn't answer): "ok", "missing", "unreachable",
// or null when unknown (still listing, the listing failed, or a hosted provider's catalog).
export function modelStatus(provider, model, listed) {
  if (!model || !listed || listed.error || listed.pulled === undefined) return null;
  if (!Array.isArray(listed.pulled)) return "unreachable";
  return listed.pulled.some((m) => sameModel(provider, m, model)) ? "ok" : "missing";
}
// How to get a model the server doesn't have.
export const installHint = (provider, model) =>
  provider === "lmstudio" ? `Download ${model} in LM Studio and load it.` : `Run: ollama pull ${model}`;
// The note under the Model field for a model (the typed one, else the file's or the default): null when it is there
// or not known yet.
export function modelWarning(provider, model, listed) {
  const s = modelStatus(provider, model, listed);
  return s === "missing" ? `Not on this server. ${installHint(provider, model)}` : s === "unreachable" ? "Server unreachable: cannot check the model." : null;
}
// The API Key row's line from `inline.cjs --key` (a stored key shows only its ends); optional: a local server's key,
// none being the usual case.
export function keyLine(r, optional = false) {
  if (!r) return "Checking for a key…";
  if (r.error) return `Cannot check the key: ${r.error}`;
  if (r.from === "keychain") return `Saved in the macOS keychain: ${r.masked}`;
  if (r.from === "file") return `Saved in vscode-secrets.json (mode 600): ${r.masked}`;
  if (r.from === "env") return `From the environment: ${r.masked}. Editors Herdr opens may not see it; save it here.`;
  return `${optional ? "No key (none needed unless the server asks for one)" : "No key yet"}${r.loose ? " (vscode-secrets.json is readable by others: chmod 600 it)" : ""}. Paste it and Save: it goes to the macOS keychain (elsewhere vscode-secrets.json, mode 600), never to settings.json.`;
}

// vsedit.sh's RUST_READY: the Rust editor has every JS editor feature, so without "editor.engine" it follows the core.
const RUST_EDITOR_READY = true;

// Raw object -> every known setting with a valid value (invalid or missing ones are the default), plus the editor's
// engine in effect.
export function normalize(raw = {}) {
  const v = {};
  for (const k of Object.keys(DEFAULTS)) v[k] = coerce(k, raw[k]) ?? DEFAULTS[k];
  v["editor.engine"] = coerce("editor.engine", raw["editor.engine"]) ?? (RUST_EDITOR_READY ? v["core.engine"] : "js");
  v[INLINE_ENABLED] = coerce(INLINE_ENABLED, raw[INLINE_ENABLED]) ?? true;
  for (const k of Object.keys(raw)) if (optional(k) && coerce(k, raw[k]) !== undefined) v[k] = coerce(k, raw[k]);
  return v;
}

// The engine the mods should use: "js" unless the file says "rust". The one reader other mods may copy.
export const coreEngine = (raw) => normalize(raw)["core.engine"];
// The terminal editor's engine, as mods/vscode-viewer/editor/vsedit.sh picks it: "editor.engine" when set, else the core's.
export const editorEngine = (raw) => normalize(raw)["editor.engine"];

// raw with key set to a valid value (throws on an invalid one); the other keys, known or not, are kept.
export function withSetting(raw, key, value) {
  const v = coerce(key, value);
  if (v === undefined) throw new Error(`Invalid value for ${key}`);
  return { ...raw, [key]: v };
}

// raw with every known setting back to its default (the editor's engine follows the core's again); unknown keys are kept.
export const withDefaults = ({ "editor.engine": _, [INLINE_ENABLED]: __, ...raw }) =>
  ({ ...Object.fromEntries(Object.entries(raw).filter(([k]) => !optional(k))), ...DEFAULTS });

export const serialize = (raw) => JSON.stringify(raw, null, 2) + "\n";

// Read-modify-write: io.read() -> text|null, io.write(text, expected) rejects when the file changed since `expected`.
// One retry after re-reading when a concurrent edit wins the race. Resolves with what was written. `fromText` throws
// on a file it can't read, so it is never overwritten.
export async function rewrite(io, change, fromText = parse, toText = serialize) {
  for (let attempt = 0; ; attempt++) {
    const text = await io.read();
    const next = change(fromText(text));
    try { await io.write(toText(next), text ?? null); return next; }
    catch (e) { if (attempt >= 1) throw e; }
  }
}
// rewrite of vscode-settings.json; resolves with the normalized values written.
export const updateFile = async (io, change) => normalize(await rewrite(io, change));

// The page the dialog opens on: the editor's request in <herdr home>/.vscode-settings-page ({ page, at }) when it is
// fresh (the editor writes it just before mod.open), else "settings".
export const PAGE_FILE = ".vscode-settings-page";
export function requestedPage(text, now) {
  try { const r = JSON.parse(text); if (r?.page === "keybindings" && now - r.at < 10000) return "keybindings"; } catch {}
  return "settings";
}

// − / + on the auto save delay: tenths below one second, whole seconds above.
export function stepDelay(value, dir) {
  const n = Number(value) || DEFAULTS["files.autoSaveDelay"];
  const step = n < 1 || (dir < 0 && n <= 1) ? 0.1 : 1;
  return coerce("files.autoSaveDelay", Math.round((n + dir * step) * 10) / 10);
}

// The vscode-core major version the explorer and source control accept (CORE_API in their core.js).
export const CORE_API = 1;
const coreVersion = (stdout) => stdout?.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? null;
// True when `vscode-core --version` output is a version the mods use.
export const coreCurrent = (stdout) => Number.parseInt(coreVersion(stdout)) === CORE_API;

// `vscode-core --version` output -> "built (v1.0.0)"-style status; null output means not built.
export function coreStatus(stdout) {
  if (stdout == null) return "Rust core: not built";
  const v = coreVersion(stdout);
  if (v && !coreCurrent(stdout)) return `Rust core: v${v} is out of date (rebuild it)`;
  return `Rust core: built${v ? ` (v${v})` : ""}`;
}

// The launch contract of the Rust editor that mods/vscode-viewer/editor/vsedit.sh accepts (its API, `vsedit --api`).
export const EDITOR_API = 2;
// True when `vsedit --version` output ("vsedit 1.0.0 (api 1)") is a binary the launcher runs.
export const editorCurrent = (stdout) => Number(stdout?.match(/\(api (\d+)\)/)?.[1]) === EDITOR_API;
// `vsedit --version` output -> its status; null output means not built.
export function editorStatus(stdout) {
  if (stdout == null) return "Rust editor: not built";
  const v = coreVersion(stdout);
  if (!editorCurrent(stdout)) return `Rust editor: ${v ? `v${v} ` : ""}is out of date (rebuild it)`;
  return `Rust editor: built${v ? ` (v${v})` : ""}`;
}
