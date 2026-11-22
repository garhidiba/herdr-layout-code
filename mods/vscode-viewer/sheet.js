// The viewer's CSV/TSV preview (main.js), drawn like a spreadsheet: a row-number column, a row of column letters and the
// file's first row as a bold header, a cell grid, numbers aligned right. Only what is on screen is built, so a file of
// tens of thousands of rows or hundreds of columns stays quick (the app cuts off a render that runs long): the rows
// scroll in a v_virtual_list; sideways the grid is its own viewport (csv.js visibleColumns), moved by the wheel or
// trackpad (Shift+wheel too) and a bar along the bottom, while the row numbers and the two header rows stay put.
// `s` is csv.js sheetOf's; `c` the colors { bg, fg, grid, head, dim }; `pos` the viewer's { x, width, thumb } (the
// sideways scroll and the grid's width, kept across renders), which the handlers here change.
import { div } from "gpui-kit";
import { h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { columnLabel, isNumber, cellText, visibleColumns, clampX } from "./csv.js";

const ROW_H = 22, LETTERS_H = 20, BAR_H = 6;

export function sheetView(s, c, pos) {
  const numW = Math.max(40, String(s.body.length + 1).length * 8 + 16);
  const total = s.widths.reduce((a, b) => a + b, 0), view = Math.max(0, (pos.width || 1600) - numW);
  pos.x = clampX(pos.x, total, view);
  const { first, end, shift } = visibleColumns(s.widths, pos.x, view), cols = [];
  for (let col = first; col < end; col++) cols.push(col);
  const cell = (text, w) => div().w(w).flex_none().px(6).border_r(1).border_color(c.grid).truncate().child(text);
  // One grid line: its number, then the columns on screen, cut at the viewport's edges. The line height is a px string:
  // a bare number is a multiplier of the font size, which made every line many rows tall.
  const row = (h, label, cellAt) => h_flex().h(h).flex_none().overflow_hidden().line_height(`${h - 1}px`).border_b(1).border_color(c.grid)
    .child(cell(label, numW).bg(c.head).text_color(c.dim).text_right())
    .child(div().flex_1().min_w(0).h_full().overflow_hidden().child(h_flex().h_full().relative().left(-shift).children(cols.map(cellAt))));
  const move = (x, cx) => { x = clampX(x, total, view); if (x !== pos.x) { pos.x = x; cx.notify(); } };
  const thumbW = Math.max(24, view * view / Math.max(total, 1)), over = total - view;
  return div().id("csv-sheet").relative().flex_1().min_h(0).overflow_hidden().flex().flex_col().bg(c.bg).text_color(c.fg).text_size(12.5)
    .on_size_change((size, cx) => { if (size.width !== pos.width) { pos.width = size.width; cx.notify(); } })
    .on_scroll_wheel((e, cx) => {
      const d = e.delta_lines ? { x: e.delta_lines.x * 40, y: e.delta_lines.y * 40 } : e.delta;
      const dx = d.x || (e.modifiers?.shift ? d.y : 0);
      if (dx) move(pos.x - dx, cx);
    })
    .on_mouse_move((e, cx) => { if (pos.thumb) move(pos.thumb.from + (e.position.x - pos.thumb.x) * pos.thumb.ratio, cx); })
    .on_mouse_up("left", () => { pos.thumb = null; })
    .on_hover((on) => { if (!on) pos.thumb = null; })
    .child(row(LETTERS_H, "", col => cell(columnLabel(col), s.widths[col]).bg(c.head).text_color(c.dim).text_center()))
    .child(row(ROW_H, "1", col => cell(cellText(s.header[col]), s.widths[col]).bg(c.head).font_bold()))
    .child(v_virtual_list("csv-rows", s.body.length, ROW_H, (i) => String(i), (range) => {
      const lines = [];
      for (let i = range.start; i < range.end; i++) lines.push(row(ROW_H, String(i + 2), col => {
        const v = s.body[i][col] ?? "";
        return cell(cellText(v), s.widths[col]).when(isNumber(v), el => el.text_right());
      }));
      return lines;
    }).flex_1().min_h(0))
    .child(Scrollbar.vertical("csv-rows").absolute().top(LETTERS_H + ROW_H).bottom(0).left(0).right(0))
    .when(over > 0 && pos.width > 0, el => el.child(div().id("csv-thumb").absolute().bottom(1).h(BAR_H).w(thumbW).rounded(3)
      .left(numW + (view - thumbW) * pos.x / over).bg(c.dim).opacity(0.45)
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); pos.thumb = { x: e.position.x, from: pos.x, ratio: over / Math.max(1, view - thumbW) }; })));
}
