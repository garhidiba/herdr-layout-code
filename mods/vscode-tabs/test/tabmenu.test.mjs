// node --test mods/vscode-tabs/test/tabmenu.test.mjs
// The editor tab menu: which tabs get it (tabfile.js), and its items and actions (vscode-explorer's paths.js).
import test from "node:test";
import assert from "node:assert/strict";
import { tabFileOf, editorTitleState, dirtyTabs, TAB_MENU, withDetails, DETAILS } from "../tabfile.js";
import { tabMenuItems, closeArgs, fileTabs, splitArgs, clipboardCommand, revealCommand, menuHeight, DETAILS as EXPLORER_DETAILS } from "../../vscode-explorer/paths.js";

const launcher = "/Users/me/.config/herdr-app/mods/vscode-viewer/editor/vsedit.sh";
const space = { id: "s1", machine: null, folder: "/p", tabs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] };
const panes = [
  { pane: "p1", tab: "a", terminal: "t1", cwd: "/p" },
  { pane: "p2", tab: "b", terminal: "t2", cwd: "/p" },
  { pane: "p3", tab: "c", terminal: null, mod: "vscode-viewer", cwd: null },
  { pane: "p4", tab: "d", terminal: "t4", cwd: "/p/sub" },
];
const terminals = [
  { address: "t1", argv: ["/bin/zsh", "-l"] },
  { address: "t2", argv: ["/bin/sh", "-c", "find", "sh", launcher, "/p/src/a.ts", "--close-on-exit"] },
  { address: "t4", argv: ["claude"] },
];
const tabs = space.tabs;
const labels = (rows) => rows.filter(r => r !== "-").map(r => r[0]);

test("an editor tab's menu knows its file, its launcher arguments and the folder it was opened in", () => {
  assert.deepEqual(tabFileOf("b", space, panes, terminals, null),
    { tab: "b", file: "/p/src/a.ts", on: null, pane: "p2", argv: [launcher, "/p/src/a.ts", "--close-on-exit"], root: "/p" });
});

test("a viewer tab is a file tab while its viewer is the one that shared its file", () => {
  const viewer = { pane: "p3", file: "/p/logo.png", on: null };
  assert.deepEqual(tabFileOf("c", space, panes, terminals, viewer), { tab: "c", file: "/p/logo.png", on: null, pane: "p3", argv: null, root: "/p" });
  assert.equal(tabFileOf("c", space, panes, terminals, { ...viewer, pane: "elsewhere" }), null);
  assert.equal(tabFileOf("c", space, panes, terminals, null), null);
});

test("shells and agents keep Herdr's menu", () => {
  assert.equal(tabFileOf("a", space, panes, terminals, null), null);
  assert.equal(tabFileOf("d", space, panes, terminals, null), null);
  assert.equal(tabFileOf("gone", space, panes, terminals, null), null);
});

test("a remote space's editor tab is on that machine", () => {
  const remote = { ...space, machine: "box", folder: "/srv" };
  const rp = [{ pane: "box/p9", tab: "a", terminal: "box/t9", cwd: "/srv" }];
  const rt = [{ address: "box/t9", argv: ["sh", "/home/me/.local/share/herdr-vscode/1/vsedit.sh", "/srv/x.go", "--close-on-exit", "--os", "mac"] }];
  const f = tabFileOf("a", remote, rp, rt, null);
  assert.equal(f.on, "box");
  assert.deepEqual(splitArgs(f), { direction: "right", pane: "box/p9", argv: ["exec", "sh", "/home/me/.local/share/herdr-vscode/1/vsedit.sh", "/srv/x.go", "--close-on-exit", "--os", "mac"] });
});

