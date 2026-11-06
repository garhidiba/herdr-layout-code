#!/usr/bin/env node
// Tokenizer parity: for every language with a file extension in the viewer's index.json, real files found under
// the --root folders (comma-separated, searched in order; read-only; up to --per-lang per language: the first ones found plus the largest and, for JavaScript,
// minified bundles) and synthetic edge cases, run through the viewer's own tokenize.cjs (unchanged; a preload hook
// records its final rule stack) and `vscode-core tokenize --stack`, compared line by line (text, color, font
// style), plus scope/total/eol/indent/colors/theme and the end rule stack.
//
//   node mods/vscode-settings/native/vscode-textmate/tests/parity.mjs [--bin <vscode-core>] [--root /Volumes/exusb/project,…]
//        [--per-lang 20] [--jobs 6] [--list <file to write the tested paths to>] [--only <scope>]
//
// Prints a per-language table and the first mismatch of each failing language; exit code 1 on any mismatch.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), repoRoot = resolve(here, "../../../../..");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const BIN = resolve(arg("--bin", join(repoRoot, "mods/vscode-settings/native/target/release/vscode-core")));
const VSCODE = join(repoRoot, "mods/vscode-viewer/vscode");
const ROOTS = arg("--root", "/Volumes/exusb/project").split(",");
const PER_LANG = Number(arg("--per-lang", 20)), JOBS = Number(arg("--jobs", 6)), ONLY = arg("--only", null);
const SKIP = new Set(["node_modules", ".git", "build", "dist", "target", ".claude", ".next", ".venv", "venv", "__pycache__", "Pods", ".gradle", "DerivedData", ".cache"]);
const index = JSON.parse(readFileSync(join(VSCODE, "index.json"), "utf8"));

// tokenize.cjs's scopeOf, verbatim.
function scopeOf(index, name) {
  const n = name.toLowerCase();
  if (index.files[n]) return index.files[n];
  for (const [prefix, scope] of Object.entries(index.prefixes)) if (n.startsWith(prefix)) return scope;
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const s = index.ext[parts.slice(i).join(".")]; if (s) return s; }
  return null;
}

const languages = [...new Set(Object.values(index.ext))].filter((s) => !ONLY || s === ONLY).sort();
const extOf = Object.fromEntries(languages.map((s) => [s, Object.keys(index.ext).find((e) => index.ext[e] === s)]));

function isBinary(file) {
  const fd = openSync(file, "r"), buf = Buffer.alloc(8192), n = readSync(fd, buf, 0, 8192, 0);
  closeSync(fd);
  return buf.subarray(0, n).includes(0);
}

// Real files: the first PER_LANG-3 found per language, plus the 3 largest (and up to 3 *.min.js for JavaScript).
function findFiles() {
  const first = new Map(), largest = new Map(), minified = [];
  const want = new Set(languages);
  let visited = 0;
  const started = Date.now();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++visited > 2_000_000 || Date.now() - started > 240_000) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
      if (!e.isFile()) continue;
      const scope = scopeOf(index, e.name);
      if (!scope || !want.has(scope)) continue;
      let size;
      try { size = statSync(p).size; } catch { continue; }
      if (size > 64 << 20) continue;
      if (scope === "source.js" && e.name.endsWith(".min.js") && minified.length < 3) { minified.push(p); continue; }
      const f = first.get(scope) ?? [];
      if (f.length < PER_LANG - 3) { f.push(p); first.set(scope, f); continue; }
      const l = largest.get(scope) ?? [];
      l.push([size, p]); l.sort((a, b) => b[0] - a[0]); l.length = Math.min(l.length, 3); largest.set(scope, l);
    }
  };
  ROOTS.forEach(walk);
  const out = [];
  for (const s of languages) for (const p of [...(first.get(s) ?? []), ...(largest.get(s) ?? []).map((x) => x[1])]) out.push([s, p, "real"]);
  for (const p of minified) out.push(["source.js", p, "real"]);
  return out.filter(([, p]) => { try { return !isBinary(p); } catch { return false; } });
}

// Synthetic edge cases, one set per language (named with the language's first extension).
function synthetic(dir) {
  const code = "const s = \"x\"; let n = 1 + 2; // c\nif (a < b) { f(n, 's', `t${n}`); } /* d */\n";
  const cases = {
    empty: "",
    newlines: "\n\n\n",
    crlf: "a = 'x'\r\nb = \"y\"\r\rc\n\r\n" + code.replace(/\n/g, "\r\n"),
    unicode: "\tconst s = \"한글 😀 𝒳 é\" // 주석 🎉\n\t\t'👩‍💻' + \"\\u{1F600}\" # 😀 <b>한</b>\n𝒳𝒴 = 1\n",
    rtl: "x = 'שלום עולם' // مرحبا\n<p dir=\"rtl\">مرحبا</p>\n",
    unterminated: "s = \"abc\n/* comment\nstill comment\n'x\n`tpl ${\n<!-- c\n\"\"\"py\n<<EOF\n",
    long: `${"x".repeat(5000)}\n${("foo(bar, \"baz\") + 1; ").repeat(190)}\n${"한".repeat(1500)}\n${"a = 'b'; ".repeat(444)}\n`,
    punct: "{[(<>)]} /a+(b)?/g $x @y #z %w ^& *~ \\ \\\\ \"\\\"\" '\\'' ${a} {{b}} <%= c %>\n",
    code: code.repeat(30),
  };
  const out = [];
  for (const s of languages) {
    const ext = extOf[s];
    for (const [name, text] of Object.entries(cases)) {
      const p = join(dir, `edge-${name}.${ext}`.replace(/[\\/]/g, "_"));
      if (scopeOf(index, basename(p)) !== s) continue;
      writeFileSync(p, text);
      out.push([s, p, "synthetic"]);
    }
    const bad = join(dir, `edge-bytes.${ext}`);
    if (scopeOf(index, basename(bad)) === s) {
      writeFileSync(bad, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a = 1 "), Buffer.from([0xff, 0xfe, 0xc3, 0x0a, 0xe2, 0x82]), Buffer.from(" \"b\"\n"), Buffer.from([0xf0, 0x9f, 0x98])]));
      out.push([s, bad, "synthetic"]);
    }
  }
  return out;
}

