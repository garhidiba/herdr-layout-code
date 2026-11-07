// node --test mods/vscode-tabs/test/move.test.mjs
// Moving a terminal between tabs (move.js): park, then keep beside another tab's pane or as a new tab.
import test from "node:test";
import assert from "node:assert/strict";
import { createMover } from "../move.js";

// A fake Herdr: park takes the pane away, keep gives it one (beside the focused pane, or in a new tab); `parked` /
// `kept` false: that step never shows; `empty` true: a tab whose last pane is parked stays, empty.
function harness({ parked = true, kept = true, empty = false } = {}) {
  const panes = [
    { pane: "p1", tab: "a", terminal: "t1" }, // a shell
    { pane: "p2", tab: "b", terminal: "t2" }, // an editor
    { pane: "p3", tab: "c", terminal: "t3" }, { pane: "p4", tab: "c", terminal: "t4", focused: true }, // a shell and an editor
  ];
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }], calls = [];
  let focus = "p4", pending = null;
  const run = (name, args) => {
    calls.push([name, args]);
    if (name === "pane.focus" && args.pane) focus = args.pane;
    if (name === "terminal.park" && parked) pending = () => {
      const i = panes.findIndex(p => p.terminal === args.terminal), tab = panes[i].tab;
      panes.splice(i, 1);
      if (!empty && !panes.some(p => p.tab === tab)) tabs.splice(tabs.findIndex(t => t.id === tab), 1);
    };
    if (name === "terminal.keep" && kept) pending = () => {
      const tab = args.place === "tab" ? "n" : panes.find(p => p.pane === focus).tab;
      if (tab === "n") tabs.push({ id: "n" });
      panes.push({ pane: `p-${args.terminal}`, tab, terminal: args.terminal });
    };
    if (name === "tab.close") tabs.splice(tabs.findIndex(t => t.id === args.id), 1);
  };
  const move = createMover({ run, panes: () => panes, spaces: () => [{ id: "s", tabs }] });
  const sleep = async () => { pending?.(); pending = null; };
  return { move: (req) => move(req, sleep), calls, panes, tabs };
}

test("an editor tab joins a shell's tab right of its pane; its own tab goes with its only pane", async () => {
  const h = harness();
  assert.equal(await h.move({ terminal: "t2", into: "a", place: "right" }), true);
  assert.deepEqual(h.calls, [["terminal.park", { terminal: "t2" }], ["tab.select", { id: "a" }], ["pane.focus", { pane: "p1" }],
    ["terminal.keep", { terminal: "t2", place: "right" }], ["tab.select", { id: "a" }], ["pane.focus", { terminal: "t2" }]]);
  assert.equal(h.panes.find(p => p.terminal === "t2").tab, "a");
  assert.deepEqual(h.tabs.map(t => t.id), ["a", "c"]);
});

test("it goes beside the target tab's focused pane, else its last one", async () => {
  const h = harness();
  h.panes[3].focused = false;
  h.panes[2].focused = true;
  await h.move({ terminal: "t1", into: "c", place: "down" });
  assert.deepEqual(h.calls[2], ["pane.focus", { pane: "p3" }]);
  const g = harness();
  g.panes[3].focused = false;
  await g.move({ terminal: "t1", into: "c", place: "down" });
  assert.deepEqual(g.calls[2], ["pane.focus", { pane: "p4" }]);
});

test("left and up are kept right and down, then swapped with that neighbour", async () => {
  for (const [place, keep, swap] of [["left", "right", "left"], ["up", "down", "up"]]) {
    const h = harness();
    assert.equal(await h.move({ terminal: "t2", into: "a", place }), true);
    assert.deepEqual(h.calls.slice(3), [["terminal.keep", { terminal: "t2", place: keep }], ["tab.select", { id: "a" }],
      ["pane.focus", { terminal: "t2" }], ["pane.swap", { direction: swap }]]);
  }
});

test("an emptied tab Herdr keeps is closed once the terminal is shown elsewhere", async () => {
  const h = harness({ empty: true });
  await h.move({ terminal: "t2", into: "a", place: "right" });
  assert.deepEqual(h.calls.at(-1), ["tab.close", { id: "b" }]);
  assert.deepEqual(h.tabs.map(t => t.id), ["a", "c"]);
});

test("Move to New Tab gives a pane that shares its tab one of its own, named after its file", async () => {
  const h = harness();
  assert.equal(await h.move({ terminal: "t4", into: null, place: "tab", name: "a.ts" }), true);
  assert.deepEqual(h.calls, [["terminal.park", { terminal: "t4" }], ["terminal.keep", { terminal: "t4", place: "tab" }],
    ["tab.select", { id: "n" }], ["pane.focus", { terminal: "t4" }], ["tab.rename", { id: "n", name: "a.ts" }]]);
  assert.deepEqual(h.tabs.map(t => t.id), ["a", "b", "c", "n"]);
});

test("nothing moves when there is nowhere to go or the request makes no sense", async () => {
  const h = harness();
  for (const req of [
    { terminal: "t2", into: null, place: "tab" }, // alone in its tab already
    { terminal: "t2", into: "b", place: "right" }, // its own tab
    { terminal: "t2", into: "gone", place: "right" },
    { terminal: "t2", into: "a", place: "tab" },
    { terminal: "t2", into: "a", place: "middle" },
    { terminal: "t4", into: null, place: "right" },
    { terminal: "nope", into: "a", place: "right" },
  ]) assert.equal(await h.move(req), false, JSON.stringify(req));
  assert.deepEqual(h.calls, []);
});

test("a park or keep that never shows stops there (Herdr toasts why)", async () => {
  const h = harness({ parked: false });
  assert.equal(await h.move({ terminal: "t2", into: "a", place: "right" }), false);
  assert.deepEqual(h.calls, [["terminal.park", { terminal: "t2" }]]);
  const k = harness({ kept: false });
  assert.equal(await k.move({ terminal: "t2", into: "a", place: "right" }), false);
  assert.equal(k.calls.at(-1)[0], "terminal.keep");
});
