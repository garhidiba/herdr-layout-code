//! VS Code's tokenizer (the vscode-textmate port) on a worker thread, so typing never waits for it (highlight.cjs's
//! Highlighter): per-line tokens and the rule stack after each line, re-tokenizing from an edit until a line ends in
//! the same state as before. Lines over 4,000 UTF-16 units are tokenized in ~1,000-unit pieces carrying the rule stack.
//! The worker owns the grammar (vscode-textmate is single-threaded); the editor mirrors the tokens.

use crate::buffer::Change;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};
use vscode_textmate::{Grammar, StateStack, Viewer};

const MAX_LINE: usize = 4000;
const CHUNK: usize = 1000;

pub const fn foreground_of(meta: u32) -> usize {
    ((meta & 0x00ff_8000) >> 15) as usize
}
pub const fn font_style_of(meta: u32) -> u32 {
    (meta & 0x0000_7800) >> 11
}
/// 0 code, 1 comment, 2 string, 3 regex.
pub const fn token_type_of(meta: u32) -> u32 {
    (meta >> 8) & 3
}

/// A line's tokens: (start byte offset, metadata), sorted, the first at 0.
pub type Tokens = Vec<(u32, u32)>;

/// The index of the token holding byte offset `i`.
pub fn token_index(tokens: &Tokens, i: usize) -> usize {
    tokens.partition_point(|t| t.0 as usize <= i).saturating_sub(1)
}

enum ToWorker {
    Reset { seq: u64, scope: Option<String>, lines: Vec<String> },
    Edit { seq: u64, change: Change, lines: Vec<String> },
}

enum FromWorker {
    Ready { seq: u64, color_map: Vec<Option<String>>, grammar: bool },
    Tokens { seq: u64, items: Vec<(usize, Vec<u32>)> },
}

/// The editor's side: the tokens of every line (None: not tokenized yet), kept aligned with the buffer.
pub struct Highlight {
    tx: Sender<ToWorker>,
    rx: Receiver<FromWorker>,
    pub tokens: Vec<Option<Tokens>>,
    pub color_map: Vec<Option<String>>,
    pub has_grammar: bool,
    /// True once the worker answered the last reset (the grammar is loaded, or there is none).
    pub ready: bool,
    seq: u64,
    reset_seq: u64,
    log: Vec<(u64, Change)>,
    /// Bumps whenever tokens arrive (caches keyed on token state use it).
    pub generation: u64,
}

impl Highlight {
    /// Starts the worker; `wake` is written to after each batch it sends.
    pub fn start(vscode: PathBuf, wake: impl Fn() + Send + 'static) -> Highlight {
        let (tx, worker_rx) = mpsc::channel();
        let (worker_tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("tokenizer".into())
            .spawn(move || Worker::new(vscode, worker_rx, worker_tx, Box::new(wake)).run())
            .expect("tokenizer thread");
        Highlight { tx, rx, tokens: vec![], color_map: vec![], has_grammar: false, ready: false, seq: 0, reset_seq: 0, log: vec![], generation: 0 }
    }

    /// Tokenizes `lines` with the grammar of `scope` (None: plain text) from scratch.
    pub fn reset(&mut self, scope: Option<&str>, lines: &[String]) {
        self.seq += 1;
        self.reset_seq = self.seq;
        self.tokens = vec![None; lines.len()];
        self.log.clear();
        self.ready = false;
        let _ = self.tx.send(ToWorker::Reset { seq: self.seq, scope: scope.map(str::to_string), lines: lines.to_vec() });
    }

    /// The buffer changed (its changes since the last call, in order); `lines` is the text after them.
    pub fn edited(&mut self, changes: &[Change], lines: &[String]) {
        let Some(c) = compose(changes) else { return };
        self.seq += 1;
        self.tokens.splice(c.start..c.start + c.removed, std::iter::repeat_n(None, c.inserted));
        self.log.push((self.seq, c));
        let _ = self.tx.send(ToWorker::Edit { seq: self.seq, change: c, lines: lines[c.start..c.start + c.inserted].to_vec() });
    }

    fn apply(&mut self, msg: FromWorker, lines: &[String]) {
        match msg {
            FromWorker::Ready { seq, color_map, grammar } => {
                if seq == self.reset_seq {
                    self.color_map = color_map.into_iter().map(|c| c.map(|s| s.chars().take(7).collect::<String>().to_lowercase())).collect();
                    self.has_grammar = grammar;
                    self.ready = true;
                    self.generation += 1;
                }
            }
            FromWorker::Tokens { seq, items } => {
                if seq < self.reset_seq {
                    return;
                }
                let later: Vec<Change> = self.log.iter().filter(|(s, _)| *s > seq).map(|(_, c)| *c).collect();
                'items: for (mut line, toks) in items {
                    for c in &later {
                        if line >= c.start + c.removed {
                            line = line + c.inserted - c.removed;
                        } else if line >= c.start {
                            continue 'items; // edited since: the worker tokenizes it again
                        }
                    }
                    if let (Some(text), Some(slot)) = (lines.get(line), self.tokens.get_mut(line)) {
                        *slot = Some(to_bytes(text, &toks));
                    }
                }
                self.log.retain(|(s, _)| *s > seq);
                self.generation += 1;
            }
        }
    }

