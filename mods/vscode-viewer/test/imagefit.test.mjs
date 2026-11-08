// node --test mods/vscode-viewer/test/imagefit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { fitScale, clampPan, place, zoomTo, zoomStep, pan, toggleFit, nextFit, imageSize, svgSize, imagesIn, STEPS, resampleWidth, resampleName, scopeOf, stateKey, scopedEntry, withEntry, GLOBAL, viewOf, fromView, drawnAt, widthToApply } from "../imagefit.js";

const view = { width: 400, height: 300 };
const wide = { width: 1600, height: 600 }, tall = { width: 300, height: 1200 }, small = { width: 100, height: 50 };

test("contain shows the whole picture, enlarging a small one too; width / height fill their side", () => {
  assert.equal(fitScale(wide, view, "contain"), 0.25);
  assert.equal(fitScale(tall, view, "contain"), 0.25);
  assert.equal(fitScale(small, view, "contain"), 4);
  assert.equal(fitScale(small, view, "width"), 4);
  assert.equal(fitScale(wide, view, "height"), 0.5);
  assert.equal(fitScale(tall, view, "width"), 400 / 300);
  assert.equal(fitScale(null, view, "contain"), 1);
});

test("a picture smaller than the view is centered; a larger one covers it, its edges never inside the view", () => {
  assert.deepEqual(clampPan({ x: 50, y: -999 }, small, view, 1), { x: 150, y: 125 });
  assert.deepEqual(clampPan({ x: 50, y: 0 }, wide, view, 1), { x: 0, y: 0 });
  assert.deepEqual(clampPan({ x: 50, y: -400 }, wide, view, 1), { x: 0, y: -300 });
  assert.deepEqual(clampPan({ x: -5000, y: -100 }, wide, view, 1), { x: -1200, y: -100 });
  assert.deepEqual(clampPan({ x: null, y: null }, wide, view, 1), { x: -600, y: -150 });
});

test("place: a fit follows the view, a hand zoom keeps its scale", () => {
  assert.deepEqual(place({ fit: "contain" }, wide, view), { scale: 0.25, x: 0, y: 75, width: 400, height: 150 });
  const w = place({ fit: "width", x: null, y: null }, tall, view);
  assert.equal(w.width, 400); assert.equal(w.height, 1600); assert.equal(w.y, -650); // centered, scrollable
  assert.equal(place({ fit: null, scale: 2 }, small, view).width, 200);
});

test("zooming keeps the point under the pointer still", () => {
  const s = zoomTo({ fit: null, scale: 1, x: -600, y: -150 }, wide, view, 2, { x: 100, y: 100 });
  // image point under (100, 100) was (700, 250); at 2x it is at -1300 + 1400 = 100.
  assert.deepEqual(s, { fit: null, scale: 2, x: -1300, y: -400 });
});

test("zoom steps walk the fixed steps from the shown scale, within 5%-3200%", () => {
  assert.equal(zoomStep({ fit: "contain" }, wide, view, 1).scale, 0.33);
  assert.equal(zoomStep({ fit: "contain" }, wide, view, -1).scale, 0.1);
  assert.equal(zoomStep({ fit: null, scale: 1 }, wide, view, 1).scale, 1.25);
  assert.equal(zoomStep({ fit: null, scale: 32 }, wide, view, 1).scale, 32);
  assert.equal(zoomStep({ fit: null, scale: 0.05 }, wide, view, -1).scale, 0.05);
  assert.equal(zoomStep({ fit: "contain" }, wide, view, 1).fit, null);
  assert.deepEqual(STEPS, [...STEPS].sort((a, b) => a - b));
});

test("panning stays inside the picture and keeps the fit", () => {
  const s = pan({ fit: "width", x: null, y: null }, tall, view, 30, 100);
  assert.equal(s.fit, "width"); assert.equal(s.x, 0); assert.equal(s.y, -550);
  assert.equal(pan(s, tall, view, 0, 9999).y, 0);
  assert.equal(pan(s, tall, view, 0, -9999).y, -1300);
});

