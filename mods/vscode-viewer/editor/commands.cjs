// Editor commands: VS Code ids and titles, the default chords that run them (macOS first: its label is the command's
// `key`); the editor context menu; fuzzy filter. A command is { id, title, key (label of the first chord), chords,
// run (Editor method name), args?, cap? (language operation it needs) }. User keybindings: keybindings.cjs.

const C = (id, title, chords, run, extra = {}) => ({ id, title, key: chords[0] ? label(chords[0]) : "", chords, run, ...extra });

// Key event -> "ctrl+alt+shift+cmd+name".
const chordOf = (ev) => `${ev.ctrl ? "ctrl+" : ""}${ev.alt ? "alt+" : ""}${ev.shift ? "shift+" : ""}${ev.cmd ? "cmd+" : ""}${ev.name}`;
// "shift+cmd+k" -> { mods: ["shift", "cmd"], name: "k" }; the key itself may be "+" ("ctrl++").
const split = (chord) => {
  const i = chord.length > 1 ? chord.lastIndexOf("+", chord.length - 2) : -1;
  return { mods: i < 0 ? [] : chord.slice(0, i).split("+"), name: chord.slice(i + 1) };
};
// Chord strings are normalized to the same modifier order as chordOf.
const normalize = (chord) => {
  const { mods, name } = split(chord);
  return ["ctrl", "alt", "shift", "cmd"].filter(m => mods.includes(m)).map(m => m + "+").join("") + name;
};
// Normalized chord -> macOS label in VS Code's glyphs: "shift+cmd+k" -> "⇧⌘K", "alt+up" -> "⌥↑", "f12" -> "F12".
const GLYPHS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const KEY_GLYPHS = { up: "↑", down: "↓", left: "←", right: "→", enter: "↩", backspace: "⌫", delete: "⌦", tab: "⇥", escape: "Escape",
  pageup: "PageUp", pagedown: "PageDown", space: "Space" };
function label(chord) {
  const { mods, name } = split(normalize(chord));
  return mods.map(m => GLYPHS[m]).join("") + (KEY_GLYPHS[name] ?? name.charAt(0).toUpperCase() + name.slice(1));
}

