// node --test mods/vscode-viewer/editor/test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const W = require("../width.cjs");
const { Buffer: TextBuffer } = require("../buffer.cjs");
const F = require("../file.cjs");
const L = require("../language.cjs");
const H = require("../highlight.cjs");
const { Editor } = require("../vsedit.cjs");

test("Hangul, CJK and emoji take two columns; combining marks none", () => {
  assert.equal(W.textWidth("abc", 4), 3);
  assert.equal(W.textWidth("한글", 4), 4);
  assert.equal(W.textWidth("漢字かな", 4), 8);
  assert.equal(W.textWidth("😀", 4), 2);
  assert.equal(W.textWidth("é", 4), 1);
  assert.equal(W.textWidth("ＡＢ", 4), 4);
});

test("tabs expand to the next tab stop", () => {
  assert.equal(W.expandTabs("\tx", 4), "    x");
  assert.equal(W.expandTabs("ab\tx", 4), "ab  x");
  assert.equal(W.expandTabs("한\tx", 4), "한  x");
  assert.equal(W.displayCol("\t\tx", 2, 2), 4);
});

test("display column maps back to a character boundary", () => {
  const line = "a한b";
  assert.equal(W.displayCol(line, 2, 4), 3);
  assert.equal(W.indexAtCol(line, 1, 4), 1);
  assert.equal(W.indexAtCol(line, 2, 4), 2); // right half of 한 -> after it
  assert.equal(W.indexAtCol(line, 3, 4), 2);
  assert.equal(W.indexAtCol(line, 99, 4), 3);
});

test("cursor steps over surrogate pairs and combining marks", () => {
  const line = "a😀éz";
  assert.equal(W.nextIndex(line, 1), 3);
  assert.equal(W.nextIndex(line, 3), 5);
  assert.equal(W.prevIndex(line, 5), 3);
  assert.equal(W.prevIndex(line, 3), 1);
});

test("edits change lines and undo/redo restore them", () => {
  const b = new TextBuffer(["hello", "world"]);
  b.edit([{ start: { line: 0, col: 5 }, text: "!\nnew" }]);
  assert.deepEqual(b.lines, ["hello!", "new", "world"]);
  b.edit([{ start: { line: 0, col: 2 }, end: { line: 2, col: 1 }, text: "" }]);
  assert.deepEqual(b.lines, ["heorld"]);
  b.undo();
  assert.deepEqual(b.lines, ["hello!", "new", "world"]);
  b.undo();
  assert.deepEqual(b.lines, ["hello", "world"]);
  b.redo(); b.redo();
  assert.deepEqual(b.lines, ["heorld"]);
  assert.ok(b.dirty);
});

test("consecutive typing is one undo step; a cursor move ends the group", () => {
  const b = new TextBuffer([""]);
  for (const [i, ch] of [..."abc"].entries()) b.edit([{ start: { line: 0, col: i }, text: ch }], { kind: "type" });
  assert.equal(b.undoStack.length, 1);
  b.seal();
  b.edit([{ start: { line: 0, col: 3 }, text: "d" }], { kind: "type" });
  assert.equal(b.undoStack.length, 2);
  b.undo();
  assert.deepEqual(b.lines, ["abc"]);
  b.undo();
  assert.deepEqual(b.lines, [""]);
});

test("file names resolve to TextMate scopes by name, prefix and longest extension", () => {
  const index = H.loadIndex();
  assert.equal(L.scopeOf(index, "App.tsx"), "source.tsx");
  assert.equal(L.scopeOf(index, "main.go"), "source.go");
  assert.equal(L.scopeOf(index, "Dockerfile.dev"), "source.dockerfile");
  assert.equal(L.scopeOf(index, "types.d.ts"), "source.ts");
  assert.equal(L.scopeOf(index, "package.json"), index.files["package.json"] ?? "source.json");
  assert.equal(L.scopeOf(index, "unknown.zzz"), null);
  assert.equal(L.languageName("source.tsx"), "TypeScript JSX");
  assert.equal(L.languageName(null), "Plain Text");
  assert.deepEqual(L.commentOf("source.go"), { line: "//" });
});

test("save keeps CRLF, the trailing newline and the file mode, atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-"));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "one\r\ntwo\r\n"); fs.chmodSync(file, 0o755);
  const doc = F.load(file);
  assert.deepEqual([doc.lines, doc.eol, doc.finalNewline], [["one", "two"], "\r\n", true]);
  F.save(file, F.encode([...doc.lines, "three"], doc));
  assert.equal(fs.readFileSync(file, "utf8"), "one\r\ntwo\r\nthree\r\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  fs.writeFileSync(file, "no newline");
  const d2 = F.load(file);
  F.save(file, F.encode(d2.lines, d2));
  assert.equal(fs.readFileSync(file, "utf8"), "no newline");
  assert.deepEqual(fs.readdirSync(dir), ["a.txt"]);
  assert.ok(F.decode(Buffer.from("a\0b")).error);
});

test("a change on disk is detected by mtime and size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-"));
  const file = path.join(dir, "b.txt");
  fs.writeFileSync(file, "x\n");
  const doc = F.load(file);
  assert.equal(F.changedOnDisk(file, doc.stamp), null);
  fs.writeFileSync(file, "xy\n");
  assert.ok(F.changedOnDisk(file, doc.stamp));
});

// Token arrays per line, comparable with deepEqual.
const snapshot = (hl, n) => { hl.ensure(n); return hl.tokens.slice(0, n + 1).map(t => (t ? Array.from(t) : null)); };

