//! Overlays drawn over the text (overlays.cjs): the modal dialog, the input box, the quick pick, the context menu, the
//! results panel, the peek box and the hover box. They hold no editor state: keys and clicks come back as an outcome
//! carrying the caller's action.

use crate::keys::{Ev, Mouse};
use crate::lang::Loc;
use crate::paint::{fit, Painter, Palette};
use crate::scrollbar::{Bar, BarMouse};
use crate::width::{char_width, text_width};
use std::path::{Path, PathBuf};
use vscode_textmate::{OnigString, Scanner};

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

/// A one-line prompt: on the first text row (go to line, the auto save delay, Save As), or in a box under a text
/// position (`at`: rename, change all) with its label below.
pub struct Input<T> {
    pub label: String,
    pub text: String,
    pub select_all: bool,
    pub accept: T,
    pub cursor: (i32, i32),
    pub at: Option<(i32, i32)>,
}

pub enum InputOutcome<T> {
    Stay,
    /// The text changed (a live preview may follow it).
    Changed(String),
    Cancel,
    Accept(T, String),
}

impl<T: Clone> Input<T> {
    pub fn new(label: &str, text: &str, accept: T) -> Input<T> {
        Input { label: label.into(), text: text.into(), select_all: !text.is_empty(), accept, cursor: (2, 1), at: None }
    }

    pub fn render(&mut self, p: &mut Painter, a: &Area) {
        let c = a.c;
        let Some((row, col)) = self.at else {
            let label = format!(" {} ", self.label);
            p.move_to(2, 1);
            p.text(&fit(&format!("{label}{}", self.text), a.cols as usize), &c.fg, &c.widget);
            self.cursor = (2, a.cols.min(tw(&label) + tw(&self.text) + 1));
            return;
        };
        let w = a.cols.min(28.max(tw(&self.text) + 4));
        let x = col.min(a.cols - w + 1).max(1);
        frame(p, a, x, row, w, 3, &c.accent);
        p.move_to(row + 1, x + 1);
        let (fg, bg) = if self.select_all { (WHITE, &c.selection) } else { (c.fg.as_str(), &c.input) };
        p.text(&fit(&format!(" {}", self.text), (w - 2).max(0) as usize), fg, bg);
        if !self.label.is_empty() {
            p.move_to(row + 2, x + 2);
            p.text(&fit(&format!(" {} ", self.label), (w - 4).max(0) as usize), &c.bar_fg, &c.widget);
        }
        self.cursor = (row + 1, x + 2 + (w - 4).min(tw(&self.text)));
    }

    fn set(&mut self, v: String) -> InputOutcome<T> {
        self.text = v;
        self.select_all = false;
        InputOutcome::Changed(self.text.clone())
    }

