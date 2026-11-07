// node --test mods/vscode-explorer/test/keys.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { treeAction, step } from "../keys.js";

const key = (k, mods = {}) => ({ key: k, modifiers: { platform: false, control: false, alt: false, shift: false, function: false, ...mods } });
const cmd = { platform: true }, ctrl = { control: true };

test("macOS: the menu's shortcuts, with Cmd", () => {
  assert.equal(treeAction(key("c", cmd), "mac"), "copy");
  assert.equal(treeAction(key("x", cmd), "mac"), "cut");
  assert.equal(treeAction(key("v", cmd), "mac"), "paste");
  assert.equal(treeAction(key("backspace", cmd), "mac"), "delete");
  assert.equal(treeAction(key("c", { platform: true, alt: true }), "mac"), "copyPath");
  assert.equal(treeAction(key("c", { platform: true, alt: true, shift: true }), "mac"), "copyRelative");
  assert.equal(treeAction(key("r", { platform: true, alt: true }), "mac"), "reveal");
  assert.equal(treeAction(key("enter"), "mac"), "rename", "Enter renames on macOS, as VS Code");
  assert.equal(treeAction(key("down", cmd), "mac"), "open");
  assert.equal(treeAction(key("space"), "mac"), "open");
});

test("Windows and Linux: Ctrl, F2 renames, Enter opens, Delete deletes", () => {
  for (const os of ["win", "linux"]) {
    assert.equal(treeAction(key("c", ctrl), os), "copy");
    assert.equal(treeAction(key("x", ctrl), os), "cut");
    assert.equal(treeAction(key("v", ctrl), os), "paste");
    assert.equal(treeAction(key("delete"), os), "delete");
    assert.equal(treeAction(key("f2"), os), "rename");
    assert.equal(treeAction(key("enter"), os), "open");
    assert.equal(treeAction(key("c", cmd), os), null, "the Windows/Super key is not Ctrl");
  }
  assert.equal(treeAction(key("c", { shift: true, alt: true }), "win"), "copyPath");
  assert.equal(treeAction(key("r", { shift: true, alt: true }), "win"), "reveal");
  assert.equal(treeAction(key("c", { control: true, alt: true }), "linux"), "copyPath");
  assert.equal(treeAction(key("c", { control: true, alt: true, shift: true }), "linux"), "copyRelative");
});

test("Open to the Side is Cmd+Enter on macOS, Ctrl+Enter elsewhere", () => {
  assert.equal(treeAction(key("enter", cmd), "mac"), "openSide");
  for (const os of ["win", "linux"]) assert.equal(treeAction(key("enter", ctrl), os), "openSide");
  assert.equal(treeAction(key("enter", ctrl), "mac"), null);
});

test("a key with extra modifiers, or one the tree doesn't use, is left alone", () => {
  assert.equal(treeAction(key("c", { platform: true, shift: true }), "mac"), null);
  assert.equal(treeAction(key("down", { shift: true }), "mac"), null);
  assert.equal(treeAction(key("c", ctrl), "mac"), null, "Ctrl+C is not Copy on macOS");
  assert.equal(treeAction(key("a"), "mac"), null);
  assert.equal(treeAction(key("up"), "linux"), "up");
});

// src/ (open) > a.js ; lib/ (closed) ; README.md
const rows = [
  { path: "src", dir: true, open: true, depth: 0 },
  { path: "src/a.js", dir: false, depth: 1 },
  { path: "lib", dir: true, open: false, depth: 0 },
  { path: "README.md", dir: false, depth: 0 },
];

test("↑/↓ step through the shown rows and stop at the ends; from nothing they start at the top", () => {
  assert.deepEqual(step(rows, "src", "down"), { select: "src/a.js" });
  assert.deepEqual(step(rows, "src", "up"), { select: "src" });
  assert.deepEqual(step(rows, "README.md", "down"), { select: "README.md" });
  assert.deepEqual(step(rows, null, "down"), { select: "src" });
  assert.equal(step([], null, "down"), null);
});

test("→ opens a closed folder, then goes to its first child; ← closes an open folder, else goes up", () => {
  assert.deepEqual(step(rows, "lib", "right"), { toggle: "lib" });
  assert.deepEqual(step(rows, "src", "right"), { select: "src/a.js" });
  assert.equal(step(rows, "README.md", "right"), null);
  assert.deepEqual(step(rows, "src", "left"), { toggle: "src" });
  assert.deepEqual(step(rows, "src/a.js", "left"), { select: "src" });
  assert.equal(step(rows, "README.md", "left"), null, "the root has no row");
});
