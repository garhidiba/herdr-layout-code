// The image panel's pure rules (image.js): where the picture sits in its view for a fit mode or a zoom, how zoom steps
// and pans move it, and an image's pixel size read from its first bytes. No Herdr imports, so node tests load it.
//
// A view state is { fit: "contain" | "width" | "height" | null, scale, x, y }: with a fit the scale follows the view's
// size, without one (zoomed by hand) `scale` holds; x, y are the picture's top-left in the view (null: centered).
// `img` and `view` are { width, height } in px.

export const FITS = ["contain", "width", "height"];
export const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const MIN = STEPS[0], MAX = STEPS[STEPS.length - 1];
const clampScale = (s) => Math.min(MAX, Math.max(MIN, s));
const known = (r) => r?.width > 0 && r?.height > 0;

// The scale a fit gives: contain shows it whole and never enlarges past 100% (VS Code's preview); width / height fill that side.
export function fitScale(img, view, fit) {
  if (!known(img) || !known(view)) return 1;
  const sw = view.width / img.width, sh = view.height / img.height;
  return fit === "width" ? sw : fit === "height" ? sh : Math.min(1, sw, sh);
}

// One axis: a picture smaller than the view is centered, a larger one always covers it (no empty edge to pan into).
const clampAxis = (pos, size, room) => size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, pos ?? (room - size) / 2));
export function clampPan(pos, img, view, scale) {
  return { x: clampAxis(pos.x, img.width * scale, view.width), y: clampAxis(pos.y, img.height * scale, view.height) };
}

// Where the picture is drawn: { scale, x, y, width, height }.
export function place(state, img, view) {
  const scale = state.fit ? fitScale(img, view, state.fit) : clampScale(state.scale ?? 1);
  return { scale, ...clampPan(state, img, view, scale), width: img.width * scale, height: img.height * scale };
}

// Zoomed to `scale` keeping the image point under `at` (view px; default the view's center) where it is.
export function zoomTo(state, img, view, scale, at = { x: view.width / 2, y: view.height / 2 }) {
  const now = place(state, img, view), next = clampScale(scale), k = next / now.scale;
  return { fit: null, scale: next, ...clampPan({ x: at.x - (at.x - now.x) * k, y: at.y - (at.y - now.y) * k }, img, view, next) };
}

// One zoom step in (dir > 0) or out from the scale shown now, as the − / + buttons and keys do.
export function zoomStep(state, img, view, dir, at) {
  const s = place(state, img, view).scale;
  const next = dir > 0 ? STEPS.find(v => v > s * 1.001) ?? MAX : [...STEPS].reverse().find(v => v < s / 1.001) ?? MIN;
  return zoomTo(state, img, view, next, at);
}

// Moved by dx, dy (px), within the picture's edges; a fit stays (a fit-width picture taller than the view scrolls).
export function pan(state, img, view, dx, dy) {
  const now = place(state, img, view);
  return { ...state, ...clampPan({ x: now.x + dx, y: now.y + dy }, img, view, now.scale) };
}

// A fit button: on picks that fit (centered); the one already on goes back to contain.
export const toggleFit = (state, fit) => ({ fit: state.fit === fit && fit !== "contain" ? "contain" : fit, scale: 1, x: null, y: null });

// Double-click: from contain to 100% at the pointer, from anything else back to contain.
export const toggleZoom = (state, img, view, at) => state.fit === "contain" ? zoomTo(state, img, view, 1, at) : toggleFit(state, "contain");

// ----- an image's size from its first bytes (`b`: byte values; PNG, JPEG, GIF, BMP, WebP, ICO), or null -----

const u16be = (b, i) => (b[i] << 8) | b[i + 1], u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const u32le = (b, i) => ((b[i + 3] << 24) >>> 0) + ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i]);
const ascii = (b, i, n) => String.fromCharCode(...b.slice(i, i + n));
const size = (width, height) => width > 0 && height > 0 ? { width, height } : null;
// JPEG's start-of-frame markers (C0-CF but DHT C4, JPG C8, DAC CC), which hold the frame's size.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function imageSize(b) {
  if (!b || b.length < 10) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return b.length >= 24 ? size(u32be(b, 16), u32be(b, 20)) : null;
  if (ascii(b, 0, 3) === "GIF") return size(u16le(b, 6), u16le(b, 8));
  if (ascii(b, 0, 2) === "BM") return b.length >= 26 ? size(u32le(b, 18), Math.abs(u32le(b, 22) | 0)) : null;
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return size(b[6] || 256, b[7] || 256);
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP" && b.length >= 30) {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8 ") return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (kind === "VP8L") return size(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
    if (kind === "VP8X") return size(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (SOF.has(m)) return size(u16be(b, i + 7), u16be(b, i + 5));
      i += 2 + (m >= 0xd0 && m <= 0xd9 ? 0 : u16be(b, i + 2));
    }
  }
  return null;
}

// An SVG's size from its text: width / height in px, else its viewBox; null when it names neither.
export function svgSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(text ?? "")?.[0];
  if (!tag) return null;
  const attr = (n) => new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag);
  const w = attr("width"), h = attr("height");
  if (w && h) return size(+w[1], +h[1]);
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  return box ? size(+box[1], +box[2]) : null;
}

// The images of a folder listing (`ls -1` lines), in Finder's order: names compared with their numbers as numbers.
export const imagesIn = (names, isImage) => names.filter(n => n && !n.startsWith(".") && isImage(n))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
