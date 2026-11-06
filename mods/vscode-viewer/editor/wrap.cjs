// Word wrap (VS Code's editor.wordWrap): where a line breaks into rows, and positions <-> (row, x) within a line.
// A line's rows: { starts: [UTF-16 index], cols: [display column of that index], indent } — row k shows the line's
// display columns [cols[k], cols[k+1]) after `indent` cells (continuation rows only). Columns are the line's own, tabs
// counted from its start, so painting and measuring agree with the unwrapped line.
const W = require("./width.cjs");

const ONE = Object.freeze({ starts: [0], cols: [0], indent: 0 }); // a line that fits: one row
const MODES = ["off", "on", "wordWrapColumn", "bounded"];
const INDENTS = ["none", "same", "indent", "deepIndent"];

// VS Code's editor.wordWrapBreakBeforeCharacters / wordWrapBreakAfterCharacters defaults.
const BEFORE = 1, AFTER = 2, IDEOGRAPHIC = 3;
const CLASS = new Map();
for (const ch of "([{‘“〈《「『【〔（［｛｢£¥＄￡￥+＋") CLASS.set(ch.codePointAt(0), BEFORE);
for (const ch of " \t})]?|/&.,;¢°′″‰℃、。｡､￠，．：；？！％・･ゝゞヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎゕゖㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ々〻ｧｨｩｪｫｬｭｮｯｰ”〉》」』】〕）］｝｣") CLASS.set(ch.codePointAt(0), AFTER);
const ideographic = (cp) => (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)
  || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x3fffd);
const classOf = (cp) => CLASS.get(cp) ?? (ideographic(cp) ? IDEOGRAPHIC : 0);
const ASCII = Uint8Array.from({ length: 128 }, (_, cp) => classOf(cp));
// VS Code's canBreak: after a run of break-after characters, before a run of break-before ones, around ideographs;
// never before a space (spaces stay at the end of the row).
const canBreak = (prev, cp, cls) => cp !== 32 && ((prev === AFTER && cls !== AFTER) || (prev !== BEFORE && cls === BEFORE)
  || (prev === IDEOGRAPHIC && cls !== AFTER) || (cls === IDEOGRAPHIC && prev !== BEFORE));

// Continuation rows' indent (editor.wrappingIndent): the line's own indentation, plus one or two tab stops; none when
// a full-width character wouldn't fit after it (VS Code's computeWrappedTextIndentLength).
function indentOf(text, tab, mode, width) {
  if (mode === "none") return 0;
  const first = text.search(/\S/);
  if (first < 0) return 0;
  let n = W.textWidth(text.slice(0, first), tab);
  for (let k = mode === "deepIndent" ? 2 : mode === "indent" ? 1 : 0; k > 0; k--) n += tab - (n % tab);
  return n + 2 > width ? 0 : n;
}

// The rows of `text` wrapped at `width` columns (VS Code's monospace line breaks): a row ends at the last break
// opportunity that fits, or before the character that doesn't fit when there is none (or what would move to the next
// row doesn't fit there either). A line that fits is ONE.
function wrapLine(text, width, tab, mode = "same") {
  if (width < 1 || (text.length * 2 <= width && !text.includes("\t"))) return ONE;
  const indent = indentOf(text, tab, mode, width), starts = [0], cols = [0];
  let col = 0, avail = width, start = 0, rowCol = 0, at = -1, atCol = 0, prev = 0;
  for (let i = 0, len = text.length; i < len;) {
    let cp = text.charCodeAt(i), n = 1, w, cls;
    if (cp < 0x80) { w = cp === 9 ? tab - (col % tab) : 1; cls = ASCII[cp]; }
    else {
      if (cp >= 0xd800 && cp < 0xdc00) { cp = text.codePointAt(i); n = cp > 0xffff ? 2 : 1; }
      w = cp < 0x300 ? 1 : W.charWidth(cp); cls = classOf(cp);
    }
    if (w) {
      if (i > start && cp !== 32 && canBreak(prev, cp, cls)) { at = i; atCol = col; }
      if (col + w - rowCol > avail && i > start) {
        if (at <= start || col + w - atCol > width - indent) { at = i; atCol = col; } // a hard break
        starts.push(start = at); cols.push(rowCol = atCol); avail = width - indent; at = -1;
      }
      prev = cls;
    }
    col += w; i += n;
  }
  return starts.length === 1 ? ONE : { starts, cols, indent };
}

// Rows per line text, for one width/tab/indent mode at a time (a new one clears it); kept under ~4M characters so a
// long line edited key by key doesn't pile up its old versions.
class Cache {
  constructor() { this.key = ""; this.map = new Map(); this.chars = 0; }
  get(text, width, tab, mode) {
    if (width < 1 || (text.length * 2 <= width && !text.includes("\t"))) return ONE;
    const key = `${width}:${tab}:${mode}`;
    if (key !== this.key) { this.key = key; this.map.clear(); this.chars = 0; }
    let r = this.map.get(text);
    if (!r) {
      if (this.chars > 4e6) { this.map.clear(); this.chars = 0; }
      this.map.set(text, (r = wrapLine(text, width, tab, mode))); this.chars += text.length;
    }
    return r;
  }
}

// Row of index col: the last row starting at or before it.
function rowOf(r, col) {
  let lo = 0, hi = r.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (r.starts[mid] <= col) lo = mid; else hi = mid - 1; }
  return lo;
}
const last = (r) => r.starts.length - 1;
// Where row k's caret stops end: the line's end on the last row, else before the row's last character (the position
// at the next row's start shows on that row).
const rowEnd = (r, k, text) => (k < last(r) ? W.prevIndex(text, r.starts[k + 1]) : text.length);
// Cells from row k's left edge to index col on it (the wrap indent included).
const xOf = (r, k, text, col, tab) => (k ? r.indent : 0) + W.textWidth(text.slice(r.starts[k], col), tab, r.cols[k]);
// The caret stop on row k nearest x cells from its left edge.
function colAt(r, k, text, x, tab) {
  const i = W.indexAtCol(text, r.cols[k] + Math.max(0, x - (k ? r.indent : 0)), tab, r.starts[k], r.cols[k]);
  return Math.min(i, rowEnd(r, k, text));
}

module.exports = { ONE, MODES, INDENTS, wrapLine, Cache, rowOf, rowEnd, xOf, colAt, last };