const COMMANDS = [
  C("editor.action.revealDefinition", "Go to Definition", ["f12"], "goTo", { args: ["definition"], cap: "definition" }),
  C("editor.action.goToTypeDefinition", "Go to Type Definition", [], "goTo", { args: ["typeDefinition"], cap: "typeDefinition" }),
  C("editor.action.goToImplementation", "Go to Implementations", ["cmd+f12"], "goTo", { args: ["implementation"], cap: "implementation" }),
  C("editor.action.goToReferences", "Go to References", ["shift+f12"], "goTo", { args: ["references"], cap: "references" }),
  C("editor.action.peekDefinition", "Peek Definition", ["alt+f12"], "peekAt", { args: ["definition"], cap: "definition" }),
  C("editor.action.referenceSearch.trigger", "Peek References", [], "peekAt", { args: ["references"], cap: "references" }),
  C("editor.action.peekImplementation", "Peek Implementations", [], "peekAt", { args: ["implementation"], cap: "implementation" }),
  C("editor.action.peekTypeDefinition", "Peek Type Definition", [], "peekAt", { args: ["typeDefinition"], cap: "typeDefinition" }),
  C("references-view.findReferences", "Find All References", ["alt+shift+f12"], "findAll", { args: ["references"], cap: "references" }),
  C("references-view.findImplementations", "Find All Implementations", [], "findAll", { args: ["implementation"], cap: "implementation" }),
  C("references-view.showCallHierarchy", "Show Call Hierarchy", ["alt+shift+h"], "callHierarchy", { cap: "callHierarchy" }),
  C("editor.action.rename", "Rename Symbol", ["f2"], "renameSymbol", { cap: "rename" }),
  C("editor.action.changeAll", "Change All Occurrences", ["cmd+f2", "ctrl+f2"], "changeAll"),
  C("editor.action.formatDocument", "Format Document", ["alt+shift+f"], "formatDocument", { cap: "format" }),
  C("editor.action.refactor", "Refactor...", ["ctrl+shift+r"], "codeActions", { args: ["refactor"], cap: "refactor" }),
  C("editor.action.sourceAction", "Source Action...", [], "codeActions", { args: ["source"], cap: "source" }),
  C("editor.action.clipboardCutAction", "Cut", ["cmd+x", "ctrl+x"], "copy", { args: [true] }),
  C("editor.action.clipboardCopyAction", "Copy", ["cmd+c", "ctrl+c"], "copy", { args: [false] }),
  C("editor.action.clipboardPasteAction", "Paste", ["cmd+v", "ctrl+v"], "paste", { args: [undefined] }),
  C("workbench.action.showCommands", "Command Palette...", ["cmd+shift+p", "ctrl+shift+p", "f1"], "openPicker", { args: [">"] }),
  C("workbench.action.quickOpen", "Go to File...", ["cmd+p", "ctrl+p"], "openPicker", { args: [""] }),
  C("workbench.action.files.save", "File: Save", ["cmd+s", "ctrl+s"], "saveFile"),
  C("workbench.action.files.toggleAutoSave", "File: Toggle Auto Save", [], "toggleAutoSave"),
  C("workbench.action.files.setAutoSaveDelay", "File: Set Auto Save Delay…", [], "askAutoSaveDelay"),
  C("workbench.action.openSettings", "Preferences: Open Settings", ["cmd+,"], "openSettingsUi"),
  C("workbench.action.openSettingsJson", "Preferences: Open Settings (JSON)", [], "openSettings"),
  C("workbench.action.openGlobalKeybindings", "Preferences: Open Keyboard Shortcuts", [], "openSettingsUi", { args: ["keybindings"] }),
  C("workbench.action.openGlobalKeybindingsFile", "Preferences: Open Keyboard Shortcuts (JSON)", [], "openKeybindings"),
  C("workbench.action.closeActiveEditor", "View: Close Editor", ["cmd+w", "ctrl+q"], "quit"),
  C("undo", "Undo", ["cmd+z", "ctrl+z"], "undo"),
  C("redo", "Redo", ["cmd+shift+z", "ctrl+shift+z", "ctrl+y"], "redo"),
  C("editor.action.selectAll", "Select All", ["cmd+a", "ctrl+a"], "selectAll"),
  C("editor.action.commentLine", "Toggle Line Comment", ["cmd+/", "ctrl+/"], "toggleComment"),
  C("editor.action.addSelectionToNextFindMatch", "Add Selection to Next Find Match", ["cmd+d", "ctrl+d"], "selectNextOccurrence"),
  C("actions.find", "Find", ["cmd+f", "ctrl+f"], "openFind", { args: [false] }),
  C("editor.action.startFindReplaceAction", "Replace", ["cmd+alt+f", "ctrl+h"], "openFind", { args: [true] }),
  C("toggleFindCaseSensitive", "Toggle Match Case", ["cmd+alt+c", "alt+c"], "toggleFind", { args: ["caseSensitive"] }),
  C("toggleFindWholeWord", "Toggle Match Whole Word", ["cmd+alt+w", "alt+w"], "toggleFind", { args: ["wholeWord"] }),
  C("toggleFindRegex", "Toggle Use Regular Expression", ["cmd+alt+r", "alt+r"], "toggleFind", { args: ["regex"] }),
  C("editor.action.replaceOne", "Replace Next Match", ["shift+cmd+1"], "replaceOne"),
  C("editor.action.replaceAll", "Replace All", ["cmd+alt+enter"], "replaceAllMatches"),
  C("editor.action.nextMatchFindAction", "Find Next", ["cmd+g", "f3"], "findAgain", { args: [1] }),
  C("editor.action.previousMatchFindAction", "Find Previous", ["cmd+shift+g", "shift+f3"], "findAgain", { args: [-1] }),
  C("workbench.action.gotoLine", "Go to Line/Column...", ["ctrl+g"], "openGoto"),
  C("editor.action.deleteLines", "Delete Line", ["cmd+shift+k", "ctrl+shift+k"], "deleteLines"),
  C("editor.action.moveLinesUpAction", "Move Line Up", ["alt+up"], "moveLines", { args: [-1] }),
  C("editor.action.moveLinesDownAction", "Move Line Down", ["alt+down"], "moveLines", { args: [1] }),
  C("editor.action.copyLinesUpAction", "Copy Line Up", ["alt+shift+up"], "copyLines", { args: [-1] }),
  C("editor.action.copyLinesDownAction", "Copy Line Down", ["alt+shift+down"], "copyLines", { args: [1] }),
  C("editor.action.insertLineAfter", "Insert Line Below", ["cmd+enter", "ctrl+enter"], "insertLine", { args: [1] }),
  C("editor.action.insertLineBefore", "Insert Line Above", ["cmd+shift+enter", "ctrl+shift+enter"], "insertLine", { args: [0] }),
  C("editor.action.indentLines", "Indent Line", ["cmd+]", "ctrl+]"], "indentLines", { args: [false] }),
  C("editor.action.outdentLines", "Outdent Line", ["cmd+[", "ctrl+["], "indentLines", { args: [true] }),
  C("workbench.action.navigateBack", "Go Back", ["ctrl+-"], "navigate", { args: [-1] }),
  C("workbench.action.navigateForward", "Go Forward", ["ctrl+shift+-"], "navigate", { args: [1] }),
  C("editor.action.showContextMenu", "Show Editor Context Menu", ["shift+f10", "menu"], "openMenuAtCursor"),
];
const BY_ID = new Map(COMMANDS.map(c => [c.id, c]));

