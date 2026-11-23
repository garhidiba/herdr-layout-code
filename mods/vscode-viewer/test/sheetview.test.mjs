// node --test mods/vscode-viewer/test/sheetview.test.mjs
// The CSV sheet's view (sheetview.js): frozen panes on one axis.
import test from "node:test";
import assert from "node:assert/strict";
import { axisSpans, axisAt, axisEnd, sourceRow, viewRows } from "../sheetview.js";

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

// viewRows run to the end; a small `step` makes it yield often, as it does in the app.
const run = (it) => { let s; while (!(s = it.next()).done); return s.value; };
const col = (...vals) => [["head"], ...vals.map(v => [v])];
const sorted = (rows, dir, step) => run(viewRows(rows, { sort: { c: 0, dir } }, step)).map(r => rows[r][0]);

test("without a sort the view shows the data rows in file order, the header left out", () => {
  assert.deepEqual(run(viewRows(col("b", "a"))), [1, 2]);
});

test("numbers sort by value, not as text: grouped thousands, decimals, signs and percents too", () => {
  assert.deepEqual(sorted(col("10", "9", "1,200", "-3", "2.5", "50%"), 1), ["-3", "2.5", "9", "10", "50%", "1,200"]);
  assert.deepEqual(sorted(col("10", "9", "1,200"), -1), ["1,200", "10", "9"]);
});

test("Korean text sorts in dictionary order, either way", () => {
  assert.deepEqual(sorted(col("다람쥐", "가방", "나무", "참가자", "조건부 참가자"), 1), ["가방", "나무", "다람쥐", "조건부 참가자", "참가자"]);
  assert.deepEqual(sorted(col("가", "다", "나"), -1), ["다", "나", "가"]);
});

test("empty cells go last both ascending and descending; numbers come before text ascending", () => {
  assert.deepEqual(sorted(col("b", "", "2", " ", "a", "1"), 1), ["1", "2", "a", "b", "", " "]);
  assert.deepEqual(sorted(col("b", "", "2", "a", "1"), -1), ["b", "a", "2", "1", ""]);
});

test("equal values keep their file order (a stable sort), and short rows count as empty", () => {
  const rows = [["k", "id"], ["x", "1"], ["y", "2"], ["x", "3"], [], ["x", "4"]];
  assert.deepEqual(run(viewRows(rows, { sort: { c: 0, dir: -1 } })), [2, 1, 3, 5, 4]);
});

test("worked a slice at a time it yields along the way and lands on the same order", () => {
  const rows = [["n"], ...Array.from({ length: 500 }, (_, i) => [String((i * 37) % 101)])];
  const it = viewRows(rows, { sort: { c: 0, dir: 1 } }, 16);
  let yields = 0, s;
  while (!(s = it.next()).done) yields++;
  assert.ok(yields > 10);
  assert.deepEqual(s.value, run(viewRows(rows, { sort: { c: 0, dir: 1 } }, 1e9)));
  const vals = s.value.map(r => Number(rows[r][0]));
  assert.deepEqual(vals, [...vals].sort((a, b) => a - b));
});

test("a filter keeps the rows whose column contains its text, ignoring case; several filters all apply", () => {
  const rows = [["name", "role"], ["Kim", "조건부 참가자"], ["Lee", "참가자"], ["kimura", "Host"], ["Park", ""]];
  assert.deepEqual(run(viewRows(rows, { filters: [[0, "KIM"]] })), [1, 3]);
  assert.deepEqual(run(viewRows(rows, { filters: [[1, "참가"]] })), [1, 2]);
  assert.deepEqual(run(viewRows(rows, { filters: [[0, "kim"], [1, "참가"]] })), [1]);
  assert.deepEqual(run(viewRows(rows, { filters: [[0, ""]] })), [1, 2, 3, 4], "an empty text filters nothing");
  assert.deepEqual(run(viewRows(rows, { filters: [[5, "x"]] })), [], "a column a row lacks holds nothing");
});

test("filtered rows are then sorted", () => {
  const rows = [["n"], ["b1"], ["a1"], ["c2"], ["a2"]];
  assert.deepEqual(run(viewRows(rows, { filters: [[0, "a"]], sort: { c: 0, dir: -1 } })), [4, 2]);
});

test("a view row maps back to the file row it shows; the header is always row 0", () => {
  assert.equal(sourceRow([3, 1, 2], 0), 0);
  assert.equal(sourceRow([3, 1, 2], 1), 3);
  assert.equal(sourceRow(null, 2), 2, "no order: the file's own");
});

test("a column's drawn right edge, frozen or scrolled (the header's sort mark sits there)", () => {
  const cols = { frozen: 1, start: i => i * 100, base: 40, scroll: 30 };
  assert.equal(axisEnd(0, cols), 140);
  assert.equal(axisEnd(2, cols), 310);
});
