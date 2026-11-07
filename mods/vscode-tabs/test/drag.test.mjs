// node --test mods/vscode-tabs/test/drag.test.mjs
// Dragging a tab into the shown tab (drag.js): when a press is a drag, the panes' area, its drop zones and preview.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dragStarted, panesRect, headersRect, paneRects, dropTarget, dropZone, zoneRect, dragSource, find } from "../drag.js";

// layouts/vscode.json as shipped: work-body padding 8, gap 8; the side panel 368px, shown; the status bar 28px.
const shipped = JSON.parse(readFileSync(new URL("../../../layouts/vscode.json", import.meta.url), "utf8"));
const bar = { x: 268, y: 0, width: 1012, height: 42 }; // the work column, right of the 268px sidebar
const win = { width: 1280, height: 800 };
const withPanel = (panel) => {
  const tree = structuredClone(shipped);
  Object.assign(find(tree, "panel"), panel);
  return tree;
};

test("a press becomes a drag past 4 px, not before", () => {
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 13, y: 10 }), false);
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 13, y: 13 }), true);
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 10, y: 15 }), true);
});

test("the panes are below the bar, left of the side panel while it shows, above the status bar, inside the padding", () => {
  // x 276 .. 1280-8-368-8 = 896; y 50 .. 800-28-8 = 764
  assert.deepEqual(panesRect(bar, win, shipped), { x: 276, y: 50, width: 1012 - 16 - 376, height: 714 });
  assert.deepEqual(panesRect(bar, win, withPanel({ hidden: true })), { x: 276, y: 50, width: 996, height: 714 });
  assert.equal(panesRect(bar, win, withPanel({ size: { px: 500 } })).width, 1012 - 16 - 508, "a dragged-wider panel");
  // The sidebar collapsed: the bar (and the work column) start further left; the panes follow it.
  assert.equal(panesRect({ ...bar, x: 44, width: 1236 }, win, shipped).x, 52);
});

test("with no layout tree, the panes are the whole area below the bar", () => {
  assert.deepEqual(panesRect(bar, win, null), { x: 268, y: 42, width: 1012, height: 758 });
  assert.equal(panesRect(bar, { width: 10, height: 10 }, shipped).height, 0);
});

test("over the side panel there is no zone; over the panes, the nearest edge", () => {
  const rect = panesRect(bar, win, shipped); // x 276..896, y 50..764
  assert.equal(dropZone(rect, { x: 1000, y: 400 }), null, "the Explorer");
  assert.equal(dropZone(rect, { x: 880, y: 400 }), "right");
  assert.equal(dropZone(rect, { x: 290, y: 400 }), "left");
  assert.equal(dropZone(rect, { x: 586, y: 60 }), "up");
  assert.equal(dropZone(rect, { x: 586, y: 750 }), "down");
  for (const pos of [{ x: 586, y: 20 }, { x: 100, y: 400 }, { x: 586, y: 790 }]) assert.equal(dropZone(rect, pos), null, JSON.stringify(pos));
  assert.equal(dropZone({ ...rect, height: 0 }, { x: 586, y: 50 }), null);
  assert.equal(dropZone(null, { x: 1, y: 1 }), null);
});

test("the preview covers the zone's half of the panes, never the side panel", () => {
  const rect = panesRect(bar, win, shipped);
  assert.deepEqual(zoneRect(rect, "right"), { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 });
  assert.ok(zoneRect(rect, "right").x + zoneRect(rect, "right").width <= 1280 - 8 - 368 - 8);
  assert.deepEqual(zoneRect(rect, "left"), { ...rect, width: rect.width / 2 });
  assert.deepEqual(zoneRect(rect, "up"), { ...rect, height: rect.height / 2 });
  assert.deepEqual(zoneRect(rect, "down"), { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 });
  assert.equal(zoneRect(rect, null), null);
});

// The field test's tab: Claude Code (left) | board_grpc.pb.go (right), each header 30px tall at the panes' top.
const area = { x: 276, y: 50, width: 620, height: 714 };
const side = { L: { x: 276, y: 50, width: 306, height: 30 }, R: { x: 590, y: 50, width: 306, height: 30 } };

test("each pane's rect runs from its header down to the panes' bottom, or to the header below it", () => {
  assert.deepEqual(paneRects(side, ["L", "R"], area), [
    { pane: "L", x: 276, y: 50, width: 306, height: 714 }, { pane: "R", x: 590, y: 50, width: 306, height: 714 }]);
  // R split down: R top half, its lower pane D under it; L still full height.
  const split = { ...side, D: { x: 590, y: 411, width: 306, height: 30 } };
  const rects = paneRects(split, ["L", "R", "D"], area);
  assert.deepEqual(rects.map(r => [r.pane, r.y, r.height]), [["L", 50, 714], ["R", 50, 411 - 8 - 50], ["D", 411, 764 - 411]]);
  assert.deepEqual(paneRects(side, ["L", "R", "nohead"], area).map(r => r.pane), ["L", "R"], "a pane without a header is left out");
  assert.deepEqual(paneRects(null, ["L"], area), []);
});

test("a drop splits the pane under the pointer, by that pane's own zones", () => {
  const rects = paneRects(side, ["L", "R"], area);
  const hit = dropTarget(rects, area, { x: 740, y: 700 }); // low in the right pane
  assert.equal(hit.beside, "R");
  assert.equal(hit.zone, "down");
  assert.deepEqual(zoneRect(hit.rect, hit.zone), { pane: "R", x: 590, y: 50 + 357, width: 306, height: 357 }, "the right pane's lower half only");
  assert.deepEqual([dropTarget(rects, area, { x: 300, y: 400 }).beside, dropTarget(rects, area, { x: 300, y: 400 }).zone], ["L", "left"]);
  assert.equal(dropTarget(rects, area, { x: 1000, y: 400 }), null, "the side panel");
  // With no header known, the whole area's zone, splitting the focused pane.
  assert.deepEqual(dropTarget([], area, { x: 586, y: 750 }), { beside: null, rect: area, zone: "down" });
});

test("a dragged tab moves its one pane, a terminal or a viewer; not the shown tab or a tab of several panes", () => {
  const panes = [
    { pane: "p1", tab: "a", terminal: "t1" }, { pane: "p2", tab: "b", terminal: "t2" },
    { pane: "p3", tab: "c", terminal: null, mod: "vscode-viewer" }, { pane: "p4", tab: "d", terminal: "t4" }, { pane: "p5", tab: "d", terminal: "t5" },
    { pane: "p6", tab: "e", terminal: null, mod: "other-mod" },
  ];
  assert.deepEqual(dragSource("b", "a", panes), { terminal: "t2" });
  assert.deepEqual(dragSource("c", "a", panes), { pane: "p3" });
  for (const id of ["a", "d", "e", "gone"]) assert.equal(dragSource(id, "a", panes), null, id);
});

test("a drag from the Explorer (no tab bar bounds) takes the box around the shown panes' headers, down to the panes' bottom", () => {
  const headers = { a: { x: 276, y: 50, width: 306, height: 30 }, b: { x: 590, y: 50, width: 306, height: 30 }, gone: { x: 0, y: 0, width: 9, height: 9 } };
  assert.deepEqual(headersRect(headers, ["a", "b"], win, shipped), { x: 276, y: 50, width: 620, height: 714 });
  assert.equal(headersRect(headers, ["c"], win, shipped), null, "no header known: no drop zones");
  assert.equal(headersRect(undefined, ["a"], win, shipped), null);
});
