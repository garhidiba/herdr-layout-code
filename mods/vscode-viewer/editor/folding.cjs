// Folding, VS Code's indentation strategy with #region markers: the foldable ranges of a text (pure), and Folds, the
// collapsed folds of one buffer with the line <-> view row mapping that skips their hidden lines.
const { leadCols } = require("./decorations.cjs");

const MAX_RANGES = 5000; // editor.foldingMaximumRegions
// `// #region`, `#region`, `# region`, `/* #region */`, `<!-- #region -->`, `--#region` and their `endregion`s.
const MARKER = /^\s*(?:(?:\/\/|--|\/\*|<!--)\s*#?|#\s*)(end)?region\b/;
// Languages whose blocks end at their last content line, blank lines below them outside (VS Code's `offSide`).
const OFF_SIDE = new Set(["source.python", "source.yaml", "source.coffee", "text.pug", "source.sass", "source.fsharp", "source.nim"]);
const offSide = (scope) => OFF_SIDE.has(scope);

// Foldable ranges [{ start, end }] sorted by start: `start` is the header line that stays visible, lines start+1..end
// fold away. VS Code's computeRanges: a line followed by deeper-indented lines heads a range that ends before the next
// line at most as deep (blank lines in between belong to it unless offSide); a region marker pair is one range that
// includes its end line. Past MAX_RANGES the deepest ranges are dropped.
function foldRanges(lines, tab, side = false) {
  const out = [], stack = [{ indent: -1, endAbove: lines.length, line: lines.length }];
  for (let l = lines.length - 1; l >= 0; l--) {
    const text = lines[l], indent = leadCols(text, tab);
    let prev = stack[stack.length - 1];
    if (indent === -1) { if (side) prev.endAbove = l; continue; }
    const m = text.length < 1000 && MARKER.exec(text);
    if (m && m[1]) { stack.push({ indent: -2, endAbove: l, line: l }); continue; } // an end marker, seen first (bottom up)
    if (m) {
      let i = stack.length - 1;
      while (i > 0 && stack[i].indent !== -2) i--;
      if (i > 0) { // a start marker with its end below
        stack.length = i + 1; prev = stack[i];
        out.push({ start: l, end: prev.line });
        Object.assign(prev, { line: l, indent, endAbove: l });
        continue;
      }
    }
    if (prev.indent > indent) {
      do { stack.pop(); prev = stack[stack.length - 1]; } while (prev.indent > indent);
      if (prev.endAbove - 1 - l >= 1) out.push({ start: l, end: prev.endAbove - 1 });
    }
    if (prev.indent === indent) prev.endAbove = l;
    else stack.push({ indent, endAbove: l, line: l });
  }
  out.reverse();
  return out.length > MAX_RANGES ? outermost(out, MAX_RANGES) : out;
}
// The `max` least nested ranges (earlier ones first within a level), in start order.
function outermost(ranges, max) {
  const ends = [], level = ranges.map(r => { while (ends.length && ends[ends.length - 1] < r.start) ends.pop(); ends.push(r.end); return ends.length; });
  return ranges.map((r, i) => i).sort((a, b) => level[a] - level[b] || a - b).slice(0, max).sort((a, b) => a - b).map(i => ranges[i]);
}
// The innermost range holding `line` (its header or a line inside) that `ok` accepts, else null.
function innermost(ranges, line, ok = () => true) {
  let best = null;
  for (const r of ranges) { if (r.start > line) break; if (line <= r.end && ok(r)) best = r; }
  return best;
}
// The range headed by `line`, else null (ranges sorted by start).
function rangeAt(ranges, line) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ranges[mid].start === line) return ranges[mid]; if (ranges[mid].start < line) lo = mid + 1; else hi = mid - 1; }
  return null;
}

