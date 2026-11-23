// The viewer's CSV/TSV preview (main.js), drawn and used like a spreadsheet: a row-number column, a row of column
// letters and the file's first row as a bold header, a cell grid, numbers aligned right.
//   Viewport: only what is on screen is built, so tens of thousands of rows or hundreds of columns stay quick (the app
//   cuts off a render that runs long). The grid is its own viewport on both axes (csv.js visibleColumns): one wheel
//   handler takes the wheel and trackpad, Shift+wheel sideways, and bars along the right and bottom edges drag; the row
//   numbers and the two header rows stay put. No scroll container inside: a GPUI scroll area that moves stops the
//   event, so a list scrolling down would swallow a diagonal swipe's sideways part.
//   Selection (selection.js): click a cell, drag or Shift+click a range, click row numbers, letters or the corner for
//   rows, columns or all; arrows move (Shift: extend), Tab moves right, ⌘A selects all, ⌘C copies the range as TSV.
//   Editing (not on a remote, read-only file): double-click, Enter, F2 or typing opens an input on the active cell;
//   Enter commits and moves down, Tab right, Esc cancels, leaving it commits. Delete/Backspace clear the range, ⌘V
//   pastes TSV from the active cell, ⌘Z/⌘⇧Z undo and redo. The viewer owns the text (`actions`, main.js). A toolbar
//   row above the grid says how to edit (or that the file is read-only).
//   Freeze panes (toolbar, Freeze at <cell> / Unfreeze): the rows above and the columns left of the active cell stay
//   put while the rest scrolls (sheetview.js maps cells to the frozen and scrolled panes); the header row always does.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { columnLabel, isNumber, cellText, visibleColumns, clampX, scrollToShow, columnStarts, columnAt, toTsv, parseCsv, thumbOf, scrollAtTrack } from "./csv.js";
import { axisSpans, axisAt } from "./sheetview.js";
import { selectCell, extendTo, selectRows, selectCols, selectAll, rectOf, rectCells, moveBy, clampSel } from "./selection.js";

const ROW_H = 22, LETTERS_H = 20, BAR = 12, TOOLS_H = 26;
// The most cells one clear or paste writes (the viewer writes them a chunk of rows per tick), and one copy takes (read a
// few ms per tick): the app cuts off a long call.
const MAX_EDIT = 50000, MAX_COPY = 500000;
const ARROWS = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

export class SheetGrid {
  // `actions` from the viewer: commit(edits, cx) -> whether it wrote them (edits [{ r, c, value }]), undo(cx), redo(cx).
  constructor(cx, actions) {
    this.handle = cx.focus_handle();
    this.actions = actions;
    this.x = 0; this.y = 0; this.width = 0; this.height = 0;  // the scroll, and the grid's size
    this.thumb = null; this.drag = null;                       // a bar or a selection being dragged
    this.sel = selectCell(1, 0); this.edit = null; this.note = null;
    this.freeze = { rows: 1, cols: 0 };                        // rows and columns held in place (freezeAt)
  }

  value(r, c) { return this.sheet?.rows[r]?.[c] ?? ""; }

  // The grid's two axes for sheetview.js: rows under the letters row, the first g.fr frozen (the header at least);
  // columns right of the row numbers, the first g.fc frozen.
  rowAxis() {
    const g = this.g;
    return { frozen: g.fr, start: i => i * ROW_H, base: LETTERS_H, scroll: this.y, end: g.topH + g.bodyH, at: o => Math.min(g.rows - 1, Math.floor(o / ROW_H)) };
  }
  colAxis() {
    const g = this.g;
    return { frozen: g.fc, start: i => g.starts[i], base: g.numW, scroll: this.x, end: g.numW + g.frozenW + g.view, at: o => columnAt(g.widths, o) };
  }

  // The cell under a point in the grid: r -1 is the letters row, c -1 the row-number column.
  hit(p) {
    if (!this.g || !p) return null;
    return { r: axisAt(p.y, this.rowAxis()), c: axisAt(p.x, this.colAxis()) };
  }

