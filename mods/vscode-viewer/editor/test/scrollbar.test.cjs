// node --test mods/vscode-viewer/editor/test
const test = require("node:test");
const assert = require("node:assert/strict");
const SB = require("../scrollbar.cjs");
const H = require("../highlight.cjs");
const { Editor } = require("../vsedit.cjs");

test("the thumb is as long as the visible share of the track, at least one cell, in eighths", () => {
  assert.deepEqual(SB.thumbOf(10, 50, 100, 0), { start: 0, size: 40 }); // half the content: half the track
  assert.deepEqual(SB.thumbOf(10, 1, 1000, 0), { start: 0, size: 8 }); // never shorter than one cell
  assert.equal(SB.thumbOf(10, 20, 20, 0), null, "nothing to scroll: no thumb");
});

test("the thumb moves over the free track in proportion to the scroll position, clamped", () => {
  assert.equal(SB.thumbOf(10, 50, 100, 50).start, 40); // at the end
  assert.equal(SB.thumbOf(10, 50, 100, 25).start, 20); // halfway
  assert.equal(SB.thumbOf(10, 50, 100, 999).start, 40); // past the end stays at the end
});

test("a thumb start maps back to the scroll position it was drawn for", () => {
  for (const pos of [0, 10, 25, 50]) // positions an eighth of a cell can tell apart (40 steps for 50 here) assert.equal(SB.posOf(10, 50, 100, SB.thumbOf(10, 50, 100, pos).start, 40), pos);
  assert.equal(SB.posOf(10, 50, 100, -30, 40), 0);
  assert.equal(SB.posOf(10, 50, 100, 500, 40), 50);
});

test("cells partly covered by the thumb use eighth blocks, colors swapped where the thumb is at the cell's start", () => {
  const v = SB.cellsOf(3, { start: 5, size: 12 }, true); // eighths 5..17: bottom 3/8 of cell 0, cell 1, top 1/8 of cell 2
  assert.deepEqual(v.map(c => c.ch), ["▃", " ", "▇"]);
  assert.deepEqual(v.map(c => [c.fg, c.bg]), [["thumb", "track"], ["thumb", "thumb"], ["track", "thumb"]]);
  const h = SB.cellsOf(3, { start: 5, size: 12 }, false); // right 3/8 of cell 0, cell 1, left 1/8 of cell 2
  assert.deepEqual(h.map(c => c.ch), ["▋", " ", "▏"]);
  assert.deepEqual(h.map(c => [c.fg, c.bg]), [["track", "thumb"], ["thumb", "thumb"], ["thumb", "track"]]);
});

test("hit-testing tells the thumb from the track before and after it", () => {
  const th = { start: 12, size: 16 }; // cells 1..3 (partly 1 and 3)
  assert.deepEqual([0, 1, 2, 3, 4].map(k => SB.partOf(th, k)), ["before", "thumb", "thumb", "thumb", "after"]);
});

const press = (x, y) => ({ type: "mouse", button: 0, x, y, motion: false, release: false });
const motion = (x, y, button = 0) => ({ type: "mouse", button, x, y, motion: true, release: false });
const release = (x, y) => ({ type: "mouse", button: 0, x, y, motion: false, release: true });

test("a bar: a track click jumps the thumb's center there and keeps dragging; a thumb drag moves by the pointer", () => {
  const bar = new SB.Bar(true);
  bar.layout(true, 2, 80, 10, 10, 100, 0); // rows 2..11 in column 80, 10 of 100
  assert.equal(bar.mouse(press(79, 5)), undefined, "not the bar's column");
  assert.equal(bar.mouse(press(80, 11)), 90, "the last cell: the end");
  bar.mouse(release(80, 11));
  bar.layout(true, 2, 80, 10, 10, 100, 0);
  assert.equal(bar.mouse(press(80, 2)), null, "on the thumb: no jump");
  assert.equal(bar.mouse(motion(80, 7)), 50, "5 cells down of 9 free: 50 of 90");
  assert.equal(bar.mouse(motion(80, 99)), 90, "past the end: clamped");
  assert.equal(bar.mouse(release(80, 99)), null);
  assert.equal(bar.drag, null);
  assert.equal(bar.mouse({ ...press(80, 5), button: 64 }), undefined, "the wheel is not the bar's");
});