test("a remote editor whose terminals() row has no argv is a file tab with the explorer's details (hc get)", () => {
  const remote = { ...space, machine: "box", folder: "/srv" };
  const rp = [{ pane: "box/p9", tab: "a", terminal: "box/t9", cwd: "/srv", title: "x.go — vsedit" }];
  const rt = [{ address: "box/t9", agent: "sh", cwd: "/srv", state: "live" }];
  assert.equal(tabFileOf("a", remote, rp, rt, null), null, "the row alone");
  const argv = ["sh", "-c", "…", "sh", "exec", "sh", "/home/me/.local/share/herdr-vscode/1/vsedit.sh", "/srv/x.go", "--close-on-exit"];
  const f = tabFileOf("a", remote, rp, withDetails(rt, { "box/t9": { argv, labels: {} } }), null);
  assert.equal(f.file, "/srv/x.go");
  assert.equal(DETAILS, EXPLORER_DETAILS, "the explorer's shared key");
});

test("the menu is VS Code's tab menu, the items Herdr can do, with the OS's keys", () => {
  assert.deepEqual(labels(tabMenuItems({ remote: false, os: "mac" })), ["Close", "Close Others", "Close to the Right", "Close Saved", "Close All", "Copy Path",
    "Copy Relative Path", "Reopen Editor With…", "Reveal in Finder", "Reveal in Explorer View", "Split Right", "Move into Tab…", "Move to New Tab"]);
  const hint = (os, action) => tabMenuItems({ remote: false, os }).find(r => r[1] === action)[2] ?? "";
  assert.deepEqual(["mac", "win", "linux"].map(os => hint(os, "close")), ["⌘W", "Ctrl+F4", "Ctrl+W"]);
  assert.deepEqual(["mac", "win", "linux"].map(os => hint(os, "closeOthers")), ["⌥⌘T", "", ""]);
  assert.deepEqual(["mac", "win", "linux"].map(os => hint(os, "closeSaved")), ["⌘K U", "Ctrl+K U", "Ctrl+K U"]);
  assert.deepEqual(["mac", "win", "linux"].map(os => hint(os, "copyRelative")), ["⌥⇧⌘C", "Ctrl+K Ctrl+Shift+C", "Ctrl+Shift+Alt+C"]);
  assert.deepEqual(["mac", "win", "linux"].map(os => tabMenuItems({ remote: false, os }).find(r => r[1] === "reveal")[0]),
    ["Reveal in Finder", "Reveal in File Explorer", "Open Containing Folder"]);
});

test("a remote file's Reveal in Finder is disabled, every other item stays", () => {
  const rows = tabMenuItems({ remote: true, os: "mac" });
  assert.deepEqual(rows.filter(r => r !== "-" && r[3]).map(r => r[1]), ["reveal"]);
  assert.ok(tabMenuItems({ remote: false, os: "mac" }).every(r => r === "-" || !r[3]));
  assert.equal(labels(rows).length, 13);
});

test("the tab bar opens the popup at the menu's own height on every OS", () => {
  for (const os of ["mac", "win", "linux"]) for (const remote of [false, true]) for (const flag of [{}, { lone: true, alone: true }, { viewer: true }]) {
    assert.equal(menuHeight(tabMenuItems({ remote, os, ...flag })), TAB_MENU.height, `${os} remote=${remote} ${JSON.stringify(flag)}`);
  }
});

test("the moves are disabled when there is nowhere to go, and for a viewer", () => {
  const off = (flags) => tabMenuItems({ remote: false, os: "mac", ...flags }).filter(r => r !== "-" && r[3]).map(r => r[1]);
  assert.deepEqual(off({}), []);
  assert.deepEqual(off({ lone: true }), ["moveInto"]);
  assert.deepEqual(off({ alone: true }), ["moveOut"]);
  assert.deepEqual(off({ viewer: true }), ["moveInto", "moveOut"]);
});

