// node --test mods/vscode-viewer/editor/test
process.env.VSEDIT_OS = "mac"; // the keys are macOS's unless a test resolves another OS's
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

// ---------- commands, menu, fuzzy ----------
const Cmd = require("../commands.cjs");

test("the context menu has VS Code's items, order and separators, with Peek as a submenu", () => {
  const rows = Cmd.menuRows(Cmd.MENU, () => true);
  const titles = rows.map(r => (r.sep ? "---" : r.title));
  assert.deepEqual(titles, ["Go to Definition", "Go to Type Definition", "Go to Implementations", "Go to References", "Peek", "---",
    "Find All References", "Find All Implementations", "Show Call Hierarchy", "---",
    "Rename Symbol", "Change All Occurrences", "Format Document", "Refactor...", "Source Action...", "---",
    "Cut", "Copy", "Paste", "---", "Command Palette..."]);
  assert.deepEqual(rows[4].submenu.map(r => r.title), ["Peek Definition", "Peek References", "Peek Implementations", "Peek Type Definition"]);
  assert.deepEqual(rows.filter(r => r.key).map(r => r.key), ["F12", "⌘F12", "⇧F12", "⌥⇧F12", "⌥⇧H", "F2", "⌘F2", "⌥⇧F", "⌃⇧R", "⌘X", "⌘C", "⌘V", "⇧⌘P"]);
});

test("items without a provider are disabled, and keyboard steps skip them and separators", () => {
  const rows = Cmd.menuRows(Cmd.MENU, cap => cap === "definition" || cap === "references");
  const enabled = rows.filter(r => !r.sep && r.enabled).map(r => r.title);
  assert.deepEqual(enabled, ["Go to Definition", "Go to References", "Peek", "Find All References", "Change All Occurrences", "Cut", "Copy", "Paste", "Command Palette..."]);
  assert.equal(rows[Cmd.stepMenu(rows, 0, 1)].title, "Go to References");
  assert.equal(rows[Cmd.stepMenu(rows, 0, -1)].title, "Command Palette..."); // wraps
  assert.equal(Cmd.stepMenu([{ sep: true }], 0, 1), -1);
});

test("macOS keys are ⌘ keys only: no Ctrl fallbacks", () => {
  const id = (chord) => Cmd.KEYMAP.get(chord)?.id;
  assert.equal(Cmd.OS, "mac");
  assert.equal(id("cmd+s"), "workbench.action.files.save");
  assert.equal(id("ctrl+s"), undefined);
  assert.equal(id("shift+cmd+p"), "workbench.action.showCommands");
  assert.equal(id("alt+shift+f12"), "references-view.findReferences");
  assert.equal(id("f12"), "editor.action.revealDefinition");
  assert.equal(id(Cmd.normalize("cmd+shift+k")), "editor.action.deleteLines");
  assert.equal(id("shift+f10"), "editor.action.showContextMenu");
});

test("fuzzy filter ranks word starts and consecutive letters first, and drops non-matches", () => {
  const files = ["README.md", "mods/vscode-viewer/editor/vsedit.cjs", "mods/vscode-viewer/editor/test/e2e.py", "mods/vscode-viewer/main.js"];
  assert.equal(Cmd.filter(files, "vsedit", f => f)[0].item, "mods/vscode-viewer/editor/vsedit.cjs");
  assert.deepEqual(Cmd.filter(files, "e2e", f => f).map(r => r.item), ["mods/vscode-viewer/editor/test/e2e.py"]);
  assert.equal(Cmd.filter(files, "zzz", f => f).length, 0);
  assert.equal(Cmd.filter(Cmd.COMMANDS, "fmt doc", c => c.title)[0].item.title, "Format Document");
  assert.equal(Cmd.filter(files, "", f => f).length, 4);
});

// ---------- language fallbacks and workspace edits ----------
const FB = require("../lang/fallback.cjs");
const E = require("../lang/edits.cjs");

test("without a server, Go to Definition searches the git root for definition keywords", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-fb-"));
  require("child_process").spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.go"), "package main\n\nfunc (s *Server) Handle() {}\n\nfunc main() { s.Handle(); HandleAll() }\n");
  fs.writeFileSync(path.join(dir, "b.py"), "def Handle():\n    pass\n");
  require("child_process").spawnSync("git", ["add", "."], { cwd: dir });
  const fb = new FB.Fallback(path.join(dir, "a.go"), "source.go", dir);
  const defs = await fb.definition({ file: path.join(dir, "a.go"), word: "Handle" });
  assert.deepEqual(defs.map(d => [path.basename(d.file), d.line, d.col]), [["a.go", 2, 17], ["b.py", 0, 4]]);
  const refs = await fb.references({ word: "Handle" });
  assert.equal(refs.length, 3); // whole word: HandleAll is not one
  assert.ok(fb.can("definition") && fb.can("rename") && !fb.can("callHierarchy"));
});

test("whole-word occurrences and edits applied last-first", () => {
  const lines = ["let a = ab + a;", "a(a)"];
  const occ = FB.wordOccurrences(lines, "a", "xyz");
  assert.equal(occ.length, 4);
  assert.deepEqual(E.applyToLines(lines, occ), ["let xyz = ab + xyz;", "xyz(xyz)"]);
  assert.deepEqual(E.applyToLines(["abc", "def"], [{ start: { line: 0, col: 1 }, end: { line: 1, col: 1 }, text: "X\r\nY" }]), ["aX", "Yef"]);
});

test("a workspace edit rewrites closed files keeping CRLF, and gives open files to the editor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-ws-"));
  const a = path.join(dir, "a.ts"), b = path.join(dir, "b.ts");
  fs.writeFileSync(a, "foo();\r\nfoo();\r\n"); fs.writeFileSync(b, "x");
  const seen = [];
  const r = E.applyWorkspaceEdit({
    [a]: [{ start: { line: 0, col: 0 }, end: { line: 0, col: 3 }, text: "bar" }, { start: { line: 1, col: 0 }, end: { line: 1, col: 3 }, text: "bar" }],
    [b]: [{ start: { line: 0, col: 0 }, end: { line: 0, col: 1 }, text: "y" }],
    [path.join(dir, "missing.ts")]: [{ start: { line: 0, col: 0 }, end: { line: 0, col: 0 }, text: "z" }],
  }, (file, edits) => (file === b ? (seen.push(edits.length), true) : false));
  assert.equal(fs.readFileSync(a, "utf8"), "bar();\r\nbar();\r\n");
  assert.equal(fs.readFileSync(b, "utf8"), "x"); // the editor took it
  assert.deepEqual(seen, [1]);
  assert.deepEqual([r.files, r.edits, r.failed.length], [2, 3, 1]);
});

// ---------- settings and hot exit ----------
const S = require("../settings.cjs");
const B = require("../backup.cjs");

test("settings: defaults on first run, seconds clamped to 0.1-3600, unknown keys kept on write", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-set-")), "sub", "vscode-settings.json");
  const first = S.load(file);
  assert.deepEqual(first.values, S.DEFAULTS);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), S.DEFAULTS);
  fs.writeFileSync(file, '{\n  // mine\n  "files.autoSave": "afterDelay", "files.autoSaveDelay": 0.01, "workbench.colorTheme": "x", "editor.tabSize": "big",\n}');
  const v = S.load(file).values;
  assert.equal(v["files.autoSave"], "afterDelay");
  assert.equal(v["files.autoSaveDelay"], 0.1);
  assert.equal(v["editor.tabSize"], 4);
  assert.equal(S.autoSaveLabel(v), "Auto Save: after 0.1s");
  S.update("files.autoSaveDelay", 2.5, file);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw["workbench.colorTheme"], "x");
  assert.equal(S.autoSaveLabel(S.load(file).values), "Auto Save: after 2.5s");
  assert.equal(S.normalize({ "files.autoSave": "sometimes", "files.autoSaveDelay": 99999 })["files.autoSaveDelay"], 3600);
  assert.equal(S.normalize({ "files.autoSave": "sometimes" })["files.autoSave"], "off");
});

test("hot exit backups: written per path, read back only for that path, stale when the file changed", () => {
  process.env.VSEDIT_BACKUPS = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-bk-"));
  const file = path.join(process.env.VSEDIT_BACKUPS, "doc.txt");
  fs.writeFileSync(file, "old\n");
  B.write(file, "new text", { line: 0, col: 3 });
  const b = B.read(file);
  assert.deepEqual([b.path, b.text, b.cursor], [file, "new text", { line: 0, col: 3 }]);
  assert.equal(B.changedSince(b, file), false);
  assert.equal(B.read(file + "x"), null);
  fs.writeFileSync(file, "changed on disk\n");
  assert.equal(B.changedSince(b, file), true);
  assert.equal(B.changedSince({ ...b, mtimeMs: Math.floor(fs.statSync(file).mtimeMs / 1000) * 1000, size: fs.statSync(file).size }, file), false); // the mod's whole seconds
  B.remove(file);
  assert.equal(B.read(file), null);
  assert.equal(B.pathHash("/a/b"), B.pathHash("/a/b"));
  delete process.env.VSEDIT_BACKUPS;
});

// ---------- editor commands ----------
const plainEditor = async (lines, file = "/tmp/x.txt") => new Editor(file, { lines, eol: "\n", finalNewline: true }, await H.loadGrammar(null), H.loadTheme(), null);

test("line commands: move, copy, delete, insert below/above", async () => {
  const ed = await plainEditor(["a", "b", "c"]);
  ed.moveTo({ line: 0, col: 1 });
  ed.moveLines(1);
  assert.deepEqual(ed.lines, ["b", "a", "c"]);
  assert.equal(ed.head.line, 1);
  ed.copyLines(1);
  assert.deepEqual(ed.lines, ["b", "a", "a", "c"]);
  assert.equal(ed.head.line, 2);
  ed.deleteLines();
  assert.deepEqual(ed.lines, ["b", "a", "c"]);
  assert.equal(ed.head.line, 2); // the line after the deleted one
  ed.insertLine(1);
  assert.deepEqual(ed.lines, ["b", "a", "c", ""]);
  ed.undo(); ed.undo(); ed.undo(); ed.undo();
  assert.deepEqual(ed.lines, ["a", "b", "c"]);
});

