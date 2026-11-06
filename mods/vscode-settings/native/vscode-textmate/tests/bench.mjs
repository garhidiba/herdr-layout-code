#!/usr/bin/env node
// Tokenizer benchmark, JS (vscode-textmate + vscode-oniguruma, as the viewer runs it) vs Rust (vscode-textmate crate):
//   (a) a 2,000-line TypeScript file, (b) a 20,000-line one (both cut from real .ts files under --root),
//   (c) a 500 KB single-line minified JS (the viewer's own lib/textmate.js repeated), (d) every real parity file.
// cold = a whole process (start, grammar load, tokenize): tokenize.cjs vs `vscode-core tokenize` for (a)(b)(d); for
// (c), which tokenize.cjs skips (lines over 4,000), the bench programs in the editor's 1,000-unit chunks.
// warm = tokenizing again with the grammar loaded and its regexes compiled (the second pass), in process.
//
//   node mods/vscode-settings/native/vscode-textmate/tests/bench.mjs [--root /Volumes/exusb/project]
//        [--files <list written by parity.mjs --list>] [--runs 3]
// Build first: cargo build --release && cargo build --release --examples (in mods/vscode-settings/native).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), repoRoot = resolve(here, "../../../../..");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const native = join(repoRoot, "mods/vscode-settings/native");
const BIN = join(native, "target/release/vscode-core"), BENCH = join(native, "target/release/examples/bench");
const VSCODE = join(repoRoot, "mods/vscode-viewer/vscode");
const ROOT = arg("--root", "/Volumes/exusb/project"), RUNS = Number(arg("--runs", 3));
const MAX_LINE = 4000, CHUNK = 1000;

// ---- JS side: tokenize.cjs's setup, in process ----
const require = createRequire(import.meta.url);
const textmate = require(join(VSCODE, "lib/textmate.js")), onig = require(join(VSCODE, "lib/oniguruma.js"));
const loose = (s) => JSON.parse(s.replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));
const index = JSON.parse(readFileSync(join(VSCODE, "index.json"), "utf8"));
const wasm = readFileSync(join(VSCODE, "lib/onig.wasm"));
await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
function scopeOf(name) {
  const n = name.toLowerCase();
  if (index.files[n]) return index.files[n];
  for (const [prefix, scope] of Object.entries(index.prefixes)) if (n.startsWith(prefix)) return scope;
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const s = index.ext[parts.slice(i).join(".")]; if (s) return s; }
  return null;
}
async function loadJs(scope) {
  const theme = loose(readFileSync(join(VSCODE, "theme.json"), "utf8"));
  const rawTheme = { name: theme.name, settings: [{ settings: { foreground: theme.colors["editor.foreground"], background: theme.colors["editor.background"] } }, ...theme.tokenColors] };
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s) => new onig.OnigScanner(s), createOnigString: (s) => new onig.OnigString(s) }), theme: rawTheme,
    loadGrammar: async (s) => { const f = index.scopes[s]; return f ? textmate.parseRawGrammar(readFileSync(join(VSCODE, f), "utf8"), f) : null; },
  });
  return { registry, grammar: await registry.loadGrammar(scope) };
}
// highlight.cjs's cutAt.
function cutAt(text, pos) {
  if (text.length - pos <= CHUNK) return text.length;
  const piece = text.slice(pos + CHUNK / 2, pos + CHUNK);
  let k = Math.max(piece.lastIndexOf(";"), piece.lastIndexOf("}"));
  if (k === -1) k = Math.max(piece.lastIndexOf(","), piece.lastIndexOf(" "));
  let end = k === -1 ? pos + CHUNK : pos + CHUNK / 2 + k + 1;
  if (/[\ud800-\udbff]/.test(text[end - 1])) end++;
  return end;
}
function jsPass(g, lines, mode) {
  let stack = textmate.INITIAL;
  for (const line of lines) {
    if (line.length <= MAX_LINE || mode === "whole") stack = g.tokenizeLine2(line, stack).ruleStack;
    else if (mode === "chunked") for (let pos = 0; pos < line.length;) { const end = cutAt(line, pos); stack = g.tokenizeLine2(line.slice(pos, end), stack).ruleStack; pos = end; }
  }
}
async function jsWarm(file, mode = "skip", maxLines = 8000) {
  const lines = readFileSync(file, "utf8").split(/\r\n|\r|\n/).slice(0, maxLines);
  let t = performance.now();
  const { registry, grammar: g } = await loadJs(scopeOf(basename(file)));
  const loadMs = performance.now() - t;
  if (!g) return null;
  t = performance.now(); jsPass(g, lines, mode); const firstMs = performance.now() - t;
  t = performance.now(); jsPass(g, lines, mode); const warmMs = performance.now() - t;
  // Without this, ~1,000 grammars in one process grow the WASM heap past 2 GB and vscode-oniguruma's 32-bit
  // pointers fail ("memory access out of bounds"); tokenize.cjs loads one grammar per process and never gets there.
  registry.dispose();
  return { loadMs, firstMs, warmMs };
}

