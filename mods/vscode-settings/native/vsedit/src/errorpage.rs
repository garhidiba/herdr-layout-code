//! The tab's page for a file the editor can't open (errorpage.cjs): the reason, then Try Again, Open in VS Code,
//! Reveal in Finder and Close (Esc/⌘W/Ctrl+Q). Keyboard and mouse.

use crate::app::{App, Flow};
use crate::keys::Ev;
use crate::paint::{fit, Painter, Palette};
use crate::term::which;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const WHITE: &str = "#ffffff";

/// A short reason for an I/O error (its message when there is no better name).
pub fn reason_of(e: &io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::ENOENT) => "File not found".into(),
        Some(libc::EACCES) | Some(libc::EPERM) => "Permission denied".into(),
        Some(libc::EISDIR) => "The path is a folder, not a file".into(),
        Some(libc::ELOOP) => "Too many symbolic links".into(),
        Some(libc::ENAMETOOLONG) => "The file name is too long".into(),
        Some(libc::EIO) => "The disk could not be read".into(),
        _ => e.to_string().lines().next().unwrap_or("").to_string(),
    }
}

/// Starts a program without waiting; false when it isn't installed.
fn launch(cmd: &str, args: &[&str]) -> bool {
    let Some(bin) = which(cmd) else { return false };
    Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().is_ok()
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Choice {
    Retry,
    Close,
}

#[derive(Clone, Copy)]
enum Btn {
    Retry,
    Code,
    Reveal,
    Close,
}

pub struct ErrorPage {
    file: PathBuf,
    reason: String,
    crumbs: Vec<String>,
    c: Palette,
    focus: usize,
    rects: Vec<(i32, i32, i32, usize)>,
    note: String,
    buttons: Vec<(&'static str, char, Btn)>,
}

impl ErrorPage {
    pub fn new(file: &Path, reason: &str, crumbs: Vec<String>, c: Palette) -> ErrorPage {
        let mut buttons = vec![("Try Again", 't', Btn::Retry), ("Open in VS Code", 'o', Btn::Code)];
        if cfg!(target_os = "macos") {
            buttons.push(("Reveal in Finder", 'r', Btn::Reveal));
        }
        buttons.push(("Close", 'c', Btn::Close));
        ErrorPage { file: file.to_path_buf(), reason: reason.into(), crumbs, c, focus: 0, rects: vec![], note: String::new(), buttons }
    }
    fn press(&mut self, i: usize) -> Flow<Choice> {
        let file = self.file.to_string_lossy().into_owned();
        match self.buttons[i].2 {
            Btn::Retry => Flow::Done(Choice::Retry),
            Btn::Close => Flow::Done(Choice::Close),
            Btn::Code => {
                self.note = if launch("code", &[&file]) { "Opened in VS Code".into() } else { "VS Code's `code` command was not found".into() };
                Flow::Go
            }
            Btn::Reveal => {
                launch("open", &["-R", &file]);
                Flow::Go
            }
        }
    }
}

impl App for ErrorPage {
    type Out = Choice;
    fn handle(&mut self, ev: &Ev) -> Flow<Choice> {
        let n = self.buttons.len();
        match ev {
            Ev::Mouse(m) if m.press() => match self.rects.iter().find(|r| m.y == r.1 && m.x >= r.0 && m.x < r.0 + r.2) {
                Some(r) => self.press(r.3),
                None => Flow::Go,
            },
            Ev::Text(t) => match self.buttons.iter().position(|b| t.to_lowercase() == b.1.to_string()) {
                Some(i) => self.press(i),
                None => Flow::Go,
            },
            Ev::Key(k) => {
                let chord = k.chord();
                if matches!(chord.as_str(), "escape" | "ctrl+q" | "cmd+w") {
                    return Flow::Done(Choice::Close);
                }
                match k.name.as_str() {
                    "enter" | "space" => return self.press(self.focus),
                    "right" => self.focus = (self.focus + 1) % n,
                    "left" => self.focus = (self.focus + n - 1) % n,
                    _ if chord == "tab" => self.focus = (self.focus + 1) % n,
                    _ if chord == "shift+tab" => self.focus = (self.focus + n - 1) % n,
                    _ => {}
                }
                Flow::Go
            }
            _ => Flow::Go,
        }
    }
    fn render(&mut self, rows: i32, cols: i32) -> Flow<Choice> {
        let c = &self.c;
        let mut p = Painter::default();
        let name = self.file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let lines: [(&str, &str, u32); 6] =
            [("⚠", &c.warn, 0), ("", &c.fg, 0), ("The editor could not be opened", &c.fg, 2), (&name, &c.bar_fg, 0), (&self.reason, &c.error, 0), ("", &c.fg, 0)];
        let top = ((rows - lines.len() as i32 - 3) / 2).max(2);
        p.move_to(1, 1);
        p.text(&fit(&format!(" {}", self.crumbs.join(" › ")), cols as usize), &c.bar_fg, &c.bg);
        for r in 2..rows {
            p.move_to(r, 1);
            match lines.get((r - top) as usize).filter(|_| r >= top) {
                Some((t, fg, style)) => {
                    let pad = ((cols - t.encode_utf16().count() as i32) / 2).max(0) as usize;
                    p.styled(&fit(&format!("{}{t}", " ".repeat(pad)), cols as usize), fg, &c.bg, *style, None);
                }
                None => p.text(&" ".repeat(cols as usize), &c.fg, &c.bg),
            }
        }
        let y = top + lines.len() as i32;
        let labels: Vec<String> = self.buttons.iter().map(|b| format!(" {} ", b.0)).collect();
        let total: i32 = labels.iter().map(|l| l.len() as i32 + 2).sum::<i32>() - 2;
        let mut x = ((cols - total) / 2 + 1).max(1);
        self.rects.clear();
        for (i, l) in labels.iter().enumerate() {
            if x + l.len() as i32 - 1 > cols {
                break;
            }
            p.move_to(y, x);
            let on = i == self.focus;
            p.text(l, if on { WHITE } else { &c.fg }, if on { &c.button } else { &c.input });
            self.rects.push((x, y, l.len() as i32, i));
            x += l.len() as i32 + 2;
        }
        if !self.note.is_empty() {
            p.move_to(y + 2, 1);
            let pad = ((cols - self.note.len() as i32) / 2).max(0) as usize;
            p.text(&fit(&format!("{}{}", " ".repeat(pad), self.note), cols as usize), &c.bar_fg, &c.bg);
        }
        p.move_to(rows, 1);
        p.text(&fit(&format!("  {}", self.reason), cols as usize), &c.bar_fg, &c.bar);
        Flow::Frame(p.out + "\x1b[0m\x1b[?25l")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn errors_get_short_reasons() {
        let e = std::io::Error::from_raw_os_error(libc::EACCES);
        assert_eq!(super::reason_of(&e), "Permission denied");
        assert_eq!(super::reason_of(&std::io::Error::from_raw_os_error(libc::ENOENT)), "File not found");
    }
}
