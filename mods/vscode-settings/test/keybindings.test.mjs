// node --test mods/vscode-settings/test/keybindings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { canon, fromHerdr, toHerdr, label, matchesRow, conflicts, parseFile, serializeFile, withKey, withoutKey, withReset, hasUserEntries,
  herdrRoute, withPassthrough, recordStep } from "../keybindings.js";
import { loose, rewrite, requestedPage } from "../settings.js";

const require = createRequire(import.meta.url);
const Editor = require("../../vscode-viewer/editor/keybindings.cjs");
const Commands = require("../../vscode-viewer/editor/commands.cjs");

// An in-memory file with writeTextFile's contract: writes only when `expected` still matches.
function memoryFile(text) {
  const f = { text };
  f.io = { read: async () => f.text, write: async (next, expected) => { if (expected !== f.text) throw new Error("stale"); f.text = next; } };
  return f;
}
const kbIo = (f, change) => rewrite(f.io, change, (t) => parseFile(t, loose), serializeFile);

test("VS Code and Herdr spellings of a key map to the same chord, and back", () => {
  assert.equal(canon("cmd+shift+p"), "shift+cmd+p");
  assert.equal(fromHerdr("cmd-shift-p"), "shift+cmd+p");
  assert.equal(toHerdr("shift+cmd+p"), "cmd-shift-p");
  assert.equal(fromHerdr("ctrl--"), "ctrl+-");
  assert.equal(toHerdr("ctrl+shift+-"), "ctrl-shift--");
  assert.equal(toHerdr(canon("alt+cmd+f")), "cmd-alt-f");
  assert.equal(fromHerdr("f12"), "f12");
  assert.equal(canon("cmd+k cmd+s"), "cmd+k cmd+s");
  assert.equal(toHerdr("ctrl+k ctrl+shift+c"), "ctrl-k ctrl-shift-c");
  assert.equal(fromHerdr("super-shift-k"), "shift+cmd+k"); // GPUI on Linux; "win-" on Windows
  assert.equal(fromHerdr("win-a"), "cmd+a");
  assert.equal(fromHerdr("cmd-k cmd-s"), null); // a keystroke is one step
  assert.equal(canon("a b c"), null);
  for (const k of ["cmd+shift+k", "ctrl+-", "alt+shift+f12", "meta+up", "Shift+Cmd+Enter", "ctrl+k ctrl+c", "Cmd+K M", "ctrl+k ctrl+c ctrl+d", "ctrl+k hyper+x"])
    assert.equal(canon(k), Editor.canon(k), k); // same as the editor
});

test("keys render in the OS's style: macOS glyphs, Windows/Linux text, chords step by step", () => {
  assert.equal(label("shift+cmd+k"), "⇧⌘K");
  assert.equal(label("ctrl+alt+shift+cmd+enter"), "⌃⌥⇧⌘↩");
  assert.equal(label("alt+up"), "⌥↑");
  assert.equal(label("f12"), "F12");
  assert.equal(label(""), "");
  assert.equal(label("cmd+k cmd+j", "mac"), "⌘K ⌘J");
  assert.equal(label("ctrl+shift+k", "win"), "Ctrl+Shift+K");
  assert.equal(label("ctrl+alt+shift+up", "linux"), "Ctrl+Shift+Alt+UpArrow");
  assert.equal(label("ctrl+k ctrl+0", "linux"), "Ctrl+K Ctrl+0");
  for (const os of Commands.OSES) for (const { key } of Commands.defaults(os)) assert.equal(label(key, os), Commands.label(key, os), `${os} ${key}`); // same as the editor
});

test("the recorder makes a chord from two keystrokes and starts over on the third", () => {
  assert.equal(recordStep(null, "ctrl+k"), "ctrl+k");
  assert.equal(recordStep("ctrl+k", "ctrl+c"), "ctrl+k ctrl+c");
  assert.equal(recordStep("ctrl+k ctrl+c", "shift+cmd+d"), "shift+cmd+d");
});

test("search matches the title, the id, or the key in any spelling", () => {
  const row = { id: "editor.action.deleteLines", title: "Delete Line", key: "shift+cmd+k", source: "Default" };
  for (const q of ["delete", "deleteLines", "⇧⌘K", "cmd+shift+k", "shift+cmd+k", ""]) assert.ok(matchesRow(row, q), q);
  assert.ok(!matchesRow(row, "format"));
  const win = { id: "editor.foldAll", title: "Fold All", key: "ctrl+k ctrl+0", source: "Default" };
  for (const q of ["Ctrl+K Ctrl+0", "ctrl+k ctrl+0"]) assert.ok(matchesRow(win, q, "win"), q);
});

test("conflicts count the other rows that have the key", () => {
  const rows = [{ id: "a", key: "cmd+d" }, { id: "b", key: "cmd+d" }, { id: "c", key: "cmd+e" }];
  assert.equal(conflicts(rows, "cmd+d", rows[2]), 2);
  assert.equal(conflicts(rows, "cmd+d", rows[0]), 1);
});

test("changing a default key removes the default and adds the new one; other entries are kept", async () => {
  const f = memoryFile('// mine\n[{ "key": "cmd+9", "command": "my.extension", "when": "x" }]');
  await kbIo(f, (en) => withKey(en, { id: "editor.action.deleteLines", key: "shift+cmd+k", source: "Default" }, "shift+cmd+d"));
  assert.deepEqual(JSON.parse(f.text), [
    { key: "cmd+9", command: "my.extension", when: "x" },
    { key: "shift+cmd+k", command: "-editor.action.deleteLines" },
    { key: "shift+cmd+d", command: "editor.action.deleteLines" },
  ]);
  // the editor resolves the written file as intended
  const km = Editor.resolve(JSON.parse(f.text), "mac");
  assert.equal(km.byChord.get("shift+cmd+d"), "editor.action.deleteLines");
  assert.equal(km.byChord.get("shift+cmd+k"), undefined);
});

