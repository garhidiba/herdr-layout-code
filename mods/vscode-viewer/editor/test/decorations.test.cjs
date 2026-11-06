// node --test mods/vscode-viewer/editor/test
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../decorations.cjs");
const H = require("../highlight.cjs");
const { fgSGR } = require("../paint.cjs");
const { Editor } = require("../vsedit.cjs");

const GO = ["func main() {", "\tif x {", "\t\ty()", "", "\t}", "}"];
const editor = async (lines, scope = "source.go", file = "/tmp/x.go") =>
  new Editor(file, { lines: [...lines], eol: "\n", finalNewline: true }, await H.loadGrammar(scope), H.loadTheme(), scope);
const plain = (s) => s.replace(/\x1b\[[\d;]*[mHq]|\x1b\[\?[\d;]*[hl]|\x1b\][^\x07]*\x07/g, "");

// ---------- indent guides ----------
test("each indent step of a line's leading whitespace gets a guide; tabs and spaces count by display columns", () => {
  const rows = D.indentGuides(["a", "  b", "    c", "   d", "\t\te"], 0, 4, 2, 4, 0);
  assert.deepEqual(rows.map(r => r.count), [0, 1, 2, 2, 4]); // 3 spaces start a second step; two tabs are 8 columns
});

test("a blank line takes its guides from the content lines around it, VS Code's rule", () => {
  const level = D.guideLevels(["a {", "", "  b", "", "", "}", ""], 2, 4);
  assert.equal(level(1), 1, "between a shallower and a deeper line: one more than the shallower");
  assert.equal(level(3), 1, "a block's last blank lines before its closer: one more than the closer");
  assert.equal(level(6), 0, "past the last content line: none");
});

test("the active guide is the block the cursor is in; on a header, the block below; on a footer, the block above", () => {
  const level = D.guideLevels(GO, 4, 4);
  assert.deepEqual(D.activeGuide(level, 2, GO.length), { index: 1, from: 2, to: 3 }, "inside the if block");
  assert.deepEqual(D.activeGuide(level, 1, GO.length), { index: 1, from: 2, to: 3 }, "the if line: its body");
  assert.deepEqual(D.activeGuide(level, 4, GO.length), { index: 1, from: 2, to: 3 }, "the closing brace: the body above");
  assert.deepEqual(D.activeGuide(level, 0, GO.length), { index: 0, from: 1, to: 4 }, "func line: the function body");
  assert.equal(D.activeGuide(D.guideLevels(["a", "b"], 4, 4), 0, 2), null, "no indentation: no active guide");
});

test("the painted frame draws guides in the leading whitespace and on blank lines, the active one brighter, never over a selection", async () => {
  const ed = await editor(GO);
  ed.rows = 10; ed.cols = 40;
  ed.moveTo({ line: 2, col: 2 });
  const out = ed.render().out, c = ed.colors;
  assert.ok(plain(out).includes("3  │   │   y()"), "two guides before y()");
  assert.ok(plain(out).includes("4  │   │      "), "the blank line keeps both guides");
  assert.ok(out.includes(fgSGR(c.guideActive) + "│"), "the active guide in editorIndentGuide.activeBackground");
  assert.ok(out.includes(fgSGR(c.guide) + "│"), "the others in editorIndentGuide.background");
  ed.sel = { anchor: { line: 1, col: 0 }, head: { line: 2, col: 3 } };
  assert.ok(!plain(ed.render().out).includes("3  │   │   y()"), "a selection hides the guides under it");
});

// ---------- bracket matching ----------
const code = () => true;
test("the bracket before the cursor, else the one after it, is matched with its partner across lines", () => {
  const lines = ["f(a, [b]) {", "  g(c)", "}"];
  assert.deepEqual(D.matchBracket(lines, { line: 0, col: 2 }, code), [{ line: 0, col: 1 }, { line: 0, col: 8 }], "after (: before wins");
  assert.deepEqual(D.matchBracket(lines, { line: 0, col: 5 }, code), [{ line: 0, col: 5 }, { line: 0, col: 7 }], "before [: the one after");
  assert.deepEqual(D.matchBracket(lines, { line: 2, col: 1 }, code), [{ line: 2, col: 0 }, { line: 0, col: 10 }], "} back to {");
  assert.equal(D.matchBracket(lines, { line: 1, col: 1 }, code), null, "no bracket at the cursor");
  assert.equal(D.matchBracket(["(("], { line: 0, col: 1 }, code), null, "unbalanced: no partner");
});

test("brackets inside strings and comments don't count, by the grammar's token types", async () => {
  const ed = await editor(['f("(", x) // )', ")"], "source.ts", "/tmp/x.ts");
  ed.hl.ensure(1);
  ed.moveTo({ line: 0, col: 2 });
  assert.deepEqual(ed.bracketPair(), [{ line: 0, col: 1 }, { line: 0, col: 8 }]);
  ed.moveTo({ line: 0, col: 4 });
  assert.equal(ed.bracketPair(), null, "the ( in the string is not a bracket");
});

test("the scan for a partner stops after its character budget", () => {
  const lines = ["(" + "x".repeat(100) + ")"];
  assert.equal(D.matchBracket(lines, { line: 0, col: 1 }, code, 50), null);
  assert.ok(D.matchBracket(lines, { line: 0, col: 1 }, code, 200));
});

test("both brackets are painted on editorBracketMatch.background", async () => {
  const ed = await editor(["f(x)"], "source.ts", "/tmp/x.ts");
  ed.rows = 6; ed.cols = 30;
  ed.moveTo({ line: 0, col: 2 });
  const bgOf = (hex) => fgSGR(hex).replace("[38;", "[48;"), out = ed.render().out;
  assert.ok(out.includes(bgOf(ed.colors.bracketMatch) + "("), "( highlighted");
  assert.ok(out.includes(bgOf(ed.colors.bracketMatch) + ")"), ") highlighted");
});