    pub fn event(&mut self, ev: &Ev) -> InputOutcome<T> {
        match ev {
            Ev::Text(t) | Ev::Paste(t) => {
                let first = t.split(['\r', '\n']).next().unwrap_or("");
                let base = if self.select_all { String::new() } else { self.text.clone() };
                return self.set(base + first);
            }
            Ev::Key(k) => match k.name.as_str() {
                "escape" => return InputOutcome::Cancel,
                "enter" => return InputOutcome::Accept(self.accept.clone(), self.text.clone()),
                "backspace" => {
                    let mut t = if self.select_all { String::new() } else { self.text.clone() };
                    t.pop();
                    return self.set(t);
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
    /// Dim text at the row's right end (a command's key, a symbol's line).
    pub key: String,
    pub hits: Vec<usize>,
    pub act: T,
}

pub fn item<T>(label: impl Into<String>, act: T) -> Item<T> {
    Item { label: label.into(), detail: String::new(), key: String::new(), hits: vec![], act }
}

/// A quick pick: fixed choices filtered as typed (fuzzy), or rows the editor computes from the text (`changed` tells
/// it to, Go to File's files, `>` commands, `@` / `#` symbols, `:` line).
pub struct Picker<T> {
    pub text: String,
    pub placeholder: String,
    /// Dim text at the input's right end (where the results come from).
    pub note: String,
    choices: Option<Vec<(String, String, T)>>,
    pub items: Vec<Item<T>>,
    pub index: usize,
    top: usize,
    /// Keys keep the selection in view; the wheel and the scrollbar scroll the list alone (off until the next key).
    follow: bool,
    bar: Bar,
    pub cursor: (i32, i32),
    /// The text changed since the editor last filled a computed picker.
    pub changed: bool,
}

impl<T: Clone> Picker<T> {
    pub fn new(placeholder: &str, choices: Vec<(String, String, T)>, index: usize) -> Picker<T> {
        let mut p = Picker { text: String::new(), placeholder: placeholder.into(), note: String::new(), choices: Some(choices), items: vec![], index: 0, top: 0, follow: true, bar: Bar::new(true), cursor: (2, 1), changed: false };
        p.refresh();
        p.index = index.min(p.items.len().saturating_sub(1));
        p
    }

    /// Rows computed by the editor from the text, starting with `text`.
    pub fn computed(text: &str, placeholder: &str, note: &str) -> Picker<T> {
        Picker { text: text.into(), placeholder: placeholder.into(), note: note.into(), choices: None, items: vec![], index: 0, top: 0, follow: true, bar: Bar::new(true), cursor: (2, 1), changed: true }
    }

    pub fn is_computed(&self) -> bool {
        self.choices.is_none()
    }

    /// New rows for a computed picker (the selection back on the first).
    pub fn set_items(&mut self, items: Vec<Item<T>>) {
        self.items = items;
        (self.index, self.top, self.follow, self.changed) = (0, 0, true, false);
    }

    fn refresh(&mut self) {
        let Some(choices) = &self.choices else {
            self.changed = true;
            return;
        };
        let labels: Vec<&str> = choices.iter().map(|c| c.0.as_str()).collect();
        self.items = filter(&labels, self.text.trim())
            .into_iter()
            .map(|(i, hits)| Item { label: choices[i].0.clone(), detail: choices[i].1.clone(), key: String::new(), hits, act: choices[i].2.clone() })
            .collect();
        self.index = 0;
        self.top = 0;
        self.follow = true;
    }

    fn scroll(&mut self, top: i64, size: usize) {
        self.top = top.clamp(0, self.items.len().saturating_sub(size) as i64) as usize;
        self.follow = false;
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
        let note = if !self.note.is_empty() && tw(&self.note) + 4 < inner / 2 { format!("{} ", self.note) } else { String::new() };
        p.text(" ", &c.fg, &c.input);
        let shown = if self.text.is_empty() { &self.placeholder } else { &self.text };
        p.text(&fit(shown, (inner - 2 - tw(&note)).max(0) as usize), if self.text.is_empty() { &c.line_number } else { &c.fg }, &c.input);
        p.text(&note, &c.line_number, &c.input);
        p.text(" ", &c.fg, &c.input);
        self.cursor = (y + 1, x + 2 + (inner - 3).min(tw(&self.text)));
        if self.follow && self.index < self.top {
            self.top = self.index;
        } else if self.follow && self.index >= self.top + size {
            self.top = self.index + 1 - size;
        }
        let n = self.items.len();
        self.top = self.top.min(n.saturating_sub(size));
        let iw = inner - self.bar.layout(n > size, y + 2, x + w - 2, size as i64, size as i64, n as i64, self.top as i64) as i32;
        for r in 0..size {
            p.move_to(y + 2 + r as i32, x + 1);
            let Some(it) = self.items.get(self.top + r) else {
                p.text(&fit(if r == 0 { " No matching results" } else { "" }, iw as usize), &c.line_number, &c.widget);
                continue;
            };
            let bg = if self.top + r == self.index { &c.selection } else { &c.widget };
            let key = if it.key.is_empty() { String::new() } else { format!("{} ", it.key) };
            p.text(" ", &c.fg, bg);
            let mut used = 1;
            for (i, ch) in it.label.char_indices() {
                let cw = char_width(ch) as i32;
                if used + cw > iw - tw(&key) - 1 {
                    break;
                }
                let hit = it.hits.contains(&i);
                p.styled(&ch.to_string(), if hit { &c.highlight } else { &c.fg }, bg, if hit { 2 } else { 0 }, None);
                used += cw;
            }
            let detail = if it.detail.is_empty() { String::new() } else { format!("  {}", it.detail) };
            p.text(&fit(&detail, (iw - used - tw(&key)).max(0) as usize), &c.line_number, bg);
            p.text(&key, &c.bar_fg, bg);
        }
        self.bar.paint(p, &Palette { bg: c.widget.clone(), ..c.clone() }, None);
    }

    pub fn event(&mut self, ev: &Ev, a: &Area) -> Outcome<T> {
        let n = self.items.len();
        self.follow |= matches!(ev, Ev::Key(_));
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
                "home" => self.index = 0,
                "end" => self.index = n.saturating_sub(1),
                "up" if n > 0 => self.index = (self.index + n - 1) % n,
                "down" if n > 0 => self.index = (self.index + 1) % n,
                "pageup" => self.index = self.index.saturating_sub(self.geometry(a).3),
                "pagedown" => self.index = (self.index + self.geometry(a).3).min(n.saturating_sub(1)),
                "enter" => return self.items.get(self.index).map_or(Outcome::Close, |it| Outcome::Run(it.act.clone())),
                _ => {}
            },
            Ev::Mouse(m) => {
                let (x, y, w, size) = self.geometry(a);
                match self.bar.mouse(m) {
                    BarMouse::To(pos) => self.scroll(pos, size),
                    BarMouse::Took => {}
                    BarMouse::No if !inside(m, x, y, w, size as i32 + 3) => {
                        if m.press() {
                            return Outcome::Close;
                        }
                    }
                    BarMouse::No if m.wheel() => self.scroll(self.top as i64 + if m.button == 64 { -3 } else { 3 }, size),
                    BarMouse::No if m.press() => {
                        let r = m.y - y - 2;
                        if r >= 0 && (r as usize) < size {
                            if let Some(it) = self.items.get(self.top + r as usize) {
                                return Outcome::Run(it.act.clone());
                            }
                        }
                    }
                    BarMouse::No => {}
                }
            }
            _ => {}
        }
        Outcome::Stay
    }
}

// ---------- context menu ----------

/// A menu row: a separator, or a command (`act`) / submenu, greyed out when not enabled.
#[derive(Clone)]
pub struct Row<T> {
    pub sep: bool,
    pub title: String,
    pub key: String,
    pub enabled: bool,
    pub act: Option<T>,
    pub submenu: Vec<Row<T>>,
}

pub fn sep<T>() -> Row<T> {
    Row { sep: true, title: String::new(), key: String::new(), enabled: false, act: None, submenu: vec![] }
}

/// The next selectable row from `i` (None: before the first) in direction `dir`, wrapping.
pub fn step_menu<T>(rows: &[Row<T>], i: Option<usize>, dir: i64) -> Option<usize> {
    let n = rows.len() as i64;
    let i = i.map_or(if dir > 0 { -1 } else { n }, |i| i as i64);
    (1..=n).map(|k| (((i + dir * k) % n) + n) % n).map(|j| j as usize).find(|&j| !rows[j].sep && rows[j].enabled)
}

/// VS Code's editor context menu (also the quick fix menu): arrows, Enter / Space, → opens a submenu, the pointer
/// highlights and clicks.
pub struct Menu<T> {
    pub rows: Vec<Row<T>>,
    pub index: Option<usize>,
    pub x: i32,
    pub y: i32,
    w: i32,
    h: i32,
    sub: Option<Box<Menu<T>>>,
    /// A submenu: where its parent menu starts (it flips to the left of it at the right edge).
    parent_x: Option<i32>,
}

impl<T: Clone> Menu<T> {
    pub fn new(rows: Vec<Row<T>>, x: i32, y: i32) -> Menu<T> {
        let w = rows.iter().map(|r| if r.sep { 0 } else { tw(&r.title) + if !r.key.is_empty() || !r.submenu.is_empty() { tw(if r.key.is_empty() { "›" } else { &r.key }) + 6 } else { 2 } }).max().unwrap_or(0) + 4;
        let h = rows.len() as i32 + 2;
        Menu { rows, index: None, x, y, w, h, sub: None, parent_x: None }
    }

    fn place(&mut self, a: &Area) {
        self.w = self.w.min(a.cols);
        self.h = self.h.min(a.rows);
        if self.x + self.w - 1 > a.cols {
            self.x = 1.max(self.parent_x.map_or(a.cols - self.w + 1, |px| px - self.w + 1));
        }
        if self.y + self.h - 1 > a.rows {
            self.y = 1.max(a.rows - self.h + 1);
        }
    }

    pub fn render(&mut self, p: &mut Painter, a: &Area) {
        self.place(a);
        let c = a.c;
        let inner = self.w - 2;
        frame(p, a, self.x, self.y, self.w, self.h, &c.border);
        for (i, r) in self.rows.iter().take((self.h - 2).max(0) as usize).enumerate() {
            let row = self.y + 1 + i as i32;
            if r.sep {
                p.move_to(row, self.x);
                p.text(&format!("├{}┤", "─".repeat(inner.max(0) as usize)), &c.border, &c.widget);
                continue;
            }
            p.move_to(row, self.x + 1);
            let on = self.index == Some(i);
            let fg = if !r.enabled { c.line_number.as_str() } else if on { WHITE } else { c.fg.as_str() };
            let bg = if on { &c.button } else { &c.widget };
            let right = if r.submenu.is_empty() { r.key.as_str() } else { "›" };
            p.text(&fit(&format!(" {}", r.title), (inner - tw(right) - 1).max(0) as usize), fg, bg);
            p.text(&format!("{right} "), if !r.enabled { &c.line_number } else if on { WHITE } else { &c.bar_fg }, bg);
        }
        if let Some(s) = self.sub.as_mut() {
            s.render(p, a);
        }
    }

    fn open_sub(&mut self, a: &Area) -> bool {
        let Some(r) = self.index.and_then(|i| self.rows.get(i)) else { return false };
        if r.submenu.is_empty() || !r.enabled {
            return false;
        }
        let mut sub = Menu::new(r.submenu.clone(), self.x + self.w - 1, self.y + self.index.unwrap_or(0) as i32);
        sub.parent_x = Some(self.x);
        sub.index = step_menu(&sub.rows, None, 1);
        sub.place(a);
        self.sub = Some(Box::new(sub));
        true
    }

    fn activate(&mut self, a: &Area) -> Outcome<T> {
        let Some(r) = self.index.and_then(|i| self.rows.get(i)) else { return Outcome::Stay };
        if r.sep || !r.enabled {
            return Outcome::Stay;
        }
        if !r.submenu.is_empty() {
            self.open_sub(a);
            return Outcome::Stay;
        }
        r.act.clone().map_or(Outcome::Close, Outcome::Run)
    }

    pub fn event(&mut self, ev: &Ev, a: &Area) -> Outcome<T> {
        if let Ev::Mouse(m) = ev {
            return self.mouse(m, a).unwrap_or(Outcome::Stay);
        }
        let Ev::Key(k) = ev else { return Outcome::Stay };
        if let Some(s) = self.sub.as_mut() {
            if k.name == "left" || k.name == "escape" {
                self.sub = None;
                return Outcome::Stay;
            }
            return s.event(ev, a);
        }
        match k.name.as_str() {
            "escape" => return Outcome::Close,
            "left" if self.parent_x.is_none() => return Outcome::Close,
            "up" | "down" => {
                if let Some(j) = step_menu(&self.rows, self.index, if k.name == "up" { -1 } else { 1 }) {
                    self.index = Some(j);
                }
            }
            "home" | "end" => {
                if let Some(j) = step_menu(&self.rows, None, if k.name == "home" { 1 } else { -1 }) {
                    self.index = Some(j);
                }
            }
            "right" => {
                self.open_sub(a);
            }
            "enter" | "space" => return self.activate(a),
            _ => {}
        }
        Outcome::Stay
    }

    /// A buttonless motion: true when the highlighted row (in this menu or an open submenu) changed.
    pub fn hover(&mut self, m: &Mouse, a: &Area) -> bool {
        let before = self.path();
        self.mouse(m, a);
        self.path() != before
    }

    fn path(&self) -> Vec<Option<usize>> {
        let mut path = vec![self.index];
        path.extend(self.sub.as_ref().map(|s| s.path()).unwrap_or_default());
        path
    }

    /// None when the event isn't this menu's (a submenu's pointer outside it goes to its parent).
    fn mouse(&mut self, m: &Mouse, a: &Area) -> Option<Outcome<T>> {
        if let Some(s) = self.sub.as_mut() {
            if let Some(o) = s.mouse(m, a) {
                return Some(o);
            }
        }
        if !inside(m, self.x, self.y, self.w, self.h) {
            if self.parent_x.is_some() {
                return None;
            }
            let click = !m.release && !m.motion && !m.wheel();
            return Some(if click { Outcome::Close } else { Outcome::Stay });
        }
        let i = (m.y - self.y - 1) as usize;
        let Some(r) = self.rows.get(i).filter(|r| !r.sep) else { return Some(Outcome::Stay) };
        if r.enabled {
            self.index = Some(i);
            if r.submenu.is_empty() {
                self.sub = None;
            } else if self.sub.is_none() {
                self.open_sub(a);
            }
        }
        Some(if m.press() { self.activate(a) } else { Outcome::Stay })
    }
}

// ---------- results panel ----------

/// A results panel row: a file (its result count) or one result.
enum PanelRow {
    File(PathBuf, usize),
    Item(usize),
}

pub enum PanelOutcome {
    /// Not the panel's event.
    No,
    Stay,
    Close,
    Open(Loc),
    Toggle,
}

/// References, implementations, calls: results grouped by file at the bottom, like VS Code's references view.
pub struct Panel {
    pub title: String,
    pub items: Vec<Loc>,
    /// Tab's label (call hierarchy: the other direction).
    pub toggle: Option<String>,
    pub focused: bool,
    rows: Vec<PanelRow>,
    index: Option<usize>,
    top: usize,
    files: usize,
}

impl Panel {
    pub fn new(title: &str, items: Vec<Loc>, toggle: Option<String>) -> Panel {
        let mut files: Vec<PathBuf> = vec![];
        for it in &items {
            if !files.contains(&it.file) {
                files.push(it.file.clone());
            }
        }
        let mut rows = vec![];
        for f in &files {
            let mine: Vec<usize> = (0..items.len()).filter(|&i| items[i].file == *f).collect();
            rows.push(PanelRow::File(f.clone(), mine.len()));
            rows.extend(mine.into_iter().map(PanelRow::Item));
        }
        let index = rows.iter().position(|r| matches!(r, PanelRow::Item(_)));
        Panel { title: title.into(), files: files.len(), items, toggle, focused: true, rows, index, top: 0 }
    }

    pub fn height(rows: i32) -> i32 {
        4.max(rows * 4 / 10)
    }

    pub fn render(&mut self, p: &mut Painter, a: &Area, root: &Path) {
        let c = a.c;
        let h = Panel::height(a.rows);
        let y0 = a.rows - h;
        let n = self.items.len();
        let summary = if n > 0 { format!("{n} result{} in {} file{}", if n == 1 { "" } else { "s" }, self.files, if self.files == 1 { "" } else { "s" }) } else { "No results".into() };
        let hint = format!("{}Enter open · Esc close ", self.toggle.as_ref().map_or(String::new(), |t| format!("Tab: {t} · ")));
        p.move_to(y0, 1);
        p.styled(&fit(&format!(" {}   {summary}", self.title.to_uppercase()), (a.cols - tw(&hint)).max(0) as usize), &c.fg, &c.bar, 2, None);
        if tw(&hint) < a.cols {
            p.text(&hint, &c.bar_fg, &c.bar);
        }
        let size = (h - 1) as usize;
        let index = self.index.unwrap_or(0);
        if index < self.top {
            self.top = index;
        } else if index >= self.top + size {
            self.top = index + 1 - size;
        }
        for r in 0..size {
            p.move_to(y0 + 1 + r as i32, 1);
            let on = self.index == Some(self.top + r);
            let bg = if on { if self.focused { &c.selection } else { &c.current_line } } else { &c.widget };
            match self.rows.get(self.top + r) {
                None => p.text(&" ".repeat(a.cols.max(0) as usize), &c.fg, &c.widget),
                Some(PanelRow::File(f, count)) => {
                    let name = f.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                    let dir = f.parent().and_then(|d| d.strip_prefix(root).ok()).map(|d| d.to_string_lossy().into_owned()).filter(|d| !d.is_empty()).unwrap_or_else(|| ".".into());
                    p.text(" ▾ ", &c.bar_fg, bg);
                    p.styled(&name, &c.fg, bg, 2, None);
                    p.text(&fit(&format!("  {dir}  ({count})"), (a.cols - 3 - tw(&name)).max(0) as usize), &c.line_number, bg);
                }
                Some(PanelRow::Item(i)) => {
                    let it = &self.items[*i];
                    let lead = format!("     {:<8} ", format!("{}:{}", it.line + 1, it.col + 1));
                    let preview = it.preview.as_deref().unwrap_or("").trim();
                    let text = match &it.name {
                        Some(name) => format!("{name}{}   {preview}", if it.detail.is_empty() { String::new() } else { format!("  {}", it.detail) }),
                        None => preview.to_string(),
                    };
                    p.text(&lead, &c.line_number, bg);
                    p.text(&fit(&text, (a.cols - tw(&lead)).max(0) as usize), &c.fg, bg);
                }
            }
        }
    }

    fn step(&mut self, dir: i64) {
        let mut j = self.index.map_or(-1, |i| i as i64) + dir;
        while j >= 0 && (j as usize) < self.rows.len() {
            if matches!(self.rows[j as usize], PanelRow::Item(_)) {
                self.index = Some(j as usize);
                return;
            }
            j += dir;
        }
    }

    fn current(&self) -> Option<Loc> {
        match self.rows.get(self.index?)? {
            PanelRow::Item(i) => self.items.get(*i).cloned(),
            PanelRow::File(..) => None,
        }
    }

    pub fn key(&mut self, k: &crate::keys::Key, rows: i32) -> PanelOutcome {
        match k.name.as_str() {
            "escape" => PanelOutcome::Close,
            "up" => {
                self.step(-1);
                PanelOutcome::Stay
            }
            "down" => {
                self.step(1);
                PanelOutcome::Stay
            }
            "pageup" | "pagedown" => {
                for _ in 0..Panel::height(rows) - 2 {
                    self.step(if k.name == "pageup" { -1 } else { 1 });
                }
                PanelOutcome::Stay
            }
            "enter" => match self.current() {
                Some(l) => {
                    self.focused = false;
                    PanelOutcome::Open(l)
                }
                None => PanelOutcome::Stay,
            },
            "tab" if self.toggle.is_some() => PanelOutcome::Toggle,
            "tab" => PanelOutcome::Stay,
            _ => PanelOutcome::No,
        }
    }

    pub fn mouse(&mut self, m: &Mouse, rows: i32) -> PanelOutcome {
        let y0 = rows - Panel::height(rows);
        if m.y < y0 || m.y > rows - 1 {
            return PanelOutcome::No;
        }
        if m.wheel() {
            self.top = (self.top as i64 + if m.button == 64 { -3 } else { 3 }).clamp(0, self.rows.len().saturating_sub(1) as i64) as usize;
            return PanelOutcome::Stay;
        }
        if !m.press() {
            return PanelOutcome::Stay;
        }
        self.focused = true;
        let i = self.top + (m.y - y0 - 1).max(0) as usize;
        if m.y > y0 && matches!(self.rows.get(i), Some(PanelRow::Item(_))) {
            self.index = Some(i);
            if let Some(l) = self.current() {
                return PanelOutcome::Open(l);
            }
        }
        PanelOutcome::Stay
    }
}

// ---------- peek ----------

/// ~8 lines around items[index] in a box under the cursor line (drawn by the editor); ↑/↓ switch results.
pub struct Peek {
    pub title: String,
    pub items: Vec<Loc>,
    pub index: usize,
}

pub enum PeekOutcome {
    No,
    Stay,
    Close,
    Open(Loc),
}

impl Peek {
    pub const LINES: i32 = 8;
    pub const HEIGHT: i32 = Peek::LINES + 2;

    pub fn key(&mut self, k: &crate::keys::Key) -> PeekOutcome {
        match k.name.as_str() {
            "escape" => PeekOutcome::Close,
            "enter" => PeekOutcome::Open(self.items[self.index].clone()),
            "up" | "down" if self.items.len() > 1 && !k.shift && !k.alt && !k.cmd => {
                let n = self.items.len();
                self.index = (self.index + if k.name == "up" { n - 1 } else { 1 }) % n;
                PeekOutcome::Stay
            }
            _ => PeekOutcome::No,
        }
    }
}

// ---------- hover ----------

/// A hover line: text, a code block's line, or a rule.
#[derive(Debug, PartialEq)]
pub struct MdLine {
    pub text: String,
    pub code: bool,
    pub rule: bool,
}

/// Replaces every match of `pattern` in `text` by `rep(groups)` (groups[0] the whole match, "" for unmatched groups).
fn re_replace(text: &str, pattern: &str, rep: &dyn Fn(&[&str]) -> String) -> String {
    let Ok(mut sc) = Scanner::new(&[pattern.to_string()]) else { return text.to_string() };
    let s = OnigString::new(text.to_string());
    let (mut out, mut at, mut last) = (String::new(), 0, 0);
    while at <= text.len() {
        let Some(m) = sc.find_next_match(&s, at) else { break };
        let (a, b) = (m.captures[0].0 as usize, m.captures[0].1 as usize);
        let groups: Vec<&str> = m.captures.iter().map(|&(x, y)| if x >= 0 && y >= x { &text[x as usize..y as usize] } else { "" }).collect();
        out.push_str(&text[last..a]);
        out.push_str(&rep(&groups));
        last = b;
        at = if b > a { b } else { b + text[b..].chars().next().map_or(1, char::len_utf8) };
    }
    out.push_str(&text[last.min(text.len())..]);
    out
}

fn matches(text: &str, pattern: &str) -> bool {
    Scanner::new(&[pattern.to_string()]).ok().and_then(|mut s| s.find_next_match(&OnigString::new(text.to_string()), 0)).is_some()
}

/// Hover Markdown as terminal lines of at most `width` cells (overlays.cjs markdownLines): code blocks keep their
/// lines, other text loses its Markdown marks and wraps at spaces; runs of blank lines become one, none at the ends.
pub fn markdown_lines(md: &str, width: usize) -> Vec<MdLine> {
    let mut out: Vec<MdLine> = vec![];
    let push = |out: &mut Vec<MdLine>, l: MdLine| {
        if !l.text.is_empty() || out.last().is_some_and(|o| !o.text.is_empty()) {
            out.push(l);
        }
    };
    // pieces of at most `width` cells pushed; the last one returned
    let hard_wrap = |out: &mut Vec<MdLine>, mut line: String, code: bool| -> String {
        loop {
            let (mut i, mut w) = (0, 0);
            for ch in line.chars() {
                let cw = char_width(ch);
                if w + cw > width {
                    break;
                }
                w += cw;
                i += ch.len_utf8();
            }
            if i >= line.len() || i == 0 {
                return line;
            }
            push(out, MdLine { text: line[..i].to_string(), code, rule: false });
            line = line[i..].to_string();
        }
    };
    let mut fence = false;
    for raw in md.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if matches(raw, r"^\s*(```|~~~)") {
            fence = !fence;
            continue;
        }
        if fence {
            let t = hard_wrap(&mut out, raw.replace('\t', "    "), true);
            push(&mut out, MdLine { text: t, code: true, rule: false });
            continue;
        }
        if matches(raw, r"^\s*(-{3,}|\*{3,}|_{3,})\s*$") {
            push(&mut out, MdLine { text: "─".repeat(width), code: false, rule: true });
            continue;
        }
        let mut t = re_replace(raw, r"^\s{0,3}#{1,6}\s+", &|_| String::new());
        t = re_replace(&t, r"!?\[([^\]]*)\]\([^)]*\)", &|g| g[1].into());
        t = re_replace(&t, r"\{@link(?:code|plain)?\s+([^}|\s]+)[|\s]?([^}]*)\}", &|g| if g[2].trim().is_empty() { g[1].into() } else { g[2].trim().into() });
        t = re_replace(&t, r"(\*\*|__)(.+?)\1", &|g| g[2].into());
        t = re_replace(&t, r"(^|[^\w*])[*_](?=\S)(.+?)[*_](?![\w*])", &|g| format!("{}{}", g[1], g[2]));
        t = re_replace(&t, r"`([^`]+)`", &|g| g[1].into());
        t = re_replace(&t, r"\\([\\`*_{}\[\]()#+\-.!|<>])", &|g| g[1].into());
        t = t.replace("&nbsp;", " ");
        t = re_replace(&t, r"(?i)<br\s*/?>", &|_| String::new());
        let t = t.trim_end();
        // words keep the spaces before them, so indentation stays
        let mut words: Vec<&str> = vec![];
        let mut from = 0;
        let b = t.as_bytes();
        for i in 1..b.len() {
            if b[i] == b' ' && b[i - 1] != b' ' && i > from {
                words.push(&t[from..i]);
                from = i;
            }
        }
        words.push(&t[from..]);
        let mut line = String::new();
        for word in words {
            if !line.is_empty() && text_width(&format!("{line}{word}"), 8) > width {
                push(&mut out, MdLine { text: line.clone(), code: false, rule: false });
                line = word.trim_start().to_string();
            } else {
                line.push_str(word);
            }
            line = hard_wrap(&mut out, line, false);
        }
        push(&mut out, MdLine { text: line, code: false, rule: false });
    }
    while out.last().is_some_and(|l| l.text.is_empty()) {
        out.pop();
    }
    out
}

/// Markdown in a box over the text, above `at` (the hovered word's screen cell) or below without room; not modal.
pub struct Hover {
    pub markdown: String,
    pub at: (i32, i32),
    /// Opened by the mouse (it closes when the pointer leaves).
    pub mouse: bool,
    rect: Option<(i32, i32, i32, i32)>,
}

impl Hover {
    pub const ROWS: usize = 14;

