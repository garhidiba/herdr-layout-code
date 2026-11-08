// node --test mods/vscode-explorer/test/split.test.mjs
// A file dragged from the tree onto a pane (split.js): it opens beside that pane, or the editor it is open in moves there.
import test from "node:test";
import assert from "node:assert/strict";
import { createSplitOpen } from "../split.js";

// A fake Herdr: tab "a" has panes p1, p2 (p2 focused); tab "b" has p3, an editor of /p/b.ts, and v4, a viewer of /p/demo.mp4. `open` adds a pane beside
// the focused one, as openFile with a place does; `focusable` false: a pane.focus that never lands.
function harness({ focusable = true } = {}) {
  const panes = [{ pane: "p1", tab: "a", terminal: "t1" }, { pane: "p2", tab: "a", terminal: "t2" }, { pane: "p3", tab: "b", terminal: "t3" },
    { pane: "v4", tab: "b", terminal: null, mod: "vscode-viewer" }];
  let focus = "p2";
  const calls = [], opened = [], moved = [];
  const run = (name, args) => { calls.push([name, args]); if (name === "pane.focus" && focusable) focus = args.pane; };
  const rows = () => panes.map(p => ({ ...p, focused: p.pane === focus }));
  const open = async (file, opts) => { opened.push([file, opts]); panes.push({ pane: "new", tab: panes.find(p => p.pane === focus).tab, terminal: "tn" }); };
  const openPane = (file) => (file === "/p/b.ts" ? rows().find(p => p.pane === "p3") : file === "/p/a.ts" ? rows().find(p => p.pane === "p1")
    : file === "/p/demo.mp4" ? rows().find(p => p.pane === "v4") : null);
  const openAt = createSplitOpen({ run, panes: rows, open, openPane, move: (r) => moved.push(r) });
  const cx = { sleep: async () => {} };
  return { openAt: (ask) => openAt({ folder: "/p", into: "a", ...ask }, cx), calls, opened, moved };
}

test("dropped on the right of a pane, the file opens right of that pane, which is focused first", async () => {
  const h = harness();
  assert.equal(await h.openAt({ file: "/p/c.ts", place: "right", beside: "p1" }), true);
  assert.deepEqual(h.calls, [["tab.select", { id: "a" }], ["pane.focus", { pane: "p1" }]]);
  assert.deepEqual(h.opened, [["/p/c.ts", { on: null, folder: "/p", place: "right" }]]);
});

test("dropped on the left or top, it opens right / down and then swaps with that pane", async () => {
  const h = harness();
  await h.openAt({ file: "/p/c.ts", place: "up", beside: "p1" });
  assert.equal(h.opened[0][1].place, "down");
  assert.deepEqual(h.calls.slice(-2), [["pane.focus", { pane: "new" }], ["pane.swap", { direction: "up" }]]);
});

test("with no pane known under the drop, the tab's focused pane is split", async () => {
  const h = harness();
  await h.openAt({ file: "/p/c.ts", place: "down", beside: null });
  assert.deepEqual(h.calls[1], ["pane.focus", { pane: "p2" }]);
});

test("a file open in an editor of that tab is only focused; open in another tab, that editor moves there", async () => {
  const h = harness();
  await h.openAt({ file: "/p/a.ts", place: "right", beside: "p2" });
  assert.deepEqual(h.calls, [["pane.focus", { pane: "p1" }]]);
  await h.openAt({ file: "/p/b.ts", place: "left", beside: "p2" });
  assert.deepEqual(h.moved, [{ terminal: "t3", into: "a", place: "left", beside: "p2" }]);
  assert.equal(h.opened.length, 0, "never a second editor on one file");
});

test("a file open in a viewer of another tab: that viewer moves there, no second viewer", async () => {
  const h = harness();
  assert.equal(await h.openAt({ file: "/p/demo.mp4", place: "right", beside: "p2" }), true);
  assert.deepEqual(h.moved, [{ pane: "v4", into: "a", place: "right", beside: "p2" }]);
  assert.equal(h.opened.length, 0);
});

test("nothing opens when the target pane never takes focus, for an unknown zone, or a gone tab", async () => {
  const h = harness({ focusable: false });
  assert.equal(await h.openAt({ file: "/p/c.ts", place: "right", beside: "p1" }), false);
  assert.equal(await h.openAt({ file: "/p/c.ts", place: "tab", beside: "p1" }), false);
  assert.equal(await h.openAt({ file: "/p/c.ts", place: "right", into: "gone" }), false);
  assert.equal(h.opened.length, 0);
});
