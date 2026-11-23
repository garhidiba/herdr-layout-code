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
  const draw = () => cx.rendering(() => grid.render(sheet, COLORS, readonly, cx));
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