test("a tab holding several panes: its focused editor gets the menu, and it is a file tab only with no shell in it", () => {
  const shared = [...panes, { pane: "p5", tab: "b", terminal: "t5", cwd: "/p", focused: true }, { pane: "p6", tab: "a", terminal: "t6", cwd: "/p" }];
  const rows = [...terminals, { address: "t5", argv: ["sh", launcher, "/p/b.ts", "--close-on-exit"] }, { address: "t6", argv: ["sh", launcher, "/p/c.ts", "--close-on-exit"] }];
  assert.equal(tabFileOf("b", space, shared, rows, null).file, "/p/b.ts", "the focused one");
  assert.equal(tabFileOf("a", space, shared, rows, null).file, "/p/c.ts", "a shell's tab with an editor moved in");
  assert.deepEqual([...fileTabs(space, shared, rows)].sort(), ["b", "c"], "two editors: a file tab; shell + editor: not one");
  assert.deepEqual([...dirtyTabs(space, [{ pane: "p6", tab: "a", terminal: "t6", title: "● c.ts — vsedit" }])], ["a"]);
});

test("a warm editor (handed its file later) is a file tab once its label names the file, not while it waits", () => {
  const warm = { address: "t2", argv: ["/bin/sh", "-c", "find", "sh", launcher, "--warm", "/h/.vscode-warm/b", "--close-on-exit"], labels: { "vscode.warm": "1" } };
  const others = terminals.filter(t => t.address !== "t2");
  assert.equal(tabFileOf("b", space, panes, [...others, warm], null), null);
  assert.deepEqual([...fileTabs(space, panes, [...others, warm])].sort(), ["c"]);
  const handed = { ...warm, labels: { "vscode.file": "/p/b.ts" } };
  assert.deepEqual(tabFileOf("b", space, panes, [...others, handed], null),
    { tab: "b", file: "/p/b.ts", on: null, pane: "p2", argv: [launcher, "/p/b.ts", "--close-on-exit"], root: "/p" });
  assert.deepEqual([...fileTabs(space, panes, [...others, handed])].sort(), ["b", "c"]);
});

test("file tabs are the editor and viewer tabs; a shell or an agent never is one", () => {
  assert.deepEqual([...fileTabs(space, panes, terminals)].sort(), ["b", "c"]);
  assert.deepEqual([...fileTabs(null, panes, terminals)], []);
});

// a shell, b editor, c viewer, d agent, e editor
const mixed = [...tabs, { id: "e" }];
const files = new Set(["b", "c", "e"]);

test("Close Others, Close to the Right and Close All close file tabs only, in tab bar order", () => {
  assert.deepEqual(closeArgs("close", mixed, "b", files), [{ id: "b" }]);
  assert.deepEqual(closeArgs("closeOthers", mixed, "b", files), [{ id: "c" }, { id: "e" }]);
  assert.deepEqual(closeArgs("closeRight", mixed, "b", files), [{ id: "c" }, { id: "e" }]);
  assert.deepEqual(closeArgs("closeRight", mixed, "e", files), []);
  assert.deepEqual(closeArgs("closeAll", mixed, "c", files), [{ id: "b" }, { id: "c" }, { id: "e" }]);
});

test("a shell or a running agent left in the space means nothing is confirmed", () => {
  for (const action of ["closeOthers", "closeRight", "closeAll"]) {
    assert.ok(closeArgs(action, mixed, "b", files).every(a => !a.confirmed && !["a", "d"].includes(a.id)), action);
  }
});

test("only when no tab is left in the space is the last close confirmed, so the space stays as a gray row", () => {
  const two = [{ id: "x" }, { id: "y" }], both = new Set(["x", "y"]);
  assert.deepEqual(closeArgs("closeAll", two, "x", both), [{ id: "x" }, { id: "y", confirmed: true }]);
  assert.deepEqual(closeArgs("closeOthers", two, "x", both), [{ id: "y" }]);
  assert.deepEqual(closeArgs("close", [{ id: "x" }], "x", new Set(["x"])), [{ id: "x", confirmed: true }]);
  assert.deepEqual(closeArgs("closeOthers", [{ id: "x" }], "x", new Set(["x"])), []);
});

