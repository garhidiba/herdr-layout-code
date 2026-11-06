// VS Code-style scrollbars shared by the editor and the hex viewer: thumb size/position in eighths of a cell (drawn with
// block elements), hit-testing, click-to-jump and thumb dragging, hover highlight (mouse mode 1003 while a bar shows),
// and overview-ruler marks on the vertical bar.
const { Painter } = require("./paint.cjs");

const E = 8; // sub-cell steps: block elements come in eighths
const LOWER = (n) => String.fromCharCode(0x2580 + n); // ▁..▇: n eighths filled from the bottom
const LEFT = (n) => String.fromCharCode(0x2590 - n);  // ▏..▉: n eighths filled from the left
const MARK = "━";
const FULL = "█";

// The thumb of a bar `length` cells long showing `visible` of `total` units scrolled to `pos`: { start, size } in
// eighths, size proportional (at least one cell); null when everything fits.
function thumbOf(length, visible, total, pos) {
  if (length < 1 || total <= visible) return null;
  const track = length * E, size = Math.min(track, Math.max(E, Math.round((track * visible) / total)));
  const max = total - visible;
  return { start: Math.round(((track - size) * Math.max(0, Math.min(pos, max))) / max), size };
}
// The scroll position (whole units, clamped) that puts a thumb of `size` eighths at `start` eighths.
function posOf(length, visible, total, start, size) {
  const free = length * E - size, max = total - visible;
  if (free <= 0 || max <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, start / free)) * max);
}
// Where cell k is relative to the thumb: "thumb" (any overlap), "before" or "after".
function partOf(th, k) {
  if (th && k * E < th.start + th.size && k * E + E > th.start) return "thumb";
  return !th || k * E + E <= th.start ? "before" : "after";
}
// Each cell's glyph and the roles ("thumb"/"track") of its foreground and background.
function cellsOf(length, th, vertical) {
  const out = [];
  for (let k = 0; k < length; k++) {
    const a = Math.max(k * E, th ? th.start : 0), n = Math.min(k * E + E, th ? th.start + th.size : 0) - a;
    if (n <= 0) out.push({ ch: " ", fg: "track", bg: "track" });
    else if (n >= E) out.push({ ch: " ", fg: "thumb", bg: "thumb" });
    else if (a > k * E) out.push(vertical ? { ch: LOWER(n), fg: "thumb", bg: "track" } : { ch: LEFT(E - n), fg: "track", bg: "thumb" }); // thumb at the cell's end
    else out.push(vertical ? { ch: LOWER(E - n), fg: "track", bg: "thumb" } : { ch: LEFT(n), fg: "thumb", bg: "track" });      // thumb at the cell's start
  }
  return out;
}
// The cell (0..length-1) of an overview-ruler mark for `line` of `lines`.
const markCell = (line, lines, length) => Math.max(0, Math.min(length - 1, Math.floor((line * length) / Math.max(1, lines))));

// One bar. layout() each frame places it (and keeps the geometry the mouse is tested against); mouse() routes presses,
// drags and releases; hovering() follows buttonless motion; paint()/repaint() draw it.
class Bar {
  constructor(vertical) { this.vertical = vertical; this.shown = false; this.th = null; this.drag = null; this.hover = false; }
  // Cells from (row, col) down (vertical) or right, `length` long, showing `visible` of `total` from `pos`.
  layout(shown, row, col, length, visible, total, pos) {
    Object.assign(this, { shown, row, col, length, visible, total });
    this.th = shown ? thumbOf(length, visible, total, pos) : null;
    if (!shown) this.drag = null;
    return shown;
  }
  along(ev) { return this.vertical ? ev.y - this.row : ev.x - this.col; }
  contains(ev) {
    const k = this.along(ev);
    return this.shown && (this.vertical ? ev.x === this.col : ev.y === this.row) && k >= 0 && k < this.length;
  }
  posAt(k) { return posOf(this.length, this.visible, this.total, k * E + E / 2 - this.drag, this.th.size); }
  // Returns the new scroll position, null when the event was the bar's without scrolling, undefined when it wasn't the
  // bar's (wheels never are). A press on the thumb starts a drag; on the track it jumps so the thumb centers on the
  // pointer (VS Code) and keeps dragging from there. Drags follow the pointer anywhere until release.
  mouse(ev) {
    if (this.drag !== null) {
      if (ev.release) { this.drag = null; return null; }
      return ev.motion ? this.posAt(this.along(ev)) : null;
    }
    if (ev.button === 64 || ev.button === 65 || !this.contains(ev)) return undefined;
    if (ev.button !== 0 || ev.motion || ev.release || !this.th) return null;
    const k = this.along(ev);
    if (partOf(this.th, k) === "thumb") { this.drag = k * E + E / 2 - this.th.start; return null; }
    this.drag = this.th.size / 2;
    return this.posAt(k);
  }
  // A buttonless motion: true when the thumb's highlight (pointer on it) changed; it also ends a drag whose release never came.
  hovering(ev) {
    const h = this.contains(ev) && partOf(this.th, this.along(ev)) === "thumb", changed = h !== this.hover || this.drag !== null;
    this.hover = h; this.drag = null;
    return changed;
  }
  // c: the palette (bg, slider, sliderHover, sliderActive); marks: a color or null per cell, drawn over the bar.
  paint(P, c, marks = null) {
    if (!this.shown) return;
    const thumb = this.drag !== null ? c.sliderActive : this.hover ? c.sliderHover : c.slider;
    const role = (r) => (r === "thumb" ? thumb : c.bg);
    cellsOf(this.length, this.th, this.vertical).forEach((cell, k) => {
      if (this.vertical || k === 0) P.move(this.row + (this.vertical ? k : 0), this.col + (this.vertical ? 0 : k));
      if (marks?.[k]) P.text(c.rulerDiag?.includes(marks[k]) ? FULL : MARK, marks[k], role(cell.bg)); // problems fill their cell
      else P.text(cell.ch, role(cell.fg), role(cell.bg));
    });
  }
  // The bar alone, keeping the terminal cursor and attributes (for hover changes, without a whole frame).
  repaint(c, marks) { const P = new Painter(); this.paint(P, c, marks); return "\x1b7" + P.out + "\x1b8"; }
}

// A buttonless motion over the screen: the repaint of the bars ([bar, marks]) whose hover changed ("" when none), or
// null when the event isn't a hover.
function hover(ev, bars, colors) {
  if (ev.type !== "mouse" || !ev.motion || ev.button !== 3) return null;
  let out = "";
  for (const [bar, marks] of bars) if (bar.hovering(ev)) out += bar.repaint(colors, marks);
  return out;
}
// Any-motion mouse reports (1003) only while a bar shows (for hover), drag-only (1002) otherwise; "" when unchanged.
function hoverMode(owner, on) {
  if (!!owner.hoverMode === on) return "";
  owner.hoverMode = on;
  return on ? "\x1b[?1003h" : "\x1b[?1003l\x1b[?1002h";
}

module.exports = { E, thumbOf, posOf, partOf, cellsOf, markCell, Bar, hover, hoverMode };