    pub fn new(markdown: String, at: (i32, i32), mouse: bool) -> Hover {
        Hover { markdown, at, mouse, rect: None }
    }

    pub fn render(&mut self, p: &mut Painter, a: &Area) {
        let c = a.c;
        let max = 10.max((a.cols - 2).min(80));
        let lines = markdown_lines(&self.markdown, (max - 2) as usize);
        let w = max.min(lines.iter().map(|l| if l.rule { 0 } else { tw(&l.text) }).max().unwrap_or(0) + 4);
        let rows = lines.len().min(Hover::ROWS).min((a.rows - 4).max(0) as usize);
        let h = rows as i32 + 2;
        let y = if self.at.0 - h >= 1 { self.at.0 - h } else { (self.at.0 + 1).min(a.rows - h) };
        let x = 1.max((self.at.1 - 1).min(a.cols - w + 1));
        self.rect = Some((x, y, w, h));
        frame(p, a, x, y, w, h, &c.hover_border);
        let inner = (w - 2).max(0) as usize;
        for (i, l) in lines.iter().take(rows).enumerate() {
            p.move_to(y + 1 + i as i32, x + 1);
            let last = lines.len() > rows && i == rows - 1;
            let text = if l.rule { "─".repeat(inner) } else { fit(&format!(" {}", if last { "…" } else { &l.text }), inner) };
            p.text(&text, if l.rule { &c.border } else if l.code { &c.highlight } else { &c.fg }, &c.hover_bg);
        }
    }

