// node --test mods/vscode-viewer/editor/test
const test = require("node:test");
const assert = require("node:assert/strict");

// Oniguruma's WASM memory, caught as it loads: compiled grammars live there and garbage collection never frees them.
let memory = null;
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async (...args) => { const r = await instantiate(...args); memory = (r.instance ?? r).exports.memory; return r; };
const H = require("../highlight.cjs");

test("opening many files of one language reuses one grammar, so oniguruma's WASM memory stays flat", async () => {
  const index = H.loadIndex(), theme = H.loadTheme(), lines = ["const a = `x${b}` // c", "function f(x) { return /re/g.test(x); }"];
  const open = async () => {
    const { grammar, textmate } = await H.loadGrammar("source.js", index, theme);
    let stack = textmate.INITIAL;
    for (const l of lines) stack = grammar.tokenizeLine2(l, stack).ruleStack;
    return grammar;
  };
  const first = await open(), before = memory.buffer.byteLength;
  const later = [];
  for (let i = 0; i < 10; i++) later.push(await open());
  // One registry per file grew it by ~30 MB per JavaScript file and crashed past 2 GB (oniguruma's pointers are 32-bit).
  assert.ok(memory.buffer.byteLength - before < 8 << 20, `grew ${(memory.buffer.byteLength - before) >> 20} MB`);
  assert.ok(later.every(g => g === first), "the same compiled grammar");
});