// A cold run of (c) for the JS side: this process, one chunked pass.
if (arg("--js-chunked", null)) {
  const file = arg("--js-chunked");
  jsPass((await loadJs(scopeOf(basename(file)))).grammar, readFileSync(file, "utf8").split(/\r\n|\r|\n/), "chunked");
  process.exit(0);
}

// ---- Rust side ----
const rsWarm = (files, mode = "skip", maxLines = 8000) =>
  JSON.parse(execFileSync(BENCH, ["--vscode", VSCODE, "--max-lines", String(maxLines), ...(mode === "skip" ? [] : [`--${mode}`]), ...files], { encoding: "utf8", maxBuffer: 1 << 28 }));

function wall(cmd, args) {
  const t = performance.now();
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return performance.now() - t;
}
const median = (f) => { const v = Array.from({ length: RUNS }, f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

// ---- inputs ----
const tmp = mkdtempSync(join(tmpdir(), "textmate-bench-"));
function tsLines(n) {
  const out = [];
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; }
    for (const e of entries) {
      if (out.length >= n) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (![".git", "node_modules", "dist", "build", "target", ".claude"].includes(e.name)) walk(p); }
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(...readFileSync(p, "utf8").split(/\r?\n/));
    }
  };
  walk(ROOT);
  return out.slice(0, n).join("\n");
}
const big = tsLines(20000);
const A = join(tmp, "ts-2000.ts"), B = join(tmp, "ts-20000.ts"), C = join(tmp, "min-500k.js");
writeFileSync(A, big.split("\n").slice(0, 2000).join("\n"));
writeFileSync(B, big);
const min = readFileSync(join(VSCODE, "lib/textmate.js"), "utf8").replace(/\r?\n/g, " ");
writeFileSync(C, min.repeat(Math.ceil(500_000 / min.length)).slice(0, 500_000));
const parityFiles = arg("--files", null) ? JSON.parse(readFileSync(arg("--files"), "utf8")) : [];

// ---- measure ----
const fmt = (ms) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`);
const rows = [];
const add = (name, coldJs, coldRs, warmJs, warmRs, note = "") => rows.push({ name, coldJs, coldRs, warmJs, warmRs, note });

for (const [name, file, maxLines] of [["(a) TS 2,000 lines", A, 2000], ["(b) TS 20,000 lines", B, 20000]]) {
  const coldJs = median(() => wall(process.execPath, [join(VSCODE, "tokenize.cjs"), file, String(maxLines)]));
  const coldRs = median(() => wall(BIN, ["tokenize", file, String(maxLines), "--vscode", VSCODE]));
  const js = await jsWarm(file, "skip", maxLines), rs = rsWarm([file], "skip", maxLines)[0];
  add(name, coldJs, coldRs, js.warmMs, rs.warmMs, `first pass (compiles regexes): JS ${fmt(js.firstMs)}, Rust ${fmt(rs.firstMs)}; grammar load: JS ${fmt(js.loadMs)}, Rust ${fmt(rs.loadMs)}`);
}
{
  const coldJs = median(() => wall(process.execPath, [fileURLToPath(import.meta.url), "--js-chunked", C]));
  const coldRs = median(() => wall(BENCH, ["--vscode", VSCODE, "--chunked", "--cold", C]));
  const js = await jsWarm(C, "chunked"), rs = rsWarm([C], "chunked")[0], whole = rsWarm([C], "whole")[0];
  add("(c) 500 KB one-line JS, 1,000-unit chunks", coldJs, coldRs, js.warmMs, rs.warmMs, `Rust in one tokenizeLine2 call: first ${fmt(whole.firstMs)}, warm ${fmt(whole.warmMs)}`);
}
if (parityFiles.length) {
  const coldJs = parityFiles.reduce((s, f) => s + wall(process.execPath, [join(VSCODE, "tokenize.cjs"), f]), 0);
  const coldRs = parityFiles.reduce((s, f) => s + wall(BIN, ["tokenize", f, "--vscode", VSCODE]), 0);
  let warmJs = 0, firstJs = 0;
  for (const f of parityFiles) { const r = await jsWarm(f); if (r) { warmJs += r.warmMs; firstJs += r.firstMs; } }
  const rs = rsWarm(parityFiles);
  const warmRs = rs.reduce((s, r) => s + r.warmMs, 0), firstRs = rs.reduce((s, r) => s + r.firstMs, 0);
  add(`(d) all ${parityFiles.length} parity files`, coldJs, coldRs, warmJs, warmRs, `first passes: JS ${fmt(firstJs)}, Rust ${fmt(firstRs)}`);
}
rmSync(tmp, { recursive: true, force: true });

console.log(`| input | cold JS | cold Rust | × | warm JS | warm Rust | × |\n|---|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) console.log(`| ${r.name} | ${fmt(r.coldJs)} | ${fmt(r.coldRs)} | ${(r.coldJs / r.coldRs).toFixed(1)} | ${fmt(r.warmJs)} | ${fmt(r.warmRs)} | ${(r.warmJs / r.warmRs).toFixed(1)} |`);
for (const r of rows) if (r.note) console.log(`- ${r.name}: ${r.note}`);
