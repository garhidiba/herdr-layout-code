// VS Code's tokenizer (vscode-textmate + oniguruma) with the One Dark theme, tokenizing lazily and incrementally.
const fs = require("fs");
const path = require("path");

const VSCODE = path.join(__dirname, "..", "vscode");
// Longer lines (minified bundles) are tokenized in CHUNK-sized pieces carrying the rule stack, a few per frame: one
// tokenizeLine2 call on a whole 20,000-character line takes ~0.5 s and grows faster than the length, so it would freeze
// typing. Pieces end after a `;` or `}` where possible, so the joins rarely split a token.
const MAX_LINE = 4000, CHUNK = 1000;

// jsonc: VS Code themes allow comments and trailing commas.
const loose = (s) => JSON.parse(s.replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));

const readJSON = (rel) => loose(fs.readFileSync(path.join(VSCODE, rel), "utf8"));
const loadIndex = () => readJSON("index.json");
const loadTheme = () => readJSON("theme.json");

let onigReady = null;
function onigLib() {
  const onig = require(path.join(VSCODE, "lib/oniguruma.js"));
  if (!onigReady) {
    const wasm = fs.readFileSync(path.join(VSCODE, "lib/onig.wasm"));
    onigReady = onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  }
  return onigReady.then(() => ({ createOnigScanner: (s) => new onig.OnigScanner(s), createOnigString: (s) => new onig.OnigString(s) }));
}

// One registry per (theme, index): it caches each scope's grammar, whose compiled scanners live in oniguruma's WASM
// memory, which garbage collection never frees. A registry per file grew it ~30 MB a file until it crashed past 2 GB.
const registries = new WeakMap(); // theme -> index -> Registry
function registryFor(textmate, index, theme) {
  let byIndex = registries.get(theme);
  if (!byIndex) registries.set(theme, (byIndex = new WeakMap()));
  let registry = byIndex.get(index);
  if (registry) return registry;
  const rawTheme = { name: theme.name, settings: [{ settings: { foreground: theme.colors["editor.foreground"], background: theme.colors["editor.background"] } }, ...theme.tokenColors] };
  registry = new textmate.Registry({
    onigLib: onigLib(), theme: rawTheme,
    loadGrammar: async (s) => { const f = index.scopes[s]; return f ? textmate.parseRawGrammar(fs.readFileSync(path.join(VSCODE, f), "utf8"), f) : null; },
  });
  byIndex.set(index, registry);
  return registry;
}

// Resolves { grammar, colorMap, textmate } for a scope; grammar is null when the scope is unknown.
async function loadGrammar(scope, index = loadIndex(), theme = loadTheme()) {
  const textmate = require(path.join(VSCODE, "lib/textmate.js"));
  const registry = registryFor(textmate, index, theme);
  const grammar = scope && index.scopes[scope] ? await registry.loadGrammar(scope) : null;
  return { grammar, colorMap: registry.getColorMap(), textmate };
}

const foregroundOf = (meta) => (meta & 0x00ff8000) >>> 15;
const fontStyleOf = (meta) => (meta & 0x00007800) >>> 11; // 1 italic, 2 bold, 4 underline, 8 strikethrough
const tokenTypeOf = (meta) => (meta >>> 8) & 3;            // 0 code, 1 comment, 2 string, 3 regex
// The (even) index in tokens [start, meta, ...] of the token holding UTF-16 index i.
function tokenIndex(tokens, i) {
  let lo = 0, hi = tokens.length / 2 - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tokens[m * 2] <= i) lo = m; else hi = m - 1; }
  return lo * 2;
}

// Where the piece of `text` starting at `pos` ends: after the last `;`/`}` (else `,`/space) in its second half.
function cutAt(text, pos) {
  if (text.length - pos <= CHUNK) return text.length;
  const piece = text.slice(pos + CHUNK / 2, pos + CHUNK);
  let k = Math.max(piece.lastIndexOf(";"), piece.lastIndexOf("}"));
  if (k === -1) k = Math.max(piece.lastIndexOf(","), piece.lastIndexOf(" "));
  let end = k === -1 ? pos + CHUNK : pos + CHUNK / 2 + k + 1;
  if (/[\ud800-\udbff]/.test(text[end - 1])) end++; // never split a surrogate pair
  return end;
}

