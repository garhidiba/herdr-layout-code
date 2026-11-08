// node --test mods/vscode-tabs/test/side.test.mjs
// The `side` row's width following the side panel and the Image Viewer column (side.js reconcileSide): the panel keeps
// its width, the outer gutter alone changes it; the inner gutter resizes the column and slides the panel as a block.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { find } from "../drag.js";
import { reconcileSide, sideMax } from "../side.js";

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
function run(trees, mem = null, max = Infinity) {
  let seen = null, at = 0, out;
  for (const t of trees) { out = reconcileSide(t, seen, mem, at += 1000, max); seen = out.seen; mem = out.mem; }
  return out;
}

const both = (side, img) => tree({ side, img, image: true });
const resize = (id, px) => ["layout.resize", { id, px }];

test("as shipped (the panel alone, the row its width) nothing moves", () => {
  assert.deepEqual(run([tree()]).commands, []);
  assert.equal(find(shipped, "panel").min, undefined, "the panel's range is side.js', so Herdr's gutters never stop at it");
});

test("showing the column widens the row by its width and the gap; hiding it gives that back", () => {
  assert.deepEqual(run([tree(), tree({ image: true })]).commands, [resize("side", 368 + 8 + 420)]);
  assert.deepEqual(run([both(796, 420), tree({ side: 796 })]).commands, [resize("side", 368)]);
});

test("the inner gutter resizes the column and slides the panel, its width unchanged: the row takes the difference", () => {
  // Wider by 100 (the panel squeezed to 268 by Herdr for a moment): the row grows by 100.
  assert.deepEqual(run([both(796, 420), both(796, 520)]).commands, [resize("side", 896)]);
  // Narrower by 120: the row shrinks by 120, the panel stays 368.
  const out = run([both(796, 420), both(796, 300)]);
  assert.deepEqual(out.commands, [resize("side", 676)]);
  assert.equal(out.seen.p, 368);
  // A drag goes on: each step slides the panel again.
  assert.deepEqual(run([both(796, 420), both(796, 520), both(896, 600)]).commands, [resize("side", 976)]);
});

test("the inner gutter stops at the column's min / max and where the panes would get narrower than MAIN_MIN", () => {
  assert.deepEqual(run([both(796, 420), both(796, 1300)]).commands, [resize("side", 368 + 8 + 1200), resize("image-panel", 1200)]);
  assert.deepEqual(run([both(796, 420), both(796, 200)]).commands, [resize("side", 368 + 8 + 260), resize("image-panel", 260)]);
  // A 1280 work column: the row at most 1280 - 16 - 8 - 300 = 956, so the column at most 956 - 376 = 580.
  const max = sideMax(shipped, 1280);
  assert.equal(max, 956);
  assert.deepEqual(run([both(796, 420), both(796, 700)], null, max).commands, [resize("side", 956), resize("image-panel", 580)]);
});

test("the outer gutter changes the panel's width alone, within 280-900, the column unchanged", () => {
  const out = run([both(796, 420), both(900, 420)]);
  assert.deepEqual(out.commands, []);
  assert.equal(out.seen.p, 472);
  assert.deepEqual(run([both(796, 420), both(600, 420)]).commands, [resize("side", 280 + 8 + 420)]);
  assert.deepEqual(run([both(796, 420), both(1500, 420)]).commands, [resize("side", 900 + 8 + 420)]);
  assert.deepEqual(run([tree(), tree({ side: 1200 })]).commands, [resize("side", 900)]);
  // Then the inner gutter slides the new width.
  assert.deepEqual(run([both(796, 420), both(900, 420), both(900, 500)]).commands, [resize("side", 472 + 8 + 500)]);
  // Against the panes' min, the panel gives way.
  assert.deepEqual(run([both(796, 420), both(990, 420)], null, 956).commands, [resize("side", 956)]);
});

test("hiding the panel beside the column leaves the column's width and remembers the panel's; showing it brings that back", () => {
  const hide = run([both(900, 420), tree({ side: 900, image: true, panel: false })]);
  assert.deepEqual(hide.commands, [resize("side", 420)]);
  assert.equal(hide.mem, 472);
  assert.deepEqual(run([both(900, 420), tree({ side: 900, image: true, panel: false }), tree({ side: 420, image: true })]).commands,
    [resize("side", 472 + 8 + 420)]);
  // After a restart, from the shared value.
  assert.deepEqual(run([tree({ side: 420, image: true, panel: false }), tree({ side: 420, image: true })], 472).commands,
    [resize("side", 472 + 8 + 420)]);
});

test("the column alone follows its row when that is dragged, within its own min and max", () => {
  const alone = { image: true, panel: false };
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 500 })]).commands, [resize("image-panel", 500)]);
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 200 })]).commands, [resize("side", 260), resize("image-panel", 260)]);
  // A width set on the column (its scope's): the row follows the column.
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 420, img: 500 })]).commands, [resize("side", 500)]);
});

test("a per-scope column width (row and column resized together) keeps the panel's width", () => {
  assert.deepEqual(run([both(796, 420), both(876, 500)]).commands, []);
});

test("with both hidden the row hides; showing one shows it at that one's width", () => {
  const off = run([tree(), tree({ panel: false })]);
  assert.deepEqual(off.commands, [["layout.hide", { id: "side" }]]);
  assert.equal(off.mem, 368);
  assert.deepEqual(run([tree({ panel: false, hidden: true }), tree({ panel: false, image: true, hidden: true })]).commands,
    [resize("side", 420), ["layout.show", { id: "side" }]]);
  assert.deepEqual(run([tree({ panel: false, hidden: true }), tree({ hidden: true })], 500).commands,
    [resize("side", 500), ["layout.show", { id: "side" }]]);
});

test("at first sight a row too narrow for both (an older state) gives the panel its remembered width", () => {
  assert.deepEqual(run([tree({ side: 368, img: 479, image: true })]).commands, [resize("side", 368 + 8 + 479)]);
  assert.deepEqual(run([tree({ side: 368, img: 479, image: true })], 300).commands, [resize("side", 300 + 8 + 479)]);
});

test("its own commands are waited for: the old layout seen again within the settle time asks nothing more", () => {
  const first = reconcileSide(tree(), null, null, 0);
  const show = reconcileSide(tree({ image: true }), first.seen, null, 10);
  assert.equal(show.commands.length, 1);
  assert.deepEqual(reconcileSide(tree({ image: true }), show.seen, null, 20).commands, [], "not landed yet");
  assert.deepEqual(reconcileSide(both(796, 420), show.seen, null, 30).commands, [], "landed");
});

test("commands whose result never shows in the layout are reported, then asked again", () => {
  const show = reconcileSide(tree({ image: true }), reconcileSide(tree(), null, null, 0).seen, null, 10);
  const again = reconcileSide(tree({ image: true }), show.seen, null, 10000);
  assert.deepEqual(again.missed, { want: { side: 796, img: 420, hidden: false }, got: { side: 368, img: 420, hidden: false } });
  assert.deepEqual(again.commands, [resize("side", 796)]);
});

test("an older layout state's px on the panel turns back into filling the row", () => {
  assert.deepEqual(run([tree({ panelPx: 334 })]).commands, [["layout.resize", { id: "panel", weight: 1 }]]);
});

test("a layout without the side row is left alone", () => {
  assert.deepEqual(reconcileSide({ id: "root", children: [] }, null, null, 0).commands, []);
});