test("Change All Occurrences previews live, applies as one step, and Esc restores", async () => {
  const ed = await plainEditor(["foo = foo + food"]);
  ed.moveTo({ line: 0, col: 1 });
  ed.changeAll();
  ed.handle({ type: "text", text: "x" });
  assert.deepEqual(ed.lines, ["x = x + food"]);
  ed.handle({ type: "text", text: "y" });
  assert.deepEqual(ed.lines, ["xy = xy + food"]);
  ed.handle({ type: "key", name: "escape" });
  assert.deepEqual(ed.lines, ["foo = foo + food"]);
  ed.changeAll();
  ed.handle({ type: "text", text: "bar" });
  ed.handle({ type: "key", name: "enter" });
  assert.deepEqual(ed.lines, ["bar = bar + food"]);
  ed.undo();
  assert.deepEqual(ed.lines, ["foo = foo + food"]);
});

test("closing with unsaved changes asks Save / Don't Save / Cancel; hot exit keeps a backup", async () => {
  process.env.VSEDIT_BACKUPS = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-bk-"));
  const file = path.join(process.env.VSEDIT_BACKUPS, "a.txt");
  fs.writeFileSync(file, "one\n");
  const ed = await plainEditor(["one"], file);
  ed.typed("x");
  ed.runCommand("workbench.action.closeActiveEditor");
  assert.equal(ed.popup.title, "Do you want to save the changes you made to a.txt?");
  assert.deepEqual(ed.popup.buttons.map(b => b.label), ["Save", "Don't Save", "Cancel"]);
  ed.handle({ type: "key", name: "escape" });
  assert.equal(ed.popup, null);
  assert.ok(!ed.done);
  ed.hotExit();
  assert.equal(B.read(file).text, "xone");
  ed.undo(); // the buffer differs from the backup again
  ed.offerBackup();
  assert.match(ed.popup.title, /^Restore unsaved changes from \d{4}-\d\d-\d\d \d\d:\d\d\?$/);
  ed.handle({ type: "key", name: "escape" }); // Esc keeps the backup for next time
  assert.equal(B.read(file).text, "xone");
  ed.offerBackup();
  ed.handle({ type: "key", name: "enter" }); // Restore
  assert.deepEqual(ed.lines, ["xone"]);
  ed.quit();
  ed.handle({ type: "text", text: "d" });
  assert.ok(ed.done);
  assert.equal(B.read(file), null);
  assert.equal(fs.readFileSync(file, "utf8"), "one\n");
  delete process.env.VSEDIT_BACKUPS;
});

test("the error page names fs errors in words and maps Esc/⌘W (this OS's Close Editor) to Close, Enter to Try Again", () => {
  const E = require("../errorpage.cjs");
  assert.equal(E.reasonOf(Object.assign(new Error("x"), { code: "ENOENT" })), "File not found");
  assert.equal(E.reasonOf(Object.assign(new Error("x"), { code: "EACCES" })), "Permission denied");
  assert.equal(E.reasonOf(new Error("first line\nsecond")), "first line");
  const picked = [], page = new E.ErrorPage("/p/a.txt", "File not found", ["a.txt"], (c) => picked.push(c));
  const key = (name, m = {}) => ({ type: "key", name, ctrl: false, shift: false, alt: false, cmd: false, ...m });
  page.handle(key("enter"));
  page.handle(key("escape"));
  page.handle(key("w", { cmd: true }));
  page.handle(key("q", { ctrl: true })); // not a macOS key
  page.handle(key("left")); page.handle(key("enter")); // focus wraps to Close
  assert.deepEqual(picked, ["retry", "close", "close", "close"]);
  assert.match(page.render(30, 100), /The editor could not be opened/);
});

// A minified bundle: `n` characters of real-looking JS on one line.
function minified(n) {
  let s = "", i = 0;
  while (s.length < n) s += `function f${i}(a,b){const c=a+b*${i};if(c>10){return "s${i}"+c}else{for(let k=0;k<c;k++){a.push({x:k,y:/re${i}/g})}}return null}var v${i++}=new Map;`;
  return s.slice(0, n);
}
// Foreground color index of each character in [from, to).
const colorsIn = (tokens, from, to) => {
  const out = [];
  for (let i = from, t = 0; i < to; i++) { while (t + 2 < tokens.length && tokens[t + 2] <= i) t += 2; out.push(H.foregroundOf(tokens[t + 1])); }
  return out;
};

test("a 200 KB minified line is colored piece by piece, the visible window first, matching full tokenization", async () => {
  const { grammar, textmate } = await H.loadGrammar("source.js");
  const line = minified(200000), hl = new H.Highlighter(grammar, textmate.INITIAL, [line, "const after = 1;"]);
  hl.ensure(1);
  assert.equal(hl.ensureLong(0, 1, Date.now() + 5), false, "not done within 5 ms: the rest goes on in later frames");
  const from = 10000, to = 10100;
  while (hl.long[0].pos < to) hl.ensureLong(0, 0, Date.now() + 20);
  const whole = grammar.tokenizeLine2(line.slice(0, 20000), textmate.INITIAL).tokens;
  assert.deepEqual(colorsIn(hl.tokens[0], from, to), colorsIn(whole, from, to));
  assert.ok(new Set(colorsIn(hl.tokens[0], from, to)).size > 2, "the window has several colors");
  const keep = hl.long[0].pieces.length;
  hl.lines[0] = line.slice(0, 15000) + "x" + line.slice(15000); hl.onEdit(0, 1, 1); hl.ensure(1);
  assert.ok(hl.long[0].pieces.length > 0 && hl.long[0].pieces.length <= keep && hl.long[0].pos <= 15000, "typing keeps the pieces before the edit");
});

// ---------- user keybindings (vscode-keybindings.json) ----------
const K = require("../keybindings.cjs");
const press = (ed, name, m = {}) => ed.handle({ type: "key", name, ctrl: !!m.ctrl, shift: !!m.shift, alt: !!m.alt, cmd: !!m.cmd });

test("VS Code key spellings become the editor's keys, two-step chords included; three steps and unknown modifiers are not keys", () => {
  assert.equal(K.canon("Cmd+Shift+K"), "shift+cmd+k");
  assert.equal(K.canon("shift+cmd+k"), "shift+cmd+k");
  assert.equal(K.canon("meta+alt+up"), "alt+cmd+up");
  assert.equal(K.canon("ctrl+-"), "ctrl+-");
  assert.equal(K.canon("ctrl++"), "ctrl++");
  assert.equal(K.canon("f12"), "f12");
  assert.equal(K.canon("Cmd+K  Cmd+S"), "cmd+k cmd+s");
  assert.equal(K.canon("ctrl+k shift+alt+x"), "ctrl+k alt+shift+x");
  assert.equal(K.canon("ctrl+k ctrl+c ctrl+d"), null);
  assert.equal(K.canon("ctrl+k hyper+c"), null);
  assert.equal(K.canon("hyper+x"), null);
  assert.equal(K.canon(""), null);
});

test("a user binding adds a key; the default keys of the command keep working", () => {
  const km = K.resolve([{ key: "cmd+shift+d", command: "editor.action.deleteLines" }]);
  assert.equal(km.byChord.get("shift+cmd+d"), "editor.action.deleteLines");
  assert.equal(km.byChord.get("shift+cmd+k"), "editor.action.deleteLines");
  assert.equal(km.label("editor.action.deleteLines"), "⇧⌘D"); // menus show the user's key
});

test("a user binding on a default's key overrides it, and the last binding of a key wins", () => {
  const km = K.resolve([
    { key: "cmd+g", command: "editor.action.deleteLines" },
    { key: "cmd+e", command: "editor.action.commentLine" },
    { key: "cmd+e", command: "editor.action.selectAll" },
  ]);
  assert.equal(km.byChord.get("cmd+g"), "editor.action.deleteLines");
  assert.equal(km.byChord.get("cmd+e"), "editor.action.selectAll");
  assert.equal(km.label("editor.action.nextMatchFindAction"), "F3"); // ⌘G is taken; its other default is left
});

test("\"-command\" removes that command's default for the key, or all its defaults without a key", () => {
  const one = K.resolve([{ key: "cmd+g", command: "-editor.action.nextMatchFindAction" }]);
  assert.equal(one.byChord.get("cmd+g"), undefined);
  assert.equal(one.byChord.get("f3"), "editor.action.nextMatchFindAction");
  const all = K.resolve([{ command: "-editor.action.nextMatchFindAction" }]);
  assert.equal(all.byChord.get("f3"), undefined);
  assert.equal(all.label("editor.action.nextMatchFindAction"), "");
  const other = K.resolve([{ key: "cmd+shift+k", command: "-undo" }]); // not that command's key: nothing removed
  assert.equal(other.byChord.get("shift+cmd+k"), "editor.action.deleteLines");
});

test("entries that aren't keybindings are skipped and an invalid file falls back to the defaults", () => {
  const km = K.resolve([null, 3, { key: "cmd+k cmd+s cmd+x", command: "-undo" }, { key: "cmd+y" }, { key: "cmd+y", command: "" }]);
  assert.equal(km.byChord.get("cmd+z"), "undo");
  assert.equal(km.byChord.has("cmd+y"), false);
  assert.match(K.parseText("{ \"key\": 1 }").error, /not a JSON array/);
  assert.deepEqual(K.parseText("// mine\n[{ \"key\": \"cmd+e\", \"command\": \"undo\" },]").user, [{ key: "cmd+e", command: "undo" }]);
  assert.deepEqual(K.parseText(null), { user: [], error: null });
});

test("the table has one row per binding in effect with its source, and commands without a key", () => {
  const rows = K.table(K.resolve([{ key: "cmd+shift+k", command: "-editor.action.deleteLines" }, { key: "cmd+shift+d", command: "editor.action.deleteLines" },
    { key: "cmd+9", command: "my.extension" }]));
  assert.deepEqual(rows.filter(r => r.id === "editor.action.deleteLines").map(r => [r.key, r.source]), [["shift+cmd+d", "User"]]);
  assert.deepEqual(rows.filter(r => r.id === "editor.action.nextMatchFindAction").map(r => [r.key, r.source]), [["cmd+g", "Default"], ["f3", "Default"]]);
  assert.deepEqual(rows.find(r => r.id === "editor.action.goToTypeDefinition"), { id: "editor.action.goToTypeDefinition", title: "Go to Type Definition", key: "", source: "" });
  assert.deepEqual(rows.at(-1), { id: "my.extension", title: "", key: "cmd+9", source: "User" });
});