// VS Code's default editor context menu: groups, with Peek as a submenu.
const MENU = [
  ["editor.action.revealDefinition", "editor.action.goToTypeDefinition", "editor.action.goToImplementation", "editor.action.goToReferences",
    { title: "Peek", items: ["editor.action.peekDefinition", "editor.action.referenceSearch.trigger", "editor.action.peekImplementation", "editor.action.peekTypeDefinition"] }],
  ["references-view.findReferences", "references-view.findImplementations", "references-view.showCallHierarchy"],
  ["editor.action.rename", "editor.action.changeAll", "editor.action.formatDocument", "editor.action.refactor", "editor.action.sourceAction"],
  ["editor.action.clipboardCutAction", "editor.action.clipboardCopyAction", "editor.action.clipboardPasteAction"],
  ["workbench.action.showCommands"],
];

// Rows for a menu: { sep: true } | { id, title, key, enabled, submenu? }. can(cap) says whether a provider exists;
// keyOf(id) is the key label shown (the user's keymap; default: the command's own).
function menuRows(groups, can, keyOf = (id) => BY_ID.get(id).key) {
  const rows = [];
  const row = (id) => { const c = BY_ID.get(id); return { id, title: c.title, key: keyOf(id), enabled: !c.cap || can(c.cap) }; };
  groups.forEach((g, i) => {
    if (i) rows.push({ sep: true });
    for (const it of g) {
      if (typeof it === "string") rows.push(row(it));
      else { const items = menuRows([it.items], can, keyOf); rows.push({ id: null, title: it.title, key: "", enabled: items.some(r => r.enabled), submenu: items }); }
    }
  });
  return rows;
}

// Next selectable row from i in direction dir (wrapping); -1 when none.
function stepMenu(rows, i, dir) {
  for (let k = 1; k <= rows.length; k++) {
    const j = ((i + dir * k) % rows.length + rows.length) % rows.length;
    if (!rows[j].sep && rows[j].enabled) return j;
  }
  return -1;
}

// The default keymap (no user keybindings): chord -> command.
const KEYMAP = new Map(COMMANDS.flatMap(c => c.chords.map(ch => [normalize(ch), c])));

// Subsequence match with VS Code-like bonuses (start, word starts, consecutive). Returns { score, hits } or null.
function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase(), t = text.toLowerCase(), hits = [];
  let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i === -1) return null;
    const start = i === 0 || /[\s/\\._\-:]/.test(text[i - 1]) || (text[i] !== t[i] && text[i - 1] === t[i - 1]);
    score += 1 + (i === prev + 1 ? 5 : 0) + (start ? 8 : 0) - Math.min(3, (i - ti) * 0.05);
    hits.push(i); prev = i; ti = i + 1;
  }
  return { score, hits };
}

// Items matching query, best first (ties keep the original order). key(item) is the text matched.
function filter(items, query, key) {
  const out = [];
  items.forEach((it, i) => { const m = fuzzy(query, key(it)); if (m) out.push({ it, m, i }); });
  return out.sort((a, b) => b.m.score - a.m.score || a.i - b.i).map(o => ({ item: o.it, hits: o.m.hits }));
}

module.exports = { COMMANDS, BY_ID, MENU, KEYMAP, menuRows, stepMenu, chordOf, split, normalize, label, fuzzy, filter };