    pub fn contains(&self, m: &Mouse) -> bool {
        self.rect.is_some_and(|(x, y, w, h)| inside(m, x, y, w, h))
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

    #[test]
    fn hover_markdown_loses_its_marks_keeps_code_and_wraps() {
        let md = "```typescript\nfunction greet(name: string): string\n```\n\n\n**Says** `hi` to {@link Person the person} — see [docs](http://x).\n\n---\n*@param* name";
        let got: Vec<(String, bool, bool)> = markdown_lines(md, 20).into_iter().map(|l| (l.text, l.code, l.rule)).collect();
        let want = [("function greet(name:", true, false), (" string): string", true, false), ("", false, false), ("Says hi to the", false, false), ("person — see docs.", false, false), ("", false, false), (&"─".repeat(20), false, true), ("@param name", false, false)];
        assert_eq!(got, want.iter().map(|(t, c, r)| (t.to_string(), *c, *r)).collect::<Vec<_>>());
    }

    #[test]
    fn menus_skip_separators_and_disabled_rows() {
        let row = |t: &str, on: bool| Row { sep: false, title: t.into(), key: String::new(), enabled: on, act: Some(t.to_string()), submenu: vec![] };
        let rows = vec![row("a", false), row("b", true), sep(), row("c", true)];
        assert_eq!(step_menu(&rows, None, 1), Some(1));
        assert_eq!(step_menu(&rows, Some(1), 1), Some(3));
        assert_eq!(step_menu(&rows, Some(3), 1), Some(1));
        assert_eq!(step_menu(&rows, None, -1), Some(3));
    }

    #[test]
    fn quick_pick_scrolls_with_keys_wheel_and_clicks() {
        let c = Palette::of(&serde_json::json!({}));
        let a = Area { c: &c, rows: 30, cols: 100 };
        let mut pk = Picker::new("", (0..30).map(|i| (format!("item {i}"), String::new(), i)).collect(), 0);
        let draw = |pk: &mut Picker<i32>| {
            let mut p = Painter::default();
            pk.render(&mut p, &a);
            p.out
        };
        let wheel = Ev::Mouse(Mouse { button: 65, x: 50, y: 5, ..Default::default() });
        pk.event(&crate::keys::key("end"), &a);
        draw(&mut pk);
        assert_eq!((pk.index, pk.top), (29, 18));
        pk.event(&crate::keys::key("home"), &a);
        draw(&mut pk);
        assert_eq!((pk.index, pk.top), (0, 0));
        for _ in 0..12 {
            pk.event(&crate::keys::key("down"), &a);
        }
        draw(&mut pk);
        assert_eq!((pk.index, pk.top), (12, 1), "↓ past the last row scrolls one");
        pk.event(&wheel, &a);
        draw(&mut pk);
        assert_eq!((pk.index, pk.top), (12, 4), "the wheel scrolls 3 rows, the selection stays");
        for _ in 0..10 {
            pk.event(&wheel, &a);
        }
        assert!(draw(&mut pk).contains("\x1b[4;89H"), "a scrollbar in the list's last column");
        assert_eq!(pk.top, 18, "clamped at the end");
        let click = Ev::Mouse(Mouse { button: 0, x: 50, y: 4, ..Default::default() });
        assert!(matches!(pk.event(&click, &a), Outcome::Run(18)));
    }
}
