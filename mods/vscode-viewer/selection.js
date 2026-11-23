// The CSV sheet's selection (sheet.js), as in a spreadsheet: an anchor and a focus cell spanning a rectangle, and the
// active cell that typing, Enter and plain arrows start from. A cell is { r, c }; row 0 is the header row. Pure.

const cell = (r, c) => ({ r, c });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const selectCell = (r, c) => ({ anchor: cell(r, c), focus: cell(r, c), active: cell(r, c) });

// Shift+click or a drag: the rectangle from the anchor to this cell; the active cell stays.
export const extendTo = (s, r, c) => ({ ...s, focus: cell(r, c) });

// Whole rows r0..r1 (a click or drag on the row numbers), whole columns c0..c1 (on the letters), or everything.
export const selectRows = (r0, r1, cols) => ({ anchor: cell(r0, 0), focus: cell(r1, cols - 1), active: cell(r0, 0) });
export const selectCols = (c0, c1, rows) => ({ anchor: cell(0, c0), focus: cell(rows - 1, c1), active: cell(0, c0) });
export const selectAll = (rows, cols) => ({ anchor: cell(0, 0), focus: cell(rows - 1, cols - 1), active: cell(0, 0) });

// The selected rectangle, inclusive.
export function rectOf(s) {
  return { r0: Math.min(s.anchor.r, s.focus.r), r1: Math.max(s.anchor.r, s.focus.r), c0: Math.min(s.anchor.c, s.focus.c), c1: Math.max(s.anchor.c, s.focus.c) };
}
export const rectCells = (q) => (q.r1 - q.r0 + 1) * (q.c1 - q.c0 + 1);

// An arrow (or Tab, Enter): moves the active cell and collapses the range onto it; with `extend` (Shift) moves the
// focus instead, growing or shrinking the range. Both stay inside the sheet.
export function moveBy(s, dr, dc, extend, rows, cols) {
  const from = extend ? s.focus : s.active, r = clamp(from.r + dr, 0, rows - 1), c = clamp(from.c + dc, 0, cols - 1);
  return extend ? extendTo(s, r, c) : selectCell(r, c);
}

// The selection held to a sheet that may have shrunk (a reload, an undo).
export function clampSel(s, rows, cols) {
  const fit = (p) => cell(clamp(p.r, 0, rows - 1), clamp(p.c, 0, cols - 1));
  return { anchor: fit(s.anchor), focus: fit(s.focus), active: fit(s.active) };
}

// Where a pasted block `h` x `w` goes: the whole selection `q` when it is larger and a whole multiple of the block (one
// value fills it; a block repeats across it, as a spreadsheet tiles a copy), else the block's own size from the active
// cell. The value at (r, c) is block[(r - r0) % h][(c - c0) % w].
export function pasteRange(q, active, h, w) {
  const sh = q.r1 - q.r0 + 1, sw = q.c1 - q.c0 + 1;
  if ((sh > h || sw > w) && sh % h === 0 && sw % w === 0) return q;
  return { r0: active.r, r1: active.r + h - 1, c0: active.c, c1: active.c + w - 1 };
}

// Fill down (`down`) or right: the range's first row (column) copied over the rest of it; a range one row (column)
// deep takes the one above (left of) it. The header row (0) is never filled down nor copied down. Returns the row
// (column) to copy, `from`, and the range it writes, or null when there is nothing to copy from.
export function fillPlan(q, down) {
  const lo = down ? Math.max(q.r0, 1) : q.c0, hi = down ? q.r1 : q.c1, from = lo < hi ? lo : lo - 1;
  if (hi < lo || from < (down ? 1 : 0)) return null;
  return { from, q: down ? { ...q, r0: from + 1 } : { ...q, c0: from + 1 } };
}