test("the editor runs the user's key and no longer runs a removed default", async () => {
  const ed = await plainEditor(["a", "b", "c"]);
  ed.keymap = K.resolve([{ key: "cmd+shift+d", command: "editor.action.deleteLines" }, { key: "cmd+shift+k", command: "-editor.action.deleteLines" }]);
  press(ed, "k", { cmd: true, shift: true });
  assert.deepEqual(ed.lines, ["a", "b", "c"]);
  press(ed, "d", { cmd: true, shift: true });
  assert.deepEqual(ed.lines, ["b", "c"]);
});

test("live() reads the file again when it changes", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-kb-")), "vscode-keybindings.json");
  const kb = K.live(file);
  assert.equal(kb.keymap.byChord.get("cmd+9"), undefined);
  assert.equal(kb.poll(), false);
  fs.writeFileSync(file, JSON.stringify([{ key: "cmd+9", command: "undo" }]));
  assert.equal(kb.poll(), true);
  assert.equal(kb.keymap.byChord.get("cmd+9"), "undo");
});

// ---------- per-OS default keys (keymap.json), labels and two-step chords ----------
test("the OS comes from VSEDIT_OS, else the platform", () => {
  assert.equal(Cmd.platform("win", "darwin"), "win");
  assert.equal(Cmd.platform(null, "darwin"), "mac");
  assert.equal(Cmd.platform(null, "win32"), "win");
  assert.equal(Cmd.platform(null, "linux"), "linux");
  assert.equal(Cmd.platform("bogus", "freebsd"), "linux");
});

test("keymap.json: every command has mac/win/linux keys in normalized form and an Editor method", () => {
  const data = require("../keymap.json").commands;
  assert.deepEqual(data.map(c => c.id).sort(), Object.keys(Cmd.RUNS).sort(), "keymap.json and RUNS name the same commands");
  for (const c of data) {
    for (const os of Cmd.OSES) {
      assert.ok(Array.isArray(c.keys[os]), `${c.id}: keys.${os}`);
      for (const k of c.keys[os]) assert.equal(Cmd.normalize(k), k, `${c.id}: ${k} is normalized`);
    }
  }
  for (const c of Cmd.COMMANDS) assert.equal(typeof Editor.prototype[c.run], "function", `${c.id} runs ${c.run}`);
});

test("each OS gets VS Code's own defaults, without the other OSes' keys", () => {
  const on = (os) => { const km = K.resolve([], os); return (key) => km.byChord.get(key); };
  const mac = on("mac"), win = on("win"), linux = on("linux");
  // macOS: ⌘ keys and the emacs keys; Select All is ⌘A only
  assert.equal(mac("cmd+a"), "editor.action.selectAll");
  assert.equal(mac("ctrl+a"), "cursorLineStart");
  assert.equal(mac("ctrl+e"), "cursorLineEnd");
  assert.equal(mac("ctrl+shift+a"), "cursorLineStartSelect");
  assert.equal(mac("ctrl+k"), "deleteAllRight");
  assert.equal(mac("ctrl+f"), "cursorRight");
  assert.equal(mac("ctrl+p"), "cursorUp");
  assert.equal(mac("ctrl+u"), "deleteAllLeft"); // what Herdr sends for ⌘⌫
  assert.equal(mac("ctrl+w"), "deleteWordLeft"); // what Herdr sends for ⌥⌫
  assert.equal(mac("ctrl+s"), undefined);
  assert.equal(mac("ctrl+shift+["), "editor.fold"); // ⌥⌘[ is Herdr's
  // Windows / Linux: Ctrl keys
  for (const k of [win, linux]) {
    assert.equal(k("ctrl+a"), "editor.action.selectAll");
    assert.equal(k("ctrl+w"), "workbench.action.closeActiveEditor");
    assert.equal(k("ctrl+u"), "cursorUndo");
    assert.equal(k("ctrl+e"), "workbench.action.quickOpen");
    assert.equal(k("ctrl+h"), "editor.action.startFindReplaceAction");
    assert.equal(k("ctrl+left"), "cursorWordLeft");
    assert.equal(k("ctrl+home"), "cursorTop");
    assert.equal(k("ctrl+shift+1"), "editor.action.replaceOne");
    assert.equal(k("cmd+s"), undefined);
  }
  assert.equal(win("ctrl+f4"), "workbench.action.closeActiveEditor");
  assert.equal(win("alt+left"), "workbench.action.navigateBack");
  assert.equal(win("alt+shift+up"), "editor.action.copyLinesUpAction");
  assert.equal(win("alt+shift+f"), "editor.action.formatDocument");
  assert.equal(linux("alt+left"), undefined);
  assert.equal(linux("ctrl+alt+-"), "workbench.action.navigateBack");
  assert.equal(linux("alt+shift+up"), undefined); // VS Code's Add Cursor Above
  assert.equal(linux("ctrl+alt+shift+up"), "editor.action.copyLinesUpAction");
  assert.equal(linux("ctrl+shift+i"), "editor.action.formatDocument");
  assert.equal(linux("ctrl+shift+f10"), "editor.action.peekDefinition");
});

test("labels follow the OS: macOS glyphs, else VS Code's Ctrl+Shift+K text", () => {
  assert.equal(Cmd.label("shift+cmd+k", "mac"), "⇧⌘K");
  assert.equal(Cmd.label("ctrl+alt+shift+up", "mac"), "⌃⌥⇧↑");
  assert.equal(Cmd.label("cmd+k cmd+j", "mac"), "⌘K ⌘J");
  assert.equal(Cmd.label("ctrl+shift+k", "win"), "Ctrl+Shift+K");
  assert.equal(Cmd.label("ctrl+alt+shift+up", "linux"), "Ctrl+Shift+Alt+UpArrow");
  assert.equal(Cmd.label("ctrl+k ctrl+0", "linux"), "Ctrl+K Ctrl+0");
  assert.equal(Cmd.label("shift+cmd+k", "win"), "Shift+Windows+K");
  assert.equal(Cmd.label("cmd+a", "linux"), "Super+A");
  assert.equal(K.resolve([], "win").label("workbench.action.closeActiveEditor"), "Ctrl+F4");
  assert.equal(K.resolve([], "linux").label("editor.foldAll"), "Ctrl+K Ctrl+0");
});

test("two-step chords: the first steps are prefixes; the user file adds and removes chords for this OS", () => {
  const km = K.resolve([{ key: "ctrl+k ctrl+d", command: "editor.action.deleteLines" }, { key: "ctrl+k ctrl+j", command: "-editor.unfoldAll" }], "linux");
  assert.ok(km.prefixes.has("ctrl+k"));
  assert.equal(km.byChord.get("ctrl+k ctrl+0"), "editor.foldAll");
  assert.equal(km.byChord.get("ctrl+k ctrl+d"), "editor.action.deleteLines");
  assert.equal(km.byChord.get("ctrl+k ctrl+j"), undefined);
  assert.equal(km.label("editor.action.deleteLines"), "Ctrl+K Ctrl+D");
  const none = K.resolve(["cmd+k cmd+0", "cmd+k cmd+j", "cmd+k cmd+l", "cmd+k cmd+s", "cmd+k cmd+c", "cmd+k cmd+u", "cmd+k cmd+x", "cmd+k m"]
    .map(key => ({ key, command: "-x" })).concat(Cmd.COMMANDS.filter(c => c.keys.mac.some(k => k.includes(" "))).map(c => ({ command: `-${c.id}` }))), "mac");
  assert.equal(none.prefixes.size, 0, "no chord left, no prefix");
});

test("a chord runs after its second key, with VS Code's status hint after the first", async () => {
  const ed = await plainEditor(["  a", "b"]);
  const fold = [];
  ed.unfoldAll = () => fold.push("unfold");
  press(ed, "k", { cmd: true });
  assert.equal(ed.message.text, "(⌘K) was pressed. Waiting for second key of chord...");
  press(ed, "j", { cmd: true });
  assert.deepEqual(fold, ["unfold"]);
  assert.equal(ed.message, null);
  press(ed, "k", { cmd: true });
  press(ed, "q", { cmd: true });
  assert.equal(ed.message.text, "The key combination (⌘K, ⌘Q) is not a command.");
  press(ed, "a", { ctrl: true }); // not part of a chord any more: line start
  assert.equal(ed.head.col, 0);
  press(ed, "k", { cmd: true });
  ed.handle({ type: "text", text: "m" }); // ⌘K M: a typed character is the second key
  assert.ok(ed.popup, "Change Language Mode opened");
});

test("⌘K ⌘C / ⌘K ⌘U add and remove line comments", async () => {
  const ed = await plainEditor(["a", "// b"], "/tmp/x.js");
  ed.comment = { line: "//" };
  ed.sel = { anchor: { line: 0, col: 0 }, head: { line: 1, col: 1 } };
  press(ed, "k", { cmd: true }); press(ed, "c", { cmd: true });
  assert.deepEqual(ed.lines, ["// a", "// // b"]);
  press(ed, "k", { cmd: true }); press(ed, "u", { cmd: true });
  assert.deepEqual(ed.lines, ["a", "// b"]);
});

test("macOS emacs keys: ⌃A / ⌃E line start and end, ⌃K and ⌃U (Herdr's ⌘⌫) delete to the end and start", async () => {
  const ed = await plainEditor(["  hello world"]);
  ed.moveTo({ line: 0, col: 7 });
  press(ed, "a", { ctrl: true });
  assert.equal(ed.head.col, 0);
  assert.ok(ed.empty, "not Select All");
  press(ed, "e", { ctrl: true });
  assert.equal(ed.head.col, 13);
  press(ed, "a", { ctrl: true, shift: true });
  assert.deepEqual([ed.sel.anchor.col, ed.head.col], [13, 0]);
  ed.moveTo({ line: 0, col: 8 });
  press(ed, "k", { ctrl: true });
  assert.deepEqual(ed.lines, ["  hello "]);
  press(ed, "u", { ctrl: true });
  assert.deepEqual(ed.lines, [""]);
});

