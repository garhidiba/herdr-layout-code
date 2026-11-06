// Terminal display width: East Asian Wide/Fullwidth and emoji take 2 columns, combining marks 0, tabs expand.
// Columns in the buffer are UTF-16 indexes (like VS Code); display columns come from these helpers.

// Sorted [first, last] code point ranges that are 2 columns wide.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
// Zero-width: combining marks, Hangul medial/final jamo, zero-width spaces/joiners, variation selectors.
const ZERO = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x1160, 0x11ff],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff],
  [0xd7b0, 0xd7ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff], [0xe0000, 0xe01ef],
];

function inRanges(ranges, cp) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return true;
  }
  return false;
}

// Width of one code point (tabs are handled by the callers that know the column).
function charWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 1; // shown as a control picture
  if (cp < 0x300) return 1;
  if (inRanges(ZERO, cp)) return 0;
  return inRanges(WIDE, cp) ? 2 : 1;
}

// Display width of text starting at display column `col` (tabs advance to the next tab stop).
function textWidth(text, tabSize, col = 0) {
  const start = col;
  for (const ch of text) {
    if (ch === "\t") col += tabSize - (col % tabSize);
    else col += charWidth(ch.codePointAt(0));
  }
  return col - start;
}

// Display column of UTF-16 index `index` in `line`.
const displayCol = (line, index, tabSize) => textWidth(line.slice(0, index), tabSize);

// UTF-16 index of the character boundary nearest display column `col` (the right half of a wide char goes after it).
// from / fromCol: a known index and its display column to start the walk at (a wrapped row's start).
function indexAtCol(line, col, tabSize, from = 0, fromCol = 0) {
  let c = fromCol, i = from;
  for (const ch of from ? line.slice(from) : line) {
    const w = ch === "\t" ? tabSize - (c % tabSize) : charWidth(ch.codePointAt(0));
    if (c + w > col && w > 0) return (col - c) * 2 >= w ? i + ch.length : i;
    c += w; i += ch.length;
  }
  return i;
}

// Next/previous cursor stop: steps over surrogate pairs and the zero-width marks that follow a character.
function nextIndex(line, i) {
  if (i >= line.length) return line.length;
  i += line.codePointAt(i) > 0xffff ? 2 : 1;
  while (i < line.length && charWidth(line.codePointAt(i)) === 0) i += line.codePointAt(i) > 0xffff ? 2 : 1;
  return i;
}
function prevIndex(line, i) {
  while (i > 0) {
    const lo = line.charCodeAt(i - 1);
    i -= lo >= 0xdc00 && lo <= 0xdfff && i > 1 ? 2 : 1;
    if (charWidth(line.codePointAt(i)) !== 0) break;
  }
  return Math.max(0, i);
}

// Tabs replaced by spaces up to each tab stop (what the screen shows).
function expandTabs(line, tabSize) {
  if (!line.includes("\t")) return line;
  let out = "", col = 0;
  for (const ch of line) {
    if (ch === "\t") { const n = tabSize - (col % tabSize); out += " ".repeat(n); col += n; }
    else { out += ch; col += charWidth(ch.codePointAt(0)); }
  }
  return out;
}

module.exports = { charWidth, textWidth, displayCol, indexAtCol, nextIndex, prevIndex, expandTabs };
