// node --test mods/vscode-memo/test/memo.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MEMO, MIN, MEMO_SETTINGS, GRIP, CORNER, FOOT, panelLayout, closesOnPress, memoTarget, clampRect, dragRect, panelRect, gitignoreAddition, dragStarted, memoSettings } from "../memo.js";

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

test("a press outside closes the unpinned panel; inside, on the button or pinned it doesn't", () => {
  const panel = { x: 100, y: 100, width: 400, height: 300 }, button = { x: 900, y: 700, width: 40, height: 40 };
  const at = (x, y, pinned = false) => closesOnPress({ x, y }, { panel, button, pinned });
  assert.ok(at(50, 50));
  assert.ok(at(500, 250)); // just past the right edge
  assert.ok(!at(100, 100)); // the border's corner: resizing
  assert.ok(!at(300, 110)); // the title bar: moving
  assert.ok(!at(300, 300)); // the editor
  assert.ok(!at(910, 710)); // the button toggles it itself
  assert.ok(!at(50, 50, true)); // pinned
  assert.ok(!closesOnPress({ x: 50, y: 50 }, { panel: null, button, pinned: false })); // no panel
});

test("the panel opens where it was left, else above the button and to its left, else in the middle", () => {
  const win = { width: 1200, height: 800 }, button = { x: 1150, y: 730, width: 34, height: 34 };
  assert.deepEqual(panelRect(null, button, win), { x: 744, y: 382, width: 440, height: 340 });
  assert.deepEqual(panelRect({ x: 1000, y: 700, width: 300, height: 200 }, button, win), { x: 900, y: 600, width: 300, height: 200 });
  // A button near the top left: the panel stays in the window.
  assert.deepEqual(panelRect(null, { x: 0, y: 0, width: 40, height: 40 }, win), { x: 0, y: 0, width: 440, height: 340 });
  // Opened by the toggle command before the button was ever pointed at.
  assert.deepEqual(panelRect(null, null, win), { x: 380, y: 230, width: 440, height: 340 });
});

test("the panel's corners resize from CORNER px along both sides; its edges are GRIP px", () => {
  const body = { type: "block", content: { terminal: "t1" } };
  const [left, middle, right] = panelLayout("vscode-memo", body).children;
  // A grip block as [edge, px] (null: it takes the rest).
  const strip = (n) => n.children.map(c => [c.content.props.edge, c.size?.px ?? null]);
  // The sides: GRIP px wide, a corner CORNER px tall at each end.
  assert.equal(left.size.px, GRIP); assert.equal(right.size.px, GRIP);
  assert.deepEqual(strip(left), [["nw", CORNER], ["w", null], ["sw", CORNER]]);
  assert.deepEqual(strip(right), [["ne", CORNER], ["e", null], ["se", CORNER]]);
  // The top (GRIP px) and bottom (FOOT px) strips: the corners go on CORNER px from the outside edge.
  const [top, title, editor, bottom] = middle.children;
  assert.equal(top.size.px, GRIP); assert.equal(bottom.size.px, FOOT);
  assert.deepEqual(strip(top), [["nw", CORNER - GRIP], ["n", null], ["ne", CORNER - GRIP]]);
  assert.deepEqual(strip(bottom), [["sw", CORNER - GRIP], ["s", null], ["se", CORNER - GRIP]]);
  assert.ok(CORNER >= 14 && CORNER <= 16 && GRIP <= 6);
  // Then the title bar (it fills the top corners' inside with its own grips) and the editor.
  assert.equal(title.content.props.role, "title");
  assert.equal(editor, body);
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
