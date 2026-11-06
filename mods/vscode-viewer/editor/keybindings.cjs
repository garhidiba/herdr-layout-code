// User keybindings: <herdr home>/vscode-keybindings.json in VS Code's format, [{ "key": "cmd+shift+k", "command": "id" }],
// written for this OS (as VS Code's own file is), two-step chords ("ctrl+k ctrl+c") included; `when` is ignored. "-id"
// removes a default (all of the command's defaults without "key", else the one with that key). This OS's defaults
// (commands.cjs, keymap.json) come first, then the user's entries in order; for a key, the last binding wins (VS Code's
// rules). `node keybindings.cjs --table [file]` prints the resolved table as JSON for the Keyboard Shortcuts dialog.
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./commands.cjs");
const { loose } = require("./highlight.cjs");

const keybindingsFile = () => process.env.VSEDIT_KEYBINDINGS
  ?? path.join(process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app"), "vscode-keybindings.json");

const MODS = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift", cmd: "cmd", meta: "cmd", win: "cmd", super: "cmd", command: "cmd" };
const NAMES = { esc: "escape", return: "enter", del: "delete" };

// A VS Code key ("Shift+Cmd+K", "ctrl+-", "ctrl+k ctrl+c") -> the editor's key ("shift+cmd+k", "ctrl+-",
// "ctrl+k ctrl+c"); null when it can't be one (empty, more than two steps, an unknown modifier).
function canon(key) {
  if (typeof key !== "string") return null;
  const steps = key.trim().toLowerCase().split(/\s+/);
  if (!steps[0] || steps.length > 2) return null;
  const out = [];
  for (const step of steps) {
    const { mods, name } = C.split(step), m = mods.map(x => MODS[x]);
    if (!name || m.some(x => !x)) return null;
    out.push([...m, NAMES[name] ?? name].join("+"));
  }
  return C.normalize(out.join(" "));
}

// User entries (the file's array) -> the keymap of an OS: { os, bindings: [{ key, command, source: "default" | "user" }]
// (in order), byChord: Map key -> command id (the last binding wins), prefixes: Set of the first steps of the two-step
// keys in effect, label(id) (the key shown in menus, "" when none), keyLabel(key) }.
// Entries that aren't { key?, command } objects, or whose key can't be read, are skipped.
function resolve(user = [], os = C.OS) {
  let bindings = C.defaults(os).map(b => ({ ...b, source: "default" }));
  for (const e of Array.isArray(user) ? user : []) {
    if (!e || typeof e !== "object" || typeof e.command !== "string" || !e.command.replace(/^-/, "")) continue;
    const key = e.key == null ? null : canon(e.key);
    if (e.key != null && !key) continue;
    if (e.command.startsWith("-")) {
      const id = e.command.slice(1);
      bindings = bindings.filter(b => b.command !== id || (key !== null && b.key !== key));
    } else if (key) bindings.push({ key, command: e.command, source: "user" });
  }
  const byChord = new Map(bindings.map(b => [b.key, b.command]));
  const prefixes = new Set([...byChord.keys()].filter(k => k.includes(" ")).map(k => k.split(" ")[0]));
  const keyLabel = (key) => C.label(key, os);
  // A key still running this command; the user's newest one first, else the command's first default.
  const label = (id) => {
    const live = bindings.filter(b => b.command === id && byChord.get(b.key) === id);
    const b = live.filter(x => x.source === "user").pop() ?? live[0];
    return b ? keyLabel(b.key) : "";
  };
  return { os, bindings, byChord, prefixes, label, keyLabel };
}

// File text -> { user (entries), error }. Missing or empty -> no entries; invalid -> no entries and the error.
function parseText(text) {
  if (text == null || !text.trim()) return { user: [], error: null };
  try {
    const v = loose(text);
    return Array.isArray(v) ? { user: v, error: null } : { user: [], error: "vscode-keybindings.json is not a JSON array" };
  } catch (e) { return { user: [], error: `vscode-keybindings.json: ${e.message}` }; }
}

function load(file = keybindingsFile()) {
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  const { user, error } = parseText(text);
  return { keymap: resolve(user), error };
}

const stampOf = (file) => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return null; } };
// The keymap of `file`, kept current by poll() (call it every 2s): true when the file changed and was read again.
function live(file = keybindingsFile()) {
  const kb = {
    file, stamp: undefined, keymap: null, error: null,
    poll() { const st = stampOf(file); if (st === kb.stamp) return false; kb.stamp = st; Object.assign(kb, load(file)); return true; },
  };
  kb.poll();
  return kb;
}

// The dialog's table: one row per binding in effect, then one per command left without a key.
// Row: { id, title, key (chord, "" when none), source: "Default" | "User" | "" }. Unknown user commands have title "".
function table(keymap) {
  const rows = [], seen = new Set();
  for (const c of C.COMMANDS) {
    const own = keymap.bindings.filter(b => b.command === c.id && keymap.byChord.get(b.key) === c.id);
    for (const b of own) rows.push({ id: c.id, title: c.title, key: b.key, source: b.source === "user" ? "User" : "Default" });
    if (!own.length) rows.push({ id: c.id, title: c.title, key: "", source: "" });
    seen.add(c.id);
  }
  for (const b of keymap.bindings)
    if (!seen.has(b.command) && keymap.byChord.get(b.key) === b.command) rows.push({ id: b.command, title: "", key: b.key, source: "User" });
  return rows;
}

if (require.main === module && process.argv[2] === "--table") {
  const file = process.argv[3] ?? keybindingsFile(), { keymap, error } = load(file);
  process.stdout.write(JSON.stringify({ file, error, os: keymap.os, rows: table(keymap) }) + "\n");
}

module.exports = { keybindingsFile, canon, resolve, parseText, load, live, table };
