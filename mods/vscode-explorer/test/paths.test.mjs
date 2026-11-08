// node --test mods/vscode-explorer/test/paths.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { openArgs, wantsEditor, isMarkdown, isImage, relativeTo, within, copyName, freeName, nameProblem, menuItems, menuHeight, parentOf, openWith, vscodeRemoteArgs, editorFileOf, autoRevealOf, revealPath, normalPath, editorTabOf, editorPaneOf, deleteTitle, extraLines, closesForDeleted } from "../paths.js";

test("a dialog grows by the lines a long file name wraps onto, and not for a short one", () => {
  assert.equal(deleteTitle("/p/Invoice-44K7PLUN-0001 copy 2.pdf"), "Are you sure you want to delete 'Invoice-44K7PLUN-0001 copy 2.pdf'?");
  assert.equal(extraLines(deleteTitle("/p/a.txt"), 40, 20), 0);
  assert.equal(extraLines(deleteTitle("/p/Invoice-44K7PLUN-0001 copy 2.pdf"), 40, 20), 20);
  assert.equal(extraLines("x".repeat(120), 40, 20), 40);
  assert.equal(extraLines("x".repeat(100), 56, 16, 2), 0, "the lines the dialog already has room for");
});

const home = "/Users/me/.config/herdr-app";

test("every file but an image or a video opens in the terminal editor, which shows text or (NUL bytes) the hex viewer", () => {
  const text = ["x.toml", "x.yaml", "x.yml", ".env", ".env.dev", ".env.example", ".profile", "Dockerfile", "Makefile",
    "README.md", "notes.markdown", "LICENSE", "no-extension", "big.log", "data.unknownext", "app.min.js", "a.pdf", "a.bin"];
  for (const name of text) assert.ok(wantsEditor(`/p/${name}`), name);
  for (const name of ["logo.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.ico", "a.svg", "a.tif", "a.tiff", "clip.MP4", "a.mov", "a.m4v", "a.webm", "a.mkv", "a.avi"]) assert.ok(!wantsEditor(`/p/${name}`), name);
  assert.ok(!wantsEditor("/p/a.ts", "viewer"));
  assert.ok(wantsEditor("/p/a.png", "editor"));
  assert.ok(isMarkdown("/p/README.md") && isMarkdown("/p/a.MDX") && !isMarkdown("/p/md") && !isMarkdown("/p/a.toml"));
});

test("code opens in the terminal editor, images (and remote files without the remote editor) in the viewer", () => {
  assert.deepEqual(openArgs("/p/src/a.ts", { appHome: home }),
    { name: "a.ts", folder: "/p/src", argv: ["exec", "sh", `${home}/mods/vscode-viewer/editor/vsedit.sh`, "/p/src/a.ts", "--close-on-exit"] });
  for (const f of ["/p/README.md", "/p/.env", "/p/x.toml", "/p/deploy.yml", "/p/Dockerfile"]) assert.equal(openArgs(f, { appHome: home }).argv[3], f);
  assert.equal(openArgs("/p/README.md", { appHome: home, how: "viewer" }).mod, "vscode-viewer"); // Open Preview
  assert.equal(openArgs("/p/logo.PNG", { appHome: home }).mod, "vscode-viewer");
  assert.deepEqual(openArgs("/p/a.ts", { on: "box", appHome: home }), { name: "a.ts", mod: "vscode-viewer", props: { file: "/p/a.ts", on: "box" } });
  assert.equal(openArgs("/p/a.ts", { on: "box", appHome: home, how: "editor" }).mod, "vscode-viewer"); // not installed on box
  assert.equal(openArgs("/p/README.md", { appHome: home, how: "editor" }).argv[1], "sh");
  assert.equal(openArgs("/p/a.ts", { appHome: home, how: "viewer" }).mod, "vscode-viewer");
  assert.equal(parentOf("/a"), "/");
  assert.equal(openArgs("/p/src/a.ts", { appHome: home, folder: "/p" }).folder, "/p"); // the tree's root, not src
});

test("a remote file opens in the editor installed on its machine, with the launcher's arguments", () => {
  const remote = { launcher: "/root/.local/share/herdr-vscode/1.0.0-0123456789ab/vsedit.sh", args: ["--os", "mac"] };
  assert.deepEqual(openArgs("/srv/a b.ts", { on: "box", appHome: home, folder: "/srv", remote }),
    { name: "a b.ts", folder: "/srv", argv: ["exec", "sh", remote.launcher, "/srv/a b.ts", "--close-on-exit", "--os", "mac"] });
  for (const f of ["/srv/README.md", "/srv/.env.dev", "/srv/x.toml", "/srv/compose.yaml"]) assert.equal(openArgs(f, { on: "box", appHome: home, remote }).argv[2], remote.launcher);
  assert.equal(openArgs("/srv/a.png", { on: "box", appHome: home, remote }).mod, "vscode-viewer");
  assert.equal(openArgs("/srv/a.ts", { on: "box", appHome: home, how: "viewer", remote }).mod, "vscode-viewer");
});

