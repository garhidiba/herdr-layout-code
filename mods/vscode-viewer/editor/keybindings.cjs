// User keybindings: <herdr home>/vscode-keybindings.json in VS Code's format, [{ "key": "cmd+shift+k", "command": "id" }],
// where "-id" removes a default (all of the command's defaults without "key", else the one with that key). The defaults
// (commands.cjs) come first, then the user's entries in order; for a key, the last binding wins (VS Code's rules).
// `node keybindings.cjs --table [file]` prints the resolved table as JSON for the Keyboard Shortcuts dialog.
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./commands.cjs");
const { loose } = require("./highlight.cjs");

const keybindingsFile = () => process.env.VSEDIT_KEYBINDINGS
  ?? path.join(process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app"), "vscode-keybindings.json");

const MODS = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift", cmd: "cmd", meta: "cmd", win: "cmd", super: "cmd", command: "cmd" };
const NAMES = { esc: "escape", return: "enter", del: "delete" };

// A VS Code key ("Shift+Cmd+K", "ctrl+-") -> the editor's chord ("shift+cmd+k", "ctrl+-"); null when it can't be one
// (empty, a two-step chord like "cmd+k cmd+s", an unknown modifier).
function canon(key) {
  if (typeof key !== "string") return null;
  const s = key.trim().toLowerCase();
  if (!s || /\s/.test(s)) return null;
  const { mods, name } = C.split(s), m = mods.map(x => MODS[x]);
  if (m.some(x => !x)) return null;
  return C.normalize([...m, NAMES[name] ?? name].join("+"));
}

// User entries (the file's array) -> the keymap: { bindings: [{ key, command, source: "default" | "user" }] (in order),
// byChord: Map chord -> command id (the last binding wins), label(id) (the key shown in menus, "" when none) }.
// Entries that aren't { key?, command } objects, or whose key can't be read, are skipped.
function resolve(user = []) {
  let bindings = C.COMMANDS.flatMap(c => c.chords.map(ch => ({ key: C.normalize(ch), command: c.id, source: "default" })));
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
  // A key still running this command; the user's newest one first, else the first default (the macOS one).
  const label = (id) => {
    const live = bindings.filter(b => b.command === id && byChord.get(b.key) === id);
    const b = live.filter(x => x.source === "user").pop() ?? live[0];
    return b ? C.label(b.key) : "";
  };
  return { bindings, byChord, label };
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
  process.stdout.write(JSON.stringify({ file, error, rows: table(keymap) }) + "\n");
}

module.exports = { keybindingsFile, canon, resolve, parseText, load, live, table };