const run = (cmd, args, env = {}) => new Promise((ok) => {
  const t = process.hrtime.bigint();
  execFile(cmd, args, { maxBuffer: 1 << 30, encoding: "utf8", env: { ...process.env, ...env } }, (error, stdout, stderr) => ok({ error, stdout, stderr, ms: Number(process.hrtime.bigint() - t) / 1e6 }));
});

function compare(js, rs) {
  for (const k of ["scope", "total", "eol", "indent", "colors", "theme"]) {
    if (JSON.stringify(js[k]) !== JSON.stringify(rs[k])) return { what: k, js: js[k], rs: rs[k] };
  }
  const n = Math.max(js.lines.length, rs.lines.length);
  for (let i = 0; i < n; i++) {
    const a = JSON.stringify(js.lines[i]), b = JSON.stringify(rs.lines[i]);
    if (a !== b) return { what: `line ${i + 1}`, js: js.lines[i], rs: rs.lines[i] };
  }
  return null;
}

let stackFiles = 0;
async function check([scope, file, kind]) {
  const stackOut = join(tmp, `stack-${stackFiles++}.json`);
  const [js, rs] = await Promise.all([
    run(process.execPath, ["-r", join(here, "js-stack-hook.cjs"), join(VSCODE, "tokenize.cjs"), file], { TEXTMATE_STACK_OUT: stackOut }),
    run(BIN, ["tokenize", file, "--vscode", VSCODE, "--stack"]),
  ]);
  const r = { scope, file, kind, jsMs: js.ms, rsMs: rs.ms };
  if (js.error) return { ...r, skip: `JS failed: ${(js.stderr || String(js.error)).split("\n")[0]}`, rsFailed: !!rs.error };
  if (rs.error) return { ...r, mismatch: { what: "rust failed", js: "", rs: rs.stdout.slice(0, 300) } };
  const a = JSON.parse(js.stdout), b = JSON.parse(rs.stdout);
  const jsStack = JSON.parse(readFileSync(stackOut, "utf8")), rsStack = b.stack;
  rmSync(stackOut);
  delete b.stack;
  const m = compare(a, b) ?? (JSON.stringify(jsStack) !== JSON.stringify(rsStack) ? { what: "end rule stack", js: jsStack, rs: rsStack } : null);
  return { ...r, lines: a.lines.length, mismatch: m };
}

if (!existsSync(BIN)) { console.error(`no binary at ${BIN} (cargo build --release first)`); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), "textmate-parity-"));
const files = [...findFiles(), ...synthetic(tmp)];
console.error(`${files.length} files (${files.filter((f) => f[2] === "real").length} real) in ${languages.length} languages`);
const results = [];
let next = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < files.length) {
    const f = files[next++];
    results.push(await check(f));
    if (results.length % 100 === 0) console.error(`  ${results.length}/${files.length}`);
  }
}));
rmSync(tmp, { recursive: true, force: true });
if (arg("--list", null)) writeFileSync(arg("--list"), JSON.stringify(files.filter((f) => f[2] === "real").map((f) => f[1])));

const short = (v) => { const s = JSON.stringify(v); return s.length > 400 ? s.slice(0, 400) + "…" : s; };
let failed = 0, total = 0, passed = 0, skipped = 0;
console.log("| language | real | synthetic | pass | rate |\n|---|---:|---:|---:|---:|");
for (const s of languages) {
  const rs = results.filter((r) => r.scope === s);
  const tested = rs.filter((r) => !r.skip), ok = tested.filter((r) => !r.mismatch);
  total += tested.length; passed += ok.length; skipped += rs.length - tested.length;
  const real = tested.filter((r) => r.kind === "real").length;
  console.log(`| ${s} | ${real} | ${tested.length - real} | ${ok.length}/${tested.length} | ${tested.length ? ((100 * ok.length) / tested.length).toFixed(1) : "-"}% |`);
}
for (const r of results.filter((r) => r.mismatch)) {
  if (failed++ < 40) console.log(`\nMISMATCH ${r.scope} ${r.file}: ${r.mismatch.what}\n  js: ${short(r.mismatch.js)}\n  rs: ${short(r.mismatch.rs)}`);
}
for (const r of results.filter((r) => r.skip)) console.log(`\nSKIPPED ${r.scope} ${r.file}: ${r.skip}${r.rsFailed ? " (Rust failed too)" : " (Rust did not fail)"}`);
console.log(`\n${passed}/${total} files identical (${((100 * passed) / Math.max(total, 1)).toFixed(2)}%), ${skipped} skipped where tokenize.cjs itself failed`);
process.exit(failed ? 1 : 0);