test("a remote file on a machine without the editor opens the viewer with the install offer", () => {
  assert.deepEqual(openArgs("/srv/.env", { on: "box", appHome: home, remote: { install: true } }),
    { name: ".env", mod: "vscode-viewer", props: { file: "/srv/.env", on: "box", install: true } });
  assert.deepEqual(openArgs("/srv/.env", { on: "box", appHome: home }).props, { file: "/srv/.env", on: "box" });
});

test("relative paths are relative to the Explorer root", () => {
  assert.equal(relativeTo("/p", "/p/src/a.ts"), "src/a.ts");
  assert.equal(relativeTo("/p", "/p"), ".");
  assert.equal(relativeTo("/p", "/pq/a"), "/pq/a");
});

test("a folder can't be pasted into itself or below itself", () => {
  assert.ok(within("/p/a", "/p/a"));
  assert.ok(within("/p/a/b", "/p/a"));
  assert.ok(!within("/p/ab", "/p/a"));
});

test("pasted copies get Finder-style names and never overwrite", async () => {
  assert.equal(copyName("a.txt", 1), "a copy.txt");
  assert.equal(copyName("a.txt", 2), "a copy 2.txt");
  assert.equal(copyName(".env", 1), ".env copy");
  assert.equal(copyName("v1.2", 1, true), "v1.2 copy");
  const taken = new Set(["a.txt", "a copy.txt"]);
  assert.equal(await freeName("a.txt", async (n) => taken.has(n)), "a copy 2.txt");
  assert.equal(await freeName("b.txt", async (n) => taken.has(n)), "b.txt");
});

test("new names must be non-empty, slash-free and not taken", () => {
  assert.ok(nameProblem("  ", false));
  assert.ok(nameProblem("a/b", false));
  assert.ok(nameProblem("..", false));
  assert.match(nameProblem("a.txt", true), /already exists/);
  assert.equal(nameProblem("a.txt", false), null);
});

test("the menu groups items like VS Code; a remote entry has every item but Reveal in Finder", () => {
  const labels = (rows) => rows.map(r => (r === "-" ? "-" : r[0]));
  assert.deepEqual(labels(menuItems({ dir: true, remote: false, canPaste: true })), [
    "New File…", "New Folder…", "-", "Reveal in Finder", "Open in Integrated Terminal", "-", "Cut", "Copy", "Paste", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: false, canPaste: false })), [
    "Open", "Open to the Side", "Open With…", "-", "Reveal in Finder", "Open in Integrated Terminal", "-", "Cut", "Copy", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.deepEqual(labels(menuItems({ dir: true, remote: true, canPaste: true })), [
    "New File…", "New Folder…", "-", "Open in Integrated Terminal", "-", "Cut", "Copy", "Paste", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: false, canPaste: false, markdown: true })).slice(0, 4), ["Open", "Open to the Side", "Open Preview", "Open With…"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: true, canPaste: false, image: true })).slice(0, 4), ["Open", "Open to the Side", "Open in Image Panel", "Open With…"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: true, canPaste: false })), [
    "Open", "Open to the Side", "Open With…", "-", "Open in Integrated Terminal", "-", "Cut", "Copy", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.equal(menuHeight(["-", ["a"]]), 10 + 9 + 26);
});

test("Open With offers system apps only for local files", () => {
  assert.deepEqual(openWith(false).map(r => r[1]), ["editor", "viewer", "code", "system"]);
  assert.deepEqual(openWith(true).map(r => r[1]), ["editor", "viewer", "code"]);
});

test("VS Code opens a remote path through Remote-SSH on plain ssh machines only", () => {
  const box = { name: "box", target: "root@10.0.0.5", via: false };
  assert.deepEqual(vscodeRemoteArgs(box, "/srv/my app/a#1.ts", false), ["--file-uri", "vscode-remote://ssh-remote+root@10.0.0.5/srv/my%20app/a%231.ts"]);
  assert.deepEqual(vscodeRemoteArgs(box, "/srv", true), ["--folder-uri", "vscode-remote://ssh-remote+root@10.0.0.5/srv"]);
  assert.equal(vscodeRemoteArgs({ ...box, via: "fly ssh console" }, "/srv", true), null);
  assert.equal(vscodeRemoteArgs({ ...box, target: "a b/c" }, "/srv", true), null);
  assert.equal(vscodeRemoteArgs(null, "/srv", true), null);
});

