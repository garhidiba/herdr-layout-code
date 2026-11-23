// node --test mods/vscode-viewer/test/sheetview.test.mjs
// The CSV sheet's view (sheetview.js): frozen panes on one axis.
import test from "node:test";
import assert from "node:assert/strict";
import { axisSpans, axisAt } from "../sheetview.js";

// Rows 22 px from y 20 (under the letters row), the first 5 frozen, scrolled 220 px, the view ending at y 400.
const rows = { frozen: 5, start: i => i * 22, base: 20, scroll: 220, end: 400, at: o => Math.min(49, Math.floor(o / 22)) };

test("a point in the frozen rows is that row, whatever the scroll", () => {
  assert.equal(axisAt(20, rows), 0);
  assert.equal(axisAt(100, rows), 3);
  assert.equal(axisAt(129, rows), 4);
});

test("a point past the frozen rows is a scrolled row: the first scrolled row shown is 5 + scroll / 22", () => {
  assert.equal(axisAt(130, rows), 15);
  assert.equal(axisAt(130 + 22 * 3, rows), 18);
  assert.equal(axisAt(5000, rows), 49, "held to the last row");
});

test("before the base is -1 (the letters row, the row numbers)", () => {
  assert.equal(axisAt(19, rows), -1);
});

test("a span across the frozen edge shows as two boxes, the scrolled part only from where it comes on screen", () => {
  assert.deepEqual(axisSpans(3, 15, rows), [[86, 130], [130, 152]]);
});

test("a span scrolled out of view under the frozen rows is not shown", () => {
  assert.deepEqual(axisSpans(6, 10, rows), []);
  assert.deepEqual(axisSpans(0, 0, rows), [[20, 42]], "the header row is frozen");
});

test("with nothing frozen the whole axis scrolls", () => {
  const cols = { frozen: 0, start: i => i * 100, base: 40, scroll: 150, end: 600, at: o => Math.min(9, Math.floor(o / 100)) };
  assert.equal(axisAt(40, cols), 1);
  assert.deepEqual(axisSpans(0, 2, cols), [[40, 190]]);
});
