// node --test mods/vscode-explorer/test/paths.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { openArgs, relativeTo, within, copyName, freeName, nameProblem, menuItems, menuHeight, parentOf } from "../paths.js";

const home = "/Users/me/.config/herdr-app";

test("code opens in the terminal editor, images/markdown/remote files in the viewer", () => {
  assert.deepEqual(openArgs("/p/src/a.ts", { appHome: home }),
    { name: "a.ts", folder: "/p/src", argv: ["exec", "node", `${home}/mods/vscode-viewer/editor/vsedit.cjs`, "/p/src/a.ts", "--close-on-exit"] });
  assert.equal(openArgs("/p/README.md", { appHome: home }).mod, "vscode-viewer");
  assert.equal(openArgs("/p/logo.PNG", { appHome: home }).mod, "vscode-viewer");
  assert.deepEqual(openArgs("/p/a.ts", { on: "box", appHome: home }), { name: "a.ts", mod: "vscode-viewer", props: { file: "/p/a.ts", on: "box" } });
  assert.equal(openArgs("/p/README.md", { appHome: home, how: "editor" }).argv[1], "node");
  assert.equal(openArgs("/p/a.ts", { appHome: home, how: "viewer" }).mod, "vscode-viewer");
  assert.equal(parentOf("/a"), "/");
  assert.equal(openArgs("/p/src/a.ts", { appHome: home, folder: "/p" }).folder, "/p"); // the tree's root, not src
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

test("the menu groups items like VS Code and hides file operations for remote folders", () => {
  const labels = (rows) => rows.map(r => (r === "-" ? "-" : r[0]));
  assert.deepEqual(labels(menuItems({ dir: true, remote: false, canPaste: true })), [
    "New File…", "New Folder…", "-", "Reveal in Finder", "Open in Integrated Terminal", "-", "Cut", "Copy", "Paste", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: false, canPaste: false })), [
    "Open Preview", "Open With…", "-", "Reveal in Finder", "Open in Integrated Terminal", "-", "Cut", "Copy", "-",
    "Copy Path", "Copy Relative Path", "-", "Rename…", "Delete"]);
  assert.deepEqual(labels(menuItems({ dir: false, remote: true, canPaste: true })), ["Open Preview", "-", "Copy Path", "Copy Relative Path"]);
  assert.equal(menuHeight(["-", ["a"]]), 10 + 9 + 26);
});
