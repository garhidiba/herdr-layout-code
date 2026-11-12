//! The read-only hex viewer for binary files (hexview.cjs): rows of offset | 16 bytes (8+8) | ASCII read lazily in
//! chunks, go to offset, find hex bytes or text, a data inspector, copy as hex; and the "this file is binary" prompt.

use crate::app::{App, Flow};
use crate::commands::LiveKeys;
use crate::keys::{Ev, Mouse};
use crate::overlays::{button, Area, Dialog, Input, InputOutcome, Outcome};
use crate::paint::{fit, Painter, Palette};
use crate::scrollbar::{self, Bar, BarMouse};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant};

const ROW: usize = 16;

/// Clearly binary names skip the prompt and open in hex right away.
pub fn binary_name(file: &Path) -> bool {
    let name = file.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name == ".ds_store" {
        return true;
    }
    const EXT: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "heic", "psd", "zip", "gz", "tgz", "bz2", "xz", "zst", "7z",
        "rar", "tar", "jar", "war", "dmg", "iso", "pkg", "deb", "rpm", "exe", "dll", "so", "dylib", "o", "a", "obj", "lib", "class", "pyc",
        "wasm", "bin", "ttf", "otf", "woff", "woff2", "eot", "pdf", "sqlite", "sqlite3", "db", "mp3", "mp4", "m4a", "mov", "avi", "mkv", "wav",
        "flac", "ogg", "webm",
    ];
    name.rsplit_once('.').is_some_and(|(_, e)| EXT.contains(&e))
}

fn byte_color(b: u8) -> &'static str {
    match b {
        0 => "#5c6370",
        0x20..=0x7e => "#98c379",
        _ => "#d19a66",
    }
}
fn char_of(b: u8) -> char {
    if (0x20..0x7f).contains(&b) {
        b as char
    } else {
        '·'
    }
}
/// 0-based screen column of byte i's hex digits.
fn hex_col(i: usize) -> usize {
    10 + i * 3 + (i >= 8) as usize
}
const ASCII_COL: usize = 10 + ROW * 3 + 1 + 1;

pub fn header() -> String {
    let mut h = String::from("Offset    ");
    for i in 0..ROW {
        if i == 8 {
            h.push(' ');
        }
        h += &format!("{i:02X} ");
    }
    h + " Decoded Text"
}

/// One row as the screen shows it, without colors.
#[cfg(test)]
fn format_row(offset: usize, bytes: &[u8]) -> String {
    let mut hex = String::new();
    for i in 0..ROW {
        if i == 8 {
            hex.push(' ');
        }
        hex += &bytes.get(i).map_or("  ".into(), |b| format!("{b:02x}"));
        hex.push(' ');
    }
    format!("{offset:08x}  {hex} {}", bytes.iter().map(|b| char_of(*b)).collect::<String>())
}

fn float(v: f32) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    // Number(v.toPrecision(7)) printed by JavaScript
    let s = format!("{:.6e}", v as f64);
    let n: f64 = s.parse().unwrap_or(0.0);
    let t = format!("{n}");
    if n != 0.0 && (n.abs() >= 1e21 || n.abs() < 1e-6) {
        let e = format!("{n:e}");
        return e.replace('e', "e+").replace("e+-", "e-");
    }
    t
}

/// Data inspector values at the first byte of `b`.
pub fn inspect(b: &[u8]) -> Vec<(&'static str, String)> {
    let mut out = vec![];
    if !b.is_empty() {
        out.push(("int8", (b[0] as i8).to_string()));
        out.push(("uint8", b[0].to_string()));
    }
    if b.len() >= 2 {
        out.push(("int16 LE", i16::from_le_bytes([b[0], b[1]]).to_string()));
        out.push(("int16 BE", i16::from_be_bytes([b[0], b[1]]).to_string()));
    }
    if b.len() >= 4 {
        let a = [b[0], b[1], b[2], b[3]];
        out.push(("int32 LE", i32::from_le_bytes(a).to_string()));
        out.push(("int32 BE", i32::from_be_bytes(a).to_string()));
        out.push(("float32 LE", float(f32::from_le_bytes(a))));
        out.push(("float32 BE", float(f32::from_be_bytes(a))));
    }
    out
}