test("hover follows buttonless motion and repaints only the bar, keeping the cursor", () => {
  const bar = new SB.Bar(true), c = require("../paint.cjs").paletteOf({});
  bar.layout(true, 2, 80, 10, 10, 100, 0);
  assert.equal(SB.hover(motion(80, 3), [[bar]], c) === null, true, "a drag motion is not a hover");
  const out = SB.hover(motion(80, 2, 3), [[bar]], c); // onto the thumb (row 2)
  assert.ok(bar.hover && out.startsWith("\x1b7") && out.endsWith("\x1b8") && out.includes("\x1b[2;80H"));
  assert.equal(SB.hover(motion(80, 2, 3), [[bar]], c), "", "still on it: nothing to repaint");
  assert.notEqual(SB.hover(motion(80, 6, 3), [[bar]], c), "", "onto the track: the highlight goes");
  assert.equal(bar.hover, false);
  assert.equal(SB.hoverMode(bar, true), "\x1b[?1003h");
  assert.equal(SB.hoverMode(bar, true), "");
  assert.equal(SB.hoverMode(bar, false), "\x1b[?1003l\x1b[?1002h", "back to drag-only reports");
});

const editorOf = (lines, rows = 12, cols = 40) => {
  const ed = new Editor("/tmp/sb.txt", { lines, eol: "\n", finalNewline: true }, { grammar: null, colorMap: [], textmate: { INITIAL: null } }, H.loadTheme(), "text");
  ed.rows = rows; ed.cols = cols;
  return ed;
};

test("editor: the vertical bar shows only for a file taller than the view, and takes the last column", () => {
  const short = editorOf(["a", "b"]);
  short.render();
  assert.equal(short.vbar.shown, false);
  assert.equal(short.textWidth, 40 - short.gutter);
  const ed = editorOf(Array.from({ length: 500 }, (_, i) => `line ${i}`));
  const out = ed.render().out;
  assert.equal(ed.vbar.shown, true);
  assert.equal(ed.hbar.shown, false);
  assert.equal(ed.textWidth, 40 - ed.gutter - 1);
  assert.ok(out.includes("\x1b[2;40H"), "painted in the last column");
  assert.ok(out.includes("\x1b[?1003h"), "hover reports on while a bar shows");
});

test("editor: bar clicks scroll without moving the cursor or selecting; the wheel over the horizontal bar scrolls sideways", () => {
  const ed = editorOf([...Array.from({ length: 500 }, (_, i) => `line ${i}`), "x".repeat(200)]);
  ed.render();
  ed.handle(press(40, 11)); ed.handle(release(40, 11)); // the last cell of the vertical track
  assert.equal(ed.top, 500, "jumped to the end");
  assert.deepEqual(ed.sel.head, { line: 0, col: 0 }, "the cursor stays");
  ed.render();
  assert.equal(ed.hbar.shown, true, "the 200-column line is in view");
  const row = ed.hbar.row;
  ed.handle({ type: "mouse", button: 65, x: 20, y: row, motion: false, release: false });
  assert.equal(ed.left, 6);
  ed.handle(press(39, row)); ed.handle(motion(39, row)); ed.handle(release(39, row));
  assert.ok(ed.left > 150, "the end of the horizontal track: the right end of the line");
  assert.equal(ed.empty, true, "no selection");
});

test("editor: overview ruler marks the cursor line and find matches on the vertical bar", () => {
  const ed = editorOf(Array.from({ length: 100 }, (_, i) => (i === 50 ? "needle" : `line ${i}`)));
  ed.find.query = "needle"; ed.prompt = { kind: "find", replace: false, origin: ed.sel };
  ed.render();
  ed.prompt = null;
  const len = ed.vbar.length;
  assert.equal(ed.marks[0], ed.colors.rulerCursor);
  assert.equal(ed.marks[SB.markCell(50, 100, len)], ed.colors.rulerFind);
});
