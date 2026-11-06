// Editor commands: VS Code ids and titles with their default keys per OS (keymap.json, shared with the Rust port), the
// Editor method each runs, the editor context menu, fuzzy filter. A command is { id, title, keys: { mac, win, linux },
// key (label of its first key on this OS), run (Editor method name), args?, cap? (language operation it needs) }.
// User keybindings: keybindings.cjs.

// The OS whose keys are in effect: VSEDIT_OS (mac | win | linux), else the platform's.
const OSES = ["mac", "win", "linux"];
const platform = (env = process.env.VSEDIT_OS, p = process.platform) =>
  (OSES.includes(env) ? env : p === "darwin" ? "mac" : p === "win32" ? "win" : "linux");
const OS = platform();

// Key event -> "ctrl+alt+shift+cmd+name".
const chordOf = (ev) => `${ev.ctrl ? "ctrl+" : ""}${ev.alt ? "alt+" : ""}${ev.shift ? "shift+" : ""}${ev.cmd ? "cmd+" : ""}${ev.name}`;
// "shift+cmd+k" -> { mods: ["shift", "cmd"], name: "k" }; the key itself may be "+" ("ctrl++").
const split = (chord) => {
  const i = chord.length > 1 ? chord.lastIndexOf("+", chord.length - 2) : -1;
  return { mods: i < 0 ? [] : chord.slice(0, i).split("+"), name: chord.slice(i + 1) };
};
// Keys are normalized to chordOf's modifier order; a two-step chord ("cmd+k cmd+c") step by step.
const normalize = (key) => key.trim().split(/\s+/).map((step) => {
  const { mods, name } = split(step);
  return ["ctrl", "alt", "shift", "cmd"].filter(m => mods.includes(m)).map(m => m + "+").join("") + name;
}).join(" ");

// Normalized key -> its label as VS Code shows it on that OS: macOS glyphs ("⇧⌘K", "⌘K ⌘J", "⌥↑"), elsewhere text in
// VS Code's order ("Ctrl+Shift+K", "Ctrl+K Ctrl+J", "Alt+UpArrow"; ⌘ is the Windows / Super key).
const GLYPHS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const MAC_KEYS = { up: "↑", down: "↓", left: "←", right: "→", enter: "↩", backspace: "⌫", delete: "⌦", tab: "⇥", escape: "Escape",
  pageup: "PageUp", pagedown: "PageDown", space: "Space", home: "Home", end: "End", insert: "Insert" };
const TEXT_KEYS = { up: "UpArrow", down: "DownArrow", left: "LeftArrow", right: "RightArrow", enter: "Enter", backspace: "Backspace",
  delete: "Delete", tab: "Tab", escape: "Escape", pageup: "PageUp", pagedown: "PageDown", space: "Space", home: "Home", end: "End", insert: "Insert" };
const capital = (name) => name.charAt(0).toUpperCase() + name.slice(1);
function label(key, os = OS) {
  return normalize(key).split(" ").map((step) => {
    const { mods, name } = split(step);
    if (os === "mac") return mods.map(m => GLYPHS[m]).join("") + (MAC_KEYS[name] ?? capital(name));
    const text = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: os === "win" ? "Windows" : "Super" };
    return [...["ctrl", "shift", "alt", "cmd"].filter(m => mods.includes(m)).map(m => text[m]), TEXT_KEYS[name] ?? capital(name)].join("+");
  }).join(" ");
}