    /// Takes what the worker sent; true when anything arrived.
    pub fn poll(&mut self, lines: &[String]) -> bool {
        let mut any = false;
        while let Ok(msg) = self.rx.try_recv() {
            self.apply(msg, lines);
            any = true;
        }
        any
    }

    /// Waits until `done(self)` or the deadline, taking the worker's batches as they come.
    pub fn wait(&mut self, lines: &[String], deadline: Instant, done: impl Fn(&Highlight) -> bool) -> bool {
        self.poll(lines);
        while !done(self) {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(msg) => self.apply(msg, lines),
                Err(RecvTimeoutError::Timeout) => return false,
                Err(RecvTimeoutError::Disconnected) => return false,
            }
        }
        true
    }

    /// Tokens of lines [first, last] are all there (or there is no grammar).
    pub fn has_lines(&self, first: usize, last: usize) -> bool {
        self.ready && (!self.has_grammar || (first..=last.min(self.tokens.len().saturating_sub(1))).all(|l| self.tokens.get(l).is_some_and(Option::is_some)))
    }

    pub fn line(&self, l: usize) -> Option<&Tokens> {
        self.tokens.get(l).and_then(Option::as_ref)
    }
}

/// Semantic colors over the TextMate tokens (LSP `semanticTokens`, tsserver's encoded classifications, mapped through
/// the theme: lang/semantic.rs). Empty unless the theme turns semantic highlighting on: painting asks `at(line, byte)` first.
/// Spans move with edits below them; spans on edited lines are dropped (the provider sends them again).
#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub fg: String,
    pub style: u32,
}

#[derive(Default)]
pub struct SemanticLayer {
    lines: Vec<Vec<Span>>,
}

impl SemanticLayer {
    pub fn reset(&mut self, lines: usize) {
        self.lines = vec![vec![]; lines];
    }
    /// Replaces a line's spans (sorted by start, not overlapping).
    pub fn set(&mut self, line: usize, spans: Vec<Span>) {
        if let Some(l) = self.lines.get_mut(line) {
            *l = spans;
        }
    }
    pub fn edited(&mut self, changes: &[Change]) {
        for c in changes {
            if c.start + c.removed <= self.lines.len() {
                self.lines.splice(c.start..c.start + c.removed, std::iter::repeat_n(vec![], c.inserted));
            }
        }
    }
    /// The span covering byte `i` of `line`.
    pub fn at(&self, line: usize, i: usize) -> Option<&Span> {
        self.lines.get(line)?.iter().find(|s| i >= s.start && i < s.end)
    }
}

/// One change covering a sequence of changes (each in the coordinates the previous one left).
pub fn compose(changes: &[Change]) -> Option<Change> {
    let (first, rest) = changes.split_first()?;
    // [s, e): the current lines that differ from the original; `removed`: how many original lines they replace
    let (mut s, mut e, mut removed) = (first.start, first.start + first.inserted, first.removed);
    for c in rest {
        let (u0, u1) = (s.min(c.start), e.max(c.start + c.removed));
        removed += (u1 - u0) - (e - s);
        s = u0;
        e = u1 - c.removed + c.inserted;
    }
    Some(Change { start: s, removed, inserted: e - s })
}

