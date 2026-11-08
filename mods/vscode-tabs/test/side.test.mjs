// node --test mods/vscode-tabs/test/side.test.mjs
// The `side` row's width following the side panel and the Image Viewer column (side.js reconcileSide): the panel keeps
// its width, the outer gutter alone changes it; the sash between them (sashDrag) resizes the column and slides the
// panel as a block. The row has no gutter or gap of its own: the 8 px between the cards are the two mods' sash halves.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { find } from "../drag.js";
import { reconcileSide, sideMax, sashStart, sashDrag, workWidth } from "../side.js";

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

test("the row has no gutter or gap of its own; the panel's range is side.js'", () => {
  const side = find(shipped, "side");
  assert.equal(side.resizable, false, "Herdr's gutter would squeeze the panel for a frame");
  assert.equal(side.gap, 0, "the mods' sash halves make the 8 px");
  assert.equal(find(shipped, "panel").min, undefined);
  assert.deepEqual(run([tree()]).commands, []);
});

test("showing the column widens the row by its width; hiding it gives that back", () => {
  assert.deepEqual(run([tree(), tree({ image: true })]).commands, [resize("side", 368 + 420)]);
  assert.deepEqual(run([both(788, 420), tree({ side: 788 })]).commands, [resize("side", 368)]);
});

test("the sash sizes the column and the row together, the panel's width kept: the panel slides as a block", () => {
  const from = sashStart(both(788, 420), 1000);
  assert.deepEqual(from, { x: 1000, p: 368, img: 420 });
  assert.deepEqual(sashDrag(both(788, 420), from, 900, NaN), [resize("image-panel", 520), resize("side", 888)]);
  assert.deepEqual(sashDrag(both(888, 520), from, 1120, NaN), [resize("image-panel", 300), resize("side", 668)]);
  // Then reconcile sees both changed together: nothing to fix, the panel still 368.
  const out = run([both(788, 420), both(888, 520)]);
  assert.deepEqual(out.commands, []);
  assert.equal(out.seen.p, 368);
});

test("the sash stops at the column's min / max and where the panes would get narrower than MAIN_MIN", () => {
  const from = sashStart(both(788, 420), 1000);
  assert.deepEqual(sashDrag(both(788, 420), from, 0, NaN)[0], resize("image-panel", 1200));
  assert.deepEqual(sashDrag(both(788, 420), from, 1500, NaN)[0], resize("image-panel", 260));
  // A 1548 window with the 268 sidebar: a 1280 work column, the row at most 1280 - 16 - 8 - 300 = 956, the column 588.
  const work = workWidth(shipped, 1548);
  assert.equal(work, 1280);
  assert.equal(sideMax(shipped, work), 956);
  assert.deepEqual(sashDrag(both(788, 420), from, 600, work), [resize("image-panel", 588), resize("side", 956)]);
  assert.deepEqual(sashStart(tree(), 1000), null, "no column shown, no sash");
});

test("the column resized alone (its scope's width, set without the row) takes the row along, the panel kept", () => {
  assert.deepEqual(run([both(788, 420), both(788, 520)]).commands, [resize("side", 888)]);
  assert.deepEqual(run([both(788, 420), both(868, 500)]).commands, [], "row and column together");
});

test("the outer gutter changes the panel's width alone, within 280-900, the column unchanged", () => {
  const out = run([both(788, 420), both(892, 420)]);
  assert.deepEqual(out.commands, []);
  assert.equal(out.seen.p, 472);
  assert.deepEqual(run([both(788, 420), both(600, 420)]).commands, [resize("side", 280 + 420)]);
  assert.deepEqual(run([both(788, 420), both(1500, 420)]).commands, [resize("side", 900 + 420)]);
  assert.deepEqual(run([tree(), tree({ side: 1200 })]).commands, [resize("side", 900)]);
  // Then the sash slides the new width.
  const from = sashStart(both(892, 420), 1000);
  assert.deepEqual(sashDrag(both(892, 420), from, 920, NaN), [resize("image-panel", 500), resize("side", 972)]);
  // Against the panes' min, the panel gives way.
  assert.deepEqual(run([both(788, 420), both(990, 420)], null, 956).commands, [resize("side", 956)]);
});

test("hiding the panel beside the column leaves the column's width and remembers the panel's; showing it brings that back", () => {
  const hide = run([both(892, 420), tree({ side: 892, image: true, panel: false })]);
  assert.deepEqual(hide.commands, [resize("side", 420)]);
  assert.equal(hide.mem, 472);
  assert.deepEqual(run([both(892, 420), tree({ side: 892, image: true, panel: false }), tree({ side: 420, image: true })]).commands,
    [resize("side", 472 + 420)]);
  // After a restart, from the shared value.
  assert.deepEqual(run([tree({ side: 420, image: true, panel: false }), tree({ side: 420, image: true })], 472).commands,
    [resize("side", 472 + 420)]);
});

test("the column alone follows its row when that is dragged, within its own min and max", () => {
  const alone = { image: true, panel: false };
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 500 })]).commands, [resize("image-panel", 500)]);
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 200 })]).commands, [resize("side", 260), resize("image-panel", 260)]);
  assert.deepEqual(run([tree({ ...alone, side: 420 }), tree({ ...alone, side: 420, img: 500 })]).commands, [resize("side", 500)]);
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
  assert.deepEqual(run([tree({ side: 368, img: 479, image: true })]).commands, [resize("side", 368 + 479)]);
  assert.deepEqual(run([tree({ side: 368, img: 479, image: true })], 300).commands, [resize("side", 300 + 479)]);
});

test("its own commands are waited for: the old layout seen again within the settle time asks nothing more", () => {
  const first = reconcileSide(tree(), null, null, 0);
  const show = reconcileSide(tree({ image: true }), first.seen, null, 10);
  assert.equal(show.commands.length, 1);
  assert.deepEqual(reconcileSide(tree({ image: true }), show.seen, null, 20).commands, [], "not landed yet");
  assert.deepEqual(reconcileSide(both(788, 420), show.seen, null, 30).commands, [], "landed");
});

test("commands whose result never shows in the layout are reported, then asked again", () => {
  const show = reconcileSide(tree({ image: true }), reconcileSide(tree(), null, null, 0).seen, null, 10);
  const again = reconcileSide(tree({ image: true }), show.seen, null, 10000);
  assert.deepEqual(again.missed, { want: { side: 788, img: 420, hidden: false }, got: { side: 368, img: 420, hidden: false } });
  assert.deepEqual(again.commands, [resize("side", 788)]);
});

test("an older layout state's px on the panel turns back into filling the row", () => {
  assert.deepEqual(run([tree({ panelPx: 334 })]).commands, [["layout.resize", { id: "panel", weight: 1 }]]);
});

test("a layout without the side row is left alone", () => {
  assert.deepEqual(reconcileSide({ id: "root", children: [] }, null, null, 0).commands, []);
  assert.deepEqual(sashDrag({ id: "root", children: [] }, { x: 0, p: 0, img: 0 }, 0, NaN), []);
});
