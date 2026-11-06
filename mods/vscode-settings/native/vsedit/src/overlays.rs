//! Overlays drawn over the text (overlays.cjs): the modal dialog, the input box and the quick pick. They hold no
//! editor state: keys and clicks come back as an `Outcome` carrying the caller's action.

use crate::keys::{Ev, Mouse};
use crate::paint::{fit, Painter, Palette};
use crate::width::{char_width, text_width};

const WHITE: &str = "#ffffff";

pub enum Outcome<T> {
    /// Handled; nothing for the caller to do.
    Stay,
    /// Close the overlay.
    Close,
    /// Close it, then run this.
    Run(T),
}

/// Screen and colors an overlay draws with.
pub struct Area<'a> {
    pub c: &'a Palette,
    pub rows: i32,
    pub cols: i32,
}

fn inside(m: &Mouse, x: i32, y: i32, w: i32, h: i32) -> bool {
    m.x >= x && m.x < x + w && m.y >= y && m.y < y + h
}

fn tw(s: &str) -> i32 {
    text_width(s, 8) as i32
}

/// A box border around (x, y, w, h); the inside is left to the caller.
pub fn frame(p: &mut Painter, a: &Area, x: i32, y: i32, w: i32, h: i32, color: &str) {
    let inner = "─".repeat((w - 2).max(0) as usize);
    p.move_to(y, x);
    p.text(&format!("┌{inner}┐"), color, &a.c.widget);
    for r in 1..h - 1 {
        p.move_to(y + r, x);
        p.text("│", color, &a.c.widget);
        p.move_to(y + r, x + w - 1);
        p.text("│", color, &a.c.widget);
    }
    p.move_to(y + h - 1, x);
    p.text(&format!("└{inner}┘"), color, &a.c.widget);
}

// ---------- modal dialog ----------

pub struct Button<T> {
    pub label: String,
    pub key: char,
    pub act: T,
    pub cancel: bool,
}

pub fn button<T>(label: &str, key: char, act: T) -> Button<T> {
    Button { label: label.into(), key, act, cancel: false }
}

/// Enter = the focused button (the first), Esc = the cancel button, or just closes when there is none.
pub struct Dialog<T> {
    pub title: String,
    pub detail: Option<String>,
    pub buttons: Vec<Button<T>>,
    pub focus: usize,
    rects: Vec<(i32, i32, i32, usize)>,
}

impl<T: Clone> Dialog<T> {
    pub fn new(title: &str, detail: Option<&str>, buttons: Vec<Button<T>>) -> Dialog<T> {
        Dialog { title: title.into(), detail: detail.map(str::to_string), buttons, focus: 0, rects: vec![] }
    }

    pub fn render(&mut self, p: &mut Painter, a: &Area) {
        let c = a.c;
        let btn_w: i32 = self.buttons.iter().map(|b| tw(&b.label) + 4).sum::<i32>() + 2;
        let w = a.cols.min(44.max(tw(&self.title) + 6).max(self.detail.as_deref().map_or(0, tw) + 6).max(btn_w + 2));
        let h = if self.detail.is_some() { 7 } else { 6 };
        let x = ((a.cols - w) / 2 + 1).max(1);
        let y = ((a.rows - h) / 2).max(1);
        frame(p, a, x, y, w, h, &c.accent);
        let line = |p: &mut Painter, r: i32, text: &str, fg: &str, style: u32| {
            p.move_to(y + r, x + 1);
            p.styled(&fit(text, (w - 2).max(0) as usize), fg, &c.widget, style, None);
        };
        line(p, 1, "", &c.fg, 0);
        line(p, 2, &format!("  {}", self.title), &c.fg, 2);
        if let Some(d) = &self.detail {
            line(p, 3, &format!("  {d}"), &c.bar_fg, 0);
        }
        line(p, h - 3, "", &c.fg, 0);
        p.move_to(y + h - 2, x + 1);
        let pad = (w - 2 - btn_w).max(0);
        let mut col = x + 1 + pad;
        p.text(&" ".repeat(pad as usize), &c.fg, &c.widget);
        self.rects.clear();
        for (i, b) in self.buttons.iter().enumerate() {
            let label = format!(" {} ", b.label);
            let on = i == self.focus;
            p.text("  ", &c.fg, &c.widget);
            col += 2;
            p.text(&label, if on { WHITE } else { &c.fg }, if on { &c.button } else { &c.input });
            self.rects.push((col, y + h - 2, tw(&label), i));
            col += tw(&label);
        }
        p.text(&fit("", (x + w - 1 - col).max(0) as usize), &c.fg, &c.widget);
    }

    fn press(&self, i: usize) -> Outcome<T> {
        self.buttons.get(i).map_or(Outcome::Stay, |b| Outcome::Run(b.act.clone()))
    }

