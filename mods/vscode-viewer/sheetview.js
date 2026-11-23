// The CSV sheet's view (sheet.js), apart from the data: where cells land on screen with frozen panes. Pure.
//   One axis at a time, rows or columns alike: its first `frozen` items stay put from `base`, the rest scroll by
//   `scroll` in the room after them, up to `end`. `start(i)` is item i's offset from item 0 (start(count) the whole
//   length), `at(offset)` the item holding an offset, held to the existing ones.

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
