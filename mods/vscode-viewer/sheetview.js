// The CSV sheet's view (sheet.js), apart from the data: which rows show in which order, and where cells land on
// screen with frozen panes. Pure.
//   Rows: the view shows the header (view row 0, always the file's row 0), then the data rows in `order` (file row
//   indices, filtered and sorted; null: all of them in the file's own order). viewRows works it out a slice at a time; sourceRow maps back, so edits,
//   copies and pastes in a sorted view reach the right rows of the file.
//   Panes, one axis at a time, rows or columns alike: its first `frozen` items stay put from `base`, the rest scroll by
//   `scroll` in the room after them, up to `end`. `start(i)` is item i's offset from item 0 (start(count) the whole
//   length), `at(offset)` the item holding an offset, held to the existing ones.
import { isNumber } from "./csv.js";

// The file row a view row shows.
export const sourceRow = (order, v) => (v === 0 || !order ? v : order[v - 1]);

// Text in the reader's language order (Hangul by syllable, digits in text as numbers), or by code point without Intl
// (which also puts Hangul syllables in dictionary order).
const collator = typeof Intl === "object" && Intl.Collator ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
const textOrder = collator ? collator.compare : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const NUM = 0, TEXT = 1, EMPTY = 2;

// The data rows of `rows` in view order: those whose cells hold every one of `filters` [[c, text]] (case-insensitive
// substrings; an empty text filters nothing), sorted by `sort` { c, dir: 1 ascending | -1 descending }: numbers by
// value before text (after it descending), text in language order, empty cells last either way, ties in file order.
// A generator that yields every `step` units of work, so a caller can run it a few ms per tick (the app cuts off a
// long call); its return value is the order.
export function* viewRows(rows, { sort = null, filters = [] } = {}, step = 400) {
  const tests = filters.filter(([, t]) => t).map(([c, t]) => [c, t.toLowerCase()]);
  let order = [];
  for (let r = 1; r < rows.length; r++) {
    if (tests.every(([c, t]) => (rows[r]?.[c] ?? "").toLowerCase().includes(t))) order.push(r);
    if (r % step === 0) yield;
  }
  if (!sort) return order;
  const { c, dir } = sort, kind = new Uint8Array(rows.length), val = new Array(rows.length);
  for (let k = 0; k < order.length; k++) {
    const r = order[k], s = (rows[r]?.[c] ?? "").trim();
    if (!s) kind[r] = EMPTY;
    else if (isNumber(s)) { kind[r] = NUM; val[r] = parseFloat(s.replace(/,/g, "")); }
    else { kind[r] = TEXT; val[r] = s; }
    if (k % step === step - 1) yield;
  }
  const cmp = (i, j) => {
    const a = kind[i], b = kind[j];
    const d = a !== b ? (a === EMPTY || b === EMPTY ? a - b : (a - b) * dir) : a === EMPTY ? 0 : (a === NUM ? val[i] - val[j] : textOrder(val[i], val[j])) * dir;
    return d || i - j;
  };
  return yield* mergeSort(order, cmp, step);
}

// A bottom-up merge sort that yields every `step` comparisons.
function* mergeSort(a, cmp, step) {
  let src = a, dst = new Array(a.length), work = 0;
  const n = a.length;
  for (let w = 1; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid = Math.min(lo + w, n), hi = Math.min(lo + 2 * w, n);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) {
        dst[k++] = cmp(src[i], src[j]) <= 0 ? src[i++] : src[j++];
        if (++work === step) { work = 0; yield; }
      }
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// Where item i ends on screen along an axis, as drawn (not cut to its pane).
export const axisEnd = (i, { frozen, start, base, scroll }) => base + start(i + 1) - (i < frozen ? 0 : scroll);

// Where items lo..hi (inclusive) show along an axis: [from, to) screen px intervals, the frozen part first, each cut
// to its pane; the parts off screen are left out.
export function axisSpans(lo, hi, { frozen, start, base, scroll, end }) {
  const out = [], split = base + start(frozen);
  if (lo < frozen) out.push([base + start(lo), base + start(Math.min(hi, frozen - 1) + 1)]);
  if (hi >= frozen) {
    const shift = split - start(frozen) - scroll, from = Math.max(split, shift + start(Math.max(lo, frozen))), to = Math.min(end, shift + start(hi + 1));
    if (to > from) out.push([from, to]);
  }
  return out;
}

// The item under screen px `p` along an axis: -1 before `base` (the row numbers, the letters row).
export function axisAt(p, { frozen, start, base, scroll, at }) {
  if (p < base) return -1;
  const split = base + start(frozen);
  return p < split ? at(p - base) : at(p - split + start(frozen) + scroll);
}
