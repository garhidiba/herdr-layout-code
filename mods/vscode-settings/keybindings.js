// Pure rules for the Keyboard Shortcuts page: key spellings (VS Code "shift+cmd+k" or the chord "ctrl+k ctrl+c", Herdr/GPUI
// "cmd-shift-k", and the editor's key "shift+cmd+k" that both map to), labels in the OS's style, edits of
// <herdr home>/vscode-keybindings.json that keep every other entry, and whether Herdr lets a key reach the editor
// (keys.json's "terminal" passthrough, step by step for a chord). Which binding wins, and for which OS, is the editor's
// rule (mods/vscode-viewer/editor/keybindings.cjs, whose `--table` gives the rows and the OS); keys here match its form.

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
// One keystroke ("shift+cmd+k" with sep "+") -> the editor's form, or null.
function step(s, sep) {
  const { mods, name } = split(s, sep), m = mods.map(x => MODS[x]);
  if (!name || m.some(x => !x)) return null;
  return ORDER.filter(o => m.includes(o)).map(o => o + "+").join("") + (NAMES[name] ?? name);
}
// A key of one or two steps ("cmd+k cmd+s") -> the editor's form, or null (empty, three steps, unknown modifier).
function chord(s, sep) {
  if (typeof s !== "string") return null;
  const steps = s.trim().toLowerCase().split(/\s+/).map(x => step(x, sep));
  return steps[0] && steps.length <= 2 && steps.every(Boolean) ? steps.join(" ") : null;
}
const steps = (c) => c.split(" ");

// VS Code key (a chord too) -> the editor's key, or null.
export const canon = (key) => chord(key, "+");
// Herdr / GPUI keystroke ("cmd-shift-d", what on_key_down reports; win/super are the same key as cmd) -> key, or null.
export const fromHerdr = (keystroke) => (typeof keystroke === "string" && !/\s/.test(keystroke.trim()) ? chord(keystroke, "-") : null);
// Key -> Herdr's spelling for keys.json (each step of a chord).
export const toHerdr = (c) => steps(c).map((s) => {
  const { mods, name } = split(s, "+");
  return [...HERDR_ORDER.filter(m => mods.includes(m)), name].join("-");
}).join(" ");

// The recorder's key after another keystroke: a second keystroke makes a chord (VS Code's Define Keybinding), a third
// starts over.
export const recordStep = (prev, keystroke) => (prev && !prev.includes(" ") ? `${prev} ${keystroke}` : keystroke);

// Key -> its label as VS Code shows it on that OS (the editor's commands.cjs label): macOS glyphs "⇧⌘K", "⌘K ⌘J";
// Windows / Linux text "Ctrl+Shift+K", "Ctrl+K Ctrl+J" (⌘ is the Windows / Super key).
const GLYPHS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const MAC_KEYS = { up: "↑", down: "↓", left: "←", right: "→", enter: "↩", backspace: "⌫", delete: "⌦", tab: "⇥", escape: "Escape",
  pageup: "PageUp", pagedown: "PageDown", space: "Space", home: "Home", end: "End", insert: "Insert" };
const TEXT_KEYS = { up: "UpArrow", down: "DownArrow", left: "LeftArrow", right: "RightArrow", enter: "Enter", backspace: "Backspace",
  delete: "Delete", tab: "Tab", escape: "Escape", pageup: "PageUp", pagedown: "PageDown", space: "Space", home: "Home", end: "End", insert: "Insert" };
const capital = (name) => name.charAt(0).toUpperCase() + name.slice(1);
export function label(c, os = "mac") {
  if (!c) return "";
  return steps(c).map((s) => {
    const { mods, name } = split(s, "+");
    if (os === "mac") return mods.map(m => GLYPHS[m]).join("") + (MAC_KEYS[name] ?? capital(name));
    const text = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: os === "win" ? "Windows" : "Super" };
    return [...["ctrl", "shift", "alt", "cmd"].filter(m => mods.includes(m)).map(m => text[m]), TEXT_KEYS[name] ?? capital(name)].join("+");
  }).join(" ");
}

// Search: the query in the title, id or key (as typed, as the OS's label, or as a key spelled in any order).
export function matchesRow(row, query, os = "mac") {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.title, row.id, row.key, label(row.key, os)].some(s => s.toLowerCase().includes(q)) || (!!row.key && canon(q) === row.key);
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

// Does the key reach a terminal program (the editor)? bindings: Herdr's keys() for this OS, [{ section, keys, action }].
// "terminal" in the terminal section passes it; a global, layout or terminal action takes it first; ⌘ (Windows / Super)
// keys nobody binds don't reach programs either. A chord passes when both its keystrokes do. `loses`: what passing it
// takes from every terminal.
export function herdrRoute(bindings, c) {
  let passes = true;
  const loses = [];
  for (const s of steps(c)) {
    const hits = bindings.filter(b => fromHerdr(b.keys) === s && (b.section === "terminal" || b.section === "global" || b.section.startsWith("layout:")));
    const passed = hits.some(b => b.section === "terminal" && b.action === "terminal");
    const taken = hits.filter(b => b.action !== "terminal").map(({ section, action }) => ({ section, action }));
    passes &&= passed || (!taken.length && !split(s, "+").mods.includes("cmd"));
    loses.push(...taken);
  }
  return { passes, loses };
}

// keys.json object with the key (each keystroke of a chord) passed to terminal programs; other sections and keys kept,
// another spelling of the same keystroke in "terminal" replaced.
export function withPassthrough(keys, c) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("keys.json is not a JSON object");
  let terminal = { ...(keys.terminal ?? {}) };
  for (const s of steps(c)) terminal = { ...Object.fromEntries(Object.entries(terminal).filter(([k]) => fromHerdr(k) !== s)), [toHerdr(s)]: "terminal" };
  return { ...keys, terminal };
}
