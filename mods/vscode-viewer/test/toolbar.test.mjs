// node --test mods/vscode-viewer/test/toolbar.test.mjs
// The Image Viewer toolbar's show on click / hide by itself (toolbar.js), on a fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import { barsStart, barsShown, barsTick, barsClick, barsEnter, barsLeave, barsOver, barsNext, LEAVE_HIDE, IDLE_HIDE } from "../toolbar.js";

// Shown at `t` (deadlines passed).
const shownAt = (s, t, busy) => barsShown(barsTick(s, t, busy));

test("hidden at first; the pointer moving or coming in doesn't show them", () => {
  const s = barsStart();
  assert.equal(barsShown(s), false);
  assert.equal(barsShown(barsEnter(s, 1000)), false);
  assert.equal(barsShown(barsOver(s, 1000, true)), false, "not even over the rows' place");
  assert.equal(barsNext(s, 0), null);
});

test("a click shows them at once; another click hides them", () => {
  const s = barsClick(barsStart(), 1000);
  assert.equal(barsShown(s), true);
  assert.equal(barsShown(barsClick(s, 1500)), false);
});

test("a click on the rows keeps them (and counts as use); on hidden rows' place it shows them", () => {
  const s = barsOver(barsClick(barsStart(), 0), 500, true);
  const kept = barsClick(s, 900);
  assert.equal(barsShown(kept), true);
  assert.equal(shownAt(barsOver(kept, 900, false), 900 + IDLE_HIDE - 1), true);
  assert.equal(barsShown(barsClick(barsOver(barsStart(), 0, true), 100)), true);
});

test("they hide a while after the last click, or after the pointer leaves the rows", () => {
  const s = barsClick(barsStart(), 0);
  assert.equal(barsNext(s, 500), IDLE_HIDE - 500);
  assert.equal(shownAt(s, IDLE_HIDE - 1), true);
  assert.equal(shownAt(s, IDLE_HIDE), false);
  const off = barsOver(barsOver(s, 1000, true), 5000, false);
  assert.equal(shownAt(off, 5000 + IDLE_HIDE - 1), true);
  assert.equal(shownAt(off, 5000 + IDLE_HIDE), false);
});

test("over the rows, or while a drag runs, they stay", () => {
  const over = barsOver(barsClick(barsStart(), 0), 100, true);
  assert.equal(shownAt(over, 60000), true);
  assert.equal(barsNext(over, 100), null);
  const s = barsClick(barsStart(), 0);
  assert.equal(shownAt(s, 60000, true), true);
  assert.equal(barsNext(s, 0, true), null);
});

test("leaving hides them after a while; coming back in time keeps them", () => {
  const left = barsLeave(barsClick(barsStart(), 0), 500);
  assert.equal(barsNext(left, 500), LEAVE_HIDE);
  assert.equal(shownAt(left, 500 + LEAVE_HIDE - 1), true);
  assert.equal(shownAt(left, 500 + LEAVE_HIDE), false);
  const back = barsEnter(left, 900);
  assert.equal(shownAt(back, 900 + IDLE_HIDE - 1), true);
  assert.equal(shownAt(back, 900 + IDLE_HIDE), false);
  assert.equal(barsShown(barsLeave(barsStart(), 0)), false);
});
