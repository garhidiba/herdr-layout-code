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

// The view kept for coming back (a space switch, a restart, the dialog handing back): the fit, else the hand zoom, and
// the picture's point at the view's center as shares of its size, so a resized view stays on the same spot.
export function viewOf(state, img, view) {
  const p = place(state, img, view);
  return { fit: state.fit ?? null, scale: p.scale, cx: (view.width / 2 - p.x) / p.width, cy: (view.height / 2 - p.y) / p.height };
}
// The view state that shows `saved` (viewOf's) again in `view`; no saved view: contain.
export function fromView(saved, img, view) {
  if (!saved) return { fit: "contain", scale: 1, x: null, y: null };
  const fit = FITS.includes(saved.fit) ? saved.fit : null, scale = fit ? fitScale(img, view, fit) : clampScale(saved.scale ?? 1);
  const at = (c, size, room) => Number.isFinite(c) ? room / 2 - c * size * scale : null;
  return { fit, scale, ...clampPan({ x: at(saved.cx, img.width, view.width), y: at(saved.cy, img.height, view.height) }, img, view, scale) };
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

// ----- smooth downscales: the GPU draws a picture smaller than its pixels by plain bilinear sampling, without mipmaps,
// so a strong downscale aliases; such a picture is drawn from a copy resampled to its drawn size instead -----

export const RESAMPLE_BELOW = 0.9; // a copy only when it would have under this share of the original's pixels
const RESAMPLE_STEP = 64;          // copy widths are rounded up to this, so small zoom moves reuse one copy
const KEPT = ["svg", "gif", "ico"]; // SVG draws sharp at any size; a GIF would lose its frames; icons are small

// The pixel width of the copy for a picture `img` drawn `drawn` px wide on a screen of `density` device px per px, or
// null when the original serves: drawn at or near its own pixels (100% and up always), or a format kept as is (`ext`).
export function resampleWidth(img, drawn, density = 2, ext = "") {
  if (!(img?.width > 0) || !(drawn > 0) || KEPT.includes(ext)) return null;
  const want = Math.ceil(drawn * density / RESAMPLE_STEP) * RESAMPLE_STEP;
  return want < img.width * RESAMPLE_BELOW ? want : null;
}

// The copy's name in the cache folder: the source's cache id (`id`, preview.js pathHash) + "r" (so cachePreview's
// sweep of `<id>-*` leaves copies alone), its version (`st`: mtime, size) and the width; a JPEG stays one, else PNG
// (keeps transparency). [name, format for the resampler].
export function resampleName(id, st, width, ext) {
  const jpeg = ext === "jpg" || ext === "jpeg";
  return [`${id}r-${st.mtime}-${st.size}-w${width}.${jpeg ? "jpg" : "png"}`, jpeg ? "jpeg" : "png"];
}

// ----- scope: one image per space (default) or one for all spaces (vscode-settings.json "imageViewer.scope") -----

export const GLOBAL = "*"; // the STATE entry every space shares in global scope (space ids never are "*")
// The scope from vscode-settings.json's text (comments and trailing commas allowed, as VS Code's); "space" unless "global".
export function scopeOf(text) {
  try {
    const o = JSON.parse(String(text ?? "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1") || "{}");
    return o?.["imageViewer.scope"] === "global" ? "global" : "space";
  } catch { return "space"; }
}
// The STATE entry a view keeps: the shown space's, or GLOBAL.
export const stateKey = (scope, space) => scope === "global" ? GLOBAL : space;
// The entry a view shows (`all`: STATE): its own, else, so switching the scope never blanks the view, the other
// scope's (the global one, or the shown space's). Entries keep their machine (`on`), so a remote image still loads.
export function scopedEntry(all, scope, space) {
  const own = all?.[stateKey(scope, space)], other = all?.[stateKey(scope === "global" ? "space" : "global", space)];
  return own?.file ? own : other?.file ? other : own ?? null;
}
// STATE with `patch` merged into the view's entry (on top of what it shows), spaces no longer in `live` dropped.
export function withEntry(all, scope, space, live, patch) {
  const key = stateKey(scope, space);
  const kept = Object.fromEntries(Object.entries(all ?? {}).filter(([k]) => k === GLOBAL || live.has(k)));
  return { ...kept, [key]: { ...scopedEntry(all, scope, space), ...patch } };
}