test("Close Saved closes the file tabs without unsaved changes, the clicked one too, and leaves shells and agents", () => {
  assert.deepEqual(closeArgs("closeSaved", mixed, "c", files, new Set(["b"])), [{ id: "c" }, { id: "e" }]);
  assert.deepEqual(closeArgs("closeSaved", mixed, "b", files, new Set(["b", "e"])), [{ id: "c" }]);
  assert.deepEqual(closeArgs("closeSaved", mixed, "b", files), [{ id: "b" }, { id: "c" }, { id: "e" }]);
  const two = [{ id: "x" }, { id: "y" }], both = new Set(["x", "y"]);
  assert.deepEqual(closeArgs("closeSaved", two, "x", both, new Set()), [{ id: "x" }, { id: "y", confirmed: true }]);
});

test("a tab that is gone or an unknown item closes nothing", () => {
  assert.deepEqual(closeArgs("closeAll", mixed, "gone", files), []);
  assert.deepEqual(closeArgs("closeSaved", mixed, "gone", files), []);
  assert.deepEqual(closeArgs("pin", mixed, "b", files), []);
});

test("Split Right opens the same file beside it: the editor again, or a viewer pane", () => {
  assert.deepEqual(splitArgs(tabFileOf("b", space, panes, terminals, null)),
    { direction: "right", pane: "p2", argv: ["exec", "sh", launcher, "/p/src/a.ts", "--close-on-exit"] });
  assert.deepEqual(splitArgs({ pane: "p3", argv: null, file: "/p/logo.png", on: null }),
    { direction: "right", pane: "p3", mod: "vscode-viewer", props: { file: "/p/logo.png", on: null } });
});

test("copy and reveal use the computer's own clipboard and file manager", () => {
  assert.deepEqual(clipboardCommand("mac", "/p/a b.ts"), ["sh", ["-c", 'printf %s "$1" | { pbcopy; }', "copy", "/p/a b.ts"]]);
  assert.match(clipboardCommand("linux", "/p/a.ts")[1][1], /wl-copy.*xclip -selection clipboard/);
  assert.deepEqual(clipboardCommand("win", "C:\\it's.ts"), ["powershell", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value 'C:\\it''s.ts'"]]);
  assert.deepEqual(revealCommand("mac", "/p/a.ts"), ["open", ["-R", "/p/a.ts"]]);
  assert.deepEqual(revealCommand("win", "C:\\p\\a.ts"), ["explorer.exe", ["/select,C:\\p\\a.ts"]]);
  assert.deepEqual(revealCommand("linux", "/p/src/a.ts"), ["xdg-open", ["/p/src"]]);
});

test("an editor's title says whether it has unsaved changes; any other program's says nothing", () => {
  assert.equal(editorTitleState("a.ts — vsedit"), "clean");
  assert.equal(editorTitleState("● a.ts — vsedit"), "dirty");
  assert.equal(editorTitleState("● a.ts — vsedit (closing)"), "closing");
  for (const other of ["● a.ts", "✳ Claude Code", "zsh", "", null, undefined]) assert.equal(editorTitleState(other), null, String(other));
});

test("the dirty tabs are the ones whose editor's title has the ●, in this space only", () => {
  const titled = [
    { pane: "p1", tab: "a", terminal: "t1", title: "● not an editor" },
    { pane: "p2", tab: "b", terminal: "t2", title: "● a.ts — vsedit" },
    { pane: "p3", tab: "c", terminal: null, mod: "vscode-viewer", title: "● x — vsedit" },
    { pane: "p4", tab: "e", terminal: "t5", title: "b.ts — vsedit" },
    { pane: "p5", tab: "d", terminal: "t4", title: "● d.ts — vsedit (closing)" },
    { pane: "p9", tab: "elsewhere", terminal: "t9", title: "● c.ts — vsedit" },
  ];
  assert.deepEqual([...dirtyTabs({ ...space, tabs: mixed }, titled)], ["b", "d"]);
  assert.deepEqual([...dirtyTabs(null, titled)], []);
});
