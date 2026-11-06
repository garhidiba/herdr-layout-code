#!/usr/bin/env node
// A VS Code-like terminal editor: VS Code's own tokenizer and One Dark colors, VS Code's macOS keys (⌘ through the Kitty
// keyboard protocol, Ctrl as fallback), its editor context menu and command palette, language intelligence (lang/),
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

// ---------- the editor ----------
const DOC_FIELDS = ["file", "doc", "buf", "hl", "indent", "scope", "language", "comment", "crumbs", "root", "session", "sel", "goal", "top", "left", "seenVersion"];
const NOT_FOUND = { definition: "definition", typeDefinition: "type definition", implementation: "implementation", references: "references" };
const PEEK_TITLE = { definition: "Definition", typeDefinition: "Type Definition", implementation: "Implementations", references: "References" };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stampText = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

class Editor {
  // settings: S.normalize()d values (the file is read by main, not here).
  constructor(file, doc, { grammar, colorMap, textmate }, theme, scope, settings = S.normalize()) {
    this.theme = theme; this.textmate = textmate; this.settings = settings;
    this.colors = paletteOf(theme.colors);
    this.colorMap = this.colorsOf(colorMap);
    this.docs = new Map(); this.loading = new Map(); this.fileLines = new Map();
    Object.assign(this, this.makeState(file, doc, grammar, scope));
    this.prompt = null; this.message = null; this.find = { query: "", replace: "", field: "query", matches: [], version: -1 };
    this.popup = null; this.panel = null; this.peek = null; // overlays (popup: menu, picker, input or dialog)
    this.back = []; this.forward = [];                       // navigation history: { file, pos, top }
    this.clip = { text: "", whole: false };
    this.lastClick = { time: 0, line: -1, col: -1 }; this.dragging = false;
    this.rows = 24; this.cols = 80;
    this.redraw = () => {}; this.onExit = null; this.autoTimer = null;
  }

