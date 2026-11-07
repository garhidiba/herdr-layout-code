// The tree's rows under the pointer. The tree scrolls itself (main.js keeps `top`, the pixels scrolled) and draws only the
// rows on screen, so a pointer's y inside the viewport names a row: what a drop from Finder or a drag inside the tree
// lands on. A virtual list can't say how far it has scrolled, nor take a handler per row.
import { parentOf, within } from "./paths.js";

export const ROW = 22;
// A press becomes a drag once the pointer moves this far, so clicks and double-clicks stay clicks.
export const DRAG_PX = 4;

// `top` kept between 0 and the last screenful.
export const clampTop = (top, count, height) => Math.max(0, Math.min(top, count * ROW - height));
// The row index at viewport y, or -1 below the last row (or above the viewport).
export function rowAt(top, y, count) {
  const i = Math.floor((top + y) / ROW);
  return y >= 0 && i < count ? i : -1;
}
// The rows on screen, [start, end).
export const shown = (top, height, count) => [Math.max(0, Math.floor(top / ROW)), Math.min(count, Math.ceil((top + height) / ROW))];
// `top` that puts row `i` on screen, moving the least (unchanged when it is on screen already).
export function scrollToShow(top, i, height) {
  if (i * ROW < top) return i * ROW;
  if ((i + 1) * ROW > top + height) return (i + 1) * ROW - height;
  return top;
}
export const dragStarted = (from, to) => Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) >= DRAG_PX;

// The folder (a path below the root, "" for the root) that something let go on row `i` goes into: a folder row is
// that folder, a file row its folder, no row the root.
export function dropFolder(rows, i) {
  const r = rows[i];
  if (!r) return "";
  if (r.dir) return r.path;
  return r.path.includes("/") ? parentOf(r.path) : "";
}

// Where the row `src` dragged onto row `i` would go, or null when it can't: a folder never goes into itself or below it.
export function dragTarget(src, rows, i) {
  const folder = dropFolder(rows, i);
  return src.dir && within(folder, src.path) ? null : folder;
}

// The rows highlighted for a drop into `folder`: the folder's row and everything shown below it, [start, end); the
// whole tree for the root.
export function targetRange(rows, folder) {
  if (folder === "") return [0, rows.length];
  const start = rows.findIndex(r => r.path === folder);
  if (start < 0) return [0, 0];
  let end = start + 1;
  while (end < rows.length && rows[end].depth > rows[start].depth) end++;
  return [start, end];
}
