// node --test mods/vscode-memo/test/memo.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMO, MIN, MEMO_SETTINGS, GRIP, CORNER, FOOT, DEFAULT_POS, buttonRect, buttonPos, panelLayout, closesOnPress, memoTarget, clampRect, dragRect, panelRect, gitignoreAddition, dragStarted, memoSettings,
  joinPath, REMOTE_PREPARE, NOT_INSTALLED, WINDOWS, MEMO_SETTINGS_FILE, preparedDir, windowsPrepare, psQuote, encodeCommand, remoteEditorArgv, keysOs, appendCommand } from "../memo.js";

const panes = [
  { pane: "p1", tab: "t1", terminal: null, mod: "vscode-viewer", cwd: null },
  { pane: "p2", tab: "t1", terminal: "a", cwd: "/w/app" },
];

test("a space's memo is under its folder, else its first terminal's", () => {
  assert.deepEqual(memoTarget({ id: "s1", folder: "/w/docs/", machine: null, tabs: [{ id: "t1" }] }, panes),
    { folder: "/w/docs", on: null, path: `/w/docs/${MEMO}` });
  assert.deepEqual(memoTarget({ id: "s2", folder: "", machine: null, tabs: [{ id: "t1" }] }, panes),
    { folder: "/w/app", on: null, path: "/w/app/.herdr/memo.md" });
  assert.deepEqual(memoTarget({ id: "box/s3", folder: "/srv", machine: "box", tabs: [] }, panes),
    { folder: "/srv", on: "box", path: "/srv/.herdr/memo.md" });
  assert.equal(memoTarget({ id: "s4", folder: "", machine: null, tabs: [] }, panes), null);
  assert.equal(memoTarget(undefined, panes), null);
});

test("rects stay inside the window", () => {
  const win = { width: 1000, height: 700 };
  assert.deepEqual(clampRect({ x: 980, y: -5, width: 40, height: 40 }, win), { x: 960, y: 0, width: 40, height: 40 });
  assert.deepEqual(clampRect({ x: 10, y: 10, width: 1200, height: 300 }, win), { x: 0, y: 10, width: 1000, height: 300 });
  // Unknown window size: only kept off the top and left edges.
  assert.deepEqual(clampRect({ x: -3, y: 2000, width: 40, height: 40 }, null), { x: 0, y: 2000, width: 40, height: 40 });
});

test("dragging moves, and an edge or corner resizes with the opposite side fixed", () => {
  const r = { x: 100, y: 100, width: 400, height: 300 };
  assert.deepEqual(dragRect(r, "move", 10, -20, MIN), { x: 110, y: 80, width: 400, height: 300 });
  assert.deepEqual(dragRect(r, "e", 50, 99, MIN), { x: 100, y: 100, width: 450, height: 300 });
  assert.deepEqual(dragRect(r, "se", 20, 30, MIN), { x: 100, y: 100, width: 420, height: 330 });
  assert.deepEqual(dragRect(r, "nw", -10, 20, MIN), { x: 90, y: 120, width: 410, height: 280 });
  // Never under the smallest size; the right / bottom edge stays where it was.
  assert.deepEqual(dragRect(r, "w", 300, 0, MIN), { x: 240, y: 100, width: 260, height: 300 });
  assert.deepEqual(dragRect(r, "n", 0, 500, MIN), { x: 100, y: 240, width: 400, height: 160 });
  assert.ok(!dragStarted({ x: 0, y: 0 }, { x: 3, y: 2 }));
  assert.ok(dragStarted({ x: 0, y: 0 }, { x: 4, y: 3 }));
});

test("the button starts bottom right, above the status bar, and keeps its corner as the window resizes", () => {
  const win = { width: 1200, height: 800 };
  assert.deepEqual(buttonRect(null, win), { x: 1144, y: 716, width: 40, height: 40 });
  assert.deepEqual(buttonPos(buttonRect(null, win), win), DEFAULT_POS);
  // Dragged to (300, 100): kept as offsets, so a wider, shorter window keeps it as far from the bottom-right corner.
  const pos = buttonPos({ x: 300, y: 100, width: 40, height: 40 }, win);
  assert.deepEqual(pos, { right: 860, bottom: 660 });
  assert.deepEqual(buttonRect(pos, { width: 1400, height: 760 }), { x: 500, y: 60, width: 40, height: 40 });
  // A window too small for that offset: kept inside it.
  assert.deepEqual(buttonRect(pos, { width: 600, height: 400 }), { x: 0, y: 0, width: 40, height: 40 });
  // A spot saved by the first version ({ x, y }) is used as is.
  assert.deepEqual(buttonRect({ x: 216, y: 3 }, win), { x: 216, y: 3, width: 40, height: 40 });
});

