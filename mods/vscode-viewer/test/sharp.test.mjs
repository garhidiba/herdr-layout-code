// node --test mods/vscode-viewer/test/sharp.test.mjs
// Which resampled copy the Image Viewer draws (sharp.js), on a fake clock: asked once settled, stale jobs dropped,
// a landed copy warmed before it is swapped in.
import test from "node:test";
import assert from "node:assert/strict";
import { sharpStart, sharpAsk, sharpDue, sharpStarted, sharpDone, sharpWarmed, sharpShown, SETTLE } from "../sharp.js";

const A = "pic.png";

test("a copy is asked once the wanted width has stayed SETTLE ms, not while a resize drag runs", () => {
  let s = sharpAsk(sharpStart(), `${A}@400`, 1000);
  assert.deepEqual(sharpDue(s, 1100), { wait: SETTLE - 100 });
  s = sharpAsk(s, `${A}@390`, 1100); // the column still settling: the wait starts again
  assert.deepEqual(sharpDue(s, 1300), { wait: 50 });
  assert.equal(sharpDue(s, 5000, true), null, "a drag running");
  assert.deepEqual(sharpDue(s, 1350), { start: `${A}@390` });
  assert.equal(sharpDue(sharpAsk(sharpStart(), null, 0), 9999), null, "the original serves");
});

test("one job at a time; a job landing for a width no longer wanted is dropped, the wanted one asked next", () => {
  let s = sharpStarted(sharpAsk(sharpStart(), `${A}@400`, 0), `${A}@400`);
  assert.equal(sharpDue(s, 9999), null, "running");
  s = sharpAsk(s, `${A}@300`, 500);
  s = sharpDone(s, `${A}@400`, "cache/400.png");
  assert.equal(s.warming, null, "stale: never warmed, never shown");
  assert.equal(s.running, null);
  assert.deepEqual(sharpDue(s, 500 + SETTLE), { start: `${A}@300` });
});

test("a landed copy warms first and is swapped in only if still wanted", () => {
  let s = sharpStarted(sharpAsk(sharpStart(), `${A}@400`, 0), `${A}@400`);
  s = sharpDone(s, `${A}@400`, "cache/400.png");
  assert.deepEqual(s.warming, { key: `${A}@400`, path: "cache/400.png" });
  assert.equal(sharpShown(s, A), null, "the original still drawn while it warms");
  assert.equal(sharpDue(s, 9999), null, "not asked again while warming");
  const shown = sharpWarmed(s, `${A}@400`);
  assert.deepEqual(sharpShown(shown, A), { key: `${A}@400`, path: "cache/400.png" });
  const gone = sharpWarmed(sharpAsk(s, `${A}@200`, 50), `${A}@400`);
  assert.equal(gone.shown, null);
  assert.equal(gone.warming, null);
});

test("the shown copy stays (stretched) while a new width is asked, until the new one swaps in", () => {
  let s = sharpWarmed(sharpDone(sharpStarted(sharpAsk(sharpStart(), `${A}@400`, 0), `${A}@400`), `${A}@400`, "cache/400.png"), `${A}@400`);
  s = sharpAsk(s, `${A}@500`, 1000);
  assert.equal(sharpShown(s, A).path, "cache/400.png");
  s = sharpWarmed(sharpDone(sharpStarted(s, `${A}@500`), `${A}@500`, "cache/500.png"), `${A}@500`);
  assert.equal(sharpShown(s, A).path, "cache/500.png");
});

test("back at the shown width nothing is asked; the original serving or another picture shows no copy", () => {
  let s = sharpWarmed(sharpDone(sharpStarted(sharpAsk(sharpStart(), `${A}@400`, 0), `${A}@400`), `${A}@400`, "cache/400.png"), `${A}@400`);
  assert.equal(sharpDue(sharpAsk(s, `${A}@400`, 5000), 9999), null);
  assert.equal(sharpShown(sharpAsk(s, null, 5000), A), null);
  assert.equal(sharpShown(sharpAsk(s, "other.png@400", 5000), "other.png"), null);
});

test("a failed job asks nothing more until the width changes", () => {
  const s = sharpDone(sharpStarted(sharpAsk(sharpStart(), `${A}@400`, 0), `${A}@400`), `${A}@400`, null);
  assert.equal(s.warming, null);
  assert.equal(sharpDue(s, 9999), null);
  assert.deepEqual(sharpDue(sharpAsk(s, `${A}@300`, 10000), 10000 + SETTLE), { start: `${A}@300` });
});
