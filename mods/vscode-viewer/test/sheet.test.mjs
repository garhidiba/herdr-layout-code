// node --test mods/vscode-viewer/test/sheet.test.mjs
// The CSV sheet's grid (sheet.js) driven through a stand-in for gpui (gpui-stub.mjs): frozen panes, and edits landing
// on the right rows of the file.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { texts, handler, fakeCx } from "./gpui-stub.mjs";
import { sheetOf } from "../csv.js";
import { selectCell } from "../selection.js";

register("./gpui-loader.mjs", import.meta.url);
const { SheetGrid } = await import("../sheet.js");
const COLORS = { bg: "#000", fg: "#fff", grid: "#333", head: "#111", dim: "#888", accent: "#61afef", hover: "#222" };

// A 600 x 400 grid of `rows` with every column 100 px wide (row numbers 40 px); commits are recorded.
function gridOf(rows, readonly = false) {
  const commits = [], cx = fakeCx();
  const grid = new SheetGrid(cx, { commit: (edits) => { commits.push(edits); return true; }, undo() {}, redo() {} });
  const sheet = sheetOf(rows);
  sheet.widths = sheet.widths.map(() => 100);
  grid.width = 600; grid.height = 400;
  const draw = () => grid.render(sheet, COLORS, readonly, cx);
  draw();
  return { grid, sheet, commits, cx, draw };
}
const table = (n, cols = 10) => [Array.from({ length: cols }, (_, c) => `h${c}`), ...Array.from({ length: n }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r + 1}c${c}`))];

test("the toolbar says how to edit, or that the file is read-only", () => {
  assert.ok(texts(gridOf(table(3)).draw()).includes("Double-click, Enter or type to edit a cell"));
  assert.ok(texts(gridOf(table(3), true).draw()).includes("Read-only (remote)"));
});

test("Freeze at the active cell holds the rows above it and the columns left of it while the rest scrolls", () => {
  const { grid, cx, draw } = gridOf(table(50));
  grid.sel = selectCell(5, 2);
  handler(draw(), "csv-freeze")(null, cx);
  draw();
  grid.scroll(150, 220, cx);
  draw();
  // Frozen: rows 0..4 from y 20, columns A..B from x 40; the scrolled panes start at y 130 and x 240.
  assert.deepEqual(grid.hit({ x: 45, y: 25 }), { r: 0, c: 0 });
  assert.deepEqual(grid.hit({ x: 250, y: 100 }), { r: 3, c: 3 }, "frozen row, scrolled column (240 + 150 px in)");
  assert.deepEqual(grid.hit({ x: 100, y: 140 }), { r: 15, c: 0 }, "scrolled row (220 px = 10 rows in), frozen column");
  assert.deepEqual(grid.hit({ x: 30, y: 10 }), { r: -1, c: -1 }, "the corner");
});

test("a frozen cell never scrolls into view; a scrolled one does", () => {
  const { grid, cx, draw } = gridOf(table(50));
  grid.sel = selectCell(5, 2);
  handler(draw(), "csv-freeze")(null, cx);
  draw();
  grid.scroll(150, 220, cx);
  grid.reveal({ r: 2, c: 1 });
  assert.deepEqual([grid.x, grid.y], [150, 220]);
  grid.reveal({ r: 5, c: 2 });
  assert.deepEqual([grid.x, grid.y], [0, 0]);
});

test("frozen panes are held to half the grid, and Unfreeze goes back to the header row alone", () => {
  const { grid, cx, draw } = gridOf(table(50));
  grid.sel = selectCell(40, 9);
  handler(draw(), "csv-freeze")(null, cx);
  draw();
  assert.ok(grid.g.fr * 22 <= 200 && grid.g.frozenW <= 280, `fr ${grid.g.fr}, frozen ${grid.g.frozenW}px`);
  handler(draw(), "csv-unfreeze")(null, cx);
  draw();
  assert.deepEqual([grid.g.fr, grid.g.fc], [1, 0]);
});
