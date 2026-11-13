//! Shift+click in Herdr (clicks.cjs). Herdr keeps a Shift+press in a terminal for its own text selection, so the
//! editor's pane header (vscode-pane's click.js) writes each left press in the editor's pane to
//! $HERDR_APP_HOME/data/vsedit-click/<HC_TERMINAL_ID>.json: { x, y, count, at, kind: "shift" | "plain", area } in window
//! px, `area` the text box ({ x, y, width, height | null }). A Shift press becomes a ⌥+click at its cell. Px to cells: at
//! first from `area` and the terminal's size; then from plain presses, which also reach the editor as SGR at a cell:
//! each one paired with its record calibrates the cell size and origin (a line through two or more cells).

use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const STALE: f64 = 1000.0; // ms: an older record is ignored
const PAIR: f64 = 300.0; // ms between a plain record and the SGR press it is paired with
const KEEP: usize = 8; // pairs kept
const EVERY: Duration = Duration::from_millis(50); // how often the file is checked

/// px = a + b × cell at the cell's center (cells 1-based), on one axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Axis {
    pub a: f64,
    pub b: f64,
}

/// One axis: a line through the pairs ((px, cell)) when they span two cells or more, else `est`'s cell size through
/// their mean offset, else `est`.
pub fn fit_axis(pairs: &[(f64, f64)], est: Axis) -> Axis {
    if pairs.is_empty() {
        return est;
    }
    let n = pairs.len() as f64;
    let mc = pairs.iter().map(|p| p.1).sum::<f64>() / n;
    let mp = pairs.iter().map(|p| p.0).sum::<f64>() / n;
    let vc: f64 = pairs.iter().map(|p| (p.1 - mc).powi(2)).sum();
    let b = if vc > 0.0 { pairs.iter().map(|p| (p.1 - mc) * (p.0 - mp)).sum::<f64>() / vc } else { 0.0 };
    if b > 0.0 {
        Axis { a: mp - b * mc, b }
    } else {
        Axis { a: mp - est.b * mc, b: est.b }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: Option<f64>,
}

/// The guess before calibration: `area` split evenly into cols × rows; with no height, cells twice as tall as wide.
pub fn estimate(area: Area, cols: usize, rows: usize) -> (Axis, Axis) {
    let w = area.width / cols as f64;
    let h = area.height.map_or(w * 2.0, |h| h / rows as f64);
    (Axis { a: area.x - w / 2.0, b: w }, Axis { a: area.y - h / 2.0, b: h })
}

/// The cell under px (x, y), or None outside the cols × rows screen.
pub fn to_cell(x: f64, y: f64, model: (Axis, Axis), cols: usize, rows: usize) -> Option<(i32, i32)> {
    let c = ((x - model.0.a) / model.0.b).round();
    let r = ((y - model.1.a) / model.1.b).round();
    (c >= 1.0 && c <= cols as f64 && r >= 1.0 && r <= rows as f64).then_some((c as i32, r as i32))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub x: f64,
    pub y: f64,
    pub count: u32,
    pub at: f64,
    pub shift: bool,
    pub area: Area,
}

/// A record from the file's JSON; None when malformed or of another kind.
pub fn parse(text: &str) -> Option<Record> {
    let v: Value = serde_json::from_str(text).ok()?;
    let f = |v: &Value, k: &str| v[k].as_f64().filter(|n| n.is_finite());
    let a = &v["area"];
    let height = if a["height"].is_null() { None } else { Some(f(a, "height").filter(|h| *h > 0.0)?) };
    let area = Area { x: f(a, "x")?, y: f(a, "y")?, width: f(a, "width").filter(|w| *w > 0.0)?, height };
    let shift = match v["kind"].as_str()? {
        "shift" => true,
        "plain" => false,
        _ => return None,
    };
    Some(Record { x: f(&v, "x")?, y: f(&v, "y")?, count: v["count"].as_u64().unwrap_or(1) as u32, at: f(&v, "at")?, shift, area })
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Calibration state: the pairs so far, the last unpaired press and plain record.
#[derive(Default)]
pub struct Clicks {
    pairs: Vec<(f64, f64, i32, i32)>, // px, py, cell x, cell y
    press: Option<(i32, i32, f64)>,
    plain: Option<Record>,
    key: Option<(u64, u64, u64, Option<u64>, usize, usize)>,
    seen: f64,
    est: Option<(Axis, Axis)>,
}

impl Clicks {
    /// A plain left press the editor got as SGR at cell (x, y), at `at` ms.
    pub fn pressed(&mut self, x: i32, y: i32, at: f64) {
        self.press = Some((x, y, at));
        self.pair();
    }

    /// A record read from the file: (x, y, count 1 or 2) for a fresh Shift press on the screen, else None. A record is
    /// used once; a new pane box or terminal size starts the calibration over.
    pub fn record(&mut self, rec: Record, cols: usize, rows: usize, now: f64) -> Option<(i32, i32, u32)> {
        if cols == 0 || rows == 0 || rec.at <= self.seen || now - rec.at > STALE {
            return None;
        }
        self.seen = rec.at;
        let a = rec.area;
        let key = Some((a.x.to_bits(), a.y.to_bits(), a.width.to_bits(), a.height.map(f64::to_bits), cols, rows));
        if key != self.key {
            self.key = key;
            self.pairs.clear();
        }
        self.est = Some(estimate(a, cols, rows));
        if !rec.shift {
            self.plain = Some(rec);
            self.pair();
            return None;
        }
        let (c, r) = to_cell(rec.x, rec.y, self.model()?, cols, rows)?;
        Some((c, r, if rec.count >= 2 { 2 } else { 1 }))
    }

    fn pair(&mut self) {
        let (Some((x, y, at)), Some(plain)) = (self.press, self.plain.as_ref()) else { return };
        if (at - plain.at).abs() > PAIR {
            return;
        }
        self.pairs.push((plain.x, plain.y, x, y));
        if self.pairs.len() > KEEP {
            self.pairs.remove(0);
        }
        self.press = None;
        self.plain = None;
    }

    fn model(&self) -> Option<(Axis, Axis)> {
        let (ex, ey) = self.est?;
        let xs: Vec<_> = self.pairs.iter().map(|p| (p.0, p.2 as f64)).collect();
        let ys: Vec<_> = self.pairs.iter().map(|p| (p.1, p.3 as f64)).collect();
        Some((fit_axis(&xs, ex), fit_axis(&ys, ey)))
    }
}

/// The signal file of this editor's terminal, checked every 50 ms (by its modification time and size).
pub struct Signal {
    path: PathBuf,
    seen: Option<(SystemTime, u64)>,
    pub next: Instant,
    pub clicks: Clicks,
}

impl Signal {
    /// None outside a Herdr terminal ($HC_TERMINAL_ID unset).
    pub fn new() -> Option<Signal> {
        let id = std::env::var("HC_TERMINAL_ID").ok().filter(|s| !s.is_empty())?;
        let path = crate::settings::herdr_home().join("data/vsedit-click").join(format!("{id}.json"));
        let seen = Self::stamp(&path);
        Some(Signal { path, seen, next: Instant::now() + EVERY, clicks: Clicks::default() })
    }

    fn stamp(path: &PathBuf) -> Option<(SystemTime, u64)> {
        let m = std::fs::metadata(path).ok()?;
        Some((m.modified().ok()?, m.len()))
    }

    /// When due: a Shift press to apply (x, y, count), if the file changed to a fresh one.
    pub fn poll(&mut self, cols: usize, rows: usize) -> Option<(i32, i32, u32)> {
        if Instant::now() < self.next {
            return None;
        }
        self.next = Instant::now() + EVERY;
        let stamp = Self::stamp(&self.path);
        if stamp.is_none() || stamp == self.seen {
            return None;
        }
        self.seen = stamp;
        let rec = parse(&std::fs::read_to_string(&self.path).ok()?)?; // caught mid-write: read again when it changes
        self.clicks.record(rec, cols, rows, now_ms())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 100 × 30 terminal whose cells are 9 × 18 px from (100, 200); the header's box says 8 px wide and no height.
    fn real(c: f64, r: f64) -> (f64, f64) {
        (100.0 + (c - 0.5) * 9.0, 200.0 + (r - 0.5) * 18.0)
    }
    const BOX: Area = Area { x: 100.0, y: 200.0, width: 800.0, height: None };
    fn rec(shift: bool, at: f64, (x, y): (f64, f64)) -> Record {
        Record { x, y, count: 1, at, shift, area: BOX }
    }

    #[test]
    fn before_calibration_the_box_split_by_the_terminal_size_places_the_cell() {
        let m = estimate(Area { height: Some(480.0), ..BOX }, 100, 30);
        assert_eq!(to_cell(100.0 + 7.5 * 8.0, 200.0 + 1.5 * 16.0, m, 100, 30), Some((8, 2)));
        assert_eq!(to_cell(100.0 + 7.5 * 8.0, 200.0 + 1.5 * 16.0, estimate(BOX, 100, 30), 100, 30), Some((8, 2)), "no height: twice as tall as wide");
        assert_eq!(to_cell(90.0, 300.0, m, 100, 30), None, "left of the screen");
        assert_eq!(to_cell(300.0, 200.0 + 30.0 * 16.0 + 1.0, m, 100, 30), None, "below the screen");
    }

    #[test]
    fn one_axis_a_line_through_two_cells_one_cell_keeps_the_size_none_keeps_the_estimate() {
        let est = Axis { a: 96.0, b: 8.0 };
        assert_eq!(fit_axis(&[], est), est);
        assert_eq!(fit_axis(&[(100.0 + 8.5 * 9.0, 9.0)], est), Axis { a: 100.0 + 8.5 * 9.0 - 72.0, b: 8.0 });
        let two = fit_axis(&[(100.0 + 8.5 * 9.0, 9.0), (100.0 + 39.5 * 9.0, 40.0)], est);
        assert!((two.b - 9.0).abs() < 1e-9 && (two.a - 95.5).abs() < 1e-9, "{two:?}");
    }

    #[test]
    fn plain_presses_paired_with_their_sgr_cells_calibrate_a_wrong_box() {
        let (mut c, now) = (Clicks::default(), 10000.0);
        assert_eq!(c.record(rec(true, now, real(50.0, 4.0)), 100, 30, now), Some((56, 4, 1)), "the box alone is 6 cells off");
        c.pressed(9, 3, now + 1.0);
        c.record(rec(false, now + 2.0, real(9.0, 3.0)), 100, 30, now + 2.0);
        c.record(rec(false, now + 3.0, real(40.0, 10.0)), 100, 30, now + 3.0); // the record first, then its press
        c.pressed(40, 10, now + 4.0);
        assert_eq!(c.record(rec(true, now + 5.0, real(50.0, 4.0)), 100, 30, now + 5.0), Some((50, 4, 1)));
    }

    #[test]
    fn a_plain_record_far_from_any_press_calibrates_nothing_and_a_new_size_starts_over() {
        let (mut c, now) = (Clicks::default(), 10000.0);
        c.pressed(9, 3, now);
        c.record(rec(false, now + 400.0, real(9.0, 3.0)), 100, 30, now + 400.0);
        c.record(rec(false, now + 401.0, real(40.0, 10.0)), 100, 30, now + 401.0);
        c.pressed(40, 10, now + 402.0);
        assert_eq!(c.pairs.len(), 1);
        c.record(rec(false, now + 403.0, real(1.0, 1.0)), 90, 30, now + 403.0);
        assert!(c.pairs.is_empty());
    }

    #[test]
    fn stale_repeated_and_malformed_records_are_ignored_and_a_double_press_keeps_count_2() {
        let (mut c, now) = (Clicks::default(), 10000.0);
        assert_eq!(c.record(rec(true, now - 1500.0, real(5.0, 5.0)), 100, 30, now), None, "older than 1 s");
        assert!(c.record(rec(true, now, real(5.0, 5.0)), 100, 30, now).is_some());
        assert_eq!(c.record(rec(true, now, real(5.0, 5.0)), 100, 30, now), None, "already used");
        assert_eq!(c.record(Record { count: 2, ..rec(true, now + 2.0, real(5.0, 5.0)) }, 100, 30, now + 2.0).map(|r| r.2), Some(2));
        assert_eq!(parse(r#"{"x": 1, "y": 1, "at": 5, "kind": "shift"}"#), None, "no box");
        assert_eq!(parse(r#"{"x": 1, "y": 1, "at": 5, "kind": "drag", "area": {"x": 0, "y": 0, "width": 9, "height": null}}"#), None);
        assert_eq!(parse("{\"x\": 1, \"y\""), None, "caught mid-write");
        assert_eq!(
            parse(r#"{"x": 1, "y": 2, "count": 2, "at": 5, "kind": "shift", "area": {"x": 3, "y": 4, "width": 9, "height": null}}"#),
            Some(Record { x: 1.0, y: 2.0, count: 2, at: 5.0, shift: true, area: Area { x: 3.0, y: 4.0, width: 9.0, height: None } })
        );
    }
}
