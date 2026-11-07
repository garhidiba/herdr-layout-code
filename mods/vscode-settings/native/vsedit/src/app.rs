//! A full-screen session for the hex viewer, the binary prompt and the error page (terminal.cjs `session`): the
//! alternate screen and input modes on, a frame after each input batch, the modes off when the app is done.

use crate::keys::{self, Ev};
use crate::term::{self, Term};
use std::process::exit;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub enum Flow<T> {
    Go,
    Frame(String),
    Done(T),
}

pub trait App {
    type Out;
    /// The frame (or Done when drawing failed).
    fn render(&mut self, rows: i32, cols: i32) -> Flow<Self::Out>;
    fn handle(&mut self, ev: &Ev) -> Flow<Self::Out>;
    /// A buttonless motion: what to write instead of a frame, None to handle it as an event.
    fn hover(&mut self, _ev: &Ev) -> Option<String> {
        None
    }
    fn deadline(&self) -> Option<Instant> {
        None
    }
    /// Runs what is due; true to draw again.
    fn tick(&mut self) -> bool {
        false
    }
    /// Text for the clipboard, once.
    fn clipboard(&mut self) -> Option<String> {
        None
    }
}

/// Runs `app` until it is done; signals and a closed terminal end the process (after restoring the terminal).
pub fn run<A: App>(term: &mut Term, app: &mut A) -> A::Out {
    // The shape goes out with every frame: Herdr resets it on focus, tab switches and resizes.
    let cursor = crate::settings::load(&crate::settings::settings_file()).0.cursor_seq();
    term.write(&format!("{}{cursor}", term::ENTER));
    term::right_clicks_to("program", false);
    let end = |term: &mut Term| {
        term.write(term::LEAVE);
        term::right_clicks_to("menu", true);
    };
    let (mut pending, mut escape_at) = (String::new(), None::<Instant>);
    let mut draw = true;
    loop {
        if draw {
            let (rows, cols) = term.size();
            match app.render(rows, cols) {
                Flow::Frame(s) => term.write(&format!("\x1b[?2026h\x1b[?25l{cursor}{s}\x1b[?2026l")), // one synchronized update
                Flow::Done(v) => {
                    end(term);
                    return v;
                }
                Flow::Go => {}
            }
        }
        draw = false;
        let sig = term::SIGNAL.load(Ordering::Relaxed);
        if sig != 0 {
            end(term);
            term.restore();
            exit(128 + sig);
        }
        if term::take_close_request() {
            end(term); // nothing unsaved here: the hex viewer, the binary prompt, the error page
            term.restore();
            exit(0);
        }
        let deadline = [app.deadline(), escape_at].into_iter().flatten().min();
        let Some(chunk) = term.read(deadline.map(|d| d.saturating_duration_since(Instant::now()))) else {
            end(term);
            term.restore();
            exit(129)
        };
        let mut events = vec![];
        if !chunk.is_empty() {
            term::log_input(&chunk);
            pending.push_str(&String::from_utf8_lossy(&chunk));
            let (evs, rest) = keys::parse(&pending);
            pending = rest;
            escape_at = (!pending.is_empty()).then(|| Instant::now() + Duration::from_millis(50));
            draw |= evs.is_empty();
            events = evs;
        }
        if escape_at.is_some_and(|t| t <= Instant::now()) {
            escape_at = None;
            pending.clear();
            events.push(keys::key("escape"));
        }
        for ev in events {
            if let Ev::Focus(true) = ev {
                term::right_clicks_to("program", false); // again, in case Herdr hadn't adopted it yet
            }
            match app.hover(&ev) {
                Some(out) => {
                    if !out.is_empty() {
                        term.write(&out);
                    }
                }
                None => {
                    draw = true;
                    if let Flow::Done(v) = app.handle(&ev) {
                        end(term);
                        return v;
                    }
                }
            }
            if let Some(text) = app.clipboard() {
                term::write_clipboard(term, &text);
            }
        }
        draw |= term::take_resized() || app.tick();
    }
}
