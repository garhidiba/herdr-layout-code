// node --test mods/vscode-explorer/test/dnd.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { ROW, clampTop, rowAt, shown, scrollToShow, dragStarted, dropFolder, dragTarget, targetRange } from "../dnd.js";

// src/ (open) > lib/ (open) > a.js ; src/b.js ; README.md
const rows = [
  { path: "src", dir: true, depth: 0 },
  { path: "src/lib", dir: true, depth: 1 },
  { path: "src/lib/a.js", dir: false, depth: 2 },
  { path: "src/b.js", dir: false, depth: 1 },
  { path: "README.md", dir: false, depth: 0 },
];

test("the pointer's y names the row under it, counting what is scrolled away", () => {
  assert.equal(rowAt(0, 0, 5), 0);
  assert.equal(rowAt(0, ROW - 1, 5), 0);
  assert.equal(rowAt(0, ROW, 5), 1);
  assert.equal(rowAt(ROW * 2 + 5, 0, 5), 2);
  assert.equal(rowAt(0, ROW * 5, 5), -1, "below the last row is empty space");
  assert.equal(rowAt(0, -1, 5), -1);
});

test("scrolling stays between the top and the last screenful", () => {
  assert.equal(clampTop(-30, 100, 220), 0);
  assert.equal(clampTop(99999, 100, 220), 100 * ROW - 220);
  assert.equal(clampTop(50, 5, 220), 0, "a tree shorter than the viewport doesn't scroll");
});

test("only the rows on screen are drawn, a partly shown one included", () => {
  assert.deepEqual(shown(0, 220, 100), [0, 10]);
  assert.deepEqual(shown(11, 220, 100), [0, 11]);
  assert.deepEqual(shown(0, 220, 3), [0, 3]);
});

test("revealing a row scrolls the least, and not at all when it is on screen", () => {
  assert.equal(scrollToShow(0, 3, 220), 0);
  assert.equal(scrollToShow(0, 20, 220), 21 * ROW - 220);
  assert.equal(scrollToShow(ROW * 10, 2, 220), ROW * 2);
});

test("a press becomes a drag only after the pointer moves a few pixels", () => {
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 12, y: 11 }), false);
  assert.equal(dragStarted({ x: 10, y: 10 }, { x: 10, y: 14 }), true);
});

test("a drop lands in a folder row's folder, a file row's folder, or the root", () => {
  assert.equal(dropFolder(rows, 1), "src/lib");
  assert.equal(dropFolder(rows, 2), "src/lib");
  assert.equal(dropFolder(rows, 3), "src");
  assert.equal(dropFolder(rows, 4), "", "a file at the root");
  assert.equal(dropFolder(rows, -1), "", "empty space");
});

test("a folder can't be dragged into itself or below it; files and other folders can go anywhere", () => {
  assert.equal(dragTarget(rows[0], rows, 0), null);
  assert.equal(dragTarget(rows[0], rows, 2), null, "src/lib/a.js is inside src");
  assert.equal(dragTarget(rows[1], rows, 3), "src", "src/lib onto src/b.js: its own folder (a move does nothing there)");
  assert.equal(dragTarget(rows[4], rows, 1), "src/lib");
  assert.equal(dragTarget(rows[2], rows, -1), "");
  assert.equal(dragTarget({ path: "srcx", dir: true }, rows, 0), "src", "a name that only starts the same is not inside");
});

test("the drop highlight covers the target folder and everything shown below it", () => {
  assert.deepEqual(targetRange(rows, "src"), [0, 4]);
  assert.deepEqual(targetRange(rows, "src/lib"), [1, 3]);
  assert.deepEqual(targetRange(rows, ""), [0, 5]);
  assert.deepEqual(targetRange(rows, "gone"), [0, 0]);
});
