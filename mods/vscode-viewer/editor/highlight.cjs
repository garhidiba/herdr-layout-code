// VS Code's tokenizer (vscode-textmate + oniguruma) with the One Dark theme, tokenizing lazily and incrementally.
const fs = require("fs");
const path = require("path");

const VSCODE = path.join(__dirname, "..", "vscode");
const MAX_LINE = 4000; // longer lines are painted in the default color, like tokenize.cjs

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

// Resolves { grammar, colorMap, textmate } for a scope; grammar is null when the scope is unknown.
async function loadGrammar(scope, index = loadIndex(), theme = loadTheme()) {
  const textmate = require(path.join(VSCODE, "lib/textmate.js"));
  const rawTheme = { name: theme.name, settings: [{ settings: { foreground: theme.colors["editor.foreground"], background: theme.colors["editor.background"] } }, ...theme.tokenColors] };
  const registry = new textmate.Registry({
    onigLib: onigLib(), theme: rawTheme,
    loadGrammar: async (s) => { const f = index.scopes[s]; return f ? textmate.parseRawGrammar(fs.readFileSync(path.join(VSCODE, f), "utf8"), f) : null; },
  });
  const grammar = scope && index.scopes[scope] ? await registry.loadGrammar(scope) : null;
  return { grammar, colorMap: registry.getColorMap(), textmate };
}

const foregroundOf = (meta) => (meta & 0x00ff8000) >>> 15;
const fontStyleOf = (meta) => (meta & 0x00007800) >>> 11; // 1 italic, 2 bold, 4 underline, 8 strikethrough

// Per-line tokens and the rule stack at each line's end. Edits invalidate from the edited line;
// re-tokenizing stops as soon as a line past the edit ends in the same state as before.
class Highlighter {
  constructor(grammar, initial, lines) {
    this.grammar = grammar;
    this.initial = initial;
    this.lines = lines;          // shared with the buffer (same array)
    this.tokens = [];            // Uint32Array [start, meta, ...] or undefined
    this.states = [];            // rule stack after line i
    this.validTo = 0;            // lines [0, validTo) are tokenized and current
    this.editEnd = -1;           // last line touched by edits since then
  }

  // Buffer listener: lines [start, start+removed) became `inserted` lines.
  onEdit(start, removed, inserted) {
    const fill = new Array(inserted).fill(undefined);
    this.tokens.splice(start, removed, ...fill);
    this.states.splice(start, removed, ...fill);
    if (this.editEnd >= start + removed) this.editEnd += inserted - removed;
    this.editEnd = Math.max(this.editEnd, start + inserted - 1);
    this.validTo = Math.min(this.validTo, start);
  }

  tokenizeLine(i) {
    const line = this.lines[i], prev = i ? this.states[i - 1] : this.initial;
    if (!this.grammar || line.length > MAX_LINE) return { tokens: null, state: prev };
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
}

module.exports = { loadGrammar, loadIndex, loadTheme, Highlighter, foregroundOf, fontStyleOf, MAX_LINE };