  // Everything that belongs to one open file; switching files swaps these fields.
  makeState(file, doc, grammar, scope) {
    const buf = new TextBuffer(doc.lines), hl = new H.Highlighter(grammar, this.textmate.INITIAL, buf.lines);
    buf.listeners.push((s, r, n) => hl.onEdit(s, r, n));
    const fallback = { useTabs: !this.settings["editor.insertSpaces"], size: this.settings["editor.tabSize"] };
    return { file, doc, buf, hl, indent: F.detectIndent(buf.lines, fallback), scope, language: L.languageName(grammar ? scope : null),
      comment: L.commentOf(scope), crumbs: breadcrumbs(file), root: gitRoot(file), session: null, sel: caret({ line: 0, col: 0 }),
      goal: null, top: 0, left: 0, seenVersion: 0 };
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
  get height() { return Math.max(1, this.rows - 2 - (this.panel ? this.panel.height(this) : 0)); }
  get gutter() { return Math.max(3, String(this.lines.length).length) + 3; }
  get textWidth() { return Math.max(1, this.cols - this.gutter); }
  range() { return ordered(this.sel.anchor, this.sel.head); }
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
    if (line < this.top) this.top = line;
    if (line >= this.top + this.height) this.top = line - this.height + 1;
    const x = W.displayCol(this.lines[line], col, this.tab);
    if (x < this.left) this.left = Math.max(0, x - 4);
    if (x >= this.left + this.textWidth) this.left = x - this.textWidth + 5;
  }
  vertical(delta, extend) {
    const { line, col } = this.head;
    if (this.goal == null) this.goal = W.displayCol(this.lines[line], col, this.tab);
    const target = line + delta;
    if (target < 0) return this.moveTo({ line: 0, col: 0 }, extend);
    if (target >= this.lines.length) return this.moveTo({ line: this.lines.length - 1, col: this.lines[this.lines.length - 1].length }, extend);
    this.moveTo({ line: target, col: W.indexAtCol(this.lines[target], this.goal, this.tab) }, extend, true);
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
  home(extend) {
    const { line, col } = this.head, first = this.lines[line].search(/\S|$/);
    this.moveTo({ line, col: col === first ? 0 : first }, extend);
  }

  // ----- editing -----
  // Replaces the selection (or the given range) with text, as one undo step.
  insert(text, kind = null) {
    const before = this.sel, [s, e] = this.range();
    this.buf.edit([{ start: s, end: e, text }], { before, after: caret(endOf(s, text)), kind });
    this.sel = caret(endOf(s, text)); this.goal = null; this.reveal(); // no seal: typing keeps grouping
  }
  typed(text) {
    text = text.replace(/\r\n?/g, "\n");
    this.insert(text, text.includes("\n") ? null : "type");
  }
  deleteRange(s, e) {
    if (cmp(s, e) === 0) return;
    const before = this.sel;
    this.buf.edit([{ start: s, end: e, text: "" }], { before, after: caret(s) });
    this.moveTo(s);
  }
  backspace(word) {
    if (!this.empty) return this.deleteRange(...this.range());
    const { line, col } = this.head, text = this.lines[line];
    if (col === 0) return line > 0 && this.deleteRange({ line: line - 1, col: this.lines[line - 1].length }, this.head);
    let to = word ? wordLeft(text, col) : W.prevIndex(text, col);
    const lead = text.slice(0, col);
    if (!word && !this.indent.useTabs && /^ +$/.test(lead)) to = Math.max(0, col - (((col - 1) % this.tab) + 1)); // to the previous tab stop
    this.deleteRange({ line, col: to }, this.head);
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
  toggleComment() {
    if (!this.comment) return this.say(`No comment syntax known for ${this.language}`, this.colors.warn);
    const [a, b] = this.selectedLines(), rows = [];
    for (let l = a; l <= b; l++) if (this.lines[l].trim()) rows.push(l);
    if (!rows.length) return;
    const [open, close] = this.comment.block ?? [this.comment.line, null];
    const lead = (t) => t.match(/^[\t ]*/)[0].length;
    const commented = rows.every(l => this.lines[l].slice(lead(this.lines[l])).startsWith(open) && (!close || this.lines[l].trimEnd().endsWith(close)));
    const edits = [];
    if (commented) {
      for (const l of rows) {
        const t = this.lines[l], at = lead(t), sp = t[at + open.length] === " " ? 1 : 0;
        if (close) {
          const end = t.trimEnd().length - close.length, sp2 = t[end - 1] === " " ? 1 : 0;
          edits.push({ line: l, col: end - sp2, remove: close.length + sp2, text: "" });
        }
        edits.push({ line: l, col: at, remove: open.length + sp, text: "" });
      }
    } else {
      const at = Math.min(...rows.map(l => lead(this.lines[l])));
      for (const l of rows) {
        if (close) edits.push({ line: l, col: this.lines[l].trimEnd().length, remove: 0, text: " " + close });
        edits.push({ line: l, col: at, remove: 0, text: open + " " });
      }
    }
    this.lineEdits(edits);
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
  matches() {
    const f = this.find;
    if (f.version === this.buf.version && f.searched === f.query) return f.matches;
    f.matches = []; f.version = this.buf.version; f.searched = f.query;
    if (!f.query) return f.matches;
    const q = f.query.toLowerCase();
    for (let l = 0; l < this.lines.length && f.matches.length < 20000; l++) {
      const t = this.lines[l].toLowerCase();
      for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) f.matches.push({ line: l, col: i, len: q.length });
    }
    return f.matches;
  }
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
    if (this.currentMatch() === -1) return this.findNext(1);
    const s = this.range()[0];
    this.insert(this.find.replace);
    this.findNext(1, endOf(s, this.find.replace));
  }
  replaceAll() {
    const ms = this.matches();
    if (!ms.length) return;
    const before = this.sel;
    this.buf.edit([...ms].reverse().map(m => ({ start: { line: m.line, col: m.col }, end: { line: m.line, col: m.col + m.len }, text: this.find.replace })), { before });
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
      this.buf.markSaved(); this.buf.seal(); B.remove(this.file);
      this.session?.saved(this.file);
      if (!auto) this.say("Saved", this.colors.ok);
      return true;
    } catch (e) { this.say(`Failed to save: ${e.message}`, this.colors.error, 8000); return false; }
    finally { this.redraw(); }
  }
  // Writes another open file as it is (rename across files, auto save).
  writeState(st) {
    try { st.doc.stamp = F.save(st.file, F.encode(st.buf.lines, st.doc)); st.buf.markSaved(); B.remove(st.file); return true; }
    catch (e) { this.say(`Failed to save ${path.basename(st.file)}: ${e.message}`, this.colors.error, 8000); return false; }
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
    if (pos) { this.moveTo(pos); this.top = Math.max(0, this.head.line - Math.floor(this.height / 3)); }
    this.redraw();
    return true;
  }
  jumpTo(loc) { return this.track(this.open(loc.file, { line: loc.line, col: loc.col })); }
  pushNav() { this.back.push({ file: this.file, pos: { ...this.head }, top: this.top }); if (this.back.length > 50) this.back.shift(); this.forward = []; }
  navigate(dir) {
    const from = dir < 0 ? this.back : this.forward, to = dir < 0 ? this.forward : this.back, e = from.pop();
    if (!e) return;
    to.push({ file: this.file, pos: { ...this.head }, top: this.top });
    return this.track(this.open(e.file, null, false).then(() => { this.moveTo(e.pos); this.top = e.top; }));
  }

