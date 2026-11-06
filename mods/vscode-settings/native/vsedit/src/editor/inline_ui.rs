//! Inline suggestions in the editor (vsedit.cjs's inline* methods): the debounce, the request on a thread (its curl
//! killed when it goes stale), the ghost text's state and keys, the status bar item and the warm-up. Rules and
//! providers are inline.rs's; drawing the ghost text is view.rs's.

use super::Editor;
use crate::buffer::Pos;
use crate::inline::{self, Cancel, Config, Health};
use crate::keys::Ev;
use crate::term;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// The suggestion shown: where (file, text version, cursor) and its texts.
#[derive(Clone, Debug)]
pub struct Ghost {
    pub file: PathBuf,
    pub version: u64,
    pub at: Pos,
    pub items: Vec<String>,
    pub index: usize,
}

#[derive(Default)]
pub struct InlineState {
    pub ghost: Option<Ghost>,
    /// When the debounced request goes.
    due: Option<Instant>,
    cancel: Option<Arc<Cancel>>,
    gen: u64,
    pub busy: bool,
    error: Option<String>,
    /// Replies per (file, version, position, provider): reused instead of asking again.
    cache: Vec<(String, Vec<String>)>,
    health: HashMap<String, Health>,
    warmed: HashSet<String>,
    seen: Option<(PathBuf, u64, Pos)>,
    /// The event being handled edited by typing (asks again once typing pauses).
    pub editing: bool,
    cfg: Option<(inline::InlineSettings, Config)>,
}

/// Whether a provider can run here (the default of editor.inlineSuggest.enabled): Ollama installed, or an endpoint set.
fn usable(cfg: &Config) -> bool {
    static OLLAMA: OnceLock<bool> = OnceLock::new();
    cfg.custom_endpoint || (cfg.provider == "ollama" && *OLLAMA.get_or_init(|| term::which("ollama").is_some()))
}