test("a press outside closes the unpinned panel; inside, on the button or pinned it doesn't", () => {
  const panel = { x: 100, y: 100, width: 400, height: 300 }, button = { x: 900, y: 700, width: 40, height: 40 };
  const at = (x, y, pinned = false) => closesOnPress({ x, y }, { panel, button, pinned });
  assert.ok(at(50, 50));
  assert.ok(at(500, 250)); // just past the right edge
  assert.ok(!at(100, 100)); // the border's corner: resizing
  assert.ok(!at(300, 110)); // the title bar: moving
  assert.ok(!at(300, 300)); // the editor
  assert.ok(!at(910, 710)); // the button toggles it itself
  assert.ok(!at(50, 50, true)); // pinned
  assert.ok(!closesOnPress({ x: 50, y: 50 }, { panel: null, button, pinned: false })); // no panel
});

test("the panel opens where it was left, else above the button and to its left, else in the middle", () => {
  const win = { width: 1200, height: 800 }, button = { x: 1150, y: 730, width: 34, height: 34 };
  assert.deepEqual(panelRect(null, button, win), { x: 744, y: 382, width: 440, height: 340 });
  assert.deepEqual(panelRect({ x: 1000, y: 700, width: 300, height: 200 }, button, win), { x: 900, y: 600, width: 300, height: 200 });
  // A button near the top left: the panel stays in the window.
  assert.deepEqual(panelRect(null, { x: 0, y: 0, width: 40, height: 40 }, win), { x: 0, y: 0, width: 440, height: 340 });
  // Opened by the toggle command before the button was ever pointed at.
  assert.deepEqual(panelRect(null, null, win), { x: 380, y: 230, width: 440, height: 340 });
});

test("the panel's corners resize from CORNER px along both sides; its edges are GRIP px", () => {
  const body = { type: "block", content: { terminal: "t1" } };
  const [left, middle, right] = panelLayout("vscode-memo", body).children;
  // A grip block as [edge, px] (null: it takes the rest).
  const strip = (n) => n.children.map(c => [c.content.props.edge, c.size?.px ?? null]);
  // The sides: GRIP px wide, a corner CORNER px tall at each end.
  assert.equal(left.size.px, GRIP); assert.equal(right.size.px, GRIP);
  assert.deepEqual(strip(left), [["nw", CORNER], ["w", null], ["sw", CORNER]]);
  assert.deepEqual(strip(right), [["ne", CORNER], ["e", null], ["se", CORNER]]);
  // The top (GRIP px) and bottom (FOOT px) strips: the corners go on CORNER px from the outside edge.
  const [top, title, editor, bottom] = middle.children;
  assert.equal(top.size.px, GRIP); assert.equal(bottom.size.px, FOOT);
  assert.deepEqual(strip(top), [["nw", CORNER - GRIP], ["n", null], ["ne", CORNER - GRIP]]);
  assert.deepEqual(strip(bottom), [["sw", CORNER - GRIP], ["s", null], ["se", CORNER - GRIP]]);
  assert.ok(CORNER >= 14 && CORNER <= 16 && GRIP <= 6);
  // Then the title bar (it fills the top corners' inside with its own grips) and the editor.
  assert.equal(title.content.props.role, "title");
  assert.equal(editor, body);
});

test(".gitignore gets the memo once, keeping its newline", () => {
  assert.equal(gitignoreAddition("node_modules\n", false), ".herdr/memo.md\n");
  assert.equal(gitignoreAddition("node_modules", false), "\n.herdr/memo.md\n");
  assert.equal(gitignoreAddition("", null), ".herdr/memo.md\n");
  assert.equal(gitignoreAddition("dist\n", true), null);
  // No git to ask: a line that ignores it is enough.
  assert.equal(gitignoreAddition("dist\r\n/.herdr/\r\n", null), null);
  assert.equal(gitignoreAddition("  .herdr/memo.md  \n", null), null);
  assert.equal(gitignoreAddition("# .herdr/memo.md\n", null), ".herdr/memo.md\n");
  // Git says it isn't ignored (a later "!" line, say): append even though a line matches.
  assert.equal(gitignoreAddition(".herdr/\n!.herdr/memo.md\n", false), ".herdr/memo.md\n");
});