test("an editor tab's file is the argument after the vsedit launcher, wrapped or not; other programs have none", () => {
  const local = openArgs("/p/src/a.ts", { appHome: home }).argv;
  assert.equal(editorFileOf(local), "/p/src/a.ts");
  assert.equal(editorFileOf(["/bin/zsh", "-lic", '"$@"; exec "$0" -li', ...local]), "/p/src/a.ts"); // inside Herdr's shell
  assert.equal(editorFileOf(["/bin/sh", "-c", "find", "sh", "/home/me/.herdr-vscode/3/vsedit.sh", "/srv/x.go", "--close-on-exit", "--os", "linux"]), "/srv/x.go");
  for (const argv of [["/bin/zsh", "-l"], ["claude"], ["sh", "/a/vsedit.sh"], ["sh", "/a/vsedit.sh", "--help"], [], null, undefined]) {
    assert.equal(editorFileOf(argv), null, JSON.stringify(argv));
  }
});

test("a warm editor shows no file while it waits, then the one its label names (warm.js hands it over)", () => {
  const warm = ["/bin/sh", "-c", "find", "sh", `${home}/mods/vscode-viewer/editor/vsedit.sh`, "--warm", `${home}/.vscode-warm/tb1`, "--close-on-exit"];
  assert.equal(editorFileOf(warm, { "vscode.warm": "1" }), null);
  assert.equal(editorFileOf(warm, { "vscode.file": "/p/b.ts" }), "/p/b.ts");
  const tab = { tabs: [{ id: "tb1" }] }, panes = [{ tab: "tb1", terminal: "t5" }];
  assert.equal(editorTabOf("/p/b.ts", null, tab, panes, [{ address: "t5", argv: warm, labels: { "vscode.file": "/p/b.ts" } }]), "tb1");
  assert.equal(editorTabOf("/p/b.ts", null, tab, panes, [{ address: "t5", argv: warm, labels: {} }]), null);
});

test("revealing a file opens every folder above it, outermost first", () => {
  assert.deepEqual(revealPath("/p", "/p/src/lib/a.ts"), { path: "src/lib/a.ts", folders: ["src", "src/lib"] });
  assert.deepEqual(revealPath("/p", "/p/README.md"), { path: "README.md", folders: [] });
  assert.deepEqual(revealPath("/", "/etc/hosts"), { path: "etc/hosts", folders: ["etc"] });
});

test("a file outside the tree's root (another folder, a settings file) leaves the tree as it is", () => {
  for (const file of ["/other/a.ts", "/project-b/a.ts", "/p", "/p/", "/Users/me/.config/herdr-app/vscode-settings.json", "", null]) {
    assert.equal(revealPath("/p", file), null, String(file));
  }
  assert.equal(revealPath(null, "/p/a.ts"), null);
});

test("explorer.autoReveal is on unless the settings file turns it off", () => {
  for (const text of [null, "", "{}", '{ "explorer.autoReveal": true }', "{ broken", '{ "explorer.autoReveal": "no" }']) {
    assert.equal(autoRevealOf(text), true, String(text));
  }
  assert.equal(autoRevealOf('// mine\n{ "explorer.autoReveal": false, /* x */ }'), false);
});

test("two spellings of one path compare equal", () => {
  assert.equal(normalPath("/p//src/./a.go"), "/p/src/a.go");
  assert.equal(normalPath("/p/x/../src/a.go"), "/p/src/a.go");
  assert.equal(normalPath("/../a"), "/a");
  assert.equal(normalPath("/"), "/");
  assert.equal(normalPath("a/../b"), "b");
});

test("a file open in an editor tab of the space is found there, on its machine only", () => {
  // As Herdr lists the Explorer's editor terminal (launch.js's FIND wrapper around vsedit.sh).
  const editor = (address, file) => ({ address, argv: ["/bin/sh", "-c", "find", "sh", `${home}/mods/vscode-viewer/editor/vsedit.sh`, file, "--close-on-exit"] });
  const space = { id: "s1", tabs: [{ id: "tb1" }, { id: "tb2" }, { id: "tb3" }] };
  const panes = [{ pane: "p1", tab: "tb1", terminal: "t1" }, { pane: "p2", tab: "tb2", terminal: "t2" }, { pane: "p3", tab: "tb3", terminal: "box/t3" },
    { pane: "p4", tab: "tbX", terminal: "t4" }, { pane: "p5", tab: "tb1", terminal: null, mod: "vscode-viewer" }];
  const terminals = [{ address: "t1", argv: ["/bin/zsh", "-l"] }, editor("t2", "/p/services/followService.go"), editor("box/t3", "/p/services/followService.go"), editor("t4", "/p/other.go")];
  assert.equal(editorTabOf("/p/services/followService.go", null, space, panes, terminals), "tb2");
  assert.equal(editorTabOf("/p//services/./followService.go", null, space, panes, terminals), "tb2");
  assert.equal(editorTabOf("/p/services/followService.go", "box", space, panes, terminals), "tb3");
  assert.equal(editorTabOf("/p/services/followService.go", "nas", space, panes, terminals), null);
  assert.equal(editorTabOf("/p/other.go", null, space, panes, terminals), null); // another space's tab
  assert.equal(editorTabOf("/p/services/chatService.go", null, space, panes, terminals), null);
  assert.equal(editorTabOf("/p/a.go", null, null, panes, terminals), null);
  // moved beside a shell (vscode-tabs' move.js): found in that tab, as its own pane
  const shared = [...panes, { pane: "p6", tab: "tb1", terminal: "t6" }], more = [...terminals, editor("t6", "/p/b.go")];
  assert.deepEqual(editorPaneOf("/p/b.go", null, space, shared, more), { pane: "p6", tab: "tb1", terminal: "t6" });
  assert.equal(editorTabOf("/p/b.go", null, space, shared, more), "tb1");
});