impl Editor {
    pub fn inline_cfg(&mut self) -> Config {
        let s = &self.settings.inline;
        if self.inline.cfg.as_ref().is_none_or(|c| &c.0 != s) {
            self.inline.cfg = Some((s.clone(), inline::config(s, usable)));
        }
        self.inline.cfg.as_ref().unwrap().1.clone()
    }
    fn health(&mut self, cfg: &Config) -> &mut Health {
        self.inline.health.entry(cfg.key.clone()).or_insert_with(|| Health::new(cfg.stop_after))
    }
    fn text_chars(&self) -> usize {
        let mut n = 0;
        for t in &self.buf.lines {
            n += t.len() + 1;
            if n > inline::MAX_FILE_CHARS {
                break;
            }
        }
        n
    }
    fn limited(cfg: &Config) -> bool {
        cfg.limit > 0 && inline::usage_of(&cfg.key, &inline::usage_file(), &inline::today()).requests >= cfg.limit
    }
    /// Why no request may go now: None when one may; "ui" (an overlay or a selection) and "position" go unsaid.
    fn inline_blocked(&mut self, cfg: &Config, manual: bool) -> Option<String> {
        if !cfg.enabled {
            return Some("Inline suggestions are off (click their status bar item to turn them on)".into());
        }
        if let Some(p) = self.health(cfg).paused.clone() {
            return Some(format!("{} is paused: {p} (click its status bar item to resume)", cfg.label));
        }
        if self.popup.is_some() || self.prompt.is_some() || self.ls.peek.is_some() || !self.empty() {
            return Some("ui".into());
        }
        if inline::denied(&self.file, &cfg.exclude) {
            return Some("No inline suggestions for this file (editor.inlineSuggest.exclude)".into());
        }
        if self.text_chars() > inline::MAX_FILE_CHARS {
            return Some("The file is too large for inline suggestions".into());
        }
        let h = self.head();
        if !manual && !inline::at_suggestable(&self.buf.lines[h.line], h.col) {
            return Some("position".into());
        }
        if Self::limited(cfg) {
            return Some(format!("{}: today's limit of {} requests is reached (editor.inlineSuggest.dailyRequestLimit)", cfg.label, cfg.limit));
        }
        None
    }
    pub fn inline_cancel(&mut self) {
        self.inline.due = None;
        if let Some(c) = self.inline.cancel.take() {
            c.cancel();
            self.inline.gen += 1;
        }
        self.inline.busy = false;
    }
    /// After each event: the ghost goes when the text, the cursor or the file changed under it; an edit by typing asks
    /// again once typing pauses (auto trigger), any other change cancels what is pending.
    pub fn inline_after_event(&mut self) {
        let now = (self.file.clone(), self.buf.version, self.head());
        let stale = self.inline.ghost.as_ref().is_some_and(|g| g.file != self.file || g.version != self.buf.version || g.at != now.2);
        if stale || !self.empty() || self.popup.is_some() || self.prompt.is_some() {
            self.inline.ghost = None;
        }
        let editing = std::mem::take(&mut self.inline.editing);
        if self.inline.seen.as_ref() == Some(&now) {
            return;
        }
        let version_changed = self.inline.seen.as_ref().is_none_or(|s| s.1 != now.1);
        self.inline.seen = Some(now);
        if self.inline.ghost.is_some() {
            return;
        }
        if editing && version_changed {
            self.inline_schedule();
        } else {
            self.inline_cancel();
        }
    }
    fn inline_schedule(&mut self) {
        self.inline_cancel();
        let cfg = self.inline_cfg();
        if cfg.manual || self.inline_blocked(&cfg, false).is_some() {
            return;
        }
        self.inline.due = Some(Instant::now() + Duration::from_millis(cfg.debounce));
    }
    pub fn inline_deadline(&self) -> Option<Instant> {
        self.inline.due
    }
    /// Runs the debounced request when due; true to draw again.
    pub fn inline_tick(&mut self) -> bool {
        if self.inline.due.is_some_and(|t| t <= Instant::now()) {
            self.inline.due = None;
            self.inline_request(false);
            return true;
        }
        false
    }
    /// Asks the provider for the cursor's position (manual: Trigger Inline Suggestion, which says why it can't).
    pub fn inline_request(&mut self, manual: bool) {
        let cfg = self.inline_cfg();
        if let Some(why) = self.inline_blocked(&cfg, manual) {
            if manual && why != "ui" {
                self.warn(why);
            }
            return;
        }
        let (at, file, version) = (self.head(), self.file.clone(), self.buf.version);
        let key = format!("{}\0{version}\0{}\0{}\0{}\0{}", file.display(), at.line, at.col, cfg.key, cfg.multiline);
        if let Some((_, items)) = self.inline.cache.iter().find(|c| c.0 == key) {
            let items = items.clone();
            return self.inline_show(items, at, version);
        }
        let ctx = inline::context_at(&self.buf.lines, at.line, at.col, cfg.prefix_chars, cfg.suffix_chars);
        self.inline_cancel();
        let cancel = Arc::new(Cancel::default());
        self.inline.cancel = Some(cancel.clone());
        self.inline.gen += 1;
        let gen = self.inline.gen;
        self.inline.busy = true;
        let t0 = Instant::now();
        let work_cfg = cfg.clone();
        let req = inline::request(&work_cfg, &ctx);
        self.spawn(
            move || match inline::post(&req, &cancel) {
                Ok((status, json)) => Some(inline::reply(&work_cfg, status, &json)),
                Err(None) => None,
                Err(Some(e)) => Some(Err(inline::failure(&work_cfg, &e))),
            },
            move |ed, r| {
                let Some(r) = r else { return }; // cancelled
                if gen != ed.inline.gen {
                    return;
                }
                ed.inline.cancel = None;
                ed.inline.busy = false;
                let (texts, error) = match r {
                    Ok(t) => (t, None),
                    Err(e) => (vec![], Some(e)),
                };
                ed.inline.error = error.clone();
                let results: Vec<_> = texts.iter().map(|t| inline::clean(t, &ctx, cfg.multiline)).collect();
                let good: Vec<String> = results.iter().filter_map(|r| r.0.clone()).collect();
                let ms = error.is_none().then(|| t0.elapsed().as_millis() as u64);
                inline::record_usage(&cfg.key, ctx.prefix.chars().count() + ctx.suffix.chars().count(), texts.iter().map(|t| t.chars().count()).sum(), ms, &inline::usage_file(), &inline::today());
                let anomaly = if error.is_some() {
                    None
                } else if results.iter().any(|r| r.1 == Some("fim")) {
                    Some("fim")
                } else {
                    results.iter().find_map(|r| r.1).or(if results.is_empty() { Some("empty") } else { None })
                };
                let paused = ed.health(&cfg).record(anomaly, error.as_deref());
                let w = ed.c.warn.clone();
                if let Some(p) = paused {
                    ed.say(format!("{} paused: {p}", cfg.label), Some(&w), 8000);
                } else if let Some(e) = error {
                    ed.say(e, Some(&w), 6000);
                }
                if !good.is_empty() {
                    if ed.inline.cache.len() >= 50 {
                        ed.inline.cache.remove(0);
                    }
                    ed.inline.cache.push((key, good.clone()));
                    ed.inline_show(good, at, version);
                }
            },
        );
    }
    fn inline_show(&mut self, items: Vec<String>, at: Pos, version: u64) {
        if self.buf.version != version || self.head() != at || !self.empty() || self.popup.is_some() || self.prompt.is_some() {
            return;
        }
        self.inline.ghost = Some(Ghost { file: self.file.clone(), version, at, items, index: 0 });
    }
    /// The ghost text to paint: (line, byte col, its lines), None when none shows.
    pub fn ghost_view(&mut self) -> Option<(usize, usize, Vec<String>)> {
        let g = self.inline.ghost.clone()?;
        if g.file != self.file || g.version != self.buf.version || self.folds.is_hidden(g.at.line) {
            return None;
        }
        Some((g.at.line, g.at.col, g.items[g.index].split('\n').map(String::from).collect()))
    }
    /// A key or typed text while a suggestion shows: its commands (Tab, Esc, ⌘→ …, keymap.json's `when` keys), or typing
    /// what it starts with, which keeps the rest without asking again. True when handled here.
    pub fn inline_key(&mut self, ev: &Ev, term: &mut crate::term::Term) -> bool {
        let Some(g) = self.inline.ghost.clone() else { return false };
        match ev {
            Ev::Key(k) => match self.keys.keymap.suggest_command(&k.chord()) {
                Some(c) => {
                    self.run_command(c, Some(term));
                    true
                }
                None => false,
            },
            Ev::Text(t) => {
                let text = t.replace("\r\n", "\n").replace('\r', "\n");
                let mut order = vec![g.items[g.index].clone()];
                order.extend(g.items.iter().enumerate().filter(|(i, _)| *i != g.index).map(|(_, s)| s.clone()));
                let left = inline::type_through(&order, &text);
                self.typed(t);
                let h = self.head();
                if let Some(left) = left.filter(|_| h.line == g.at.line && !text.contains('\n')) {
                    let rest = self.buf.lines[h.line][h.col..].to_string();
                    let items: Vec<String> = left.iter().map(|s| inline::trim_line_suffix(s, &rest)).filter(|s| !s.is_empty()).collect();
                    if !items.is_empty() {
                        self.inline.ghost = Some(Ghost { version: self.buf.version, at: h, items, index: 0, ..g });
                        self.inline.editing = false;
                    }
                }
                true
            }
            _ => false,
        }
    }
    /// Tab: the whole suggestion; ⌘→ / Ctrl+→: up to the end of its next word, the rest still showing.
    pub fn inline_accept(&mut self, word: bool) {
        let Some(g) = self.inline.ghost.clone() else { return };
        let text = &g.items[g.index];
        let n = if word { inline::next_word_len(text) } else { text.len() };
        let (part, rest) = text.split_at(n);
        self.insert(part, false);
        self.buf.seal();
        self.inline.ghost = (!rest.is_empty()).then(|| Ghost { items: vec![rest.to_string()], index: 0, version: self.buf.version, at: self.head(), ..g });
    }
    pub fn inline_hide(&mut self) {
        self.inline.ghost = None;
        self.inline_cancel();
    }
    pub fn inline_cycle(&mut self, dir: i32) {
        if let Some(g) = self.inline.ghost.as_mut() {
            let n = g.items.len() as i32;
            g.index = ((g.index as i32 + dir).rem_euclid(n)) as usize;
        }
    }
    pub fn inline_trigger(&mut self) {
        self.inline.ghost = None;
        self.inline_request(true);
    }
    /// Loads the provider's model in the background once per provider and model (Ollama).
    pub fn inline_warmup(&mut self) {
        let cfg = self.inline_cfg();
        if !cfg.enabled || self.inline.warmed.contains(&cfg.key) {
            return;
        }
        let Some(req) = inline::warmup(&cfg) else { return };
        self.inline.warmed.insert(cfg.key.clone());
        std::thread::spawn(move || {
            let _ = inline::post(&req, &Cancel::default());
        });
    }
    /// The status bar item: the provider and its state (None while the provider is off or can't run here and nothing
    /// was set).
    pub fn inline_status(&mut self) -> Option<String> {
        let cfg = self.inline_cfg();
        if cfg.provider == "off" || (!cfg.enabled && self.settings.inline.enabled.is_none()) {
            return None;
        }
        let paused = self.health(&cfg).paused.is_some();
        let state = if !cfg.enabled {
            ": off"
        } else if paused {
            ": paused"
        } else if Self::limited(&cfg) {
            ": limit"
        } else if self.inline.busy {
            " …"
        } else if self.inline.error.is_some() {
            ": error"
        } else {
            ""
        };
        Some(format!("{}{state}", cfg.label))
    }
    /// What the pointer on the item shows: today's usage (and why the provider is paused).
    pub fn inline_usage(&mut self) -> String {
        let cfg = self.inline_cfg();
        let paused = self.health(&cfg).paused.clone().map(|p| format!("{} paused: {p} · ", cfg.label)).unwrap_or_default();
        paused + &inline::usage_text(&cfg, &inline::usage_of(&cfg.key, &inline::usage_file(), &inline::today()))
    }
    /// A click on the item: suggestions on/off (resuming a paused provider).
    pub fn toggle_inline(&mut self) {
        let cfg = self.inline_cfg();
        self.inline.health.remove(&cfg.key);
        self.inline.error = None;
        self.inline_hide();
        match crate::settings::update(&crate::settings::settings_file(), "editor.inlineSuggest.enabled", serde_json::json!(!cfg.enabled)) {
            Ok((v, st)) => {
                (self.settings, self.settings_stamp) = (v, st);
                self.say(format!("Inline suggestions {}", if cfg.enabled { "off" } else { "on" }), None, 3000);
            }
            Err(e) => self.error(format!("Cannot write settings: {e}"), 6000),
        }
        self.inline_warmup();
    }
}