test("Windows/Linux: Ctrl+W closes the editor and Ctrl+K Ctrl+0 folds all", async () => {
  const ed = await plainEditor(["a"]);
  ed.keymap = K.resolve([], "linux");
  const did = [];
  ed.foldAll = () => did.push("foldAll");
  ed.onExit = () => did.push("exit");
  press(ed, "k", { ctrl: true });
  assert.equal(ed.message.text, "(Ctrl+K) was pressed. Waiting for second key of chord...");
  press(ed, "0", { ctrl: true });
  press(ed, "w", { ctrl: true });
  assert.deepEqual(did, ["foldAll", "exit"]);
});

test("Find: Alt+Enter in Replace replaces every match as one undo step", async () => {
  const ed = await plainEditor(["a b a", "ba"]);
  ed.openFind(true);
  ed.handle({ type: "text", text: "a" });
  ed.find.field = "replace"; ed.handle({ type: "text", text: "z" });
  press(ed, "enter", { alt: true });
  assert.deepEqual(ed.lines, ["z b z", "bz"]);
  ed.undo();
  assert.deepEqual(ed.lines, ["a b a", "ba"]);
});

const FIND = require("../find.cjs");
const at = (r) => r.matches.map(m => [m.line, m.col, m.len]);

test("Find: case-insensitive by default; Match Case, Whole Word and Regex narrow or widen the matches", () => {
  const lines = ["Foo foo food", "x.y xzy"];
  assert.deepEqual(at(FIND.findMatches(lines, "foo")), [[0, 0, 3], [0, 4, 3], [0, 8, 3]]);
  assert.deepEqual(at(FIND.findMatches(lines, "foo", { caseSensitive: true })), [[0, 4, 3], [0, 8, 3]]);
  assert.deepEqual(at(FIND.findMatches(lines, "foo", { wholeWord: true })), [[0, 0, 3], [0, 4, 3]]);
  assert.deepEqual(at(FIND.findMatches(lines, "x.y")), [[1, 0, 3]]);                 // literal: the dot is a dot
  assert.deepEqual(at(FIND.findMatches(lines, "x.y", { regex: true })), [[1, 0, 3], [1, 4, 3]]);
  assert.deepEqual(at(FIND.findMatches(["한글 한글자"], "한글", { wholeWord: true })), [[0, 0, 2]]);
});

test("Find: an invalid regex has no matches and an error; empty matches are skipped", () => {
  const r = FIND.findMatches(["a(b"], "(", { regex: true });
  assert.deepEqual(r.matches, []);
  assert.ok(r.error);
  assert.deepEqual(at(FIND.findMatches(["ab"], "x*", { regex: true })), []);
});

test("Replace with a regex substitutes groups in place; without regex the text is literal", () => {
  const line = "let a = 1; let bb = 2;", opts = { regex: true };
  const [m1, m2] = FIND.findMatches([line], "let (\\w+)", opts).matches;
  assert.equal(FIND.replacementOf(line, m1, "let (\\w+)", opts, "const $1"), "const a");
  assert.equal(FIND.replacementOf(line, m2, "let (\\w+)", opts, "$&\\n"), "let bb\n");
  assert.equal(FIND.replacementOf(line, m1, "let", {}, "$1"), "$1");
});

