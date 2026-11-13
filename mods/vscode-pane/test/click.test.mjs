// node --test mods/vscode-pane/test/click.test.mjs
// An editor pane's header passing presses on to vsedit (click.js): which presses, and the record written.
import test from "node:test";
import assert from "node:assert/strict";
import { clickRecord, isLocalEditor } from "../click.js";

const head = { x: 300, y: 50, width: 600, height: 30 }; // the editor's header: its text from y 80, x 300..900
const press = (x, y, mods = {}, button = "left", click_count = 1) =>
  ({ button, click_count, position: { x, y }, modifiers: { shift: false, alt: false, control: false, platform: false, ...mods } });

test("a Shift+press in the pane's text is recorded with the text box inside the padding", () => {
  assert.deepEqual(clickRecord(press(400, 300, { shift: true }), head, [], [14, 12], 8, 1000),
    { x: 400, y: 300, count: 1, at: 1000, kind: "shift", area: { x: 314, y: 92, width: 572, height: null } });
});

test("a press with no modifier is recorded as plain, for calibration; a double press keeps its count", () => {
  const r = clickRecord(press(400, 300, {}, "left", 2), head, [], [14, 12], 8, 1);
  assert.equal(r.kind, "plain");
  assert.equal(r.count, 2);
});

test("⌥, Ctrl and ⌘ presses, other buttons and presses outside the pane are not recorded", () => {
  assert.equal(clickRecord(press(400, 300, { alt: true }), head, [], [0, 0], 8, 1), null);
  assert.equal(clickRecord(press(400, 300, { control: true }), head, [], [0, 0], 8, 1), null);
  assert.equal(clickRecord(press(400, 300, { platform: true }), head, [], [0, 0], 8, 1), null);
  assert.equal(clickRecord(press(400, 300, {}, "right"), head, [], [0, 0], 8, 1), null);
  assert.equal(clickRecord(press(400, 60), head, [], [0, 0], 8, 1), null, "on the header");
  assert.equal(clickRecord(press(250, 300), head, [], [0, 0], 8, 1), null, "left of the pane");
  assert.equal(clickRecord(press(900, 300), head, [], [0, 0], 8, 1), null, "right of the pane");
});

test("a header below in the same columns bounds the pane: presses there belong to the other pane", () => {
  const below = { x: 300, y: 500, width: 600, height: 30 }, beside = { x: 908, y: 50, width: 300, height: 30 };
  assert.equal(clickRecord(press(400, 495), head, [below, beside], [14, 12], 8, 1), null, "in the gap and below");
  const r = clickRecord(press(400, 400), head, [below, beside], [14, 12], 8, 1);
  assert.deepEqual(r.area, { x: 314, y: 92, width: 572, height: 492 - 80 - 24 });
});

test("only local editors' panes pass presses on", () => {
  assert.equal(isLocalEditor({ terminal: "t3", title: "a.ts — vsedit" }), true);
  assert.equal(isLocalEditor({ terminal: "t3", title: "● a.ts — vsedit" }), true);
  assert.equal(isLocalEditor({ terminal: "vps/t3", title: "a.ts — vsedit" }), false);
  assert.equal(isLocalEditor({ terminal: "t3", title: "zsh" }), false);
  assert.equal(isLocalEditor({ terminal: null, mod: "vscode-viewer", title: "a.ts — vsedit" }), false);
});