test("deleting a file or a folder closes the panes showing it, and their tab when nothing else is in it", () => {
  const editor = (address, file) => ({ address, argv: ["sh", `${home}/mods/vscode-viewer/editor/vsedit.sh`, file, "--close-on-exit"] });
  const spaces = [{ id: "s1", tabs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] }, { id: "s2", tabs: [{ id: "f" }] }];
  const panes = [
    { pane: "pa", tab: "a", terminal: "ta", title: "x.ts — vsedit" },     // /p/src/x.ts alone
    { pane: "pb", tab: "b", terminal: "tb", title: "y.ts — vsedit" },     // /p/src/sub/y.ts beside a shell
    { pane: "pb2", tab: "b", terminal: "tsh", title: "zsh" },
    { pane: "pc", tab: "c", terminal: "tc", title: "● z.ts — vsedit" },   // unsaved
    { pane: "pd", tab: "d", terminal: null, mod: "vscode-viewer" },       // cat.png viewer
    { pane: "pe", tab: "e", terminal: "te", title: "x.ts — vsedit" },     // another folder's x.ts
    { pane: "pf", tab: "f", terminal: "box/tf", title: "x.ts — vsedit" }, // /p/src/x.ts on box
  ];
  const terminals = [editor("ta", "/p/src/x.ts"), editor("tb", "/p/src/sub/y.ts"), { address: "tsh", argv: ["/bin/zsh"] },
    editor("tc", "/p/src/z.ts"), editor("te", "/p/srcx/x.ts"), editor("box/tf", "/p/src/x.ts")];
  const viewers = { pd: { file: "/p/src/cat.png", on: null } };
  const of = (path, on = null, more = {}) => closesForDeleted(path, on, { spaces, panes, terminals, viewers, ...more });

  assert.deepEqual(of("/p/src/x.ts"), [["tab.close", { id: "a" }]], "its editor's tab; the same path on box stays");
  assert.deepEqual(of("/p/src/sub/y.ts"), [["pane.close", { pane: "pb" }]], "the shell beside it keeps the tab");
  assert.deepEqual(of("/p/src/z.ts"), [], "an unsaved editor stays");
  assert.deepEqual(of("/p/src/z.ts", null, { panes: panes.map(p => (p.pane === "pc" ? { ...p, title: "z.ts — vsedit (closing)" } : p)) }), [],
    "one asking Save / Don't Save stays too");
  assert.deepEqual(of("/p/src/cat.png"), [["tab.close", { id: "d" }]], "a viewer");
  assert.deepEqual(of("/p//src/"), [["tab.close", { id: "a" }], ["tab.close", { id: "d" }], ["pane.close", { pane: "pb" }]],
    "a folder: everything below it, not /p/srcx");
  assert.deepEqual(of("/p/src/x.ts", "box"), [["tab.close", { id: "f", confirmed: true }]], "on its machine; its space's last tab is confirmed");
  assert.deepEqual(of("/p/src/cat.png", null, { viewers: { pd: { file: "/p/src/cat.png", dirty: true } } }), [], "an unsaved viewer stays");
  assert.deepEqual(of("/p/src/cat.png", null, { viewers: {}, focusedViewer: { pane: "pd", file: "/p/src/cat.png", on: null } }),
    [["tab.close", { id: "d" }]], "a viewer known only as the focused one");
  assert.deepEqual(of("/p/src/cat.png", "box"), [], "a viewer of this computer's file, not box's");
  assert.deepEqual(of("/p/none.ts"), []);
});

test("the image panel takes the viewer's image formats, not videos or other files", () => {
  assert.deepEqual(["a.PNG", "b.jpeg", "c.svg", "d.tif", "e.webp"].map(isImage), [true, true, true, true, true]);
  assert.deepEqual(["a.mp4", "png", "a.png.txt", "notes.md"].map(isImage), [false, false, false, false]);
});