/// "0x1f", "1fh" and anything with a-f are hex; plain digits are decimal.
pub fn parse_offset(s: &str) -> Option<u64> {
    let s = s.trim().to_lowercase();
    let hex = |t: &str| (!t.is_empty() && t.bytes().all(|b| b.is_ascii_hexdigit())).then(|| u64::from_str_radix(t, 16).ok()).flatten();
    if let Some(h) = s.strip_prefix("0x").and_then(hex).or_else(|| s.strip_suffix('h').and_then(hex)) {
        return Some(h);
    }
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        return s.parse().ok();
    }
    hex(&s)
}

/// Find text -> bytes: spaced byte pairs are hex; "quoted" or anything else is UTF-8 text.
pub fn parse_needle(q: &str) -> Option<Vec<u8>> {
    if q.len() >= 3 && q.starts_with('"') && q.ends_with('"') {
        return Some(q.as_bytes()[1..q.len() - 1].to_vec());
    }
    let t = q.trim();
    let parts: Vec<&str> = t.split_whitespace().collect();
    if !parts.is_empty() && parts.iter().all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Some(parts.iter().map(|p| u8::from_str_radix(p, 16).unwrap()).collect());
    }
    (!q.is_empty()).then(|| q.as_bytes().to_vec())
}

/// Reads a file through a small LRU of fixed-size chunks; searches stream through it in 1 MB blocks.
pub struct Reader {
    file: File,
    pub size: u64,
    chunk: u64,
    keep: usize,
    cache: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
}

impl Reader {
    pub fn open(path: &Path) -> io::Result<Reader> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok(Reader { file, size, chunk: 64 * 1024, keep: 64, cache: HashMap::new(), order: VecDeque::new() })
    }
    fn direct(&mut self, offset: u64, len: u64) -> io::Result<Vec<u8>> {
        let n = len.min(self.size.saturating_sub(offset));
        let mut buf = vec![0; n as usize];
        self.file.seek(SeekFrom::Start(offset))?;
        let mut got = 0;
        while got < buf.len() {
            let r = self.file.read(&mut buf[got..])?;
            if r == 0 {
                break;
            }
            got += r;
        }
        buf.truncate(got);
        Ok(buf)
    }
    fn chunk_at(&mut self, i: u64) -> io::Result<&Vec<u8>> {
        if !self.cache.contains_key(&i) {
            let c = self.direct(i * self.chunk, self.chunk)?;
            self.cache.insert(i, c);
            if self.cache.len() > self.keep {
                if let Some(old) = self.order.pop_front() {
                    self.cache.remove(&old);
                }
            }
        }
        self.order.retain(|k| *k != i);
        self.order.push_back(i);
        Ok(&self.cache[&i])
    }
    /// Bytes [offset, offset + len), cut at the end of the file.
    pub fn read(&mut self, offset: u64, len: u64) -> io::Result<Vec<u8>> {
        let end = self.size.min(offset + len);
        let mut out = vec![];
        let mut p = offset;
        while p < end {
            let i = p / self.chunk;
            let base = i * self.chunk;
            let c = self.chunk_at(i)?;
            let e = (c.len() as u64).min(end - base);
            if e <= p - base {
                break; // the file shrank under us
            }
            out.extend_from_slice(&c[(p - base) as usize..e as usize]);
            p = base + e;
        }
        Ok(out)
    }
    fn index_in(&mut self, needle: &[u8], start: u64, end: u64, last: bool) -> io::Result<Option<u64>> {
        const BLOCK: u64 = 1 << 20;
        let over = needle.len() as u64 - 1;
        let found = |hay: &[u8], last: bool| {
            let mut it = hay.windows(needle.len()).enumerate().filter(|(_, w)| *w == needle).map(|(i, _)| i as u64);
            if last {
                it.next_back()
            } else {
                it.next()
            }
        };
        if !last {
            let mut p = start;
            while p < end {
                let hay = self.direct(p, (end - p).min(BLOCK) + over)?;
                if let Some(i) = found(&hay, false) {
                    return Ok((p + i < end).then_some(p + i));
                }
                p += BLOCK;
            }
        } else {
            let mut q = end;
            while q > start {
                let p = start.max(q.saturating_sub(BLOCK));
                let hay = self.direct(p, q - p + over)?;
                let hits: Option<u64> = found(&hay[..hay.len().min((q - p) as usize + over as usize)], true).filter(|i| p + i < q);
                if let Some(i) = hits {
                    return Ok(Some(p + i));
                }
                q = p;
            }
        }
        Ok(None)
    }
    /// The next match at or after `from` (or the last before it, backwards), wrapping.
    pub fn find(&mut self, needle: &[u8], from: u64, back: bool) -> io::Result<Option<u64>> {
        if needle.is_empty() {
            return Ok(None);
        }
        if back {
            return Ok(match self.index_in(needle, 0, from, true)? {
                Some(i) => Some(i),
                None => self.index_in(needle, from, self.size, true)?,
            });
        }
        Ok(match self.index_in(needle, from, self.size, false)? {
            Some(i) => Some(i),
            None => self.index_in(needle, 0, from.min(self.size), false)?,
        })
    }
}

