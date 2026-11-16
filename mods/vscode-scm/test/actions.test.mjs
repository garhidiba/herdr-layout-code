// node --test mods/vscode-scm/test/actions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatus, fileState, groupState, fileMenuItems, groupMenuItems, menuHeight, actionSteps, confirmOf } from "../actions.js";

const actions = (rows) => rows.filter((r) => r !== "-").map((r) => r[1]);

test("status entries keep their XY and path, spaces in names included", () => {
  assert.deepEqual(parseStatus(" M a b.txt\0?? new.js\0"), [{ xy: " M", path: "a b.txt" }, { xy: "??", path: "new.js" }]);
  assert.deepEqual(parseStatus(""), []);
});

test("an unstaged change offers Stage and Discard, not Unstage", () => {
  assert.deepEqual(actions(fileMenuItems(fileState(" M"))),
    ["diff", "open", "stage", "discard", "revealExplorer", "reveal", "copyPath", "copyRelative"]);
});

test("a staged change offers Unstage instead of Stage", () => {
  const items = actions(fileMenuItems(fileState("M ")));
  assert.ok(items.includes("unstage") && items.includes("discard") && !items.includes("stage"));
});

test("a partly staged file offers both Stage and Unstage", () => {
  const items = actions(fileMenuItems(fileState("MM")));
  assert.ok(items.includes("stage") && items.includes("unstage"));
});

test("only an untracked file offers Add to .gitignore", () => {
  assert.ok(actions(fileMenuItems(fileState("??"))).includes("ignore"));
  assert.ok(!actions(fileMenuItems(fileState(" M"))).includes("ignore"));
  assert.ok(!actions(fileMenuItems(fileState("A "))).includes("ignore"));
});

test("a remote file has no Reveal in Finder but keeps Reveal in Explorer View", () => {
  const items = actions(fileMenuItems(fileState(" M"), { remote: true }));
  assert.ok(!items.includes("reveal") && items.includes("revealExplorer"));
});

test("a deleted file has nothing to open or reveal", () => {
  for (const xy of [" D", "D "]) assert.deepEqual(actions(fileMenuItems(fileState(xy))), ["diff", ...(xy === " D" ? ["stage"] : ["unstage"]), "discard", "copyPath", "copyRelative"]);
});

test("a conflicted file stages (marks resolved) and is not called staged", () => {
  assert.deepEqual([fileState("UU").staged, fileState("UU").unstaged], [false, true]);
});

test("a file that is no longer changed (a stale row) offers no git action", () => {
  assert.deepEqual(actions(fileMenuItems(fileState(undefined))), ["diff", "open", "revealExplorer", "reveal", "copyPath", "copyRelative"]);
});

test("the Changes header offers what the repo has: Stage All, Unstage All, Discard All", () => {
  const state = groupState(parseStatus("M  a\0 M b\0?? c\0"));
  assert.deepEqual(state, { staged: true, unstaged: true, count: 3 });
  assert.deepEqual(actions(groupMenuItems(state)), ["stageAll", "unstageAll", "discardAll"]);
  assert.deepEqual(actions(groupMenuItems(groupState(parseStatus("A  a\0")))), ["unstageAll", "discardAll"]);
  assert.deepEqual(groupMenuItems(groupState([])), []);
});

test("Discard All is not offered in a repo without a commit (it would delete every file)", () => {
  assert.deepEqual(actions(groupMenuItems(groupState(parseStatus("?? a\0")), { hasHead: false })), ["stageAll"]);
  assert.equal(actionSteps("discardAll", { hasHead: false }), null);
});

test("the menu is as tall as the Explorer's: 26 px rows, 9 px separators, 10 px padding", () => {
  assert.equal(menuHeight([["a", "a"], "-", ["b", "b"]]), 10 + 26 + 9 + 26);
});

test("only the destructive actions ask first, untracked files with VS Code's DELETE wording", () => {
  assert.equal(confirmOf("stage", { path: "a", state: fileState(" M") }), null);
  assert.match(confirmOf("discard", { path: "src/a.js", state: fileState(" M") }).title, /discard changes in a\.js/);
  assert.match(confirmOf("discard", { path: "n.js", state: fileState("??") }).title, /DELETE n\.js/);
  assert.match(confirmOf("discardAll", { count: 3 }).title, /ALL changes in 3 files/);
});

// The steps run with real git in a temporary repo.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "scm-actions-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n"); git("add", "a.txt"); git("commit", "-q", "-m", "init");
  const status = (path) => parseStatus(git("status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all")).find((e) => e.path === path)?.xy;
  const run = (action, path) => {
    const target = { root: dir, path, state: fileState(status(path)), hasHead: true };
    for (const [cmd, args] of actionSteps(action, target)) execFileSync(cmd, args, { cwd: dir });
  };
  return { dir, git, status, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Stage and Unstage move a change into and out of the index", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "a.txt"), "two\n");
    r.run("stage", "a.txt"); assert.equal(r.status("a.txt"), "M ");
    r.run("unstage", "a.txt"); assert.equal(r.status("a.txt"), " M");
  } finally { r.done(); }
});

test("Discard goes back to HEAD: a staged edit, a new file, an untracked file, a deletion", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "a.txt"), "two\n"); r.git("add", "a.txt"); writeFileSync(join(r.dir, "a.txt"), "three\n");
    r.run("discard", "a.txt"); assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "one\n"); assert.equal(r.status("a.txt"), undefined);
    writeFileSync(join(r.dir, "n.txt"), "x"); r.git("add", "n.txt");
    r.run("discard", "n.txt"); assert.equal(existsSync(join(r.dir, "n.txt")), false);
    writeFileSync(join(r.dir, "u *.txt"), "x"); writeFileSync(join(r.dir, "u keep.txt"), "x");
    r.run("discard", "u *.txt"); assert.equal(existsSync(join(r.dir, "u *.txt")), false);
    assert.equal(existsSync(join(r.dir, "u keep.txt")), true, "the path is literal, not a glob");
    rmSync(join(r.dir, "a.txt")); r.run("discard", "a.txt"); assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "one\n");
  } finally { r.done(); }
});

test("Add to .gitignore appends the anchored path on its own line", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, ".gitignore"), "node_modules");
    writeFileSync(join(r.dir, "secret.env"), "x");
    r.run("ignore", "secret.env");
    assert.equal(readFileSync(join(r.dir, ".gitignore"), "utf8"), "node_modules\n/secret.env\n");
    assert.equal(r.status("secret.env"), undefined);
  } finally { r.done(); }
});

test("Stage All, Unstage All and Discard All act on the whole repo", () => {
  const r = repo();
  try {
    const all = (action) => { for (const [cmd, args] of actionSteps(action, { root: r.dir, hasHead: true })) execFileSync(cmd, args, { cwd: r.dir }); };
    writeFileSync(join(r.dir, "a.txt"), "two\n"); writeFileSync(join(r.dir, "n.txt"), "x");
    all("stageAll"); assert.deepEqual([r.status("a.txt"), r.status("n.txt")], ["M ", "A "]);
    all("unstageAll"); assert.deepEqual([r.status("a.txt"), r.status("n.txt")], [" M", "??"]);
    all("discardAll"); assert.equal(r.git("status", "--porcelain"), "");
    assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "one\n");
  } finally { r.done(); }
});
