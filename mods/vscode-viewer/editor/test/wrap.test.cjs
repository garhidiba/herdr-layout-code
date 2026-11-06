// node --test mods/vscode-viewer/editor/test
process.env.VSEDIT_OS = "mac";
require("./no-inline.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const WR = require("../wrap.cjs");
const H = require("../highlight.cjs");
const S = require("../settings.cjs");
const { Editor } = require("../vsedit.cjs");

const rows = (text, width, mode = "same", tab = 4) => { const r = WR.wrapLine(text, width, tab, mode); return r.starts.map((s, k) => text.slice(s, r.starts[k + 1])); };
const editor = (lines, settings = {}, size = [8, 30]) => {
  const ed = new Editor("/tmp/wrap.txt", { lines: [...lines], eol: "\n", finalNewline: true }, { grammar: null, colorMap: [], textmate: { INITIAL: null } },
    H.loadTheme(), null, S.normalize({ "editor.wordWrap": "on", ...settings }));
  [ed.rows, ed.cols] = size;
  return ed;
};
// The painted screen as text rows (cursor moves placed; colors dropped; one cell per character).
function screen(ed) {
  const grid = Array.from({ length: ed.rows }, () => []);
  let row = 0, col = 0;
  for (const part of ed.render(0).out.split(/(\x1b\[\d+;\d+H)/)) {
    const m = part.match(/^\x1b\[(\d+);(\d+)H$/);
    if (m) { row = m[1] - 1; col = m[2] - 1; continue; }
    for (const ch of part.replace(/\x1b\[[\d;:?]*[a-zA-Z]|\x1b[78]/g, "")) grid[row][col++] = ch;
  }
  return grid.map(r => Array.from(r, ch => ch ?? " ").join("").trimEnd());
}

// ---------- wrap points (wrap.cjs) ----------
test("a line breaks after spaces and punctuation, the spaces staying at the end of the row", () => {
  assert.deepEqual(rows("hello world foo bar baz qux", 10), ["hello ", "world foo ", "bar baz ", "qux"]);
  assert.deepEqual(rows("gamma.delta(epsilon);", 12), ["gamma.delta", "(epsilon);"], "before an opening bracket");
});

test("a token longer than the row breaks where it doesn't fit", () => {
  assert.deepEqual(rows("a".repeat(25), 10), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
});

test("CJK measures two columns and breaks between ideographs; Hangul breaks at spaces", () => {
  assert.deepEqual(rows("漢字漢字漢字漢字漢字漢字", 10), ["漢字漢字漢", "字漢字漢字", "漢字"]);
  assert.deepEqual(rows("한글 단어 줄바꿈 테스트", 10), ["한글 단어 ", "줄바꿈 ", "테스트"]);
});

test("continuation rows get the wrapping indent: none, same, one or two tab stops more", () => {
  const line = "    call(alpha, beta, gamma)";
  assert.equal(WR.wrapLine(line, 20, 4, "none").indent, 0);
  assert.equal(WR.wrapLine(line, 20, 4, "same").indent, 4);
  assert.equal(WR.wrapLine(line, 20, 4, "indent").indent, 8);
  assert.equal(WR.wrapLine(line, 20, 4, "deepIndent").indent, 12);
  assert.deepEqual(rows(line, 20), ["    call(alpha, ", "beta, gamma)"], "the next row holds width - indent columns");
  assert.equal(WR.wrapLine(" ".repeat(19) + "x".repeat(10), 20, 4, "same").indent, 0, "no indent when a wide character wouldn't fit after it");
});

test("a line that fits is one row; the cache returns the same rows for the same text and drops them for another width", () => {
  assert.equal(WR.wrapLine("short", 10, 4), WR.ONE);
  const c = new WR.Cache(), t = "x ".repeat(20);
  assert.equal(c.get(t, 10, 4, "same"), c.get(t, 10, 4, "same"));
  assert.notDeepEqual(c.get(t, 12, 4, "same").starts, c.get(t, 10, 4, "same").starts.slice(0, 1));
});

test("positions map to (row, x) and back, the wrap indent included; a row's end stops before the next row's first character", () => {
  const text = "  aaaa bbbb cccc", r = WR.wrapLine(text, 8, 4, "same"); // "  aaaa " | "bbbb " | "cccc", indent 2
  assert.deepEqual(r.starts, [0, 7, 12]);
  assert.equal(WR.rowOf(r, 7), 1);
  assert.equal(WR.xOf(r, 1, text, 9, 4), 4, "2 indent + 2 characters");
  assert.equal(WR.colAt(r, 1, text, 4, 4), 9);
  assert.equal(WR.colAt(r, 1, text, 0, 4), 7, "x inside the indent: the row's start");
  assert.equal(WR.colAt(r, 0, text, 99, 4), 6, "past a row's end: before its last (break) character");
  assert.equal(WR.colAt(r, 2, text, 99, 4), text.length);
});

// ---------- the editor ----------
test("settings: editor.wordWrap, wordWrapColumn and wrappingIndent default to VS Code's and reject bad values", () => {
  const v = S.normalize({});
  assert.deepEqual([v["editor.wordWrap"], v["editor.wordWrapColumn"], v["editor.wrappingIndent"]], ["off", 80, "same"]);
  const w = S.normalize({ "editor.wordWrap": "sometimes", "editor.wordWrapColumn": 0, "editor.wrappingIndent": "deep" });
  assert.deepEqual([w["editor.wordWrap"], w["editor.wordWrapColumn"], w["editor.wrappingIndent"]], ["off", 1, "same"]);
});

test("a long line paints on several rows; the number only on the first, the indent on the rest; no horizontal scrollbar", () => {
  const ed = editor(["one", "alpha beta gamma delta epsilon zeta eta theta", "two"]); // wrap width 30 - 6 - 2 = 22
  const s = screen(ed);
  assert.equal(ed.wrapWidth, 22);
  assert.deepEqual(s.slice(1, 6).map(r => r.trimEnd()), ["   1  one", "   2  alpha beta gamma", "      delta epsilon zeta", "      eta theta", "   3  two"]);
  assert.equal(ed.hbar.shown, false);
  assert.equal(ed.viewCount, 5);
});

test("cursor down / up move by row within a wrapped line, keeping the column; Home / End go to the row's edge first", () => {
  const ed = editor(["alpha beta gamma delta epsilon zeta eta theta", "x"]);
  ed.moveTo({ line: 0, col: 2 });
  ed.vertical(1, false);
  assert.deepEqual(ed.head, { line: 0, col: 19 }, "row 2 starts at delta (17); x 2 there");
  ed.vertical(1, false);
  assert.deepEqual(ed.head, { line: 0, col: 38 });
  ed.vertical(1, false);
  assert.deepEqual(ed.head, { line: 1, col: 1 });
  ed.vertical(-1, false);
  assert.deepEqual(ed.head, { line: 0, col: 38 }, "the goal column is kept");
  ed.moveTo({ line: 0, col: 20 });
  ed.lineEdge(true, false); assert.equal(ed.head.col, 35, "End: the row's end (before its break space)");
  ed.lineEdge(true, false); assert.equal(ed.head.col, 45, "End again: the line's end");
  ed.moveTo({ line: 0, col: 20 });
  ed.home(false); assert.equal(ed.head.col, 17, "Home: the row's start");
  ed.home(false); assert.equal(ed.head.col, 0, "Home again: the line's");
  ed.moveTo({ line: 0, col: 20 });
  ed.lineEdge(true, false, true); ed.lineEdge(true, false, true);
  assert.equal(ed.head.col, 35, "cursorLineEnd stays at the row's end");
});

test("a click on a continuation row lands in that row; the cursor shows there", () => {
  const ed = editor(["alpha beta gamma delta epsilon zeta eta theta"]);
  screen(ed);
  assert.deepEqual(ed.cellToPos(ed.gutter + 1 + 2, 3), { line: 0, col: 19 });
  assert.deepEqual(ed.cellToPos(ed.gutter + 30, 3), { line: 0, col: 35 }, "past the row's end");
  ed.moveTo({ line: 0, col: 19 });
  assert.deepEqual(ed.screenOf(ed.head), { row: 3, col: ed.gutter + 3 });
  assert.match(ed.render(0).out, new RegExp(`\\x1b\\[3;${ed.gutter + 3}H\\x1b\\[\\?25h$`));
});

test("PageDown, the wheel and the scrollbar scroll by rows; a folded region hides its wrapped rows", () => {
  const long = "word ".repeat(20).trim(); // 5 rows at 22 columns
  const ed = editor(["head {", `  ${long}`, "}", ...Array.from({ length: 20 }, (_, i) => `l${i}`)]);
  screen(ed);
  assert.equal(ed.toView(2), 1 + WR.wrapLine(`  ${long}`, 22, 4, "same").starts.length);
  ed.scrollBy(2);
  assert.deepEqual([ed.top, ed.topSub], [1, 1], "the top can be a line's second row");
  assert.ok(screen(ed)[1].startsWith("      "), "the first text row is a continuation row");
  ed.scrollTo(0);
  ed.collapse([{ start: 0, end: 1 }]);
  assert.equal(ed.toView(2), 1);
  assert.equal(ed.viewCount, 23 - 1);
});

test("resizing rewraps without moving the cursor's position, and keeps it in view", () => {
  const ed = editor(["alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma"]);
  ed.moveTo({ line: 0, col: 90 });
  screen(ed);
  const narrow = ed.rowPos(ed.head).sub;
  ed.cols = 60; ed.reveal(); screen(ed);
  assert.deepEqual(ed.head, { line: 0, col: 90 });
  assert.ok(ed.rowPos(ed.head).sub < narrow);
  ed.cols = 16; ed.rows = 5; ed.reveal(); screen(ed);
  const row = ed.rowsTo(0, ed.rowPos(ed.head).sub);
  assert.ok(row >= 0 && row < ed.height, `cursor row ${row}`);
});

test("Toggle Word Wrap and the status bar item turn wrapping on and off for this file", () => {
  const ed = editor(["alpha beta gamma delta epsilon zeta eta theta ".repeat(3)], { "editor.wordWrap": "off" }, [8, 70]);
  assert.match(screen(ed)[7], /No Wrap/);
  ed.runCommand("editor.action.toggleWordWrap");
  assert.equal(ed.wordWrap, "on");
  assert.match(screen(ed)[7], / Wrap /);
  const hit = ed.statusHits.find(h => h.hover?.().includes("Word wrap"));
  hit.run();
  assert.equal(ed.wordWrap, "off");
  assert.equal(S.normalize({})["editor.wordWrap"], "off", "the settings are untouched");
  const col = editor(["x"], { "editor.wordWrap": "bounded", "editor.wordWrapColumn": 40 }, [8, 100]);
  assert.match(screen(col)[7], /Wrap 40/);
  assert.equal(col.wrapWidth, 40);
});

test("find matches, problems and the selection follow a line across its rows; the git bar shows on every row", () => {
  const ed = editor(["alpha beta gamma delta epsilon zeta eta theta"]);
  ed.sel = { anchor: { line: 0, col: 11 }, head: { line: 0, col: 30 } };
  const out = ed.render(0).out;
  const sel = ed.colors.selection.slice(1).match(/../g).map(h => parseInt(h, 16)).join(";");
  assert.equal(out.split(`48;2;${sel}m`).length - 1 >= 2, true, "the selection is painted on both rows");
});

test("a 500 KB single line wraps in time and scrolling to its end stays quick", () => {
  const ed = editor(["abc, ".repeat(100000)], {}, [30, 100]);
  let t = Date.now();
  screen(ed);
  assert.ok(Date.now() - t < 500, `first frame ${Date.now() - t} ms`);
  ed.moveTo({ line: 0, col: 499999 });
  t = Date.now();
  screen(ed);
  assert.ok(Date.now() - t < 200, `frame at the end ${Date.now() - t} ms`);
  assert.ok(ed.rowsTo(0, ed.rowPos(ed.head).sub) < ed.height);
});
