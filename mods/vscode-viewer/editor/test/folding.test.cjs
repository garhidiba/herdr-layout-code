// node --test mods/vscode-viewer/editor/test
require("./no-inline.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const FD = require("../folding.cjs");
const H = require("../highlight.cjs");
const { Editor } = require("../vsedit.cjs");

const plain = (s) => s.replace(/\x1b\[[\d;]*[mHq]|\x1b\[\?[\d;]*[hl]|\x1b\][^\x07]*\x07|\x1b[78]/g, "");
const GO = ["func main() {", "\tif x {", "\t\ty()", "", "\t\tz()", "\t}", "}", "", "func b() {", "\treturn", "}"];
const editor = (lines, scope = "source.go") => {
  const ed = new Editor("/tmp/fold.go", { lines: [...lines], eol: "\n", finalNewline: true }, { grammar: null, colorMap: [], textmate: { INITIAL: null } }, H.loadTheme(), scope);
  ed.rows = 14; ed.cols = 40;
  return ed;
};
const rowsOf = (ed) => plain(ed.render().out).split("\n")[0];

// ---------- ranges ----------
test("a line followed by deeper lines heads a range up to the last line before one as shallow; the closer stays out", () => {
  assert.deepEqual(FD.foldRanges(GO, 4), [{ start: 0, end: 5 }, { start: 1, end: 4 }, { start: 8, end: 9 }]);
});

test("blank lines inside a block belong to it, except in off-side languages (Python), where a block ends at its last content line", () => {
  const py = ["def f():", "    a", "", "def g():", "    b"];
  assert.deepEqual(FD.foldRanges(py, 4), [{ start: 0, end: 2 }, { start: 3, end: 4 }]);
  assert.deepEqual(FD.foldRanges(py, 4, FD.offSide("source.python")), [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});

test("#region / #endregion markers fold from the start marker through the end marker, whatever the indentation", () => {
  const ts = ["// #region setup", "a()", "b()", "// #endregion", "c()"];
  assert.deepEqual(FD.foldRanges(ts, 4), [{ start: 0, end: 3 }]);
  assert.deepEqual(FD.foldRanges(["#region x", "y", "#endregion"], 4), [{ start: 0, end: 2 }], "C#-style");
  assert.deepEqual(FD.foldRanges(["region = 1", "  b"], 4), [{ start: 0, end: 1 }], "a plain word `region` is no marker");
  assert.deepEqual(FD.foldRanges(["// #region", "a"], 4), [], "a start marker without an end is a plain line");
});

test("past the range limit the outermost ranges are kept", () => {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push("a {", "  b {", "    c", "  }", "}");
  const r = FD.foldRanges(lines, 2);
  assert.equal(r.length, FD.MAX_RANGES);
  assert.equal(r.filter(x => lines[x.start] === "a {").length, 3000, "every top-level range");
});

test("innermost / rangeAt: the deepest range holding a line, the range a line heads", () => {
  const r = FD.foldRanges(GO, 4);
  assert.deepEqual(FD.innermost(r, 2), { start: 1, end: 4 });
  assert.deepEqual(FD.innermost(r, 1), { start: 1, end: 4 }, "a header is in its own range");
  assert.deepEqual(FD.innermost(r, 1, x => x.start !== 1), { start: 0, end: 5 }, "skipping one: its parent");
  assert.equal(FD.innermost(r, 7), null);
  assert.deepEqual(FD.rangeAt(r, 8), { start: 8, end: 9 }); assert.equal(FD.rangeAt(r, 2), null);
});

// ---------- the view ----------
test("collapsed folds hide their lines: view rows skip them, both ways", () => {
  const f = new FD.Folds();
  f.collapse([{ start: 1, end: 4 }, { start: 8, end: 9 }]);
  assert.deepEqual([0, 1, 5, 6, 7, 8, 10].map(l => f.toView(l)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(v => f.fromView(v)), [0, 1, 5, 6, 7, 8, 10]);
  assert.equal(f.toView(3), 1, "a hidden line sits on its header's row");
  assert.equal(f.next(1), 5); assert.equal(f.next(5), 6);
  assert.equal(f.viewCount(11), 7);
  assert.equal(f.isHidden(2), true); assert.equal(f.isHidden(1), false);
});

test("nested folds: the outer one hides the inner one's header; revealing a line opens every fold around it", () => {
  const f = new FD.Folds();
  f.collapse([{ start: 0, end: 5 }, { start: 1, end: 4 }]);
  assert.equal(f.viewCount(7), 2);
  assert.equal(f.visible(3), 0, "folds into the outer header");
  assert.equal(f.reveal(3), true);
  assert.equal(f.any, false);
  assert.equal(f.reveal(3), false, "already visible");
});

test("edits: folds below shift, a header edited in place stays, an edit reaching hidden lines unfolds", () => {
  const f = new FD.Folds();
  f.collapse([{ start: 4, end: 6 }]);
  f.onEdit(1, 1, 3); // a line above split into three
  assert.deepEqual(f.list, [{ start: 6, end: 8 }]);
  f.onEdit(6, 1, 1); // typing on the header
  assert.deepEqual(f.list, [{ start: 6, end: 8 }]);
  f.onEdit(10, 1, 1); // below
  assert.deepEqual(f.list, [{ start: 6, end: 8 }]);
  f.onEdit(7, 1, 1); // a hidden line
  assert.deepEqual(f.list, []);
});

test("recomputed ranges: a fold takes its header's new end, and goes when the header heads nothing", () => {
  const f = new FD.Folds();
  f.collapse([{ start: 0, end: 2 }, { start: 5, end: 6 }]);
  assert.equal(f.sync([{ start: 0, end: 3 }]), true);
  assert.deepEqual(f.list, [{ start: 0, end: 3 }]);
  assert.equal(f.sync([{ start: 0, end: 3 }]), false, "unchanged");
});

// ---------- the editor ----------
test("Fold at the cursor hides the block: the header shows ⋯, the next row is the line after the block, numbers stay real", () => {
  const ed = editor(GO);
  ed.moveTo({ line: 2, col: 1 });
  ed.runCommand("editor.fold");
  assert.equal(ed.head.line, 1, "the hidden cursor went to the header");
  const out = plain(ed.render().out);
  assert.ok(out.includes("2 ›│   if x { ⋯"), "the header with its chevron and the collapsed marker");
  assert.ok(out.includes("⋯                         6  │   }"), "line 6 right after the folded header");
  assert.ok(!out.includes("y()"), "hidden lines not painted");
  ed.handle({ type: "key", name: "down" });
  assert.equal(ed.head.line, 5, "down skips the fold");
  ed.handle({ type: "key", name: "up" });
  assert.equal(ed.head.line, 1);
  ed.runCommand("editor.unfold");
  assert.ok(plain(ed.render().out).includes("y()"));
});

test("moving the cursor into a fold or editing inside it unfolds it; Toggle Fold, Fold All, Unfold All", () => {
  const ed = editor(GO);
  ed.moveTo({ line: 1, col: 0 });
  ed.runCommand("editor.toggleFold");
  assert.equal(ed.folds.has(1), true);
  ed.gotoText("3");
  assert.equal(ed.folds.any, false, "Go to Line into the fold opened it");
  ed.runCommand("editor.foldAll");
  assert.deepEqual(ed.folds.list.map(f => f.start), [0, 1, 8]);
  assert.equal(ed.head.line, 0, "the cursor went to the outermost header");
  assert.equal(ed.viewCount, 5);
  ed.replaceAll(GO.join("\n").replace("y()", "w()"));
  assert.equal(ed.folds.any, false, "an edit inside unfolds");
  ed.runCommand("editor.foldAll"); ed.runCommand("editor.unfoldAll");
  assert.equal(ed.folds.any, false);
  ed.moveTo({ line: 1, col: 0 }); ed.runCommand("editor.toggleFold"); ed.runCommand("editor.toggleFold");
  assert.equal(ed.folds.any, false, "toggle twice");
});

test("chevrons show while the pointer is on the gutter (⌄ open, › always for a collapsed fold); a click toggles them", () => {
  const ed = editor(GO), motion = (x, y) => ({ type: "mouse", button: 3, x, y, motion: true, release: false });
  ed.redraw = () => {};
  ed.render();
  assert.ok(!plain(ed.render().out).includes("⌄"), "hidden until the pointer is on the gutter");
  ed.hover(motion(2, 3));
  assert.equal(ed.gutterHover, true);
  assert.ok(plain(ed.render().out).includes("2 ⌄"), "line 2 heads a range");
  const press = { type: "mouse", button: 0, x: ed.gutter, y: 3, motion: false, release: false };
  ed.handle(press); ed.handle({ ...press, release: true });
  assert.equal(ed.folds.has(1), true, "the click collapsed it");
  assert.deepEqual(ed.head, { line: 0, col: 0 }, "the cursor stays");
  ed.hover(motion(20, 3));
  assert.ok(plain(ed.render().out).includes("2 ›"), "a collapsed chevron shows without the pointer");
  ed.handle(press); ed.handle({ ...press, release: true });
  assert.equal(ed.folds.any, false, "and expands again");
});

test("the scrollbar and paging count view rows: a folded file is shorter", () => {
  const lines = ["top {", ...Array.from({ length: 200 }, (_, i) => `  line ${i}`), "}", ...Array.from({ length: 5 }, (_, i) => `tail ${i}`)];
  const ed = editor(lines);
  ed.render();
  assert.equal(ed.vbar.shown, true);
  ed.runCommand("editor.fold");
  ed.render();
  assert.equal(ed.viewCount, 7);
  assert.equal(ed.vbar.shown, false, "7 rows fit");
  ed.handle({ type: "key", name: "pagedown" });
  assert.equal(ed.head.line, 206, "page down by rows: the last line");
});
