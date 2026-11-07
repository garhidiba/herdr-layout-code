// node --test mods/vscode-explorer/test/paths.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { openArgs, wantsEditor, isMarkdown, relativeTo, within, copyName, freeName, nameProblem, menuItems, menuHeight, parentOf, openWith, vscodeRemoteArgs, editorFileOf, autoRevealOf, revealPath, normalPath, editorTabOf } from "../paths.js";

const home = "/Users/me/.config/herdr-app";

test("every file but an image opens in the terminal editor, which shows text or (NUL bytes) the hex viewer", () => {
  const text = ["x.toml", "x.yaml", "x.yml", ".env", ".env.dev", ".env.example", ".profile", "Dockerfile", "Makefile",
    "README.md", "notes.markdown", "LICENSE", "no-extension", "big.log", "data.unknownext", "app.min.js", "a.pdf", "a.bin"];
  for (const name of text) assert.ok(wantsEditor(`/p/${name}`), name);
  for (const name of ["logo.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.ico", "a.svg", "a.tif", "a.tiff"]) assert.ok(!wantsEditor(`/p/${name}`), name);
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
    "Open", "Open With…", "-", "Reveal in Finder", "Open in Integrated Terminal", "-", "Cut", "Copy", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.deepEqual(labels(menuItems({ dir: true, remote: true, canPaste: true })), [
    "New File…", "New Folder…", "-", "Open in Integrated Terminal", "-", "Cut", "Copy", "Paste", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: false, canPaste: false, markdown: true })).slice(0, 3), ["Open", "Open Preview", "Open With…"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: true, canPaste: false })), [
    "Open", "Open With…", "-", "Open in Integrated Terminal", "-", "Cut", "Copy", "-",
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
});