fn size_text(n: u64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    let (div, unit) = if n < 1048576 { (1024.0, "KB") } else { (1048576.0, "MB") };
    format!("{:.1} {unit} ({n} bytes)", n as f64 / div)
}

#[derive(Clone, Copy)]
enum HexInput {
    Goto,
    Find,
}

pub struct HexView {
    reader: Reader,
    crumbs: Vec<String>,
    c: Palette,
    keys: LiveKeys,
    cursor: u64,
    anchor: Option<u64>,
    top: u64,
    rows: i32,
    cols: i32,
    popup: Option<Input<HexInput>>,
    message: Option<(String, String, Instant)>,
    query: String,
    needle: Option<Vec<u8>>,
    vbar: Bar,
    hover_mode: Option<bool>,
    next_poll: Instant,
    /// The clipboard text to write (the session owns the terminal).
    pub copy: Option<String>,
}

impl HexView {
    pub fn new(reader: Reader, crumbs: Vec<String>, c: Palette) -> HexView {
        HexView {
            reader,
            crumbs,
            c,
            keys: LiveKeys::new(),
            cursor: 0,
            anchor: None,
            top: 0,
            rows: 24,
            cols: 80,
            popup: None,
            message: None,
            query: String::new(),
            needle: None,
            vbar: Bar::new(true),
            hover_mode: None,
            next_poll: Instant::now() + Duration::from_secs(2),
            copy: None,
        }
    }
    fn height(&self) -> u64 {
        (self.rows - 4).max(1) as u64
    }
    fn last_row(&self) -> u64 {
        self.reader.size.div_ceil(ROW as u64).saturating_sub(1)
    }
    fn range(&self) -> (u64, u64) {
        let a = self.anchor.unwrap_or(self.cursor);
        (a.min(self.cursor), a.max(self.cursor) + 1)
    }
    fn say(&mut self, text: String, color: Option<&str>) {
        let color = color.unwrap_or(&self.c.bar_fg).to_string();
        self.message = Some((text, color, Instant::now() + Duration::from_secs(3)));
    }
    fn move_to(&mut self, offset: i64, extend: bool) {
        if extend && self.anchor.is_none() {
            self.anchor = Some(self.cursor);
        }
        if !extend {
            self.anchor = None;
        }
        self.cursor = offset.clamp(0, self.reader.size.saturating_sub(1) as i64) as u64;
        let row = self.cursor / ROW as u64;
        if row < self.top {
            self.top = row;
        } else if row >= self.top + self.height() {
            self.top = row + 1 - self.height();
        }
    }
    fn center(&mut self) {
        self.top = (self.cursor / ROW as u64).saturating_sub(self.height() / 2);
    }
    fn scroll(&mut self, rows: i64) {
        let max = (self.last_row() as i64 - self.height() as i64 + 1).max(0);
        self.top = (self.top as i64 + rows).clamp(0, max) as u64;
    }
    fn find_next(&mut self, back: bool, here: bool) -> io::Result<()> {
        let Some(needle) = self.needle.clone() else {
            self.open_find();
            return Ok(());
        };
        let (s, _) = self.range();
        let from = if back { s } else if here { self.cursor } else { s + 1 };
        match self.reader.find(&needle, from, back)? {
            None => {
                let w = self.c.warn.clone();
                self.say(format!("No results for {}", self.query), Some(&w));
            }
            Some(i) => {
                self.anchor = Some(i);
                self.cursor = i + needle.len() as u64 - 1;
                self.center();
                self.say(format!("Found at 0x{i:x} ({i})"), None);
            }
        }
        Ok(())
    }
    fn open_find(&mut self) {
        self.popup = Some(Input::new("Find (hex bytes de ad be ef, or text):", &self.query.clone(), HexInput::Find));
    }
    fn copy_hex(&mut self) -> io::Result<()> {
        if self.reader.size == 0 {
            return Ok(());
        }
        let (s, e) = self.range();
        let n = (e - s).min(1 << 20);
        let bytes = self.reader.read(s, n)?;
        self.copy = Some(bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" "));
        self.say(if n < e - s { format!("Copied the first {n} bytes as hex") } else { format!("Copied {n} byte{} as hex", if n == 1 { "" } else { "s" }) }, None);
        Ok(())
    }
    fn offset_at(&self, x: i32, y: i32) -> Option<u64> {
        let (r, col) = (y - 3, (x - 1).max(0) as usize);
        if r < 0 || r as u64 >= self.height() {
            return None;
        }
        let i = if (ASCII_COL..ASCII_COL + ROW).contains(&col) { Some(col - ASCII_COL) } else { (0..ROW).find(|k| col >= hex_col(*k) && col < hex_col(*k) + 3) };
        let o = (self.top + r as u64) * ROW as u64 + i? as u64;
        (o < self.reader.size).then_some(o)
    }
    fn mouse(&mut self, m: &Mouse) {
        match self.vbar.mouse(m) {
            BarMouse::To(p) => return self.top = p.max(0) as u64,
            BarMouse::Took => return,
            BarMouse::No => {}
        }
        if m.wheel() {
            return self.scroll(if m.button == 64 { -3 } else { 3 });
        }
        if m.button != 0 || m.release {
            return;
        }
        if let Some(o) = self.offset_at(m.x, m.y) {
            self.move_to(o as i64, m.motion || m.extend());
        }
    }
    fn input(&mut self, a: HexInput, t: String) -> io::Result<()> {
        match a {
            HexInput::Goto => match parse_offset(&t).filter(|o| *o < self.reader.size) {
                Some(o) => {
                    self.move_to(o as i64, false);
                    self.center();
                }
                None => {
                    let w = self.c.warn.clone();
                    self.say(format!("Offset out of range: {t}"), Some(&w));
                }
            },
            HexInput::Find => {
                self.needle = parse_needle(&t);
                self.query = t;
                self.find_next(false, true)?;
            }
        }
        Ok(())
    }
    fn key(&mut self, ev: &Ev) -> io::Result<Flow<()>> {
        if let Some(p) = self.popup.as_mut() {
            match p.event(ev) {
                InputOutcome::Stay | InputOutcome::Changed(_) => {}
                InputOutcome::Cancel => self.popup = None,
                InputOutcome::Accept(a, t) => {
                    self.popup = None;
                    self.input(a, t)?;
                }
            }
            return Ok(Flow::Go);
        }
        let k = match ev {
            Ev::Mouse(m) => {
                self.mouse(m);
                return Ok(Flow::Go);
            }
            Ev::Key(k) => k,
            _ => return Ok(Flow::Go),
        };
        let chord = k.chord();
        if chord == "escape" {
            if self.anchor.take().is_some() {
                return Ok(Flow::Go);
            }
            return Ok(Flow::Done(()));
        }
        match self.keys.keymap.by_chord.get(&chord).map(String::as_str) {
            Some("workbench.action.closeActiveEditor") => return Ok(Flow::Done(())),
            Some("workbench.action.gotoLine") => self.popup = Some(Input::new("Go to offset (0x1F hex or 31 decimal):", "", HexInput::Goto)),
            Some("actions.find") => self.open_find(),
            Some("editor.action.nextMatchFindAction") => self.find_next(false, false)?,
            Some("editor.action.previousMatchFindAction") => self.find_next(true, false)?,
            Some("editor.action.clipboardCopyAction") => self.copy_hex()?,
            _ => {
                let page = (self.height() * ROW as u64) as i64;
                let step = match k.name.as_str() {
                    "left" => Some(-1),
                    "right" => Some(1),
                    "up" => Some(-(ROW as i64)),
                    "down" => Some(ROW as i64),
                    "pageup" => Some(-page),
                    "pagedown" => Some(page),
                    _ => None,
                };
                if let Some(s) = step {
                    if s.abs() == page {
                        self.scroll(s / ROW as i64);
                    }
                    self.move_to(self.cursor as i64 + s, k.shift);
                } else if k.name == "home" {
                    self.move_to(0, k.shift);
                } else if k.name == "end" {
                    self.move_to(self.reader.size as i64 - 1, k.shift);
                }
            }
        }
        Ok(Flow::Go)
    }
    fn draw(&mut self, rows: i32, cols: i32) -> io::Result<String> {
        (self.rows, self.cols) = (rows, cols);
        self.top = self.top.min(self.last_row());
        let mut p = Painter::default();
        let c = &self.c;
        let h = self.height();
        let (s, e) = self.range();
        let sel = self.anchor.is_some();
        let cursor = self.cursor;
        let bg_of = |o: u64| if o == cursor { &c.find_match } else if sel && o >= s && o < e { &c.selection } else { &c.bg };
        p.move_to(1, 1);
        p.text(&fit(&format!(" {}", self.crumbs.join(" › ")), cols as usize), &c.bar_fg, &c.bg);
        p.move_to(2, 1);
        p.text(&fit(&header(), cols as usize), &c.line_number, &c.bg);
        let data = self.reader.read(self.top * ROW as u64, h * ROW as u64)?;
        for r in 0..h as usize {
            let off = (self.top + r as u64) * ROW as u64;
            let bytes = data.get(r * ROW..((r + 1) * ROW).min(data.len())).unwrap_or(&[]);
            let mut x = 0usize;
            p.move_to(r as i32 + 3, 1);
            let mut put = |p: &mut Painter, t: &str, fg: &str, bg: &str| {
                if x < cols as usize {
                    p.text(&t.chars().take(cols as usize - x).collect::<String>(), fg, bg);
                }
                x += t.chars().count();
            };
            if !bytes.is_empty() || (off == 0 && r == 0) {
                let on_row = self.cursor / ROW as u64 == self.top + r as u64;
                put(&mut p, &format!("{off:08x}"), if on_row { &c.line_number_active } else { &c.line_number }, &c.bg);
                put(&mut p, "  ", &c.fg, &c.bg);
                for i in 0..ROW {
                    if i == 8 {
                        put(&mut p, " ", &c.fg, &c.bg);
                    }
                    let Some(&b) = bytes.get(i) else {
                        put(&mut p, "   ", &c.fg, &c.bg);
                        continue;
                    };
                    let o = off + i as u64;
                    let joined = sel && o >= s && o + 1 < e && i != 7 && i != ROW - 1;
                    put(&mut p, &format!("{b:02x}"), byte_color(b), bg_of(o));
                    put(&mut p, " ", &c.fg, if joined { &c.selection } else { &c.bg });
                }
                put(&mut p, " ", &c.fg, &c.bg);
                for (i, &b) in bytes.iter().enumerate() {
                    put(&mut p, &char_of(b).to_string(), byte_color(b), bg_of(off + i as u64));
                }
            }
            if x < cols as usize {
                p.text(&" ".repeat(cols as usize - x), &c.fg, &c.bg);
            }
        }
        let shown = self.last_row() >= h || self.top > 0;
        if self.vbar.layout(shown, 3, cols, h as i64, h as i64, self.last_row() as i64 + 1, self.top as i64) {
            self.vbar.paint(&mut p, &self.c, None);
        }
        // the data inspector
        let c = &self.c;
        let mut x = 0;
        p.move_to(rows - 1, 1);
        for (k, v) in inspect(&self.reader.read(self.cursor, 4)?) {
            let t = format!("  {k} ");
            if x + t.len() + v.len() > cols as usize {
                break;
            }
            p.text(&t, &c.line_number, &c.bg);
            p.text(&v, &c.fg, &c.bg);
            x += t.len() + v.len();
        }
        if x < cols as usize {
            p.text(&" ".repeat(cols as usize - x), &c.fg, &c.bg);
        }
        // the status bar
        let o = self.cursor;
        let b = self.reader.read(o, 1)?.first().copied();
        let mut parts = vec![format!("Offset 0x{o:X} ({o})")];
        if let Some(b) = b {
            parts.push(format!("Byte 0x{b:02X} {b} {b:08b}"));
        }
        if self.anchor.is_some() {
            parts.push(format!("{} selected", e - s));
        }
        parts.push(size_text(self.reader.size));
        parts.push("Hex".into());
        let msg = self.message.as_ref().filter(|m| m.2 > Instant::now()).cloned();
        let mut right = parts.join("   ") + "  ";
        if msg.as_ref().is_some_and(|m| m.0.len() + right.len() + 4 > cols as usize) {
            right.clear();
        }
        p.move_to(rows, 1);
        p.text(&fit(&format!("  {}", msg.as_ref().map_or("", |m| m.0.as_str())), (cols as usize).saturating_sub(right.len())), msg.as_ref().map_or(&c.bar_fg, |m| &m.1), &c.bar);
        if right.len() <= cols as usize {
            p.text(&right, &c.bar_fg, &c.bar);
        }
        let mut cursor_out = String::new();
        if let Some(pop) = self.popup.as_mut() {
            pop.render(&mut p, &Area { c: &self.c, rows, cols });
            cursor_out = format!("\x1b[{};{}H\x1b[?25h", pop.cursor.0, pop.cursor.1);
        }
        let mode = scrollbar::hover_mode(&mut self.hover_mode, self.vbar.shown);
        Ok(format!("{}\x1b[0m{}{mode}", p.out, if cursor_out.is_empty() { "\x1b[?25l".to_string() } else { cursor_out }))
    }
}