/// UTF-16 token starts -> byte offsets in `text`.
fn to_bytes(text: &str, toks: &[u32]) -> Tokens {
    let mut out = Vec::with_capacity(toks.len() / 2);
    let (mut unit, mut chars) = (0u32, text.char_indices().peekable());
    let mut byte = 0usize;
    for pair in toks.chunks_exact(2) {
        while unit < pair[0] {
            match chars.next() {
                Some((_, c)) => {
                    unit += c.len_utf16() as u32;
                    byte = chars.peek().map_or(text.len(), |(i, _)| *i);
                }
                None => break,
            }
        }
        out.push((byte as u32, pair[1]));
    }
    out
}

// ---------- the worker ----------

/// A long line's tokens built piece by piece (highlight.cjs LongLine): pieces end after a `;`/`}` where possible.
struct LongLine {
    text: String,
    prev: Option<StateStack>,
    /// (end byte, end UTF-16 unit, state after, token count)
    pieces: Vec<(usize, u32, Option<StateStack>, usize)>,
    pos: usize,
    unit: u32,
    state: Option<StateStack>,
    toks: Vec<u32>,
}

impl LongLine {
    fn new(text: String, prev: Option<StateStack>) -> LongLine {
        let state = prev.clone();
        LongLine { text, prev, pieces: vec![], pos: 0, unit: 0, state, toks: vec![] }
    }
    fn done(&self) -> bool {
        self.pos >= self.text.len()
    }
    fn restart(&mut self, k: usize) {
        self.pieces.truncate(k);
        match self.pieces.last() {
            Some((end, unit, state, n)) => {
                (self.pos, self.unit, self.state) = (*end, *unit, state.clone());
                self.toks.truncate(*n);
            }
            None => {
                (self.pos, self.unit, self.state) = (0, 0, self.prev.clone());
                self.toks.clear();
            }
        }
    }
    /// The text changed: keep the pieces before the first changed byte.
    fn retext(&mut self, text: String) {
        if text == self.text {
            return;
        }
        let d = text.bytes().zip(self.text.bytes()).take_while(|(a, b)| a == b).count();
        self.text = text;
        let k = self.pieces.iter().take_while(|p| p.0 < d).count();
        self.restart(k);
    }
    /// Where the piece starting at `pos` ends (byte, units).
    fn cut(&self) -> (usize, u32) {
        let rest = &self.text[self.pos..];
        let (mut unit, mut best, mut weak) = (0usize, None, None);
        for (i, c) in rest.char_indices() {
            if unit >= CHUNK {
                let end = best.or(weak).unwrap_or((i, unit));
                return (self.pos + end.0, self.unit + end.1 as u32);
            }
            unit += c.len_utf16();
            if unit > CHUNK / 2 {
                let after = (i + c.len_utf8(), unit);
                match c {
                    ';' | '}' => best = Some(after),
                    ',' | ' ' => weak = Some(after),
                    _ => {}
                }
            }
        }
        (self.text.len(), self.unit + unit as u32)
    }
    fn step(&mut self, grammar: &mut Grammar) {
        let (end, unit) = self.cut();
        let Ok(r) = grammar.tokenize_line2(&self.text[self.pos..end], self.state.as_ref(), Duration::ZERO) else {
            (self.pos, self.unit) = (self.text.len(), unit);
            return;
        };
        for pair in r.tokens.chunks_exact(2) {
            self.toks.extend([pair[0] + self.unit, pair[1]]);
        }
        (self.pos, self.unit, self.state) = (end, unit, Some(r.rule_stack));
        self.pieces.push((end, unit, self.state.clone(), self.toks.len()));
    }
    /// The tokens so far, then the default color for the rest.
    fn tokens(&self) -> Vec<u32> {
        let mut t = self.toks.clone();
        if !self.done() {
            t.extend([self.unit, 0]);
        }
        t
    }
}