test("changing a user key rewrites that entry; a command without a key gets one", () => {
  const en = [{ key: "shift+cmd+d", command: "editor.action.deleteLines" }];
  assert.deepEqual(withKey(en, { id: "editor.action.deleteLines", key: "shift+cmd+d", source: "User" }, "cmd+e"), [{ key: "cmd+e", command: "editor.action.deleteLines" }]);
  assert.deepEqual(withKey([], { id: "editor.action.goToTypeDefinition", key: "", source: "" }, "cmd+t"), [{ key: "cmd+t", command: "editor.action.goToTypeDefinition" }]);
  assert.equal(withKey(en, { id: "editor.action.deleteLines", key: "shift+cmd+d", source: "User" }, "shift+cmd+d"), en);
});

test("Remove deletes a user binding or removes a default; Reset drops every entry of the command", () => {
  const en = [{ key: "shift+cmd+k", command: "-editor.action.deleteLines" }, { key: "Shift+Cmd+D", command: "editor.action.deleteLines" }, { key: "cmd+e", command: "undo" }];
  assert.deepEqual(withoutKey(en, { id: "editor.action.deleteLines", key: "shift+cmd+d", source: "User" }), [en[0], en[2]]);
  assert.deepEqual(withoutKey([], { id: "undo", key: "cmd+z", source: "Default" }), [{ key: "cmd+z", command: "-undo" }]);
  assert.deepEqual(withReset(en, "editor.action.deleteLines"), [en[2]]);
  assert.ok(hasUserEntries(en, "undo"));
  assert.ok(!hasUserEntries(en, "redo"));
});

test("a keybindings file that isn't an array is never overwritten; a missing one is created", async () => {
  const bad = memoryFile('{ "key": "cmd+e" }');
  await assert.rejects(kbIo(bad, (en) => [...en, { key: "cmd+e", command: "undo" }]));
  assert.equal(bad.text, '{ "key": "cmd+e" }');
  const none = memoryFile(null);
  await kbIo(none, (en) => [...en, { key: "cmd+e", command: "undo" }]);
  assert.deepEqual(JSON.parse(none.text), [{ key: "cmd+e", command: "undo" }]);
});

const KEYS = [
  { section: "global", keys: "cmd-shift-d", action: "pane.split:down" },
  { section: "layout:vscode", keys: "cmd-e", action: "layout.toggle:panel" },
  { section: "terminal", keys: "cmd-s", action: "terminal" },
  { section: "layout:vscode", keys: "cmd-s", action: "vscode-viewer.save" },
  { section: "mod:other", keys: "cmd-j", action: "other.run" },
];

test("Herdr passes a key when its terminal section says so; otherwise names what takes it", () => {
  assert.deepEqual(herdrRoute(KEYS, "cmd+s"), { passes: true, loses: [{ section: "layout:vscode", action: "vscode-viewer.save" }] });
  assert.deepEqual(herdrRoute(KEYS, "shift+cmd+d"), { passes: false, loses: [{ section: "global", action: "pane.split:down" }] });
  assert.deepEqual(herdrRoute(KEYS, "cmd+j"), { passes: false, loses: [] }); // an unbound ⌘ key doesn't reach programs
  assert.deepEqual(herdrRoute(KEYS, "alt+shift+h"), { passes: true, loses: [] }); // a plain key nobody binds does
  assert.deepEqual(herdrRoute(KEYS, "cmd+k cmd+s"), { passes: false, loses: [{ section: "layout:vscode", action: "vscode-viewer.save" }] }); // ⌘K doesn't
  assert.deepEqual(herdrRoute(KEYS, "ctrl+k ctrl+c"), { passes: true, loses: [] }); // Windows/Linux Ctrl chords nobody binds
});

test("passing a key to the editor adds it to keys.json's terminal section and keeps everything else", async () => {
  const f = { text: JSON.stringify({ global: { "cmd-shift-d": "pane.split:down" }, terminal: { "cmd-s": "terminal", "shift-cmd-d": "terminal.copy" }, "layout:vscode": { "cmd-e": "layout.toggle:panel" } }) };
  f.io = { read: async () => f.text, write: async (next, expected) => { assert.equal(expected, f.text); f.text = next; } };
  await rewrite(f.io, (k) => withPassthrough(k, "shift+cmd+d"), (t) => loose(t));
  assert.deepEqual(JSON.parse(f.text), {
    global: { "cmd-shift-d": "pane.split:down" },
    terminal: { "cmd-s": "terminal", "cmd-shift-d": "terminal" },
    "layout:vscode": { "cmd-e": "layout.toggle:panel" },
  });
  assert.throws(() => withPassthrough([], "cmd+e"));
  assert.deepEqual(withPassthrough({ terminal: { "cmd-c": "terminal.copy" } }, "cmd+k cmd+c").terminal, { "cmd-k": "terminal", "cmd-c": "terminal" }); // each keystroke
});

test("the dialog opens on Keyboard Shortcuts only for a fresh request from the editor", () => {
  const now = 1_000_000;
  assert.equal(requestedPage(JSON.stringify({ page: "keybindings", at: now - 1000 }), now), "keybindings");
  assert.equal(requestedPage(JSON.stringify({ page: "keybindings", at: now - 60000 }), now), "settings");
  assert.equal(requestedPage(JSON.stringify({ page: "settings", at: now }), now), "settings");
  assert.equal(requestedPage(null, now), "settings");
});