    pub fn event(&mut self, ev: &Ev) -> Outcome<T> {
        let n = self.buttons.len();
        match ev {
            Ev::Text(t) => {
                let t = t.to_lowercase();
                match self.buttons.iter().position(|b| t == b.key.to_string()) {
                    Some(i) => self.press(i),
                    None => Outcome::Stay,
                }
            }
            Ev::Key(k) => match k.name.as_str() {
                "escape" => match self.buttons.iter().position(|b| b.cancel) {
                    Some(i) => self.press(i),
                    None => Outcome::Close,
                },
                "enter" | "space" => self.press(self.focus),
                "right" => {
                    self.focus = (self.focus + 1) % n;
                    Outcome::Stay
                }
                "tab" if !k.shift => {
                    self.focus = (self.focus + 1) % n;
                    Outcome::Stay
                }
                "left" | "tab" => {
                    self.focus = (self.focus + n - 1) % n;
                    Outcome::Stay
                }
                name => match self.buttons.iter().position(|b| name == b.key.to_string() && !k.ctrl && !k.cmd) {
                    Some(i) => self.press(i),
                    None => Outcome::Stay,
                },
            },
            Ev::Mouse(m) if m.press() => match self.rects.iter().find(|r| inside(m, r.0, r.1, r.2, 1)) {
                Some(r) => self.press(r.3),
                None => Outcome::Stay,
            },
            _ => Outcome::Stay,
        }
    }
}

// ---------- input box ----------

/// A one-line prompt on the first text row (go to line, the auto save delay).
pub struct Input<T> {
    pub label: String,
    pub text: String,
    pub select_all: bool,
    pub accept: T,
    pub cursor: (i32, i32),
}

pub enum InputOutcome<T> {
    Stay,
    Cancel,
    Accept(T, String),
}

impl<T: Clone> Input<T> {
    pub fn new(label: &str, text: &str, accept: T) -> Input<T> {
        Input { label: label.into(), text: text.into(), select_all: !text.is_empty(), accept, cursor: (2, 1) }
    }

    pub fn render(&mut self, p: &mut Painter, a: &Area) {
        let label = format!(" {} ", self.label);
        p.move_to(2, 1);
        p.text(&fit(&format!("{label}{}", self.text), a.cols as usize), &a.c.fg, &a.c.widget);
        self.cursor = (2, a.cols.min(tw(&label) + tw(&self.text) + 1));
    }

    fn set(&mut self, v: String) {
        self.text = v;
        self.select_all = false;
    }

    pub fn event(&mut self, ev: &Ev) -> InputOutcome<T> {
        match ev {
            Ev::Text(t) | Ev::Paste(t) => {
                let first = t.split(['\r', '\n']).next().unwrap_or("");
                let base = if self.select_all { String::new() } else { self.text.clone() };
                self.set(base + first);
            }
            Ev::Key(k) => match k.name.as_str() {
                "escape" => return InputOutcome::Cancel,
                "enter" => return InputOutcome::Accept(self.accept.clone(), self.text.clone()),
                "backspace" => {
                    let mut t = if self.select_all { String::new() } else { self.text.clone() };
                    t.pop();
                    self.set(t);
                }
                "left" | "right" | "home" | "end" => self.select_all = false,
                _ => {}
            },
            _ => {}
        }
        InputOutcome::Stay
    }
}

// ---------- quick pick ----------

pub struct Item<T> {
    pub label: String,
    pub detail: String,
    pub hits: Vec<usize>,
    pub act: T,
}

/// A quick pick of fixed choices, filtered as typed (fuzzy), starting on `index`.
pub struct Picker<T> {
    pub text: String,
    pub placeholder: String,
    choices: Vec<(String, String, T)>,
    pub items: Vec<Item<T>>,
    pub index: usize,
    top: usize,
    pub cursor: (i32, i32),
}

impl<T: Clone> Picker<T> {
    pub fn new(placeholder: &str, choices: Vec<(String, String, T)>, index: usize) -> Picker<T> {
        let mut p = Picker { text: String::new(), placeholder: placeholder.into(), choices, items: vec![], index: 0, top: 0, cursor: (2, 1) };
        p.refresh();
        p.index = index.min(p.items.len().saturating_sub(1));
        p
    }

    fn refresh(&mut self) {
        let labels: Vec<&str> = self.choices.iter().map(|c| c.0.as_str()).collect();
        self.items = filter(&labels, &self.text)
            .into_iter()
            .map(|(i, hits)| Item { label: self.choices[i].0.clone(), detail: self.choices[i].1.clone(), hits, act: self.choices[i].2.clone() })
            .collect();
        self.index = 0;
        self.top = 0;
    }

    fn geometry(&self, a: &Area) -> (i32, i32, i32, usize) {
        let w = (a.cols - 2).min(80);
        let size = 1.max(12.min(self.items.len().max(1) as i32).min(a.rows - 6)) as usize;
        ((a.cols - w) / 2 + 1, 2, w, size)
    }