struct Worker {
    vscode: PathBuf,
    rx: Receiver<ToWorker>,
    tx: Sender<FromWorker>,
    wake: Box<dyn Fn() + Send>,
    viewer: Option<Result<Viewer, String>>,
    grammars: HashMap<String, Grammar>,
    scope: Option<String>,
    seq: u64,
    lines: Vec<String>,
    states: Vec<Option<StateStack>>,
    long: Vec<Option<LongLine>>,
    valid_to: usize,
    edit_end: Option<usize>,
    out: Vec<(usize, Vec<u32>)>,
    flushed: Instant,
}

impl Worker {
    fn new(vscode: PathBuf, rx: Receiver<ToWorker>, tx: Sender<FromWorker>, wake: Box<dyn Fn() + Send>) -> Worker {
        Worker {
            vscode,
            rx,
            tx,
            wake,
            viewer: None,
            grammars: HashMap::new(),
            scope: None,
            seq: 0,
            lines: vec![],
            states: vec![],
            long: vec![],
            valid_to: 0,
            edit_end: None,
            out: vec![],
            flushed: Instant::now(),
        }
    }

    fn send(&mut self, msg: FromWorker) -> bool {
        let ok = self.tx.send(msg).is_ok();
        (self.wake)();
        ok
    }

    fn flush(&mut self) -> bool {
        self.flushed = Instant::now();
        if self.out.is_empty() {
            return true;
        }
        let items = std::mem::take(&mut self.out);
        self.send(FromWorker::Tokens { seq: self.seq, items })
    }

    fn grammar(&mut self) -> Option<&mut Grammar> {
        let scope = self.scope.as_ref()?;
        self.grammars.get_mut(scope)
    }

    fn handle(&mut self, msg: ToWorker) -> bool {
        match msg {
            ToWorker::Reset { seq, scope, lines } => {
                self.out.clear();
                self.seq = seq;
                let viewer = self.viewer.get_or_insert_with(|| vscode_textmate::viewer(&self.vscode));
                let mut loaded = false;
                if let (Ok(v), Some(s)) = (viewer.as_mut(), scope.as_ref()) {
                    if !self.grammars.contains_key(s) {
                        if let Ok(Some(g)) = v.registry.load_grammar(s) {
                            self.grammars.insert(s.clone(), g);
                        }
                    }
                    loaded = self.grammars.contains_key(s);
                }
                let color_map = match viewer {
                    Ok(v) => v.registry.color_map().to_vec(),
                    Err(_) => vec![],
                };
                self.scope = scope.filter(|_| loaded);
                self.states = vec![None; lines.len()];
                self.long = (0..lines.len()).map(|_| None).collect();
                self.lines = lines;
                self.valid_to = 0;
                self.edit_end = None;
                self.send(FromWorker::Ready { seq, color_map, grammar: loaded })
            }
            ToWorker::Edit { seq, change: c, lines } => {
                self.flush();
                self.seq = seq;
                let n = c.inserted;
                self.lines.splice(c.start..c.start + c.removed, lines);
                self.states.splice(c.start..c.start + c.removed, std::iter::repeat_n(None, n));
                let keep = if c.removed == 1 && n == 1 { self.long[c.start].take() } else { None };
                let mut fill: Vec<Option<LongLine>> = (0..n).map(|_| None).collect();
                if keep.is_some() {
                    fill[0] = keep;
                }
                self.long.splice(c.start..c.start + c.removed, fill);
                if let Some(e) = self.edit_end.as_mut() {
                    if *e >= c.start + c.removed {
                        *e = *e + n - c.removed;
                    }
                }
                let last = (c.start + n).saturating_sub(1);
                self.edit_end = Some(self.edit_end.map_or(last, |e| e.max(last)));
                self.valid_to = self.valid_to.min(c.start);
                true
            }
        }
    }