impl App for HexView {
    type Out = io::Result<()>;
    fn render(&mut self, rows: i32, cols: i32) -> Flow<Self::Out> {
        match self.draw(rows, cols) {
            Ok(s) => Flow::Frame(s),
            Err(e) => Flow::Done(Err(e)),
        }
    }
    fn handle(&mut self, ev: &Ev) -> Flow<Self::Out> {
        match self.key(ev) {
            Ok(Flow::Done(())) => Flow::Done(Ok(())),
            Ok(_) => Flow::Go,
            Err(e) => Flow::Done(Err(e)),
        }
    }
    fn hover(&mut self, ev: &Ev) -> Option<String> {
        if self.popup.is_some() {
            return None;
        }
        match ev {
            Ev::Mouse(m) if m.motion && m.button == 3 => Some(if self.vbar.hovering(m) { self.vbar.repaint(&self.c, None) } else { String::new() }),
            _ => None,
        }
    }
    fn deadline(&self) -> Option<Instant> {
        let m = self.message.as_ref().map(|m| m.2).filter(|t| *t > Instant::now());
        [m, Some(self.next_poll)].into_iter().flatten().min()
    }
    fn tick(&mut self) -> bool {
        if Instant::now() >= self.next_poll {
            self.next_poll = Instant::now() + Duration::from_secs(2);
            self.keys.poll();
        }
        true
    }
    fn clipboard(&mut self) -> Option<String> {
        self.copy.take()
    }
}

