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

test("⌘ chords and their Ctrl fallbacks run the same commands", () => {
  const id = (chord) => Cmd.KEYMAP.get(chord)?.id;
  assert.equal(id("cmd+s"), "workbench.action.files.save");
  assert.equal(id("ctrl+s"), "workbench.action.files.save");
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

// A herdr-app stub on PATH that records its arguments; runs `code` in a child node with `args` and env.
function withHerdrStub(code, args, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-herdr-")), log = path.join(dir, "log");
  fs.writeFileSync(path.join(dir, "herdr-app"), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  const r = require("child_process").spawnSync(process.execPath, ["-e", code, "--", ...args],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env }, cwd: path.join(__dirname, "..") });
  return { status: r.status, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}
const EXIT = `require("./terminal.cjs").exit(0)`;

test("leaving a program the Explorer opened in Herdr kills its terminal, so the tab closes", () => {
  const r = withHerdrStub(EXIT, ["a.txt", "--close-on-exit"], { HC_TERMINAL_ID: "term-3" });
  assert.equal(r.status, 0);
  assert.equal(r.calls, "do terminal.kill --terminal term-3\n");
});

test("started by hand, or outside Herdr, leaving keeps the terminal", () => {
  assert.equal(withHerdrStub(EXIT, ["a.txt"], { HC_TERMINAL_ID: "term-3" }).calls, "");
  assert.equal(withHerdrStub(EXIT, ["a.txt", "--close-on-exit"], { HC_TERMINAL_ID: "" }).calls, "");
});

test("the error page names fs errors in words and maps Esc/⌘W/Ctrl+Q to Close, Enter to Try Again", () => {
  const E = require("../errorpage.cjs");
  assert.equal(E.reasonOf(Object.assign(new Error("x"), { code: "ENOENT" })), "File not found");
  assert.equal(E.reasonOf(Object.assign(new Error("x"), { code: "EACCES" })), "Permission denied");
  assert.equal(E.reasonOf(new Error("first line\nsecond")), "first line");
  const picked = [], page = new E.ErrorPage("/p/a.txt", "File not found", ["a.txt"], (c) => picked.push(c));
  const key = (name, m = {}) => ({ type: "key", name, ctrl: false, shift: false, alt: false, cmd: false, ...m });
  page.handle(key("enter"));
  page.handle(key("escape"));
  page.handle(key("w", { cmd: true }));
  page.handle(key("q", { ctrl: true }));
  page.handle(key("left")); page.handle(key("enter")); // focus wraps to Close
  assert.deepEqual(picked, ["retry", "close", "close", "close", "close"]);
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
