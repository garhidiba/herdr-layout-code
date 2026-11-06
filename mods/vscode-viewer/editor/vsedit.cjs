#!/usr/bin/env node
// A VS Code-like terminal editor: VS Code's own tokenizer and One Dark colors, VS Code's default keys for the OS it runs on
// (keymap.json; ⌘ through the Kitty keyboard protocol), its editor context menu and command palette, language intelligence (lang/),
// mouse, IME-friendly cursor, auto save and hot exit.
// usage: node vsedit.cjs <file>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const W = require("./width.cjs");
const { Buffer: TextBuffer, cmp, ordered, endOf, caret } = require("./buffer.cjs");
const F = require("./file.cjs");
const L = require("./language.cjs");
const H = require("./highlight.cjs");
const { parse } = require("./keys.cjs");
const { blend, paletteOf, Painter, fit } = require("./paint.cjs");
const C = require("./commands.cjs");
const O = require("./overlays.cjs");
const S = require("./settings.cjs");
const K = require("./keybindings.cjs");
const B = require("./backup.cjs");
// The language layer loads on first use (a server request, or shutdown when it was used), not before the first frame.
let langModule = null;
const Lang = new Proxy({}, { get: (_, k) => (langModule ??= require("./lang/index.cjs"))[k] });
const { applyWorkspaceEdit, lastFirst } = require("./lang/edits.cjs");
const { wordOccurrences, Fallback } = require("./lang/fallback.cjs");
const { gitRoot, run, which } = require("./lang/proc.cjs");
const T = require("./terminal.cjs");
const HV = require("./hexview.cjs");
const E = require("./errorpage.cjs");
const SB = require("./scrollbar.cjs");
const D = require("./decorations.cjs");
const A = require("./autoclose.cjs");
const FIND = require("./find.cjs");
const SYM = require("./symbols.cjs");
const G = require("./gitgutter.cjs");
const FD = require("./folding.cjs");
const SS = require("./smartselect.cjs");
const { editsWithin } = require("./lang/edits.cjs");
const I = require("./inline.cjs");
const WR = require("./wrap.cjs");

// VS Code's "Col": characters before the cursor, tabs counted to the next tab stop.
function visibleColumn(line, index, tab) {
  let c = 0;
  for (const ch of line.slice(0, index)) c = ch === "\t" ? c + tab - (c % tab) : c + 1;
  return c;
}

// ---------- word motion (VS Code: skip spaces, then one run of word chars or of punctuation) ----------
const classOf = (ch) => (/\s/.test(ch) ? 0 : /[\p{L}\p{N}_$]/u.test(ch) ? 1 : 2);
function wordRight(line, col) {
  while (col < line.length && classOf(line[col]) === 0) col++;
  const c = classOf(line[col] ?? " ");
  while (col < line.length && classOf(line[col]) === c && c !== 0) col++;
  return col;
}
function wordLeft(line, col) {
  while (col > 0 && classOf(line[col - 1]) === 0) col--;
  const c = classOf(line[col - 1] ?? " ");
  while (col > 0 && classOf(line[col - 1]) === c && c !== 0) col--;
  return col;
}

// Closers on `line` at or after `col` moved by `delta` columns (an insert or delete there).
const shiftClosers = (at, line, col, delta) => at.map(q => (q.line === line && q.col >= col ? { line, col: q.col + delta } : q));

// ---------- the editor ----------
const DOC_FIELDS = ["file", "doc", "buf", "hl", "indent", "scope", "language", "comment", "crumbs", "root", "session", "sel", "goal", "top", "topSub", "left", "seenVersion", "outline", "git", "folds", "lenses", "wrapToggle", "wrapRows"];
const GIT_GLYPHS = { added: "▎", modified: "▎", deletedBelow: "▁", deletedAbove: "▔" };
const GIT_COLORS = { added: "gitAdded", modified: "gitModified", deletedBelow: "gitDeleted", deletedAbove: "gitDeleted" };
const WORD_DELAY = 250; // ms the cursor rests on a word before its occurrences highlight, like VS Code
const HOVER_DELAY = 300; // ms the pointer rests on a word before its hover shows (VS Code's editor.hover.delay)
const CURSOR_STACK = 50; // cursor states Cursor Undo keeps, like VS Code
const NOT_FOUND = { definition: "definition", typeDefinition: "type definition", implementation: "implementation", references: "references" };
const PEEK_TITLE = { definition: "Definition", typeDefinition: "Type Definition", implementation: "Implementations", references: "References" };
// Commands the find widget runs itself while it has the keys (the rest of its keys are its own).
const WIDGET_COMMANDS = new Set(["toggleFindCaseSensitive", "toggleFindWholeWord", "toggleFindRegex", "toggleFindInSelection", "editor.action.replaceOne", "editor.action.replaceAll"]);
const NO_LENSES = new Map();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stampText = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

class Editor {
  // settings: S.normalize()d values (the file is read by main, not here).
  constructor(file, doc, { grammar, colorMap, textmate }, theme, scope, settings = S.normalize()) {
    this.theme = theme; this.textmate = textmate; this.settings = settings;
    this.keymap = K.resolve(); // main() swaps in the user's (vscode-keybindings.json)
    this.colors = paletteOf(theme.colors);
    this.colorMap = this.colorsOf(colorMap);
    this.docs = new Map(); this.loading = new Map(); this.fileLines = new Map();
    Object.assign(this, this.makeState(file, doc, grammar, scope));
    this.prompt = null; this.message = null; this.chordPrefix = null;
    this.find = { query: "", replace: "", field: "query", matches: [], version: -1, caseSensitive: false, wholeWord: false, regex: false, scope: null };
    this.popup = null; this.panel = null; this.peek = null; // overlays (popup: menu, picker, input or dialog)
    this.back = []; this.forward = [];                       // navigation history: { file, pos, top }
    this.clip = { text: "", whole: false };
    this.lastClick = { time: 0, line: -1, col: -1 }; this.dragging = false;
    this.rows = 24; this.cols = 80;
    this.vbar = new SB.Bar(true); this.hbar = new SB.Bar(false); this.marks = null; // scrollbars, laid out each frame
    this.wraps = new WR.Cache(); // each line's rows while word wrap is on
    this.redraw = () => {}; this.onExit = null; this.autoTimer = null;
    // inline suggestions: the ghost text shown, the debounce timer, the request in flight (abort), replies per position
    this.inline = { ghost: null, timer: null, abort: null, gen: 0, busy: false, error: null, cache: new Map(), health: new Map(),
      warmed: new Set(), models: new Map(), keys: new Map(), seen: null, editing: false };
  }

  // Everything that belongs to one open file; switching files swaps these fields.
  makeState(file, doc, grammar, scope) {
    const buf = new TextBuffer(doc.lines), hl = new H.Highlighter(grammar, this.textmate.INITIAL, buf.lines);
    buf.listeners.push((s, r, n) => hl.onEdit(s, r, n));
    const git = new G.GitGutter(file, buf, () => this.redraw());
    buf.listeners.push(() => git.changed());
    const folds = new FD.Folds();
    buf.listeners.push((s, r, n) => folds.onEdit(s, r, n));
    const lenses = { version: -1, items: [] }; // CodeLens as of a text version, moved along with edits until new ones come
    buf.listeners.push((s, r, n) => { if (lenses.items.length) lenses.items = D.shiftLines(lenses.items, s, r, n); });
    // rows per line while wrapping, -1 where an edit changed the line (recounted on the next rowIndex())
    const wrapRows = { key: "", counts: [], start: null, version: -1, foldVersion: -1 };
    buf.listeners.push((s, r, n) => {
      if (!wrapRows.key) return;
      const c = wrapRows.counts;
      if (r === n) { for (let k = s; k < s + n; k++) c[k] = -1; return; } // typing within lines
      const tail = c.splice(s + r);
      c.length = s;
      for (let k = 0; k < n; k++) c.push(-1);
      for (const x of tail) c.push(x);
    });
    const fallback = { useTabs: !this.settings["editor.insertSpaces"], size: this.settings["editor.tabSize"] };
    return { file, doc, buf, hl, indent: F.detectIndent(buf.lines, fallback), scope, language: L.languageName(grammar ? scope : null),
      comment: L.commentOf(scope), crumbs: breadcrumbs(file), root: gitRoot(file), session: null, sel: caret({ line: 0, col: 0 }),
      goal: null, top: 0, topSub: 0, left: 0, seenVersion: 0, outline: null, git, folds, lenses, wrapToggle: null, wrapRows };
  }
  colorsOf(colorMap) { return colorMap.map(c => (c ? c.slice(0, 7).toLowerCase() : this.colors.fg)); }
  // The grammar arrives after the first, uncolored frame (main paints before loading it).
  useGrammar({ grammar, colorMap, textmate }) {
    this.textmate = textmate; this.colorMap = this.colorsOf(colorMap);
    this.hl.reset(grammar, textmate.INITIAL);
    this.language = L.languageName(grammar ? this.scope : null);
  }
  snapshot() { const st = {}; for (const k of DOC_FIELDS) st[k] = this[k]; return st; }
  activate(st) { this.docs.set(this.file, this.snapshot()); Object.assign(this, st); this.docs.set(st.file, st); }
  // The current file first, then every other open file.
  allStates() { return [this.snapshot(), ...[...this.docs.values()].filter(s => s.file !== this.file)]; }
  get lang() { return (this.session ??= new Lang.Session(this.file, this.scope)); }
  get index() { return (this._index ??= H.loadIndex()); }

