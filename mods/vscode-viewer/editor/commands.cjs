// Editor commands: VS Code titles, macOS key labels and the chords that run them; the editor context menu; fuzzy filter.
// A command is { id, title, key (label), chords, run (Editor method name), args?, cap? (language operation it needs) }.

const C = (id, title, key, chords, run, extra = {}) => ({ id, title, key, chords, run, ...extra });

const COMMANDS = [
  C("editor.action.revealDefinition", "Go to Definition", "F12", ["f12"], "goTo", { args: ["definition"], cap: "definition" }),
  C("editor.action.goToTypeDefinition", "Go to Type Definition", "", [], "goTo", { args: ["typeDefinition"], cap: "typeDefinition" }),
  C("editor.action.goToImplementation", "Go to Implementations", "⌘F12", ["cmd+f12"], "goTo", { args: ["implementation"], cap: "implementation" }),
  C("editor.action.goToReferences", "Go to References", "⇧F12", ["shift+f12"], "goTo", { args: ["references"], cap: "references" }),
  C("editor.action.peekDefinition", "Peek Definition", "⌥F12", ["alt+f12"], "peekAt", { args: ["definition"], cap: "definition" }),
  C("editor.action.referenceSearch.trigger", "Peek References", "", [], "peekAt", { args: ["references"], cap: "references" }),
  C("editor.action.peekImplementation", "Peek Implementations", "", [], "peekAt", { args: ["implementation"], cap: "implementation" }),
  C("editor.action.peekTypeDefinition", "Peek Type Definition", "", [], "peekAt", { args: ["typeDefinition"], cap: "typeDefinition" }),
  C("references-view.findReferences", "Find All References", "⌥⇧F12", ["alt+shift+f12"], "findAll", { args: ["references"], cap: "references" }),
  C("references-view.findImplementations", "Find All Implementations", "", [], "findAll", { args: ["implementation"], cap: "implementation" }),
  C("references-view.showCallHierarchy", "Show Call Hierarchy", "⌥⇧H", ["alt+shift+h"], "callHierarchy", { cap: "callHierarchy" }),
  C("editor.action.rename", "Rename Symbol", "F2", ["f2"], "renameSymbol", { cap: "rename" }),
  C("editor.action.changeAll", "Change All Occurrences", "⌘F2", ["cmd+f2", "ctrl+f2"], "changeAll"),
  C("editor.action.formatDocument", "Format Document", "⌥⇧F", ["alt+shift+f"], "formatDocument", { cap: "format" }),
  C("editor.action.refactor", "Refactor...", "⌃⇧R", ["ctrl+shift+r"], "codeActions", { args: ["refactor"], cap: "refactor" }),
  C("editor.action.sourceAction", "Source Action...", "", [], "codeActions", { args: ["source"], cap: "source" }),
  C("editor.action.clipboardCutAction", "Cut", "⌘X", ["cmd+x", "ctrl+x"], "copy", { args: [true] }),
  C("editor.action.clipboardCopyAction", "Copy", "⌘C", ["cmd+c", "ctrl+c"], "copy", { args: [false] }),
  C("editor.action.clipboardPasteAction", "Paste", "⌘V", ["cmd+v", "ctrl+v"], "paste", { args: [undefined] }),
  C("workbench.action.showCommands", "Command Palette...", "⇧⌘P", ["cmd+shift+p", "ctrl+shift+p", "f1"], "openPicker", { args: [">"] }),
  C("workbench.action.quickOpen", "Go to File...", "⌘P", ["cmd+p", "ctrl+p"], "openPicker", { args: [""] }),
  C("workbench.action.files.save", "File: Save", "⌘S", ["cmd+s", "ctrl+s"], "saveFile"),
  C("workbench.action.files.toggleAutoSave", "File: Toggle Auto Save", "", [], "toggleAutoSave"),
  C("workbench.action.files.setAutoSaveDelay", "File: Set Auto Save Delay…", "", [], "askAutoSaveDelay"),
  C("workbench.action.openSettingsJson", "Preferences: Open Settings (JSON)", "", [], "openSettings"),
  C("workbench.action.closeActiveEditor", "View: Close Editor", "⌘W", ["cmd+w", "ctrl+q"], "quit"),
  C("undo", "Undo", "⌘Z", ["cmd+z", "ctrl+z"], "undo"),
  C("redo", "Redo", "⇧⌘Z", ["cmd+shift+z", "ctrl+shift+z", "ctrl+y"], "redo"),
  C("editor.action.selectAll", "Select All", "⌘A", ["cmd+a", "ctrl+a"], "selectAll"),
  C("editor.action.commentLine", "Toggle Line Comment", "⌘/", ["cmd+/", "ctrl+/"], "toggleComment"),
  C("editor.action.addSelectionToNextFindMatch", "Add Selection to Next Find Match", "⌘D", ["cmd+d", "ctrl+d"], "selectNextOccurrence"),
  C("actions.find", "Find", "⌘F", ["cmd+f", "ctrl+f"], "openFind", { args: [false] }),
  C("editor.action.startFindReplaceAction", "Replace", "⌥⌘F", ["cmd+alt+f", "ctrl+h"], "openFind", { args: [true] }),
  C("editor.action.nextMatchFindAction", "Find Next", "⌘G", ["cmd+g", "f3"], "findAgain", { args: [1] }),
  C("editor.action.previousMatchFindAction", "Find Previous", "⇧⌘G", ["cmd+shift+g", "shift+f3"], "findAgain", { args: [-1] }),
  C("workbench.action.gotoLine", "Go to Line/Column...", "⌃G", ["ctrl+g"], "openGoto"),
  C("editor.action.deleteLines", "Delete Line", "⇧⌘K", ["cmd+shift+k", "ctrl+shift+k"], "deleteLines"),
  C("editor.action.moveLinesUpAction", "Move Line Up", "⌥↑", ["alt+up"], "moveLines", { args: [-1] }),
  C("editor.action.moveLinesDownAction", "Move Line Down", "⌥↓", ["alt+down"], "moveLines", { args: [1] }),
  C("editor.action.copyLinesUpAction", "Copy Line Up", "⇧⌥↑", ["alt+shift+up"], "copyLines", { args: [-1] }),
  C("editor.action.copyLinesDownAction", "Copy Line Down", "⇧⌥↓", ["alt+shift+down"], "copyLines", { args: [1] }),
  C("editor.action.insertLineAfter", "Insert Line Below", "⌘↩", ["cmd+enter", "ctrl+enter"], "insertLine", { args: [1] }),
  C("editor.action.insertLineBefore", "Insert Line Above", "⇧⌘↩", ["cmd+shift+enter", "ctrl+shift+enter"], "insertLine", { args: [0] }),
  C("editor.action.indentLines", "Indent Line", "⌘]", ["cmd+]", "ctrl+]"], "indentLines", { args: [false] }),
  C("editor.action.outdentLines", "Outdent Line", "⌘[", ["cmd+[", "ctrl+["], "indentLines", { args: [true] }),
  C("workbench.action.navigateBack", "Go Back", "⌃-", ["ctrl+-"], "navigate", { args: [-1] }),
  C("workbench.action.navigateForward", "Go Forward", "⌃⇧-", ["ctrl+shift+-"], "navigate", { args: [1] }),
  C("editor.action.showContextMenu", "Show Editor Context Menu", "⇧F10", ["shift+f10", "menu"], "openMenuAtCursor"),
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

// Rows for a menu: { sep: true } | { id, title, key, enabled, submenu? }. can(cap) says whether a provider exists.
function menuRows(groups, can) {
  const rows = [];
  const row = (id) => { const c = BY_ID.get(id); return { id, title: c.title, key: c.key, enabled: !c.cap || can(c.cap) }; };
  groups.forEach((g, i) => {
    if (i) rows.push({ sep: true });
    for (const it of g) {
      if (typeof it === "string") rows.push(row(it));
      else { const items = menuRows([it.items], can); rows.push({ id: null, title: it.title, key: "", enabled: items.some(r => r.enabled), submenu: items }); }
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

// Key event -> "ctrl+alt+shift+cmd+name".
const chordOf = (ev) => `${ev.ctrl ? "ctrl+" : ""}${ev.alt ? "alt+" : ""}${ev.shift ? "shift+" : ""}${ev.cmd ? "cmd+" : ""}${ev.name}`;
// Chord strings are normalized to the same modifier order as chordOf.
const normalize = (chord) => {
  const parts = chord.split("+"), name = parts.pop();
  return ["ctrl", "alt", "shift", "cmd"].filter(m => parts.includes(m)).map(m => m + "+").join("") + name;
};
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

module.exports = { COMMANDS, BY_ID, MENU, KEYMAP, menuRows, stepMenu, chordOf, normalize, fuzzy, filter };