test("the memo editor keeps the user's settings, cut down to a document editor", () => {
  const s = JSON.parse(memoSettings('{\n  // engine\n  "editor.engine": "rust", "editor.tabSize": 2,\n  "editor.wordWrap": "off",\n}\n'));
  assert.equal(s["editor.engine"], "rust");
  assert.equal(s["editor.tabSize"], 2);
  assert.equal(s["editor.wordWrap"], "on");
  assert.equal(s["files.autoSave"], "afterDelay");
  assert.equal(s["editor.inlineSuggest.provider"], "off");
  assert.equal(s["workbench.statusBar.visible"], false);
  assert.deepEqual(JSON.parse(memoSettings(null)), MEMO_SETTINGS);
  assert.deepEqual(JSON.parse(memoSettings("not json")), MEMO_SETTINGS);
});

test("a Windows space's memo uses backslashes; a Unix space's slashes", () => {
  assert.deepEqual(memoTarget({ id: "win/s1", folder: "C:\\project\\refine-mods\\", machine: "win-amd64", tabs: [] }, panes),
    { folder: "C:\\project\\refine-mods", on: "win-amd64", path: "C:\\project\\refine-mods\\.herdr\\memo.md" });
  assert.equal(memoTarget({ id: "w/s2", folder: "C:/w", machine: "w", tabs: [] }, panes).path, "C:/w\\.herdr\\memo.md");
  assert.equal(joinPath("\\\\nas\\share", ".gitignore"), "\\\\nas\\share\\.gitignore");
  assert.equal(joinPath("/srv/app", ".gitignore"), "/srv/app/.gitignore");
  // A Unix folder keeps a backslash that is part of its name.
  assert.equal(memoTarget({ id: "s5", folder: "/w/a\\", machine: null, tabs: [] }, panes).path, "/w/a\\/.herdr/memo.md");
});

// REMOTE_PREPARE run here as on a Linux machine, with $HOME a temp folder.
const prepare = (home, path, settings = "{}") => spawnSync("sh", ["-c", REMOTE_PREPARE, "sh", path, settings],
  { env: { ...process.env, HOME: home }, encoding: "utf8" });

