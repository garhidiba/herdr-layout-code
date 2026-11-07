// node --test mods/vscode-tabs/test/drag.test.mjs
// Dragging a tab into the shown tab (drag.js): when a press is a drag, the content area, its drop zones and preview.
import test from "node:test";
import assert from "node:assert/strict";
import { dragStarted, contentRect, dropZone, zoneRect, dragTerminal, STATUS } from "../drag.js";

const bar = { x: 300, y: 0, width: 800, height: 40 };
const win = { width: 1100, height: 724 };
const rect = contentRect(bar, win); // x 300..1100, y 40..700

test("a press becomes a drag past 4 px, not before", () => {
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 13, y: 10 }), false);
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 13, y: 13 }), true);
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 10, y: 15 }), true);
});

test("the content area is below the bar, as wide, down to the status bar", () => {
  assert.deepEqual(rect, { x: 300, y: 40, width: 800, height: 724 - 40 - STATUS });
  assert.equal(contentRect(bar, { width: 10, height: 10 }).height, 0);
});

test("the nearest edge picks the zone: left, right, up, down", () => {
  assert.equal(dropZone(rect, { x: 320, y: 370 }), "left");
  assert.equal(dropZone(rect, { x: 1080, y: 370 }), "right");
  assert.equal(dropZone(rect, { x: 700, y: 60 }), "up");
  assert.equal(dropZone(rect, { x: 700, y: 690 }), "down");
  assert.equal(dropZone(rect, { x: 800, y: 370 }), "right", "right of the middle");
});

test("outside the content (the bar, the sidebar, past the bottom) there is no zone", () => {
  for (const pos of [{ x: 700, y: 20 }, { x: 100, y: 370 }, { x: 700, y: 710 }]) assert.equal(dropZone(rect, pos), null, JSON.stringify(pos));
  assert.equal(dropZone({ ...rect, height: 0 }, { x: 700, y: 40 }), null);
  assert.equal(dropZone(null, { x: 1, y: 1 }), null);
});

test("the preview covers the zone's half", () => {
  assert.deepEqual(zoneRect(rect, "left"), { ...rect, width: 400 });
  assert.deepEqual(zoneRect(rect, "right"), { ...rect, x: 700, width: 400 });
  assert.deepEqual(zoneRect(rect, "up"), { ...rect, height: rect.height / 2 });
  assert.deepEqual(zoneRect(rect, "down"), { ...rect, y: 40 + rect.height / 2, height: rect.height / 2 });
  assert.equal(zoneRect(rect, null), null);
});

test("a dragged tab moves its one terminal; not the shown tab, a mod pane or a tab of several panes", () => {
  const panes = [
    { pane: "p1", tab: "a", terminal: "t1" }, { pane: "p2", tab: "b", terminal: "t2" },
    { pane: "p3", tab: "c", terminal: null, mod: "vscode-viewer" }, { pane: "p4", tab: "d", terminal: "t4" }, { pane: "p5", tab: "d", terminal: "t5" },
  ];
  assert.equal(dragTerminal("b", "a", panes), "t2");
  assert.equal(dragTerminal("a", "a", panes), null);
  assert.equal(dragTerminal("c", "a", panes), null);
  assert.equal(dragTerminal("d", "a", panes), null);
  assert.equal(dragTerminal("gone", "a", panes), null);
});
