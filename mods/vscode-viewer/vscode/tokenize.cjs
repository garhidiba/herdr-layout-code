// Tokenizes a file with VS Code's own engine (vscode-textmate + oniguruma, TextMate grammars, One Dark).
// usage: node tokenize.cjs <file> [maxLines]   ->  one JSON object on stdout:
//   { scope, colors: [hex...], lines: [[text, colorIndex, fontStyle, text, ...], ...], total, theme: {...} }
// fontStyle bits: 1 italic, 2 bold, 4 underline, 8 strikethrough.
const fs = require("fs");
const path = require("path");
const textmate = require("./lib/textmate.js");
const onig = require("./lib/oniguruma.js");

const here = __dirname;
const file = process.argv[2];
const MAX_LINES = Number(process.argv[3]) || 8000, MAX_LINE = 4000;

// jsonc: VS Code themes allow comments and trailing commas.
const loose = (s) => JSON.parse(s.replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));

function scopeOf(index, name) {
  const n = name.toLowerCase();
  if (index.files[n]) return index.files[n];
  for (const [prefix, scope] of Object.entries(index.prefixes)) if (n.startsWith(prefix)) return scope;
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const s = index.ext[parts.slice(i).join(".")]; if (s) return s; }
  return null;
}

(async () => {
  const text = fs.readFileSync(file, "utf8");
  const index = JSON.parse(fs.readFileSync(path.join(here, "index.json"), "utf8"));
  const theme = loose(fs.readFileSync(path.join(here, "theme.json"), "utf8"));
  const rawTheme = { name: theme.name, settings: [{ settings: { foreground: theme.colors["editor.foreground"], background: theme.colors["editor.background"] } }, ...theme.tokenColors] };
  const scope = scopeOf(index, path.basename(file));
  const lines = text.split(/\r\n|\r|\n/);
  const total = lines.length;
  const colorIndex = new Map(), colors = [];
  const colorOf = (hex) => { if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); } return colorIndex.get(hex); };
  // Status-bar facts, like VS Code's: line ending and the indentation the file uses.
  const eol = text.includes("\r\n") ? "CRLF" : "LF";
  let tabs = 0; const steps = {};
  for (const l of lines.slice(0, 2000)) {
    if (l.startsWith("\t")) tabs++;
    else { const m = l.match(/^( +)\S/); if (m && m[1].length <= 8) steps[m[1].length] = (steps[m[1].length] ?? 0) + 1; }
  }
  const spaceLines = Object.values(steps).reduce((a, b) => a + b, 0);
  const step = Object.keys(steps).map(Number).sort((a, b) => a - b).find(k => steps[k] >= Math.max(2, spaceLines * 0.1)) ?? 4;
  const indent = tabs > spaceLines ? "Tabs" : `Spaces: ${step}`;
  const out = { scope, total, eol, indent, colors, lines: [], theme: theme.colors };
  const fg = colorOf((theme.colors["editor.foreground"] ?? "#abb2bf").slice(0, 7));

  let grammar = null;
  if (scope) {
    const wasm = fs.readFileSync(path.join(here, "lib/onig.wasm"));
    await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const onigLib = Promise.resolve({ createOnigScanner: (s) => new onig.OnigScanner(s), createOnigString: (s) => new onig.OnigString(s) });
    const registry = new textmate.Registry({
      onigLib, theme: rawTheme,
      loadGrammar: async (s) => { const f = index.scopes[s]; return f ? textmate.parseRawGrammar(fs.readFileSync(path.join(here, f), "utf8"), f) : null; },
    });
    grammar = await registry.loadGrammar(scope);
    out.colorMap = registry.getColorMap();
  }

  let stack = textmate.INITIAL;
  const shown = Math.min(total, MAX_LINES);
  for (let n = 0; n < shown; n++) {
    const line = lines[n];
    if (!grammar || line.length > MAX_LINE) { out.lines.push([line, fg, 0]); continue; }
    const r = grammar.tokenizeLine2(line, stack);
    stack = r.ruleStack;
    const t = r.tokens, row = [];
    for (let i = 0; i < t.length; i += 2) {
      const start = t[i], end = i + 2 < t.length ? t[i + 2] : line.length, meta = t[i + 1];
      if (end <= start) continue;
      const color = out.colorMap[(meta & 0x00ff8000) >>> 15] ?? "#abb2bf";
      row.push(line.slice(start, end), colorOf(color.slice(0, 7)), (meta & 0x00007800) >>> 11);
    }
    out.lines.push(row.length ? row : ["", fg, 0]);
  }
  delete out.colorMap;
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
