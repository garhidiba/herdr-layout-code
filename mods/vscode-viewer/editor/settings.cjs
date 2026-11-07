// User settings: <herdr home>/vscode-settings.json, VS Code names and meanings, except files.autoSaveDelay is in seconds.
// Missing file -> created with the defaults. Unknown keys are kept when a setting is written back.
const fs = require("fs");
const os = require("os");
const path = require("path");
const F = require("./file.cjs");
const { loose } = require("./highlight.cjs");
const I = require("./inline.cjs");

const DEFAULTS = {
  "files.autoSave": "off",            // "off" | "afterDelay" | "onFocusChange"
  "files.autoSaveDelay": 1,           // seconds (VS Code uses milliseconds), 0.1-3600
  "editor.tabSize": 4,                // for files without indentation to detect
  "editor.insertSpaces": true,
  "editor.formatOnSave": false,
  "files.trimTrailingWhitespace": false,
  "files.insertFinalNewline": false,
  "breadcrumbs.enabled": true,       // the top line's folders and the symbols at the cursor
  "editor.hover.enabled": true,      // the hover after the pointer rests 300 ms on a word
  "extensions.ignoreRecommendations": false, // true: no status bar offer to install a missing language server
  "editor.codeLens": true,           // "N references" above declarations while a language server runs
  "editor.find.seedSearchStringFromSelection": "always", // "never" | "always" (the word at the cursor too) | "selection"
  "editor.find.autoFindInSelection": "never",            // "never" | "always" | "multiline"
  "editor.cursorStyle": "line",       // VS Code's values; see cursorSeq
  "editor.cursorBlinking": "blink",   // "blink" | "smooth" | "phase" | "expand" | "solid"
  "editor.wordWrap": "off",          // "off" | "on" (the window's width) | "wordWrapColumn" | "bounded" (the smaller of both)
  "editor.wordWrapColumn": 80,       // 1-500
  "editor.wrappingIndent": "same",   // continuation rows: "none" | "same" | "indent" | "deepIndent"
};
const CURSOR_STYLE = { line: 5, "line-thin": 5, block: 1, "block-outline": 1, underline: 3, "underline-thin": 3 }; // DECSCUSR: blinking; +1 is steady
const CURSOR_BLINKING = ["blink", "smooth", "phase", "expand", "solid"];
const SEED = ["never", "always", "selection"], AUTO_IN_SELECTION = ["never", "always", "multiline"];
const AUTO_SAVE = ["off", "afterDelay", "onFocusChange"];
const { MODES: WRAP, INDENTS: WRAP_INDENT } = require("./wrap.cjs");

const settingsFile = () => process.env.VSEDIT_SETTINGS
  ?? path.join(process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app"), "vscode-settings.json");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// Raw object -> every setting with a valid value (invalid ones fall back to the default), the inline suggestion ones
// (editor.inlineSuggest.*, inline.cjs) included; those aren't written into a new file.
function normalize(raw = {}) {
  const v = { ...DEFAULTS, ...I.normalize(raw) };
  if (AUTO_SAVE.includes(raw["files.autoSave"])) v["files.autoSave"] = raw["files.autoSave"];
  const d = Number(raw["files.autoSaveDelay"]);
  if (raw["files.autoSaveDelay"] != null && Number.isFinite(d)) v["files.autoSaveDelay"] = clamp(d, 0.1, 3600);
  const t = Number(raw["editor.tabSize"]);
  if (Number.isInteger(t)) v["editor.tabSize"] = clamp(t, 1, 16);
  for (const k of ["editor.insertSpaces", "editor.formatOnSave", "files.trimTrailingWhitespace", "files.insertFinalNewline", "breadcrumbs.enabled", "editor.hover.enabled", "extensions.ignoreRecommendations", "editor.codeLens"])
    if (typeof raw[k] === "boolean") v[k] = raw[k];
  if (SEED.includes(raw["editor.find.seedSearchStringFromSelection"])) v["editor.find.seedSearchStringFromSelection"] = raw["editor.find.seedSearchStringFromSelection"];
  if (AUTO_IN_SELECTION.includes(raw["editor.find.autoFindInSelection"])) v["editor.find.autoFindInSelection"] = raw["editor.find.autoFindInSelection"];
  if (raw["editor.cursorStyle"] in CURSOR_STYLE) v["editor.cursorStyle"] = raw["editor.cursorStyle"];
  if (CURSOR_BLINKING.includes(raw["editor.cursorBlinking"])) v["editor.cursorBlinking"] = raw["editor.cursorBlinking"];
  if (WRAP.includes(raw["editor.wordWrap"])) v["editor.wordWrap"] = raw["editor.wordWrap"];
  if (WRAP_INDENT.includes(raw["editor.wrappingIndent"])) v["editor.wrappingIndent"] = raw["editor.wrappingIndent"];
  // VS Code's workbench.statusBar.visible (not written into a new file): false hides the status bar (vscode-memo's).
  v["workbench.statusBar.visible"] = raw["workbench.statusBar.visible"] !== false;
  const wc = Number(raw["editor.wordWrapColumn"]);
  if (Number.isInteger(wc)) v["editor.wordWrapColumn"] = clamp(wc, 1, 500);
  return v;
}

// DECSCUSR for the cursor settings. Terminals have no thin variants, so line-thin is the bar and underline-thin the
// underline; only "solid" is steady, every other blinking value blinks.
const cursorSeq = (v) => `\x1b[${CURSOR_STYLE[v["editor.cursorStyle"]] + (v["editor.cursorBlinking"] === "solid" ? 1 : 0)} q`;

function readRaw(file) {
  try { const o = loose(fs.readFileSync(file, "utf8")); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

// { values, stamp } — creates the file with the defaults when it doesn't exist.
function load(file = settingsFile()) {
  if (!fs.existsSync(file)) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); F.save(file, JSON.stringify(DEFAULTS, null, 2) + "\n"); } catch {} }
  let stamp = null;
  try { const st = fs.statSync(file); stamp = { mtimeMs: st.mtimeMs, size: st.size }; } catch {}
  return { values: normalize(readRaw(file)), stamp };
}

// Writes one setting, keeping the file's other keys (comments are not kept).
function update(key, value, file = settingsFile()) {
  const raw = readRaw(file);
  raw[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  F.save(file, JSON.stringify(raw, null, 2) + "\n");
  return load(file);
}

const seconds = (s) => `${Number(s.toFixed(3))}s`;
// "Auto Save: after 1s" / "Auto Save: on focus change" / "Auto Save: off"
function autoSaveLabel(v) {
  const m = v["files.autoSave"];
  return m === "afterDelay" ? `Auto Save: after ${seconds(v["files.autoSaveDelay"])}` : m === "onFocusChange" ? "Auto Save: on focus change" : "Auto Save: off";
}

module.exports = { DEFAULTS, settingsFile, normalize, cursorSeq, load, update, autoSaveLabel };