  // ----- prompts and overlays -----
  dialog(title, detail, buttons) { this.popup = new O.Dialog({ title, detail, buttons }); }
  closePopup() { this.popup = null; }
  openFind(replace) {
    const [s, e] = this.range();
    if (!this.empty && s.line === e.line) this.find.query = this.buf.getText(s, e);
    this.find.field = replace && this.find.query ? "replace" : "query";
    this.prompt = { kind: "find", replace, origin: this.sel };
  }
  findAgain(dir) {
    const [s, e] = this.range();
    if (!this.find.query && !this.empty && s.line === e.line) this.find.query = this.buf.getText(s, e);
    if (!this.find.query) return this.openFind(false);
    this.findNext(dir);
  }
  openGoto() { this.popup = new O.Input({ label: `Go to line (1-${this.lines.length}), :col optional:`, onAccept: (v) => this.gotoText(v) }); }
  gotoText(text) {
    const [ln, col] = text.split(/[:,]/).map(Number);
    if (!ln) return;
    const line = Math.max(0, Math.min(this.lines.length, ln) - 1);
    this.moveTo({ line, col: col ? col - 1 : 0 });
    this.top = Math.max(0, line - Math.floor(this.height / 2));
  }
  // Screen cell under a buffer position (row, col), for popups placed at the cursor.
  screenOf(p) { return { row: p.line - this.top + 2, col: this.gutter + W.displayCol(this.lines[p.line], p.col, this.tab) - this.left + 1 }; }
  openMenu(x, y) { this.popup = new O.Menu(C.menuRows(C.MENU, cap => this.lang.can(cap)), x, y); }
  openMenuAtCursor() { const s = this.screenOf(this.head); this.openMenu(Math.max(1, s.col), Math.min(this.rows, s.row + 1)); }
  openPicker(prefix) {
    this.popup = new O.Picker(prefix, (t) => this.pickItems(t), "Search files by name (: to go to a line, > for commands)");
  }
  pickItems(text) {
    if (text.startsWith(">")) {
      return C.filter(C.COMMANDS, text.slice(1).trim(), c => c.title).map(({ item, hits }) => ({ label: item.title, hits, key: item.key,
        detail: item.run === "toggleAutoSave" || item.run === "askAutoSaveDelay" ? S.autoSaveLabel(this.settings) : "", run: () => this.runCommand(item.id) }));
    }
    if (text.startsWith(":")) return [{ label: text.length > 1 ? `Go to line ${text.slice(1)}` : "Type a line number to go to", run: () => this.gotoText(text.slice(1)) }];
    return C.filter(this.projectFiles(), text.trim(), f => f).slice(0, 300)
      .map(({ item, hits }) => ({ label: item, hits, run: () => this.track(this.open(path.join(this.root, item))) }));
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
    if (ev.type === "text" || ev.type === "paste") return set(f[f.field] + ev.text.split(/\r?\n|\r/)[0]);
    if (ev.type !== "key") return;
    const { name, shift, ctrl, alt, cmd } = ev, chord = C.chordOf(ev);
    if (name === "escape") { this.prompt = null; return; }
    if (name === "backspace") return set([...f[f.field]].slice(0, -1).join(""));
    if (name === "tab" && p.replace) { f.field = f.field === "query" ? "replace" : "query"; return; }
    if (chord === "ctrl+h" || chord === "cmd+alt+f") { p.replace = true; f.field = "replace"; return; }
    if (chord === "ctrl+f" || chord === "cmd+f") { p.replace = false; f.field = "query"; return; }
    if (name === "enter" && (alt || cmd) && p.replace) return this.replaceAll();
    if (name === "enter" && f.field === "replace") return this.replaceOne();
    if (name === "g" && cmd) return this.findNext(shift ? -1 : 1);
    if (name === "enter" || name === "f3" || name === "down") return this.findNext(shift ? -1 : 1);
    if (name === "up") return this.findNext(-1);
    void ctrl;
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

  // ----- language features -----
  langCtx() {
    const [s, e] = this.range(), { line, col } = this.head;
    return { file: this.file, lines: this.lines, line, col, sel: { start: s, end: e }, tabSize: this.tab, insertSpaces: !this.indent.useTabs,
      word: this.wordAt()?.text ?? "", language: this.language };
  }
  locate(kind) { return this.lang.run(kind, kind, this.langCtx()); }
  noResult(kind) { const w = this.wordAt()?.text; this.say(`No ${NOT_FOUND[kind]} found${w ? ` for '${w}'` : ""}`, this.colors.warn); }
  goTo(kind) {
    return this.track(this.locate(kind).then(locs => {
      if (!locs.length) return this.noResult(kind);
      if (locs.length === 1) return this.jumpTo(locs[0]);
      this.showPanel(PEEK_TITLE[kind], locs);
    }));
  }
  peekAt(kind) {
    return this.track(this.locate(kind).then(locs => {
      if (!locs.length) return this.noResult(kind);
      this.peek = new O.Peek(PEEK_TITLE[kind], locs);
      const row = this.head.line - this.top; // keep the box on screen below the cursor line
      if (row + this.peek.height >= this.height) this.top = Math.max(0, this.head.line - Math.max(0, this.height - this.peek.height - 1));
    }));
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
  codeActions(kind) {
    return this.track(this.lang.run(kind, kind === "refactor" ? "refactors" : "sourceActions", this.langCtx()).then(list => {
      if (!list.length) return this.say(kind === "refactor" ? "No refactorings available" : "No source actions available", this.colors.warn);
      this.popup = new O.Picker("", (t) => C.filter(list, t, a => a.title).map(({ item, hits }) => ({ label: item.title, hits,
        run: () => this.track(item.resolve().then(ws => { const r = this.applyEdit(ws); if (r.failed.length) this.reportEdit(r, "Applied"); })) })),
      kind === "refactor" ? "Select a refactoring" : "Select a source action");
    }));
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
  // The Settings dialog (the vscode-settings mod) through herdr-app; outside Herdr, the JSON file.
  openSettingsUi() {
    const bin = process.env.HC_TERMINAL_ID && which("herdr-app");
    if (!bin) return this.openSettings();
    require("child_process").spawn(bin, ["do", "mod.open", "--name", "vscode-settings"], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  // After each input event: restart the auto-save timer when the text changed.
  afterEvent() {
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
  focusChanged(focused) { if (!focused && this.settings["files.autoSave"] === "onFocusChange") this.autoSave(); }

  // ----- input -----
  handle(ev) {
    if (ev.type === "focus") return this.focusChanged(ev.focused);
    if (ev.type === "mouse") return this.mouse(ev);
    if (this.popup) return void this.popup.key(ev, this);
    if (this.prompt) return this.promptKey(ev);
    if (this.peek && this.peek.key(ev, this)) return;
    if (this.panel?.focused && this.panel.key(ev, this)) return;
    if (ev.type === "text") return this.typed(ev.text);
    if (ev.type === "paste") return this.paste(ev.text);
    const cmd = C.KEYMAP.get(C.chordOf(ev));
    if (cmd) return this.runCommand(cmd.id);
    const { name, ctrl, shift, alt } = ev, last = this.lines.length - 1;
    if (ev.cmd) {
      switch (name) {
        case "left": return this.home(shift);
        case "right": return this.moveTo({ line: this.head.line, col: this.lines[this.head.line].length }, shift);
        case "up": return this.moveTo({ line: 0, col: 0 }, shift);
        case "down": return this.moveTo({ line: last, col: this.lines[last].length }, shift);
        case "backspace": return this.empty ? this.deleteRange({ line: this.head.line, col: 0 }, this.head) : this.backspace(false);
        case "delete": return this.empty ? this.deleteRange(this.head, { line: this.head.line, col: this.lines[this.head.line].length }) : this.deleteForward(false);
      }
      return;
    }
    if (ctrl) {
      switch (name) {
        case "home": return this.moveTo({ line: 0, col: 0 }, shift);
        case "end": return this.moveTo({ line: last, col: this.lines[last].length }, shift);
        case "left": case "right": return this.horizontal(name === "left" ? -1 : 1, shift, true);
        case "up": case "down": this.top = Math.max(0, Math.min(last, this.top + (name === "up" ? -1 : 1))); return;
        case "backspace": case "w": return this.backspace(true);   // ctrl+w: what Herdr sends for ⌥⌫
        case "delete": return this.deleteForward(true);
        case "u": return this.empty ? this.deleteRange({ line: this.head.line, col: 0 }, this.head) : this.backspace(false); // Herdr's ⌘⌫
        case "e": return this.moveTo({ line: this.head.line, col: this.lines[this.head.line].length }, shift);              // Herdr's ⌘→
      }
      return;
    }
    switch (name) {
      case "left": case "right": return this.horizontal(name === "left" ? -1 : 1, shift, alt);
      case "up": case "down": return this.vertical(name === "up" ? -1 : 1, shift);
      case "pageup": case "pagedown": {
        const d = name === "pageup" ? -this.height : this.height;
        this.top = Math.max(0, Math.min(Math.max(0, this.lines.length - this.height), this.top + d));
        return this.vertical(d, shift);
      }
      case "home": return this.home(shift);
      case "end": return this.moveTo({ line: this.head.line, col: this.lines[this.head.line].length }, shift);
      case "enter": return alt ? undefined : this.enter();
      case "tab": return this.tabKey(shift);
      case "backspace": return this.backspace(alt);
      case "delete": return this.deleteForward(alt);
      case "escape": if (!this.empty) this.moveTo(this.head); else if (this.panel) this.panel = null; return;
    }
  }

  // Terminal cell -> buffer position (rows: 1 breadcrumbs, 2..rows-1 text).
  cellToPos(x, y) {
    const line = Math.max(0, Math.min(this.lines.length - 1, this.top + y - 2));
    return { line, col: W.indexAtCol(this.lines[line], Math.max(0, this.left + x - 1 - this.gutter), this.tab) };
  }
  // How far past the text area a drag pointer is, in cells (the gutter and the last column count as past the side).
  dragOverflow(x, y) {
    return { dx: x <= this.gutter ? x - this.gutter - 1 : x >= this.cols ? x - this.cols + 1 : 0,
      dy: y < 2 ? y - 2 : y > this.height + 1 ? y - this.height - 1 : 0 };
  }
  // Extends the dragged selection to the pointer; past an edge, first scrolls toward it (faster the farther out).
  // Returns true while the pointer is outside, so the auto-scroll timer keeps going.
  dragStep() {
    const { x, y } = this.drag, { dx, dy } = this.dragOverflow(x, y);
    if (dy) this.top = Math.max(0, Math.min(this.lines.length - 1, this.top + dy));
    if (dx) {
      let widest = 0;
      for (let l = this.top; l < Math.min(this.lines.length, this.top + this.height); l++) widest = Math.max(widest, W.textWidth(this.lines[l], this.tab));
      this.left = Math.max(0, Math.min(this.left + dx * 2, Math.max(this.left, widest - this.textWidth + 5)));
    }
    const p = this.cellToPos(Math.max(this.gutter + 1, Math.min(x, this.cols)), Math.max(2, Math.min(y, this.height + 1)));
    this.sel = { anchor: this.sel.anchor, head: p };
    return !!(dx || dy);
  }
  stopDragScroll() { clearInterval(this.dragTimer); this.dragTimer = null; }
  mouse(ev) {
    if (this.popup) return void this.popup.mouse(ev, this);
    if (this.panel && this.panel.mouse(ev, this)) return;
    const wheel = ev.button === 64 || ev.button === 65;
    if (wheel && !ev.shift) {
      this.top = Math.max(0, Math.min(Math.max(0, this.lines.length - 1), this.top + (ev.button === 64 ? -3 : 3)));
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
    if (ev.y < 2 || ev.y > this.height + 1) return;
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
    const now = Date.now(), c = this.lastClick;
    const double = now - c.time < 400 && c.line === p.line && c.col === p.col;
    this.lastClick = { time: now, line: p.line, col: p.col };
    this.dragging = true;
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
    const P = new Painter(), c = this.colors, height = this.height, width = this.textWidth, gw = this.gutter;
    this.top = Math.max(0, Math.min(this.top, this.lines.length - 1));
    const deadline = Date.now() + budget;
    // long lines get at most 25 ms a frame, so keys are handled between slices
    const done = this.hl.ensure(this.top + height, deadline) & this.hl.ensureLong(this.top, this.top + height, Math.min(deadline, Date.now() + 25));
    const [ss, se] = this.range(), empty = this.empty;
    const showMatches = this.prompt?.kind === "find" && this.find.query;
    const ms = showMatches ? this.matches() : [];
    let mi = 0;

    // breadcrumbs
    P.move(1, 1);
    const crumbs = this.crumbs.map((s, i) => (i === this.crumbs.length - 1 ? s : s + " › ")).join("");
    P.text(fit(" " + crumbs + (this.buf.dirty ? " ●" : ""), this.cols), c.barFg, c.bg);
    if (this.buf.dirty) { const w = W.textWidth(" " + crumbs + " ", 8); if (w < this.cols) { P.move(1, w + 1); P.text("●", c.warn, c.bg); } }

    for (let r = 0; r < height; r++) {
      const l = this.top + r;
      P.move(r + 2, 1);
      if (l >= this.lines.length) { P.text(" ".repeat(this.cols), c.fg, c.bg); continue; }
      const active = l === this.head.line;
      P.text(String(l + 1).padStart(gw - 2) + "  ", active ? c.lineNumberActive : c.lineNumber, c.bg);
      const lineBg = active && empty ? c.currentLine : c.bg;
      while (mi < ms.length && ms[mi].line < l) mi++;
      const lineMatches = [];
      for (let k = mi; k < ms.length && ms[k].line === l; k++) lineMatches.push(ms[k]);
      this.paintLine(P, l, lineBg, ss, se, lineMatches, width);
    }

    if (this.peek) {
      this.peekRow = Math.max(2, Math.min(this.head.line - this.top + 3, height + 2 - this.peek.height));
      this.peek.render(P, this, this.peekRow);
    }
    if (this.panel) this.panel.render(P, this);
    this.renderStatus(P);
    let cursor = this.renderPrompt(P);
    if (this.popup) { this.popup.cursor = null; this.popup.render(P, this); cursor = this.popup.cursor ?? "hide"; }
    P.out += "\x1b[0m";
    if (cursor === "hide") P.out += "\x1b[?25l";
    else if (cursor) P.out += `\x1b[${cursor[0]};${cursor[1]}H\x1b[?25h`;
    else {
      const { line, col } = this.head, x = W.displayCol(this.lines[line], col, this.tab) - this.left;
      const visible = line >= this.top && line < this.top + height && x >= 0 && x < width;
      P.out += visible ? `\x1b[${line - this.top + 2};${gw + x + 1}H\x1b[?25h` : "\x1b[?25l";
    }
    return { out: P.out, done };
  }

  paintLine(P, l, lineBg, ss, se, lineMatches, width) {
    const c = this.colors, text = this.lines[l];
    const selFrom = l < ss.line || l > se.line ? -1 : l === ss.line ? ss.col : 0;
    const selTo = l < ss.line || l > se.line ? -1 : l === se.line ? se.col : Infinity;
    const cur = this.currentMatchRange();
    const bgAt = (i) => {
      const m = lineMatches.find(m => i >= m.col && i < m.col + m.len);
      if (m) return cur && cur.line === l && cur.col === m.col ? c.match : c.matchOther;
      return selFrom !== -1 && i >= selFrom && i < selTo ? c.selection : null;
    };
    let { x, col } = this.paintText(P, text, this.hl.tokens[l] ?? null, width, this.left, lineBg, bgAt, this.tab);
    // Selection past the line end shows one cell for the line break, like VS Code.
    if (x < width && selFrom !== -1 && selTo > text.length && col >= this.left) { P.text(" ", c.fg, c.selection); x++; }
    if (x < width) P.text(" ".repeat(width - x), c.fg, lineBg);
  }
  // Paints a line's visible part [left, left+width) with token colors; bgAt(i) overrides the background at UTF-16 index i.
  // Returns { x: cells painted, col: the line's display width }.
  paintText(P, text, tokens, width, left, lineBg, bgAt, tab) {
    const c = this.colors;
    let col = 0, ti = 0, x = 0, i = 0;
    const right = left + width;
    // A long line of single-width characters (a minified file): start at the first visible one instead of walking there.
    if (left > 0 && text.length > 1000 && !/[^\x20-\x7e]/.test(text)) {
      i = col = Math.min(left, text.length);
      if (tokens) { let lo = 0, hi = tokens.length / 2 - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tokens[m * 2] <= i) lo = m; else hi = m - 1; } ti = lo * 2; }
    }
    for (const ch of i ? text.slice(i) : text) {
      if (col >= right) break;
      while (tokens && ti + 2 < tokens.length && tokens[ti + 2] <= i) ti += 2;
      const meta = tokens ? tokens[ti + 1] : 0;
      const fg = tokens ? this.colorMap[H.foregroundOf(meta)] ?? c.fg : c.fg, style = tokens ? H.fontStyleOf(meta) : 0;
      const bg = bgAt(i) ?? lineBg;
      const cp = ch.codePointAt(0);
      let w, glyph = ch;
      if (ch === "\t") { w = tab - (col % tab); glyph = " ".repeat(w); }
      else { w = W.charWidth(cp); if (cp < 0x20) glyph = String.fromCharCode(0x2400 + cp); else if (cp === 0x7f) glyph = "␡"; }
      if (w === 0) { if (col > left && col <= right) P.out += ch; }
      else if (col >= left && col + w <= right) { P.text(glyph, fg, bg, style); x += w; }
      else if (col + w > left) { const vis = Math.min(col + w, right) - Math.max(col, left); P.text(" ".repeat(vis), fg, bg, style); x += vis; }
      col += w; i += ch.length;
    }
    return { x, col };
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
    const parts = [
      `Ln ${line + 1}, Col ${visibleColumn(this.lines[line], col, this.tab) + 1}` + (selected ? ` (${selected} selected)` : ""),
      this.indent.useTabs ? `Tab Size: ${this.tab}` : `Spaces: ${this.tab}`, this.doc.bom ? "UTF-8 with BOM" : "UTF-8",
      this.doc.eol === "\r\n" ? "CRLF" : "LF", this.language,
    ];
    if (this.settings["files.autoSave"] !== "off") parts.unshift("Auto Save");
    const rightText = parts.join("   ") + "  ";
    let leftText = "", leftColor = c.barFg;
    if (this.message && this.message.until > Date.now()) { leftText = this.message.text; leftColor = this.message.color; }
    else this.message = null;
    if (this.prompt?.kind === "find" && this.find.query) {
      const n = this.matches().length, k = this.currentMatch();
      leftText = n ? `Find: ${k === -1 ? "?" : k + 1} of ${n}${n >= 20000 ? "+" : ""}` : "Find: No results";
      leftColor = n ? c.barFg : c.warn;
    }
    const rw = W.textWidth(rightText, 8);
    P.move(this.rows, 1);
    P.text(fit("  " + leftText, Math.max(0, this.cols - rw)), leftColor, c.bar);
    if (rw <= this.cols) P.text(rightText, c.barFg, c.bar);
  }

  // Draws the active prompt; returns [row, col] for the terminal cursor when it should sit in the prompt.
  renderPrompt(P) {
    const p = this.prompt, c = this.colors;
    if (!p) return null;
    // find widget, top right like VS Code
    const w = Math.min(this.cols, 48), x = this.cols - w + 1, f = this.find;
    const rowsOf = [["Find", "query"], ...(p.replace ? [["Replace", "replace"]] : [])];
    let cursor = null;
    rowsOf.forEach(([label, field], r) => {
      const lead = ` ${label.padEnd(8)}`, value = f[field], avail = w - W.textWidth(lead, 8) - 1;
      const shown = W.textWidth(value, 8) > avail ? "…" + [...value].slice(-(avail - 1)).join("") : value;
      P.move(2 + r, x);
      P.text(lead, c.barFg, c.widget);
      P.text(fit(shown, avail), c.fg, c.input);
      P.text(" ", c.fg, c.widget);
      if (field === f.field) cursor = [2 + r, x + W.textWidth(lead, 8) + Math.min(avail - 1, W.textWidth(shown, 8))];
    });
    return cursor;
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
  process.stdout.write(ENTER + `\x1b]12;${ed.colors.cursor}\x07`);
  rightClicksTo("program", false);

  let scheduled = false, timer = null;
  const draw = (budget = 60) => {
    scheduled = false;
    ed.rows = process.stdout.rows || 24; ed.cols = process.stdout.columns || 80;
    const { out, done } = ed.render(budget);
    process.stdout.write("\x1b[?25l" + out);
    if (!done) schedule(); // keep tokenizing toward the viewport in small slices
    clearTimeout(timer);
    if (ed.message) timer = setTimeout(schedule, Math.max(50, ed.message.until - Date.now() + 10));
  };
  const schedule = () => { if (!scheduled) { scheduled = true; setImmediate(() => draw()); } };
  ed.redraw = () => { ed.afterEvent(); schedule(); };
  ed.onExit = () => { restore(); process.exit(0); };
  Lang.setApplyEdit((ws) => { ed.applyEdit(ws); schedule(); return true; });
  setInterval(() => { if (ed.pollSettings()) schedule(); }, 2000).unref();

  let pending = "";
  process.stdin.on("data", (chunk) => {
    const { events, rest } = parse(pending + chunk);
    pending = rest;
    for (const ev of events) { ed.handle(ev); ed.afterEvent(); }
    // A split escape sequence that never completes was a plain Esc.
    if (pending) setTimeout(() => { if (pending === rest) { pending = ""; ed.handle({ type: "key", name: "escape" }); schedule(); } }, 50);
    schedule();
  });
  process.stdout.on("resize", schedule);
  ed.offerBackup();
  draw(0); // the text at once, uncolored
  ed.useGrammar(await H.loadGrammar(scope, index, theme));
  draw(1000); // the first colored screen waits for its colors
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
