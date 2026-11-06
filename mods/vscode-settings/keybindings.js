// Pure rules for the Keyboard Shortcuts page: key spellings (VS Code "shift+cmd+k", Herdr/GPUI "cmd-shift-k", and the
// editor's chord "shift+cmd+k" that both map to), edits of <herdr home>/vscode-keybindings.json that keep every other
// entry, and whether Herdr lets a key reach the editor (keys.json's "terminal" passthrough). Which binding wins is the
// editor's rule (mods/vscode-viewer/editor/keybindings.cjs, whose `--table` the page shows); chords here match its form.

export const FILE = "vscode-keybindings.json";

const ORDER = ["ctrl", "alt", "shift", "cmd"];          // the editor's chord order (commands.cjs chordOf)
const HERDR_ORDER = ["ctrl", "cmd", "alt", "shift"];    // how keys.json spells them ("cmd-shift-z", "ctrl-shift--")
const MODS = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift", cmd: "cmd", meta: "cmd", win: "cmd", super: "cmd", command: "cmd" };
const NAMES = { esc: "escape", return: "enter", del: "delete" };

// "a+b+k" -> { mods: ["a", "b"], name: "k" }; the key itself may be the separator ("ctrl--", "ctrl++").
function split(s, sep) {
  const i = s.length > 1 ? s.lastIndexOf(sep, s.length - 2) : -1;
  return { mods: i < 0 ? [] : s.slice(0, i).split(sep), name: s.slice(i + 1) };
}
function chord(s, sep) {
  if (typeof s !== "string") return null;
  s = s.trim().toLowerCase();
  if (!s || /\s/.test(s)) return null; // two-step chords ("cmd+k cmd+s") aren't supported
  const { mods, name } = split(s, sep), m = mods.map(x => MODS[x]);
  if (m.some(x => !x)) return null;
  return ORDER.filter(o => m.includes(o)).map(o => o + "+").join("") + (NAMES[name] ?? name);
}

// VS Code key -> chord, or null.
export const canon = (key) => chord(key, "+");
// Herdr / GPUI keystroke ("cmd-shift-d", what on_key_down reports) -> chord, or null.
export const fromHerdr = (keystroke) => chord(keystroke, "-");
// Chord -> Herdr's spelling for keys.json.
export function toHerdr(c) {
  const { mods, name } = split(c, "+");
  return [...HERDR_ORDER.filter(m => mods.includes(m)), name].join("-");
}

// Chord -> macOS label in VS Code's glyphs (the editor's commands.cjs label): "shift+cmd+k" -> "⇧⌘K".
const GLYPHS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const KEY_GLYPHS = { up: "↑", down: "↓", left: "←", right: "→", enter: "↩", backspace: "⌫", delete: "⌦", tab: "⇥", escape: "Escape",
  pageup: "PageUp", pagedown: "PageDown", space: "Space" };
export function label(c) {
  if (!c) return "";
  const { mods, name } = split(c, "+");
  return mods.map(m => GLYPHS[m]).join("") + (KEY_GLYPHS[name] ?? name.charAt(0).toUpperCase() + name.slice(1));
}

// Search: the query in the title, id or key (as typed, as a glyph label, or as a key spelled in any order).
export function matchesRow(row, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.title, row.id, row.key, label(row.key)].some(s => s.toLowerCase().includes(q)) || (!!row.key && canon(q) === row.key);
}

// How many other rows already have this key (the recorder's "N existing commands have this keybinding").
export const conflicts = (rows, key, row) => rows.filter(r => r.key === key && r !== row && !(r.id === row?.id && r.key === row?.key)).length;

// ----- the user file: an array of { key, command } -----

// File text -> entries. Missing/empty -> []; anything but an array throws (never overwrite it).
export function parseFile(text, loose) {
  if (text == null || !text.trim()) return [];
  const v = loose(text);
  if (!Array.isArray(v)) throw new Error(`${FILE} is not a JSON array`);
  return v;
}
export const serializeFile = (entries) => JSON.stringify(entries, null, 2) + "\n";

const isEntry = (e, command, key) => !!e && typeof e === "object" && e.command === command && canon(e.key) === key;

// Row (from the table: { id, key, source }) bound to `key` instead. A user binding gets the new key; a default one is
// removed ("-id") and the new key added; a command without a key gets one.
export function withKey(entries, row, key) {
  if (key === row.key) return entries;
  if (row.source === "User") {
    let i = entries.length - 1;
    while (i >= 0 && !isEntry(entries[i], row.id, row.key)) i--;
    if (i >= 0) return entries.map((e, k) => (k === i ? { ...e, key } : e));
  }
  const removal = row.source === "Default" ? [{ key: row.key, command: `-${row.id}` }] : [];
  return [...entries, ...removal, { key, command: row.id }];
}

// Row without its key: a user binding is deleted, a default one removed with "-id".
export function withoutKey(entries, row) {
  if (!row.key) return entries;
  if (row.source === "User") return entries.filter(e => !isEntry(e, row.id, row.key));
  return [...entries, { key: row.key, command: `-${row.id}` }];
}

// The command back to its defaults: every user entry for it (bindings and removals) deleted.
export const withReset = (entries, id) => entries.filter(e => !(e && typeof e === "object" && (e.command === id || e.command === `-${id}`)));

// True when the file has an entry for this command (Reset to default has something to do).
export const hasUserEntries = (entries, id) => entries.length !== withReset(entries, id).length;

// ----- Herdr's keys -----

// Does the chord reach a terminal program (the editor)? bindings: Herdr's keys(), [{ section, keys, action }].
// "terminal" in the terminal section passes it; a global, layout or terminal action takes it first; ⌘ keys
// nobody binds don't reach programs either. `loses`: what passing it takes from every terminal.
export function herdrRoute(bindings, c) {
  const hits = bindings.filter(b => fromHerdr(b.keys) === c && (b.section === "terminal" || b.section === "global" || b.section.startsWith("layout:")));
  const passed = hits.some(b => b.section === "terminal" && b.action === "terminal");
  const loses = hits.filter(b => b.action !== "terminal").map(({ section, action }) => ({ section, action }));
  return { passes: passed || (!loses.length && !split(c, "+").mods.includes("cmd")), loses };
}

// keys.json object with the chord passed to terminal programs; other sections and keys kept, another spelling of the
// same key in "terminal" replaced.
export function withPassthrough(keys, c) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("keys.json is not a JSON object");
  const terminal = Object.fromEntries(Object.entries(keys.terminal ?? {}).filter(([k]) => fromHerdr(k) !== c));
  return { ...keys, terminal: { ...terminal, [toHerdr(c)]: "terminal" } };
}