test("Find widget: ⌥⌘C/⌥⌘W/⌥⌘R toggle through the keymap, the count reads N of M, and clicks press the buttons", async () => {
  const ed = await plainEditor(["Foo foo food"]);
  ed.rows = 10; ed.cols = 80;
  ed.openFind(false);
  ed.handle({ type: "text", text: "foo" });
  assert.equal(ed.matches().length, 3);
  press(ed, "c", { cmd: true, alt: true });
  assert.ok(ed.find.caseSensitive);
  assert.equal(ed.matches().length, 2);
  press(ed, "w", { cmd: true, alt: true });
  assert.equal(ed.matches().length, 1);
  assert.deepEqual(ed.range(), [{ line: 0, col: 4 }, { line: 0, col: 7 }]); // the search restarts and selects it
  const screen = ed.render(0).out.replace(/\x1b\[[\d;]*m/g, "");
  assert.match(screen, /1 of 1/);
  const dot = ed.findHits[4]; // ▸, field, Aa, ab, .*
  ed.handle({ type: "mouse", button: 0, x: dot.x, y: dot.y, release: false, motion: false });
  assert.ok(ed.find.regex);
  ed.handle({ type: "text", text: "x" });
  assert.match(ed.render(0).out.replace(/\x1b\[[\d;]*m/g, ""), /No results/);
  const toggle = ed.findHits[0];
  ed.handle({ type: "mouse", button: 0, x: toggle.x, y: toggle.y, release: false, motion: false });
  assert.ok(ed.prompt.replace);
  assert.equal(ed.find.field, "replace");
});

const click = (ed, x, y) => ed.handle({ type: "mouse", button: 0, x, y, release: false, motion: false });

test("status bar: Ln/Col opens Go to Line, Spaces picks tabs and a size for this file, LF switches to CRLF on save", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-status-")), "a.txt");
  fs.writeFileSync(file, "a\nb\n");
  const ed = new Editor(file, F.load(file), await H.loadGrammar(null), H.loadTheme(), null);
  ed.rows = 10; ed.cols = 100;
  ed.render(0);
  click(ed, ed.statusHits[0].x, ed.rows);
  assert.match(ed.popup.label, /^Go to line/);
  ed.closePopup();
  click(ed, ed.statusHits[1].x, ed.rows);
  assert.deepEqual(ed.popup.items.map(i => i.label), ["Indent Using Spaces", "Indent Using Tabs"]);
  press(ed, "down"); press(ed, "enter");
  assert.equal(ed.popup.items.length, 8);
  assert.equal(ed.popup.index, ed.tab - 1);
  ed.handle({ type: "text", text: "2" }); press(ed, "enter");
  assert.deepEqual(ed.indent, { useTabs: true, size: 2 });
  ed.render(0);
  assert.equal(ed.statusHits.length, 4); // Ln/Col, indentation, EOL, language: the encoding is display only
  click(ed, ed.statusHits[2].x, ed.rows);
  assert.deepEqual(ed.popup.items.map(i => i.label), ["LF", "CRLF"]);
  press(ed, "down"); press(ed, "enter");
  assert.ok(ed.buf.dirty);
  await ed.saveFile();
  assert.equal(fs.readFileSync(file, "utf8"), "a\r\nb\r\n");
  assert.ok(!ed.buf.dirty);
});

test("Change Language Mode lists the grammars and re-tokenizes with the chosen one", async () => {
  const ed = await plainEditor(["const x = 1; // hi"]);
  ed.rows = 10; ed.cols = 100;
  ed.runCommand("workbench.action.editor.changeLanguageMode");
  const labels = ed.popup.items.map(i => i.label);
  assert.equal(labels[ed.popup.index], "Plain Text");
  assert.ok(labels.includes("TypeScript") && labels.includes("Python") && labels.includes("Go"));
  ed.handle({ type: "text", text: "TypeScript" });
  assert.equal(ed.popup.items[0].label, "TypeScript");
  press(ed, "enter");
  for (let i = 0; i < 50 && ed.language !== "TypeScript"; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(ed.language, "TypeScript");
  assert.deepEqual(ed.comment, { line: "//" });
  ed.hl.ensure(0);
  assert.ok(ed.hl.tokens[0].length > 2, "not tokenized with the grammar");
});

const SYM = require("../symbols.cjs");

test("regex outline: functions and classes with their nesting and ranges, for brace and indent languages", () => {
  const py = ["class Shop:", "    def buy(self):", "        pass", "", "    def sell(self):", "        pass", "def main():", "    Shop()"];
  assert.deepEqual(SYM.outline(py).map(s => [s.name, s.kind, s.depth, s.container, s.range.end.line]),
    [["Shop", "class", 0, "", 5], ["buy", "function", 1, "Shop", 2], ["sell", "function", 1, "Shop", 5], ["main", "function", 0, "", 7]]);
  const go = ["package main", "", "func (s *Server) Start(port int) {", "\tlisten(port)", "}", "type Server struct {", "}", "export const add = (a, b) => a + b;"];
  assert.deepEqual(SYM.outline(go).map(s => [s.name, s.kind, s.at.col, s.range.end.line]),
    [["Start", "function", 17, 4], ["Server", "type", 5, 6], ["add", "function", 13, 7]]);
});

test("LSP document symbols (hierarchical or flat) and tsserver's navtree become one list in document order", () => {
  const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
  const tree = SYM.fromLsp([{ name: "A", kind: 5, range: r(0, 0, 9, 1), selectionRange: r(0, 6, 0, 7), children: [{ name: "m", kind: 6, detail: "()", range: r(1, 2, 3, 3), selectionRange: r(1, 2, 1, 3) }] }]);
  assert.deepEqual(tree.map(s => [s.name, s.kind, s.depth, s.container, s.at.line, s.at.col, s.detail]), [["A", "class", 0, "", 0, 6, ""], ["m", "method", 1, "A", 1, 2, "()"]]);
  const flat = SYM.fromLsp([{ name: "f", kind: 12, containerName: "mod", location: { uri: "file:///x", range: r(4, 0, 6, 1) } }]);
  assert.deepEqual(flat.map(s => [s.name, s.kind, s.container, s.range.end.line]), [["f", "function", "mod", 6]]);
  const span = (l1, o1, l2, o2) => ({ start: { line: l1, offset: o1 }, end: { line: l2, offset: o2 } });
  const nav = SYM.fromNavtree({ text: '"a"', kind: "module", spans: [span(1, 1, 9, 1)], childItems: [
    { text: "React", kind: "alias", spans: [span(1, 8, 1, 13)] },
    { text: "App", kind: "function", spans: [span(3, 1, 5, 2)], nameSpan: span(3, 10, 3, 13), childItems: [{ text: "<function>", kind: "function", spans: [span(4, 1, 4, 9)] }] }] });
  assert.deepEqual(nav.map(s => [s.name, s.kind, s.at.line, s.at.col, s.range.end.line]), [["App", "function", 2, 9, 4]]);
});

test("the breadcrumbs follow the cursor into the symbols around it; off, they show only the file name", async () => {
  const ed = await plainEditor(["class Shop:", "    def buy(self):", "        pass", "x = 1"], "/tmp/vsedit-crumbs/shop.py");
  ed.crumbs = ["src", "shop.py"];
  ed.moveTo({ line: 2, col: 4 });
  assert.equal(ed.crumbText(), " src › shop.py"); // the outline is loading
  await ed.loadOutline();
  assert.equal(ed.crumbText(), " src › shop.py › Shop › buy");
  ed.moveTo({ line: 3, col: 0 });
  assert.equal(ed.crumbText(), " src › shop.py");
  ed.settings = { ...ed.settings, "breadcrumbs.enabled": false };
  assert.equal(ed.crumbText(), " shop.py");
});

test("Go to Symbol in Editor (⇧⌘O) lists the outline, names its source and jumps; a breadcrumb click opens it", async () => {
  const ed = await plainEditor(["def one():", "    pass", "def two():", "    pass"], "/tmp/vsedit-crumbs/two.py");
  ed.rows = 10; ed.cols = 100;
  await ed.runCommand("workbench.action.gotoSymbol");
  assert.equal(ed.popup.text, "@");
  assert.equal(ed.popup.note, "regex outline (no language server)");
  assert.deepEqual(ed.popup.items.map(i => [i.label, i.detail]), [["one", "function"], ["two", "function"]]);
  ed.handle({ type: "text", text: "tw" }); press(ed, "enter");
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(ed.head, { line: 2, col: 4 });
  ed.handle({ type: "mouse", button: 0, x: 3, y: 1, release: false, motion: false });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ed.popup?.text, "@");
});

test("breadcrumbs.enabled defaults to true and only takes a boolean", () => {
  assert.equal(S.normalize({})["breadcrumbs.enabled"], true);
  assert.equal(S.normalize({ "breadcrumbs.enabled": false })["breadcrumbs.enabled"], false);
  assert.equal(S.normalize({ "breadcrumbs.enabled": "no" })["breadcrumbs.enabled"], true);
});

const { diagnosticsOf } = require("../lang/lsp.cjs");
const { tsDiagnostics } = require("../lang/tsserver.cjs");

test("diagnostics: LSP publishDiagnostics and tsserver's diag events become the same shape", () => {
  const r = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
  const lsp = [{ range: r, severity: 2, message: "unused", source: "rustc", code: "E1" }, { range: r, message: "no severity" }, { message: "no range" }];
  assert.deepEqual(diagnosticsOf({ diagnostics: lsp }), [ // raw: the server's own, for its code action requests
    { start: { line: 1, col: 2 }, end: { line: 1, col: 5 }, severity: 2, message: "unused", source: "rustc(E1)", raw: lsp[0] },
    { start: { line: 1, col: 2 }, end: { line: 1, col: 5 }, severity: 1, message: "no severity", source: "", raw: lsp[1] }]);
  assert.deepEqual(tsDiagnostics([{ start: { line: 1, offset: 19 }, end: { line: 1, offset: 26 }, text: "Cannot find module", code: 2307, category: "error" },
    { start: { line: 3, offset: 1 }, end: { line: 3, offset: 2 }, text: "unused", code: 6133, category: "suggestion" }]), [
    { start: { line: 0, col: 18 }, end: { line: 0, col: 25 }, severity: 1, message: "Cannot find module", source: "ts(2307)", code: 2307 },
    { start: { line: 2, col: 0 }, end: { line: 2, col: 1 }, severity: 4, message: "unused", source: "ts(6133)", code: 6133 }]);
});

const withProblems = async (lines, list) => {
  const ed = await plainEditor(lines);
  ed.rows = 12; ed.cols = 100;
  ed.session = { diagnostics: () => list, symbols: async () => ({ source: "test", items: [] }), can: () => false };
  return ed;
};
const problem = (l1, c1, l2, c2, severity, message) => ({ start: { line: l1, col: c1 }, end: { line: l2, col: c2 }, severity, message, source: "ts(1)" });

test("diagnostics draw curly underlines in the severity's color, a gutter mark and overview ruler marks", async () => {
  const ed = await withProblems(["let a = b;", "ok", "warn here"], [problem(0, 8, 0, 9, 1, "Cannot find name 'b'."), problem(2, 0, 2, 4, 2, "careful"), problem(1, 0, 1, 2, 4, "a hint")]);
  const out = ed.render(0).out;
  assert.match(out, /\x1b\[4m\x1b\[4:3m\x1b\[58:2::241:76:76m(?:\x1b\[[\d;]*m)*b/, "no red squiggle under b");
  assert.match(out, /\x1b\[4m\x1b\[4:3m\x1b\[58:2::204:167:0m(?:\x1b\[[\d;]*m)*warn/, "no yellow squiggle under warn");
  assert.ok(/\x1b\[59m/.test(out), "the underline color is not reset after a squiggle");
  assert.match(out, /\x1b\[2;1H(?:\x1b\[[\d;]*m)*●/, "no mark in the gutter of line 1");
  assert.doesNotMatch(out, /\x1b\[3;1H(?:\x1b\[[\d;]*m)*●/, "hints get no mark");
  const marks = ed.rulerMarks([], null, ed.problems());
  assert.equal(marks.filter(Boolean).length >= 2, true);
});

test("the problem at the cursor shows in the status bar, else the counts; F8 / ⇧F8 walk the problems, wrapping", async () => {
  const ed = await withProblems(["let a = b;", "ok", "warn here"], [problem(0, 8, 0, 9, 1, "Cannot find name 'b'."), problem(2, 0, 2, 4, 2, "careful")]);
  const status = () => ed.render(0).out.split(`\x1b[${ed.rows};1H`).pop().replace(/\x1b\[[\d;:]*m/g, "");
  assert.match(status(), /⊗ 1 {2}⚠ 1/);
  press(ed, "f8");
  assert.deepEqual(ed.head, { line: 0, col: 8 });
  assert.match(status(), /Cannot find name 'b'\. {2}ts\(1\)/);
  press(ed, "f8");
  assert.deepEqual(ed.head, { line: 2, col: 0 });
  assert.match(status(), /careful/);
  press(ed, "f8");
  assert.deepEqual(ed.head, { line: 0, col: 8 });
  press(ed, "f8", { shift: true });
  assert.deepEqual(ed.head, { line: 2, col: 0 });
});

test("an empty problem range underlines the character at it, or the last one at the line end", () => {
  const span = (c, text) => Editor.problemSpan({ start: { line: 0, col: c }, end: { line: 0, col: c } }, 0, text);
  assert.deepEqual(span(1, "abc"), { from: 1, to: 2 });
  assert.deepEqual(span(3, "abc"), { from: 2, to: 3 });
  assert.equal(span(0, ""), null);
});

// ---------- small batch: line selection, join, block comment, brackets, selection search, Save As / Save All ----------
const sel = (ed) => [ed.sel.anchor.line, ed.sel.anchor.col, ed.sel.head.line, ed.sel.head.col];
const jsEditor = async (lines, scope = "source.js", file = "/tmp/x.js") => {
  const ed = new Editor(file, { lines, eol: "\n", finalNewline: true }, await H.loadGrammar(scope), H.loadTheme(), scope);
  ed.hl.ensure(lines.length - 1);
  return ed;
};

test("Expand Line Selection selects the line, each press adds the next one, the last line to its end", async () => {
  const ed = await plainEditor(["ab", "cd", "ef"]);
  ed.moveTo({ line: 0, col: 1 });
  ed.runCommand("expandLineSelection");
  assert.deepEqual(sel(ed), [0, 0, 1, 0]);
  ed.runCommand("expandLineSelection");
  assert.deepEqual(sel(ed), [0, 0, 2, 0]);
  ed.runCommand("expandLineSelection");
  assert.deepEqual(sel(ed), [0, 0, 2, 2]);
  ed.runCommand("expandLineSelection");
  assert.deepEqual(sel(ed), [0, 0, 2, 2]);
});

test("Join Lines joins the next line with one space, drops its indent and blank lines, and keeps a selection's end", async () => {
  const ed = await plainEditor(["foo", "    bar", "x  ", "y"]);
  ed.runCommand("editor.action.joinLines");
  assert.deepEqual(ed.lines, ["foo bar", "x  ", "y"]);
  assert.deepEqual(sel(ed), [0, 3, 0, 3]); // at the join, before the space
  ed.moveTo({ line: 1, col: 0 });
  ed.joinLines();
  assert.deepEqual(ed.lines, ["foo bar", "x y"]); // trailing whitespace becomes the one space
  assert.deepEqual(sel(ed), [1, 2, 1, 2]);
  ed.joinLines(); // the last line: the cursor goes to its end, nothing changes
  assert.deepEqual(ed.lines, ["foo bar", "x y"]);
  assert.deepEqual(sel(ed), [1, 3, 1, 3]);
  const multi = await plainEditor(["a", "", "  bc", "d"]);
  multi.sel = { anchor: { line: 0, col: 0 }, head: { line: 2, col: 3 } };
  multi.joinLines();
  assert.deepEqual(multi.lines, ["a bc", "d"]);
  assert.deepEqual(sel(multi), [0, 0, 0, 3]); // one character before the end, as before
  multi.undo();
  assert.deepEqual(multi.lines, ["a", "", "  bc", "d"]);
});

test("Delete All Right / Left delete the line break at the line's end / start", async () => {
  const ed = await plainEditor(["ab", "cd"]);
  ed.moveTo({ line: 0, col: 1 });
  ed.runCommand("deleteAllRight");
  assert.deepEqual(ed.lines, ["a", "cd"]);
  ed.runCommand("deleteAllRight");
  assert.deepEqual(ed.lines, ["acd"]);
  ed.moveTo({ line: 0, col: 0 });
  ed.runCommand("deleteAllLeft"); // the first line: nothing before it
  assert.deepEqual(ed.lines, ["acd"]);
  const two = await plainEditor(["ab", "cd"]);
  two.moveTo({ line: 1, col: 0 });
  two.runCommand("deleteAllLeft");
  assert.deepEqual(two.lines, ["abcd"]);
  assert.deepEqual(sel(two), [0, 2, 0, 2]);
});

test("Toggle Block Comment wraps the selection in the language's block comment and takes it off again", async () => {
  const ed = await jsEditor(["let x = 1;"]);
  ed.sel = { anchor: { line: 0, col: 4 }, head: { line: 0, col: 5 } };
  ed.runCommand("editor.action.blockComment");
  assert.deepEqual(ed.lines, ["let /* x */ = 1;"]);
  assert.deepEqual(sel(ed), [0, 7, 0, 8]); // the text stays selected
  ed.blockComment();
  assert.deepEqual(ed.lines, ["let x = 1;"]);
  assert.deepEqual(sel(ed), [0, 4, 0, 5]);
  ed.moveTo({ line: 0, col: 10 }); // empty selection: an empty comment, the cursor inside
  ed.blockComment();
  assert.deepEqual(ed.lines, ["let x = 1;/*  */"]);
  assert.deepEqual(sel(ed), [0, 13, 0, 13]);
  ed.blockComment();
  assert.deepEqual(ed.lines, ["let x = 1;"]);
  const multi = await jsEditor(["a", "b"]);
  multi.sel = { anchor: { line: 0, col: 0 }, head: { line: 1, col: 1 } };
  multi.blockComment();
  assert.deepEqual(multi.lines, ["/* a", "b */"]);
  multi.blockComment();
  assert.deepEqual(multi.lines, ["a", "b"]);
  const py = await jsEditor(["x"], "source.python", "/tmp/x.py");
  py.selectAll(); py.blockComment();
  assert.deepEqual(py.lines, ['""" x """']);
  const plain = await plainEditor(["x"]);
  plain.selectAll(); plain.blockComment();
  assert.deepEqual(plain.lines, ["x"]);
  assert.match(plain.message.text, /No block comment syntax known for Plain Text/);
});

test("block comment pairs follow VS Code's language configurations", () => {
  assert.deepEqual(L.blockCommentOf("source.ts"), ["/*", "*/"]);
  assert.deepEqual(L.blockCommentOf("source.css"), ["/*", "*/"]);
  assert.deepEqual(L.blockCommentOf("text.html.basic"), ["<!--", "-->"]);
  assert.deepEqual(L.blockCommentOf("source.lua"), ["--[[", "]]"]);
  assert.equal(L.blockCommentOf("source.shell"), null);
  assert.equal(L.blockCommentOf("text.pug"), null);
  assert.equal(L.blockCommentOf(null), null);
});

test("Go to Bracket jumps between partners, to the closer around the cursor, else to the next bracket", async () => {
  const ed = await jsEditor(["foo(a, [b]) ", 'f(")")']);
  const go = (col, line = 0) => { ed.moveTo({ line, col }); ed.runCommand("editor.action.jumpToBracket"); return [ed.head.line, ed.head.col]; };
  assert.deepEqual(go(4), [0, 10]);  // after `(`: before its `)`
  ed.jumpToBracket();
  assert.deepEqual([ed.head.line, ed.head.col], [0, 3]); // and back before the `(`
  assert.deepEqual(go(8), [0, 9]);   // after `[`
  assert.deepEqual(go(5), [0, 10]);  // inside (…): its closer
  assert.deepEqual(go(0), [0, 3]);   // before any bracket: the next one
  assert.deepEqual(go(2, 1), [1, 5]); // the `)` in the string doesn't count
});

test("Select to Bracket selects the pair with its brackets, backwards from the closer", async () => {
  const ed = await jsEditor(["foo(a, [b]) x"]);
  ed.moveTo({ line: 0, col: 5 });
  ed.runCommand("editor.action.selectToBracket");
  assert.deepEqual(sel(ed), [0, 3, 0, 11]);
  ed.moveTo({ line: 0, col: 11 });
  ed.selectToBracket();
  assert.deepEqual(sel(ed), [0, 11, 0, 3]);
  ed.moveTo({ line: 0, col: 12 });
  ed.selectToBracket(); // nothing around or after: unchanged
  assert.deepEqual(sel(ed), [0, 12, 0, 12]);
});

test("Find With Selection opens Find with the selection or the word; Find Next / Previous Selection move without it", async () => {
  const ed = await plainEditor(["foo bar foo", "bar"]);
  ed.moveTo({ line: 0, col: 1 });
  ed.runCommand("actions.findWithSelection");
  assert.equal(ed.find.query, "foo");
  assert.equal(ed.prompt.kind, "find");
  ed.prompt = null;
  ed.sel = { anchor: { line: 0, col: 4 }, head: { line: 0, col: 7 } };
  ed.runCommand("editor.action.nextSelectionMatchFindAction");
  assert.equal(ed.find.query, "bar");
  assert.deepEqual(sel(ed), [1, 0, 1, 3]);
  assert.equal(ed.prompt, null);
  ed.moveTo({ line: 0, col: 9 });
  ed.runCommand("editor.action.previousSelectionMatchFindAction");
  assert.equal(ed.find.query, "foo");
  assert.deepEqual(sel(ed), [0, 0, 0, 3]);
  ed.findSelection(-1); // wraps
  assert.deepEqual(sel(ed), [0, 8, 0, 11]);
});

const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(ok()); };

test("Save As asks for a path in the file's folder, saves there and goes on editing that file", async () => {
  process.env.VSEDIT_BACKUPS = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-bk-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-saveas-")), file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "one\n");
  const ed = new Editor(file, F.load(file), await H.loadGrammar(null), H.loadTheme(), null);
  ed.typed("x");
  ed.runCommand("workbench.action.files.saveAs");
  assert.equal(ed.popup.text, dir + path.sep);
  ed.handle({ type: "text", text: "b.js" }); // typed after the folder, not over it
  ed.handle({ type: "key", name: "enter" });
  await until(() => fs.existsSync(path.join(dir, "b.js")) && !ed.buf.dirty);
  assert.equal(fs.readFileSync(path.join(dir, "b.js"), "utf8"), "xone\n");
  assert.equal(fs.readFileSync(file, "utf8"), "one\n");
  assert.equal(ed.file, path.join(dir, "b.js"));
  assert.equal(ed.language, "JavaScript");
  assert.equal(ed.docs.has(file), false);
  ed.saveAs(); // an existing file: asks first
  ed.popup.text = file; ed.handle({ type: "key", name: "enter" });
  assert.match(ed.popup.title, /'a.txt' already exists/);
  ed.handle({ type: "key", name: "escape" });
  assert.equal(fs.readFileSync(file, "utf8"), "one\n");
  ed.saveAs();
  ed.popup.text = path.join(dir, "missing", "c.txt"); ed.handle({ type: "key", name: "enter" });
  assert.match(ed.message.text, /Folder not found/);
  delete process.env.VSEDIT_BACKUPS;
});

test("Save All writes every unsaved open file, leaving one changed on disk", async () => {
  process.env.VSEDIT_BACKUPS = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-bk-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-saveall-")), [a, b, c] = ["a.txt", "b.txt", "c.txt"].map(n => path.join(dir, n));
  for (const f of [a, b, c]) fs.writeFileSync(f, "1\n");
  const ed = new Editor(a, F.load(a), await H.loadGrammar(null), H.loadTheme(), null);
  for (const f of [b, c, a]) { await ed.open(f); ed.typed("x"); }
  fs.writeFileSync(c, "changed elsewhere\n");
  await ed.runCommand("workbench.action.files.saveAll");
  assert.equal(fs.readFileSync(a, "utf8"), "x1\n");
  assert.equal(fs.readFileSync(b, "utf8"), "x1\n");
  assert.equal(fs.readFileSync(c, "utf8"), "changed elsewhere\n");
  assert.match(ed.message.text, /Not saved, changed on disk: c.txt/);
  delete process.env.VSEDIT_BACKUPS;
});

test("the new commands have VS Code's keys on each OS", () => {
  const on = (os) => { const km = K.resolve([], os); return (key) => km.byChord.get(key); };
  const mac = on("mac"), win = on("win"), linux = on("linux");
  assert.equal(mac("cmd+l"), "expandLineSelection");
  assert.equal(win("ctrl+l"), "expandLineSelection");
  assert.equal(mac("shift+cmd+s"), "workbench.action.files.saveAs");
  assert.equal(linux("ctrl+shift+s"), "workbench.action.files.saveAs");
  assert.equal(mac("alt+cmd+s"), "workbench.action.files.saveAll");
  assert.equal(win("ctrl+k s"), "workbench.action.files.saveAll");
  assert.equal(mac("shift+cmd+\\"), "editor.action.jumpToBracket");
  assert.equal(linux("ctrl+shift+\\"), "editor.action.jumpToBracket");
  assert.equal(mac("cmd+e"), "actions.findWithSelection");
  assert.equal(win("ctrl+e"), "workbench.action.quickOpen");
  assert.equal(mac("cmd+f3"), "editor.action.nextSelectionMatchFindAction");
  assert.equal(win("ctrl+shift+f3"), "editor.action.previousSelectionMatchFindAction");
  assert.equal(mac("ctrl+j"), "editor.action.joinLines");
  assert.equal(win("ctrl+j"), undefined);
  assert.equal(mac("alt+shift+a"), "editor.action.blockComment");
  assert.equal(win("alt+shift+a"), "editor.action.blockComment");
  assert.equal(linux("ctrl+shift+a"), "editor.action.blockComment");
  assert.equal(linux("alt+shift+a"), undefined);
  assert.equal(Cmd.label("shift+cmd+\\", "mac"), "⇧⌘\\");
  assert.equal(Cmd.label("ctrl+k s", "win"), "Ctrl+K S");
  assert.equal(keyOf("\x1b[92;10u"), "shift+cmd+\\"); // Kitty ⇧⌘\
  assert.equal(keyOf("\x1b[13;9~"), "cmd+f3");
});

// ---------- medium batch: line comments ----------
test("line comments: toggle comments all non-blank lines unless all are commented; blank-only lines get comments too", async () => {
  const ed = await jsEditor(["a", "// b", "", "c"]);
  ed.selectAll();
  ed.runCommand("editor.action.commentLine");
  assert.deepEqual(ed.lines, ["// a", "// // b", "", "// c"]);
  ed.runCommand("editor.action.commentLine");
  assert.deepEqual(ed.lines, ["a", "// b", "", "c"]);
  const blank = await jsEditor(["", "  "]);
  blank.selectAll();
  blank.runCommand("editor.action.commentLine");
  assert.deepEqual(blank.lines, ["// ", "//   "]);
  blank.runCommand("editor.action.removeCommentLine");
  assert.deepEqual(blank.lines, ["", "  "]);
});

test("Add / Remove Line Comment comment every line again / uncomment only the commented ones, the cursor following its text", async () => {
  const ed = await jsEditor(["  a", "  // b", "c"]);
  ed.sel = { anchor: { line: 0, col: 2 }, head: { line: 2, col: 1 } };
  ed.runCommand("editor.action.addCommentLine");
  assert.deepEqual(ed.lines, ["//   a", "//   // b", "// c"]); // at the smallest indent, already commented lines again
  assert.deepEqual(sel(ed), [0, 5, 2, 4]);
  ed.runCommand("editor.action.removeCommentLine");
  assert.deepEqual(ed.lines, ["  a", "  // b", "c"]);
  ed.runCommand("editor.action.removeCommentLine");
  assert.deepEqual(ed.lines, ["  a", "  b", "c"]);
});

test("line comment commands in a language with only block comments put one block comment around the lines", async () => {
  const css = await jsEditor(["a { color: red; }", "b {}"], "source.css", "/tmp/x.css");
  css.sel = { anchor: { line: 0, col: 0 }, head: { line: 1, col: 4 } };
  css.runCommand("editor.action.commentLine");
  assert.deepEqual(css.lines, ["/* a { color: red; }", "b {} */"]);
  css.runCommand("editor.action.commentLine");
  assert.deepEqual(css.lines, ["a { color: red; }", "b {}"]);
  css.moveTo({ line: 0, col: 2 }); // nothing selected: the cursor line's text, the cursor staying on it
  css.runCommand("editor.action.addCommentLine");
  assert.deepEqual(css.lines, ["/* a { color: red; } */", "b {}"]);
  assert.deepEqual(sel(css), [0, 5, 0, 5]);
  css.runCommand("editor.action.removeCommentLine");
  assert.deepEqual(css.lines, ["a { color: red; }", "b {}"]);
  assert.deepEqual(sel(css), [0, 2, 0, 2]);
  const html = await jsEditor(["  <p>x</p>"], "text.html.basic", "/tmp/x.html");
  html.runCommand("editor.action.commentLine");
  assert.deepEqual(html.lines, ["  <!-- <p>x</p> -->"]);
});

// ---------- medium batch: Cursor Undo / Redo ----------
test("Cursor Undo / Redo walk back and forth through cursor and selection changes; a new move ends redo, an edit clears both", async () => {
  const ed = await plainEditor(["abc", "def", "ghi"]);
  const key = (name, m) => { press(ed, name, m); ed.afterEvent(); };
  ed.afterEvent();
  key("down"); key("right"); ed.selectAll(); ed.afterEvent();
  key("u", { cmd: true });
  assert.deepEqual(sel(ed), [1, 1, 1, 1]);
  key("u", { cmd: true });
  assert.deepEqual(sel(ed), [1, 0, 1, 0]);
  ed.runCommand("cursorRedo"); ed.afterEvent();
  assert.deepEqual(sel(ed), [1, 1, 1, 1]);
  ed.runCommand("cursorRedo"); ed.afterEvent();
  assert.deepEqual(sel(ed), [0, 0, 2, 3]);
  ed.runCommand("cursorRedo"); ed.afterEvent();
  assert.deepEqual(sel(ed), [0, 0, 2, 3], "nothing left to redo");
  key("u", { cmd: true }); key("left");
  ed.runCommand("cursorRedo"); ed.afterEvent();
  assert.deepEqual(sel(ed), [1, 0, 1, 0], "a move after Cursor Undo drops the redo states");
  ed.typed("x"); ed.afterEvent();
  key("u", { cmd: true });
  assert.deepEqual(sel(ed), [1, 1, 1, 1], "an edit clears the cursor states");
});

test("Cursor Undo keeps at most 50 states and brings back the scroll position", async () => {
  const ed = await plainEditor(Array.from({ length: 100 }, (_, i) => `line ${i}`));
  ed.rows = 12; ed.afterEvent();
  for (let i = 0; i < 60; i++) { ed.moveTo({ line: i, col: 0 }); ed.afterEvent(); }
  const top = ed.top;
  ed.moveTo({ line: 99, col: 0 }); ed.afterEvent();
  ed.runCommand("cursorUndo"); ed.afterEvent();
  assert.deepEqual([ed.head.line, ed.top], [59, top]);
  for (let i = 0; i < 60; i++) { ed.runCommand("cursorUndo"); ed.afterEvent(); }
  assert.equal(ed.head.line, 10, "the oldest of the 50 states (lines 10-59)");
});

// ---------- medium batch: Expand / Shrink Selection ----------
// A language session stub: can(op) from `ops`, the provider methods from `impl`.
const stubSession = (impl, ops = Object.keys(impl), diags = []) => ({ can: (op) => ops.includes(op), provider: (op) => (ops.includes(op) ? impl : null),
  run: async (op, method, ctx, ...rest) => impl[method](ctx, ...rest), diagnostics: () => diags, symbols: async () => ({ source: "t", items: [] }), touch() {}, saved() {} });
const SS = require("../smartselect.cjs");
const rangeOf = (r) => [r.start.line, r.start.col, r.end.line, r.end.col];

test("Expand Selection grows from the word to the string's contents, the string, the brackets' contents, the brackets, the line, the text", async () => {
  const ed = await jsEditor(['call(a, "hi there");', "x"]);
  ed.session = stubSession({}); // no language server
  ed.moveTo({ line: 0, col: 13 });
  const steps = [];
  for (let i = 0; i < 8; i++) { await ed.runCommand("editor.action.smartSelect.expand"); steps.push(sel(ed)); }
  assert.deepEqual(steps, [[0, 12, 0, 17], [0, 9, 0, 17], [0, 8, 0, 18], [0, 5, 0, 18], [0, 4, 0, 19], [0, 0, 0, 20], [0, 0, 1, 1], [0, 0, 1, 1]]);
  await ed.runCommand("editor.action.smartSelect.shrink");
  assert.deepEqual(sel(ed), [0, 0, 0, 20]);
  for (let i = 0; i < 7; i++) await ed.runCommand("editor.action.smartSelect.shrink");
  assert.deepEqual(sel(ed), [0, 13, 0, 13], "back to where it started");
  ed.moveTo({ line: 0, col: 1 });
  await ed.runCommand("editor.action.smartSelect.shrink");
  assert.deepEqual(sel(ed), [0, 1, 0, 1], "shrinking a selection that wasn't grown does nothing");
});

test("Expand Selection: a block's lines after its brackets; Alt+Shift+→ / ⌃⇧⌘→ on each OS", async () => {
  const lines = ["if (x) {", "  y();", "}"], code = () => true;
  const chain = SS.chain({ start: { line: 1, col: 2 }, end: { line: 1, col: 2 } }, SS.fallbackRanges(lines, { line: 1, col: 2 }, code)).map(rangeOf);
  assert.deepEqual(chain, [[1, 2, 1, 2], [1, 2, 1, 3], [1, 2, 1, 6], [1, 0, 1, 6], [0, 8, 2, 0], [0, 7, 2, 1], [0, 0, 2, 1]]);
  assert.equal(K.resolve([], "mac").byChord.get("ctrl+shift+cmd+right"), "editor.action.smartSelect.expand");
  assert.equal(K.resolve([], "win").byChord.get("alt+shift+left"), "editor.action.smartSelect.shrink");
  assert.equal(K.resolve([], "linux").byChord.get("alt+shift+right"), "editor.action.smartSelect.expand");
  assert.equal(keyOf("\x1b[1;14C"), "ctrl+shift+cmd+right");
});

test("Expand Selection takes the language server's ranges with its own; a failing server leaves its own", async () => {
  const ed = await plainEditor(["a.b.c"]);
  let fail = false;
  ed.session = { can: (op) => op === "selectionRange", diagnostics: () => [], symbols: async () => ({ source: "t", items: [] }),
    run: async () => { if (fail) throw new Error("server gone"); return [{ start: { line: 0, col: 0 }, end: { line: 0, col: 3 } }]; } };
  ed.moveTo({ line: 0, col: 2 });
  for (const want of [[0, 2, 0, 3], [0, 0, 0, 3], [0, 0, 0, 5]]) { await ed.runCommand("editor.action.smartSelect.expand"); assert.deepEqual(sel(ed), want); }
  fail = true;
  ed.moveTo({ line: 0, col: 2 });
  await ed.runCommand("editor.action.smartSelect.expand"); await ed.runCommand("editor.action.smartSelect.expand");
  assert.deepEqual(sel(ed), [0, 0, 0, 5]);
});

// ---------- medium batch: Format Selection ----------

test("a document formatter's changes are kept to the selected lines, or refused when a change crosses their edges", () => {
  const lines = ["a", "  b", "c", "  d"], whole = (text) => [{ start: { line: 0, col: 0 }, end: { line: 3, col: 3 }, text }];
  assert.deepEqual(E.editsWithin(lines, whole("a\nb\nc\nd"), 1, 2), [{ start: { line: 1, col: 0 }, end: { line: 2, col: 1 }, text: "b\nc" }]);
  assert.deepEqual(E.applyToLines(lines, E.editsWithin(lines, whole("a\nb\nc\nd"), 1, 2)), ["a", "b", "c", "  d"]);
  assert.deepEqual(E.editsWithin(lines, whole("a\n  b\nc\nd"), 0, 2), [], "the change is outside");
  assert.equal(E.editsWithin(lines, whole("a\nb c\nd"), 1, 1), null, "lines 2-3 joined across the edge");
  assert.deepEqual(E.applyToLines(lines, E.editsWithin(lines, whole("x\na\nb\nc\nd"), 1, 3)), ["a", "b", "c", "d"], "an insertion before the selection is left out");
});

test("Format Selection uses the range formatter, else restricts the document formatter, else says it can't", async () => {
  const ed = await plainEditor(["a", "  b", "  c"]);
  ed.session = stubSession({ formatRange: async (ctx) => [{ start: ctx.sel.start, end: ctx.sel.end, text: ctx.lines[ctx.sel.start.line].trim() }] });
  ed.moveTo({ line: 1, col: 3 });
  press(ed, "k", { cmd: true }); await press(ed, "f", { cmd: true });
  assert.deepEqual(ed.lines, ["a", "b", "  c"], "the cursor line when nothing is selected");
  ed.session = stubSession({ formatRange: async () => null, format: async () => [{ start: { line: 0, col: 0 }, end: { line: 2, col: 3 }, text: "A\nb\nc" }] });
  ed.sel = { anchor: { line: 1, col: 0 }, head: { line: 2, col: 1 } };
  await ed.runCommand("editor.action.formatSelection");
  assert.deepEqual(ed.lines, ["a", "b", "c"], "only the selected lines changed");
  ed.session = stubSession({ format: async () => [{ start: { line: 0, col: 0 }, end: { line: 2, col: 1 }, text: "a b c" }] });
  await ed.runCommand("editor.action.formatSelection");
  assert.deepEqual(ed.lines, ["a", "b", "c"]);
  assert.match(ed.message.text, /Format Selection isn't supported here/);
  ed.session = stubSession({});
  await ed.runCommand("editor.action.formatSelection");
  assert.match(ed.message.text, /No format selection support for Plain Text/);
  assert.equal(K.resolve([], "linux").byChord.get("ctrl+k ctrl+f"), "editor.action.formatSelection");
});

// ---------- medium batch: Quick Fix ----------
const tick = () => new Promise(r => setTimeout(r, 5));

test("Quick Fix (⌘.) lists the fixes for the problem at the cursor, preferred first, then the refactorings, and applies one", async () => {
  const p = problem(0, 8, 0, 9, 1, "Cannot find name 'b'.");
  const ed = await withProblems(["let a = b;"], [p]);
  const asked = [];
  const fix = (title, preferred) => ({ title, kind: "quickfix", preferred, resolve: async () => ({ [ed.file]: [{ start: { line: 0, col: 8 }, end: { line: 0, col: 9 }, text: "c" }] }) });
  ed.session = stubSession({ quickFixes: async (ctx) => { asked.push(ctx); return [fix("Change spelling"), fix("Declare 'b'", true)]; },
    refactors: async () => [{ title: "Extract to constant", resolve: async () => ({}) }] }, ["quickFix", "refactor"], [p]);
  ed.moveTo({ line: 0, col: 8 });
  await press(ed, ".", { cmd: true });
  assert.deepEqual(asked[0].diagnostics, [p]);
  assert.deepEqual(ed.popup.rows.map(r => r.sep ? "-" : r.title), ["Declare 'b'", "Change spelling", "-", "Extract to constant"]);
  assert.equal(ed.popup.index, 0);
  press(ed, "down"); press(ed, "enter");
  await tick();
  assert.deepEqual(ed.lines, ["let a = c;"]);
});

test("Quick Fix away from a problem on the line takes the nearest one and its range; nothing at all says so", async () => {
  const p = problem(0, 8, 0, 9, 1, "Cannot find name 'b'.");
  const ed = await withProblems(["let a = b;"], [p]);
  let asked;
  ed.session = stubSession({ quickFixes: async (ctx) => { asked = ctx; return []; }, refactors: async () => [] }, ["quickFix", "refactor"], [p]);
  ed.moveTo({ line: 0, col: 1 });
  await ed.runCommand("editor.action.quickFix");
  assert.deepEqual(asked.diagnostics, [p]);
  assert.deepEqual(asked.sel, { start: p.start, end: p.end });
  assert.equal(ed.message.text, "No code actions available");
  assert.equal(K.resolve([], "win").byChord.get("ctrl+."), "editor.action.quickFix");
});

test("the light bulb shows in the gutter of the cursor line once its problems have quick fixes", async () => {
  const p = problem(0, 8, 0, 9, 1, "Cannot find name 'b'.");
  const ed = await withProblems(["let a = b;", "ok"], [p]);
  ed.session = stubSession({ quickFixes: async () => [{ title: "Declare 'b'" }] }, ["quickFix"], [p]);
  assert.doesNotMatch(ed.render(0).out, /◆/);
  await new Promise(r => setTimeout(r, 300));
  assert.match(ed.render(0).out, /\x1b\[2;1H(?:\x1b\[[\d;]*m)*◆/, "no light bulb on line 1");
  ed.moveTo({ line: 1, col: 0 });
  assert.doesNotMatch(ed.render(0).out, /◆/, "a line without problems has none");
});

// ---------- medium batch: hover ----------
const O = require("../overlays.cjs");
const { hoverText } = require("../lang/lsp.cjs");

test("hover Markdown becomes plain lines: code blocks kept, marks and links dropped, wrapped at the width", () => {
  const md = "```typescript\nfunction greet(name: string): string\n```\n\nSays **hi** to `name`, see {@link Foo the foo} and [docs](http://x).\n\n\n\n*@param* — name\n\n---\nlast";
  assert.deepEqual(O.markdownLines(md, 20), [
    { text: "function greet(name:", code: true }, { text: " string): string", code: true }, { text: "" },
    { text: "Says hi to name, see" }, { text: "the foo and docs." }, { text: "" }, { text: "@param — name" }, { text: "" },
    { text: "─".repeat(20), rule: true }, { text: "last" }]);
  assert.equal(hoverText({ kind: "markdown", value: "**x**" }), "**x**");
  assert.equal(hoverText([{ language: "rust", value: "fn f()" }, "docs"]), "```rust\nfn f()\n```\n\ndocs");
  assert.equal(hoverText(null), "");
});

test("Show Hover (⌘K ⌘I) shows the problem, then the type and docs, above the word; the next key closes it, Esc only that", async () => {
  const p = problem(0, 8, 0, 9, 1, "Cannot find name 'b'.");
  const ed = await withProblems(["", "", "", "let a = 1;", "let c = b;"], [{ ...p, start: { line: 4, col: 8 }, end: { line: 4, col: 9 } }]);
  ed.session = stubSession({ hover: async (ctx) => ({ contents: `\`\`\`ts\nlet ${ctx.word}: number\n\`\`\`\nThe docs.` }) }, ["hover"], ed.problems());
  ed.moveTo({ line: 4, col: 8 });
  press(ed, "k", { cmd: true }); await press(ed, "i", { cmd: true });
  const screen = ed.render(0).out.replace(/\x1b\[[\d;:]*m/g, "");
  assert.match(screen, /Cannot find name 'b'\. {2}ts\(1\)[^]*let b: number[^]*The docs\./);
  assert.ok(ed.hoverBox.box(ed).y < 6, "above the cursor line");
  press(ed, "escape");
  assert.equal(ed.hoverBox, null);
  assert.deepEqual(ed.head, { line: 4, col: 8 });
  await ed.runCommand("editor.action.showHover");
  press(ed, "right");
  assert.equal(ed.hoverBox, null);
  assert.equal(ed.head.col, 9, "the key still does its work");
  ed.session = stubSession({ hover: async () => null }, ["hover"]);
  ed.moveTo({ line: 3, col: 4 });
  await ed.runCommand("editor.action.showHover");
  assert.equal(ed.hoverBox, null);
  assert.equal(ed.message.text, "No hover information");
});

test("the mouse resting 300 ms on a word shows its hover (editor.hover.enabled), leaving the word closes it", async () => {
  const ed = await plainEditor(["alpha beta", ""]);
  ed.rows = 12; ed.cols = 80;
  ed.session = stubSession({ hover: async (ctx) => ({ contents: `about ${ctx.word}` }) }, ["hover"]);
  ed.render(0);
  const at = (x, y) => ed.hover({ type: "mouse", motion: true, button: 3, x, y });
  at(ed.gutter + 8, 2); // over "beta"
  await new Promise(r => setTimeout(r, 360));
  assert.equal(ed.hoverBox?.markdown, "about beta");
  assert.equal(ed.hoverBox.source, "mouse");
  at(ed.gutter + 9, 2); // still on beta: stays
  assert.ok(ed.hoverBox);
  at(ed.gutter + 30, 2); // past the line's end
  assert.equal(ed.hoverBox, null);
  ed.settings = { ...ed.settings, "editor.hover.enabled": false };
  at(ed.gutter + 2, 2);
  await new Promise(r => setTimeout(r, 360));
  assert.equal(ed.hoverBox, null, "off: no mouse hover");
  assert.equal(S.normalize({})["editor.hover.enabled"], true);
  assert.equal(S.normalize({ "editor.hover.enabled": 0 })["editor.hover.enabled"], true);
  assert.equal(K.resolve([], "linux").byChord.get("ctrl+k ctrl+i"), "editor.action.showHover");
});

// ---------- medium batch: Go to Symbol in Workspace ----------
test("Go to Symbol in Workspace (⌘T) asks the language server for what is typed and opens the chosen symbol", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-ws-")), other = path.join(dir, "b.txt");
  fs.writeFileSync(other, "one\n  greet here\n");
  const ed = await plainEditor(["x"], path.join(dir, "a.txt"));
  const queries = [];
  ed.session = stubSession({ workspaceSymbols: async (ctx, q) => { queries.push(q); return [{ name: "greet", kind: "function", container: "Shop", file: other, line: 1, col: 2 }]; } }, ["workspaceSymbols"]);
  press(ed, "t", { cmd: true });
  assert.equal(ed.popup.text, "#");
  ed.handle({ type: "text", text: "gre" });
  assert.equal(ed.popup.items[0].label, "Searching symbols…");
  await tick();
  assert.deepEqual(queries.at(-1), "gre");
  assert.deepEqual(ed.popup.items.map(i => [i.label, i.detail, i.key]), [["greet", "Shop · b.txt", "function"]]);
  press(ed, "enter");
  await tick(); await tick();
  assert.equal(ed.file, other);
  assert.deepEqual(ed.head, { line: 1, col: 2 });
  const plain = await plainEditor(["x"]);
  plain.session = stubSession({});
  press(plain, "t", { cmd: true });
  assert.equal(plain.popup, null);
  assert.match(plain.message.text, /No go to symbol in workspace support for Plain Text/);
  assert.equal(K.resolve([], "linux").byChord.get("ctrl+t"), "workbench.action.showAllSymbols");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a language server child never keeps the process alive, so a script that touched one exits and the server goes too", () => {
  const rpc = path.join(__dirname, "..", "lang", "rpc.cjs");
  const script = `const { Child } = require(${JSON.stringify(rpc)}); const c = new Child(process.execPath, ["-e", "process.stdin.resume()"], process.cwd(), () => {});
    console.log(c.proc.pid);`;
  const r = require("child_process").spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, "the script did not exit by itself");
  const pid = Number(r.stdout.trim());
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) require("child_process").spawnSync("sleep", ["0.1"]);
  assert.equal(alive(), false, "the server outlived the script");
});
