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

const press = (x, y, extra = {}) => ({ position: { x, y }, local_position: { x, y }, modifiers: {}, click_count: 1, ...extra });
const key = (k, char) => ({ key: k, key_char: char, modifiers: {} });
// Column B (index 1) spans x 140..240; its header's sort mark is the last 16 px.
const SORT_B = [230, 30];
const people = () => [["name", "age"], ["다람쥐", "30"], ["가방", "4"], ["나무", ""], ["라면", "100"]];

test("typing on a selected cell opens the editor with that character, and Enter writes it to that row", () => {
  const { grid, commits, cx } = gridOf(people());
  grid.mouseDown(press(60, 20 + 22 * 2 + 5), cx);  // row 3 (가방), column A
  assert.deepEqual(grid.sel.active, { r: 2, c: 0 });
  grid.keyDown(key("x", "x"), cx);
  assert.equal(grid.edit.state.value(), "x");
  grid.edit.state.set_value("xyz");
  grid.keyDown(key("enter"), cx);
  assert.deepEqual(commits, [[{ r: 2, c: 0, value: "xyz" }]]);
  assert.deepEqual(grid.sel.active, { r: 3, c: 0 }, "and moves down");
});

test("a click on a header's sort mark cycles ascending, descending and file order; numbers by value, empties last", () => {
  const { grid, cx, draw, sheet } = gridOf(people());
  const names = () => { draw(); return Array.from({ length: grid.g.rows - 1 }, (_, i) => sheet.rows[grid.src(i + 1)][0]); };
  grid.mouseDown(press(...SORT_B), cx);
  assert.deepEqual(names(), ["가방", "다람쥐", "라면", "나무"]);
  grid.mouseDown(press(...SORT_B), cx);
  assert.deepEqual(names(), ["라면", "다람쥐", "가방", "나무"]);
  grid.mouseDown(press(...SORT_B), cx);
  assert.deepEqual(names(), ["다람쥐", "가방", "나무", "라면"]);
  assert.deepEqual(grid.sel.active, { r: 1, c: 0 }, "the sort mark does not select");
});

test("in a sorted view, an edit, a clear and a paste write the file rows on screen, not the view's row numbers", () => {
  const { grid, commits, cx, draw } = gridOf(people());
  grid.mouseDown(press(...SORT_B), cx);  // age ascending: 가방 (2), 다람쥐 (1), 라면 (4), 나무 (3)
  draw();
  grid.sel = selectCell(1, 0);
  grid.keyDown(key("f2"), cx);
  grid.edit.state.set_value("bag");
  grid.keyDown(key("enter"), cx);
  assert.deepEqual(commits.pop(), [{ r: 2, c: 0, value: "bag" }]);
  grid.sel = selectCell(3, 1);
  grid.keyDown(key("delete"), cx);
  assert.deepEqual(commits.pop(), [{ r: 4, c: 1, value: "" }]);
  cx.clip = "p\nq";
  grid.sel = selectCell(2, 0);
  grid.keyDown({ key: "v", modifiers: { platform: true } }, cx);
  assert.deepEqual(commits.pop(), [{ r: 1, c: 0, value: "p" }, { r: 4, c: 0, value: "q" }]);
});

test("copy in a sorted view takes the rows as shown", async () => {
  const { grid, cx, draw } = gridOf(people());
  grid.mouseDown(press(...SORT_B), cx);
  draw();
  grid.sel = { anchor: { r: 1, c: 0 }, focus: { r: 2, c: 1 }, active: { r: 1, c: 0 } };
  grid.keyDown({ key: "c", modifiers: { platform: true } }, cx);
  await cx.idle();
  assert.equal(cx.clip, "가방\t4\n다람쥐\t30");
});
