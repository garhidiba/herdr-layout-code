#!/usr/bin/env node
// Parity and benchmark harness: runs the mods' own scripts and parsers (lifted from mods/*/main.js at run
// time, never edited) and vscode-core on real folders, compares the JSON, times both, and checks that
// vscode-core wrote nothing to any repo (.git/index mtimes, no index.lock).
//
//   node mods/vscode-settings/native/vscode-core/tests/parity.mjs [--bin mods/vscode-settings/native/target/release/vscode-core] [--root /Volumes/exusb/project]
//
// Read-only on the folders it looks at. Exit code 1 on any mismatch or repo write.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), repoRoot = resolve(here, "../../../../..");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const BIN = resolve(arg("--bin", join(repoRoot, "mods/vscode-settings/native/target/release/vscode-core")));
const ROOT = arg("--root", "/Volumes/exusb/project");
// Repos for status/log/commit-files (merges, upstream far ahead, dirty, nested repos), folders for tree.
const REPOS = ["anamensis", "aws-terraform", "synol-server/chartdb", "dailoop", "pixiv-rust", "herdr-layout-vscode"].map((r) => `${ROOT}/${r}`);
const TREES = [[ROOT, ["anamensis", "synol-server"]], [`${ROOT}/anamensis`, ["src", "src/main", "nope"]], [`${ROOT}/pixiv-rust`, ["pixiv-go"]]];

