// Colors text with VS Code's own engine (the vscode-viewer mod's vscode/ folder: vscode-textmate, oniguruma,
// TextMate grammars, Atom One Dark), the same way its tokenize.cjs does.
// usage: node tokens.cjs <engine dir> <file name> [file] [maxLines]   (no file: the text on stdin)
//   -> { colors: [hex...], lines: [[text, colorIndex, fontStyle, text, ...], ...] }   fontStyle: 1 italic, 2 bold, 4 underline
const fs = require("fs");
const path = require("path");

const [engine, name, file, max] = process.argv.slice(2);
const MAX_LINES = Number(max) || 20000, MAX_LINE = 4000;
const textmate = require(path.join(engine, "lib/textmate.js"));
const onig = require(path.join(engine, "lib/oniguruma.js"));

// jsonc: VS Code themes allow comments and trailing commas.
const loose = (s) => JSON.parse(s.replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));

function scopeOf(index, n) {
  n = n.toLowerCase();
  if (index.files[n]) return index.files[n];
  for (const [prefix, scope] of Object.entries(index.prefixes)) if (n.startsWith(prefix)) return scope;
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const s = index.ext[parts.slice(i).join(".")]; if (s) return s; }
  return null;
}

(async () => {
  const text = fs.readFileSync(file || 0, "utf8");
  const index = JSON.parse(fs.readFileSync(path.join(engine, "index.json"), "utf8"));
  const theme = loose(fs.readFileSync(path.join(engine, "theme.json"), "utf8"));
  const rawTheme = { name: theme.name, settings: [{ settings: { foreground: theme.colors["editor.foreground"], background: theme.colors["editor.background"] } }, ...theme.tokenColors] };
  const scope = scopeOf(index, path.basename(name));
  const lines = text.split(/\r\n|\r|\n/).slice(0, MAX_LINES);
  const colorIndex = new Map(), colors = [];
  const colorOf = (hex) => { if (!colorIndex.has(hex)) { colorIndex.set(hex, colors.length); colors.push(hex); } return colorIndex.get(hex); };
  const fg = colorOf((theme.colors["editor.foreground"] ?? "#abb2bf").slice(0, 7));
  const out = { colors, lines: [] };

  let grammar = null, colorMap = [];
  if (scope) {
    const wasm = fs.readFileSync(path.join(engine, "lib/onig.wasm"));
    await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const onigLib = Promise.resolve({ createOnigScanner: (s) => new onig.OnigScanner(s), createOnigString: (s) => new onig.OnigString(s) });
    const registry = new textmate.Registry({
      onigLib, theme: rawTheme,
      loadGrammar: async (s) => { const f = index.scopes[s]; return f ? textmate.parseRawGrammar(fs.readFileSync(path.join(engine, f), "utf8"), f) : null; },
    });
    grammar = await registry.loadGrammar(scope);
    colorMap = registry.getColorMap();
  }

  let stack = textmate.INITIAL;
  for (const line of lines) {
    if (!grammar || line.length > MAX_LINE) { out.lines.push([line, fg, 0]); continue; }
    const r = grammar.tokenizeLine2(line, stack);
    stack = r.ruleStack;
    const t = r.tokens, row = [];
    for (let i = 0; i < t.length; i += 2) {
      const start = t[i], end = i + 2 < t.length ? t[i + 2] : line.length, meta = t[i + 1];
      if (end <= start) continue;
      const color = colorMap[(meta & 0x00ff8000) >>> 15] ?? "#abb2bf";
      row.push(line.slice(start, end), colorOf(color.slice(0, 7)), (meta & 0x00007800) >>> 11);
    }
    out.lines.push(row.length ? row : ["", fg, 0]);
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
