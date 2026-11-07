// node --test mods/vscode-memo/test/memo.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MEMO, MIN, MEMO_SETTINGS, DEFAULT_POS, buttonRect, buttonPos, memoTarget, clampRect, dragRect, panelRect, gitignoreAddition, dragStarted, memoSettings } from "../memo.js";

const panes = [
  { pane: "p1", tab: "t1", terminal: null, mod: "vscode-viewer", cwd: null },
  { pane: "p2", tab: "t1", terminal: "a", cwd: "/w/app" },
];

test("a space's memo is under its folder, else its first terminal's", () => {
  assert.deepEqual(memoTarget({ id: "s1", folder: "/w/docs/", machine: null, tabs: [{ id: "t1" }] }, panes),
    { folder: "/w/docs", on: null, path: `/w/docs/${MEMO}` });
  assert.deepEqual(memoTarget({ id: "s2", folder: "", machine: null, tabs: [{ id: "t1" }] }, panes),
    { folder: "/w/app", on: null, path: "/w/app/.herdr/memo.md" });
  assert.deepEqual(memoTarget({ id: "box/s3", folder: "/srv", machine: "box", tabs: [] }, panes),
    { folder: "/srv", on: "box", path: "/srv/.herdr/memo.md" });
  assert.equal(memoTarget({ id: "s4", folder: "", machine: null, tabs: [] }, panes), null);
  assert.equal(memoTarget(undefined, panes), null);
});

test("rects stay inside the window", () => {
  const win = { width: 1000, height: 700 };
  assert.deepEqual(clampRect({ x: 980, y: -5, width: 40, height: 40 }, win), { x: 960, y: 0, width: 40, height: 40 });
  assert.deepEqual(clampRect({ x: 10, y: 10, width: 1200, height: 300 }, win), { x: 0, y: 10, width: 1000, height: 300 });
  // Unknown window size: only kept off the top and left edges.
  assert.deepEqual(clampRect({ x: -3, y: 2000, width: 40, height: 40 }, null), { x: 0, y: 2000, width: 40, height: 40 });
});

test("dragging moves, and an edge or corner resizes with the opposite side fixed", () => {
  const r = { x: 100, y: 100, width: 400, height: 300 };
  assert.deepEqual(dragRect(r, "move", 10, -20, MIN), { x: 110, y: 80, width: 400, height: 300 });
  assert.deepEqual(dragRect(r, "e", 50, 99, MIN), { x: 100, y: 100, width: 450, height: 300 });
  assert.deepEqual(dragRect(r, "se", 20, 30, MIN), { x: 100, y: 100, width: 420, height: 330 });
  assert.deepEqual(dragRect(r, "nw", -10, 20, MIN), { x: 90, y: 120, width: 410, height: 280 });
  // Never under the smallest size; the right / bottom edge stays where it was.
  assert.deepEqual(dragRect(r, "w", 300, 0, MIN), { x: 240, y: 100, width: 260, height: 300 });
  assert.deepEqual(dragRect(r, "n", 0, 500, MIN), { x: 100, y: 240, width: 400, height: 160 });
  assert.ok(!dragStarted({ x: 0, y: 0 }, { x: 3, y: 2 }));
  assert.ok(dragStarted({ x: 0, y: 0 }, { x: 4, y: 3 }));
});

test("the button starts bottom right, above the status bar, and keeps its corner as the window resizes", () => {
  const win = { width: 1200, height: 800 };
  assert.deepEqual(buttonRect(null, win), { x: 1144, y: 716, width: 40, height: 40 });
  assert.deepEqual(buttonPos(buttonRect(null, win), win), DEFAULT_POS);
  // Dragged to (300, 100): kept as offsets, so a wider, shorter window keeps it as far from the bottom-right corner.
  const pos = buttonPos({ x: 300, y: 100, width: 40, height: 40 }, win);
  assert.deepEqual(pos, { right: 860, bottom: 660 });
  assert.deepEqual(buttonRect(pos, { width: 1400, height: 760 }), { x: 500, y: 60, width: 40, height: 40 });
  // A window too small for that offset: kept inside it.
  assert.deepEqual(buttonRect(pos, { width: 600, height: 400 }), { x: 0, y: 0, width: 40, height: 40 });
  // A spot saved by the first version ({ x, y }) is used as is.
  assert.deepEqual(buttonRect({ x: 216, y: 3 }, win), { x: 216, y: 3, width: 40, height: 40 });
});

test("the panel opens where it was left, else above the button and to its left", () => {
  const win = { width: 1200, height: 800 }, button = buttonRect(null, win);
  assert.deepEqual(panelRect(null, button, win), { x: 744, y: 368, width: 440, height: 340 });
  assert.deepEqual(panelRect({ x: 1000, y: 700, width: 300, height: 200 }, button, win), { x: 900, y: 600, width: 300, height: 200 });
  // A button near the top left: the panel stays in the window.
  assert.deepEqual(panelRect(null, { x: 0, y: 0, width: 40, height: 40 }, win), { x: 0, y: 0, width: 440, height: 340 });
});

test(".gitignore gets the memo once, keeping its newline", () => {
  assert.equal(gitignoreAddition("node_modules\n", false), ".herdr/memo.md\n");
  assert.equal(gitignoreAddition("node_modules", false), "\n.herdr/memo.md\n");
  assert.equal(gitignoreAddition("", null), ".herdr/memo.md\n");
  assert.equal(gitignoreAddition("dist\n", true), null);
  // No git to ask: a line that ignores it is enough.
  assert.equal(gitignoreAddition("dist\r\n/.herdr/\r\n", null), null);
  assert.equal(gitignoreAddition("  .herdr/memo.md  \n", null), null);
  assert.equal(gitignoreAddition("# .herdr/memo.md\n", null), ".herdr/memo.md\n");
  // Git says it isn't ignored (a later "!" line, say): append even though a line matches.
  assert.equal(gitignoreAddition(".herdr/\n!.herdr/memo.md\n", false), ".herdr/memo.md\n");
});

test("the memo editor keeps the user's settings, cut down to a document editor", () => {
  const s = JSON.parse(memoSettings('{\n  // engine\n  "editor.engine": "rust", "editor.tabSize": 2,\n  "editor.wordWrap": "off",\n}\n'));
  assert.equal(s["editor.engine"], "rust");
  assert.equal(s["editor.tabSize"], 2);
  assert.equal(s["editor.wordWrap"], "on");
  assert.equal(s["files.autoSave"], "afterDelay");
  assert.equal(s["editor.inlineSuggest.provider"], "off");
  assert.deepEqual(JSON.parse(memoSettings(null)), MEMO_SETTINGS);
  assert.deepEqual(JSON.parse(memoSettings("not json")), MEMO_SETTINGS);
});