// QuickJS's localeCompare (Herdr's engine): NFC, then code point order. Node's ICU collation differs.
String.prototype.localeCompare = function (other) {
  const a = [...this.normalize("NFC")].map((c) => c.codePointAt(0)), b = [...String(other).normalize("NFC")].map((c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

// Herdr's `exec`: resolves { code, stdout, stderr }, rejects when the program cannot start.
async function exec(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Lifts top-level `const`/`function` statements (a function runs to its closing `}` line, a const to its
// last indented continuation line) and class methods (to their `  }` line) out of a mod's source.
function lift(file, names, methods = []) {
  const lines = readFileSync(join(repoRoot, file), "utf8").split("\n"), out = [];
  for (const name of names) {
    const start = lines.findIndex((l) => new RegExp(`^(async )?(const|function) ${name}\\b`).test(l));
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    let end = start;
    if (/^(async )?function/.test(lines[start])) while (lines[end] !== "}") end++;
    else while (lines[end + 1]?.startsWith(" ")) end++;
    out.push(lines.slice(start, end + 1).join("\n"));
  }
  for (const name of methods) {
    const start = lines.findIndex((l) => l.startsWith(`  async ${name}(`) || l.startsWith(`  ${name}(`));
    if (start < 0) throw new Error(`method ${name} not found in ${file}`);
    let end = start;
    while (lines[end] !== "  }") end++;
    out.push(lines.slice(start, end + 1).join("\n").replace(/^  (async )?/, "$1function "));
  }
  return out.join("\n");
}
const load = (source, names, env) => new Function(...Object.keys(env), `${source}\nreturn { ${names.join(", ")} };`)(...Object.values(env));

const scmNames = ["READ", "ROW", "gitLetter", "REPOS", "parseRepos", "scanRepos", "pickRepo", "LOG_FORMAT", "parseLog", "parseRefs", "graph", "NAME_STATUS", "parseNameStatus", "upstreamOf", "readRepo"];
const scm = load(lift("mods/vscode-scm/main.js", scmNames), ["scanRepos", "pickRepo", "readRepo", "parseNameStatus", "READ", "FILES"], { exec });
const exNames = ["PER_FOLDER", "GIT_RANK", "gitLetter", "dirtyOf", "NESTED_STATUS", "directory", "gitMarks"];
const ex = load(lift("mods/vscode-explorer/main.js", exNames, ["loadFolder"]), ["dirtyOf", "gitMarks", "loadFolder"], { exec, window: () => ({ platform: "macos" }) });

// The Explorer's data for a folder, as refresh()/preload() build it: root then expanded folders, then marks.
async function jsTree(cwd, expanded) {
  const tree = { entries: new Map(), folders: new Set(expanded), limited: false }, context = { cwd, on: null };
  const loadFolder = ex.loadFolder.bind({ current: () => true });
  for (const path of ["", ...expanded]) await loadFolder(path, context, tree).catch((e) => { if (!path) throw e; tree.folders.delete(path); });
  const marks = await ex.gitMarks(cwd, null);
  return { entries: Object.fromEntries(tree.entries), limited: tree.limited, marks, dirty: Object.fromEntries(ex.dirtyOf(marks)) };
}
async function jsAll(root, expanded) {
  const tree = await jsTree(root, expanded), { top, repos } = await scm.scanRepos(root, null), selected = scm.pickRepo(repos, top, null);
  const repo = selected ? await scm.readRepo(repos.find((r) => r.path === selected), selected, null) : null;
  return { tree, repos: { top, repos }, selected, repo };
}

function core(...args) {
  const r = spawnSync(BIN, args, { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`vscode-core ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout);
}

let failures = 0;
function same(label, js, rust) {
  const a = JSON.stringify(js), b = JSON.stringify(rust);
  if (a === b) return console.log(`  ok   ${label}`);
  failures++;
  let i = 0;
  while (a[i] === b[i]) i++;
  console.log(`  DIFF ${label} at ${i}:\n    js:   …${a.slice(Math.max(0, i - 80), i + 160)}\n    rust: …${b.slice(Math.max(0, i - 80), i + 160)}`);
}
async function time(fn) { const t = performance.now(); const v = await fn(); return [v, performance.now() - t]; }

// .git/index mtimes and index.lock files of every repo below ROOT (depth 4, worktrees' .git files skipped).
function snapshot() {
  const found = spawnSync("find", [ROOT, "-maxdepth", "4", "-name", ".git", "-type", "d", "-prune"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  return Object.fromEntries(found.map((g) => [g, [existsSync(`${g}/index`) ? statSync(`${g}/index`).mtimeMs : null, existsSync(`${g}/index.lock`)]]));
}

const bench = [];
console.log(`vscode-core: ${BIN}\n\n== no writes (vscode-core only)`);
{
  const before = snapshot();
  core("repos", ROOT);
  for (const [dir, expanded] of TREES) core("all", dir, "--expanded", expanded.join(","));
  for (const r of REPOS) { core("status", r); core("repo", r); try { core("log", r, "--graph"); } catch {} }
  const after = snapshot(), changed = Object.keys(before).filter((g) => JSON.stringify(before[g]) !== JSON.stringify(after[g]) || after[g][1]);
  console.log(`  ${Object.keys(before).length} repos checked; index changed or locked: ${changed.length ? changed.join(", ") : "none"}`);
  if (changed.length) failures++;
}

console.log("\n== repos");
{
  const [js, tj] = await time(() => scm.scanRepos(ROOT, null));
  const [rust, tr] = await time(() => core("repos", ROOT));
  same(`repos ${ROOT} (${js.repos.length} repos)`, js, rust);
  bench.push([`repos ${ROOT}`, tj, tr]);
}

console.log("\n== status / log --graph / repo / commit-files");
for (const path of REPOS) {
  const { repos } = await scm.scanRepos(path, null), repo = repos.find((r) => r.path === path);
  const [js, tj] = await time(() => scm.readRepo(repo, path, null));
  const [rust, tr] = await time(() => {
    const s = core("status", path), up = repo?.ahead !== null && repo?.upstream ? ["--upstream", repo.upstream] : [];
    return { ...s, commits: js.hasHead ? core("log", path, "--graph", ...up) : [] };
  });
  same(`status ${path} (${js.files.length} files)`, { files: js.files, limited: js.limited, hasHead: js.hasHead }, { files: rust.files, limited: rust.limited, hasHead: rust.hasHead });
  same(`log --graph ${path} (${js.commits.length} commits, ${js.commits.filter((c) => c.merge).length} merges)`, js.commits, rust.commits);
  bench.push([`status+log ${path.slice(ROOT.length + 1)}`, tj, tr]);
  // `repo`: the same in one call, in readRepo()'s exact shape.
  const up = repo?.ahead !== null && repo?.upstream ? ["--upstream", repo.upstream] : [];
  const [one, t1] = await time(() => core("repo", path, ...up));
  same(`repo ${path}`, js, one);
  bench.push([`repo ${path.slice(ROOT.length + 1)}`, tj, t1]);
  // A sample of commits: merges first, then the newest.
  const sample = [...js.commits.filter((c) => c.merge).slice(0, 5), ...js.commits.slice(0, 10)];
  let ok = 0;
  for (const c of sample) {
    const r = await exec("git", [...scm.READ, "show", "--name-status", "-z", "--format=", "-M", "-m", "--first-parent", c.hash], { cwd: path });
    const a = scm.parseNameStatus(r.stdout).slice(0, 1000), b = core("commit-files", path, c.hash);
    if (JSON.stringify(a) === JSON.stringify(b)) ok++; else same(`commit-files ${path} ${c.hash}`, a, b);
  }
  console.log(`  ${ok === sample.length ? "ok  " : "DIFF"} commit-files ${path}: ${ok}/${sample.length} commits equal`);
}

console.log("\n== tree");
for (const [dir, expanded] of TREES) {
  const [js, tj] = await time(() => jsTree(dir, expanded));
  const [rust, tr] = await time(() => core("tree", dir, "--expanded", expanded.join(",")));
  same(`tree ${dir} [${expanded}] (${Object.values(js.entries).flat().length} entries, ${Object.keys(js.marks).length} marks)`, js, rust);
  bench.push([`tree ${dir.slice(ROOT.length + 1) || ROOT}`, tj, tr]);
}

console.log("\n== all (12 project folders)");
{
  const folders = [ROOT, ...REPOS, ...["habilisadi", "synol-server", "obsidian-memo", "callwnanote", "waydo"].map((r) => `${ROOT}/${r}`)].slice(0, 12);
  let tj = 0, tr = 0;
  for (const dir of folders) {
    const [js, a] = await time(() => jsAll(dir, []));
    const [rust, b] = await time(() => core("all", dir));
    tj += a; tr += b;
    same(`all ${dir} (js ${a.toFixed(0)} ms, vscode-core ${b.toFixed(0)} ms)`, js, { tree: rust.tree, repos: rust.repos, selected: rust.selected, repo: rust.repo });
  }
  bench.push([`all × ${folders.length} folders (sequential)`, tj, tr]);
}

console.log("\n== benchmark (wall ms: mods' JS/shell path vs vscode-core)");
for (const [label, js, rust] of bench) console.log(`  ${label.padEnd(48)} ${js.toFixed(0).padStart(7)} ${rust.toFixed(0).padStart(7)}   ×${(js / rust).toFixed(1)}`);
console.log(failures ? `\n${failures} mismatch(es)` : "\nall equal");
process.exit(failures ? 1 : 0);