  // Freezes the rows above and the columns left of the active cell (the header row always stays), as Excel's Freeze
  // Panes; unfreeze() goes back to the header row alone.
  freezeAt(cx) { const a = this.sel.active; this.freeze = { rows: Math.max(1, a.r), cols: a.c }; this.x = this.y = 0; cx.notify(); }
  unfreeze(cx) { this.freeze = { rows: 1, cols: 0 }; cx.notify(); }

  scroll(x, y, cx) {
    const g = this.g;
    x = clampX(x, g.total, g.view); y = clampX(y, g.tall, g.bodyH);
    if (x !== this.x || y !== this.y) { this.x = x; this.y = y; cx.notify(); }
  }

  // Scrolls just enough to show a cell (frozen ones always show).
  reveal({ r, c }) {
    const g = this.g;
    if (!g) return;
    if (r >= g.fr) this.y = clampX(scrollToShow((r - g.fr) * ROW_H, ROW_H, this.y, g.bodyH), g.tall, g.bodyH);
    if (c >= g.fc) this.x = clampX(scrollToShow(g.starts[c] - g.frozenW, g.widths[c], this.x, g.view), g.total, g.view);
  }

  mouseDown(e, cx) {
    // Where the sheet sits in the window: a drag's moves arrive at the viewer (pointerMove), in window coordinates.
    if (e.local_position) this.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
    const h = this.hit(e.local_position), g = this.g;
    if (this.edit && h?.r === this.edit.r && h?.c === this.edit.c) return;  // a click in the input moves its caret
    this.handle.focus();
    this.note = null;
    if (this.edit) this.finishEdit(true, cx);
    if (!h) return;
    const shift = e.modifiers?.shift;
    if (h.r < 0 && h.c < 0) this.sel = selectAll(g.rows, g.cols);
    else if (h.r < 0) { const from = shift ? this.sel.anchor.c : h.c; this.sel = selectCols(from, h.c, g.rows); this.drag = { cols: from }; }
    else if (h.c < 0) { const from = shift ? this.sel.anchor.r : h.r; this.sel = selectRows(from, h.r, g.cols); this.drag = { rows: from }; }
    else if (e.click_count >= 2) return this.startEdit(h.r, h.c, null, cx);
    else { this.sel = shift ? extendTo(this.sel, h.r, h.c) : selectCell(h.r, h.c); this.drag = { cells: true }; }
    cx.notify();
  }

  // A bar or selection drag goes on wherever the pointer is in the viewer, not only over the sheet: moves reach an
  // element only while it is hovered, and the bars sit on the sheet's edges, so a pointer drifting a few px past one
  // used to end the drag (the viewer passes its moves here, and its release or the pointer leaving it to pointerUp).
  pointerMove(e, cx) {
    const t = this.thumb, d = this.drag;
    if (t) return t.axis === "x" ? this.scroll(t.from + (e.position.x - t.at) * t.ratio, this.y, cx) : this.scroll(this.x, t.from + (e.position.y - t.at) * t.ratio, cx);
    const h = d && this.origin && this.hit({ x: e.position.x - this.origin.x, y: e.position.y - this.origin.y }), g = this.g;
    if (!h) return;
    const r = Math.max(0, h.r), c = Math.max(0, h.c);
    const next = d.cols != null ? selectCols(d.cols, c, g.rows) : d.rows != null ? selectRows(d.rows, r, g.cols) : extendTo(this.sel, r, c);
    if (JSON.stringify(next) !== JSON.stringify(this.sel)) { this.sel = next; cx.notify(); }
  }
  pointerUp() { this.thumb = null; this.drag = null; }

  move(dr, dc, extend, cx) {
    this.sel = moveBy(this.sel, dr, dc, extend, this.g.rows, this.g.cols);
    this.reveal(extend ? this.sel.focus : this.sel.active);
    cx.notify();
  }

