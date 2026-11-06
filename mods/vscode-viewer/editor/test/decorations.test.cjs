// node --test mods/vscode-viewer/editor/test
require("./no-inline.cjs");
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

// ---------- occurrences ----------
test("word occurrences are whole words only; selection matches are exact and case-sensitive", () => {
  const lines = ["foo food foo_x foo", "x = foo + Foo"];
  assert.deepEqual(D.wordMatches(lines, 0, 1, "foo").map(m => [m.line, m.col]), [[0, 0], [0, 15], [1, 4]]);
  assert.deepEqual(D.textMatches(lines, 0, 1, "foo").map(m => [m.line, m.col]), [[0, 0], [0, 4], [0, 9], [0, 15], [1, 4]]);
  assert.deepEqual(D.textMatches(lines, 1, 1, "Foo").map(m => [m.line, m.col]), [[1, 10]], "only the lines asked for");
});

test("the word at the cursor highlights 250 ms after the cursor rests, in wordHighlightBackground, with ruler marks", async () => {
  const ed = await editor(["let a = b + a;", "a"], "source.ts", "/tmp/x.ts");
  ed.moveTo({ line: 0, col: 4 });
  assert.equal(ed.highlights(10), null, "not before the delay");
  ed.wordSince -= 300;
  const h = ed.highlights(10);
  assert.deepEqual(h.list.map(m => [m.line, m.col]), [[0, 4], [0, 12], [1, 0]]);
  assert.equal(h.bg, ed.colors.wordHighlight);
  assert.equal(h.ruler, ed.colors.rulerWord);
  ed.typed("x");
  assert.equal(ed.highlights(10), null, "typing restarts the delay");
  ed.moveTo({ line: 0, col: 3 });
  ed.wordSince -= 300;
  assert.equal(ed.highlights(10), null, "no word at the cursor");
});

test("a one-line selection highlights its other exact matches at once, in selectionHighlightBackground", async () => {
  const ed = await editor(["ab ab", "xab", "a b"], "source.ts", "/tmp/x.ts");
  ed.sel = { anchor: { line: 0, col: 0 }, head: { line: 0, col: 2 } };
  const h = ed.highlights(10);
  assert.deepEqual(h.list.map(m => [m.line, m.col]), [[0, 0], [0, 3], [1, 1]]);
  assert.equal(h.bg, ed.colors.selectionHighlight);
  ed.rows = 8; ed.cols = 30;
  const bgOf = (hex) => fgSGR(hex).replace("[38;", "[48;");
  assert.ok(ed.render().out.includes(bgOf(ed.colors.selectionHighlight) + "ab"), "the other match is painted");
  ed.sel = { anchor: { line: 0, col: 0 }, head: { line: 1, col: 1 } };
  assert.equal(ed.highlights(10), null, "a multi-line selection has none");
  ed.sel = { anchor: { line: 2, col: 1 }, head: { line: 2, col: 2 } };
  assert.equal(ed.highlights(10), null, "nor a whitespace-only one");
});

// ---------- auto-closing pairs ----------
const A = require("../autoclose.cjs");
const type = (ch, text, col, more = {}) => A.onType(ch, { pairs: A.pairsOf("source.ts"), text, col, selected: false, inText: false, closer: false, ...more });

test("an opening bracket or quote pairs before whitespace, a closer or the line end, not before a word", () => {
  assert.equal(type("(", "", 0), "pair");
  assert.equal(type("[", "a )", 1), "pair");
  assert.equal(type("{", ";", 0), "pair");
  assert.equal(type("(", "abc", 0), null, "before a word: just the char");
  assert.equal(type("x", "", 0), null);
});

test("quotes don't pair right after a word character or inside strings and comments", () => {
  assert.equal(type('"', "", 0), "pair");
  assert.equal(type("'", "don", 3), null, "an apostrophe in a word");
  assert.equal(type('"', "", 0, { inText: true }), null);
  assert.equal(type("`", "", 0), "pair", "backticks in TypeScript");
  assert.equal(A.onType("`", { pairs: A.pairsOf("source.python"), text: "", col: 0 }), null, "but not in Python");
  assert.equal(A.onType("'", { pairs: A.pairsOf("source.rust"), text: "", col: 0 }), null, "no ' pairs in Rust (lifetimes)");
});

test("typing a closer over one the editor inserted steps over it; with a selection, an opener wraps it", () => {
  assert.equal(type(")", "()", 1, { closer: true }), "over");
  assert.equal(type(")", "()", 1), null, "a closer the user typed is not stepped over");
  assert.equal(type("(", "abc", 0, { selected: true }), "wrap");
  assert.equal(type("x", "abc", 0, { selected: true }), null);
});

test("the cursor is in a string or comment by the grammar's tokens; after a closing quote is outside", async () => {
  const { grammar, textmate } = await H.loadGrammar("source.ts");
  const at = (text, col) => A.inStringOrComment(grammar.tokenizeLine2(text, textmate.INITIAL).tokens, text, col);
  assert.equal(at('x = "ab', 6), true, "inside a string");
  assert.equal(at('x = "ab"', 8), false, "after its closing quote");
  assert.equal(at('x = "', 5), true, "right after a lone opening quote");
  assert.equal(at("x // note", 9), true, "in a comment");
  assert.equal(at("x = 1", 5), false);
});

test("editor: auto-closing, type-over, Backspace in an empty pair, wrapping, no pair in a string", async () => {
  const ed = await editor([""], "source.ts", "/tmp/x.ts");
  ed.typed("f(");
  assert.deepEqual([ed.lines[0], ed.head.col], ["f()", 2]);
  ed.typed('"');
  assert.deepEqual([ed.lines[0], ed.head.col], ['f("")', 3]);
  ed.typed("a\"");
  assert.deepEqual([ed.lines[0], ed.head.col], ['f("a")', 5], "typed over the auto-inserted quote");
  ed.typed(")");
  assert.deepEqual([ed.lines[0], ed.head.col], ['f("a")', 6], "and over the auto-inserted paren");
  ed.typed(" [");
  ed.backspace(false);
  assert.equal(ed.lines[0], 'f("a") ', "Backspace in [] deletes both");
  ed.typed(")");
  assert.equal(ed.lines[0], 'f("a") )', "a closer nobody inserted is typed");
  ed.sel = { anchor: { line: 0, col: 3 }, head: { line: 0, col: 4 } };
  ed.typed("(");
  assert.equal(ed.lines[0], 'f("(a)") )', "an opener wraps the selection");
  assert.deepEqual(ed.range().map(p => p.col), [4, 5], "keeping the inner text selected");
  ed.moveTo({ line: 0, col: 5 });
  ed.typed("'");
  assert.equal(ed.lines[0], `f("(a')") )`, "no pair inside a string");
});