test("fit buttons toggle back to contain", () => {
  assert.equal(toggleFit({ fit: "contain" }, "width").fit, "width");
  assert.equal(toggleFit({ fit: "width" }, "width").fit, "contain");
  assert.equal(toggleFit({ fit: "contain" }, "contain").fit, "contain");
  assert.equal(toggleFit({ fit: null, scale: 3 }, "height").fit, "height");
});

test("double-click cycles Fit → Fit Width → Fit Height, skipping a fit that looks the same; a hand zoom goes to Fit", () => {
  const tallish = { width: 800, height: 1200 }; // contain 0.25, width 0.5, height 0.25 in the 400×300 view
  assert.equal(nextFit({ fit: "contain" }, tallish, view), "width");
  assert.equal(nextFit({ fit: "width" }, tallish, view), "height");
  assert.equal(nextFit({ fit: "height" }, tallish, view), "width", "contain = height's scale: skipped");
  assert.equal(nextFit({ fit: "contain" }, wide, view), "height"); // contain 0.25 = width 0.25
  assert.equal(nextFit({ fit: "height" }, wide, view), "contain");
  assert.equal(nextFit({ fit: null, scale: 3 }, wide, view), "contain");
  assert.equal(nextFit({ fit: "contain" }, { width: 400, height: 300 }, view), "contain", "all the same: stays");
});

const bytes = (...parts) => parts.flatMap(p => typeof p === "string" ? [...p].map(c => c.charCodeAt(0)) : p);
const be32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255], le16 = (n) => [n & 255, n >> 8], le32 = (n) => [...le16(n & 0xffff), ...le16(n >>> 16)];

test("image sizes from their first bytes", () => {
  assert.deepEqual(imageSize(bytes([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(1920), be32(1080))), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(bytes("GIF89a", le16(320), le16(200))), { width: 320, height: 200 });
  assert.deepEqual(imageSize(bytes("BM", Array(16).fill(0), le32(640), le32(-480 >>> 0))), { width: 640, height: 480 });
  assert.deepEqual(imageSize(bytes([0, 0, 1, 0, 1, 0, 0, 0, 0, 0])), { width: 256, height: 256 });
  // JPEG: SOI, an APP0 segment to skip, then SOF2 (progressive) with height 3024, width 4032.
  assert.deepEqual(imageSize(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], Array(14).fill(0), [0xff, 0xc2, 0, 17, 8, 0x0b, 0xd0, 0x0f, 0xc0, 3], Array(8).fill(0))), { width: 4032, height: 3024 });
  // WebP lossless (VP8L): 14-bit width-1 and height-1 packed after the 0x2f signature.
  const w = 800 - 1, h = 600 - 1, bits = w | (h << 14);
  assert.deepEqual(imageSize(bytes("RIFF", le32(100), "WEBP", "VP8L", le32(90), [0x2f], le32(bits), Array(8).fill(0))), { width: 800, height: 600 });
  assert.deepEqual(imageSize(bytes("RIFF", le32(100), "WEBP", "VP8X", le32(10), Array(4).fill(0), [0x1f, 3, 0], [0xff, 1, 0])), { width: 800, height: 512 });
  assert.equal(imageSize(bytes("not an image at all")), null);
  assert.equal(imageSize(null), null);
});

test("SVG sizes from width / height, else the viewBox", () => {
  assert.deepEqual(svgSize('<?xml?><svg xmlns="x" width="24px" height="16">'), { width: 24, height: 16 });
  assert.deepEqual(svgSize('<svg width="100%" viewBox="0 0 640 480">'), { width: 640, height: 480 });
  assert.equal(svgSize("<html/>"), null);
});

test("a folder's images in name order, numbers as numbers, hidden files left out", () => {
  const isImage = (n) => /\.(png|jpe?g)$/i.test(n);
  assert.deepEqual(imagesIn(["img10.png", "img2.png", "notes.txt", ".hidden.png", "", "B.JPG", "a.jpeg"], isImage), ["a.jpeg", "B.JPG", "img2.png", "img10.png"]);
});

