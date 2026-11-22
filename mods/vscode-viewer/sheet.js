// The viewer's CSV/TSV preview (main.js), drawn like a spreadsheet: a row-number column, a row of column letters and the
// file's first row as a bold header, a cell grid, numbers aligned right. Only what is on screen is built, so a file of
// tens of thousands of rows or hundreds of columns stays quick (the app cuts off a render that runs long).
// The grid is its own viewport on both axes (csv.js visibleColumns, clampX): one wheel handler takes the wheel and
// trackpad, Shift+wheel sideways, and bars along the right and bottom edges drag; the row numbers and the two header
// rows stay put. No scroll container inside: a GPUI scroll area that moves stops the event, so a list scrolling down
// would swallow a diagonal swipe's sideways part.
// `s` is csv.js sheetOf's; `c` the colors { bg, fg, grid, head, dim }; `pos` the viewer's { x, y, width, height, thumb }
// (the scroll and the grid's size, kept across renders), which the handlers here change.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { columnLabel, isNumber, cellText, visibleColumns, clampX } from "./csv.js";

const ROW_H = 22, LETTERS_H = 20, HEAD_H = LETTERS_H + ROW_H, BAR = 12;

export function sheetView(s, c, pos) {
  const numW = Math.max(40, String(s.body.length + 1).length * 8 + 16);
  const total = s.widths.reduce((a, b) => a + b, 0), view = Math.max(0, (pos.width || 1600) - numW);
  const tall = s.body.length * ROW_H, bodyH = Math.max(0, (pos.height || 900) - HEAD_H);
  pos.x = clampX(pos.x, total, view); pos.y = clampX(pos.y, tall, bodyH);
  const { first, end, shift } = visibleColumns(s.widths, pos.x, view), cols = [];
  for (let col = first; col < end; col++) cols.push(col);
  const r0 = Math.floor(pos.y / ROW_H), r1 = Math.min(s.body.length, Math.ceil((pos.y + bodyH) / ROW_H));
  const cell = (text, w) => div().w(w).flex_none().px(6).border_r(1).border_color(c.grid).truncate().child(text);
  // One grid line: its number, then the columns on screen, cut at the viewport's edges. The line height is a px string:
  // a bare number is a multiplier of the font size.
  const row = (h, label, cellAt) => h_flex().h(h).flex_none().overflow_hidden().line_height(`${h - 1}px`).border_b(1).border_color(c.grid)
    .child(cell(label, numW).bg(c.head).text_color(c.dim).text_right())
    .child(div().flex_1().min_w(0).h_full().overflow_hidden().child(h_flex().h_full().relative().left(-shift).children(cols.map(cellAt))));
  const lines = [];
  for (let i = r0; i < r1; i++) lines.push(row(ROW_H, String(i + 2), col => {
    const v = s.body[i][col] ?? "";
    return cell(cellText(v), s.widths[col]).when(isNumber(v), el => el.text_right());
  }));
  const scroll = (x, y, cx) => {
    x = clampX(x, total, view); y = clampX(y, tall, bodyH);
    if (x !== pos.x || y !== pos.y) { pos.x = x; pos.y = y; cx.notify(); }
  };
  // A bar's thumb: its length and offset along a track `track` long, for a viewport `seen` of `whole`, scrolled `at`.
  const thumb = (track, seen, whole, at) => { const len = Math.max(24, track * seen / whole); return { len, at: (track - len) * at / (whole - seen) }; };
  const grab = (axis, ratio) => (e, cx) => { cx.stop_propagation(); pos.thumb = { axis, at: axis === "x" ? e.position.x : e.position.y, from: axis === "x" ? pos.x : pos.y, ratio }; };
  const tx = total > view ? thumb(view, view, total, pos.x) : null, ty = tall > bodyH ? thumb(bodyH, bodyH, tall, pos.y) : null;
  return div().id("csv-sheet").relative().flex_1().min_h(0).overflow_hidden().flex().flex_col().bg(c.bg).text_color(c.fg).text_size(12.5)
    .on_size_change((size, cx) => { if (size.width !== pos.width || size.height !== pos.height) { pos.width = size.width; pos.height = size.height; cx.notify(); } })
    .on_scroll_wheel((e, cx) => {
      const d = e.delta_lines ? { x: e.delta_lines.x * 40, y: e.delta_lines.y * ROW_H * 3 } : e.delta;
      if (e.modifiers?.shift && !d.x) scroll(pos.x - d.y, pos.y, cx);
      else scroll(pos.x - d.x, pos.y - d.y, cx);
    })
    .on_mouse_move((e, cx) => {
      const t = pos.thumb;
      if (t) t.axis === "x" ? scroll(t.from + (e.position.x - t.at) * t.ratio, pos.y, cx) : scroll(pos.x, t.from + (e.position.y - t.at) * t.ratio, cx);
    })
    .on_mouse_up("left", () => { pos.thumb = null; })
    .on_hover((on) => { if (!on) pos.thumb = null; })
    .child(row(LETTERS_H, "", col => cell(columnLabel(col), s.widths[col]).bg(c.head).text_color(c.dim).text_center()))
    .child(row(ROW_H, "1", col => cell(cellText(s.header[col]), s.widths[col]).bg(c.head).font_bold()))
    .child(div().flex_1().min_h(0).overflow_hidden().child(v_flex().relative().top(-(pos.y % ROW_H)).children(lines)))
    .when(Boolean(tx) && pos.width > 0, el => el.child(div().id("csv-thumb-x").absolute().bottom(2).h(BAR - 4).w(tx.len).rounded(3)
      .left(numW + tx.at).bg(c.dim).opacity(0.5).on_mouse_down("left", grab("x", (total - view) / Math.max(1, view - tx.len)))))
    .when(Boolean(ty) && pos.height > 0, el => el.child(div().id("csv-thumb-y").absolute().right(2).w(BAR - 4).h(ty.len).rounded(3)
      .top(HEAD_H + ty.at).bg(c.dim).opacity(0.5).on_mouse_down("left", grab("y", (tall - bodyH) / Math.max(1, bodyH - ty.len)))));
}