    pub fn render(&mut self, p: &mut Painter, a: &Area) {
        let c = a.c;
        let (x, y, w, size) = self.geometry(a);
        let inner = w - 2;
        frame(p, a, x, y, w, size as i32 + 3, &c.border);
        p.move_to(y + 1, x + 1);
        p.text(" ", &c.fg, &c.input);
        let shown = if self.text.is_empty() { &self.placeholder } else { &self.text };
        p.text(&fit(shown, (inner - 2).max(0) as usize), if self.text.is_empty() { &c.line_number } else { &c.fg }, &c.input);
        p.text(" ", &c.fg, &c.input);
        self.cursor = (y + 1, x + 2 + (inner - 3).min(tw(&self.text)));
        if self.index < self.top {
            self.top = self.index;
        } else if self.index >= self.top + size {
            self.top = self.index + 1 - size;
        }
        for r in 0..size {
            p.move_to(y + 2 + r as i32, x + 1);
            let Some(it) = self.items.get(self.top + r) else {
                p.text(&fit(if r == 0 { " No matching results" } else { "" }, inner as usize), &c.line_number, &c.widget);
                continue;
            };
            let bg = if self.top + r == self.index { &c.selection } else { &c.widget };
            p.text(" ", &c.fg, bg);
            let mut used = 1;
            for (i, ch) in it.label.char_indices() {
                let cw = char_width(ch) as i32;
                if used + cw > inner - 1 {
                    break;
                }
                let hit = it.hits.contains(&i);
                p.styled(&ch.to_string(), if hit { &c.highlight } else { &c.fg }, bg, if hit { 2 } else { 0 }, None);
                used += cw;
            }
            let detail = if it.detail.is_empty() { String::new() } else { format!("  {}", it.detail) };
            p.text(&fit(&detail, (inner - used).max(0) as usize), &c.line_number, bg);
        }
    }

    pub fn event(&mut self, ev: &Ev, a: &Area) -> Outcome<T> {
        let n = self.items.len();
        match ev {
            Ev::Text(t) | Ev::Paste(t) => {
                self.text.push_str(t.split(['\r', '\n']).next().unwrap_or(""));
                self.refresh();
            }
            Ev::Key(k) => match k.name.as_str() {
                "escape" => return Outcome::Close,
                "backspace" => {
                    self.text.pop();
                    self.refresh();
                }
                "up" if n > 0 => self.index = (self.index + n - 1) % n,
                "down" if n > 0 => self.index = (self.index + 1) % n,
                "pageup" => self.index = self.index.saturating_sub(self.geometry(a).3),
                "pagedown" => self.index = (self.index + self.geometry(a).3).min(n.saturating_sub(1)),
                "enter" => return self.items.get(self.index).map_or(Outcome::Close, |it| Outcome::Run(it.act.clone())),
                _ => {}
            },
            Ev::Mouse(m) if m.press() => {
                let (x, y, w, size) = self.geometry(a);
                if !inside(m, x, y, w, size as i32 + 3) {
                    return Outcome::Close;
                }
                let r = m.y - y - 2;
                if r >= 0 && (r as usize) < size {
                    if let Some(it) = self.items.get(self.top + r as usize) {
                        return Outcome::Run(it.act.clone());
                    }
                }
            }
            _ => {}
        }
        Outcome::Stay
    }
}

/// Subsequence match with VS Code-like bonuses (commands.cjs fuzzy): (score, byte offsets of the hits) or None.
pub fn fuzzy(query: &str, text: &str) -> Option<(f64, Vec<usize>)> {
    if query.is_empty() {
        return Some((0.0, vec![]));
    }
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let lower: Vec<char> = chars.iter().map(|(_, c)| c.to_lowercase().next().unwrap_or(*c)).collect();
    let (mut score, mut ti, mut prev, mut hits) = (0.0, 0usize, -2i64, vec![]);
    for q in query.to_lowercase().chars() {
        if q == ' ' {
            continue;
        }
        let i = (ti..lower.len()).find(|&i| lower[i] == q)?;
        let before = i.checked_sub(1).map(|k| chars[k].1);
        let start = i == 0
            || before.is_some_and(|b| b.is_whitespace() || "/\\._-:".contains(b))
            || (chars[i].1 != lower[i] && before.is_some_and(|b| b.to_lowercase().next() == Some(b)));
        score += 1.0 + if i as i64 == prev + 1 { 5.0 } else { 0.0 } + if start { 8.0 } else { 0.0 } - ((i - ti) as f64 * 0.05).min(3.0);
        hits.push(chars[i].0);
        prev = i as i64;
        ti = i + 1;
    }
    Some((score, hits))
}

/// Indexes of the items matching `query`, best first (ties keep the order), with their hits.
pub fn filter(items: &[&str], query: &str) -> Vec<(usize, Vec<usize>)> {
    let mut out: Vec<(usize, f64, Vec<usize>)> = items.iter().enumerate().filter_map(|(i, t)| fuzzy(query, t).map(|(s, h)| (i, s, h))).collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    out.into_iter().map(|(i, _, h)| (i, h)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_prefers_word_starts_and_runs() {
        let files = ["README.md", "mods/vscode-viewer/editor/vsedit.cjs", "mods/vscode-viewer/editor/test/e2e.py"];
        assert_eq!(filter(&files, "vsedit")[0].0, 1);
        assert!(fuzzy("xyz", "abc").is_none());
        assert_eq!(fuzzy("lf", "LF").map(|f| f.1), Some(vec![0, 1]));
    }
}