test("a strong downscale's copy covers exactly the device px it is drawn on, rounded down, never more", () => {
  const tall = { width: 1504, height: 5280 };
  assert.equal(resampleWidth(tall, 1504 * 0.28, 1), 421); // 421.1 device px → 421
  assert.equal(resampleWidth(tall, 1504 * 0.28, 2), 842); // 842.2 → 842
  for (const density of [1, 1.5, 2]) for (let drawn = 50; drawn < 1300; drawn += 7.3) {
    const w = resampleWidth(tall, drawn, density);
    if (w !== null) { assert.ok(w <= drawn * density, `${w} <= ${drawn * density}`); assert.ok(drawn * density - w < 1); }
  }
  assert.equal(resampleWidth(tall, 1504 * 0.92, 1), null, "near its own pixels: the original");
  assert.equal(resampleWidth(tall, 1504 * 0.46, 2), null);
  assert.equal(resampleWidth(tall, 1504, 2), null, "100%");
  assert.equal(resampleWidth(tall, 3008, 1), null, "zoomed in");
  assert.equal(resampleWidth({ width: 4000, height: 10 }, 100, 2, "svg"), null);
  assert.equal(resampleWidth({ width: 4000, height: 10 }, 100, 2, "gif"), null);
  assert.equal(resampleWidth(null, 100), null);
  assert.equal(resampleWidth(tall, 0), null);
});

test("the picture is drawn at its place with its origin on whole device px", () => {
  const p = { x: 10.3, y: -20.74, width: 421.1, height: 1478.4 };
  assert.deepEqual(drawnAt(p, 1), { x: 10, y: -21, width: 421.1, height: 1478.4 });
  assert.deepEqual(drawnAt(p, 2), { x: 10.5, y: -20.5, width: 421.1, height: 1478.4 });
});

test("each fit touches its walls with no gap, in odd-sized views too", () => {
  for (const v of [view, { width: 367, height: 813 }, { width: 401.5, height: 299.25 }]) {
    for (const img of [wide, tall, small, { width: 1504, height: 5280 }]) {
      const w = drawnAt(place({ fit: "width" }, img, v), 2), h = drawnAt(place({ fit: "height" }, img, v), 2);
      assert.equal(w.x, 0); assert.ok(Math.abs(w.x + w.width - v.width) < 1e-9, "width: left and right walls");
      assert.equal(h.y, 0); assert.ok(Math.abs(h.y + h.height - v.height) < 1e-9, "height: top and bottom walls");
      const c = place({ fit: "contain" }, img, v);
      const touchesX = Math.abs(c.width - v.width) < 1e-9 && Math.abs(c.x) < 1e-9, touchesY = Math.abs(c.height - v.height) < 1e-9 && Math.abs(c.y) < 1e-9;
      assert.ok(touchesX || touchesY, "contain: the limiting side's walls");
      assert.ok(c.width <= v.width + 1e-9 && c.height <= v.height + 1e-9, "and nothing outside");
    }
  }
});

test("the column takes its scope's kept width, only when it has one and differs", () => {
  assert.equal(widthToApply({ width: 500 }, 420), 500);
  assert.equal(widthToApply({ width: 420.4 }, 420), null);
  assert.equal(widthToApply({}, 420), null);
  assert.equal(widthToApply(null, 420), null);
  const live = new Set(["s1", "s2"]);
  let all = withEntry({}, "space", "s1", live, { file: "/a.png", width: 500 });
  all = withEntry(all, "space", "s2", live, { file: "/b.png", width: 300 });
  assert.equal(widthToApply(scopedEntry(all, "space", "s1"), 300), 500);
  assert.equal(widthToApply(scopedEntry(all, "space", "s2"), 500), 300);
  all = withEntry(all, "global", "s1", live, { width: 640 });
  assert.equal(scopedEntry(all, "global", "s2").width, 640, "global: one width");
});

