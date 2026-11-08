// node --test mods/vscode-tabs/test/side.test.mjs
// The `side` row's width following the side panel and the Image Viewer column (side.js reconcileSide).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { find } from "../drag.js";
import { reconcileSide } from "../side.js";

const shipped = JSON.parse(readFileSync(new URL("../../../layouts/vscode.json", import.meta.url), "utf8"));
// The shipped layout with the row's width and its children's state: { side, img, panel: shown, image: shown, hidden }.
function tree({ side = 368, img = 420, panel = true, image = false, hidden = false, panelPx } = {}) {
  const t = structuredClone(shipped);
  Object.assign(find(t, "side"), { size: { px: side }, hidden });
  Object.assign(find(t, "image-panel"), { size: { px: img }, hidden: !image });
  Object.assign(find(t, "panel"), { hidden: !panel }, panelPx ? { size: { px: panelPx } } : {});
  return t;
}
// Runs a sequence of layouts through reconcileSide as the tab bar does, the clock moved past each settle.
function run(trees, mem = null) {
  let seen = null, at = 0, out;
  for (const t of trees) { out = reconcileSide(t, seen, mem, at += 1000); seen = out.seen; mem = out.mem; }
  return out;
}

test("as shipped (the panel alone, the row its width) nothing moves", () => {
  assert.deepEqual(run([tree()]).commands, []);
});

test("showing the column widens the row by its width and the gap; hiding it gives that back", () => {
  assert.deepEqual(run([tree(), tree({ image: true })]).commands, [["layout.resize", { id: "side", px: 368 + 8 + 420 }]]);
  assert.deepEqual(run([tree({ side: 796, image: true }), tree({ side: 796 })]).commands, [["layout.resize", { id: "side", px: 368 }]]);
});

test("the gutter between them trades width: the row stays, until the panel would pass its min or max", () => {
  assert.deepEqual(run([tree({ side: 796, image: true }), tree({ side: 796, img: 300, image: true })]).commands, []);
  // The column dragged to 600: the panel would be 188 < 280, so the column gives back to 508.
  assert.deepEqual(run([tree({ side: 796, image: true }), tree({ side: 796, img: 600, image: true })]).commands,
    [["layout.resize", { id: "image-panel", px: 508 }]]);
});

test("the row dragged past the panel's min or max is held at it", () => {
  assert.deepEqual(run([tree(), tree({ side: 1200 })]).commands, [["layout.resize", { id: "side", px: 900 }]]);
  assert.deepEqual(run([tree({ side: 796, image: true }), tree({ side: 600, image: true })]).commands,
    [["layout.resize", { id: "side", px: 280 + 8 + 420 }]]);
});

test("hiding the panel beside the column leaves the column's width and remembers the panel's; showing it brings that back", () => {
  const hide = run([tree({ side: 900, image: true }), tree({ side: 900, image: true, panel: false })]);
  assert.deepEqual(hide.commands, [["layout.resize", { id: "side", px: 420 }]]);
  assert.equal(hide.mem, 472);
  assert.deepEqual(run([tree({ side: 420, image: true, panel: false }), tree({ side: 420, image: true })], 472).commands,
    [["layout.resize", { id: "side", px: 472 + 8 + 420 }]]);
});

test("the column alone follows its row when that is dragged, within its own min and max", () => {
  const alone = { image: true, panel: false };
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 500 })]).commands, [["layout.resize", { id: "image-panel", px: 500 }]]);
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 200 })]).commands,
    [["layout.resize", { id: "side", px: 260 }], ["layout.resize", { id: "image-panel", px: 260 }]]);
  // A width set on the column (its scope's): the row follows the column.
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 420, img: 500 })]).commands, [["layout.resize", { id: "side", px: 500 }]]);
});

test("with both hidden the row hides; showing one shows it at that one's width", () => {
  const off = run([tree(), tree({ panel: false })]);
  assert.deepEqual(off.commands, [["layout.hide", { id: "side" }]]);
  assert.equal(off.mem, 368);
  assert.deepEqual(run([tree({ panel: false, hidden: true }), tree({ panel: false, image: true, hidden: true })]).commands,
    [["layout.resize", { id: "side", px: 420 }], ["layout.show", { id: "side" }]]);
  assert.deepEqual(run([tree({ panel: false, hidden: true }), tree({ hidden: true })], 500).commands,
    [["layout.resize", { id: "side", px: 500 }], ["layout.show", { id: "side" }]]);
});

test("its own commands are waited for: the old layout seen again within the settle time asks nothing more", () => {
  const first = reconcileSide(tree(), null, null, 0);
  const show = reconcileSide(tree({ image: true }), first.seen, null, 10);
  assert.equal(show.commands.length, 1);
  assert.deepEqual(reconcileSide(tree({ image: true }), show.seen, null, 20).commands, [], "not landed yet");
  assert.deepEqual(reconcileSide(tree({ side: 796, image: true }), show.seen, null, 30).commands, [], "landed");
});

test("an older layout state's px on the panel turns back into filling the row", () => {
  assert.deepEqual(run([tree({ panelPx: 334 })]).commands, [["layout.resize", { id: "panel", weight: 1 }]]);
});

test("a layout without the side row is left alone", () => {
  assert.deepEqual(reconcileSide({ id: "root", children: [] }, null, null, 0).commands, []);
});
