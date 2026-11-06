// Editor decorations from the text, computed for the visible lines only: indent guides (editor.guides.indentation, with
// the active one). Pure functions over lines.
const SCAN = 1000;     // lines walked from a line to find its block or the content around a blank line

// Display columns of a line's leading whitespace, or -1 for a blank (whitespace-only) line.
function leadCols(text, tab) {
  let c = 0;
  for (const ch of text) {
    if (ch === " ") c++;
    else if (ch === "\t") c += tab - (c % tab);
    else return c;
  }
  return -1;
}

// level(l): how many guides line l has (one per started indent of `size` columns). A blank line takes VS Code's rule from
// the content lines around it: one more than the shallower when they differ, their level when equal, 0 at the file's ends.
function guideLevels(lines, size, tab) {
  const memo = new Map();
  const content = (l) => {
    let v = memo.get(l);
    if (v === undefined) { const c = leadCols(lines[l], tab); memo.set(l, (v = c < 0 ? -1 : Math.ceil(c / size))); }
    return v;
  };
  const near = (l, d) => {
    for (let k = l + d, n = 0; k >= 0 && k < lines.length && n < SCAN; k += d, n++) { const v = content(k); if (v >= 0) return v; }
    return -1;
  };
  return (l) => {
    const v = content(l);
    if (v >= 0) return v;
    const up = near(l, -1), down = near(l, 1);
    if (up < 0 || down < 0) return 0;
    return up < down ? up + 1 : up === down ? down : down + 1;
  };
}

// The active guide for the cursor on line c, VS Code's: the block below a header line (the next line one level deeper),
// the block above a footer line, else the block the line is in. { index, from, to }: guide `index` on lines [from, to].
function activeGuide(level, c, n) {
  const at = level(c), down = c + 1 < n ? level(c + 1) : -1, up = c > 0 ? level(c - 1) : -1;
  let indent = at, from = c, to = c, goUp = true, goDown = true;
  if (down === at + 1) { indent = down; from = to = c + 1; goUp = false; }
  else if (up === at + 1) { indent = up; from = to = c - 1; goDown = false; }
  else if (!at) return null;
  for (let k = 0; goUp && from > 0 && k < SCAN && level(from - 1) >= indent; k++) from--;
  for (let k = 0; goDown && to < n - 1 && k < SCAN && level(to + 1) >= indent; k++) to++;
  return { index: indent - 1, from, to };
}

// Guides of lines [first, last]: per line { count, active } — guides at display columns i*size for i < count, `active` the
// index drawn in the active color (-1 for none).
function indentGuides(lines, first, last, size, tab, cursorLine) {
  const level = guideLevels(lines, size, tab), act = activeGuide(level, cursorLine, lines.length), out = [];
  for (let l = first; l <= Math.min(last, lines.length - 1); l++) {
    const count = level(l);
    out.push({ count, active: act && l >= act.from && l <= act.to && act.index < count ? act.index : -1 });
  }
  return out;
}

module.exports = { leadCols, guideLevels, activeGuide, indentGuides };