// The collapsed folds of a buffer ([{ start, end }] by start; nested ones allowed) and the view they leave: hidden lines
// are skipped, so view row v shows line fromView(v). Every method is O(log n) or better without folds.
class Folds {
  constructor() { this.list = []; this.spans = null; this.version = 0; }
  get any() { return this.list.length > 0; }
  changed() { this.spans = null; this.version++; }
  has(line) { return !!rangeAt(this.list, line); }
  collapse(ranges) {
    const add = ranges.filter(r => r.end > r.start && !this.has(r.start)).map(r => ({ start: r.start, end: r.end }));
    if (!add.length) return false;
    this.list = [...this.list, ...add].sort((a, b) => a.start - b.start); this.changed();
    return true;
  }
  expand(line) { const n = this.list.length; this.list = this.list.filter(f => f.start !== line); if (n === this.list.length) return false; this.changed(); return true; }
  clear() { if (!this.any) return false; this.list = []; this.changed(); return true; }
  // Unfolds every fold hiding `line` (the cursor moved there); true when one opened.
  reveal(line) {
    if (!this.any || !this.isHidden(line)) return false;
    this.list = this.list.filter(f => !(f.start < line && line <= f.end)); this.changed();
    return true;
  }
  // Follows recomputed ranges: a fold takes the end of the range its header still heads, and goes when none does.
  sync(ranges) {
    if (!this.any) return false;
    const next = this.list.map(f => rangeAt(ranges, f.start)).filter(Boolean).map(r => ({ start: r.start, end: r.end }));
    if (next.length === this.list.length && next.every((f, i) => f.end === this.list[i].end)) return false;
    this.list = next; this.changed();
    return true;
  }
  // A buffer edit: lines [s, s+removed) became `inserted` lines. Folds below shift, folds above stay, an edit of a
  // header's line alone keeps it, and an edit reaching into hidden lines (or splitting/joining the header) unfolds them.
  onEdit(s, removed, inserted) {
    if (!this.any) return;
    const delta = inserted - removed, last = s + removed - 1;
    this.list = this.list.flatMap(f => {
      if (s > f.end) return [f];
      if (last < f.start) return [{ start: f.start + delta, end: f.end + delta }];
      return s === f.start && removed === 1 && inserted === 1 ? [f] : [];
    });
    this.changed();
  }
  // Hidden lines as merged spans [a, b] (inclusive) with the count of hidden lines before each.
  hidden() {
    if (this.spans) return this.spans;
    const a = [], b = [], before = [];
    let total = 0;
    for (const f of this.list) {
      const s = f.start + 1, e = f.end;
      if (a.length && s <= b[b.length - 1] + 1) { const old = b[b.length - 1]; if (e > old) { b[b.length - 1] = e; total += e - old; } continue; }
      a.push(s); b.push(e); before.push(total); total += e - s + 1;
    }
    return (this.spans = { a, b, before, total });
  }
  // Index of the last span starting at or before line (-1 for none).
  spanBefore(line) {
    const { a } = this.hidden();
    let lo = 0, hi = a.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid] <= line) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return k;
  }
  isHidden(line) { if (!this.any) return false; const k = this.spanBefore(line); return k >= 0 && line <= this.hidden().b[k]; }
  // The visible line a hidden line folds into (its outermost fold's header); a visible line itself.
  visible(line) { if (!this.any) return line; const k = this.spanBefore(line), h = this.hidden(); return k >= 0 && line <= h.b[k] ? h.a[k] - 1 : line; }
  // View row of a line (a hidden line: its header's row).
  toView(line) {
    if (!this.any) return line;
    line = this.visible(line);
    const k = this.spanBefore(line), h = this.hidden();
    return k < 0 ? line : line - h.before[k] - (h.b[k] - h.a[k] + 1);
  }
  // Line at view row v.
  fromView(v) {
    if (!this.any) return v;
    const { a, b, before } = this.hidden();
    let lo = 0, hi = a.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid] - before[mid] <= v) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return k < 0 ? v : v + before[k] + (b[k] - a[k] + 1);
  }
  // The visible line after `line` (past a collapsed fold's hidden lines).
  next(line) { if (!this.any) return line + 1; const k = this.spanBefore(line + 1), h = this.hidden(); return k >= 0 && line + 1 <= h.b[k] ? h.b[k] + 1 : line + 1; }
  // Rows of a `lines`-line text: the count of visible lines.
  viewCount(lines) { return lines - (this.any ? this.hidden().total : 0); }
}

module.exports = { foldRanges, innermost, rangeAt, offSide, Folds, MARKER, MAX_RANGES };
