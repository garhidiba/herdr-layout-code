//! VS Code-style scrollbars (scrollbar.cjs), shared by the editor and the hex viewer: thumb size/position in eighths
//! of a cell (block elements), hit-testing, click-to-jump and dragging, hover (mouse mode 1003 while a bar shows),
//! overview-ruler marks on the vertical bar.

use crate::keys::Mouse;
use crate::paint::{Painter, Palette};

const E: i64 = 8;
const MARK: &str = "━";
const FULL: &str = "█";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Thumb {
    pub start: i64,
    pub size: i64,
}

/// The thumb of a bar `length` cells long showing `visible` of `total` scrolled to `pos`; None when all fits.
pub fn thumb_of(length: i64, visible: i64, total: i64, pos: i64) -> Option<Thumb> {
    if length < 1 || total <= visible {
        return None;
    }
    let track = length * E;
    let size = track.min(E.max(((track * visible) as f64 / total as f64).round() as i64));
    let max = total - visible;
    Some(Thumb { start: (((track - size) * pos.clamp(0, max)) as f64 / max as f64).round() as i64, size })
}

/// The scroll position that puts a thumb of `size` eighths at `start` eighths.
pub fn pos_of(length: i64, visible: i64, total: i64, start: f64, size: i64) -> i64 {
    let free = length * E - size;
    let max = total - visible;
    if free <= 0 || max <= 0 {
        return 0;
    }
    ((start / free as f64).clamp(0.0, 1.0) * max as f64).round() as i64
}

fn on_thumb(th: Option<Thumb>, k: i64) -> bool {
    th.is_some_and(|t| k * E < t.start + t.size && k * E + E > t.start)
}

/// Each cell's glyph and whether its foreground / background is the thumb.
fn cells(length: i64, th: Option<Thumb>, vertical: bool) -> Vec<(char, bool, bool)> {
    (0..length)
        .map(|k| {
            let (ts, te) = th.map_or((0, 0), |t| (t.start, t.start + t.size));
            let a = (k * E).max(ts);
            let n = (k * E + E).min(te) - a;
            let lower = |n: i64| char::from_u32(0x2580 + n as u32).unwrap();
            let left = |n: i64| char::from_u32(0x2590 - n as u32).unwrap();
            if n <= 0 || th.is_none() {
                (' ', false, false)
            } else if n >= E {
                (' ', true, true)
            } else if a > k * E {
                if vertical {
                    (lower(n), true, false)
                } else {
                    (left(E - n), false, true)
                }
            } else if vertical {
                (lower(E - n), false, true)
            } else {
                (left(n), true, false)
            }
        })
        .collect()
}

/// The cell of an overview-ruler mark for `line` of `lines`.
pub fn mark_cell(line: usize, lines: usize, length: usize) -> usize {
    ((line * length) / lines.max(1)).min(length.saturating_sub(1))
}

pub enum BarMouse {
    /// Not the bar's event.
    No,
    /// The bar's, without scrolling.
    Took,
    /// Scroll to this position.
    To(i64),
}

#[derive(Default)]
pub struct Bar {
    pub vertical: bool,
    pub shown: bool,
    th: Option<Thumb>,
    /// While dragging: where in the thumb (eighths) the pointer holds it.
    pub drag: Option<f64>,
    hover: bool,
    pub row: i32,
    pub col: i32,
    pub length: i64,
    visible: i64,
    total: i64,
}

