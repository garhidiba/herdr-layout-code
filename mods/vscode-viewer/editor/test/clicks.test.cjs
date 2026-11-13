// node --test mods/vscode-viewer/editor/test/clicks.test.cjs
// Shift+clicks from the pane header's signal file (clicks.cjs): px to cells, calibration from plain presses, what is dropped.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const CL = require("../clicks.cjs");

// A 100 × 30 terminal whose cells are 9 × 18 px from (100, 200); the header's box says 8 px wide and no height.
const real = (c, r) => ({ x: 100 + (c - 0.5) * 9, y: 200 + (r - 0.5) * 18 });
const box = { x: 100, y: 200, width: 800, height: null };
const rec = (kind, at, { x, y }, extra = {}) => ({ x, y, count: 1, at, kind, area: box, ...extra });

test("the signal file is the terminal's under the app home, none outside Herdr", () => {
  assert.equal(CL.signalFile({ HC_TERMINAL_ID: "t7", HERDR_APP_HOME: "/h" }), "/h/data/vsedit-click/t7.json");
  assert.equal(CL.signalFile({}), null);
});

test("before calibration, the box split by the terminal size places the cell; with no height, cells are twice as tall as wide", () => {
  const m = CL.estimate({ x: 100, y: 200, width: 800, height: 480 }, 100, 30);
  assert.deepEqual(CL.toCell(100 + 7.5 * 8, 200 + 1.5 * 16, m, 100, 30), { x: 8, y: 2 });
  const tall = CL.estimate(box, 100, 30);
  assert.deepEqual(CL.toCell(100 + 7.5 * 8, 200 + 1.5 * 16, tall, 100, 30), { x: 8, y: 2 });
});

test("cells off the screen are dropped", () => {
  const m = CL.estimate({ x: 100, y: 200, width: 800, height: 480 }, 100, 30);
  assert.equal(CL.toCell(90, 300, m, 100, 30), null);
  assert.equal(CL.toCell(300, 200 + 30 * 16 + 1, m, 100, 30), null);
});

test("one axis: a line through two cells or more, one cell keeps the estimated size, none keeps the estimate", () => {
  const est = { a: 96, b: 8 };
  assert.deepEqual(CL.fitAxis([], est), est);
  assert.deepEqual(CL.fitAxis([[100 + 8.5 * 9, 9]], est), { a: 100 + 8.5 * 9 - 72, b: 8 });
  const two = CL.fitAxis([[100 + 8.5 * 9, 9], [100 + 39.5 * 9, 40]], est);
  assert.ok(Math.abs(two.b - 9) < 1e-9 && Math.abs(two.a - 95.5) < 1e-9, JSON.stringify(two));
});

test("plain presses paired with their SGR cells calibrate a wrong box", () => {
  const c = new CL.Clicks(), now = 10000;
  assert.deepEqual(c.record(rec("shift", now, real(50, 4)), 100, 30, now), { x: 56, y: 4, count: 1 }, "the box alone is 6 cells off");
  c.pressed(9, 3, now + 1); c.record(rec("plain", now + 2, real(9, 3)), 100, 30, now + 2);
  c.record(rec("plain", now + 3, real(40, 10)), 100, 30, now + 3); c.pressed(40, 10, now + 4); // the record first, then its press
  assert.deepEqual(c.record(rec("shift", now + 5, real(50, 4)), 100, 30, now + 5), { x: 50, y: 4, count: 1 });
});

test("a plain record far from any press calibrates nothing; a new box or terminal size starts over", () => {
  const c = new CL.Clicks(), now = 10000;
  c.pressed(9, 3, now); c.record(rec("plain", now + 400, real(9, 3)), 100, 30, now + 400);
  c.record(rec("plain", now + 401, real(40, 10)), 100, 30, now + 401); c.pressed(40, 10, now + 402);
  assert.equal(c.pairs.length, 1);
  c.record(rec("plain", now + 403, real(1, 1)), 90, 30, now + 403);
  assert.equal(c.pairs.length, 0);
});

test("stale, repeated and malformed records are ignored; a double press keeps count 2", () => {
  const c = new CL.Clicks(), now = 10000;
  assert.equal(c.record(rec("shift", now - 1500, real(5, 5)), 100, 30, now), null, "older than 1 s");
  assert.ok(c.record(rec("shift", now, real(5, 5)), 100, 30, now));
  assert.equal(c.record(rec("shift", now, real(5, 5)), 100, 30, now), null, "already used");
  assert.equal(c.record({ x: 1, y: 1, at: now + 1, kind: "shift" }, 100, 30, now + 1), null, "no box");
  assert.equal(c.record(rec("shift", now + 2, real(5, 5), { count: 2 }), 100, 30, now + 2).count, 2);
});

test("only plain left presses are paired", () => {
  const m = (o) => ({ type: "mouse", button: 0, x: 1, y: 1, release: false, motion: false, shift: false, alt: false, ctrl: false, ...o });
  assert.equal(CL.plainPress(m({})), true);
  for (const o of [{ alt: true }, { shift: true }, { ctrl: true }, { release: true }, { motion: true }, { button: 2 }]) assert.equal(CL.plainPress(m(o)), false, JSON.stringify(o));
});