test("on a Unix machine without the editor, the memo is made and the install is asked for", () => {
  const home = mkdtempSync(join(tmpdir(), "memo-")), path = join(home, "app", ".herdr", "memo.md");
  try {
    const r = prepare(home, path);
    assert.equal(r.status, NOT_INSTALLED);
    assert.equal(readFileSync(path, "utf8"), "");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("on a Unix machine with the editor, the newest complete version is used and the memo's settings written beside it", () => {
  const home = mkdtempSync(join(tmpdir(), "memo-")), root = join(home, ".local/share/herdr-vscode");
  const path = join(home, "app", ".herdr", "memo.md");
  try {
    mkdirSync(join(root, "1.0.0-aaaaaaaaaaaa"), { recursive: true });
    writeFileSync(join(root, "1.0.0-aaaaaaaaaaaa", "manifest.json"), "{}");
    mkdirSync(join(root, "1.0.1-bbbbbbbbbbbb")); // still installing: no manifest
    mkdirSync(join(root, ".install.x"));
    writeFileSync(join(root, "vscode-settings.json"), "user");
    mkdirSync(join(home, "app", ".herdr"), { recursive: true });
    writeFileSync(path, "kept");
    const r = prepare(home, path, '{"editor.wordWrap": "on"}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(preparedDir(r.stdout), join(root, "1.0.0-aaaaaaaaaaaa"));
    assert.equal(readFileSync(path, "utf8"), "kept");
    assert.equal(readFileSync(join(root, MEMO_SETTINGS_FILE), "utf8"), '{"editor.wordWrap": "on"}');
    assert.equal(readFileSync(join(root, "vscode-settings.json"), "utf8"), "user"); // the other editors' settings
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a Windows machine's sh (Git Bash) hands over to PowerShell before writing anything", () => {
  const home = mkdtempSync(join(tmpdir(), "memo-")), path = join(home, "app", ".herdr", "memo.md");
  try {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "uname"), "#!/bin/sh\necho MINGW64_NT-10.0-26300\n", { mode: 0o755 });
    const r = spawnSync("sh", ["-c", REMOTE_PREPARE, "sh", path, "{}"],
      { env: { ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(r.status, WINDOWS);
    assert.equal(existsSync(join(home, "app")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the version folder is the last line printed, CRLF or not", () => {
  assert.equal(preparedDir("C:\\L\\herdr-vscode\\1.0.0-8b1da81ce8af\r\n"), "C:\\L\\herdr-vscode\\1.0.0-8b1da81ce8af");
  assert.equal(preparedDir(""), null);
});

const decode = (b64) => Buffer.from(b64, "base64").toString("utf16le");

test("on Windows the memo is prepared through PowerShell with its values quoted, never spliced", () => {
  const [program, args] = windowsPrepare("C:\\p\\it's\\.herdr\\memo.md", '{"a": "b\'c"}');
  assert.equal(program, "powershell");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = decode(args[3]);
  assert.ok(script.includes("$memo = 'C:\\p\\it''s\\.herdr\\memo.md'"));
  assert.ok(script.includes(`$settings = '{"a": "b''c"}'`));
  assert.ok(script.includes(MEMO_SETTINGS_FILE));
  assert.ok(script.includes(`exit ${NOT_INSTALLED}`));
  // Too long for a command line: the memo's own settings only.
  assert.ok(decode(windowsPrepare("C:\\p\\memo.md", "x".repeat(20000))[1][3]).includes(psQuote(memoSettings(null))));
  assert.throws(() => windowsPrepare("/not/windows", "{}"));
  assert.throws(() => windowsPrepare("C:\\a\nb", "{}"));
});

test("PowerShell's -EncodedCommand is UTF-16LE base64", () => {
  for (const s of ["", "a", "ab", "abc", "한글 'x'"]) assert.equal(encodeCommand(s), Buffer.from(s, "utf16le").toString("base64"));
});

test("the remote memo editor starts from the installed bundle with the memo's settings, not the launcher's", () => {
  const root = "/root/.local/share/herdr-vscode", dir = `${root}/1.0.0-aaaaaaaaaaaa`;
  assert.deepEqual(remoteEditorArgv("unix", dir, "/srv/.herdr/memo.md", "mac"), [
    "/usr/bin/env", `HERDR_APP_HOME=${root}`, `VSEDIT_SETTINGS=${root}/${MEMO_SETTINGS_FILE}`,
    `VSEDIT_KEYBINDINGS=${root}/vscode-keybindings.json`, `VSEDIT_BACKUPS=${root}/backups`, "VSEDIT_OS=mac",
    `${dir}/vsedit`, "--vscode", `${dir}/vscode`, "/srv/.herdr/memo.md"]);
  const argv = remoteEditorArgv("windows", "C:\\L\\herdr-vscode\\1.0.0-8b1da81ce8af", "C:\\project\\.herdr\\memo.md", "mac");
  assert.deepEqual(argv.slice(0, 5), ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  const script = decode(argv[5]);
  assert.ok(script.includes("$dir = 'C:\\L\\herdr-vscode\\1.0.0-8b1da81ce8af'"));
  assert.ok(script.includes("$env:VSEDIT_SETTINGS = Join-Path $root 'vscode-memo-settings.json'"));
  assert.ok(script.includes("$env:VSEDIT_OS = 'mac'"));
  assert.ok(script.includes("& (Join-Path $dir 'vsedit.exe') --vscode (Join-Path $dir 'vscode') 'C:\\project\\.herdr\\memo.md'"));
  assert.equal(keysOs("macos"), "mac");
  assert.equal(keysOs("windows"), "win");
  assert.equal(keysOs("linux"), "linux");
});

test("a remote .gitignore is appended to with the machine's own shell", () => {
  assert.deepEqual(appendCommand("unix", "/srv/.gitignore", "x\n"), ["sh", ["-c", 'printf %s "$2" >> "$1"', "sh", "/srv/.gitignore", "x\n"]]);
  assert.equal(appendCommand(null, "/srv/.gitignore", "x\n")[0], "sh");
  const [program, args] = appendCommand("windows", "C:\\p\\.gitignore", ".herdr/memo.md\n");
  assert.equal(program, "powershell");
  assert.equal(decode(args.at(-1)), "[IO.File]::AppendAllText('C:\\p\\.gitignore', '.herdr/memo.md\n')");
});