impl Bar {
    pub fn new(vertical: bool) -> Bar {
        Bar { vertical, ..Default::default() }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn layout(&mut self, shown: bool, row: i32, col: i32, length: i64, visible: i64, total: i64, pos: i64) -> bool {
        (self.shown, self.row, self.col, self.length, self.visible, self.total) = (shown, row, col, length, visible, total);
        self.th = if shown { thumb_of(length, visible, total, pos) } else { None };
        if !shown {
            self.drag = None;
        }
        shown
    }
    fn along(&self, m: &Mouse) -> i64 {
        (if self.vertical { m.y - self.row } else { m.x - self.col }) as i64
    }
    pub fn contains(&self, m: &Mouse) -> bool {
        let k = self.along(m);
        self.shown && (if self.vertical { m.x == self.col } else { m.y == self.row }) && k >= 0 && k < self.length
    }
    fn pos_at(&self, k: i64) -> i64 {
        let th = self.th.unwrap_or(Thumb { start: 0, size: E });
        pos_of(self.length, self.visible, self.total, (k * E) as f64 + E as f64 / 2.0 - self.drag.unwrap_or(0.0), th.size)
    }
    /// A press on the thumb starts a drag; on the track it jumps so the thumb centers on the pointer and keeps
    /// dragging. Drags follow the pointer anywhere until release. Wheels are never the bar's.
    pub fn mouse(&mut self, m: &Mouse) -> BarMouse {
        if self.drag.is_some() {
            if m.release {
                self.drag = None;
                return BarMouse::Took;
            }
            return if m.motion { BarMouse::To(self.pos_at(self.along(m))) } else { BarMouse::Took };
        }
        if m.wheel() || !self.contains(m) {
            return BarMouse::No;
        }
        let Some(th) = self.th.filter(|_| m.button == 0 && !m.motion && !m.release) else { return BarMouse::Took };
        let k = self.along(m);
        if on_thumb(Some(th), k) {
            self.drag = Some((k * E) as f64 + E as f64 / 2.0 - th.start as f64);
            return BarMouse::Took;
        }
        self.drag = Some(th.size as f64 / 2.0);
        BarMouse::To(self.pos_at(k))
    }
    /// A buttonless motion: true when the thumb's highlight changed (it also ends a drag whose release never came).
    pub fn hovering(&mut self, m: &Mouse) -> bool {
        let h = self.contains(m) && on_thumb(self.th, self.along(m));
        let changed = h != self.hover || self.drag.is_some();
        self.hover = h;
        self.drag = None;
        changed
    }
    pub fn paint(&self, p: &mut Painter, c: &Palette, marks: Option<&[Option<String>]>) {
        if !self.shown {
            return;
        }
        let thumb = if self.drag.is_some() { &c.slider_active } else if self.hover { &c.slider_hover } else { &c.slider };
        let role = |t: bool| if t { thumb.as_str() } else { c.bg.as_str() };
        for (k, (ch, fg, bg)) in cells(self.length, self.th, self.vertical).into_iter().enumerate() {
            if self.vertical || k == 0 {
                p.move_to(self.row + if self.vertical { k as i32 } else { 0 }, self.col + if self.vertical { 0 } else { k as i32 });
            }
            match marks.and_then(|m| m.get(k)).and_then(Option::as_deref) {
                // problems fill their cell, so an error stands out as a red block
                Some(mark) if c.ruler_diag[1..].iter().any(|d| d == mark) => p.text(FULL, mark, role(bg)),
                Some(mark) => p.text(MARK, mark, role(bg)),
                None => p.text(&ch.to_string(), role(fg), role(bg)),
            }
        }
    }
    /// The bar alone, keeping the terminal cursor (hover changes, without a whole frame).
    pub fn repaint(&self, c: &Palette, marks: Option<&[Option<String>]>) -> String {
        let mut p = Painter::default();
        self.paint(&mut p, c, marks);
        format!("\x1b7{}\x1b8", p.out)
    }
}

/// Any-motion reports (1003) only while a bar shows, drag-only (1002) otherwise; "" when unchanged.
pub fn hover_mode(state: &mut Option<bool>, on: bool) -> &'static str {
    if *state == Some(on) || (state.is_none() && !on) {
        *state = Some(on);
        return "";
    }
    *state = Some(on);
    if on {
        "\x1b[?1003h"
    } else {
        "\x1b[?1003l\x1b[?1002h"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_thumb_is_proportional_and_at_least_one_cell() {
        assert_eq!(thumb_of(10, 10, 10, 0), None);
        assert_eq!(thumb_of(10, 10, 100, 0), Some(Thumb { start: 0, size: 8 }));
        assert_eq!(thumb_of(10, 10, 100, 90), Some(Thumb { start: 72, size: 8 }));
        assert_eq!(thumb_of(10, 50, 100, 25), Some(Thumb { start: 20, size: 40 }));
        assert_eq!(pos_of(10, 50, 100, 40.0, 40), 50);
    }

    #[test]
    fn partial_cells_use_block_elements() {
        let c = cells(2, Some(Thumb { start: 4, size: 8 }), true);
        assert_eq!(c[0], ('▄', true, false));
        assert_eq!(c[1], ('▄', false, true));
        assert_eq!(mark_cell(499, 500, 28), 27);
    }

    #[test]
    fn problem_marks_fill_their_cell_and_other_marks_are_a_line() {
        let c = Palette::of(&serde_json::Value::Null);
        let mut b = Bar::new(true);
        b.layout(true, 2, 100, 3, 3, 4, 0);
        let mut p = Painter::default();
        b.paint(&mut p, &c, Some(&[Some(c.ruler_diag[1].clone()), Some(c.ruler_cursor.clone()), Some(c.ruler_diag[2].clone())]));
        let cells: Vec<&str> = p.out.split("\x1b[").filter_map(|s| s.split('m').nth(1)).filter(|s| !s.is_empty()).collect();
        assert_eq!(cells, ["█", "━", "█"]);
    }

    #[test]
    fn a_track_press_jumps_and_keeps_dragging() {
        let mut b = Bar::new(true);
        b.layout(true, 2, 100, 28, 28, 527, 0);
        let m = |y, motion, release| Mouse { x: 100, y, motion, release, ..Default::default() };
        assert!(matches!(b.mouse(&m(29, false, false)), BarMouse::To(499)));
        assert!(b.drag.is_some());
        assert!(matches!(b.mouse(&m(29, false, true)), BarMouse::Took));
        assert!(matches!(b.mouse(&Mouse { x: 5, y: 5, ..Default::default() }), BarMouse::No));
    }
}
