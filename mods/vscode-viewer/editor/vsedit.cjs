#!/usr/bin/env node
// A VS Code-like terminal editor: VS Code's own tokenizer and One Dark colors, Ctrl shortcuts, mouse, IME-friendly cursor.
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

// ---------- colors ----------
const hex = (c) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const opaque = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
// Alpha color (#rrggbbaa) composited over an opaque one.
function blend(c, under) {
  if (opaque(c)) return opaque(c);
  if (!/^#[0-9a-f]{8}$/i.test(c ?? "")) return under;
  const a = parseInt(c.slice(7, 9), 16) / 255, top = hex(c), bot = hex(under);
  return "#" + top.map((v, i) => Math.round(v * a + bot[i] * (1 - a)).toString(16).padStart(2, "0")).join("");
}
function paletteOf(colors = {}) {
  const bg = opaque(colors["editor.background"]) ?? "#282c34";
  const selection = opaque(colors["editor.selectionBackground"]) ?? "#3e4451";
  const matchOther = blend(colors["editor.findMatchHighlightBackground"] ?? "#528bff3d", bg);
  return {
    bg, fg: opaque(colors["editor.foreground"]) ?? "#abb2bf", selection,
    lineNumber: opaque(colors["editorLineNumber.foreground"]) ?? "#636d83",
    lineNumberActive: opaque(colors["editorLineNumber.activeForeground"]) ?? "#abb2bf",
    currentLine: opaque(colors["editor.lineHighlightBackground"]) ?? "#2c313c",
    match: opaque(colors["editor.findMatchBackground"]) ?? "#42557b", matchOther,
    warn: "#e5c07b", error: "#e06c75", ok: "#98c379",
    bar: opaque(colors["statusBar.background"]) ?? "#21252b", barFg: opaque(colors["statusBar.foreground"]) ?? "#9da5b4",
    widget: opaque(colors["editorWidget.background"]) ?? "#21252b", input: opaque(colors["input.background"]) ?? "#1b1d23",
    cursor: opaque(colors["editorCursor.foreground"]) ?? "#528bff",
  };
}
const fgSGR = (c) => { const [r, g, b] = hex(c); return `\x1b[38;2;${r};${g};${b}m`; };
const bgSGR = (c) => { const [r, g, b] = hex(c); return `\x1b[48;2;${r};${g};${b}m`; };
const styleSGR = (s) => "\x1b[22;23;24;29m" + (s & 1 ? "\x1b[3m" : "") + (s & 2 ? "\x1b[1m" : "") + (s & 4 ? "\x1b[4m" : "") + (s & 8 ? "\x1b[9m" : "");

// Paints cells, emitting SGR only when an attribute changes.
class Painter {
  constructor() { this.out = ""; this.fg = this.bg = null; this.style = -1; }
  set(fg, bg, style = 0) {
    if (style !== this.style) { this.out += styleSGR(style); this.style = style; }
    if (fg !== this.fg) { this.out += fgSGR(fg); this.fg = fg; }
    if (bg !== this.bg) { this.out += bgSGR(bg); this.bg = bg; }
  }
  text(s, fg, bg, style = 0) { this.set(fg, bg, style); this.out += s; }
  move(row, col) { this.out += `\x1b[${row};${col}H`; }
}

// Fits text into `width` display columns (cut with …, or padded).
function fit(s, width) {
  if (width <= 0) return "";
  let out = "", w = 0;
  for (const ch of s) {
    const cw = W.charWidth(ch.codePointAt(0));
    if (w + cw > width) { while (w > width - 1) { const last = [...out].pop(); out = out.slice(0, -last.length); w -= W.charWidth(last.codePointAt(0)); } return out + "…" + " ".repeat(width - 1 - w); }
    out += ch; w += cw;
  }
  return out + " ".repeat(width - w);
}

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
class Editor {
  constructor(file, doc, { grammar, colorMap, textmate }, theme, scope) {
    this.file = file; this.doc = doc;
    this.buf = new TextBuffer(doc.lines);
    this.indent = F.detectIndent(this.buf.lines);
    this.scope = scope; this.language = L.languageName(grammar ? scope : null); this.comment = L.commentOf(scope);
    this.colors = paletteOf(theme.colors);
    this.colorMap = colorMap.map(c => (c ? c.slice(0, 7).toLowerCase() : this.colors.fg));
    this.hl = new H.Highlighter(grammar, textmate.INITIAL, this.buf.lines);
    this.buf.listeners.push((s, r, n) => this.hl.onEdit(s, r, n));
    this.sel = caret({ line: 0, col: 0 });
    this.goal = null; this.top = 0; this.left = 0;
    this.prompt = null; this.message = null; this.find = { query: "", replace: "", field: "query", matches: [], version: -1 };
    this.clip = { text: "", whole: false };
    this.lastClick = { time: 0, line: -1, col: -1 }; this.dragging = false;
    this.crumbs = breadcrumbs(file);
    this.rows = 24; this.cols = 80;
  }

  get lines() { return this.buf.lines; }
  get tab() { return this.indent.size; }
  get head() { return this.sel.head; }
  get empty() { return cmp(this.sel.anchor, this.sel.head) === 0; }
  get height() { return Math.max(1, this.rows - 2); }
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
  saveFile(force = false) {
    if (!force && F.changedOnDisk(this.file, this.doc.stamp)) {
      return this.choose("The file has been changed on disk.", [["o", "Overwrite", () => this.saveFile(true)], ["r", "Reload", () => this.reload()], ["c", "Cancel", () => {}]]);
    }
    try {
      this.doc.stamp = F.save(this.file, F.encode(this.lines, this.doc));
      this.buf.markSaved(); this.buf.seal();
      this.say("Saved", this.colors.ok);
      return true;
    } catch (e) { this.say(`Failed to save: ${e.message}`, this.colors.error, 8000); return false; }
  }
  reload() {
    let doc;
    try { doc = F.load(this.file); } catch (e) { return this.say(`Failed to reload: ${e.message}`, this.colors.error, 8000); }
    if (doc.error) return this.say(doc.error, this.colors.error, 8000);
    const last = this.lines.length - 1, before = this.sel;
    this.buf.edit([{ start: { line: 0, col: 0 }, end: { line: last, col: this.lines[last].length }, text: doc.lines.join("\n") }], { before });
    Object.assign(this.doc, { eol: doc.eol, finalNewline: doc.finalNewline, bom: doc.bom, stamp: doc.stamp });
    this.buf.markSaved();
    this.moveTo(this.buf.clamp(before.head));
    this.say("Reloaded from disk");
  }
  quit() {
    if (!this.buf.dirty) return this.exit();
    this.choose(`Do you want to save the changes you made to ${path.basename(this.file)}?`,
      [["s", "Save", () => { if (this.saveFile() === true) this.exit(); }], ["d", "Don't Save", () => this.exit()], ["c", "Cancel", () => {}]]);
  }

  // ----- prompts -----
  choose(text, options) { this.prompt = { kind: "choice", text, options }; }
  openFind(replace) {
    const [s, e] = this.range();
    if (!this.empty && s.line === e.line) this.find.query = this.buf.getText(s, e);
    this.find.field = replace && this.find.query ? "replace" : "query";
    this.prompt = { kind: "find", replace, origin: this.sel };
  }
  openGoto() { this.prompt = { kind: "goto", text: "" }; }

  promptKey(ev) {
    const p = this.prompt;
    if (p.kind === "choice") {
      if (ev.type !== "key" && ev.type !== "text") return;
      const k = (ev.type === "text" ? ev.text : ev.name).toLowerCase();
      if (k === "escape") return (this.prompt = null);
      const opt = p.options.find(o => o[0] === k) ?? (k === "enter" ? p.options[0] : null);
      if (opt) { this.prompt = null; opt[2](); }
      return;
    }
    const field = p.kind === "goto" ? "text" : this.find.field, holder = p.kind === "goto" ? p : this.find;
    const set = (v) => { holder[field] = v; if (p.kind === "find" && field === "query") this.findNext(1, ordered(p.origin.anchor, p.origin.head)[0]); };
    if (ev.type === "text" || ev.type === "paste") return set(holder[field] + ev.text.split(/\r?\n|\r/)[0]);
    if (ev.type !== "key") return;
    const { name, shift, ctrl, alt } = ev;
    if (name === "escape") { this.prompt = null; return; }
    if (name === "backspace") return set([...holder[field]].slice(0, -1).join(""));
    if (p.kind === "goto") {
      if (name !== "enter") return;
      this.prompt = null;
      const [ln, col] = p.text.split(/[:,]/).map(Number);
      if (!ln) return;
      const line = Math.max(0, Math.min(this.lines.length, ln) - 1);
      this.moveTo({ line, col: col ? col - 1 : 0 });
      this.top = Math.max(0, line - Math.floor(this.height / 2));
      return;
    }
    if (name === "tab" && p.replace) { this.find.field = this.find.field === "query" ? "replace" : "query"; return; }
    if (ctrl && name === "h") { p.replace = true; this.find.field = "replace"; return; }
    if (ctrl && name === "f") { p.replace = false; this.find.field = "query"; return; }
    if (name === "enter" && alt && p.replace) return this.replaceAll();
    if (name === "enter" && this.find.field === "replace") return this.replaceOne();
    if (name === "enter" || name === "f3" || name === "down") return this.findNext(shift ? -1 : 1);
    if (name === "up") return this.findNext(-1);
  }

  // ----- input -----
  handle(ev) {
    if (ev.type === "mouse") return this.mouse(ev);
    if (this.prompt) return this.promptKey(ev);
    if (ev.type === "text") return this.typed(ev.text);
    if (ev.type === "paste") return this.paste(ev.text);
    const { name, ctrl, shift, alt } = ev;
    if (ctrl) {
      switch (name) {
        case "a": this.sel = { anchor: { line: 0, col: 0 }, head: { line: this.lines.length - 1, col: this.lines[this.lines.length - 1].length } }; this.buf.seal(); return;
        case "c": return this.copy(false);
        case "x": return this.copy(true);
        case "v": return this.paste();
        case "z": return shift ? this.redo() : this.undo();
        case "y": return this.redo();
        case "/": return this.toggleComment();
        case "f": return this.openFind(false);
        case "h": return this.openFind(true);
        case "g": return this.openGoto();
        case "s": return this.saveFile();
        case "q": return this.quit();
        case "home": return this.moveTo({ line: 0, col: 0 }, shift);
        case "end": return this.moveTo({ line: this.lines.length - 1, col: this.lines[this.lines.length - 1].length }, shift);
        case "left": case "right": return this.horizontal(name === "left" ? -1 : 1, shift, true);
        case "up": case "down": this.top = Math.max(0, Math.min(this.lines.length - 1, this.top + (name === "up" ? -1 : 1))); return;
        case "backspace": return this.backspace(true);
        case "delete": return this.deleteForward(true);
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
      case "escape": if (!this.empty) this.moveTo(this.head); return;
    }
  }

  // Terminal cell -> buffer position (rows: 1 breadcrumbs, 2..rows-1 text).
  cellToPos(x, y) {
    const line = Math.max(0, Math.min(this.lines.length - 1, this.top + y - 2));
    return { line, col: W.indexAtCol(this.lines[line], Math.max(0, this.left + x - 1 - this.gutter), this.tab) };
  }
  mouse(ev) {
    if (ev.button === 64 || ev.button === 65) { // wheel
      this.top = Math.max(0, Math.min(Math.max(0, this.lines.length - 1), this.top + (ev.button === 64 ? -3 : 3)));
      return;
    }
    if (ev.button === 66 || ev.button === 67) { this.left = Math.max(0, this.left + (ev.button === 66 ? -6 : 6)); return; }
    if (ev.release) { this.dragging = false; return; }
    if (ev.button !== 0 || this.prompt?.kind === "choice") return;
    if (ev.y < 2 || ev.y > this.rows - 1) return;
    const p = this.cellToPos(ev.x, ev.y);
    if (ev.motion) { if (this.dragging) { this.sel = { anchor: this.sel.anchor, head: p }; this.reveal(); } return; }
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
    const done = this.hl.ensure(this.top + height, Date.now() + budget);
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

    this.renderStatus(P);
    const cursor = this.renderPrompt(P);
    P.out += "\x1b[0m";
    if (cursor) P.out += `\x1b[${cursor[0]};${cursor[1]}H\x1b[?25h`;
    else {
      const { line, col } = this.head, x = W.displayCol(this.lines[line], col, this.tab) - this.left;
      const visible = line >= this.top && line < this.top + height && x >= 0 && x < width;
      P.out += visible ? `\x1b[${line - this.top + 2};${gw + x + 1}H\x1b[?25h` : "\x1b[?25l";
    }
    return { out: P.out, done };
  }

  paintLine(P, l, lineBg, ss, se, lineMatches, width) {
    const c = this.colors, text = this.lines[l], tokens = this.hl.tokens[l] ?? null, tab = this.tab;
    const selFrom = l < ss.line || l > se.line ? -1 : l === ss.line ? ss.col : 0;
    const selTo = l < ss.line || l > se.line ? -1 : l === se.line ? se.col : Infinity;
    const cur = this.currentMatchRange();
    let col = 0, ti = 0, x = 0, i = 0;
    const right = this.left + width;
    for (const ch of text) {
      if (col >= right) break;
      while (tokens && ti + 2 < tokens.length && tokens[ti + 2] <= i) ti += 2;
      const meta = tokens ? tokens[ti + 1] : 0;
      const fg = tokens ? this.colorMap[H.foregroundOf(meta)] ?? c.fg : c.fg, style = tokens ? H.fontStyleOf(meta) : 0;
      let bg = lineBg;
      const m = lineMatches.find(m => i >= m.col && i < m.col + m.len);
      if (m) bg = cur && cur.line === l && cur.col === m.col ? c.match : c.matchOther;
      else if (selFrom !== -1 && i >= selFrom && i < selTo) bg = c.selection;
      const cp = ch.codePointAt(0);
      let w, glyph = ch;
      if (ch === "\t") { w = tab - (col % tab); glyph = " ".repeat(w); }
      else { w = W.charWidth(cp); if (cp < 0x20) glyph = String.fromCharCode(0x2400 + cp); else if (cp === 0x7f) glyph = "␡"; }
      if (w === 0) { if (col > this.left && col <= right) P.out += ch; }
      else if (col >= this.left && col + w <= right) { P.text(glyph, fg, bg, style); x += w; }
      else if (col + w > this.left) { const vis = Math.min(col + w, right) - Math.max(col, this.left); P.text(" ".repeat(vis), fg, bg, style); x += vis; }
      col += w; i += ch.length;
    }
    // Selection past the line end shows one cell for the line break, like VS Code.
    if (x < width && selFrom !== -1 && selTo > text.length && col >= this.left) { P.text(" ", c.fg, c.selection); x++; }
    if (x < width) P.text(" ".repeat(width - x), c.fg, lineBg);
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
    if (p.kind === "choice") {
      const text = " " + p.text + "  " + p.options.map(o => `[${o[0].toUpperCase()}] ${o[1]}`).join("  ") + " ";
      P.move(this.rows - 1, 1);
      P.text(fit(text, this.cols), c.warn, c.widget);
      return [this.rows - 1, Math.min(this.cols, W.textWidth(text, 8) + 1)];
    }
    if (p.kind === "goto") {
      const label = ` Go to line (1-${this.lines.length}): `;
      P.move(2, 1);
      P.text(fit(label + p.text, this.cols), c.fg, c.widget);
      return [2, Math.min(this.cols, W.textWidth(label + p.text, 8) + 1)];
    }
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

  exit() { this.done = true; }
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
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[5 q";
const LEAVE = "\x1b[0m\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0 q\x1b]112\x07\x1b[?25h\x1b[?1049l";

async function main() {
  const arg = process.argv[2];
  if (!arg) { process.stderr.write("usage: node vsedit.cjs <file>\n"); process.exit(2); }
  const file = path.resolve(arg);
  let doc;
  try { doc = F.load(file); }
  catch (e) {
    if (e.code !== "ENOENT") { process.stderr.write(`vsedit: ${e.message}\n`); process.exit(1); }
    doc = { lines: [""], eol: "\n", finalNewline: true, bom: false, stamp: null };
  }
  if (doc.error) { process.stderr.write(`vsedit: ${path.basename(file)}: ${doc.error}\n`); process.exit(1); }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write("vsedit: needs a terminal\n"); process.exit(1); }

  const index = H.loadIndex(), theme = H.loadTheme(), scope = L.scopeOf(index, path.basename(file));
  const ed = new Editor(file, doc, await H.loadGrammar(scope, index, theme), theme, scope);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { process.stdout.write(LEAVE); } catch {}
    try { process.stdin.setRawMode(false); } catch {}
  };
  process.on("exit", restore);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => { restore(); process.exit(128 + (os.constants.signals[sig] ?? 1)); });
  process.on("uncaughtException", (e) => { restore(); process.stderr.write(`vsedit crashed: ${e && e.stack || e}\n`); process.exit(1); });

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdout.write(ENTER + `\x1b]12;${ed.colors.cursor}\x07`);

  let scheduled = false, timer = null;
  let first = true;
  const draw = () => {
    scheduled = false;
    ed.rows = process.stdout.rows || 24; ed.cols = process.stdout.columns || 80;
    const { out, done } = ed.render(first ? 1000 : 60); // the first screen waits for its colors
    first = false;
    process.stdout.write("\x1b[?25l" + out);
    if (!done) schedule(); // keep tokenizing toward the viewport in small slices
    clearTimeout(timer);
    if (ed.message) timer = setTimeout(schedule, Math.max(50, ed.message.until - Date.now() + 10));
  };
  const schedule = () => { if (!scheduled) { scheduled = true; setImmediate(draw); } };

  let pending = "";
  process.stdin.on("data", (chunk) => {
    const { events, rest } = parse(pending + chunk);
    pending = rest;
    for (const ev of events) {
      ed.handle(ev);
      if (ed.done) { restore(); process.exit(0); }
    }
    // A split escape sequence that never completes was a plain Esc.
    if (pending) setTimeout(() => { if (pending === rest) { pending = ""; ed.handle({ type: "key", name: "escape" }); schedule(); } }, 50);
    schedule();
  });
  process.stdout.on("resize", schedule);
  draw();
}

if (require.main === module) main();
module.exports = { Editor, paletteOf, blend, wordLeft, wordRight, breadcrumbs };