test("incremental re-tokenization equals tokenizing the edited text from scratch", async () => {
  const { grammar, textmate } = await H.loadGrammar("source.tsx");
  const src = fs.readFileSync(path.join(__dirname, "..", "vsedit.cjs"), "utf8").split("\n");
  const buf = new TextBuffer([...src]);
  const hl = new H.Highlighter(grammar, textmate.INITIAL, buf.lines);
  buf.listeners.push((s, r, n) => hl.onEdit(s, r, n));
  hl.ensure(buf.lines.length);
  const edits = [
    { start: { line: 10, col: 0 }, text: "/* open comment " },
    { start: { line: 40, col: 0 }, text: "const s = `tmpl\n${x}\n`;\n" },
    { start: { line: 10, col: 0 }, end: { line: 10, col: 16 }, text: "" },
    { start: { line: 100, col: 0 }, end: { line: 120, col: 0 }, text: "" },
  ];
  for (const e of edits) {
    buf.edit([e]);
    const fresh = new H.Highlighter(grammar, textmate.INITIAL, [...buf.lines]);
    assert.deepEqual(snapshot(hl, buf.lines.length - 1), snapshot(fresh, buf.lines.length - 1));
  }
});

test("re-tokenization after a local edit stops where the state matches again", async () => {
  const { grammar, textmate } = await H.loadGrammar("source.go");
  const lines = Array.from({ length: 20000 }, (_, i) => `x${i} := ${i} // n`);
  const buf = new TextBuffer(lines);
  const hl = new H.Highlighter(grammar, textmate.INITIAL, buf.lines);
  buf.listeners.push((s, r, n) => hl.onEdit(s, r, n));
  hl.ensure(19999);
  let calls = 0;
  const orig = hl.tokenizeLine.bind(hl);
  hl.tokenizeLine = (i) => { calls++; return orig(i); };
  buf.edit([{ start: { line: 5000, col: 0 }, text: "y" }]);
  hl.ensure(19999);
  assert.ok(calls <= 2, `re-tokenized ${calls} lines`);
});

test("editor: Enter keeps indentation, Tab/Shift+Tab indent, Ctrl+/ toggles comments", async () => {
  const theme = H.loadTheme();
  const ed = new Editor("/tmp/x.go", { lines: ["func main() {", "\tx := 1", "}"], eol: "\n", finalNewline: true }, await H.loadGrammar("source.go"), theme, "source.go");
  ed.moveTo({ line: 1, col: 7 });
  ed.enter();
  assert.deepEqual(ed.lines.slice(1, 3), ["\tx := 1", "\t"]);
  ed.undo();
  ed.sel = { anchor: { line: 0, col: 0 }, head: { line: 2, col: 1 } };
  ed.toggleComment();
  assert.deepEqual(ed.lines, ["// func main() {", "// \tx := 1", "// }"]); // at the smallest indent, like VS Code
  ed.toggleComment();
  assert.deepEqual(ed.lines, ["func main() {", "\tx := 1", "}"]);
  ed.tabKey(false);
  assert.deepEqual(ed.lines, ["\tfunc main() {", "\t\tx := 1", "\t}"]);
  ed.tabKey(true);
  assert.deepEqual(ed.lines, ["func main() {", "\tx := 1", "}"]);
  ed.moveTo({ line: 1, col: 1 });
  ed.typed("한글");
  assert.equal(ed.lines[1], "\t한글x := 1");
  assert.equal(ed.head.col, 3);
});

// ---------- keys ----------
const { parse } = require("../keys.cjs");
const chord = (e) => `${e.ctrl ? "ctrl+" : ""}${e.alt ? "alt+" : ""}${e.shift ? "shift+" : ""}${e.cmd ? "cmd+" : ""}${e.name}`;
const keyOf = (s) => { const e = parse(s).events[0]; return e && (e.type === "key" ? chord(e) : e); };

test("Kitty CSI-u reports ⌘ (super) as cmd, with shift/alt/ctrl, and drops key releases", () => {
  assert.equal(keyOf("\x1b[115;9u"), "cmd+s");
  assert.equal(keyOf("\x1b[112;10u"), "shift+cmd+p");
  assert.equal(keyOf("\x1b[102;11u"), "alt+cmd+f");
  assert.equal(keyOf("\x1b[47;9u"), "cmd+/");
  assert.equal(keyOf("\x1b[13;9u"), "cmd+enter");
  assert.equal(keyOf("\x1b[1;9D"), "cmd+left");
  assert.equal(keyOf("\x1b[1;3A"), "alt+up");
  assert.equal(keyOf("\x1b[97;5u"), "ctrl+a");
  assert.equal(keyOf("\x1b[27u"), "escape");
  assert.deepEqual(parse("\x1b[115;65u").events, [{ type: "text", text: "s" }]); // caps lock alone still types
  assert.deepEqual(parse("\x1b[115;9:3u").events, []); // release
  assert.deepEqual(parse("\x1b[57441;2u").events, []); // a lone modifier key
});

test("function keys, Shift+F10, the menu key and focus reports", () => {
  assert.equal(keyOf("\x1b[24~"), "f12");
  assert.equal(keyOf("\x1b[24;9~"), "cmd+f12");
  assert.equal(keyOf("\x1b[24;4~"), "alt+shift+f12");
  assert.equal(keyOf("\x1b[21;2~"), "shift+f10");
  assert.equal(keyOf("\x1b[57363u"), "menu");
  assert.equal(keyOf("\x1bOQ"), "f2");
  assert.deepEqual(parse("\x1b[I\x1b[O").events, [{ type: "focus", focused: true }, { type: "focus", focused: false }]);
  assert.deepEqual(parse("\x1b[<2;10;5M").events[0], { type: "mouse", button: 2, x: 10, y: 5, release: false, motion: false, shift: false, alt: false, ctrl: false });
  assert.equal(parse("\x1b[115;9").rest, "\x1b[115;9"); // split sequence waits for the rest
});
