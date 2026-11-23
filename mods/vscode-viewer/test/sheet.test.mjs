// node --test mods/vscode-viewer/test/sheet.test.mjs
// The CSV sheet's grid (sheet.js) driven through a stand-in for gpui (gpui-stub.mjs): frozen panes, and edits landing
// on the right rows of the file.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { texts, handler, fakeCx } from "./gpui-stub.mjs";
import { sheetOf } from "../csv.js";
import { selectCell, rectOf } from "../selection.js";

register("./gpui-loader.mjs", import.meta.url);
const { SheetGrid } = await import("../sheet.js");
const COLORS = { bg: "#000", fg: "#fff", grid: "#333", head: "#111", dim: "#888", accent: "#61afef", hover: "#222" };

// A 600 x 400 grid of `rows` with every column 100 px wide (row numbers 40 px); commits are recorded.
function gridOf(rows, readonly = false) {
  const commits = [], reshapes = [], cx = fakeCx();
  const grid = new SheetGrid(cx, { commit: (edits) => { commits.push(edits); return true; }, reshape: (op) => { reshapes.push(op); return true; }, undo() {}, redo() {} });
  const sheet = sheetOf(rows);
  sheet.widths = sheet.widths.map(() => 100);
  grid.width = 600; grid.height = 400;
  const draw = () => cx.rendering(() => grid.render(sheet, COLORS, readonly, cx));
  draw();
  return { grid, sheet, commits, reshapes, cx, draw };
}
const table = (n, cols = 10) => [Array.from({ length: cols }, (_, c) => `h${c}`), ...Array.from({ length: n }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r + 1}c${c}`))];

test("the toolbar says how to edit, or that the file is read-only", () => {
  assert.ok(texts(gridOf(table(3)).draw()).includes("Double-click, Enter or type to edit a cell; right-click for rows and columns"));
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
// Column B (index 1) spans x 140..240; its header's sort mark is the last 24 px.
const SORT_B = [218, 30];
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

test("the toolbar's Sort ▲ / Sort ▼ sort by the active column, and Unsort goes back to the file's order", () => {
  const { grid, cx, draw, sheet } = gridOf(people());
  const ages = () => { draw(); return Array.from({ length: grid.g.rows - 1 }, (_, i) => sheet.rows[grid.src(i + 1)][1]); };
  grid.mouseDown(press(150, 20 + 22 * 2 + 5), cx);  // a cell in column B
  handler(draw(), "csv-sort-up")(null, cx);
  assert.deepEqual(ages(), ["4", "30", "100", ""]);
  handler(draw(), "csv-sort-down")(null, cx);
  assert.deepEqual(ages(), ["100", "30", "4", ""]);
  assert.ok(texts(draw()).includes("Unsort B"));
  handler(draw(), "csv-unsort")(null, cx);
  assert.deepEqual(ages(), ["30", "4", "", "100"]);
  assert.equal(handler(draw(), "csv-unsort"), null, "no Unsort while unsorted");
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

// Types `text` into the toolbar's filter input, as the input's change event reports it.
const typeFilter = (grid, cx, text) => { grid.filterInput.set_value(text); grid.filterInput.handlers.change(null, cx); };

test("the filter input filters the active column, counts the rows shown, and edits land on the file rows", () => {
  const { grid, commits, cx, draw, sheet } = gridOf(people());
  grid.sel = selectCell(1, 0);
  assert.ok(texts(draw()).includes("Filter A"));
  typeFilter(grid, cx, "무");  // 나무, file row 3
  const shown = texts(draw());
  assert.equal(grid.g.rows, 2);
  assert.ok(shown.includes("1 of 4 rows"), shown.join("|"));
  assert.equal(sheet.rows[grid.src(1)][0], "나무");
  grid.sel = selectCell(1, 1);
  grid.keyDown(key("7", "7"), cx);
  grid.keyDown(key("enter"), cx);
  assert.deepEqual(commits.pop(), [{ r: 3, c: 1, value: "7" }]);
});

test("the filter input follows the selection to another column; a chip or Esc clears a filter", () => {
  const { grid, cx, draw } = gridOf(people());
  grid.sel = selectCell(1, 0);
  draw();
  typeFilter(grid, cx, "가");
  draw();
  grid.sel = selectCell(1, 1);
  assert.ok(texts(draw()).includes("Filter B"));
  assert.equal(grid.filterInput.value(), "", "column B has no filter yet");
  typeFilter(grid, cx, "4");
  draw();
  assert.equal(grid.g.rows, 2, "both filters apply: 가방, 4");
  handler(draw(), "csv-unfilter-0")(null, cx);
  draw();
  assert.deepEqual([...grid.filters], [[1, "4"]]);
  handler(draw(), "csv-filter", "on_key_down")({ key: "escape", modifiers: {} }, cx);
  assert.equal(grid.filters.size, 0);
  assert.equal(grid.filterInput.value(), "");
  draw();
  assert.equal(grid.order, null, "no filter and no sort: the file's own rows");
});

test("while the view's rows are being worked out, edits wait instead of writing rows by a stale order", () => {
  const { grid, commits, cx } = gridOf(people());
  grid.pending = true;
  grid.keyDown(key("x", "x"), cx);
  grid.keyDown(key("delete"), cx);
  assert.equal(grid.edit, null);
  assert.deepEqual(commits, []);
  assert.match(grid.note, /try again/);
});

// The render starts the later slices: the task must not notify before its first await (the app refuses a notify
// during render, which left the sort pending forever).
test("a large sort lands across ticks with the same order", async () => {
  const rows = [["n"], ...Array.from({ length: 60000 }, (_, i) => [String((i * 7919) % 60013)])];
  const { grid, cx, draw } = gridOf(rows);
  const t0 = Date.now();
  grid.mouseDown(press(150, 30), cx);  // column A's sort mark (row numbers 56 px wide here, so A is 56..156)
  draw();
  assert.ok(Date.now() - t0 < 100, "the first slice is short");
  await cx.idle();
  draw();
  assert.equal(grid.pending, false);
  const vals = Array.from({ length: 60000 }, (_, i) => Number(rows[grid.src(i + 1)][0]));
  assert.ok(vals.every((v, i) => i === 0 || vals[i - 1] <= v));
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

// Column widths by hand: every column 100 px from x 40, so column c's right edge is at 140 + 100c.
const drag = (grid, cx, from, to, y = 10) => {
  grid.mouseDown(press(from, y), cx);
  grid.pointerMove({ position: { x: to, y } }, cx);
  grid.pointerUp();
};

test("a column's right edge is grabbed within 4 px in the letters and header rows, frozen or scrolled", () => {
  const { grid, cx, draw } = gridOf(table(50));
  assert.equal(grid.edgeAt({ x: 243, y: 10 }), 1, "letters row, B's right edge");
  assert.equal(grid.edgeAt({ x: 137, y: 30 }), 0, "header row, A's right edge");
  assert.equal(grid.edgeAt({ x: 245, y: 10 }), null, "5 px off");
  assert.equal(grid.edgeAt({ x: 240, y: 50 }), null, "not in the data rows");
  grid.sel = selectCell(1, 2);
  handler(draw(), "csv-freeze")(null, cx);
  draw();
  grid.scroll(150, 0, cx);
  draw();
  // A..B frozen (edges 140, 240); the rest scrolled 150 px past them, so C's edge (190) hides behind them and D's is at 290.
  assert.equal(grid.edgeAt({ x: 241, y: 10 }), 1, "the frozen pane's last edge");
  assert.equal(grid.edgeAt({ x: 290, y: 30 }), 3, "a scrolled column's edge");
  assert.equal(grid.edgeAt({ x: 190, y: 10 }), null, "an edge scrolled behind the frozen pane");
});

test("dragging a column's edge sizes it live, past the grid too, held to 30 px at least", () => {
  const { grid, cx, draw } = gridOf(table(5));
  drag(grid, cx, 240, 300);
  draw();
  assert.equal(grid.g.widths[1], 160);
  assert.equal(grid.g.starts[2], 260, "the columns after it move over");
  assert.deepEqual(grid.hit({ x: 290, y: 30 }), { r: 0, c: 1 });
  drag(grid, cx, 300, -500, 30);
  draw();
  assert.equal(grid.g.widths[1], 30);
  assert.equal(grid.sort, null, "a grab on the header's edge does not sort");
  grid.pointerMove({ position: { x: 600, y: 10 } }, cx);
  draw();
  assert.equal(grid.g.widths[1], 30, "the drag ends on release");
});

test("a double-click on a column's edge fits it back to its measured width", () => {
  const { grid, cx, draw } = gridOf(table(5));
  drag(grid, cx, 240, 300);
  draw();
  grid.mouseDown(press(300, 10), cx);
  grid.mouseDown(press(300, 10, { click_count: 2 }), cx);
  grid.pointerUp();
  draw();
  assert.equal(grid.g.widths[1], 100);
});

test("a width set by hand stays when the sheet is parsed again", () => {
  const { grid, cx } = gridOf(table(5));
  drag(grid, cx, 240, 300);
  const again = sheetOf(table(6));
  again.widths = again.widths.map(() => 100);
  cx.rendering(() => grid.render(again, COLORS, false, cx));
  assert.equal(grid.g.widths[1], 160);
});

test("clicks just outside an edge still select the column and sort", () => {
  const { grid, cx } = gridOf(table(5));
  grid.mouseDown(press(235, 10), cx);
  grid.pointerUp();
  assert.deepEqual([grid.sel.anchor.c, grid.sel.focus.c], [1, 1]);
  grid.mouseDown(press(235, 30), cx);
  assert.deepEqual(grid.sort, { c: 1, dir: 1 });
  assert.equal(grid.g.widths[1], 100);
});

const cmdKey = (k, extra = {}) => ({ key: k, modifiers: { platform: true, ...extra } });
const range = (r0, c0, r1, c1) => ({ anchor: { r: r0, c: c0 }, focus: { r: r1, c: c1 }, active: { r: r0, c: c0 } });

test("⌘V with one copied value fills the whole selection; a copied block repeats over a multiple of it", () => {
  const { grid, commits, cx } = gridOf(table(6, 3));
  cx.clip = "x\n";
  grid.sel = range(1, 0, 2, 1);
  grid.keyDown(cmdKey("v"), cx);
  assert.deepEqual(commits.pop(), [{ r: 1, c: 0, value: "x" }, { r: 1, c: 1, value: "x" }, { r: 2, c: 0, value: "x" }, { r: 2, c: 1, value: "x" }]);
  cx.clip = "a\tb";
  grid.sel = range(3, 0, 4, 1);
  grid.keyDown(cmdKey("v"), cx);
  assert.deepEqual(commits.pop().map(e => e.value), ["a", "b", "a", "b"], "a copied row into two rows");
  assert.deepEqual(grid.sel, range(3, 0, 4, 1));
});

test("⌃D fills down from the selection's first row, ⌘R right from its first column", () => {
  const { grid, commits, cx } = gridOf(table(4, 3));
  grid.sel = range(1, 0, 3, 0);
  grid.keyDown({ key: "d", modifiers: { control: true } }, cx);
  assert.deepEqual(commits.pop(), [{ r: 2, c: 0, value: "r1c0" }, { r: 3, c: 0, value: "r1c0" }]);
  grid.sel = selectCell(2, 2);
  grid.keyDown(cmdKey("r"), cx);
  assert.deepEqual(commits.pop(), [{ r: 2, c: 2, value: "r2c1" }], "one cell takes the one left of it");
});

const altCmd = (k) => cmdKey(k, { alt: true });

test("⌥⌘= inserts as many blank rows above the selection as it spans, ⌥⌘- deletes its rows", () => {
  const { grid, reshapes, cx } = gridOf(table(5, 2));
  grid.sel = range(2, 0, 3, 1);
  grid.keyDown(altCmd("="), cx);
  assert.deepEqual(reshapes.pop(), { insertRows: 2, values: [["", ""], ["", ""]] });
  grid.keyDown(altCmd("-"), cx);
  assert.deepEqual(reshapes.pop(), { deleteRows: [2, 3] });
});

test("with whole columns selected, ⌥⌘= and ⌥⌘- insert and delete columns, and widths and filters move with them", () => {
  const { grid, reshapes, cx, draw } = gridOf(table(5, 4));
  drag(grid, cx, 440, 480);  // column D 140 px wide
  grid.filters.set(3, "x");
  grid.sel = range(0, 1, 5, 2);  // columns B..C from the letters
  draw();
  grid.keyDown(altCmd("="), cx);
  assert.deepEqual(reshapes.pop(), { insertCols: 1, count: 2 });
  assert.deepEqual([...grid.widthOf], [[5, 140]]);
  assert.deepEqual([...grid.filters], [[5, "x"]]);
  grid.keyDown(altCmd("-"), cx);
  assert.deepEqual(reshapes.pop(), { deleteCols: 1, count: 2 });
  assert.deepEqual([...grid.filters], [[3, "x"]]);
});

test("a right-click on a row number selects that row and opens the menu; Duplicate copies it below and selects the copy", () => {
  const { grid, reshapes, cx, draw } = gridOf(table(5, 3));
  grid.contextMenu(press(20, 20 + 22 * 3 + 5), cx);  // row 4 (view row 3)
  assert.deepEqual(rectOf(grid.sel), { r0: 3, r1: 3, c0: 0, c1: 2 });
  const shown = texts(draw());
  assert.ok(shown.includes("Insert 1 row above") && shown.includes("Delete 1 row"), shown.join("|"));
  assert.ok(!shown.includes("Delete 3 columns"), "whole rows: no column commands");
  handler(draw(), "csv-menu-copyRows", "on_mouse_down")(null, cx);
  assert.deepEqual(reshapes.pop(), { insertRows: 4, copy: [3] });
  assert.equal(grid.menu, null);
  assert.deepEqual(rectOf(grid.sel), { r0: 4, r1: 4, c0: 0, c1: 2 });
});

test("a right-click inside the selection keeps it; Insert copied rows puts the clipboard's rows above it", () => {
  const { grid, reshapes, cx, draw } = gridOf(table(5, 3));
  grid.sel = range(2, 0, 4, 1);
  grid.contextMenu(press(150, 20 + 22 * 3 + 5), cx);  // row 3, column B: inside
  assert.deepEqual(rectOf(grid.sel), { r0: 2, r1: 4, c0: 0, c1: 1 });
  assert.ok(texts(draw()).includes("Delete 2 columns"), "a cell range offers columns too");
  cx.clip = "a\tb\nc\td\n";
  handler(draw(), "csv-menu-pasteRows", "on_mouse_down")(null, cx);
  assert.deepEqual(reshapes.pop(), { insertRows: 2, values: [["a", "b"], ["c", "d"]] });
});

test("rows are never inserted above the header; in a sorted view row commands reach the file rows on screen", () => {
  const { grid, reshapes, cx, draw } = gridOf(people());
  grid.sel = selectCell(0, 0);
  grid.keyDown(altCmd("="), cx);
  assert.deepEqual(reshapes.pop(), { insertRows: 1, values: [["", ""]] });
  grid.mouseDown(press(...SORT_B), cx);  // age ascending: 가방 (2), 다람쥐 (1), 라면 (4), 나무 (3)
  draw();
  grid.sel = range(1, 0, 2, 0);
  grid.keyDown(altCmd("-"), cx);
  assert.deepEqual(reshapes.pop(), { deleteRows: [2, 1] });
  grid.contextMenu(press(20, 20 + 22 * 3 + 5), cx);  // view row 3: 라면, file row 4
  handler(draw(), "csv-menu-rowsBelow", "on_mouse_down")(null, cx);
  assert.deepEqual(reshapes.pop(), { insertRows: 5, values: [["", ""]] });
});

test("Esc closes the menu, and row commands wait on a read-only file", () => {
  const { grid, reshapes, cx } = gridOf(table(3, 2), true);
  grid.contextMenu(press(60, 20 + 22 * 2 + 5), cx);
  assert.ok(grid.menu);
  grid.keyDown(key("escape"), cx);
  assert.equal(grid.menu, null);
  grid.keyDown(altCmd("-"), cx);
  assert.deepEqual(reshapes, []);
  assert.equal(grid.note, "Read-only (remote)");
});