// A long line's tokens, built piece by piece: tokens [start, meta, ...] for [0, pos), then [pos, 0] (default color)
// until done. Editing keeps the pieces before the first changed character.
class LongLine {
  constructor(text, prev) { this.text = text; this.prev = prev; this.pieces = []; this.buf = new Uint32Array(1024); this.restart(0); }
  restart(k) {
    this.pieces.length = k;
    const last = this.pieces[k - 1];
    this.pos = last ? last.end : 0; this.state = last ? last.state : this.prev; this.n = last ? last.n : 0;
    this.done = this.pos >= this.text.length;
  }
  retext(text) {
    if (text === this.text) return;
    let d = 0;
    const max = Math.min(text.length, this.text.length);
    while (d < max && text.charCodeAt(d) === this.text.charCodeAt(d)) d++;
    this.text = text;
    let k = 0;
    while (k < this.pieces.length && this.pieces[k].end < d) k++;
    this.restart(k);
  }
  step(grammar) {
    const end = cutAt(this.text, this.pos), r = grammar.tokenizeLine2(this.text.slice(this.pos, end), this.state), t = r.tokens;
    if (this.n + t.length + 2 > this.buf.length) { const b = new Uint32Array(Math.max(this.buf.length * 2, this.n + t.length + 2)); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
    for (let j = 0; j < t.length; j += 2) { this.buf[this.n + j] = t[j] + this.pos; this.buf[this.n + j + 1] = t[j + 1]; }
    this.n += t.length; this.pos = end; this.state = r.ruleStack; this.done = end >= this.text.length;
    this.pieces.push({ end, state: this.state, n: this.n });
  }
  get tokens() {
    if (this.done) return this.buf.subarray(0, this.n);
    this.buf[this.n] = this.pos; this.buf[this.n + 1] = 0;
    return this.buf.subarray(0, this.n + 2);
  }
}

// Per-line tokens and the rule stack at each line's end. Edits invalidate from the edited line;
// re-tokenizing stops as soon as a line past the edit ends in the same state as before.
class Highlighter {
  constructor(grammar, initial, lines) {
    this.grammar = grammar;
    this.initial = initial;
    this.lines = lines;          // shared with the buffer (same array)
    this.tokens = [];            // Uint32Array [start, meta, ...] or undefined
    this.states = [];            // rule stack after line i
    this.long = [];              // LongLine for lines over MAX_LINE
    this.validTo = 0;            // lines [0, validTo) are tokenized and current
    this.editEnd = -1;           // last line touched by edits since then
  }

  // A new grammar (it loads after the first, uncolored frame): everything is tokenized again.
  reset(grammar, initial) {
    this.grammar = grammar; this.initial = initial;
    this.tokens = []; this.states = []; this.long = []; this.validTo = 0; this.editEnd = -1;
  }

  // Buffer listener: lines [start, start+removed) became `inserted` lines.
  onEdit(start, removed, inserted) {
    const fill = new Array(inserted).fill(undefined);
    this.tokens.splice(start, removed, ...fill);
    this.states.splice(start, removed, ...fill);
    // typing within one long line keeps its pieces before the change
    this.long.splice(start, removed, ...(removed === 1 && inserted === 1 ? [this.long[start]] : fill));
    if (this.editEnd >= start + removed) this.editEnd += inserted - removed;
    this.editEnd = Math.max(this.editEnd, start + inserted - 1);
    this.validTo = Math.min(this.validTo, start);
  }

  tokenizeLine(i) {
    const line = this.lines[i], prev = i ? this.states[i - 1] : this.initial;
    if (!this.grammar) return { tokens: null, state: prev };
    if (line.length > MAX_LINE) { // pieces come from ensureLong; until the line is done, later lines start from the best stack so far
      let lt = this.long[i];
      if (!lt || !(lt.prev === prev || lt.prev.equals(prev))) lt = this.long[i] = new LongLine(line, prev);
      else lt.retext(line);
      return { tokens: lt.tokens, state: lt.state };
    }
    this.long[i] = undefined;
    const r = this.grammar.tokenizeLine2(line, prev);
    return { tokens: r.tokens, state: r.ruleStack };
  }

  // Tokenizes through line `last` (clamped). Stops early past `deadline` (ms timestamp); returns true when done.
  ensure(last, deadline = Infinity) {
    last = Math.min(last, this.lines.length - 1);
    while (this.validTo <= last) {
      const i = this.validTo, old = this.states[i];
      const { tokens, state } = this.tokenizeLine(i);
      this.tokens[i] = tokens; this.states[i] = state;
      this.validTo = i + 1;
      if (i > this.editEnd && old && old.equals(state)) {
        // Rest of the file is unchanged: skip ahead over lines that are still tokenized.
        let j = this.validTo;
        while (j < this.lines.length && this.states[j]) j++;
        this.validTo = j;
        this.editEnd = -1;
      }
      if (i >= this.editEnd) this.editEnd = -1;
      if ((i & 31) === 0 && Date.now() > deadline) return this.validTo > last;
    }
    return true;
  }

  // Tokenizes the long lines among [first, last] piece by piece until `deadline`; true when they are all done. A line
  // that finishes with a different end stack than the one its following lines used makes them re-tokenize.
  ensureLong(first, last, deadline = Infinity) {
    let done = true;
    for (let i = first; i <= Math.min(last, this.validTo - 1); i++) {
      const lt = this.long[i];
      if (!lt || lt.done) continue;
      while (!lt.done && Date.now() < deadline) lt.step(this.grammar);
      this.tokens[i] = lt.tokens;
      if (!lt.done) { done = false; continue; }
      if (!this.states[i]?.equals(lt.state)) {
        this.states[i] = lt.state;
        if (this.validTo > i + 1) { this.editEnd = Math.max(this.editEnd, i + 1); this.validTo = i + 1; done = false; }
      }
    }
    return done;
  }
}

module.exports = { loadGrammar, loadIndex, loadTheme, Highlighter, foregroundOf, fontStyleOf, tokenTypeOf, tokenIndex, MAX_LINE, loose };
