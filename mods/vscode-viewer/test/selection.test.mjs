// node --test mods/vscode-viewer/test/selection.test.mjs
// The CSV sheet's selection rules (selection.js).
import test from "node:test";
import assert from "node:assert/strict";
import { selectCell, extendTo, selectRows, selectCols, selectAll, rectOf, rectCells, moveBy, clampSel } from "../selection.js";

test("a click selects one cell, which is also the active one", () => {
  const s = selectCell(3, 2);
  assert.deepEqual(rectOf(s), { r0: 3, r1: 3, c0: 2, c1: 2 });
  assert.deepEqual(s.active, { r: 3, c: 2 });
});

test("Shift+click or a drag spans a rectangle from the anchor, in any direction, keeping the active cell", () => {
  const s = extendTo(selectCell(5, 4), 2, 1);
  assert.deepEqual(rectOf(s), { r0: 2, r1: 5, c0: 1, c1: 4 });
  assert.deepEqual(s.active, { r: 5, c: 4 });
  assert.equal(rectCells(rectOf(s)), 16);
});

test("row numbers select whole rows, letters whole columns, the corner everything", () => {
  assert.deepEqual(rectOf(selectRows(4, 2, 5)), { r0: 2, r1: 4, c0: 0, c1: 4 });
  assert.deepEqual(rectOf(selectCols(1, 3, 10)), { r0: 0, r1: 9, c0: 1, c1: 3 });
  assert.deepEqual(rectOf(selectAll(10, 5)), { r0: 0, r1: 9, c0: 0, c1: 4 });
  assert.deepEqual(selectRows(4, 2, 5).active, { r: 4, c: 0 });
});

test("arrows move the active cell and collapse the range; Shift+arrows move the focus; both stay in the sheet", () => {
  const s = extendTo(selectCell(1, 1), 3, 3);
  assert.deepEqual(rectOf(moveBy(s, 1, 0, false, 10, 10)), { r0: 2, r1: 2, c0: 1, c1: 1 }, "from the active cell");
  assert.deepEqual(rectOf(moveBy(s, 0, 1, true, 10, 10)), { r0: 1, r1: 3, c0: 1, c1: 4 });
  assert.deepEqual(rectOf(moveBy(s, -1, -1, true, 10, 10)), { r0: 1, r1: 2, c0: 1, c1: 2 }, "shrinks back toward the anchor");
  assert.deepEqual(moveBy(selectCell(0, 0), -1, -1, false, 10, 10).active, { r: 0, c: 0 });
  assert.deepEqual(moveBy(selectCell(9, 9), 1, 1, false, 10, 10).active, { r: 9, c: 9 });
});

test("a selection is held to a sheet that shrank", () => {
  assert.deepEqual(rectOf(clampSel(extendTo(selectCell(2, 2), 8, 8), 5, 4)), { r0: 2, r1: 4, c0: 2, c1: 3 });
});
