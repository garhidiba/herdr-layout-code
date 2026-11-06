// User settings: <herdr home>/vscode-settings.json, VS Code names and meanings, except files.autoSaveDelay is in seconds.
// Missing file -> created with the defaults. Unknown keys are kept when a setting is written back.
const fs = require("fs");
const os = require("os");
const path = require("path");
const F = require("./file.cjs");
const { loose } = require("./highlight.cjs");

const DEFAULTS = {
  "files.autoSave": "off",            // "off" | "afterDelay" | "onFocusChange"
  "files.autoSaveDelay": 1,           // seconds (VS Code uses milliseconds), 0.1-3600
  "editor.tabSize": 4,                // for files without indentation to detect
  "editor.insertSpaces": true,
  "editor.formatOnSave": false,
  "files.trimTrailingWhitespace": false,
  "files.insertFinalNewline": false,
};
const AUTO_SAVE = ["off", "afterDelay", "onFocusChange"];

const settingsFile = () => process.env.VSEDIT_SETTINGS
  ?? path.join(process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app"), "vscode-settings.json");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// Raw object -> every setting with a valid value (invalid ones fall back to the default).
function normalize(raw = {}) {
  const v = { ...DEFAULTS };
  if (AUTO_SAVE.includes(raw["files.autoSave"])) v["files.autoSave"] = raw["files.autoSave"];
  const d = Number(raw["files.autoSaveDelay"]);
  if (raw["files.autoSaveDelay"] != null && Number.isFinite(d)) v["files.autoSaveDelay"] = clamp(d, 0.1, 3600);
  const t = Number(raw["editor.tabSize"]);
  if (Number.isInteger(t)) v["editor.tabSize"] = clamp(t, 1, 16);
  for (const k of ["editor.insertSpaces", "editor.formatOnSave", "files.trimTrailingWhitespace", "files.insertFinalNewline"])
    if (typeof raw[k] === "boolean") v[k] = raw[k];
  return v;
}

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

module.exports = { DEFAULTS, settingsFile, normalize, load, update, autoSaveLabel };
