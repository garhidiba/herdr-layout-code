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

test("the gutter between them trades width: the row stays while the panel is within its min and max", () => {
  assert.deepEqual(run([tree({ side: 796, image: true }), tree({ side: 796, img: 300, image: true })]).commands, []);
  assert.equal(find(shipped, "panel").min, undefined, "the layout leaves the panel's min to side.js, so Herdr's gutter passes it");
});

test("the column dragged wider than the panel can give pushes the row (the panel at its min) into the panes", () => {
  // The column dragged to 600: the panel would be 188 < 280, so the row grows to 280 + 8 + 600.
  assert.deepEqual(run([tree({ side: 796, image: true }), tree({ side: 796, img: 600, image: true })]).commands,
    [["layout.resize", { id: "side", px: 888 }]]);
});

test("the column dragged narrower than the panel's max allows stops there", () => {
  assert.deepEqual(run([tree({ side: 1300, image: true }), tree({ side: 1300, img: 300, image: true })]).commands,
    [["layout.resize", { id: "image-panel", px: 392 }]]);
});

test("at first sight a row too narrow for both (an older state) gives the panel its remembered width", () => {
  assert.deepEqual(run([tree({ side: 368, img: 479, image: true })]).commands, [["layout.resize", { id: "side", px: 368 + 8 + 479 }]]);
  assert.deepEqual(run([tree({ side: 368, img: 479, image: true })], 300).commands, [["layout.resize", { id: "side", px: 300 + 8 + 479 }]]);
});

test("commands whose result never shows in the layout are reported, then asked again", () => {
  const show = reconcileSide(tree({ image: true }), reconcileSide(tree(), null, null, 0).seen, null, 10);
  const again = reconcileSide(tree({ image: true }), show.seen, null, 10000);
  assert.deepEqual(again.missed, { want: { side: 796, img: 420, hidden: false }, got: { side: 368, img: 420, hidden: false } });
  assert.deepEqual(again.commands, [["layout.resize", { id: "side", px: 796 }]]);
  assert.equal(reconcileSide(tree({ side: 796, image: true }), show.seen, null, 20).missed, null);
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

test("a push lands while the gutter drag goes on: the next push isn't held back by the column's moving width", () => {
  const t0 = reconcileSide(tree({ side: 796, image: true }), null, null, 0);
  const push = reconcileSide(tree({ side: 796, img: 600, image: true }), t0.seen, null, 100);
  assert.deepEqual(push.commands, [["layout.resize", { id: "side", px: 888 }]]);
  const next = reconcileSide(tree({ side: 888, img: 650, image: true }), push.seen, null, 200);
  assert.deepEqual(next.commands, [["layout.resize", { id: "side", px: 938 }]]);
});
