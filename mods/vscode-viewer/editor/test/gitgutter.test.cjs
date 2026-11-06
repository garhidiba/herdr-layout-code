// node --test mods/vscode-viewer/editor/test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const G = require("../gitgutter.cjs");
const H = require("../highlight.cjs");
const SB = require("../scrollbar.cjs");
const { fgSGR } = require("../paint.cjs");
const { Editor } = require("../vsedit.cjs");

// ---------- the diff ----------
test("lines only in the buffer are added, lines replaced are modified, lines gone are a deletion before the next line", () => {
  const base = ["a", "b", "c", "d", "e"];
  assert.deepEqual(G.diffHunks(base, ["a", "b", "x", "y", "c", "d", "e"]), [{ kind: "added", start: 2, end: 4 }]);
  assert.deepEqual(G.diffHunks(base, ["a", "B", "c", "d", "e"]), [{ kind: "modified", start: 1, end: 2 }]);
  assert.deepEqual(G.diffHunks(base, ["a", "d", "e"]), [{ kind: "deleted", start: 1, end: 1 }]);
  assert.deepEqual(G.diffHunks(base, ["a", "B", "C", "x", "d"]), [{ kind: "modified", start: 1, end: 4 }, { kind: "deleted", start: 5, end: 5 }]);
  assert.deepEqual(G.diffHunks(base, base.slice()), [], "no change: no hunks");
});

test("a file new in the index (empty base) is all added; past the edit limit the middle is one change", () => {
  assert.deepEqual(G.diffHunks([], ["a", "b"]), [{ kind: "added", start: 0, end: 2 }]);
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`), b = Array.from({ length: 50 }, (_, i) => (i % 2 ? `b${i}` : `a${i}`));
  assert.deepEqual(G.diffHunks(a, b, 3), [{ kind: "modified", start: 1, end: 50 }]);
  assert.equal(G.diffHunks(a, b).length, 25, "within the limit: each changed line apart");
});

test("gutter marks: bars on changed lines, a deletion marker below the line before it (above the first line at the top)", () => {
  const hunks = [{ kind: "deleted", start: 0, end: 0 }, { kind: "added", start: 2, end: 4 }, { kind: "deleted", start: 6, end: 6 }];
  assert.deepEqual([...G.marksFor(hunks, 0, 9)], [[0, "deletedAbove"], [2, "added"], [3, "added"], [5, "deletedBelow"]]);
  assert.deepEqual([...G.marksFor(hunks, 3, 4)], [[3, "added"]], "only the lines asked for");
});

test("next / previous change from the cursor line, wrapping around the file", () => {
  const hunks = [{ kind: "added", start: 2, end: 4 }, { kind: "deleted", start: 9, end: 9 }];
  assert.equal(G.nextChange(hunks, 0, 1), hunks[0]);
  assert.equal(G.nextChange(hunks, 2, 1), hunks[1], "a deletion is at the line before it (8)");
  assert.equal(G.nextChange(hunks, 8, 1), hunks[0], "past the last: back to the first");
  assert.equal(G.nextChange(hunks, 8, -1), hunks[0]);
  assert.equal(G.nextChange(hunks, 1, -1), hunks[1], "before the first: the last");
  assert.equal(G.nextChange([], 1, 1), null);
});

test("HEAD's text splits like a file: BOM dropped, any line ending, no line after the final newline", () => {
  assert.deepEqual(G.splitText("﻿a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(G.splitText(""), [""]);
});

// ---------- against a repo ----------
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-git-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  git("add", "a.txt"); git("commit", "-q", "-m", "first");
  return { dir, git };
}

test("a tracked file diffs against HEAD; a file new in the index is all added; an untracked one or no repo shows nothing", async (t) => {
  const { dir, git } = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gutter = (name, lines) => { const g = new G.GitGutter(path.join(dir, name), { lines }); g.started = true; return g; };
  const a = gutter("a.txt", ["one", "TWO", "three", "four"]);
  await a.refresh();
  clearInterval(a.poller);
  assert.deepEqual(a.base, ["one", "two", "three"]);
  assert.deepEqual(a.hunks, [{ kind: "modified", start: 1, end: 2 }, { kind: "added", start: 3, end: 4 }]);
  fs.writeFileSync(path.join(dir, "new.txt"), "x\n");
  const untracked = gutter("new.txt", ["x"]);
  await untracked.refresh(); clearInterval(untracked.poller);
  assert.equal(untracked.base, null); assert.deepEqual(untracked.hunks, []);
  git("add", "new.txt");
  const staged = gutter("new.txt", ["x"]);
  await staged.refresh(); clearInterval(staged.poller);
  assert.deepEqual(staged.hunks, [{ kind: "added", start: 0, end: 1 }]);
  const outside = new G.GitGutter(path.join(os.tmpdir(), "vsedit-no-repo.txt"), { lines: ["a"] });
  await outside.refresh();
  assert.equal(outside.base, null); assert.equal(outside.poller, null, "no repo: no polling");
});

test("edits diff 300 ms after the last one, and a new commit (HEAD's reflog) is read again", async (t) => {
  const { dir, git } = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const buf = { lines: ["one", "two", "three"] };
  let frames = 0;
  const g = new G.GitGutter(path.join(dir, "a.txt"), buf, () => frames++);
  g.start();
  while (g.base === null) await new Promise(r => setTimeout(r, 20));
  clearInterval(g.poller);
  buf.lines.push("four"); g.changed();
  assert.deepEqual(g.hunks, [], "not before the delay");
  await new Promise(r => setTimeout(r, G.DELAY + 50));
  assert.deepEqual(g.hunks, [{ kind: "added", start: 3, end: 4 }]);
  assert.ok(frames > 0, "a frame was asked for");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
  git("commit", "-q", "-am", "second");
  g.poll();
  while (g.hunks.length) await new Promise(r => setTimeout(r, 20));
  assert.equal(g.base.length, 4, "the new HEAD");
});

test("the painted gutter has the change bar after the line number in editorGutter colors, and the ruler marks it", async (t) => {
  const { dir } = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "a.txt");
  const ed = new Editor(file, { lines: ["one", "TWO", "three", ...Array.from({ length: 60 }, (_, i) => `x${i}`)], eol: "\n", finalNewline: true },
    { grammar: null, colorMap: [], textmate: { INITIAL: null } }, H.loadTheme(), "text");
  ed.rows = 20; ed.cols = 40;
  ed.render();
  await ed.git.refresh(); clearInterval(ed.git.poller);
  const out = ed.render().out, c = ed.colors;
  assert.deepEqual(ed.git.hunks, [{ kind: "modified", start: 1, end: 2 }, { kind: "added", start: 3, end: 63 }]);
  assert.ok(out.includes(fgSGR(c.gitModified) + "▎"), "a modified bar");
  assert.ok(out.includes(fgSGR(c.gitAdded) + "▎"), "an added bar");
  assert.equal(c.gitAdded, "#109868");
  assert.equal(ed.marks[SB.markCell(40, 63, ed.vbar.length)], c.rulerAdded, "the added lines on the overview ruler");
  ed.gotoChange(1);
  assert.equal(ed.head.line, 1, "Go to Next Change from line 0");
  ed.gotoChange(1); ed.gotoChange(1);
  assert.equal(ed.head.line, 1, "wraps around");
});