// What each command runs: id -> [Editor method, args?, cap?]. Titles and keys are keymap.json's.
const RUNS = {
  "editor.action.revealDefinition": ["goTo", ["definition"], "definition"],
  "editor.action.goToTypeDefinition": ["goTo", ["typeDefinition"], "typeDefinition"],
  "editor.action.goToImplementation": ["goTo", ["implementation"], "implementation"],
  "editor.action.goToReferences": ["goTo", ["references"], "references"],
  "editor.action.peekDefinition": ["peekAt", ["definition"], "definition"],
  "editor.action.referenceSearch.trigger": ["peekAt", ["references"], "references"],
  "editor.action.peekImplementation": ["peekAt", ["implementation"], "implementation"],
  "editor.action.peekTypeDefinition": ["peekAt", ["typeDefinition"], "typeDefinition"],
  "references-view.findReferences": ["findAll", ["references"], "references"],
  "references-view.findImplementations": ["findAll", ["implementation"], "implementation"],
  "references-view.showCallHierarchy": ["callHierarchy", [], "callHierarchy"],
  "editor.action.rename": ["renameSymbol", [], "rename"],
  "editor.action.changeAll": ["changeAll"],
  "editor.action.formatDocument": ["formatDocument", [], "format"],
  "editor.action.formatSelection": ["formatSelection"],
  "editor.action.quickFix": ["quickFix"],
  "editor.action.showHover": ["showHover"],
  "editor.action.smartSelect.expand": ["smartSelect", [1]],
  "editor.action.smartSelect.shrink": ["smartSelect", [-1]],
  "cursorUndo": ["cursorHistory", [-1]],
  "cursorRedo": ["cursorHistory", [1]],
  "editor.action.refactor": ["codeActions", ["refactor"], "refactor"],
  "editor.action.sourceAction": ["codeActions", ["source"], "source"],
  "editor.action.clipboardCutAction": ["copy", [true]],
  "editor.action.clipboardCopyAction": ["copy", [false]],
  "editor.action.clipboardPasteAction": ["paste", [undefined]],
  "workbench.action.showCommands": ["openPicker", [">"]],
  "workbench.action.quickOpen": ["openPicker", [""]],
  "workbench.action.files.save": ["saveFile"],
  "workbench.action.files.saveAs": ["saveAs"],
  "workbench.action.files.saveAll": ["saveAll"],
  "expandLineSelection": ["expandLineSelection"],
  "editor.action.blockComment": ["blockComment"],
  "actions.findWithSelection": ["findWithSelection"],
  "editor.action.nextSelectionMatchFindAction": ["findSelection", [1]],
  "editor.action.previousSelectionMatchFindAction": ["findSelection", [-1]],
  "editor.action.jumpToBracket": ["jumpToBracket"],
  "editor.action.selectToBracket": ["selectToBracket"],
  "editor.action.joinLines": ["joinLines"],
  "workbench.action.files.toggleAutoSave": ["toggleAutoSave"],
  "workbench.action.files.setAutoSaveDelay": ["askAutoSaveDelay"],
  "workbench.action.openSettings": ["openSettingsUi"],
  "workbench.action.openSettingsJson": ["openSettings"],
  "workbench.action.openGlobalKeybindings": ["openSettingsUi", ["keybindings"]],
  "workbench.action.openGlobalKeybindingsFile": ["openKeybindings"],
  "workbench.action.closeActiveEditor": ["quit"],
  "undo": ["undo"],
  "redo": ["redo"],
  "editor.action.selectAll": ["selectAll"],
  "editor.action.commentLine": ["toggleComment"],
  "editor.action.addCommentLine": ["toggleComment", ["add"]],
  "editor.action.removeCommentLine": ["toggleComment", ["remove"]],
  "editor.action.trimTrailingWhitespace": ["trimTrailing"],
  "editor.action.addSelectionToNextFindMatch": ["selectNextOccurrence"],
  "actions.find": ["openFind", [false]],
  "editor.action.startFindReplaceAction": ["openFind", [true]],
  "toggleFindCaseSensitive": ["toggleFind", ["caseSensitive"]],
  "toggleFindWholeWord": ["toggleFind", ["wholeWord"]],
  "toggleFindRegex": ["toggleFind", ["regex"]],
  "editor.action.replaceOne": ["replaceOne"],
  "editor.action.replaceAll": ["replaceAllMatches"],
  "editor.action.nextMatchFindAction": ["findAgain", [1]],
  "editor.action.previousMatchFindAction": ["findAgain", [-1]],
  "workbench.action.gotoSymbol": ["goToSymbol"],
  "editor.action.marker.next": ["nextProblem", [1]],
  "editor.action.marker.prev": ["nextProblem", [-1]],
  "workbench.action.gotoLine": ["openGoto"],
  "editor.action.deleteLines": ["deleteLines"],
  "editor.action.moveLinesUpAction": ["moveLines", [-1]],
  "editor.action.moveLinesDownAction": ["moveLines", [1]],
  "editor.action.copyLinesUpAction": ["copyLines", [-1]],
  "editor.action.copyLinesDownAction": ["copyLines", [1]],
  "editor.action.insertLineAfter": ["insertLine", [1]],
  "editor.action.insertLineBefore": ["insertLine", [0]],
  "editor.action.indentLines": ["indentLines", [false]],
  "editor.action.outdentLines": ["indentLines", [true]],
  "workbench.action.navigateBack": ["navigate", [-1]],
  "workbench.action.navigateForward": ["navigate", [1]],
  "editor.action.indentUsingSpaces": ["pickTabSize", [false]],
  "editor.action.indentUsingTabs": ["pickTabSize", [true]],
  "workbench.action.editor.changeEOL": ["pickEol"],
  "workbench.action.editor.changeLanguageMode": ["pickLanguage"],
  "workbench.action.editor.nextChange": ["gotoChange", [1]],
  "workbench.action.editor.previousChange": ["gotoChange", [-1]],
  "editor.fold": ["fold"],
  "editor.unfold": ["unfold"],
  "editor.toggleFold": ["toggleFold"],
  "editor.foldAll": ["foldAll"],
  "editor.unfoldAll": ["unfoldAll"],
  "editor.action.showContextMenu": ["openMenuAtCursor"],
  // horizontal(dir, extend, word), vertical(rows, extend), home(extend), lineEdge(end, extend), docEdge(end, extend), page(dir, extend)
  "cursorLeft": ["horizontal", [-1, false, false]], "cursorLeftSelect": ["horizontal", [-1, true, false]],
  "cursorRight": ["horizontal", [1, false, false]], "cursorRightSelect": ["horizontal", [1, true, false]],
  "cursorUp": ["vertical", [-1, false]], "cursorUpSelect": ["vertical", [-1, true]],
  "cursorDown": ["vertical", [1, false]], "cursorDownSelect": ["vertical", [1, true]],
  "cursorWordLeft": ["horizontal", [-1, false, true]], "cursorWordLeftSelect": ["horizontal", [-1, true, true]],
  "cursorWordEndRight": ["horizontal", [1, false, true]], "cursorWordEndRightSelect": ["horizontal", [1, true, true]],
  "cursorHome": ["home", [false]], "cursorHomeSelect": ["home", [true]],
  "cursorEnd": ["lineEdge", [true, false]], "cursorEndSelect": ["lineEdge", [true, true]],
  "cursorLineStart": ["lineEdge", [false, false]], "cursorLineStartSelect": ["lineEdge", [false, true]],
  "cursorLineEnd": ["lineEdge", [true, false]], "cursorLineEndSelect": ["lineEdge", [true, true]],
  "cursorTop": ["docEdge", [false, false]], "cursorTopSelect": ["docEdge", [false, true]],
  "cursorBottom": ["docEdge", [true, false]], "cursorBottomSelect": ["docEdge", [true, true]],
  "cursorPageUp": ["page", [-1, false]], "cursorPageUpSelect": ["page", [-1, true]],
  "cursorPageDown": ["page", [1, false]], "cursorPageDownSelect": ["page", [1, true]],
  "scrollLineUp": ["scrollLine", [-1]], "scrollLineDown": ["scrollLine", [1]],
  "deleteLeft": ["backspace", [false]], "deleteRight": ["deleteForward", [false]],
  "deleteWordLeft": ["backspace", [true]], "deleteWordRight": ["deleteForward", [true]],
  "deleteAllLeft": ["deleteAll", [-1]], "deleteAllRight": ["deleteAll", [1]],
};

const COMMANDS = require("./keymap.json").commands.map(({ id, title, keys }) => {
  const r = RUNS[id];
  if (!r) throw new Error(`keymap.json: no Editor method for ${id}`);
  const [run, args = [], cap] = r;
  return { id, title, keys, key: keys[OS][0] ? label(keys[OS][0]) : "", run, args, ...(cap ? { cap } : {}) };
});
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

// The default bindings of an OS, in order: [{ key (normalized), command (id) }].
const defaults = (os = OS) => COMMANDS.flatMap(c => c.keys[os].map(k => ({ key: normalize(k), command: c.id })));
// This OS's default keymap (no user keybindings): key -> command.
const KEYMAP = new Map(defaults().map(b => [b.key, BY_ID.get(b.command)]));

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

module.exports = { OS, OSES, platform, COMMANDS, RUNS, BY_ID, MENU, KEYMAP, defaults, menuRows, stepMenu, chordOf, split, normalize, label, fuzzy, filter };