  keyDown(e, cx) {
    const m = e.modifiers ?? {}, cmd = m.platform || m.control, k = e.key;
    if (!this.g) return;
    this.note = null;
    if (this.edit) {
      if (k === "escape") this.finishEdit(false, cx);
      else if (k === "tab") this.commitAndMove(0, m.shift ? -1 : 1, cx);
      else if (k === "enter") this.commitAndMove(m.shift ? -1 : 1, 0, cx);
      else return;
      return cx.stop_propagation();
    }
    const a = this.sel.active;
    if (cmd && k === "c") this.copy(cx);
    else if (cmd && k === "v") this.paste(cx);
    else if (cmd && k === "a") this.sel = selectAll(this.g.rows, this.g.cols);
    else if (cmd && k === "z") m.shift ? this.actions.redo(cx) : this.actions.undo(cx);
    else if (cmd) return;
    else if (ARROWS[k]) this.move(...ARROWS[k], m.shift, cx);
    else if (k === "tab") this.move(0, m.shift ? -1 : 1, false, cx);
    else if (k === "enter" || k === "f2") this.startEdit(a.r, a.c, null, cx);
    else if (k === "delete" || k === "backspace") this.writeRange(rectOf(this.sel), () => "", cx);
    else if (e.key_char && !/[\x00-\x1f\x7f]/.test(e.key_char) && !m.alt) this.startEdit(a.r, a.c, e.key_char, cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // An input over the cell, holding its value (or the typed character that opened it).
  startEdit(r, c, typed, cx) {
    if (this.readonly) { this.note = "Read-only (remote)"; return cx.notify(); }
    const text = typed ?? this.value(r, c), state = InputState.new({ value: text });
    state.set_selected_range({ start: text.length, end: text.length });
    state.on("submit", (_e, cx) => this.commitAndMove(1, 0, cx));
    state.on("blur", (_e, cx) => this.finishEdit(true, cx));
    this.edit = { r, c, state };
    this.sel = selectCell(r, c);
    this.reveal({ r, c });
    state.focus();
    cx.notify();
  }

  commitAndMove(dr, dc, cx) {
    if (!this.edit) return;  // Enter reaches both the key handler and the input's submit: the first one wins
    this.finishEdit(true, cx);
    this.move(dr, dc, false, cx);
  }

  finishEdit(commit, cx) {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    if (commit && e.state.value() !== this.value(e.r, e.c) && !this.actions.commit([{ r: e.r, c: e.c, value: e.state.value() }], cx))
      this.note = "Not written: the sheet is still updating, try again";
    this.handle.focus();
    cx.timer.after(100, () => e.state.release());  // not from inside its own submit or blur handler
    cx.notify();
  }

  // Writes `valueAt(r, c)` into every cell of a range (a clear), within what one call can do.
  writeRange(q, valueAt, cx) {
    if (this.readonly) { this.note = "Read-only (remote)"; return; }
    if (rectCells(q) > MAX_EDIT) { this.note = "Too many cells to change at once here: use Edit"; return; }
    const edits = [];
    for (let r = q.r0; r <= q.r1; r++) for (let c = q.c0; c <= q.c1; c++) {
      const v = valueAt(r, c);
      if (v !== this.value(r, c)) edits.push({ r, c, value: v });
    }
    if (edits.length) this.actions.commit(edits, cx);
  }

  // The range as TSV, read a few ms per tick (a big range takes a moment), then onto the clipboard.
  copy(cx) {
    const q = rectOf(this.sel), n = rectCells(q);
    if (n > MAX_COPY) { this.note = "Too many cells to copy at once"; return; }
    const lines = [], sheet = this.sheet;
    cx.spawn(async cx => {
      for (let r = q.r0; r <= q.r1;) {
        for (const until = Date.now() + 8; r <= q.r1 && Date.now() < until; r++) {
          const row = [];
          for (let c = q.c0; c <= q.c1; c++) row.push(sheet.rows[r]?.[c] ?? "");
          lines.push(toTsv([row]));
        }
        if (r <= q.r1) { this.note = `Copying… ${Math.round((r - q.r0) * 100 / (q.r1 - q.r0 + 1))}%`; cx.notify(); await cx.sleep(1); }
      }
      cx.write_to_clipboard(lines.join("\n"));
      this.note = `Copied ${n.toLocaleString()} cell${n === 1 ? "" : "s"}`;
      cx.notify();
    });
  }

  // TSV from the clipboard, written from the active cell down and right (rows past the last one are left out).
  paste(cx) {
    const text = cx.read_from_clipboard();
    if (!text) return;
    const block = parseCsv(text.replace(/\r?\n$/, ""), "\t"), a = this.sel.active, g = this.g;
    const width = block.reduce((m, r) => Math.max(m, r.length), 0);
    if (!block.length || !width) return;
    const q = { r0: a.r, r1: Math.min(g.rows - 1, a.r + block.length - 1), c0: a.c, c1: a.c + width - 1 };
    this.writeRange(q, (r, c) => block[r - a.r]?.[c - a.c] ?? "", cx);
    this.sel = extendTo(selectCell(q.r0, q.c0), q.r1, q.c1);
  }

  // `sheet` is csv.js sheetOf's; `c` the colors { bg, fg, grid, head, dim, accent, hover }; `readonly` blocks editing.
  render(sheet, c, readonly) {
    this.sheet = sheet; this.readonly = readonly;
    const rows = sheet.rows.length, widths = sheet.widths, starts = columnStarts(widths), H = this.height || 900, W = this.width || 1600;
    const numW = Math.max(40, String(rows).length * 8 + 16);
    // The frozen panes, held to at most half the grid each way so there is always room to scroll.
    let fr = Math.max(1, Math.min(this.freeze.rows, rows)), fc = Math.max(0, Math.min(this.freeze.cols, sheet.cols - 1));
    while (fr > 1 && (fr + 1) * ROW_H > H / 2) fr--;
    while (fc > 0 && starts[fc] > (W - numW) / 2) fc--;
    const topH = LETTERS_H + fr * ROW_H, frozenW = starts[fc], total = starts[widths.length] - frozenW;
    // Each bar takes a BAR-wide gutter of its own when there is something to scroll, so its track never covers cells.
    const tall = (rows - fr) * ROW_H, hasY = tall > H - topH;
    const view = Math.max(0, W - numW - frozenW - (hasY ? BAR : 0)), hasX = total > view;
    const bodyH = Math.max(0, H - topH - (hasX ? BAR : 0));
    this.x = clampX(this.x, total, view); this.y = clampX(this.y, tall, bodyH);
    this.g = { numW, view, total, tall, bodyH, starts, widths, rows, cols: sheet.cols, fr, fc, topH, frozenW };
    this.sel = clampSel(this.sel, rows, sheet.cols);
    if (this.edit && (this.edit.r >= rows || this.edit.c >= sheet.cols)) this.edit = null;
    // The scrolled columns on screen, past the frozen ones (csv.js visibleColumns over the whole row, from their start).
    const { first, end, shift } = visibleColumns(widths, frozenW + this.x, view), cols = [], fixed = [];
    for (let col = first; col < end; col++) cols.push(col);
    for (let col = 0; col < fc; col++) fixed.push(col);
    const r0 = fr + Math.floor(this.y / ROW_H), r1 = Math.min(rows, fr + Math.ceil((this.y + bodyH) / ROW_H));
    // A render is a handful of calls per cell, every frame a scroll moves: cells are kept to the fewest (the vertical
    // grid lines are drawn once per column below, not per cell; the row's width keeps cells from shrinking).
    const cell = (text, w) => div().w(w).px(6).truncate().child(text);
    const shownW = starts[end] - starts[first];
    // One grid line: its number, the frozen columns, then the scrolled ones on screen, cut at the viewport's edges. The
    // line height is a px string: a bare number is a multiplier of the font size.
    const row = (h, label, cellAt) => h_flex().h(h).flex_none().overflow_hidden().line_height(`${h - 1}px`).border_b(1).border_color(c.grid)
      .child(cell(label, numW).flex_none().bg(c.head).text_color(c.dim).text_right())
      .when(fc > 0, el => el.child(h_flex().w(frozenW).flex_none().h_full().overflow_hidden().children(fixed.map(cellAt))))
      .child(div().flex_1().min_w(0).h_full().overflow_hidden().child(h_flex().w(shownW).h_full().relative().left(-shift).children(cols.map(cellAt))));
    const values = (r) => (col) => {
      const v = sheet.rows[r][col] ?? "", el = cell(/[\r\n]/.test(v) ? cellText(v) : v, widths[col]);
      return isNumber(v) ? el.text_right() : el;
    };
    const frozen = [], lines = [];
    for (let r = 1; r < fr; r++) frozen.push(row(ROW_H, String(r + 1), values(r)));
    for (let r = r0; r < r1; r++) lines.push(row(ROW_H, String(r + 1), values(r)));
    const split = numW + frozenW;
    const gridLines = [numW - 1, ...fixed.map(col => numW + starts[col + 1] - 1), ...cols.map(col => split + starts[col + 1] - frozenW - this.x - 1)]
      .filter(x => x < split + view).map(x => div().absolute().top(0).bottom(0).left(x).w(1).bg(c.grid));
    // Lines along the frozen panes' edges past the header row, as a spreadsheet draws them.
    if (fc > 0) gridLines.push(div().absolute().top(0).bottom(0).left(split - 1).w(1).bg(c.dim));
    if (fr > 1) gridLines.push(div().absolute().left(0).right(0).top(topH - 1).h(1).bg(c.dim));
    // Where a cell span shows on screen: a box per pane it reaches (sheetview.js axisSpans), none when off screen.
    const box = (ra, rb, ca, cb) => {
      const ys = axisSpans(ra, rb, this.rowAxis()), xs = axisSpans(ca, cb, this.colAxis());
      return ys.flatMap(([top, bottom]) => xs.map(([left, right]) => ({ top, bottom, left, w: right - left })));
    };
    const q = rectOf(this.sel), a = this.sel.active;
    const marks = [
      ...box(q.r0, q.r1, q.c0, q.c1).map(b => div().absolute().left(b.left).top(b.top).w(b.w).h(b.bottom - b.top).bg(c.accent).opacity(0.18)),
      ...box(a.r, a.r, a.c, a.c).map(b => div().absolute().left(b.left).top(b.top).w(b.w).h(b.bottom - b.top).border_2().border_color(c.accent)),
    ];
    const at = this.edit && box(this.edit.r, this.edit.r, this.edit.c, this.edit.c)[0];
    // A bar: a track in its gutter with the thumb inside (csv.js thumbOf). A press on the thumb drags it; on the track it
    // first jumps so the thumb's middle is under the pointer (scrollAtTrack), then drags on from there.
    const tx = hasX ? thumbOf(view, view, total, this.x) : null, ty = hasY ? thumbOf(bodyH, bodyH, tall, this.y) : null;
    const press = (axis, t, track, seen, whole, onTrack) => (e, cx) => {
      cx.stop_propagation();
      const p = axis === "x" ? e.position.x : e.position.y;
      if (onTrack && e.local_position) {
        const to = scrollAtTrack(axis === "x" ? e.local_position.x : e.local_position.y, track, seen, whole);
        axis === "x" ? this.scroll(to, this.y, cx) : this.scroll(this.x, to, cx);
      }
      this.thumb = { axis, at: p, from: axis === "x" ? this.x : this.y, ratio: t.ratio };
    };
    const bar = (axis) => {
      const x = axis === "x", t = x ? tx : ty, track = x ? view : bodyH, seen = track, whole = x ? total : tall;
      const knob = div().id(`csv-thumb-${axis}`).absolute().rounded(3).bg(c.dim).opacity(0.5)
        .on_mouse_down("left", press(axis, t, track, seen, whole, false));
      return div().id(`csv-track-${axis}`).absolute().bg(c.bg)
        .when(x, el => el.left(split).bottom(0).w(view).h(BAR).child(knob.left(t.at).top(2).w(t.len).h(BAR - 4)))
        .when(!x, el => el.top(topH).right(0).w(BAR).h(bodyH).child(knob.top(t.at).left(2).h(t.len).w(BAR - 4)))
        .on_mouse_down("left", press(axis, t, track, seen, whole, true));
    };
    // The sheet's own toolbar above the grid, outside its key handler (an input there types into itself, not the grid),
    // with ghost buttons as the viewer's.
    const tool = (id, label, onClick) => div().id(id).flex_none().px(7).h(20).flex().items_center().rounded(4).cursor_pointer()
      .text_color(c.fg).hover(s => s.bg(c.hover ?? c.grid)).on_click((_e, cx) => onClick(cx)).child(label);
    const tools = h_flex().h(TOOLS_H).flex_none().px(10).gap(10).items_center().bg(c.head).border_b(1).border_color(c.grid)
      .text_size(11.5).text_color(c.dim)
      .child(div().flex_1().min_w(0).truncate().child(readonly ? "Read-only (remote)" : "Double-click, Enter or type to edit a cell"))
      .child(tool("csv-freeze", `Freeze at ${columnLabel(a.c)}${a.r + 1}`, cx => this.freezeAt(cx)))
      .when(this.freeze.rows > 1 || this.freeze.cols > 0, el => el.child(tool("csv-unfreeze", "Unfreeze", cx => this.unfreeze(cx))));
    return v_flex().flex_1().min_h(0).child(tools).child(div().id("csv-sheet").track_focus(this.handle).relative().flex_1().min_h(0).overflow_hidden().flex().flex_col()
      .bg(c.bg).text_color(c.fg).text_size(12.5)
      .on_size_change((size, cx) => { if (size.width !== this.width || size.height !== this.height) { this.width = size.width; this.height = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        const d = e.delta_lines ? { x: e.delta_lines.x * 40, y: e.delta_lines.y * ROW_H * 3 } : e.delta;
        if (e.modifiers?.shift && !d.x) this.scroll(this.x - d.y, this.y, cx);
        else this.scroll(this.x - d.x, this.y - d.y, cx);
      })
      .on_mouse_down("left", (e, cx) => this.mouseDown(e, cx))
      .on_key_down((e, cx) => this.keyDown(e, cx))
      .child(row(LETTERS_H, "", col => cell(columnLabel(col), widths[col]).bg(c.head).text_color(c.dim).text_center()))
      .child(row(ROW_H, "1", col => values(0)(col).bg(c.head).font_bold()))
      .children(frozen)
      .child(div().flex_1().min_h(0).overflow_hidden().child(v_flex().relative().top(-(this.y % ROW_H)).children(lines)))
      .children(gridLines)
      .children(marks)
      .when(Boolean(at), el => el.child(Input.new(this.edit.state).absolute().left(at.left).top(at.top).w(Math.max(at.w, 120)).h(ROW_H)
        .px(5).bg(c.bg).border_2().border_color(c.accent).text_size(12.5).text_color(c.fg)))
      .when(Boolean(this.note), el => el.child(div().absolute().left(numW + 8).bottom(BAR + 2).px(8).py(2).rounded(4).bg(c.head)
        .text_size(11.5).text_color(c.dim).child(this.note ?? "")))
      .when(Boolean(tx) && this.width > 0, el => el.child(bar("x")))
      .when(Boolean(ty) && this.height > 0, el => el.child(bar("y"))));
  }
}