test("copies are named by the source's cache id, version and width, outside cachePreview's <id>-* sweep", () => {
  const st = { mtime: 1700000000, size: 12345 };
  assert.deepEqual(resampleName("abc", st, 896, "jpeg"), ["abcr-1700000000-12345-w896.jpg", "jpeg"]);
  assert.deepEqual(resampleName("abc", st, 896, "webp"), ["abcr-1700000000-12345-w896.png", "png"]);
  assert.notEqual(resampleName("abc", st, 896, "png")[0], resampleName("abc", { ...st, size: 1 }, 896, "png")[0]);
  assert.ok(!resampleName("abc", st, 896, "png")[0].startsWith("abc-"));
});

test("the scope setting: per space unless vscode-settings.json says global, comments allowed", () => {
  assert.equal(scopeOf(null), "space");
  assert.equal(scopeOf("{ // mine\n \"imageViewer.scope\": \"global\", }"), "global");
  assert.equal(scopeOf('{ "imageViewer.scope": "everywhere" }'), "space");
  assert.equal(scopeOf("{ not json"), "space");
});

test("per space each space keeps its image; global one entry for all, a remote image keeping its machine", () => {
  const live = new Set(["s1", "s2"]);
  let all = withEntry({}, "space", "s1", live, { file: "/a.png", on: null, fit: "width" });
  all = withEntry(all, "space", "s2", live, { file: "/b.png", on: "box" });
  assert.equal(scopedEntry(all, "space", "s1").file, "/a.png");
  assert.equal(scopedEntry(all, "space", "s2").on, "box");
  all = withEntry(all, "global", "s2", live, { file: "/r.png", on: "box" });
  assert.deepEqual(Object.keys(all).sort(), [GLOBAL, "s1", "s2"]);
  assert.deepEqual(scopedEntry(all, "global", "s1"), { file: "/r.png", on: "box" });
  assert.equal(stateKey("global", "s1"), GLOBAL);
  assert.equal(stateKey("space", "s1"), "s1");
});

test("switching the scope keeps the shown image: an empty entry shows the other scope's until it gets its own", () => {
  const all = { s1: { file: "/a.png", on: null, fit: "height" } };
  assert.equal(scopedEntry(all, "global", "s1").file, "/a.png");
  const next = withEntry(all, "global", "s1", new Set(["s1"]), { fit: "width" });
  assert.deepEqual(next[GLOBAL], { file: "/a.png", on: null, fit: "width" });
  assert.equal(scopedEntry({ [GLOBAL]: { file: "/g.png" } }, "space", "s9").file, "/g.png");
  assert.equal(scopedEntry({}, "space", "s1"), null);
  assert.deepEqual(Object.keys(withEntry({ gone: { file: "/x" } }, "space", "s1", new Set(["s1"]), {})), ["s1"]);
});

test("a kept view comes back on the same spot at the same zoom, also in a resized view", () => {
  const z = zoomTo({ fit: "contain" }, wide, view, 2, { x: 100, y: 100 });
  const kept = viewOf(z, wide, view);
  assert.equal(kept.fit, null); assert.equal(kept.scale, 2);
  const back = fromView(kept, wide, view);
  assert.deepEqual({ x: back.x, y: back.y, scale: back.scale }, { x: z.x, y: z.y, scale: 2 });
  // A wider view keeps the same picture point at its center.
  const big = { width: 800, height: 300 }, there = fromView(kept, wide, big);
  assert.equal((400 - there.x) / (wide.width * 2), kept.cx);
  // A fit comes back as the fit (with its scroll), whatever the view's size.
  const scrolled = pan({ fit: "width", x: null, y: null }, tall, view, 0, 200);
  const again = fromView(viewOf(scrolled, tall, view), tall, view);
  assert.equal(again.fit, "width"); assert.equal(again.y, scrolled.y);
  assert.deepEqual(fromView(null, wide, view), { fit: "contain", scale: 1, x: null, y: null });
  assert.equal(fromView({ scale: 999, cx: 0.5, cy: 0.5 }, wide, view).scale, 32);
});
