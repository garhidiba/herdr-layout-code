// node --test mods/vscode-viewer/test/imagefit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { fitScale, clampPan, place, zoomTo, zoomStep, pan, toggleFit, toggleZoom, imageSize, svgSize, imagesIn, STEPS } from "../imagefit.js";

const view = { width: 400, height: 300 };
const wide = { width: 1600, height: 600 }, tall = { width: 300, height: 1200 }, small = { width: 100, height: 50 };

test("contain shows the whole picture and never enlarges a small one; width / height fill their side", () => {
  assert.equal(fitScale(wide, view, "contain"), 0.25);
  assert.equal(fitScale(tall, view, "contain"), 0.25);
  assert.equal(fitScale(small, view, "contain"), 1);
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

test("fit buttons toggle back to contain; double-click goes between contain and 100%", () => {
  assert.equal(toggleFit({ fit: "contain" }, "width").fit, "width");
  assert.equal(toggleFit({ fit: "width" }, "width").fit, "contain");
  assert.equal(toggleFit({ fit: "contain" }, "contain").fit, "contain");
  assert.equal(toggleFit({ fit: null, scale: 3 }, "height").fit, "height");
  const z = toggleZoom({ fit: "contain" }, wide, view, { x: 200, y: 150 });
  assert.equal(z.fit, null); assert.equal(z.scale, 1);
  assert.equal(toggleZoom(z, wide, view).fit, "contain");
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
