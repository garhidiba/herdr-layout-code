// Git change decorations (VS Code's quick diff): the live buffer against the file's HEAD version as added / modified /
// deleted hunks, for the gutter bars and the overview ruler. diffHunks/marksFor/nextChange are pure; GitGutter reads
// HEAD (async), diffs 300 ms after the last edit and reads HEAD again on save or when .git/HEAD or the index change.
const fs = require("fs");
const path = require("path");
const { runAsync } = require("./lang/proc.cjs");

const DELAY = 300;         // ms after the last edit before diffing
const POLL = 3000;         // ms between checks of HEAD, the index and the reflog
const MAX_LINES = 200000;  // a buffer or base this long gets no decorations
const MAX_EDITS = 1000;    // Myers steps before the changed middle counts as one change
const GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

// Hunks [{ kind: "added" | "modified" | "deleted", start, end }] of `lines` against `base`, in buffer lines (end
// exclusive). A deletion is empty (start === end): lines were removed before line `start`. Common lines at both ends are
// trimmed first; past `limit` edits the rest of the middle is one modified hunk.
function diffHunks(base, lines, limit = MAX_EDITS) {
  let s = 0, ea = base.length, eb = lines.length;
  while (s < ea && s < eb && base[s] === lines[s]) s++;
  while (ea > s && eb > s && base[ea - 1] === lines[eb - 1]) { ea--; eb--; }
  if (s === ea && s === eb) return [];
  const ids = new Map(), id = (t) => { let v = ids.get(t); if (v === undefined) ids.set(t, (v = ids.size)); return v; };
  const a = base.slice(s, ea).map(id), b = lines.slice(s, eb).map(id);
  const ops = (a.length && b.length && myers(a, b, limit)) || [...a.map(() => "-"), ...b.map(() => "+")];
  const out = [];
  for (let i = 0, j = s; i < ops.length;) {
    if (ops[i] === " ") { i++; j++; continue; }
    let removed = 0, added = 0;
    for (; i < ops.length && ops[i] !== " "; i++) ops[i] === "-" ? removed++ : added++;
    out.push({ kind: !removed ? "added" : !added ? "deleted" : "modified", start: j, end: j + added });
    j += added;
  }
  return out;
}
// Myers' O((N+M)D) diff as ops " " (same), "-" (a only), "+" (b only) in order; null past `limit` steps.
function myers(a, b, limit) {
  const n = a.length, m = b.length, max = n + m, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= Math.min(max, limit); d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, j = i - k;
      while (i < n && j < m && a[i] === b[j]) { i++; j++; }
      v[off + k] = i;
      if (i >= n && j >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}
function backtrack(trace, n, m) {
  const ops = [];
  let i = n, j = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d], k = i - j, at = (kk) => prev[kk + d];
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1)), pk = down ? k + 1 : k - 1, pi = at(pk), pj = pi - pk;
    while (i > pi && j > pj) { ops.push(" "); i--; j--; }
    ops.push(down ? "+" : "-");
    if (down) j--; else i--;
  }
  while (i > 0 && j > 0) { ops.push(" "); i--; j--; }
  return ops.reverse();
}

// The line a hunk is shown on: a deletion sits below the line before it (above line 0 at the top).
const lineOf = (h) => (h.kind === "deleted" ? Math.max(0, h.start - 1) : h.start);
// Gutter marks of lines [first, last]: Map line -> "added" | "modified" | "deletedBelow" | "deletedAbove" (bars win).
function marksFor(hunks, first, last) {
  const out = new Map();
  for (const h of hunks) {
    if (h.kind === "deleted") { const l = lineOf(h); if (l >= first && l <= last && !out.has(l)) out.set(l, h.start === 0 ? "deletedAbove" : "deletedBelow"); continue; }
    for (let l = Math.max(first, h.start); l < Math.min(last + 1, h.end); l++) out.set(l, h.kind);
  }
  return out;
}
// The change to go to from `line`: the next one below (dir 1) or above (dir -1), wrapping; null when there is none.
function nextChange(hunks, line, dir) {
  if (!hunks.length) return null;
  if (dir > 0) return hunks.find(h => lineOf(h) > line) ?? hunks[0];
  return hunks.findLast(h => lineOf(h) < line) ?? hunks[hunks.length - 1];
}
// The text of a blob as the editor splits a file (file.cjs decode: BOM dropped, any EOL, no line after a final newline).
function splitText(text) {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// One file's decorations. base: the HEAD lines ([] for a file new in the index), null when there is nothing to compare
// with (no repo, untracked, or not read yet). hunks follow buf after each debounced diff; onChange() asks for a frame.
class GitGutter {
  constructor(file, buf, onChange = () => {}) {
    Object.assign(this, { file, buf, onChange, base: null, hunks: [], started: false, reads: 0, stamp: null, timer: null, poller: null });
  }
  // Starts reading HEAD and polling (once; the first frame that shows the file calls it).
  start() {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }
  // The buffer changed: diff again once edits pause.
  changed() {
    if (!this.started) return;
    clearTimeout(this.timer);
    (this.timer = setTimeout(() => this.diff(), DELAY)).unref?.();
  }
  diff() {
    clearTimeout(this.timer);
    const lines = this.buf.lines, base = this.base;
    const hunks = !base || lines.length > MAX_LINES || base.length > MAX_LINES ? [] : diffHunks(base, lines);
    const same = hunks.length === this.hunks.length && hunks.every((h, i) => h.kind === this.hunks[i].kind && h.start === this.hunks[i].start && h.end === this.hunks[i].end);
    this.hunks = hunks;
    if (!same) this.onChange();
  }
  // Reads the HEAD version again (start, save, HEAD/index changes); a newer read wins over an older one.
  async refresh() {
    const token = ++this.reads, dir = path.dirname(this.file);
    const git = (args, cwd) => runAsync("git", [...GIT, ...args], { cwd, timeout: 10000 });
    const top = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], dir);
    if (token !== this.reads) return;
    if (top.code !== 0) return this.settle(null, null); // no repo: no decorations, no polling
    const [root, gitDir] = top.stdout.split("\n");
    let real;
    try { real = fs.realpathSync(this.file); } catch { real = path.join(fs.realpathSync(dir), path.basename(this.file)); }
    const rel = path.relative(root, real).split(path.sep).join("/");
    const head = await git(["cat-file", "blob", `HEAD:${rel}`], root);
    if (token !== this.reads) return;
    let base = head.code === 0 ? splitText(head.stdout) : null;
    if (!base) { // not in HEAD: a file added to the index is all new, an untracked one shows nothing
      const staged = await git(["ls-files", "--cached", "--", rel], root);
      if (token !== this.reads) return;
      base = staged.code === 0 && staged.stdout.trim() ? [] : null;
    }
    this.settle(base, gitDir);
  }
  settle(base, gitDir) {
    this.base = base;
    this.diff();
    this.onChange();
    if (!gitDir) return;
    this.gitDir = gitDir; this.stamp = this.stampOf();
    if (!this.poller) (this.poller = setInterval(() => this.poll(), POLL)).unref?.();
  }
  // HEAD, the index and HEAD's reflog (a commit, checkout or reset touches one of them).
  stampOf() {
    return ["HEAD", "index", "logs/HEAD"].map(f => { try { const s = fs.statSync(path.join(this.gitDir, f)); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } }).join(" ");
  }
  poll() { const st = this.stampOf(); if (st !== this.stamp) { this.stamp = st; this.refresh(); } }
  saved() { if (this.started) this.refresh(); }
}

module.exports = { diffHunks, marksFor, nextChange, lineOf, splitText, GitGutter, DELAY };