  get lines() { return this.buf.lines; }
  get tab() { return this.indent.size; }
  get head() { return this.sel.head; }
  get empty() { return cmp(this.sel.anchor, this.sel.head) === 0; }
  // Text rows and columns, less the scrollbars of the last frame (the row above the status bar, the last column).
  get height() { return Math.max(1, this.rows - 2 - (this.panel ? this.panel.height(this) : 0) - (this.hbar.shown ? 1 : 0)); }
  get gutter() { return Math.max(3, String(this.lines.length).length) + 3; }
  get textWidth() { return Math.max(1, this.cols - this.gutter - (this.vbar.shown ? 1 : 0)); }
  range() { return ordered(this.sel.anchor, this.sel.head); }
  // ----- word wrap (wrap.cjs): editor.wordWrap, or Toggle Word Wrap's choice for this file -----
  get wordWrap() { return this.wrapToggle ?? this.settings["editor.wordWrap"]; }
  // Columns a row holds, 0 while not wrapping. "on" leaves the scrollbar's column and one for the caret free.
  get wrapWidth() {
    const mode = this.wordWrap, view = Math.max(1, this.cols - this.gutter - 2), col = this.settings["editor.wordWrapColumn"];
    return mode === "on" ? view : mode === "bounded" ? Math.min(view, col) : mode === "wordWrapColumn" ? col : 0;
  }
  // A line's rows (WR.ONE while not wrapping or when it fits).
  wrapOf(line) { const w = this.wrapWidth; return w ? this.wraps.get(this.lines[line], w, this.tab, this.settings["editor.wrappingIndent"]) : WR.ONE; }
  // p's row within its line and its x there (cells from the row's left edge, the wrap indent included).
  rowPos(p) { const r = this.wrapOf(p.line), sub = WR.rowOf(r, p.col); return { sub, x: WR.xOf(r, sub, this.lines[p.line], p.col, this.tab) }; }
  // VS Code's Toggle Word Wrap: off <-> on (or the configured mode), for this file and session.
  toggleWordWrap() {
    const set = this.settings["editor.wordWrap"], next = this.wordWrap === "off" ? (set === "off" ? "on" : set) : "off";
    this.wrapToggle = next === set ? null : next; this.left = 0; this.reveal();
  }
  // While wrapping: the first view row of each line (hidden lines: the next line's), for the text, folds and width;
  // only the lines edited since are wrapped again.
  rowIndex() {
    const w = this.wrapWidth;
    if (!w) return null;
    const st = this.wrapRows, mode = this.settings["editor.wrappingIndent"], key = `${w}:${this.tab}:${mode}`, lines = this.lines, n = lines.length;
    if (st.key === key && st.version === this.buf.version && st.foldVersion === this.folds.version) return st.start;
    if (st.key !== key || st.counts.length !== n) { st.key = key; st.counts = new Array(n).fill(-1); }
    const counts = st.counts, start = st.start?.length === n + 1 ? st.start : new Int32Array(n + 1);
    for (let l = 0; l < n; l++) if (counts[l] < 0) counts[l] = this.wraps.get(lines[l], w, this.tab, mode).starts.length;
    let v = 0;
    if (!this.folds.any) for (let l = 0; l < n; l++) { start[l] = v; v += counts[l]; }
    else for (let l = 0; l < n;) {
      const next = this.folds.next(l);
      start[l] = v; v += counts[l];
      for (let h = l + 1; h < next && h < n; h++) start[h] = v;
      l = next;
    }
    start[n] = v;
    Object.assign(st, { start, version: this.buf.version, foldVersion: this.folds.version });
    return start;
  }
  // View rows (the lines collapsed folds hide skipped, a wrapped line's rows each) <-> buffer lines; `top` is always a
  // visible line, `topSub` its first row shown.
  toView(line) { const s = this.rowIndex(); return s ? s[this.folds.visible(line)] : this.folds.toView(line); }
  fromView(v) {
    const s = this.rowIndex();
    if (!s) return this.folds.fromView(v);
    let lo = 0, hi = this.lines.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= v) lo = mid; else hi = mid - 1; }
    return this.folds.visible(lo);
  }
  get viewCount() { const s = this.rowIndex(); return s ? s[this.lines.length] : this.folds.viewCount(this.lines.length); }
  get topRow() { return this.toView(this.top) + this.topSub; }
  viewRow(p) { return this.toView(p.line) + this.rowPos(p).sub; } // p's view row
  // Scrolls view row v (clamped to [0, max]) to the first text row.
  scrollTo(v, max = this.viewCount - 1) {
    v = Math.max(0, Math.min(Math.max(0, max), v));
    this.top = this.fromView(v); this.topSub = Math.max(0, v - this.toView(this.top));
  }
  scrollBy(rows, max) { this.scrollTo(this.topRow + rows, max); }
  say(text, color = this.colors.barFg, ms = 3000) { this.message = { text, color, until: Date.now() + ms }; }

  // ----- cursor -----
  moveTo(p, extend = false, keepGoal = false) {
    p = this.buf.clamp(p);
    this.sel = extend ? { anchor: this.sel.anchor, head: p } : caret(p);
    if (!keepGoal) this.goal = null;
    this.buf.seal();
    this.reveal();
  }
  reveal() {
    const { line, col } = this.head;
    this.folds.reveal(line); // the cursor in a fold opens it
    const { sub, x } = this.rowPos({ line, col }), v = this.toView(line) + sub, row = v - this.topRow;
    if (row < 0) this.scrollTo(v);
    if (row >= this.height) this.scrollTo(v - this.height + 1);
    while (this.topRow < v && this.rowsTo(line, sub) >= this.height) this.scrollBy(1); // CodeLens rows take room too
    if (x < this.left) this.left = Math.max(0, x - 4);
    if (x >= this.left + this.textWidth) this.left = x - this.textWidth + 5;
  }
  vertical(delta, extend) {
    const { line } = this.head, { sub, x } = this.rowPos(this.head);
    if (this.goal == null) this.goal = x;
    const v = this.toView(line) + sub + delta, end = this.viewCount - 1; // by view rows: over folds and wrapped rows
    if (v < 0) return this.moveTo({ line: 0, col: 0 }, extend);
    if (v > end) { const l = this.fromView(end); return this.moveTo({ line: l, col: this.lines[l].length }, extend); }
    const target = this.fromView(v);
    this.moveTo({ line: target, col: WR.colAt(this.wrapOf(target), v - this.toView(target), this.lines[target], this.goal, this.tab) }, extend, true);
  }
  horizontal(dir, extend, word) {
    if (!extend && !this.empty && !word) return this.moveTo(this.range()[dir < 0 ? 0 : 1]);
    let { line, col } = this.head;
    const text = this.lines[line];
    if (dir < 0) {
      if (col === 0) { if (line > 0) { line--; col = this.lines[line].length; } }
      else col = word ? wordLeft(text, col) : W.prevIndex(text, col);
    } else {
      if (col >= text.length) { if (line < this.lines.length - 1) { line++; col = 0; } }
      else col = word ? wordRight(text, col) : W.nextIndex(text, col);
    }
    this.moveTo({ line, col }, extend);
  }
  // VS Code's cursorHome: on a wrapped row past its start, the row's start; else the first non-blank, then column 0.
  home(extend) {
    const { line, col } = this.head, r = this.wrapOf(line), sub = WR.rowOf(r, col), first = this.lines[line].search(/\S|$/);
    this.moveTo({ line, col: sub && col !== r.starts[sub] ? r.starts[sub] : col === first ? 0 : first }, extend);
  }
  // The cursor row's start / end (cursorLineStart, cursorLineEnd: `row`); cursorEnd: the row's end, then the line's.
  lineEdge(end, extend, row = false) {
    const { line, col } = this.head, text = this.lines[line], r = this.wrapOf(line), sub = WR.rowOf(r, col), e = WR.rowEnd(r, sub, text);
    this.moveTo({ line, col: !end ? r.starts[sub] : row || col !== e ? e : text.length }, extend);
  }
  docEdge(end, extend) { const last = this.lines.length - 1; this.moveTo(end ? { line: last, col: this.lines[last].length } : { line: 0, col: 0 }, extend); }
  page(dir, extend) {
    const d = dir * this.height;
    this.scrollBy(d, this.viewCount - this.height);
    this.vertical(d, extend);
  }
  scrollLine(dir) { this.scrollBy(dir); }

  // ----- editing -----
  // Replaces the selection (or the given range) with text, as one undo step.
  insert(text, kind = null) {
    const before = this.sel, [s, e] = this.range();
    this.buf.edit([{ start: s, end: e, text }], { before, after: caret(endOf(s, text)), kind });
    this.sel = caret(endOf(s, text)); this.goal = null; this.reveal(); // no seal: typing keeps grouping
  }
  typed(text) {
    text = text.replace(/\r\n?/g, "\n");
    if (text.length > 1 && !text.includes("\n") && /[()[\]{}"'`]/.test(text)) { for (const ch of text) this.typed(ch); return; } // a fast-typed chunk, key by key
    const closers = this.liveClosers(), { line, col } = this.head, empty = this.empty;
    if (this.autoClose(text, closers)) return;
    this.insert(text, text.includes("\n") ? null : "type");
    if (empty && !text.includes("\n")) this.setClosers(shiftClosers(closers, line, col, text.length));
  }

  // ----- auto-closing pairs -----
  // Closers the editor inserted itself ({ line, col }), valid until an edit they weren't moved along with.
  liveClosers() { const c = this.closers; return c && c.buf === this.buf && c.version === this.buf.version ? c.at : []; }
  setClosers(at) { this.closers = { buf: this.buf, version: this.buf.version, at }; }
  // Typing `ch` steps over an auto-inserted closer, wraps the selection or inserts a pair (autoclose.cjs); false: a plain insert.
  autoClose(ch, closers) {
    const { line, col } = this.head, text = this.lines[line], pairs = A.pairsOf(this.scope);
    const isCloser = closers.some(q => q.line === line && q.col === col);
    this.hl.ensure(line, Date.now() + 20);
    const action = A.onType(ch, { pairs, text, col, selected: !this.empty, closer: isCloser,
      inText: A.inStringOrComment(this.hl.tokens[line] ?? null, text, col) });
    if (action === "over") { this.moveTo({ line, col: col + 1 }); this.setClosers(closers.filter(q => q.line !== line || q.col !== col)); }
    else if (action === "wrap") {
      const [s, e] = this.range(), before = this.sel, shift = (p) => (p.line === s.line ? { line: p.line, col: p.col + 1 } : p);
      const after = { anchor: shift(before.anchor), head: shift(before.head) };
      this.buf.edit([{ start: e, text: pairs[ch] }, { start: s, text: ch }], { before, after });
      this.sel = after; this.buf.seal(); this.reveal();
    } else if (action === "pair") {
      const at = { line, col: col + 1 };
      this.buf.edit([{ start: this.head, text: ch + pairs[ch] }], { before: this.sel, after: caret(at), kind: "type" });
      this.sel = caret(at); this.goal = null; this.reveal();
      this.setClosers([...shiftClosers(closers, line, col, 2), at]);
    }
    return !!action;
  }
  deleteRange(s, e) {
    if (cmp(s, e) === 0) return;
    const before = this.sel;
    this.buf.edit([{ start: s, end: e, text: "" }], { before, after: caret(s) });
    this.moveTo(s);
  }
  backspace(word) {
    if (!this.empty) return this.deleteRange(...this.range());
    const { line, col } = this.head, text = this.lines[line], closers = this.liveClosers();
    if (col === 0) return line > 0 && this.deleteRange({ line: line - 1, col: this.lines[line - 1].length }, this.head);
    const closer = closers.some(q => q.line === line && q.col === col);
    if (!word && A.deletesPair({ pairs: A.pairsOf(this.scope), text, col, closer })) { // between an auto-closed empty pair: both go
      this.deleteRange({ line, col: col - 1 }, { line, col: col + 1 });
      return this.setClosers(shiftClosers(closers.filter(q => q.line !== line || q.col !== col), line, col, -2));
    }
    let to = word ? wordLeft(text, col) : W.prevIndex(text, col);
    const lead = text.slice(0, col);
    if (!word && !this.indent.useTabs && /^ +$/.test(lead)) to = Math.max(0, col - (((col - 1) % this.tab) + 1)); // to the previous tab stop
    this.deleteRange({ line, col: to }, this.head);
    this.setClosers(shiftClosers(closers, line, col, to - col));
  }
  // ⌘⌫ / ⌘⌦ (⌃K): the selection, else to the line's start / end; at the start / end, the line break (VS Code's).
  deleteAll(dir) {
    if (!this.empty) return this.deleteRange(...this.range());
    const { line, col } = this.head, len = this.lines[line].length;
    if (dir < 0) this.deleteRange(col === 0 && line > 0 ? { line: line - 1, col: this.lines[line - 1].length } : { line, col: 0 }, this.head);
    else this.deleteRange(this.head, col === len && line < this.lines.length - 1 ? { line: line + 1, col: 0 } : { line, col: len });
  }
  deleteForward(word) {
    if (!this.empty) return this.deleteRange(...this.range());
    const { line, col } = this.head, text = this.lines[line];
    if (col >= text.length) return line < this.lines.length - 1 && this.deleteRange(this.head, { line: line + 1, col: 0 });
    this.deleteRange(this.head, { line, col: word ? wordRight(text, col) : W.nextIndex(text, col) });
  }
  unit(atCol = 0) { return this.indent.useTabs ? "\t" : " ".repeat(this.tab - (atCol % this.tab)); }
  enter() {
    const [s, e] = this.range(), text = this.lines[s.line];
    const indent = text.slice(0, s.col).match(/^[\t ]*/)[0];
    const before = text.slice(0, s.col).trimEnd().slice(-1), after = this.lines[e.line].slice(e.col).trimStart()[0];
    const pair = { "{": "}", "[": "]", "(": ")" }[before];
    if (pair) {
      const inner = indent + this.unit();
      if (after === pair) {
        const sel = this.sel, at = { line: s.line + 1, col: inner.length };
        this.buf.edit([{ start: s, end: e, text: "\n" + inner + "\n" + indent }], { before: sel, after: caret(at) });
        return this.moveTo(at);
      }
      return this.insert("\n" + inner);
    }
    this.insert("\n" + indent);
  }
  // Lines touched by the selection (a selection ending at column 0 doesn't include that line).
  selectedLines() {
    const [s, e] = this.range();
    return [s.line, e.line > s.line && e.col === 0 ? e.line - 1 : e.line];
  }
  // Applies per-line edits [{ line, col, remove, text }] as one step, shifting the selection along.
  lineEdits(edits) {
    if (!edits.length) return;
    const before = this.sel, shift = (p) => {
      let col = p.col;
      for (const ed of edits) if (ed.line === p.line && p.col >= ed.col) col = Math.max(ed.col, col - Math.min(ed.remove, p.col - ed.col)) + ed.text.length;
      return { line: p.line, col };
    };
    const after = { anchor: shift(this.sel.anchor), head: shift(this.sel.head) };
    this.buf.edit(edits.map(ed => ({ start: { line: ed.line, col: ed.col }, end: { line: ed.line, col: ed.col + ed.remove }, text: ed.text })), { before, after });
    this.sel = after; this.buf.seal(); this.reveal();
  }
  indentLines(out) {
    const [a, b] = this.selectedLines(), edits = [];
    for (let l = a; l <= b; l++) {
      const text = this.lines[l];
      if (out) {
        const m = text.match(this.indent.useTabs ? /^\t| {1,4}/ : new RegExp(`^(\\t| {1,${this.tab}})`));
        if (m && m.index === 0) edits.push({ line: l, col: 0, remove: m[0].length, text: "" });
      } else if (text.length || a === b) edits.push({ line: l, col: 0, remove: 0, text: this.unit() });
    }
    this.lineEdits(edits);
  }
  tabKey(shift) {
    const [s, e] = this.range();
    if (shift || s.line !== e.line) return this.indentLines(shift);
    this.insert(this.unit(W.displayCol(this.lines[s.line], s.col, this.tab)));
  }
  // Toggle / Add / Remove Line Comment (VS Code's LineCommentCommand). mode: undefined toggles (all non-blank lines
  // commented: uncomment, else comment them); "add" comments every non-blank line (⌘K ⌘C), "remove" uncomments the
  // commented ones (⌘K ⌘U). Lines that are all blank get comments too; comments go at the smallest indent. A language
  // without line comments (CSS, HTML, Markdown) gets one block comment around the lines instead, whatever the mode.
  toggleComment(mode) {
    if (!this.comment) return this.say(`No comment syntax known for ${this.language}`, this.colors.warn);
    if (this.comment.block) return this.blockCommentLines();
    const [a, b] = this.selectedLines(), open = this.comment.line;
    const lead = (t) => t.match(/^[\t ]*/)[0].length;
    const isCommented = (l) => this.lines[l].slice(lead(this.lines[l])).startsWith(open);
    let rows = [];
    for (let l = a; l <= b; l++) if (this.lines[l].trim()) rows.push(l);
    if (!rows.length && mode !== "remove") for (let l = a; l <= b; l++) rows.push(l);
    if (mode === "remove") rows = rows.filter(isCommented);
    if (!rows.length) return;
    const commented = mode ? mode === "remove" : rows.every(isCommented);
    const edits = [];
    if (commented) {
      for (const l of rows) {
        const t = this.lines[l], at = lead(t), sp = t[at + open.length] === " " ? 1 : 0;
        edits.push({ line: l, col: at, remove: open.length + sp, text: "" });
      }
    } else {
      const at = Math.min(...rows.map(l => lead(this.lines[l])));
      for (const l of rows) edits.push({ line: l, col: at, remove: 0, text: open + " " });
    }
    this.lineEdits(edits);
  }
  // A line comment command where the language has only block comments: the block comment around the selection goes
  // when there is one, else one goes around the selected lines (the cursor line's text when nothing is selected); the
  // selection stays on the same text.
  blockCommentLines() {
    const pair = this.comment.block, [s, e] = this.range(), before = this.sel;
    let { edits, removed } = this.blockCommentEdits(s, e, pair);
    if (!removed) {
      const t = this.lines[s.line], from = this.empty ? { line: s.line, col: t.search(/\S|$/) } : { line: s.line, col: 0 };
      ({ edits } = this.blockCommentEdits(from, this.empty ? { line: s.line, col: t.length } : { line: e.line, col: this.lines[e.line].length }, pair));
    }
    const through = (p) => edits.reduce((q, ed) => { // edits are on single lines, last first
      const end = ed.end ?? ed.start;
      if (q.line !== ed.start.line || q.col <= ed.start.col) return q;
      return { line: q.line, col: q.col >= end.col ? q.col + ed.text.length - (end.col - ed.start.col) : ed.start.col };
    }, p);
    const after = { anchor: through(before.anchor), head: through(before.head) };
    this.buf.edit(edits, { before, after });
    this.sel = after; this.buf.seal(); this.reveal();
  }
  // Toggle Block Comment (VS Code's BlockCommentCommand): with the selection between the language's block comment tokens
  // (on its first and last line) they go, with one space inside each; else they wrap the selection with a space inside,
  // the text staying selected; an empty selection gets `/*  */` with the cursor in the middle.
  blockComment() {
    const pair = L.blockCommentOf(this.scope);
    if (!pair) return this.say(`No block comment syntax known for ${this.language}`, this.colors.warn);
    const [s, e] = this.range(), before = this.sel, { edits, after } = this.blockCommentEdits(s, e, pair);
    this.buf.edit(edits, { before, after });
    this.sel = after; this.buf.seal(); this.reveal();
  }
  // The edits (single-line, last first) toggling the block comment `[open, close]` on [s, e], the selection after them,
  // and whether they remove one.
  blockCommentEdits(s, e, [open, close]) {
    const first = this.lines[s.line], last = this.lines[e.line], empty = cmp(s, e) === 0;
    let a = first.lastIndexOf(open, s.col + open.length);
    let b = last.indexOf(close, Math.max(0, e.col - close.length, s.line === e.line && a !== -1 ? a + open.length : 0)); // `/**/`: not the shared `*`
    if (a !== -1 && b !== -1 && (s.line === e.line ? first.substring(a + open.length, b) : first.substring(a + open.length) + "\n" + last.substring(0, b)).includes(close)) a = b = -1;
    let edits, after;
    if (a !== -1 && b !== -1) {
      if (first[a + open.length] === " ") open += " ";
      if (b > 0 && last[b - 1] === " ") { close = " " + close; b--; }
      const shift = s.line === e.line ? open.length : 0;
      edits = [{ start: { line: e.line, col: b }, end: { line: e.line, col: b + close.length }, text: "" },
        { start: { line: s.line, col: a }, end: { line: s.line, col: a + open.length }, text: "" }];
      after = { anchor: { line: s.line, col: a }, head: { line: e.line, col: b - shift } };
      if (s.line === e.line && a + open.length >= b) { // nothing inside (`/*  */`): the whole comment goes
        edits = [{ start: { line: s.line, col: a }, end: { line: s.line, col: Math.max(a + open.length, b + close.length) }, text: "" }];
        after = caret({ line: s.line, col: a });
      }
    } else if (empty) {
      edits = [{ start: s, text: `${open}  ${close}` }];
      after = caret({ line: s.line, col: s.col + open.length + 1 });
    } else {
      const shift = s.line === e.line ? open.length + 1 : 0;
      edits = [{ start: e, text: " " + close }, { start: s, text: open + " " }];
      after = { anchor: { line: s.line, col: s.col + open.length + 1 }, head: { line: e.line, col: e.col + shift } };
    }
    return { edits, after, removed: a !== -1 && b !== -1 };
  }

  // ----- clipboard -----
  copy(cut) {
    let text, whole = false;
    if (this.empty) { whole = true; text = this.lines[this.head.line] + "\n"; }
    else text = this.buf.getText(...this.range());
    this.clip = { text, whole };
    writeClipboard(text);
    if (!cut) return;
    if (!whole) return this.deleteRange(...this.range());
    const l = this.head.line, last = this.lines.length - 1;
    if (last === 0) return this.deleteRange({ line: 0, col: 0 }, { line: 0, col: this.lines[0].length });
    const s = l < last ? { line: l, col: 0 } : { line: l - 1, col: this.lines[l - 1].length };
    const e = l < last ? { line: l + 1, col: 0 } : { line: l, col: this.lines[l].length };
    this.deleteRange(s, e);
    this.moveTo({ line: Math.min(l, this.lines.length - 1), col: 0 });
  }
  paste(text) {
    text = (text ?? readClipboard() ?? this.clip.text).replace(/\r\n?/g, "\n");
    if (!text) return;
    if (this.clip.whole && text === this.clip.text && this.empty) {
      // A whole line copied with an empty selection goes above the current line, like VS Code.
      const p = { line: this.head.line, col: 0 }, sel = this.sel, at = { line: this.head.line + 1, col: this.head.col };
      this.buf.edit([{ start: p, end: p, text }], { before: sel, after: caret(at) });
      return this.moveTo(at);
    }
    this.insert(text);
  }
  undo() { const s = this.buf.undo(); if (s) { this.sel = { anchor: this.buf.clamp(s.anchor), head: this.buf.clamp(s.head) }; this.reveal(); } }
  redo() { const s = this.buf.redo(); if (s) { this.sel = { anchor: this.buf.clamp(s.anchor), head: this.buf.clamp(s.head) }; this.reveal(); } }

  // ----- find / replace -----
  // The find matches, inside Find in Selection's scope while the widget is open.
  matches() {
    const f = this.find, scope = this.prompt?.kind === "find" ? f.scope : null;
    const key = `${+f.caseSensitive}${+f.wholeWord}${+f.regex}${scope ? `${scope.start.line}:${scope.start.col}-${scope.end.line}:${scope.end.col}` : ""}|${f.query}`;
    if (f.version === this.buf.version && f.searched === key) return f.matches;
    ({ matches: f.matches, error: f.error } = FIND.findMatches(this.lines, f.query, f));
    f.matches = FIND.inScope(f.matches, scope);
    f.version = this.buf.version; f.searched = key;
    return f.matches;
  }
  restartFind() { if (this.prompt?.kind === "find" && this.find.query) this.findNext(1, ordered(this.prompt.origin.anchor, this.prompt.origin.head)[0]); }
  // Match Case / Match Whole Word / Use Regular Expression; with the widget open the search restarts where it opened.
  toggleFind(option) {
    this.find[option] = !this.find[option];
    this.restartFind();
  }
  // Find in Selection (⌥⌘L / Alt+L): the search keeps to the selection the widget opened with (else the current one);
  // again turns it off. Outside the widget it opens it.
  toggleFindInSelection() {
    const f = this.find, open = this.prompt?.kind === "find";
    if (open && f.scope) { f.scope = null; return this.restartFind(); }
    const o = open ? this.prompt.origin : this.sel, sel = cmp(o.anchor, o.head) ? o : this.sel;
    let [s, e] = ordered(sel.anchor, sel.head);
    if (cmp(s, e) === 0) return this.say("Select the text to find in first", this.colors.warn);
    if (e.col === 0 && e.line > s.line) e = { line: e.line - 1, col: this.lines[e.line - 1].length }; // VS Code drops the last line's start
    if (!open) this.openFind(false);
    f.scope = { start: s, end: e };
    this.restartFind();
  }
  // A replacement on the scope's last line moves its end along.
  shiftScope(m, text) { const sc = this.find.scope; if (sc && m.line === sc.end.line && m.col < sc.end.col && !text.includes("\n")) sc.end = { line: sc.end.line, col: sc.end.col + text.length - m.len }; }
  replacementFor(m) { return FIND.replacementOf(this.lines[m.line], m, this.find.query, this.find, this.find.replace); }
  currentMatch() {
    const [s, e] = this.range();
    return this.matches().findIndex(m => m.line === s.line && m.col === s.col && e.line === s.line && e.col === m.col + m.len);
  }
  findNext(dir, from = dir > 0 ? this.range()[1] : this.range()[0]) {
    const ms = this.matches();
    if (!ms.length) return;
    let i = dir > 0 ? ms.findIndex(m => cmp(m, from) >= 0) : ms.findLastIndex(m => cmp({ line: m.line, col: m.col + m.len }, from) <= 0);
    if (i === -1) i = dir > 0 ? 0 : ms.length - 1;
    const m = ms[i];
    this.sel = { anchor: { line: m.line, col: m.col }, head: { line: m.line, col: m.col + m.len } };
    this.buf.seal(); this.reveal();
  }
  replaceOne() {
    const i = this.currentMatch();
    if (i === -1) return this.findNext(1);
    const s = this.range()[0], m = this.find.matches[i], text = this.replacementFor(m);
    this.insert(text);
    this.shiftScope(m, text);
    this.findNext(1, endOf(s, text));
  }
  replaceAllMatches() {
    const ms = this.matches();
    if (!ms.length) return;
    const before = this.sel, edits = [...ms].reverse().map(m => ({ m, start: { line: m.line, col: m.col }, end: { line: m.line, col: m.col + m.len }, text: this.replacementFor(m) }));
    this.buf.edit(edits.map(({ start, end, text }) => ({ start, end, text })), { before });
    for (const { m, text } of edits) this.shiftScope(m, text);
    this.moveTo(this.buf.clamp(this.head));
    this.say(`Replaced ${ms.length} occurrence${ms.length === 1 ? "" : "s"}`);
  }

  // ----- files -----
  // Saves the current file (format on save, trim, final newline from the settings). Resolves true when written.
  async saveFile(force = false, { auto = false } = {}) {
    if (!force && F.changedOnDisk(this.file, this.doc.stamp)) {
      if (auto) return false;
      return new Promise(resolve => this.dialog("The file has been changed on disk.", `Overwrite ${path.basename(this.file)} with your version, or reload it?`, [
        { label: "Overwrite", key: "o", run: () => resolve(this.saveFile(true)) },
        { label: "Reload", key: "r", run: () => { this.reload(); resolve(false); } },
        { label: "Cancel", key: "c", cancel: true, run: () => resolve(false) }]));
    }
    if (this.settings["editor.formatOnSave"] && this.lang.can("format")) {
      try { this.applyLocalEdits(await this.lang.run("format", "format", this.langCtx())); } catch (e) { this.say(`Format on save: ${e.message}`, this.colors.warn, 5000); }
    }
    if (this.settings["files.trimTrailingWhitespace"]) this.trimTrailing();
    if (this.settings["files.insertFinalNewline"] && this.lines.join("")) this.doc.finalNewline = true;
    try {
      this.doc.stamp = F.save(this.file, F.encode(this.lines, this.doc));
      this.buf.markSaved(); this.buf.seal(); B.remove(this.file); this.git.saved();
      this.session?.saved(this.file);
      if (!auto) this.say("Saved", this.colors.ok);
      return true;
    } catch (e) { this.say(`Failed to save: ${e.message}`, this.colors.error, 8000); return false; }
    finally { this.redraw(); }
  }
  // Writes another open file as it is (rename across files, auto save).
  writeState(st) {
    try { st.doc.stamp = F.save(st.file, F.encode(st.buf.lines, st.doc)); st.buf.markSaved(); B.remove(st.file); st.git.saved(); return true; }
    catch (e) { this.say(`Failed to save ${path.basename(st.file)}: ${e.message}`, this.colors.error, 8000); return false; }
  }
  // File: Save All: the current file as Save does, every other unsaved open file as it is; one changed on disk is left unsaved.
  saveAll() {
    const skipped = [];
    for (const st of this.allStates().slice(1)) {
      if (!st.buf.dirty) continue;
      if (F.changedOnDisk(st.file, st.doc.stamp)) skipped.push(path.basename(st.file)); else this.writeState(st);
    }
    return this.track((this.buf.dirty ? this.saveFile() : Promise.resolve()).then(() => {
      if (skipped.length) this.say(`Not saved, changed on disk: ${skipped.join(", ")}`, this.colors.warn, 8000);
    }));
  }
  // File: Save As...: asks for a path (relative to the file's folder, which is prefilled), confirms replacing a file,
  // then saves the text there and edits that file; the original stays as it is on disk.
  saveAs() {
    this.popup = new O.Input({ label: "Save As:", text: path.dirname(this.file) + path.sep, selectAll: false, onAccept: (v) => {
      v = v.trim().replace(/^~(?=$|[\\/])/, os.homedir());
      if (!v) return;
      const target = path.resolve(path.dirname(this.file), v);
      if (target === this.file) return this.track(this.saveFile());
      let stat = null;
      try { stat = fs.statSync(target); } catch {}
      if (stat?.isDirectory()) return this.say(`${target} is a folder`, this.colors.warn, 6000);
      if (!fs.existsSync(path.dirname(target))) return this.say(`Folder not found: ${path.dirname(target)}`, this.colors.warn, 6000);
      if (!stat) return this.track(this.saveTo(target));
      this.dialog(`'${path.basename(target)}' already exists. Do you want to replace it?`, "Replacing it will overwrite its contents.", [
        { label: "Replace", key: "r", run: () => this.track(this.saveTo(target)) },
        { label: "Cancel", key: "c", cancel: true, run: () => {} }]);
    } });
  }
  // The current text becomes `target`'s document (its language from its name) and is saved; the original file's
  // unsaved changes go with it (VS Code reverts the original).
  async saveTo(target) {
    const old = this.file, scope = L.scopeOf(this.index, path.basename(target));
    const { grammar } = await H.loadGrammar(scope, this.index, this.theme);
    if (this.file !== old) return false; // another file is showing by now
    const st = this.makeState(target, { ...this.doc, lines: [...this.lines], stamp: null }, grammar, scope);
    Object.assign(st, { sel: this.sel, top: this.top, topSub: this.topSub, left: this.left, indent: this.indent, seenVersion: st.buf.version });
    st.buf.savedVersion = -1; // unsaved until written
    this.activate(st);
    this.docs.delete(old); B.remove(old);
    return this.saveFile(true);
  }
  trimTrailing() {
    const edits = [];
    this.lines.forEach((t, line) => { const n = t.trimEnd().length; if (n < t.length) edits.push({ line, col: n, remove: t.length - n, text: "" }); });
    this.lineEdits(edits);
  }
  reload() {
    let doc;
    try { doc = F.load(this.file); } catch (e) { return this.say(`Failed to reload: ${e.message}`, this.colors.error, 8000); }
    if (doc.error) return this.say(doc.error, this.colors.error, 8000);
    this.replaceAll(doc.lines.join("\n"));
    Object.assign(this.doc, { eol: doc.eol, finalNewline: doc.finalNewline, bom: doc.bom, stamp: doc.stamp });
    this.buf.markSaved();
    this.say("Reloaded from disk");
  }
  // The whole text replaced as one undo step, keeping the cursor where it was.
  replaceAll(text, at = this.head) {
    const last = this.lines.length - 1, before = this.sel;
    this.buf.edit([{ start: { line: 0, col: 0 }, end: { line: last, col: this.lines[last].length }, text }], { before });
    this.moveTo(this.buf.clamp(at));
  }
  // Asks about each unsaved file, then exits.
  quit() {
    const st = this.allStates().find(s => s.buf.dirty);
    if (!st) return this.exit();
    const ask = () => this.dialog(`Do you want to save the changes you made to ${path.basename(this.file)}?`, "Your changes will be lost if you don't save them.", [
      { label: "Save", key: "s", run: () => this.saveFile().then(ok => { if (ok) this.quit(); }) },
      { label: "Don't Save", key: "d", run: () => { B.remove(this.file); this.buf.markSaved(); this.quit(); } },
      { label: "Cancel", key: "c", cancel: true, run: () => {} }]);
    if (st.file === this.file) return ask();
    this.track(this.open(st.file, null, false).then(ask));
  }
  // Hot exit: unsaved files go to backups (synchronous: runs right before the process ends).
  hotExit() {
    for (const st of this.allStates()) if (st.buf.dirty) { try { B.write(st.file, st.buf.lines.join("\n"), st.sel.head); } catch {} }
  }
  // Offers a hot-exit backup of the current file back.
  offerBackup() {
    const b = B.read(this.file);
    if (!b) return;
    if (b.text === this.lines.join("\n")) return B.remove(this.file);
    const changed = B.changedSince(b, this.file);
    this.dialog(`Restore unsaved changes from ${stampText(b.time)}?`,
      changed ? "Warning: the file has changed on disk since then." : `Unsaved changes to ${path.basename(this.file)} were kept when the editor closed.`, [
        { label: "Restore", key: "r", run: () => { this.replaceAll(b.text, b.cursor ?? this.head); this.say("Restored unsaved changes"); } },
        { label: "Discard", key: "d", run: () => B.remove(this.file) }]);
  }

  // ----- other files and navigation -----
  async loadState(file) {
    let doc;
    try { doc = F.load(file); } catch (e) { this.say(`Cannot open ${path.basename(file)}: ${e.message}`, this.colors.error, 6000); return null; }
    if (doc.error) { this.say(doc.error, this.colors.error, 6000); return null; }
    const scope = L.scopeOf(this.index, path.basename(file));
    const { grammar } = await H.loadGrammar(scope, this.index, this.theme);
    const st = this.docs.get(file) ?? this.makeState(file, doc, grammar, scope);
    this.docs.set(file, st);
    return st;
  }
  // The state of an open (or being loaded) file for drawing; null while it loads.
  docFor(file) {
    if (file === this.file) return this;
    const st = this.docs.get(file);
    if (st) return st;
    if (!this.loading.has(file)) this.loading.set(file, this.loadState(file).finally(() => { this.loading.delete(file); this.redraw(); }));
    return null;
  }
  // Shows `file` (loading it once), optionally at pos; record = remember where we were for Go Back.
  async open(file, pos = null, record = true) {
    file = path.resolve(file);
    if (record) this.pushNav();
    if (file !== this.file) {
      const st = this.docs.get(file) ?? await (this.loading.get(file) ?? this.loadState(file));
      if (!st) { if (record) this.back.pop(); return false; }
      const first = !this.docs.has(file) || st.seenVersion === 0;
      this.activate(st);
      if (first) this.offerBackup();
    }
    if (pos) { this.moveTo(pos); this.scrollTo(this.viewRow(this.head) - Math.floor(this.height / 3)); }
    this.redraw();
    return true;
  }
  jumpTo(loc) { return this.track(this.open(loc.file, { line: loc.line, col: loc.col })); }
  pushNav() { this.back.push({ file: this.file, pos: { ...this.head }, top: this.top }); if (this.back.length > 50) this.back.shift(); this.forward = []; }
  navigate(dir) {
    const from = dir < 0 ? this.back : this.forward, to = dir < 0 ? this.forward : this.back, e = from.pop();
    if (!e) return;
    to.push({ file: this.file, pos: { ...this.head }, top: this.top });
    return this.track(this.open(e.file, null, false).then(() => { this.moveTo(e.pos); this.top = e.top; this.topSub = 0; }));
  }
  // Go to Next / Previous Change: the git change below / above the cursor line, wrapping (nothing without changes).
  gotoChange(dir) {
    const h = G.nextChange(this.git.hunks, this.head.line, dir);
    if (h) this.moveTo({ line: Math.min(G.lineOf(h), this.lines.length - 1), col: 0 });
  }

  // ----- prompts and overlays -----
  dialog(title, detail, buttons) { this.popup = new O.Dialog({ title, detail, buttons }); }
  closePopup() { this.popup = null; }
  // Find / Replace (⌘F / ⌥⌘F): the search seeded from the selection or (Find only) the word at the cursor
  // (editor.find.seedSearchStringFromSelection) and selected, so typing replaces it; the selection as the scope per
  // editor.find.autoFindInSelection.
  openFind(replace) {
    const [s, e] = this.range(), f = this.find, oneLine = s.line === e.line, seed = this.settings["editor.find.seedSearchStringFromSelection"];
    const q = FIND.seedOf(replace && seed !== "never" ? "selection" : seed,
      { empty: this.empty, oneLine, text: oneLine ? this.buf.getText(s, e) : "", word: () => this.wordAt()?.text ?? null });
    if (q) f.query = f.regex ? FIND.escape(q) : q;
    const auto = this.settings["editor.find.autoFindInSelection"];
    f.scope = !this.empty && (auto === "always" || (auto === "multiline" && !oneLine)) ? { start: s, end: e } : null;
    f.field = replace && q ? "replace" : "query";
    f.fresh = f.field === "query"; // the field's text is selected
    this.prompt = { kind: "find", replace, origin: this.sel };
  }
  findAgain(dir) {
    const [s, e] = this.range();
    if (!this.find.query && !this.empty && s.line === e.line) this.find.query = this.buf.getText(s, e);
    if (!this.find.query) return this.openFind(false);
    this.findNext(dir);
  }
  // The search a selection seeds (VS Code's getSelectionSearchString): a one-line selection, else the word at the cursor.
  selectionSearch() {
    const [s, e] = this.range();
    return this.empty ? this.wordAt()?.text ?? null : s.line === e.line ? this.buf.getText(s, e) : null;
  }
  // Find With Selection (⌘E): the find widget with the selection (or the word at the cursor) as the search.
  findWithSelection() {
    const q = this.selectionSearch();
    if (q) this.find.query = q;
    this.openFind(false);
  }
  // Find Next / Previous Selection (⌘F3 / ⇧⌘F3): the selection (or the word at the cursor) becomes the search, then
  // the next / previous match is selected; the find widget is not opened.
  findSelection(dir) {
    const q = this.selectionSearch();
    if (q) this.find.query = q;
    if (this.find.query) this.findNext(dir);
  }
  openGoto() { this.popup = new O.Input({ label: `Go to line (1-${this.lines.length}), :col optional:`, onAccept: (v) => this.gotoText(v) }); }
  gotoText(text) {
    const [ln, col] = text.split(/[:,]/).map(Number);
    if (!ln) return;
    const line = Math.max(0, Math.min(this.lines.length, ln) - 1);
    this.moveTo({ line, col: col ? col - 1 : 0 });
    this.scrollTo(this.toView(line) - Math.floor(this.height / 2));
  }
  // ----- status bar pickers (indentation, end of line, language mode); they change the current file only -----
  // A quick pick of fixed choices [{ label, detail?, run }], filtered as typed, starting on `current`.
  choose(placeholder, choices, current = 0) {
    this.popup = new O.Picker("", (t) => C.filter(choices, t, ch => ch.label).map(({ item, hits }) => ({ ...item, hits })), placeholder);
    this.popup.index = Math.max(0, current);
  }
  pickIndent() {
    this.choose("Select Action", [
      { label: "Indent Using Spaces", run: () => this.pickTabSize(false) },
      { label: "Indent Using Tabs", run: () => this.pickTabSize(true) }]);
  }
  pickTabSize(useTabs) {
    const sizes = [1, 2, 3, 4, 5, 6, 7, 8].map(size => ({ label: String(size), detail: size === this.tab ? "Configured Tab Size" : "",
      run: () => { this.indent = { useTabs, size }; this.reveal(); } }));
    this.choose("Select Tab Size for the Current File", sizes, this.tab - 1);
  }
  // The file is written with the chosen line ending on the next save (it counts as a change until then).
  pickEol() {
    const set = (eol) => { if (this.doc.eol !== eol) { this.doc.eol = eol; this.buf.savedVersion = -1; } };
    this.choose("Select End of Line Sequence", [{ label: "LF", run: () => set("\n") }, { label: "CRLF", run: () => set("\r\n") }], this.doc.eol === "\r\n" ? 1 : 0);
  }
  // Plain Text and every language a grammar ships for (the scopes file names map to).
  pickLanguage() {
    const ix = this.index, roots = [...new Set([...Object.values(ix.ext), ...Object.values(ix.files), ...Object.values(ix.prefixes)])].filter(s => ix.scopes[s]);
    const langs = [{ scope: null, label: "Plain Text" }, ...roots.map(scope => ({ scope, label: L.languageName(scope) }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.scope.localeCompare(b.scope))];
    const current = this.hl.grammar ? this.scope : null;
    this.choose("Select Language Mode", langs.map(l => ({ label: l.label, detail: l.scope ? `(${l.scope})` : "", run: () => this.track(this.setLanguage(l.scope)) })),
      langs.findIndex(l => l.scope === current));
  }
  // Re-tokenizes with the scope's grammar; comments and the language server follow the new language.
  async setLanguage(scope) {
    const buf = this.buf, g = await H.loadGrammar(scope, this.index, this.theme);
    if (buf !== this.buf) return; // another file is showing by now
    this.scope = scope; this.comment = L.commentOf(scope); this.session = null;
    this.useGrammar(g);
  }
  // Screen cell under a buffer position (row, col), for popups placed at the cursor.
  screenOf(p) { const { sub, x } = this.rowPos(p); return { row: this.rowsTo(p.line, sub) + 2, col: this.gutter + x - this.left + 1 }; }
  openMenu(x, y) { this.popup = new O.Menu(C.menuRows(C.MENU, cap => this.lang.can(cap), this.keymap.label), x, y); }
  openMenuAtCursor() { const s = this.screenOf(this.head); this.openMenu(Math.max(1, s.col), Math.min(this.rows, s.row + 1)); }
  openPicker(prefix) {
    this.popup = new O.Picker(prefix, (t) => this.pickItems(t), "Search files by name (: to go to a line, > for commands)");
  }
  pickItems(text) {
    if (text.startsWith(">")) {
      return C.filter(C.COMMANDS.filter(c => c.title), text.slice(1).trim(), c => c.title).map(({ item, hits }) => ({ label: item.title, hits, key: this.keymap.label(item.id),
        detail: item.run === "toggleAutoSave" || item.run === "askAutoSaveDelay" ? S.autoSaveLabel(this.settings) : "", run: () => this.runCommand(item.id) }));
    }
    if (text.startsWith("@")) return this.symbolItems(text.slice(1).trim());
    if (text.startsWith("#")) return this.workspaceSymbolItems(text.slice(1).trim());
    if (text.startsWith(":")) return [{ label: text.length > 1 ? `Go to line ${text.slice(1)}` : "Type a line number to go to", run: () => this.gotoText(text.slice(1)) }];
    return C.filter(this.projectFiles(), text.trim(), f => f).slice(0, 300)
      .map(({ item, hits }) => ({ label: item, hits, run: () => this.track(this.open(path.join(this.root, item))) }));
  }
  // ----- document symbols (Go to Symbol in Editor, breadcrumbs) -----
  // ⇧⌘O: the symbols fresh from the language server (else the regex outline) in a quick pick that names the source.
  goToSymbol() {
    return this.track(this.loadOutline().then(o => {
      if (!o) return;
      this.popup = new O.Picker("@", (t) => this.pickItems(t), "", o.source === "regex outline" ? "regex outline (no language server)" : `from ${o.source}`);
    }));
  }
  symbolItems(query) {
    const o = this.outline;
    if (!o || o.version !== this.buf.version) this.queueOutline();
    if (!o?.items.length) return [{ label: o ? "No symbols found" : "Loading symbols…", run: () => {} }];
    return C.filter(o.items, query, s => s.name).map(({ item, hits }) => ({ label: item.name, hits, detail: item.kind + (item.container ? ` · ${item.container}` : ""),
      key: `${item.at.line + 1}`, run: () => this.jumpTo({ file: this.file, line: item.at.line, col: item.at.col }) }));
  }
  // Asks for the current file's symbols; stores and resolves { version, source, items } (null when the file changed meanwhile).
  async loadOutline() {
    const buf = this.buf, file = this.file, version = buf.version;
    const { source, items } = await this.lang.symbols(this.langCtx());
    Lang.offer(this.lang);
    const st = file === this.file ? this : this.docs.get(file);
    if (!st || st.buf !== buf || buf.version !== version) return null;
    st.outline = { version, source, items };
    return st.outline;
  }
  // The outline again 300 ms after the text last changed (breadcrumbs follow the cursor through it); asking for it gives
  // the language server the current text, so its diagnostics follow too.
  queueOutline() {
    if (this.outlineTimer) return;
    this.outlineTimer = setTimeout(() => {
      this.outlineTimer = null;
      this.loadOutline().then(o => { if (o) { this.queueLenses(); this.redraw(); } else if (!this.done) this.queueOutline(); }, () => {});
    }, 300);
    this.outlineTimer.unref?.();
  }
  // ----- CodeLens (editor.codeLens): "N references" on a row of its own above each declaration, VS Code's -----
  // Asked of the running language server after each outline (so 300 ms after the text last changed), one request at a
  // time, never blocking input; the last ones stay, moved along with edits, until the new ones come.
  queueLenses() {
    const st = this.lenses, buf = this.buf, version = buf.version;
    if (!this.settings["editor.codeLens"] || this.lensBusy || st.version === version || !this.lang.live("codeLens")) return;
    this.lensBusy = true;
    this.lang.background("codeLens", "lenses", this.langCtx()).then(items => {
      if (buf.version === version && items) { st.items = items.sort((a, b) => a.line - b.line || a.col - b.col); st.version = version; }
    }, () => { st.version = version; }).finally(() => { this.lensBusy = false; this.redraw(); });
  }
  // The shown lenses by line: line -> [{ line, col, title, kind }] (none while editor.codeLens is off).
  lensLines() {
    const st = this.lenses;
    if (!this.settings["editor.codeLens"] || !st.items.length) return NO_LENSES;
    if (st.byLine?.items !== st.items) {
      const map = new Map();
      for (const it of st.items) if (it.line < this.lines.length) { if (!map.has(it.line)) map.set(it.line, []); map.get(it.line).push(it); }
      st.byLine = { items: st.items, map };
    }
    return st.byLine.map;
  }
  // Text rows from the first shown row to row `sub` of `line`: view rows plus the lens rows above the lines in between
  // (and `line`) and a multi-line ghost text's extra rows below a row before it.
  rowsTo(line, sub = 0) {
    let n = this.toView(line) + sub - this.topRow;
    if (n < 0) return n;
    for (const l of this.lensLines().keys()) if ((l > this.top || (l === this.top && !this.topSub)) && l <= line && !this.folds.isHidden(l)) n++;
    const g = this.inlineGhostView(), gv = g && this.viewRow(g);
    if (g && gv >= this.topRow && gv < this.toView(line) + sub) n += g.lines.length - 1;
    return n;
  }
  // The first `count` text rows: { line, sub?, lens?, ghost? } (sub: the line's row when wrapped; lens: that line's
  // lenses, on the row above it; ghost k: line k of a multi-line ghost text, below its row; line -1: past the end).
  layoutRows(count, ghost = this.inlineGhostView()) {
    const by = this.lensLines(), rows = [], gsub = ghost ? this.rowPos(ghost).sub : -1;
    for (let l = this.top, k = this.topSub; rows.length < count; l = this.folds.next(l), k = 0) {
      if (l >= this.lines.length) { rows.push({ line: -1 }); continue; }
      if (by.has(l) && !k) rows.push({ line: l, lens: by.get(l) });
      for (const n = this.wrapOf(l).starts.length; k < n && rows.length < count; k++) {
        rows.push({ line: l, sub: k });
        if (ghost?.line === l && k === gsub) for (let j = 1; j < ghost.lines.length && rows.length < count; j++) rows.push({ line: l, ghost: j });
      }
    }
    return rows;
  }
  // A lens row's text: the titles joined by " | " from the line's indentation; parts: each lens's display columns.
  lensText(l, items) {
    const t = this.lines[l], indent = W.displayCol(t, t.search(/\S|$/), this.tab), parts = [];
    let text = " ".repeat(indent);
    for (const it of items) {
      if (parts.length) text += " | ";
      parts.push({ from: W.textWidth(text, this.tab), to: W.textWidth(text + it.title, this.tab), item: it });
      text += it.title;
    }
    return { text, parts };
  }
  paintLens(P, l, items) {
    const c = this.colors, width = this.textWidth, { text } = this.lensText(l, items);
    P.text(" ".repeat(this.gutter), c.fg, c.bg);
    P.text(fit([...text].slice(this.left).join(""), width), c.codeLens, c.bg);
  }
  // A click on a lens: its peek (VS Code's showReferences) at the declaration.
  clickLens(row, x) {
    const col = this.left + x - 1 - this.gutter, hit = this.lensText(row.line, row.lens).parts.find(p => col >= p.from && col < p.to);
    if (hit) this.runLens(hit.item);
  }
  runLens(it) { this.moveTo({ line: it.line, col: it.col }); return this.peekAt(it.kind); }
  // Show CodeLens Commands for Current Line: the lens of the cursor's line (a pick of them when there are several).
  showLenses() {
    const items = this.lensLines().get(this.head.line) ?? [];
    if (!items.length) return this.say("No CodeLens on this line");
    if (items.length === 1) return this.runLens(items[0]);
    this.choose("Select a command", items.map(it => ({ label: it.title, run: () => this.runLens(it) })));
  }
  // Breadcrumbs: the file's folders and name, then the symbols around the cursor; only the name when they are off.
  crumbText() {
    if (!this.settings["breadcrumbs.enabled"]) return " " + this.crumbs.at(-1);
    const names = [...this.crumbs, ...SYM.symbolPath(this.outline?.items ?? [], this.head).map(s => s.name)];
    return " " + names.join(" › ");
  }
  // ----- missing language servers (VS Code's extension recommendations) -----
  // The status bar's offer to install this file's missing server (once per language a session), unless turned off.
  installOffer() {
    if (this.settings["extensions.ignoreRecommendations"] || !this.session?.kind) return null;
    return Lang.offered(this.session.kind);
  }
  // Runs the offer's install in a new terminal tab (herdr-app terminal.open), so it is seen; never on its own. Outside
  // Herdr, or without herdr-app (a remote machine), the status bar says what to run. Then it looks for the server every
  // 3 s, 10 minutes at most, and starts it once it is there.
  installServer() {
    const h = this.installOffer();
    if (!h) return;
    Lang.takeOffer(h.kind);
    const bin = process.env.HC_TERMINAL_ID && which("herdr-app");
    if (!bin) return this.say(`Run in a terminal: ${h.command}`, this.colors.barFg, 15000);
    require("child_process").spawn(bin, ["do", "terminal.open", "--place", "tab", "--name", `Install ${h.label}`, "--folder", gitRoot(this.file),
      "--argv", JSON.stringify(Lang.installArgv(h.command))], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    this.say(`Installing ${h.label} in a new terminal tab…`, this.colors.barFg, 5000);
    const end = Date.now() + 600000;
    clearInterval(this.installTimer);
    this.installTimer = setInterval(() => {
      if (Lang.found(h.kind)) { clearInterval(this.installTimer); Lang.retry(h.kind); this.say(`${h.label} is installed`); this.queueOutline(); this.redraw(); }
      else if (Date.now() > end || this.done) clearInterval(this.installTimer);
    }, 3000);
    this.installTimer.unref?.();
  }
  // ----- diagnostics (from the language server: tsserver's geterr events, LSP publishDiagnostics) -----
  // Errors, warnings and information (hints aren't drawn) in document order, clamped to the text.
  problems() {
    const list = this.session?.diagnostics() ?? [];
    if (this._problems?.list === list && this._problems.version === this.buf.version) return this._problems.items;
    const items = list.filter(d => d.severity <= 3).map(d => ({ ...d, start: this.buf.clamp(d.start), end: this.buf.clamp(d.end) }))
      .sort((a, b) => cmp(a.start, b.start) || a.severity - b.severity);
    this._problems = { list, version: this.buf.version, items };
    return items;
  }
  // The columns [from, to) a problem underlines on `line` (an empty range takes the character at it, or before it at the end).
  static problemSpan(d, line, text) {
    if (line < d.start.line || line > d.end.line) return null;
    let from = line === d.start.line ? d.start.col : 0, to = line === d.end.line ? d.end.col : text.length;
    if (from >= to && d.start.line === d.end.line) { if (from < text.length) to = from + 1; else { from = Math.max(0, text.length - 1); to = text.length; } }
    return from < to ? { from, to } : null;
  }
  // The problems at p (their ranges, ends included), the most severe first.
  problemsAt({ line, col }) {
    return this.problems().filter(d => { const s = Editor.problemSpan(d, line, this.lines[line]); return s && col >= s.from && col <= s.to; })
      .sort((a, b) => a.severity - b.severity);
  }
  problemAtCursor() { return this.problemsAt(this.head)[0] ?? null; }
  // F8 / ⇧F8: the next / previous problem's start (wrapping); its message shows in the status bar.
  nextProblem(dir) {
    const ps = this.problems();
    if (!ps.length) return this.say("No problems in this file");
    const h = this.head;
    const d = dir > 0 ? ps.find(p => cmp(p.start, h) > 0) ?? ps[0] : ps.findLast(p => cmp(p.start, h) < 0) ?? ps.at(-1);
    this.pushNav();
    this.moveTo(d.start);
    this.scrollTo(this.viewRow(this.head) - Math.floor(this.height / 3));
  }
  // Files of the git root (git ls-files), else up to 20,000 files found under the file's folder.
  projectFiles() {
    if (this._files?.root === this.root) return this._files.list;
    let list = [];
    const r = fs.existsSync(path.join(this.root, ".git")) ? run("git", ["ls-files", "-co", "--exclude-standard"], { cwd: this.root, timeout: 5000 }) : null;
    if (r && r.code === 0) list = r.stdout.split("\n").filter(Boolean);
    else {
      const walk = (dir, depth) => {
        if (list.length >= 20000 || depth > 8) return;
        let ents = [];
        try { ents = fs.readdirSync(path.join(this.root, dir), { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          const rel = dir ? `${dir}/${e.name}` : e.name;
          if (e.isDirectory()) walk(rel, depth + 1); else if (list.length < 20000) list.push(rel);
        }
      };
      walk("", 0);
    }
    this._files = { root: this.root, list };
    return list;
  }

  promptKey(ev) {
    const p = this.prompt, f = this.find;
    const set = (v) => { f[f.field] = v; if (f.field === "query") this.findNext(1, ordered(p.origin.anchor, p.origin.head)[0]); };
    const fresh = f.fresh; // typing replaces a selected field's text
    if (ev.type === "text" || ev.type === "paste") { f.fresh = false; return set((fresh ? "" : f[f.field]) + ev.text.split(/\r?\n|\r/)[0]); }
    if (ev.type !== "key") return;
    const { name, shift, alt, cmd } = ev, chord = C.chordOf(ev);
    if (name === "escape") { this.prompt = null; return; }
    const id = this.keymap.byChord.get(chord); // the widget's own commands, through the user's keys
    if (WIDGET_COMMANDS.has(id)) return this.runCommand(id);
    f.fresh = false;
    if (name === "backspace") return set(fresh ? "" : [...f[f.field]].slice(0, -1).join(""));
    if (name === "tab" && p.replace) { f.field = f.field === "query" ? "replace" : "query"; return; }
    if (id === "editor.action.startFindReplaceAction") { p.replace = true; f.field = "replace"; return; }
    if (id === "actions.find") { p.replace = false; f.field = "query"; return; }
    if (name === "enter" && (alt || cmd) && p.replace) return this.replaceAllMatches();
    if (name === "enter" && f.field === "replace") return this.replaceOne();
    if (id === "editor.action.nextMatchFindAction" || id === "editor.action.previousMatchFindAction") return this.findNext(id.includes("next") ? 1 : -1);
    if (name === "enter" || name === "down") return this.findNext(shift ? -1 : 1);
    if (name === "up") return this.findNext(-1);
  }

  // ----- commands -----
  runCommand(id) {
    const c = C.BY_ID.get(id);
    if (!c) return;
    if (c.cap && !this.lang.can(c.cap)) return this.say(`No ${c.title.replace(/\.\.\.$/, "").toLowerCase()} support for ${this.language}`, this.colors.warn);
    return this[c.run](...(c.args ?? []));
  }
  // Runs an async operation; its error becomes the status message, and the screen redraws when it ends.
  track(promise) {
    return Promise.resolve(promise).catch(e => this.say(e?.message ?? String(e), this.colors.warn, 5000)).finally(() => this.redraw());
  }
  selectAll() { this.sel = { anchor: { line: 0, col: 0 }, head: { line: this.lines.length - 1, col: this.lines[this.lines.length - 1].length } }; this.buf.seal(); }
  // Expand Line Selection (⌘L): from the selection's first line start to the start of the line after its last line
  // (the end of the file on the last line), so pressing it again adds the next line.
  expandLineSelection() {
    const [s, e] = this.range(), last = this.lines.length - 1;
    this.sel = { anchor: { line: s.line, col: 0 }, head: e.line < last ? { line: e.line + 1, col: 0 } : { line: last, col: this.lines[last].length } };
    this.buf.seal(); this.reveal();
  }
  // The word under/before p: { text, start, end } or null.
  wordAt(p = this.head) {
    const t = this.lines[p.line];
    let s = p.col, e = p.col;
    while (s > 0 && classOf(t[s - 1]) === 1) s--;
    while (e < t.length && classOf(t[e]) === 1) e++;
    return s < e ? { text: t.slice(s, e), start: { line: p.line, col: s }, end: { line: p.line, col: e } } : null;
  }
  // ⌘D without multiple cursors: select the word, then move the selection to the next occurrence.
  selectNextOccurrence() {
    if (this.empty) { const w = this.wordAt(); if (w) { this.sel = { anchor: w.start, head: w.end }; this.buf.seal(); } return; }
    const [s, e] = this.range(), text = this.buf.getText(s, e);
    if (text.includes("\n")) return;
    const n = this.lines.length;
    for (let k = 0; k <= n; k++) {
      const l = (e.line + k) % n, from = k === 0 ? e.col : 0, i = this.lines[l].indexOf(text, from);
      if (i !== -1 && !(k === n && i >= s.col)) { this.sel = { anchor: { line: l, col: i }, head: { line: l, col: i + text.length } }; this.buf.seal(); this.reveal(); return; }
    }
  }
  deleteLines() {
    const [a, b] = this.selectedLines(), last = this.lines.length - 1, col = this.head.col;
    if (b < last) this.deleteRange({ line: a, col: 0 }, { line: b + 1, col: 0 });
    else if (a > 0) this.deleteRange({ line: a - 1, col: this.lines[a - 1].length }, { line: b, col: this.lines[b].length });
    else this.deleteRange({ line: 0, col: 0 }, { line: b, col: this.lines[b].length });
    this.moveTo({ line: Math.min(a, this.lines.length - 1), col });
  }
  // Swaps the selected lines with the line above (dir -1) or below (1).
  moveLines(dir) {
    const [a, b] = this.selectedLines();
    if ((dir < 0 && a === 0) || (dir > 0 && b === this.lines.length - 1)) return;
    const block = this.lines.slice(a, b + 1), from = dir < 0 ? a - 1 : a, to = dir < 0 ? b : b + 1;
    const text = (dir < 0 ? [...block, this.lines[a - 1]] : [this.lines[b + 1], ...block]).join("\n");
    const shift = (p) => ({ line: p.line + dir, col: p.col }), before = this.sel, after = { anchor: shift(this.sel.anchor), head: shift(this.sel.head) };
    this.buf.edit([{ start: { line: from, col: 0 }, end: { line: to, col: this.lines[to].length }, text }], { before, after });
    this.sel = after; this.buf.seal(); this.reveal();
  }
  copyLines(dir) {
    const [a, b] = this.selectedLines(), block = this.lines.slice(a, b + 1).join("\n"), n = b - a + 1;
    const before = this.sel, shift = (p) => ({ line: p.line + (dir > 0 ? n : 0), col: p.col }), after = { anchor: shift(this.sel.anchor), head: shift(this.sel.head) };
    this.buf.edit([{ start: { line: b, col: this.lines[b].length }, text: "\n" + block }], { before, after });
    this.sel = after; this.buf.seal(); this.reveal();
  }
  insertLine(below) {
    const l = this.head.line, indent = this.lines[l].match(/^[\t ]*/)[0], before = this.sel;
    const at = below ? { line: l, col: this.lines[l].length } : { line: l, col: 0 }, pos = { line: below ? l + 1 : l, col: indent.length };
    this.buf.edit([{ start: at, text: below ? "\n" + indent : indent + "\n" }], { before, after: caret(pos) });
    this.moveTo(pos);
  }
  // Join Lines (VS Code's JoinLinesAction): the selected lines, else the cursor line and the next, become one; each
  // joined line loses its indent and gets one space before it (none after an empty line, trailing whitespace becomes
  // that space; blank lines vanish). The cursor goes to the last join, a multi-line selection keeps its distance from the end.
  joinLines() {
    const [s, e] = this.range(), last = this.lines.length - 1, single = s.line === e.line;
    const end = single ? Math.min(s.line + 1, last) : e.line, endText = this.lines[end];
    let text = this.lines[s.line], back = 0;
    for (let l = s.line + 1; l <= end; l++) {
      const t = this.lines[l], i = t.search(/[^ \t]/);
      if (i === -1) { back = 0; continue; }
      let space = text !== "";
      if (space && /[ \t]$/.test(text)) { space = false; text = text.replace(/[\s﻿\xA0]+$/, " "); }
      text += (space ? " " : "") + t.slice(i);
      back = t.length - i + (space ? 1 : 0);
    }
    const before = this.sel, after = this.empty ? caret({ line: s.line, col: text.length - back })
      : single ? { anchor: s, head: e } : { anchor: s, head: { line: s.line, col: text.length - (endText.length - e.col) } };
    if (end > s.line) this.buf.edit([{ start: { line: s.line, col: 0 }, end: { line: end, col: endText.length }, text }], { before, after });
    this.sel = after; this.buf.seal(); this.reveal();
  }

  // ----- Cursor Undo / Redo (VS Code's CursorUndoRedoController) -----
  // Called after each event: a selection change without a text change records the selection (and scroll) before it, at
  // most CURSOR_STACK, and empties the redo stack; a text change or another file empties both.
  noteCursor() {
    const h = this.cursorHist, now = { sel: this.sel, top: this.top, topSub: this.topSub, left: this.left };
    if (h?.buf !== this.buf || h.version !== this.buf.version) { this.cursorHist = { buf: this.buf, version: this.buf.version, last: now, undo: [], redo: [] }; return; }
    if (cmp(h.last.sel.anchor, this.sel.anchor) || cmp(h.last.sel.head, this.sel.head)) {
      h.undo.push(h.last); h.redo = [];
      if (h.undo.length > CURSOR_STACK) h.undo.shift();
    }
    h.last = now;
  }
  // dir -1: Cursor Undo (the selection before the last cursor change), 1: Cursor Redo.
  cursorHistory(dir) {
    this.noteCursor();
    const h = this.cursorHist, st = (dir < 0 ? h.undo : h.redo).pop();
    if (!st) return;
    (dir < 0 ? h.redo : h.undo).push(h.last);
    this.sel = st.sel; this.top = st.top; this.topSub = st.topSub; this.left = st.left; this.goal = null; this.buf.seal();
    h.last = st;
  }

  // ----- Expand / Shrink Selection (smart select) -----
  // dir 1 grows the selection to the next range around it (the language server's selection ranges with the word,
  // string, bracket and line ones), -1 goes back to the one before; shrinking a selection that wasn't grown does nothing.
  smartSelect(dir) {
    const st = this.smart, [a, b] = this.range(), cur = { start: a, end: b };
    if (st?.buf === this.buf && st.version === this.buf.version && SS.same(st.chain[st.index], cur)) {
      const i = st.index + dir;
      if (i < 0 || i >= st.chain.length) return;
      st.index = i;
      this.sel = { anchor: st.chain[i].start, head: st.chain[i].end }; this.buf.seal(); this.reveal();
      return;
    }
    if (dir < 0) return;
    const buf = this.buf, version = buf.version, sel = this.sel;
    return this.track(this.selectionRanges().then(ranges => {
      if (this.buf !== buf || buf.version !== version || this.sel !== sel) return; // the cursor moved meanwhile
      this.smart = { buf, version, chain: SS.chain(cur, ranges), index: 0 };
      this.smartSelect(1);
    }));
  }
  async selectionRanges() {
    const own = SS.fallbackRanges(this.lines, this.head, this.isCode, this.stringAt);
    if (!this.lang.can("selectionRange")) return own;
    try { return [...await this.lang.run("selectionRange", "selectionRanges", this.langCtx()), ...own]; } catch { return own; }
  }
  // The [from, to) columns of the string token at (line, col), quotes included, or null.
  stringAt = (line, col) => {
    this.hl.ensure(line, Date.now() + 20);
    const tk = this.hl.tokens[line], isString = (k) => H.tokenTypeOf(tk[k + 1]) === 2;
    if (!tk || col >= this.lines[line].length) return null;
    let s = H.tokenIndex(tk, col), e = s;
    if (!isString(s)) return null;
    while (s >= 2 && isString(s - 2)) s -= 2;
    while (e + 2 < tk.length && isString(e + 2)) e += 2;
    return [tk[s], e + 2 < tk.length ? tk[e + 2] : this.lines[line].length];
  };

  // ----- language features -----
  langCtx(p = this.head) {
    const [s, e] = this.range(), { line, col } = p;
    return { file: this.file, lines: this.lines, line, col, sel: { start: s, end: e }, tabSize: this.tab, insertSpaces: !this.indent.useTabs,
      word: this.wordAt(p)?.text ?? "", language: this.language };
  }
  locate(kind) { return this.lang.run(kind, kind, this.langCtx()); }
  noResult(kind) { const w = this.wordAt()?.text; this.say(`No ${NOT_FOUND[kind]} found${w ? ` for '${w}'` : ""}`, this.colors.warn); }
  goTo(kind) {
    return this.track(this.locate(kind).then(locs => {
      if (!locs.length) return this.noResult(kind);
      if (locs.length === 1) return this.jumpTo(locs[0]);
      this.showPeek(kind, locs); // editor.gotoLocation.multiple*: "peek", VS Code's default
    }));
  }
  peekAt(kind) {
    return this.track(this.locate(kind).then(locs => (locs.length ? this.showPeek(kind, locs) : this.noResult(kind))));
  }
  showPeek(kind, locs) {
    this.peek = new O.Peek(PEEK_TITLE[kind], locs);
    // keep the box on screen below the cursor line
    const { sub } = this.rowPos(this.head);
    if (this.rowsTo(this.head.line, sub) + this.peek.height >= this.height) this.scrollTo(this.viewRow(this.head) - Math.max(0, this.height - this.peek.height - 1));
  }
  findAll(kind) {
    return this.track(this.locate(kind).then(locs => (locs.length ? this.showPanel(PEEK_TITLE[kind], locs) : this.noResult(kind))));
  }
  callHierarchy(dir = "incoming", ctx = this.langCtx()) {
    return this.track(this.lang.run("callHierarchy", "calls", ctx, dir).then(items => {
      for (const it of items) if (it.name?.includes("/")) it.name = path.basename(it.name);
      const other = dir === "incoming" ? "outgoing" : "incoming";
      this.showPanel(`${dir === "incoming" ? "Incoming" : "Outgoing"} calls · ${ctx.word}`, items, { toggle: `${other} calls`, onToggle: () => this.callHierarchy(other, ctx) });
    }));
  }
  lineOf(file, line) {
    const st = file === this.file ? this : this.docs.get(file);
    if (st) return st.buf.lines[line] ?? "";
    if (!this.fileLines.has(file)) { try { this.fileLines.set(file, F.load(file).lines ?? []); } catch { this.fileLines.set(file, []); } }
    return this.fileLines.get(file)[line] ?? "";
  }
  showPanel(title, items, opts) {
    this.fileLines.clear();
    for (const it of items) it.preview ??= this.lineOf(it.file, it.line);
    this.panel = new O.Panel(title, items, opts);
    this.reveal();
  }
  // Inline box position under a buffer position.
  inlineAt(p) { const s = this.screenOf(p); return { row: Math.min(this.rows - 3, s.row + 1), col: Math.max(1, s.col - 1) }; }
  renameSymbol() {
    const w = this.wordAt();
    if (!w) return this.say("The element can't be renamed.", this.colors.warn);
    if (this.lang.provider("rename") instanceof Fallback) return this.changeAll("Rename (whole word, this file)");
    const ctx = this.langCtx();
    this.popup = new O.Input({ label: "Enter to Rename, Esc to Cancel", text: w.text, at: this.inlineAt(w.start),
      onAccept: (name) => { if (name && name !== w.text) this.track(this.lang.run("rename", "rename", ctx, name).then(ws => this.reportEdit(this.applyEdit(ws), "Renamed"))); } });
  }
  reportEdit(r, verb) {
    if (r.failed.length) return this.say(`${verb} ${plural(r.edits, "occurrence")}; failed: ${r.failed.map(f => path.basename(f.file)).join(", ")}`, this.colors.error, 8000);
    this.say(`${verb} ${plural(r.edits, "occurrence")} in ${plural(r.files, "file")}`, this.colors.ok, 5000);
  }
  // Whole-word replace in this file with a live preview (VS Code's Change All Occurrences is file-local too).
  changeAll(label = "Change All Occurrences") {
    const [s, e] = this.range();
    const word = !this.empty && s.line === e.line ? this.buf.getText(s, e) : this.wordAt()?.text;
    if (!word) return;
    const occ = this.empty || /^[\p{L}\p{N}_$]+$/u.test(word) ? wordOccurrences(this.lines, word) : [];
    if (!occ.length) return;
    let applied = false;
    const at = this.wordAt()?.start ?? s, origin = this.sel;
    const preview = (v) => {
      if (applied) { this.buf.undo(); applied = false; }
      if (v && v !== word) { this.buf.edit(lastFirst(occ).map(o => ({ start: o.start, end: o.end, text: v })), { before: origin, after: origin }); applied = true; }
      this.sel = { anchor: this.buf.clamp(origin.anchor), head: this.buf.clamp(origin.head) };
    };
    this.popup = new O.Input({ label: `${label} · ${plural(occ.length, "occurrence")}`, text: word, at: this.inlineAt(at), onChange: preview,
      onAccept: () => { this.buf.seal(); if (applied) this.say(`Changed ${plural(occ.length, "occurrence")}`, this.colors.ok); },
      onCancel: () => preview(word) });
  }
  // Text edits on the current file as one undo step.
  applyLocalEdits(edits) {
    if (!edits?.length) return;
    const before = this.sel, at = this.head;
    this.buf.edit(lastFirst(edits).map(e => ({ start: e.start, end: e.end, text: e.text.replace(/\r\n?/g, "\n") })), { before });
    this.moveTo(this.buf.clamp(at));
  }
  // Workspace edits: the current file stays unsaved (one undo step), other open files are edited and saved, the rest rewritten on disk.
  applyEdit(ws) {
    const r = applyWorkspaceEdit(ws, (file, edits) => {
      if (file === this.file) { this.applyLocalEdits(edits); return true; }
      const st = this.docs.get(file);
      if (!st) return false;
      st.buf.edit(lastFirst(edits).map(e => ({ start: e.start, end: e.end, text: e.text.replace(/\r\n?/g, "\n") })), { before: st.sel });
      st.sel = { anchor: st.buf.clamp(st.sel.anchor), head: st.buf.clamp(st.sel.head) };
      return this.writeState(st);
    });
    for (const file of Object.keys(ws ?? {})) if (file !== this.file) this.lang.touch(file, this.docs.get(file)?.buf.lines.join("\n"));
    return r;
  }
  formatDocument() { return this.track(this.lang.run("format", "format", this.langCtx()).then(edits => this.applyLocalEdits(edits))); }
  // Format Selection (⌘K ⌘F): the language's range formatter on the selection (the cursor line when nothing is selected);
  // without one, the document formatter's changes to the selected lines, unless one of them crosses their edges.
  formatSelection() {
    const h = this.head, [s, e] = this.empty ? [{ line: h.line, col: 0 }, { line: h.line, col: this.lines[h.line].length }] : this.range();
    const [a, b] = this.empty ? [h.line, h.line] : this.selectedLines(), ctx = { ...this.langCtx(), sel: { start: s, end: e } };
    const buf = this.buf, version = buf.version, stale = () => this.buf !== buf || buf.version !== version;
    return this.track((async () => {
      let edits = this.lang.provider("formatRange") ? await this.lang.run("formatRange", "formatRange", ctx) : null;
      if (!edits) {
        if (!this.lang.can("format")) return this.say(`No format selection support for ${this.language}`, this.colors.warn);
        const all = await this.lang.run("format", "format", ctx);
        if (stale()) return;
        edits = editsWithin(this.lines, all, a, b);
        if (!edits) return this.say("Format Selection isn't supported here: the formatter also changes lines around the selection", this.colors.warn, 5000);
      }
      if (!stale()) this.applyLocalEdits(edits);
    })());
  }
  // A code action's edit applied (its resolve() gives the workspace edit), files it couldn't change reported.
  applyAction(a) { return this.track(a.resolve().then(ws => { const r = this.applyEdit(ws); if (r.failed.length) this.reportEdit(r, "Applied"); })); }
  codeActions(kind) {
    return this.track(this.lang.run(kind, kind === "refactor" ? "refactors" : "sourceActions", this.langCtx()).then(list => {
      if (!list.length) return this.say(kind === "refactor" ? "No refactorings available" : "No source actions available", this.colors.warn);
      this.popup = new O.Picker("", (t) => C.filter(list, t, a => a.title).map(({ item, hits }) => ({ label: item.title, hits, run: () => this.applyAction(item) })),
        kind === "refactor" ? "Select a refactoring" : "Select a source action");
    }));
  }
  // The problems a quick fix is for: those at the cursor, else the nearest one on its line (VS Code's
  // editor.codeActionWidget.includeNearbyQuickFixes); the request covers that problem when nothing is selected.
  quickFixCtx() {
    const ctx = this.langCtx(), { line, col } = this.head, at = this.problemsAt(this.head);
    const dist = (d) => Math.abs((d.start.line === line ? d.start.col : 0) - col);
    const near = at.length ? at : this.problems().filter(d => d.start.line <= line && d.end.line >= line).sort((x, y) => dist(x) - dist(y)).slice(0, 1);
    if (!at.length && near.length && this.empty) ctx.sel = { start: near[0].start, end: near[0].end };
    return { ...ctx, diagnostics: near };
  }
  // Quick Fix (⌘.): a menu at the cursor of the fixes for its problems (preferred first), then the refactorings.
  quickFix() {
    const ctx = this.quickFixCtx(), buf = this.buf, version = buf.version;
    return this.track((async () => {
      const fixes = ctx.diagnostics.length && this.lang.can("quickFix") ? await this.lang.run("quickFix", "quickFixes", ctx) : [];
      const refactors = this.lang.can("refactor") ? await this.lang.run("refactor", "refactors", ctx).catch(() => []) : [];
      if (this.buf !== buf || buf.version !== version) return;
      const row = (a) => ({ id: null, title: a.title, key: "", enabled: true, run: () => this.applyAction(a) });
      const rows = [...[...fixes].sort((x, y) => !!y.preferred - !!x.preferred).map(row), ...(fixes.length && refactors.length ? [{ sep: true }] : []), ...refactors.map(row)];
      if (!rows.length) return this.say("No code actions available", this.colors.warn);
      const s = this.screenOf(this.head);
      this.popup = new O.Menu(rows, Math.max(1, s.col), Math.min(this.rows, s.row + 1));
      this.popup.index = C.stepMenu(rows, -1, 1);
    })());
  }
  // The light bulb's line (-1: none): the cursor line once its problems' quick fixes came back non-empty. They are asked
  // WORD_DELAY ms after the cursor line, its problems or the text last changed, and only from a running language server.
  lightBulbLine() {
    const line = this.head.line, diags = this.problems().filter(d => d.start.line <= line && d.end.line >= line);
    const key = `${this.buf.version}:${line}:${diags.length}`, lb = this.bulb;
    if (lb?.buf === this.buf && lb.key === key) return lb.fixes ? line : -1;
    const bulb = this.bulb = { buf: this.buf, key, fixes: false };
    clearTimeout(this.bulbTimer);
    if (!diags.length || !this.session || !this.lang.can("quickFix")) return -1;
    (this.bulbTimer = setTimeout(() => {
      if (this.bulb !== bulb || this.done) return;
      const ctx = { ...this.langCtx(), diagnostics: diags, sel: { start: { line, col: 0 }, end: { line, col: this.lines[line].length } } };
      this.lang.run("quickFix", "quickFixes", ctx).then(f => { if (this.bulb === bulb && f.length) { bulb.fixes = true; this.redraw(); } }, () => {});
    }, WORD_DELAY)).unref?.();
    return -1;
  }

  // ----- hover (Show or Focus Hover, and the mouse resting on a word while editor.hover.enabled) -----
  // The problems at p, then the language server's hover there, in a box at the word; dropped when another hover was
  // asked for or the text changed meanwhile. source: "keyboard" | "mouse" (a mouse hover closes when the pointer leaves).
  showHover(p = this.head, source = "keyboard") {
    const token = this.hoverToken = (this.hoverToken ?? 0) + 1, buf = this.buf, version = buf.version;
    const at = this.wordAt(p)?.start ?? p, problems = this.problemsAt(p).map(d => d.message + (d.source ? `  ${d.source}` : ""));
    const show = (h) => {
      if (token !== this.hoverToken || this.buf !== buf || buf.version !== version) return;
      const md = [...problems, h?.contents].filter(Boolean).join("\n\n---\n\n");
      this.hoverBox = md ? Object.assign(new O.Hover(md, this.screenOf(at)), { source }) : null;
      if (!md && source === "keyboard") this.say("No hover information", this.colors.warn);
    };
    if (!this.lang.can("hover")) { show(null); return this.redraw(); }
    return this.track(this.lang.run("hover", "hover", this.langCtx(p)).then(show, () => show(null)));
  }
  // A buttonless motion: resting HOVER_DELAY ms on a word (or a problem) of the text shows its hover; moving off it
  // closes a mouse hover, unless onto the box.
  mouseHover(ev) {
    if (this.hoverBox?.contains(ev)) return;
    const p = !this.prompt && !this.peek && ev.x > this.gutter && ev.y >= 2 && ev.y <= this.height + 1 && !this.lensRowAt(ev.y) ? this.cellToPos(ev.x, ev.y) : null;
    const t = p && this.lines[p.line], over = p && p.col < t.length && this.rowPos(p).x === this.left + ev.x - 1 - this.gutter;
    const w = over && (classOf(t[p.col]) === 1 ? this.wordAt(p) : this.problemsAt(p).length ? { start: p } : null);
    // Ctrl (⌘ when the terminal reports it) over a word: underlined like a link, a click goes to its definition
    const link = ev.ctrl && w?.text && this.lang.can("definition") ? { line: p.line, from: w.start.col, to: w.end.col } : null;
    if (JSON.stringify(link) !== JSON.stringify(this.link ?? null)) { this.link = link; this.redraw(); }
    const key = w ? `${p.line}:${w.start.col}` : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key; clearTimeout(this.hoverTimer);
    if (this.hoverBox?.source === "mouse") { this.hoverBox = null; this.hoverToken = (this.hoverToken ?? 0) + 1; this.redraw(); }
    if (w && this.settings["editor.hover.enabled"]) (this.hoverTimer = setTimeout(() => this.showHover(p, "mouse"), HOVER_DELAY)).unref?.();
  }

  // ----- Go to Symbol in Workspace (⌘T: the quick pick with "#") -----
  // The language server's symbols for the query, asked once per query; rows refresh when they come.
  workspaceSymbolItems(query) {
    let req = this.wsSymbols;
    if (req?.query !== query || req.root !== this.root) {
      req = this.wsSymbols = { query, root: this.root, items: null };
      this.lang.run("workspaceSymbols", "workspaceSymbols", this.langCtx(), query).then(items => { req.items = items; }, (e) => { req.items = []; req.error = e.message; })
        .finally(() => { if (this.wsSymbols === req && this.popup instanceof O.Picker && this.popup.text.startsWith("#")) { this.popup.refresh(); this.redraw(); } });
    }
    if (!req.items) return [{ label: "Searching symbols…", run: () => {} }];
    if (req.error) return [{ label: req.error, run: () => {} }];
    return req.items.map(it => ({ label: it.name, hits: C.fuzzy(query, it.name)?.hits ?? [], key: it.kind,
      detail: [it.container, path.relative(this.root, it.file)].filter(Boolean).join(" · "), run: () => this.jumpTo(it) }));
  }

  // ----- folding -----
  // Foldable ranges (folding.cjs, cached per text version); collapsed folds follow them by their header line.
  foldRanges() {
    const r = this._ranges;
    if (r?.buf === this.buf && r.version === this.buf.version && r.tab === this.tab) return r.list;
    const list = FD.foldRanges(this.lines, this.tab, FD.offSide(this.scope));
    this._ranges = { buf: this.buf, version: this.buf.version, tab: this.tab, list };
    if (this.folds.sync(list)) this.folds.reveal(this.head.line);
    return list;
  }
  // Collapses ranges; a cursor they hide goes to the header of the fold hiding it. True when one collapsed.
  collapse(ranges) {
    if (!this.folds.collapse(ranges)) return false;
    if (this.folds.isHidden(this.head.line)) this.moveTo({ line: this.folds.visible(this.head.line), col: this.head.col });
    return true;
  }
  // Fold: the innermost expanded range at the cursor line. Unfold: the collapsed one it heads. Toggle: either.
  fold() { const r = FD.innermost(this.foldRanges(), this.head.line, r => !this.folds.has(r.start)); if (r) this.collapse([r]); }
  unfold() { this.folds.expand(this.head.line); }
  toggleFold() { if (!this.folds.expand(this.head.line)) this.fold(); }
  foldAll() { this.collapse(this.foldRanges()); }
  unfoldAll() { this.folds.clear(); }
  // A click on line's chevron: expands a collapsed fold, collapses the range it heads; false when it heads none.
  clickFold(line) {
    if (this.folds.expand(line)) return true;
    const r = FD.rangeAt(this.foldRanges(), line);
    return !!r && this.collapse([r]);
  }

  // ----- inline suggestions (inline.cjs): ghost text from a provider after typing pauses -----
  get inlineCfg() {
    if (this._inlineCfg?.settings !== this.settings) this._inlineCfg = { settings: this.settings, cfg: I.config(this.settings, inlineUsable) };
    return this._inlineCfg.cfg;
  }
  inlineHealth(cfg) {
    let h = this.inline.health.get(cfg.key);
    if (!h) this.inline.health.set(cfg.key, (h = new I.Health(cfg.stopAfter)));
    return h;
  }
  // Why no request may go now: null when one may; "ui" (an overlay or a selection) and "position" go unsaid.
  inlineBlocked(cfg, manual) {
    if (!cfg.enabled) return "Inline suggestions are off (click their status bar item to turn them on)";
    const paused = this.inlineHealth(cfg).paused;
    if (paused) return `${cfg.label} is paused: ${paused} (click its status bar item to resume)`;
    if (this.inline.models.get(cfg.key)?.missing) return I.missingText(cfg);
    if (cfg.hosted && !this.inlineKeyOf(cfg)) return `${cfg.label}: ${I.keyHelp(cfg.provider)}`;
    if (this.popup || this.prompt || this.peek || !this.empty) return "ui";
    if (I.denied(this.file, cfg.exclude)) return "No inline suggestions for this file (editor.inlineSuggest.exclude)";
    if (this.textLength() > I.MAX_FILE_CHARS) return "The file is too large for inline suggestions";
    if (!manual && (!I.atSuggestable(this.lines[this.head.line], this.head.col) || I.quietEnd(this.lines, this.head.line))) return "position";
    if (cfg.limit && I.usageOf(cfg.key).requests >= cfg.limit) return `${cfg.label}: today's limit of ${cfg.limit} requests is reached (editor.inlineSuggest.dailyRequestLimit)`;
    return null;
  }
  // A hosted provider's API key (inline.cjs apiKey), looked up again at most every 10 s while there is none.
  inlineKeyOf(cfg) {
    let k = this.inline.keys.get(cfg.provider);
    if (!k || (!k.key && Date.now() - k.at > 10000)) this.inline.keys.set(cfg.provider, (k = { ...I.apiKey(cfg.provider), at: Date.now() }));
    return k.key;
  }
  textLength() {
    if (this._length?.buf !== this.buf || this._length.version !== this.buf.version) {
      let n = 0;
      for (const t of this.lines) { n += t.length + 1; if (n > I.MAX_FILE_CHARS) break; }
      this._length = { buf: this.buf, version: this.buf.version, n };
    }
    return this._length.n;
  }
  inlineCancel() {
    clearTimeout(this.inline.timer); this.inline.timer = null;
    if (this.inline.abort) { this.inline.abort.abort(); this.inline.abort = null; this.inline.gen++; }
    this.inline.busy = false;
  }
  // After each event: the ghost goes when the text, the cursor or the file changed under it; an edit by typing asks
  // again once typing pauses (auto trigger), any other change cancels what is pending.
  inlineAfterEvent() {
    const s = this.inline, g = s.ghost, now = `${this.file}\0${this.buf.version}\0${this.head.line}\0${this.head.col}`;
    if (g && (g.file !== this.file || g.version !== this.buf.version || cmp(g.at, this.head) !== 0 || !this.empty || this.popup || this.prompt)) s.ghost = null;
    const editing = s.editing;
    s.editing = false;
    if (now === s.seen) return;
    const versionChanged = !s.seen || s.seen.split("\0")[1] !== String(this.buf.version);
    s.seen = now;
    if (s.ghost) return;
    if (editing && versionChanged) this.inlineSchedule(); else this.inlineCancel();
  }
  inlineSchedule() {
    this.inlineCancel();
    const cfg = this.inlineCfg;
    if (cfg.trigger !== "auto" || this.inlineBlocked(cfg, false)) return;
    this.inline.timer = setTimeout(() => this.inlineRequest(false), cfg.debounce);
  }
  // Asks the provider for the cursor's position (manual: Trigger Inline Suggestion, which says why it can't).
  async inlineRequest(manual) {
    const cfg = this.inlineCfg, why = this.inlineBlocked(cfg, manual);
    if (why) { if (manual && why !== "ui") this.say(why, this.colors.warn, 5000); return; }
    const at = { ...this.head }, file = this.file, version = this.buf.version;
    const key = `${file}\0${version}\0${at.line}\0${at.col}\0${cfg.key}\0${cfg.multiline}`;
    if (this.inline.cache.has(key)) return this.inlineShow(this.inline.cache.get(key), at, version);
    const ctx = { ...I.contextAt(this.lines, at.line, at.col, cfg.prefixChars, cfg.suffixChars), multiline: cfg.multiline, prose: I.proseFile(file), file };
    this.inlineCancel();
    const ac = new AbortController(), gen = ++this.inline.gen;
    Object.assign(this.inline, { abort: ac, busy: true });
    this.redraw();
    const t0 = Date.now();
    let texts = [], error = null;
    // the reply streams in: its complete lines show as they come; reading stops where the block ends (or at prose)
    const partial = (text) => {
      if (gen !== this.inline.gen) return true;
      const r = I.clean(text.slice(0, text.lastIndexOf("\n") + 1), ctx);
      if (r.anomaly === "prose") return true;
      if (r.text && r.text !== this.inline.ghost?.items[0]) { this.inlineShow([r.text], at, version); this.redraw(); }
      return cfg.multiline && I.blockCut(text, ctx, false).done;
    };
    try { const { status, json } = await I.postStream(I.request(cfg, ctx, true, cfg.hosted ? this.inlineKeyOf(cfg) : ""), ac.signal, partial); texts = I.reply(cfg, status, json); }
    catch (e) { error = I.failure(cfg, e); if (error === null) return; } // aborted: a newer request or an edit
    if (gen !== this.inline.gen) return;
    if (error === I.missingText(cfg)) this.inline.models.set(cfg.key, { missing: true, chat: false });
    Object.assign(this.inline, { abort: null, busy: false, error });
    const results = texts.map(t => I.clean(t, ctx)), good = results.filter(r => r.text).map(r => r.text);
    I.recordUsage(cfg.key, { inChars: ctx.prefix.length + ctx.suffix.length, outChars: texts.join("").length, ms: error ? null : Date.now() - t0 });
    const anomaly = error ? null : results.some(r => r.anomaly === "fim") ? "fim" : good.length ? null : results.find(r => r.anomaly)?.anomaly ?? "empty";
    const paused = this.inlineHealth(cfg).record(anomaly, error);
    if (paused) this.say(`${cfg.label} paused: ${paused}`, this.colors.warn, 8000);
    else if (error) this.say(error, this.colors.warn, 6000);
    if (good.length) {
      if (this.inline.cache.size >= 50) this.inline.cache.delete(this.inline.cache.keys().next().value);
      this.inline.cache.set(key, good);
      this.inlineShow(good, at, version);
    } else if (this.inline.ghost?.version === version && cmp(this.inline.ghost.at, at) === 0) this.inline.ghost = null; // lines shown while streaming
    this.redraw();
  }
  inlineShow(items, at, version) {
    if (this.buf.version !== version || cmp(this.head, at) !== 0 || !this.empty || this.popup || this.prompt) return;
    this.inline.ghost = { file: this.file, version, at, items, index: 0 };
  }
  // The ghost text to paint: { line, col, lines } (null when none shows).
  inlineGhostView() {
    const g = this.inline.ghost;
    if (!g || g.file !== this.file || g.version !== this.buf.version || this.folds.isHidden(g.at.line)) return null;
    return { line: g.at.line, col: g.at.col, lines: g.items[g.index].split("\n") };
  }
  // A key or typed text while a suggestion shows: its commands (Tab, Esc, ⌘→ …, keymap.json's `when` keys), or typing
  // what it starts with, which keeps the rest without asking again. True when handled here.
  inlineKey(ev) {
    const g = this.inline.ghost;
    if (ev.type === "key") {
      const id = this.keymap.whenSuggest.get(C.chordOf(ev));
      if (!C.BY_ID.has(id)) return false;
      this.runCommand(id);
      return true;
    }
    if (ev.type !== "text") return false;
    const text = ev.text.replace(/\r\n?/g, "\n"), left = I.typeThrough([g.items[g.index], ...g.items.filter((_, i) => i !== g.index)], text);
    this.typed(ev.text);
    const { line, col } = this.head;
    if (left && line === g.at.line && !text.includes("\n")) {
      const rest = this.lines[line].slice(col);
      this.inline.ghost = { ...g, version: this.buf.version, at: { line, col }, items: left.map(s => I.trimLineSuffix(s, rest)).filter(Boolean), index: 0 };
      if (!this.inline.ghost.items.length) this.inline.ghost = null;
      else this.inline.editing = false;
    }
    return true;
  }
  // Tab: the whole suggestion; ⌘→ / Ctrl+→ ("word"): up to the end of its next word; Accept Next Line ("line"): up to its
  // next line break; the rest still showing.
  inlineAccept(part = null) {
    const g = this.inline.ghost;
    if (!g) return;
    const text = g.items[g.index];
    part = text.slice(0, part === "word" ? I.nextWordLength(text) : part === "line" ? I.nextLineLength(text) : text.length);
    this.insert(part); this.buf.seal();
    const rest = text.slice(part.length);
    this.inline.ghost = rest ? { ...g, items: [rest], index: 0, version: this.buf.version, at: { ...this.head } } : null;
  }
  inlineHide() { this.inline.ghost = null; this.inlineCancel(); }
  inlineCycle(dir) { const g = this.inline.ghost; if (g) g.index = (g.index + dir + g.items.length) % g.items.length; }
  inlineTrigger() { this.inline.ghost = null; this.inlineRequest(true); }
  // Once per provider and model (Ollama): asks whether the model is pulled and a chat model, then loads it in the
  // background, so the first suggestion is quick.
  inlineWarmup() {
    const cfg = this.inlineCfg, req = cfg.enabled && !this.inline.warmed.has(cfg.key) && I.show(cfg);
    if (!req) return;
    this.inline.warmed.add(cfg.key);
    I.post(req).then(({ status, json }) => {
      const info = I.modelInfo(status, json);
      this.inline.models.set(cfg.key, info);
      if (!info?.missing) I.post(I.warmup(cfg)).catch(() => {});
      this.redraw();
    }).catch(() => {});
  }
  // The status bar item: the provider and its state; a click turns suggestions on/off (and resumes a paused provider),
  // the pointer on it shows today's usage. Hidden while the provider is off or can't run here and nothing was set.
  inlineStatus() {
    const cfg = this.inlineCfg;
    if (cfg.provider === "off" || (!cfg.enabled && this.settings["editor.inlineSuggest.enabled"] == null)) return null;
    const h = this.inlineHealth(cfg), paused = h.paused, limited = cfg.enabled && cfg.limit && I.usageOf(cfg.key).requests >= cfg.limit;
    const info = this.inline.models.get(cfg.key), missing = info?.missing, chat = I.chatModel(cfg, info);
    const noKey = cfg.enabled && cfg.hosted && !this.inlineKeyOf(cfg);
    const state = !cfg.enabled ? ": off" : missing ? `: ollama pull ${cfg.model}` : noKey ? ": no API key" : paused ? ": paused" : limited ? ": limit" :
      this.inline.busy ? " …" : this.inline.error ? ": error" : chat ? ": chat model" : "";
    const notes = [paused ? `${cfg.label} paused: ${paused}` : h.note, missing && I.missingText(cfg), chat && I.chatHint(cfg),
      noKey && I.keyHelp(cfg.provider) + (this.inline.keys.get(cfg.provider)?.loose ? ` (vscode-secrets.json is readable by others: chmod 600 it)` : "")].filter(Boolean);
    return { text: cfg.label + state, run: () => this.toggleInline(), hover: () => [...notes, I.usageText(cfg, I.usageOf(cfg.key))].join(" · ") };
  }
  // The word wrap item: "Wrap" (with the column for wordWrapColumn / bounded) or a dimmed "No Wrap"; a click is Toggle
  // Word Wrap (this file, this session, as VS Code's), the pointer on it says what it does.
  wrapStatus() {
    const mode = this.wordWrap, col = this.settings["editor.wordWrapColumn"], fixed = mode === "wordWrapColumn" || mode === "bounded";
    const what = mode === "off" ? "No word wrap" : fixed ? `Word wrap at ${mode === "bounded" ? "the window or " : ""}column ${col} (${mode})` : "Word wrap at the window's width";
    return { text: mode === "off" ? "No Wrap" : fixed ? `Wrap ${col}` : "Wrap", color: mode === "off" ? this.colors.lineNumber : null,
      run: () => this.toggleWordWrap(), hover: () => `${what} · click to turn it ${mode === "off" ? "on" : "off"} for this file (${this.keymap.label("editor.action.toggleWordWrap") || "View: Toggle Word Wrap"})` };
  }
  toggleInline() {
    const cfg = this.inlineCfg;
    this.inline.health.delete(cfg.key); this.inline.models.delete(cfg.key); this.inline.warmed.delete(cfg.key); this.inline.keys.clear(); this.inline.error = null;
    this.inlineHide();
    try { this.applySettings(S.update("editor.inlineSuggest.enabled", !cfg.enabled)); this.say(`Inline suggestions ${cfg.enabled ? "off" : "on"}`); }
    catch (e) { this.say(`Cannot write settings: ${e.message}`, this.colors.error, 6000); }
    this.inlineWarmup();
  }

  // ----- settings, auto save -----
  applySettings({ values, stamp }) { this.settings = values; this.settingsStamp = stamp; }
  pollSettings() {
    const file = S.settingsFile();
    let st = null;
    try { const s = fs.statSync(file); st = { mtimeMs: s.mtimeMs, size: s.size }; } catch {}
    if (st && (!this.settingsStamp || st.mtimeMs !== this.settingsStamp.mtimeMs || st.size !== this.settingsStamp.size)) { this.applySettings(S.load(file)); return true; }
    return false;
  }
  toggleAutoSave() {
    try { this.applySettings(S.update("files.autoSave", this.settings["files.autoSave"] === "off" ? "afterDelay" : "off")); this.say(S.autoSaveLabel(this.settings)); }
    catch (e) { this.say(`Cannot write settings: ${e.message}`, this.colors.error, 6000); }
  }
  askAutoSaveDelay() {
    this.popup = new O.Input({ label: "Auto save delay in seconds (0.1-3600):", text: String(this.settings["files.autoSaveDelay"]), onAccept: (v) => {
      const n = Number(v);
      if (!v.trim() || !Number.isFinite(n)) return this.say(`Not a number of seconds: ${v}`, this.colors.warn);
      try { this.applySettings(S.update("files.autoSaveDelay", Math.max(0.1, Math.min(3600, n)))); this.say(S.autoSaveLabel(this.settings)); }
      catch (e) { this.say(`Cannot write settings: ${e.message}`, this.colors.error, 6000); }
    } });
  }
  openSettings() { S.load(); return this.track(this.open(S.settingsFile())); }
  openKeybindings() {
    const file = K.keybindingsFile();
    if (!fs.existsSync(file)) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); F.save(file, "[]\n"); } catch {} }
    return this.track(this.open(file));
  }
  // The Settings dialog (the vscode-settings mod) through herdr-app, on its Keyboard Shortcuts page for "keybindings"
  // (asked through <herdr home>/.vscode-settings-page, honored for a few seconds); outside Herdr, the JSON file.
  openSettingsUi(page) {
    const bin = process.env.HC_TERMINAL_ID && which("herdr-app");
    if (!bin) return page ? this.openKeybindings() : this.openSettings();
    try { fs.writeFileSync(path.join(path.dirname(S.settingsFile()), ".vscode-settings-page"), JSON.stringify({ page: page ?? "settings", at: Date.now() })); } catch {}
    require("child_process").spawn(bin, ["do", "mod.open", "--name", "vscode-settings"], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  // After each input event: record a cursor change for Cursor Undo; restart the auto-save timer when the text changed.
  afterEvent() {
    this.noteCursor();
    this.inlineAfterEvent();
    if (this.buf.version === this.seenVersion) return;
    this.seenVersion = this.buf.version;
    if (this.settings["files.autoSave"] !== "afterDelay" || !this.buf.dirty) return;
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => this.autoSave(), this.settings["files.autoSaveDelay"] * 1000);
  }
  autoSave() {
    if (this.done || this.popup) return;
    for (const st of this.allStates()) if (st.file !== this.file && st.buf.dirty) this.writeState(st);
    if (this.buf.dirty) this.track(this.saveFile(false, { auto: true }));
  }
  focusChanged(focused) {
    if (focused) T.rightClicksTo("program"); // again, in case Herdr hadn't adopted the terminal yet
    else if (this.settings["files.autoSave"] === "onFocusChange") this.autoSave();
  }

  // ----- input -----
  handle(ev) {
    if (ev.type === "focus") return this.focusChanged(ev.focused);
    if (ev.type === "mouse") return this.mouse(ev);
    this.inline.editing = ev.type === "text" || (ev.type === "key" && ["enter", "backspace", "tab", "delete"].includes(ev.name));
    if (this.chordPrefix) return this.chordKey(ev);
    if (this.hoverBox && !this.popup) { this.hoverBox = null; if (ev.type === "key" && ev.name === "escape") return; } // any key closes the hover; Esc only that
    if (this.popup) return void this.popup.key(ev, this);
    if (this.prompt) return this.promptKey(ev);
    if (this.peek && this.peek.key(ev, this)) return;
    if (this.panel?.focused && this.panel.key(ev, this)) return;
    if (this.inline.ghost && this.inlineKey(ev)) return;
    if (ev.type === "text") return this.typed(ev.text);
    if (ev.type === "paste") return this.paste(ev.text);
    const chord = C.chordOf(ev);
    if (this.keymap.prefixes.has(chord)) { // the first key of a two-step chord (VS Code's ⌘K …)
      this.chordPrefix = chord;
      return this.say(`(${this.keymap.keyLabel(chord)}) was pressed. Waiting for second key of chord...`, this.colors.barFg, 60000);
    }
    const id = this.keymap.byChord.get(chord);
    if (C.BY_ID.has(id)) return this.runCommand(id);
    // Movement and deletion keys are commands (keymap.json); Enter, Tab and Escape are the editor's own.
    const { name, shift, alt } = ev;
    if (ev.cmd || ev.ctrl) return;
    switch (name) {
      case "enter": return alt ? undefined : this.enter();
      case "tab": return this.tabKey(shift);
      case "escape": if (!this.empty) this.moveTo(this.head); else if (this.panel) this.panel = null; return;
    }
  }
  // The second key of a chord: its command, else VS Code's "not a command" message. A typed character counts as its key.
  chordKey(ev) {
    if (ev.type !== "key" && ev.type !== "text") return;
    const first = this.chordPrefix, ch = ev.type === "text" ? [...ev.text][0] : null;
    const second = ch ? (ch !== ch.toLowerCase() ? "shift+" : "") + ch.toLowerCase() : C.chordOf(ev);
    this.chordPrefix = null; this.message = null;
    const id = this.keymap.byChord.get(`${first} ${second}`);
    if (C.BY_ID.has(id)) return this.runCommand(id);
    this.say(`The key combination (${this.keymap.keyLabel(first)}, ${this.keymap.keyLabel(second)}) is not a command.`, this.colors.warn);
  }

  // Terminal cell -> buffer position (rows: 1 breadcrumbs, 2..rows-1 text).
  // A lens row gives its line's start; a ghost row, a place on the cursor's row; a row past the end, the last row.
  cellToPos(x, y) {
    const row = y >= 2 && y <= this.height + 1 ? this.layoutRows(y - 1)[y - 2] : null;
    const v = row && row.line >= 0 ? -1 : Math.max(0, Math.min(this.viewCount - 1, row ? Infinity : this.topRow + y - 2));
    const line = v < 0 ? row.line : this.fromView(v);
    if (row?.lens) return { line, col: 0 };
    const sub = v >= 0 ? v - this.toView(line) : row.ghost ? this.rowPos(this.head).sub : row.sub;
    return { line, col: WR.colAt(this.wrapOf(line), sub, this.lines[line], Math.max(0, this.left + x - 1 - this.gutter), this.tab) };
  }
  // The lens row at screen row y, or null.
  lensRowAt(y) { const row = y >= 2 && y <= this.height + 1 && this.lensLines().size ? this.layoutRows(y - 1)[y - 2] : null; return row?.lens ? row : null; }
  // How far past the text area a drag pointer is, in cells (the gutter and the last text column count as past the side).
  dragOverflow(x, y) {
    const right = this.gutter + this.textWidth;
    return { dx: x <= this.gutter ? x - this.gutter - 1 : x >= right ? x - right + 1 : 0,
      dy: y < 2 ? y - 2 : y > this.height + 1 ? y - this.height - 1 : 0 };
  }
  // Extends the dragged selection to the pointer; past an edge, first scrolls toward it (faster the farther out).
  // Returns true while the pointer is outside, so the auto-scroll timer keeps going.
  dragStep() {
    const { x, y } = this.drag, { dx, dy } = this.dragOverflow(x, y);
    if (dy) this.scrollBy(dy);
    if (dx) this.left = Math.max(0, Math.min(this.left + dx * 2, Math.max(this.left, this.widest(this.top, this.height) - this.textWidth + 5)));
    const p = this.cellToPos(Math.max(this.gutter + 1, Math.min(x, this.gutter + this.textWidth)), Math.max(2, Math.min(y, this.height + 1)));
    this.sel = { anchor: this.sel.anchor, head: p };
    return !!(dx || dy);
  }
  stopDragScroll() { clearInterval(this.dragTimer); this.dragTimer = null; }
  // Display width of the widest of `count` lines from `top` (a very long line counts its length: exact for ASCII, not
  // walked); while wrapping, at most the wrap width.
  widest(top, count) {
    let w = 0;
    for (let l = top, k = 0; l < this.lines.length && k < count; l = this.folds.next(l), k++) { const t = this.lines[l]; w = Math.max(w, t.length > 1000 ? t.length : W.textWidth(t, this.tab)); }
    return Math.min(w, this.wrapWidth || Infinity);
  }
  // Shows the vertical bar when the file is taller than the view, the horizontal one when a line in view is wider; the
  // vertical one scrolls to the last line at the top (VS Code's scroll beyond last line), the horizontal one 5 columns past the widest line.
  layoutBars() {
    const base = Math.max(1, this.rows - 2 - (this.panel ? this.panel.height(this) : 0)), n = this.viewCount, widest = this.widest(this.top, base);
    let v = n > base || this.topRow > 0 || this.problems().length > 0; // problems: the overview ruler always shows, as VS Code's
    const h = widest > this.cols - this.gutter - (v ? 1 : 0) || this.left > 0;
    if (h) v ||= n > base - 1;
    const height = Math.max(1, base - (h ? 1 : 0)), width = Math.max(1, this.cols - this.gutter - (v ? 1 : 0));
    this.vbar.layout(v, 2, this.cols, height, height, n + height - 1, this.topRow);
    this.hbar.layout(h, height + 2, this.gutter + 1, width, width, widest + 5, this.left);
  }
  // Overview ruler marks on the vertical bar, like VS Code's: find matches, word / selection occurrences, the selection's
  // other end, the cursor line.
  rulerMarks(ms, hits, problems = []) {
    const n = this.viewCount, len = this.vbar.length, marks = new Array(len).fill(null), c = this.colors;
    const cell = (line) => SB.markCell(this.toView(line), Math.max(n, len), len); // a file that fits: beside each row
    for (const h of this.git.hunks) { // git changes first: everything else draws over them
      const color = c[`ruler${h.kind[0].toUpperCase()}${h.kind.slice(1)}`];
      for (let k = cell(G.lineOf(h)); k <= cell(Math.max(G.lineOf(h), h.end - 1)); k++) marks[k] = color;
    }
    for (const m of ms) marks[cell(m.line)] = c.rulerFind;
    for (const h of hits?.list ?? []) marks[cell(h.line)] = h.ruler ?? hits.ruler;
    if (!this.empty) marks[cell(this.sel.anchor.line)] = c.rulerSelection;
    marks[cell(this.head.line)] = c.rulerCursor;
    for (const d of [...problems].sort((a, b) => b.severity - a.severity)) marks[cell(d.start.line)] = c.rulerDiag[d.severity]; // errors win, over everything else
    return marks;
  }
  // A buttonless motion: the changed bar alone, "" when nothing changed, null for a whole frame (or not a hover).
  hover(ev) {
    if (this.popup) return null; // menus highlight under the pointer
    if (ev.type === "mouse" && ev.motion && ev.button === 3 && ev.y === this.rows) { // the inline suggestion item: today's usage
      const h = this.statusHits?.find(h => h.hover && ev.x >= h.x && ev.x < h.x + h.w), text = h?.hover();
      if (text && this.message?.text !== text) { this.say(text, this.colors.barFg, 6000); return null; }
    }
    if (ev.type === "mouse" && ev.motion && ev.button === 3) { // the fold chevrons show while the pointer is on the gutter
      const over = ev.x <= this.gutter && ev.y >= 2 && ev.y <= this.height + 1;
      if (over !== !!this.gutterHover) { this.gutterHover = over; this.redraw(); }
      this.mouseHover(ev);
    }
    const out = SB.hover(ev, [[this.vbar, this.marks], [this.hbar, null]], this.colors);
    return out && (this.peek || this.prompt) ? null : out; // overlays may cover the bars
  }
  // Presses, drags and wheels on the scrollbars (never the cursor or a selection); true when the event was theirs.
  barMouse(ev) {
    if (this.dragging) return false;
    if ((ev.button === 64 || ev.button === 65) && this.hbar.contains(ev)) { this.left = Math.max(0, this.left + (ev.button === 64 ? -6 : 6)); return true; }
    const covered = (this.peek && ev.y >= this.peekRow && ev.y < this.peekRow + this.peek.height) || (this.prompt && ev.y < (this.prompt.replace ? 4 : 3) && ev.x >= (this.findBox?.x ?? this.cols - 47));
    for (const [bar, key] of [[this.vbar, "top"], [this.hbar, "left"]]) {
      if (covered && bar.drag === null) continue;
      const pos = bar.mouse(ev);
      if (pos === undefined) continue;
      if (pos !== null && key === "top") this.scrollTo(pos);
      else if (pos !== null) this.left = pos;
      return true;
    }
    return false;
  }
  mouse(ev) {
    if (this.popup) return void this.popup.mouse(ev, this);
    if (this.hoverBox && !ev.motion && !ev.release) this.hoverBox = null; // a click or the wheel closes the hover
    if (this.findMouse(ev)) return;
    if (this.barMouse(ev)) return;
    if (this.panel && this.panel.mouse(ev, this)) return;
    const wheel = ev.button === 64 || ev.button === 65;
    if (wheel && !ev.shift) {
      this.scrollBy(ev.button === 64 ? -3 : 3);
      return;
    }
    if (wheel || ev.button === 66 || ev.button === 67) { // horizontal wheel, or Shift+wheel
      this.left = Math.max(0, this.left + (ev.button === 66 || ev.button === 64 ? -6 : 6));
      return;
    }
    if (ev.release) { this.dragging = false; this.stopDragScroll(); return; }
    if (ev.motion && this.dragging && ev.button === 0) {
      this.drag = { x: ev.x, y: ev.y };
      if (!this.dragStep()) this.stopDragScroll();
      else this.dragTimer ??= setInterval(() => { if (!this.dragging || !this.dragStep()) this.stopDragScroll(); this.redraw?.(); }, 40);
      return;
    }
    if (ev.y === this.rows) { // the status bar's items
      if (ev.button === 0 && !ev.motion) this.statusHits?.find(h => ev.x >= h.x && ev.x < h.x + h.w)?.run();
      return;
    }
    if (ev.y === 1) { // the breadcrumbs: a click opens Go to Symbol
      if (ev.button === 0 && !ev.motion && this.settings["breadcrumbs.enabled"]) this.goToSymbol();
      return;
    }
    if (ev.y < 2 || ev.y > this.height + 1) return;
    const lensRow = this.lensRowAt(ev.y);
    if (lensRow) { if (ev.button === 0 && !ev.motion && !this.dragging) { this.peek = null; this.clickLens(lensRow, ev.x); } return; }
    const p = this.cellToPos(ev.x, ev.y);
    if (ev.button === 2 && !ev.motion) { // right click: the context menu, at a click outside the selection the caret moves there first
      const [s, e] = this.range();
      if (this.empty || cmp(p, s) < 0 || cmp(p, e) > 0) this.moveTo(p);
      return this.openMenu(ev.x, ev.y);
    }
    if (ev.button !== 0) return;
    if (this.panel) this.panel.focused = false;
    if (this.peek && !ev.motion) { if (ev.y >= this.peekRow && ev.y < this.peekRow + this.peek.height) return; this.peek = null; }
    if (ev.motion) return;
    if (ev.x === this.gutter && !ev.shift && this.clickFold(p.line)) return; // the chevron column
    if (ev.ctrl && !ev.shift && ev.x > this.gutter) { this.link = null; this.moveTo(p); return this.runCommand("editor.action.revealDefinition"); } // VS Code's ⌘-click / Ctrl+click
    const now = Date.now(), c = this.lastClick;
    const double = now - c.time < 400 && c.line === p.line && c.col === p.col;
    this.lastClick = { time: now, line: p.line, col: p.col };
    this.dragging = true;
    if (ev.shift && (double || ev.x <= this.gutter)) { // VS Code: Shift+click on the gutter extends by whole lines, a Shift+double-click by words
      const a = this.sel.anchor, down = cmp(p, a) >= 0, t = this.lines[p.line], last = this.lines.length - 1;
      const s = wordLeft(t, Math.min(t.length, W.nextIndex(t, p.col))), e = wordRight(t, s);
      const head = ev.x > this.gutter ? { line: p.line, col: down ? e : s }
        : !down ? { line: p.line, col: 0 } : p.line < last ? { line: p.line + 1, col: 0 } : { line: last, col: t.length };
      this.sel = { anchor: a, head };
      this.buf.seal();
      return;
    }
    if (double && !ev.shift) {
      const t = this.lines[p.line], s = wordLeft(t, Math.min(t.length, W.nextIndex(t, p.col))), e = wordRight(t, s);
      this.sel = { anchor: { line: p.line, col: s }, head: { line: p.line, col: e } };
      this.buf.seal();
      return;
    }
    this.moveTo(p, ev.shift);
  }

  // ----- drawing -----
  // budget: ms to spend tokenizing toward the viewport before painting the rest in the default color.
  render(budget = 60) {
    if (this.folds.any) this.foldRanges(); // collapsed folds follow the text
    this.top = this.folds.visible(Math.max(0, Math.min(this.top, this.lines.length - 1)));
    this.topSub = Math.min(this.topSub, WR.last(this.wrapOf(this.top))); // a narrower or shorter line has fewer rows
    this.layoutBars();
    const P = new Painter(), c = this.colors, height = this.height, width = this.textWidth, gw = this.gutter;
    const deadline = Date.now() + budget;
    // each text row: a line's row (-1 past the end; folded lines skipped), its lenses above it, or a line of a
    // multi-line ghost text below the cursor's row; rows: the lines shown, each once
    const ghost = this.inlineGhostView(), layout = this.layoutRows(height, ghost);
    const rows = layout.filter(r => !r.lens && !r.ghost && !r.sub).map(r => r.line);
    if (this.topSub && layout[0]) rows.unshift(this.top);
    const end = Math.max(this.top, ...rows) + 1;
    // long lines get at most 25 ms a frame, so keys are handled between slices
    const done = this.hl.ensure(end, deadline) & this.hl.ensureLong(this.top, end, Math.min(deadline, Date.now() + 25));
    const [ss, se] = this.range(), empty = this.empty;
    const showMatches = this.prompt?.kind === "find" && this.find.query;
    const ms = showMatches ? this.matches() : [];
    const guides = this.guidesFor(rows), brackets = this.bracketPair() ?? [];
    const hits = showMatches ? null : this.highlights(height), occ = hits?.list ?? []; // Find shows its own matches
    if (this.outline?.version !== this.buf.version) this.queueOutline();
    const problems = this.problems();
    this.git.start();
    const changes = G.marksFor(this.git.hunks, this.top, end - 1), ranges = this.gutterHover ? this.foldRanges() : null, bulb = this.lightBulbLine();
    let mi = 0, hi = 0;

    // breadcrumbs
    P.move(1, 1);
    const crumbs = this.crumbText();
    P.text(fit(crumbs + (this.buf.dirty ? " ●" : ""), this.cols), c.barFg, c.bg);
    if (this.buf.dirty) { const w = W.textWidth(crumbs + " ", 8); if (w < this.cols) { P.move(1, w + 1); P.text("●", c.warn, c.bg); } }

    for (let r = 0, k = -1; r < height; r++) {
      const { line: l, lens, ghost: gk, sub = 0 } = layout[r], folded = l >= 0 && this.folds.has(l);
      P.move(r + 2, 1);
      if (lens) { this.paintLens(P, l, lens); continue; }
      if (gk) { // a ghost text line below the cursor's row
        P.text(" ".repeat(gw), c.fg, c.bg);
        const r = this.wrapOf(ghost.line), gs = this.rowPos(ghost).sub, x = this.paintGhostTail(P, ghost, gk, 0, 0, width, c.bg, () => null, null, this.left, r, gs);
        if (x < width) P.text(" ".repeat(width - x), c.fg, c.bg);
        continue;
      }
      if (!sub || (r === 0 && l >= 0)) k++; // the line's index in rows (guides)
      if (l < 0) { P.text(" ".repeat(this.cols), c.fg, c.bg); continue; }
      const active = l === this.head.line, wrap = this.wrapOf(l), lastRow = sub === WR.last(wrap);
      const spans = []; // this line's squiggles, the most severe first
      for (const d of problems) { if (d.start.line > l) break; const s = Editor.problemSpan(d, l, this.lines[l]); if (s) spans.push({ ...s, color: c.diag[d.severity], severity: d.severity }); }
      spans.sort((a, b) => a.severity - b.severity);
      // a wrapped line: the number, marks and chevron on its first row; its change bar on every row, a deletion mark
      // under its last row / over its first
      const change = changes.get(l), rowChange = change === "deletedBelow" ? (lastRow ? change : null) : change === "deletedAbove" && sub ? null : change;
      if (sub) this.paintGutter(P, l, active, rowChange, null, " ", "●", false);
      else this.paintGutter(P, l, active, rowChange, l === bulb ? c.lightBulb : spans[0]?.color, folded ? "›" : ranges && FD.rangeAt(ranges, l) ? "⌄" : " ", l === bulb ? "◆" : "●");
      const lineBg = active && empty ? c.currentLine : folded ? c.foldBackground : c.bg;
      while (mi < ms.length && ms[mi].line < l) mi++;
      const lineMatches = [];
      for (let k = mi; k < ms.length && ms[k].line === l; k++) lineMatches.push(ms[k]);
      while (hi < occ.length && occ[hi].line < l) hi++;
      const lineHits = [];
      for (let k = hi; k < occ.length && occ[k].line === l; k++) lineHits.push(occ[k]);
      this.paintLine(P, l, lineBg, ss, se, lineMatches, width, { ghost: ghost && l === ghost.line && sub === this.rowPos(ghost).sub ? ghost : null, guide: guides[k], brackets: brackets.filter(b => b.line === l), hits: lineHits, hitBg: hits?.bg, problems: spans, folded, wrap, sub });
    }
    this.marks = this.vbar.shown ? this.rulerMarks(ms, hits, problems) : null;
    this.vbar.paint(P, c, this.marks);
    if (this.hbar.shown) { P.move(height + 2, 1); P.text(" ".repeat(this.cols), c.fg, c.bg); this.hbar.paint(P, c); }

    if (this.peek) {
      this.peekRow = Math.max(2, Math.min(this.screenOf(this.head).row + 1, height + 2 - this.peek.height));
      this.peek.render(P, this, this.peekRow);
    }
    if (this.panel) this.panel.render(P, this);
    this.hoverBox?.render(P, this);
    this.renderStatus(P);
    let cursor = this.renderPrompt(P);
    if (this.popup) { this.popup.cursor = null; this.popup.render(P, this); cursor = this.popup.cursor ?? "hide"; }
    P.out += "\x1b[0m" + SB.hoverMode(this, this.vbar.shown || this.hbar.shown || this.lines.length > 1); // bars and chevrons follow the pointer
    if (cursor === "hide") P.out += "\x1b[?25l";
    else if (cursor) P.out += `\x1b[${cursor[0]};${cursor[1]}H\x1b[?25h`;
    else {
      const { line } = this.head, { sub, x: hx } = this.rowPos(this.head), x = hx - this.left;
      const row = this.rowsTo(line, sub), visible = !this.folds.isHidden(line) && row >= 0 && row < height && x >= 0 && x < width;
      P.out += visible ? `\x1b[${row + 2};${gw + x + 1}H\x1b[?25h` : "\x1b[?25l";
    }
    return { out: P.out, done };
  }

  // Indent guides of the visible lines (one per row, each run of consecutive lines between folds computed at once),
  // recomputed when the text, the view, the folds or the cursor line changes.
  guidesFor(rows) {
    const key = `${this.buf.version}:${this.top}:${rows.length}:${this.head.line}:${this.tab}:${this.folds.version}`;
    if (this._guides?.key !== key || this._guides.buf !== this.buf) {
      const out = [];
      for (let r = 0, k; r < rows.length && rows[r] >= 0; r = k + 1) {
        for (k = r; rows[k + 1] === rows[k] + 1; k++);
        out.push(...D.indentGuides(this.lines, rows[r], rows[k], this.tab, this.tab, this.head.line));
      }
      this._guides = { key, buf: this.buf, rows: out };
    }
    return this._guides.rows;
  }
  // The bracket at the cursor and its partner ([at, partner] or null), brackets in strings and comments not counting.
  bracketPair() {
    const key = `${this.buf.version}:${this.head.line}:${this.head.col}:${this.hl.validTo}`;
    if (this._brackets?.key !== key || this._brackets.buf !== this.buf) this._brackets = { key, buf: this.buf, pair: D.matchBracket(this.lines, this.head, this.isCode) };
    return this._brackets.pair;
  }
  // False inside strings, comments and regexes (by the token type): their brackets don't count. Lines not tokenized yet count as code.
  isCode = (line, col) => { const tk = this.hl.tokens[line]; return !tk || H.tokenTypeOf(tk[H.tokenIndex(tk, col) + 1]) === 0; };
  // Go to Bracket (VS Code's jumpToBracket): from the bracket touching the cursor (the one after it first) to the
  // position before its partner, else to the closer of the pair around the cursor, else to the next bracket.
  jumpToBracket() {
    const p = this.range()[0], pair = D.matchBracket(this.lines, p, this.isCode, undefined, true);
    const touches = (b) => b.line === p.line && (p.col === b.col || p.col === b.col + 1);
    const to = pair ? pair[touches(pair[1]) ? 0 : 1] : D.enclosingBrackets(this.lines, p, this.isCode)?.[1] ?? D.nextBracket(this.lines, p, this.isCode);
    if (to) this.moveTo(to);
  }
  // Select to Bracket: the pair at the cursor (else around it, else the next one) with its brackets, backwards from the closer.
  selectToBracket() {
    const p = this.range()[0];
    let pair = D.matchBracket(this.lines, p, this.isCode, undefined, true) ?? D.enclosingBrackets(this.lines, p, this.isCode);
    if (!pair) { const n = D.nextBracket(this.lines, p, this.isCode); pair = n && D.matchBracket(this.lines, n, this.isCode, undefined, true); }
    if (!pair) return;
    const [open, close] = cmp(pair[0], pair[1]) < 0 ? pair : [pair[1], pair[0]];
    const from = open, to = { line: close.line, col: close.col + 1 }, back = close.line === p.line && (p.col === close.col || p.col === to.col);
    this.sel = back ? { anchor: to, head: from } : { anchor: from, head: to };
    this.buf.seal(); this.reveal();
  }
  // The word whose occurrences highlight: the one at the cursor once it has rested there WORD_DELAY ms (a redraw is
  // scheduled for then), null before that, while typing or with a selection.
  restingWord() {
    const w = this.empty ? this.wordAt() : null;
    const key = w && `${this.file}:${this.buf.version}:${w.start.line}:${w.start.col}:${w.text}`;
    if (key !== this.wordKey) {
      this.wordKey = key; this.wordSince = Date.now();
      clearTimeout(this.wordTimer);
      if (key) (this.wordTimer = setTimeout(() => this.redraw(), WORD_DELAY)).unref?.();
      return null;
    }
    return key && Date.now() - this.wordSince >= WORD_DELAY ? w.text : null;
  }
  // The resting word's references from the running language server (documentHighlight: reads in
  // editor.wordHighlightBackground, writes in editor.wordHighlightStrongBackground), asked once per resting word;
  // nothing while it answers, null (the plain word occurrences instead) without a server or when it fails.
  referenceHighlights() {
    if (!this.lang.live("documentHighlight")) return null;
    const c = this.colors, key = this.wordKey, buf = this.buf;
    let req = this._refs;
    if (req?.key !== key || req.buf !== buf) {
      req = this._refs = { key, buf, hits: undefined };
      const done = (hits) => { req.hits = hits; if (this._refs === req) this.redraw(); };
      this.lang.background("documentHighlight", "highlights", this.langCtx()).then(list => done(list && {
        list: list.filter(h => h.end.line === h.line && h.end.col > h.col).map(h => ({ line: h.line, col: h.col, len: h.end.col - h.col,
          bg: h.kind === 3 ? c.wordHighlightStrong : c.wordHighlight, ruler: h.kind === 3 ? c.rulerWordStrong : c.rulerWord }))
          .sort((a, b) => a.line - b.line || a.col - b.col),
        bg: c.wordHighlight, ruler: c.rulerWord }), () => done(null));
    }
    return req.hits === undefined ? { list: [], bg: c.wordHighlight, ruler: c.rulerWord } : req.hits;
  }
  // Occurrences to highlight { list: [{ line, col, len, bg?, ruler? }], bg, ruler } or null: exact matches of a one-line selection
  // (selection highlight), else whole-word matches of the resting word (occurrence highlight). The whole file up to
  // 20,000 lines (for the overview ruler), else the visible lines; cached per text version and needle.
  highlights(height) {
    const [s, e] = this.range(), sel = !this.empty && s.line === e.line ? this.buf.getText(s, e) : null;
    const text = sel?.trim() ? sel : null, word = this.restingWord();
    if (!text && !word) return null;
    const refs = text ? null : this.referenceHighlights();
    if (refs) return refs;
    const whole = this.lines.length <= 20000, a = whole ? 0 : this.top, b = whole ? this.lines.length - 1 : this.top + height - 1;
    const key = `${this.buf.version}:${a}:${b}:${text ? "s" + text : "w" + word}`;
    if (this._hits?.key !== key || this._hits.buf !== this.buf) {
      const c = this.colors;
      this._hits = { key, buf: this.buf, list: text ? D.textMatches(this.lines, a, b, text) : D.wordMatches(this.lines, a, b, word),
        bg: text ? c.selectionHighlight : c.wordHighlight, ruler: text ? c.rulerSelection : c.rulerWord };
    }
    return this._hits;
  }
  // The gutter, `gutter` cells: a problem's mark `●` or the light bulb `◆` in the glyph margin (the first column, `mark`
  // its color), the line number (blank on a wrapped line's later rows: `number` false), the git change bar (or a
  // deletion marker), the fold chevron.
  paintGutter(P, l, active, change, mark = null, fold = " ", glyph = "●", number = true) {
    const c = this.colors;
    P.text(mark ? glyph : " ", mark ?? c.lineNumber, c.bg);
    P.text((number ? String(l + 1) : "").padStart(this.gutter - 3), active ? c.lineNumberActive : c.lineNumber, c.bg);
    P.text(GIT_GLYPHS[change] ?? " ", change ? c[GIT_COLORS[change]] : c.fg, c.bg);
    P.text(fold, c.foldControl, c.bg);
  }
  // deco: { guide: { count, active }, brackets: [{ col }], hits: [{ col, len }], hitBg, problems: [{ from, to, color }], folded,
  // wrap, sub } for this line; wrap / sub: its rows (wrap.cjs) and the one to paint (all of it without them).
  paintLine(P, l, lineBg, ss, se, lineMatches, width, deco = {}) {
    const c = this.colors, text = this.lines[l], g = deco.guide, size = this.tab;
    const selFrom = l < ss.line || l > se.line ? -1 : l === ss.line ? ss.col : 0;
    const selTo = l < ss.line || l > se.line ? -1 : l === se.line ? se.col : Infinity;
    const cur = this.currentMatchRange(), sc = this.prompt?.kind === "find" ? this.find.scope : null;
    const scopeFrom = !sc || l < sc.start.line || l > sc.end.line ? -1 : l === sc.start.line ? sc.start.col : 0;
    const scopeTo = sc && l === sc.end.line ? sc.end.col : Infinity;
    const bgAt = (i) => {
      const m = lineMatches.find(m => i >= m.col && i < m.col + m.len);
      if (m) return cur && cur.line === l && cur.col === m.col ? c.match : c.matchOther;
      if (selFrom !== -1 && i >= selFrom && i < selTo) return c.selection;
      if (deco.brackets?.some(b => b.col === i)) return c.bracketMatch;
      const h = deco.hits?.find(h => i >= h.col && i < h.col + h.len);
      if (h) return h.bg ?? deco.hitBg;
      return scopeFrom !== -1 && i >= scopeFrom && i < scopeTo ? c.findRange : null;
    };
    // a guide at every indent step the line has, the active block's in its own color
    const guideAt = g?.count ? (k) => (k % size === 0 && k / size < g.count ? (k / size === g.active ? c.guideActive : c.guide) : null) : null;
    const curlyAt = deco.problems?.length ? (i) => deco.problems.find(s => i >= s.from && i < s.to)?.color ?? null : null;
    // the row's part of the line: its wrap indent (with the guides in it, as VS Code draws them), then display columns
    // [left, end) of the line in `width` cells
    const r = deco.wrap ?? WR.ONE, sub = deco.sub ?? 0, last = sub === WR.last(r), ind = sub ? r.indent : 0;
    const pad = Math.min(width, Math.max(0, ind - this.left)), left = r.cols[sub] + Math.max(0, this.left - ind);
    const from = sub ? { i: r.starts[sub], col: r.cols[sub] } : null, end = last ? Infinity : r.cols[sub + 1];
    if (pad) this.paintGuides(P, this.left, pad, guideAt, lineBg);
    width -= pad;
    const tw = Math.max(0, Math.min(width, end - left)), tokens = this.hl.tokens[l] ?? null, rowGuides = sub ? null : guideAt;
    if (deco.ghost) { // the row up to the cursor, the ghost text, then the rest of the row
      const g = deco.ghost, cx = W.displayCol(text, g.col, size);
      let gx = cx > left ? this.paintText(P, text, tokens, Math.min(tw, cx - left), left, lineBg, bgAt, size, rowGuides, curlyAt, null, from).x : 0;
      gx = this.paintGhostTail(P, g, 0, cx, gx, width, lineBg, bgAt, curlyAt, left, r, sub);
      if (gx < width) P.text(" ".repeat(width - gx), c.fg, lineBg);
      return;
    }
    const link = this.link?.line === l ? this.link : null;
    let { x, col } = this.paintText(P, text, tokens, tw, left, lineBg, bgAt, this.tab, rowGuides, curlyAt, link, from);
    if (!last) return x < width && P.text(" ".repeat(width - x), c.fg, lineBg);
    // Selection past the line end shows one cell for the line break, like VS Code.
    if (x < width && selFrom !== -1 && selTo > text.length && col >= left) { P.text(" ", c.fg, c.selection); x++; }
    if (deco.folded && x < width && col >= left) { const m = " ⋯".slice(0, width - x); P.text(m, c.foldPlaceholder, lineBg); x += m.length; } // VS Code's collapsed marker
    if (x < width) this.paintGuides(P, left + x, width - x, rowGuides, lineBg); // a blank line's guides go on past its end
  }
  // `count` cells from display column k: an indent guide where guideAt(k) has one, else a space.
  paintGuides(P, k, count, guideAt, bg) {
    const c = this.colors;
    if (!guideAt) return P.text(" ".repeat(count), c.fg, bg);
    let pad = "";
    for (const e = k + count; k < e; k++) {
      const gc = guideAt(k);
      if (!gc) { pad += " "; continue; }
      if (pad) { P.text(pad, c.fg, bg); pad = ""; }
      P.text("│", gc, bg);
    }
    if (pad) P.text(pad, c.fg, bg);
  }
  // Paints a line's visible part [left, left+width) with token colors; bgAt(i) overrides the background at UTF-16 index i,
  // guideAt(col) gives an indent guide's color at a display column of the leading whitespace (not over a selection).
  // curlyAt(i) the squiggle color under UTF-16 index i; link { from, to }: indexes underlined in the link color. Returns
  // { x: cells painted, col: the line's display width }. from { i, col }: a known index and its display column at or
  // before `left` to start at (a wrapped row's start).
  paintText(P, text, tokens, width, left, lineBg, bgAt, tab, guideAt = null, curlyAt = null, link = null, from = null) {
    const c = this.colors;
    let col = from?.col ?? 0, ti = 0, x = 0, i = from?.i ?? 0, lead = !!guideAt;
    const right = left + width;
    if (i && tokens) ti = H.tokenIndex(tokens, i);
    // A long line of single-width characters (a minified file): start at the first visible one instead of walking there.
    if (!from && left > 0 && text.length > 1000 && !/[^\x20-\x7e]/.test(text)) {
      i = col = Math.min(left, text.length);
      if (tokens) ti = H.tokenIndex(tokens, i);
    }
    for (const ch of i ? text.slice(i) : text) {
      if (col >= right) break;
      while (tokens && ti + 2 < tokens.length && tokens[ti + 2] <= i) ti += 2;
      const meta = tokens ? tokens[ti + 1] : 0;
      let fg = tokens ? this.colorMap[H.foregroundOf(meta)] ?? c.fg : c.fg;
      let style = tokens ? H.fontStyleOf(meta) : 0;
      const bg = bgAt(i) ?? lineBg, curly = curlyAt?.(i) ?? null;
      if (link && i >= link.from && i < link.to) { fg = c.link; style |= 4; }
      const cp = ch.codePointAt(0);
      let w, glyph = ch;
      if (ch === "\t") { w = tab - (col % tab); glyph = " ".repeat(w); }
      else { w = W.charWidth(cp); if (cp < 0x20) glyph = String.fromCharCode(0x2400 + cp); else if (cp === 0x7f) glyph = "␡"; }
      if (lead && ch !== " " && ch !== "\t") lead = false;
      if (lead && bg !== c.selection) {
        let g = "", gc = null;
        for (let k = 0; k < w; k++) { const kc = guideAt(col + k); g += kc ? "│" : " "; gc ??= kc; }
        if (gc) { glyph = g; fg = gc; }
      }
      if (w === 0) { if (col > left && col <= right) P.out += ch; }
      else if (col >= left && col + w <= right) { P.text(glyph, fg, bg, style, curly); x += w; }
      else if (col + w > left) { const vis = Math.min(col + w, right) - Math.max(col, left); P.text(" ".repeat(vis), fg, bg, style, curly); x += vis; }
      col += w; i += ch.length;
    }
    return { x, col };
  }
  // Paints ghost text line k from display column `start` after `x` painted cells (in the ghost color, tabs to the next
  // stop), then on its last line the rest of the cursor's row (row `sub` of the line's rows r), moved after it; left: the
  // first display column shown. Returns the cells painted.
  paintGhostTail(P, g, k, start, x, width, lineBg, bgAt, curlyAt, left = this.left, r = WR.ONE, sub = 0) {
    const c = this.colors, text = this.lines[g.line], tab = this.tab, right = left + width;
    let col = start;
    for (const ch of g.lines[k]) {
      const w = ch === "\t" ? tab - (col % tab) : W.charWidth(ch.codePointAt(0));
      if (w && col >= left && col + w <= right) { P.text(ch === "\t" ? " ".repeat(w) : ch.codePointAt(0) < 0x20 ? " " : ch, c.ghost, lineBg); x += w; }
      col += w;
    }
    if (k === g.lines.length - 1 && x < width) {
      const cx = W.displayCol(text, g.col, tab), from = cx + Math.max(0, left - col), end = sub < WR.last(r) ? r.cols[sub + 1] : Infinity;
      x += this.paintText(P, text, this.hl.tokens[g.line] ?? null, Math.max(0, Math.min(width - x, end - from)), from, lineBg, bgAt, tab, null, curlyAt, null, { i: g.col, col: cx }).x;
    }
    return x;
  }
  currentMatchRange() {
    if (this.prompt?.kind !== "find") return null;
    const i = this.currentMatch();
    return i === -1 ? null : this.find.matches[i];
  }

  renderStatus(P) {
    const c = this.colors, { line, col } = this.head;
    const [s, e] = this.range();
    const selected = this.empty ? 0 : this.buf.getText(s, e).length;
    // VS Code's items, clickable like its status bar (the encoding is shown only)
    const parts = [
      { text: `Ln ${line + 1}, Col ${visibleColumn(this.lines[line], col, this.tab) + 1}` + (selected ? ` (${selected} selected)` : ""), run: () => this.openGoto() },
      { text: this.indent.useTabs ? `Tab Size: ${this.tab}` : `Spaces: ${this.tab}`, run: () => this.pickIndent() },
      { text: this.doc.bom ? "UTF-8 with BOM" : "UTF-8" },
      { text: this.doc.eol === "\r\n" ? "CRLF" : "LF", run: () => this.pickEol() },
      this.wrapStatus(),
      { text: this.language, run: () => this.pickLanguage() },
    ];
    if (this.settings["files.autoSave"] !== "off") parts.unshift({ text: "Auto Save" });
    const inline = this.inlineStatus();
    if (inline) parts.push(inline);
    const rightText = parts.map(p => p.text).join("   ") + "  ";
    let leftText = "", leftColor = c.barFg;
    if (this.message && this.message.until > Date.now()) { leftText = this.message.text; leftColor = this.message.color; }
    else this.message = null;
    if (!leftText) { // the problem at the cursor, else the file's problem counts
      const d = this.problemAtCursor(), ps = d ? [] : this.problems();
      if (d) { leftText = d.message.split("\n")[0] + (d.source ? `  ${d.source}` : ""); leftColor = c.diag[d.severity]; }
      else if (ps.length) {
        const n = (sev) => ps.filter(p => p.severity === sev).length;
        leftText = `⊗ ${n(1)}  ⚠ ${n(2)}` + (n(3) ? `  ℹ ${n(3)}` : "");
      }
    }
    const offer = leftText ? null : this.installOffer();
    if (offer) leftText = `Install ${offer.label} (${offer.command})?`;
    if (this.prompt?.kind === "find" && this.find.query) {
      const n = this.matches().length, k = this.currentMatch();
      leftText = n ? `Find: ${k === -1 ? "?" : k + 1} of ${n}${n >= 20000 ? "+" : ""}` : "Find: No results";
      leftColor = n ? c.barFg : c.warn;
    }
    const rw = W.textWidth(rightText, 8);
    P.move(this.rows, 1);
    P.text(fit("  " + leftText, Math.max(0, this.cols - rw)), leftColor, c.bar);
    this.statusHits = [];
    if (offer && !(this.prompt?.kind === "find" && this.find.query)) this.statusHits.push({ x: 3, w: Math.min(W.textWidth(leftText, 8), Math.max(0, this.cols - rw - 2)), run: () => this.installServer() });
    if (rw > this.cols) return;
    let x = this.cols - rw + 1;
    parts.forEach((p, i) => {
      const w = W.textWidth(p.text, 8);
      P.text(p.text + (i < parts.length - 1 ? "   " : "  "), p.color ?? c.barFg, c.bar);
      if (p.run) this.statusHits.push({ x, w, run: p.run, hover: p.hover });
      x += w + 3;
    });
  }

  // Draws the active prompt; returns [row, col] for the terminal cursor when it should sit in the prompt.
  renderPrompt(P) {
    const p = this.prompt, c = this.colors;
    if (!p) return null;
    // find widget, top right like VS Code: ▸/▾ (replace) [Find] Aa ab .* N of M ↑ ↓ ×, then [Replace] Replace All
    const w = Math.min(this.cols, 60), x = this.cols - w + 1, f = this.find, compact = w < 40;
    const fw = w - 3 - (compact ? 0 : 28), hits = this.findHits = [];
    this.findBox = { x, y: 2, w, h: p.replace ? 2 : 1 };
    let row = 2, col = x, cursor = null;
    const at = (r) => { row = r; col = x; P.move(r, x); };
    // a cell run painted at the current place; run (optional) makes it clickable
    const cells = (text, fg, bg, run = null) => {
      const n = W.textWidth(text, 8);
      if (run) hits.push({ x: col, y: row, w: n, run });
      P.text(text, fg, bg); col += n;
    };
    const gap = (n = 1) => cells(" ".repeat(n), c.fg, c.widget);
    const btn = (text, run, on = false, fg = c.barFg) => cells(text, on ? c.toggleFg : fg, on ? c.toggleOn : c.widget, run);
    const field = (name, placeholder) => {
      const value = f[name], shown = W.textWidth(value, 8) > fw - 1 ? "…" + [...value].slice(-(fw - 2)).join("") : value;
      if (name === f.field) cursor = [row, col + 1 + Math.min(fw - 2, W.textWidth(shown, 8))];
      cells(fit(" " + (shown || placeholder), fw), shown ? c.fg : c.lineNumber, shown && f.fresh && name === f.field ? c.selection : c.input, () => { f.field = name; f.fresh = false; });
    };
    at(2);
    btn(p.replace ? " ▾" : " ▸", () => { p.replace = !p.replace; f.field = p.replace ? "replace" : "query"; });
    field("query", "Find");
    if (!compact) {
      const n = this.matches().length, k = this.currentMatch();
      const count = f.query ? (n ? `${k === -1 ? "?" : k + 1} of ${n}${n >= 20000 ? "+" : ""}` : "No results") : "";
      gap(); btn("Aa", () => this.toggleFind("caseSensitive"), f.caseSensitive);
      gap(); btn("ab", () => this.toggleFind("wholeWord"), f.wholeWord);
      gap(); btn(".*", () => this.toggleFind("regex"), f.regex);
      gap(); btn("≡", () => this.toggleFindInSelection(), !!f.scope); // Find in Selection
      gap(); cells(fit(count, 10), f.query && !n ? c.error : c.fg, c.widget);
      btn(" ↑", () => this.findNext(-1)); btn(" ↓", () => this.findNext(1)); btn(" ×", () => { this.prompt = null; });
    }
    gap();
    if (p.replace) {
      at(3); gap(2);
      field("replace", "Replace");
      if (!compact) { gap(); btn(" Replace ", () => this.replaceOne(), false, c.fg); gap(); btn(" All ", () => this.replaceAllMatches(), false, c.fg); gap(w - 2 - fw - 16); }
      else gap();
    }
    return cursor;
  }
  // Clicks on the find widget's fields and buttons; true when the event was over the widget.
  findMouse(ev) {
    const b = this.findBox;
    if (!this.prompt || !b || this.dragging || this.vbar.drag !== null || this.hbar.drag !== null) return false;
    if (ev.x < b.x || ev.x >= b.x + b.w || ev.y < b.y || ev.y >= b.y + b.h) return false;
    const hit = this.findHits.find(h => ev.y === h.y && ev.x >= h.x && ev.x < h.x + h.w);
    if (hit && ev.button === 0 && !ev.release && !ev.motion) hit.run();
    return true;
  }

  exit() { this.done = true; this.onExit?.(); }
}

// `folder › folder › file` relative to the enclosing git repo (else the home folder), like VS Code's breadcrumbs.
function breadcrumbs(file) {
  let dir = path.dirname(file), root = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) { root = d; break; }
    if (path.dirname(d) === d) break;
  }
  const base = root ?? (file.startsWith(os.homedir() + path.sep) ? os.homedir() : "/");
  return path.relative(base, file).split(path.sep).filter(Boolean);
}

// Whether an inline suggestion provider can run here (the default of editor.inlineSuggest.enabled): Ollama installed,
// or an endpoint set. Looked up once per provider.
const usableSeen = new Map();
function inlineUsable(cfg) {
  if (!usableSeen.has(cfg.provider)) usableSeen.set(cfg.provider, cfg.provider === "ollama" ? !!which("ollama") : true);
  return cfg.customEndpoint || usableSeen.get(cfg.provider);
}

// ---------- clipboard ----------
function writeClipboard(text) {
  if (process.platform === "darwin") { try { spawnSync("pbcopy", { input: text, timeout: 2000 }); } catch {} }
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`); // OSC 52: the terminal's clipboard
}
function readClipboard() {
  if (process.platform !== "darwin") return null;
  try { const r = spawnSync("pbpaste", { encoding: "utf8", timeout: 2000 }); return r.status === 0 ? r.stdout : null; } catch { return null; }
}

// ---------- terminal ----------
const { ENTER, LEAVE, rightClicksTo } = T;

async function main() {
  const arg = process.argv[2];
  if (!arg) { process.stderr.write("usage: node vsedit.cjs <file>\n"); process.exit(2); }
  const file = path.resolve(arg);
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write("vsedit: needs a terminal\n"); process.exit(1); }
  let doc;
  for (;;) { // a file that can't be opened shows the error page; Try Again comes back here
    try {
      // Binary: straight to hex for known binary names, else ask first (Open Anyway decodes it as text, lossy).
      doc = HV.binaryName(file) ? { binary: true } : F.load(file);
      if (doc.binary && (await HV.open(file, { ask: !HV.binaryName(file), crumbs: breadcrumbs(file), clipboard: writeClipboard })) === "text") doc = F.load(file, { lossy: true });
    } catch (e) {
      // Started by hand, a missing file is a new one; the Explorer only opens files that exist.
      doc = e.code === "ENOENT" && !T.closeOnExit() ? { lines: [""], eol: "\n", finalNewline: true, bom: false, stamp: null } : { error: E.reasonOf(e) };
    }
    if (!doc.error) break;
    await E.show(file, doc.error, breadcrumbs(file));
  }

  const settings = S.load();
  const index = H.loadIndex(), theme = H.loadTheme(), scope = L.scopeOf(index, path.basename(file));
  // Paint the text right away; the grammar (oniguruma wasm, regex compilation) loads after the first frame.
  const ed = new Editor(file, doc, { grammar: null, colorMap: [], textmate: { INITIAL: null } }, theme, scope, settings.values);
  ed.language = L.languageName(index.scopes[scope] ? scope : null);
  ed.settingsStamp = settings.stamp;
  const keys = K.live();
  ed.keymap = keys.keymap;
  if (keys.error) ed.say(keys.error, ed.colors.warn, 6000);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { process.stdout.write(LEAVE); } catch {}
    try { process.stdin.setRawMode(false); } catch {}
    if (langModule) Lang.shutdown();
    rightClicksTo("menu", true);
  };
  // Closed from outside (tab closed, terminal gone): keep unsaved text as a backup, then leave.
  const hotExit = (code) => { ed.hotExit(); restore(); process.exit(code); };
  process.on("exit", restore);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => hotExit(128 + (os.constants.signals[sig] ?? 1)));
  process.on("uncaughtException", (e) => { try { ed.hotExit(); } catch {} restore(); crashed(file, e); });
  process.stdin.on("end", () => hotExit(129));
  process.stdin.on("error", () => hotExit(129));
  process.stdout.on("error", () => hotExit(129));

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdout.write(ENTER + S.cursorSeq(ed.settings) + `\x1b]12;${ed.colors.cursor}\x07`);
  rightClicksTo("program", false);

  let scheduled = false, timer = null;
  const draw = (budget = 60) => {
    scheduled = false;
    ed.rows = process.stdout.rows || 24; ed.cols = process.stdout.columns || 80;
    const { out, done } = ed.render(budget);
    // The cursor shape goes out with every frame: Herdr resets it on focus, tab switches and resizes, and a setting may have changed.
    process.stdout.write("\x1b[?25l" + S.cursorSeq(ed.settings) + out);
    if (!done) schedule(); // keep tokenizing toward the viewport in small slices
    clearTimeout(timer);
    if (ed.message) timer = setTimeout(schedule, Math.max(50, ed.message.until - Date.now() + 10));
  };
  const schedule = () => { if (!scheduled) { scheduled = true; setImmediate(() => draw()); } };
  ed.redraw = () => { ed.afterEvent(); schedule(); };
  ed.onExit = () => { restore(); process.exit(0); };
  Lang.setApplyEdit((ws) => { ed.applyEdit(ws); schedule(); return true; });
  Lang.setOnDiagnostics(() => schedule());
  setInterval(() => {
    const rebound = keys.poll();
    if (rebound) { ed.keymap = keys.keymap; if (keys.error) ed.say(keys.error, ed.colors.warn, 6000); }
    const reread = ed.pollSettings();
    if (reread) ed.inlineWarmup();
    if (reread || rebound) schedule();
  }, 2000).unref();

  let pending = "";
  const log = T.inputLog();
  process.stdin.on("data", (chunk) => {
    log(chunk);
    const { events, rest } = parse(pending + chunk);
    pending = rest;
    let changed = !events.length;
    for (const ev of events) {
      const out = ed.hover(ev); // hover motion repaints only the bar it changed, without a frame
      if (out === null) { ed.handle(ev); ed.afterEvent(); changed = true; } else if (out) process.stdout.write(out);
    }
    // A split escape sequence that never completes was a plain Esc.
    if (pending) setTimeout(() => { if (pending === rest) { pending = ""; ed.handle({ type: "key", name: "escape" }); schedule(); } }, 50);
    if (changed) schedule();
  });
  process.stdout.on("resize", schedule);
  ed.offerBackup();
  ed.noteCursor(); // where Cursor Undo goes back to first
  draw(0); // the text at once, uncolored
  ed.useGrammar(await H.loadGrammar(scope, index, theme));
  draw(1000); // the first colored screen waits for its colors
  ed.inlineWarmup();
}

// A crash shows the error page (unsaved text is already in a backup); Try Again starts the editor again in this terminal.
let crashing = false;
async function crashed(file, e) {
  if (crashing) { process.stderr.write(`vsedit crashed: ${e && e.stack || e}\n`); process.exit(1); }
  crashing = true;
  await E.show(file, `vsedit crashed: ${E.reasonOf(e)}`, breadcrumbs(file));
  process.stdin.pause(); // the restarted editor reads the terminal
  process.exit(spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" }).status ?? 1);
}

if (require.main === module) main().catch((e) => crashed(path.resolve(process.argv[2]), e));
module.exports = { Editor, paletteOf, blend, wordLeft, wordRight, breadcrumbs };
