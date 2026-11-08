// node --test mods/vscode-viewer/test/toolbar.test.mjs
// The Image Viewer toolbar's delayed show / hide (toolbar.js), on a fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import { barsStart, barsShown, barsTick, barsMove, barsLeave, barsOver, barsNext, SHOW_DELAY, LEAVE_HIDE, IDLE_HIDE } from "../toolbar.js";

// Shown at `t` (deadlines passed).
const shownAt = (s, t, busy) => barsShown(barsTick(s, t, busy));

test("hidden at first; shown only after the pointer has been inside the delay", () => {
  let s = barsStart();
  assert.equal(shownAt(s, 0), false);
  s = barsMove(s, 1000, 200);
  assert.equal(shownAt(s, 1000 + SHOW_DELAY - 1), false);
  assert.equal(barsNext(s, 1000), SHOW_DELAY);
  s = barsMove(s, 1100, 210); // moving on doesn't push the delay back
  assert.equal(shownAt(s, 1000 + SHOW_DELAY), true);
});

test("the top band or the rows themselves show them at once", () => {
  assert.equal(barsShown(barsMove(barsStart(), 1000, 20)), true);
  assert.equal(barsShown(barsMove(barsStart(), 1000, 48)), false, "below the band waits");
  assert.equal(barsShown(barsOver(barsStart(), 1000, true)), true);
});

test("leaving hides them after a while; coming back in time keeps them", () => {
  let s = barsTick(barsMove(barsStart(), 0, 200), SHOW_DELAY);
  s = barsLeave(s, 500);
  assert.equal(shownAt(s, 500 + LEAVE_HIDE - 1), true);
  assert.equal(barsNext(s, 500), LEAVE_HIDE);
  assert.equal(shownAt(s, 500 + LEAVE_HIDE), false);
  const back = barsMove(barsLeave(barsTick(barsMove(barsStart(), 0, 200), SHOW_DELAY), 500), 900, 200);
  assert.equal(barsShown(back), true, "no new delay while still shown");
});

test("leaving before the delay ran out never shows them", () => {
  const s = barsLeave(barsMove(barsStart(), 0, 200), 100);
  assert.equal(shownAt(s, 5000), false);
  assert.equal(barsNext(s, 100), null);
});

test("a still pointer inside hides them; any move shows them again after the delay", () => {
  let s = barsMove(barsStart(), 0, 200);
  assert.equal(shownAt(s, SHOW_DELAY), true);
  assert.equal(shownAt(s, IDLE_HIDE - 1), true);
  s = barsTick(s, IDLE_HIDE);
  assert.equal(barsShown(s), false);
  s = barsMove(s, 3000, 200);
  assert.equal(barsShown(s), false);
  assert.equal(shownAt(s, 3000 + SHOW_DELAY), true);
});

test("over the rows, or while a drag or zoom runs, a still pointer keeps them", () => {
  const over = barsOver(barsStart(), 0, true);
  assert.equal(shownAt(over, 60000), true);
  assert.equal(barsNext(over, 0), null);
  const shown = barsTick(barsMove(barsStart(), 0, 200), SHOW_DELAY);
  assert.equal(shownAt(shown, 60000, true), true);
  assert.equal(barsNext(shown, 0, true), null);
  // Off the rows onto the picture: the still-pointer wait starts there.
  const off = barsOver(over, 5000, false);
  assert.equal(shownAt(off, 5000 + IDLE_HIDE - 1), true);
  assert.equal(shownAt(off, 5000 + IDLE_HIDE), false);
});

test("the next wake is the nearest deadline", () => {
  const s = barsTick(barsMove(barsStart(), 0, 200), SHOW_DELAY);
  assert.equal(barsNext(s, 500), IDLE_HIDE - 500);
  assert.equal(barsNext(barsStart(), 0), null);
});