#[derive(Clone, Copy)]
pub enum Choice {
    Hex,
    Text,
}

/// "The file is not displayed in the text editor because it is binary."
pub struct BinaryPrompt {
    crumbs: Vec<String>,
    c: Palette,
    dialog: Dialog<Choice>,
    rows: i32,
    cols: i32,
}

impl BinaryPrompt {
    pub fn new(crumbs: Vec<String>, c: Palette) -> BinaryPrompt {
        let dialog = Dialog::new(
            "The file is not displayed in the text editor because it is binary.",
            Some("Open it in the Hex Viewer, or open it anyway as text (lossy)."),
            vec![button("Open in Hex Viewer", 'h', Choice::Hex), button("Open Anyway", 'a', Choice::Text)],
        );
        BinaryPrompt { crumbs, c, dialog, rows: 24, cols: 80 }
    }
}

impl App for BinaryPrompt {
    /// None: quit.
    type Out = Option<Choice>;
    fn render(&mut self, rows: i32, cols: i32) -> Flow<Self::Out> {
        (self.rows, self.cols) = (rows, cols);
        let c = &self.c;
        let mut p = Painter::default();
        p.move_to(1, 1);
        p.text(&fit(&format!(" {}", self.crumbs.join(" › ")), cols as usize), &c.bar_fg, &c.bg);
        for r in 2..rows {
            p.move_to(r, 1);
            p.text(&" ".repeat(cols as usize), &c.fg, &c.bg);
        }
        p.move_to(rows, 1);
        p.text(&" ".repeat(cols as usize), &c.bar_fg, &c.bar);
        self.dialog.render(&mut p, &Area { c, rows, cols });
        Flow::Frame(p.out + "\x1b[0m\x1b[?25l")
    }
    fn handle(&mut self, ev: &Ev) -> Flow<Self::Out> {
        if let Ev::Key(k) = ev {
            let chord = k.chord();
            if chord == "escape" || crate::commands::Keymap::resolve(&[]).id(&chord) == Some("workbench.action.closeActiveEditor") {
                return Flow::Done(None);
            }
        }
        match self.dialog.event(ev) {
            Outcome::Run(c) => Flow::Done(Some(c)),
            _ => Flow::Go,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_show_offset_hex_and_text() {
        let row = format_row(0, b"HXV1\x00\x01\x02\x03\x00\x01\x02\x03\x04\x05\x06\x07");
        assert!(row.starts_with("00000000  48 58 56 31 00 01 02 03  00 01 02 03 04 05 06 07  HXV1····"), "{row}");
        assert_eq!(&header()[..16], "Offset    00 01 ");
        assert_eq!(size_text(1 << 20), "1.0 MB (1048576 bytes)");
    }

    #[test]
    fn offsets_and_needles_parse_like_the_js() {
        assert_eq!(parse_offset("0x40000"), Some(0x40000));
        assert_eq!(parse_offset("1fh"), Some(31));
        assert_eq!(parse_offset("31"), Some(31));
        assert_eq!(parse_offset("ff"), Some(255));
        assert_eq!(parse_offset("zz"), None);
        assert_eq!(parse_needle("de ad be ef"), Some(vec![0xde, 0xad, 0xbe, 0xef]));
        assert_eq!(parse_needle("\"ab\""), Some(b"ab".to_vec()));
        assert_eq!(parse_needle("hello"), Some(b"hello".to_vec()));
    }

    #[test]
    fn the_inspector_reads_little_and_big_endian() {
        let v = inspect(&[0x00, 0x00, 0x80, 0x3f]);
        assert_eq!(v[2], ("int16 LE", "0".into()));
        assert_eq!(v[6], ("float32 LE", "1".into()));
        assert_eq!(inspect(&[0xff])[0], ("int8", "-1".into()));
    }

    #[test]
    fn search_wraps_around_the_file() {
        let path = std::env::temp_dir().join(format!("vsedit-hex-{}", std::process::id()));
        let mut data = vec![0u8; 3 << 20];
        data[100..104].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        data[(2 << 20) + 5..(2 << 20) + 9].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        std::fs::write(&path, &data).unwrap();
        let mut r = Reader::open(&path).unwrap();
        let n = [0xde, 0xad, 0xbe, 0xef];
        assert_eq!(r.find(&n, 0, false).unwrap(), Some(100));
        assert_eq!(r.find(&n, 101, false).unwrap(), Some((2 << 20) + 5));
        assert_eq!(r.find(&n, (2 << 20) + 6, false).unwrap(), Some(100));
        assert_eq!(r.find(&n, 50, true).unwrap(), Some((2 << 20) + 5));
        assert_eq!(r.read(98, 4).unwrap(), vec![0, 0, 0xde, 0xad]);
        std::fs::remove_file(path).unwrap();
    }
}