    /// Tokenizes the next line (or the next piece of a long one).
    fn step(&mut self) {
        let i = self.valid_to;
        let prev = if i > 0 { self.states[i - 1].clone() } else { None };
        let text = self.lines[i].clone();
        let Some(grammar) = self.scope.as_ref().and_then(|s| self.grammars.get_mut(s)) else { return };
        let (tokens, state) = if text.encode_utf16().count() > MAX_LINE {
            let lt = self.long[i].get_or_insert_with(|| LongLine::new(text.clone(), prev.clone()));
            let same = match (&lt.prev, &prev) {
                (None, None) => true,
                (Some(a), Some(b)) => a.equals(b),
                _ => false,
            };
            if !same {
                *lt = LongLine::new(text.clone(), prev.clone());
            } else {
                lt.retext(text);
            }
            lt.step(grammar);
            let tokens = lt.tokens();
            if !lt.done() {
                self.out.retain(|(l, _)| *l != i);
                self.out.push((i, tokens));
                return;
            }
            (tokens, lt.state.clone())
        } else {
            self.long[i] = None;
            match grammar.tokenize_line2(&text, prev.as_ref(), Duration::ZERO) {
                Ok(r) => (r.tokens, Some(r.rule_stack)),
                Err(_) => (vec![0, 0], prev.clone()),
            }
        };
        let old = self.states[i].take();
        self.out.retain(|(l, _)| *l != i);
        self.out.push((i, tokens));
        let converged = matches!((&old, &state), (Some(a), Some(b)) if a.equals(b));
        self.states[i] = state;
        self.valid_to = i + 1;
        if self.edit_end.is_none_or(|e| i > e) && converged {
            // the rest is unchanged: skip the lines still tokenized
            while self.valid_to < self.lines.len() && self.states[self.valid_to].is_some() {
                self.valid_to += 1;
            }
            self.edit_end = None;
        }
        if self.edit_end.is_some_and(|e| i >= e) {
            self.edit_end = None;
        }
    }

    fn pending(&mut self) -> bool {
        self.grammar().is_some() && self.valid_to < self.lines.len()
    }

    fn run(mut self) {
        loop {
            let msg = if self.pending() {
                match self.rx.try_recv() {
                    Ok(m) => Some(m),
                    Err(TryRecvError::Empty) => None,
                    Err(TryRecvError::Disconnected) => return,
                }
            } else {
                if !self.flush() {
                    return;
                }
                match self.rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => return,
                }
            };
            if let Some(m) = msg {
                if !self.handle(m) {
                    return;
                }
                continue;
            }
            self.step();
            if (self.flushed.elapsed() >= Duration::from_millis(12) || self.out.len() >= 256) && !self.flush() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composed_changes_cover_every_edited_line() {
        let c = |start, removed, inserted| Change { start, removed, inserted };
        assert_eq!(compose(&[c(5, 1, 1), c(2, 1, 3)]), Some(c(2, 4, 6)));
        assert_eq!(compose(&[c(0, 2, 1)]), Some(c(0, 2, 1)));
        assert_eq!(compose(&[c(3, 1, 2), c(3, 2, 1)]), Some(c(3, 1, 1)));
        assert_eq!(compose(&[]), None);
    }

    #[test]
    fn semantic_spans_move_with_edits_and_drop_on_edited_lines() {
        let mut layer = SemanticLayer::default();
        layer.reset(3);
        let span = Span { start: 0, end: 3, fg: "#e5c07b".into(), style: 0 };
        layer.set(1, vec![span.clone()]);
        layer.set(2, vec![span.clone()]);
        layer.edited(&[Change { start: 0, removed: 1, inserted: 2 }]); // a line inserted above
        assert_eq!(layer.at(2, 1), Some(&span));
        assert_eq!(layer.at(3, 2), Some(&span));
        layer.edited(&[Change { start: 2, removed: 1, inserted: 1 }]); // line 2 edited
        assert_eq!(layer.at(2, 1), None);
        assert_eq!(layer.at(3, 3), None);
    }

    #[test]
    fn utf16_starts_become_byte_offsets() {
        assert_eq!(to_bytes("a한b", &[0, 7, 1, 8, 2, 9]), vec![(0, 7), (1, 8), (4, 9)]);
        assert_eq!(to_bytes("😀x", &[0, 1, 2, 2]), vec![(0, 1), (4, 2)]);
        assert_eq!(token_index(&vec![(0, 0), (3, 1), (5, 2)], 4), 1);
    }
}
