// node --test mods/vscode-scm/test/sync.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { syncAction, syncSteps, syncError } from "../sync.js";

const repo = (ab) => ({ branch: "main", oid: "abc", upstream: "origin/main", ahead: 0, behind: 0, ...ab });

test("with changes the Commit button stays, whatever the branch is ahead or behind", () => {
  assert.equal(syncAction(repo({ ahead: 3, behind: 1 }), 2), null);
});

test("a clean branch even with its upstream keeps the Commit button", () => {
  assert.equal(syncAction(repo(), 0), null);
});

test("a clean branch ahead of its upstream offers Push with the count", () => {
  assert.deepEqual(syncAction(repo({ ahead: 8 }), 0), { kind: "push", label: "↑ Push 8 commits to origin/main" });
  assert.equal(syncAction(repo({ ahead: 1 }), 0).label, "↑ Push 1 commit to origin/main");
});

test("a clean branch behind its upstream offers Pull", () => {
  assert.deepEqual(syncAction(repo({ behind: 2 }), 0), { kind: "pull", label: "↓ Pull 2 commits from origin/main" });
});

test("a clean branch both ahead and behind offers Sync Changes", () => {
  assert.deepEqual(syncAction(repo({ ahead: 1, behind: 4 }), 0), { kind: "sync", label: "⇅ Sync Changes ↓4 ↑1" });
});

test("a branch without an upstream (or with a gone one) offers Publish Branch", () => {
  assert.equal(syncAction(repo({ upstream: null, ahead: null, behind: null }), 0).kind, "publish");
  assert.equal(syncAction(repo({ ahead: null, behind: null }), 0).kind, "publish");
});

test("a detached, unborn or unknown repo has no sync action", () => {
  assert.equal(syncAction(repo({ branch: "(detached)", ahead: 2 }), 0), null);
  assert.equal(syncAction(repo({ oid: "(initial)", upstream: null, ahead: null }), 0), null);
  assert.equal(syncAction(undefined, 0), null);
});

test("sync is the repo's own pull, then push; push and pull are plain", () => {
  assert.deepEqual(syncSteps("sync", "main"), [["pull"], ["push"]]);
  assert.deepEqual(syncSteps("push", "main"), [["push"]]);
  assert.deepEqual(syncSteps("pull", "main"), [["pull"]]);
});

test("publish sets the upstream on origin when there is one, else the first remote", () => {
  assert.deepEqual(syncSteps("publish", "feat", ["upstream", "origin"]), [["push", "-u", "origin", "feat"]]);
  assert.deepEqual(syncSteps("publish", "feat", ["gh"]), [["push", "-u", "gh", "feat"]]);
  assert.throws(() => syncSteps("publish", "feat", []), /no remote/);
});

test("no step ever force-pushes", () => {
  for (const kind of ["push", "pull", "sync", "publish"])
    for (const step of syncSteps(kind, "main", ["origin"])) assert.ok(!step.some((a) => /^(-f|--force)/.test(a)));
});

test("a rejected push suggests pulling first", () => {
  assert.match(syncError(" ! [rejected]        main -> main (fetch first)"), /Pull first/);
});

test("a missing credential explains that no prompt can be shown", () => {
  assert.match(syncError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), /credential helper or ssh agent/);
  assert.match(syncError("git@github.com: Permission denied (publickey)."), /Authentication failed/);
});

test("other errors pass through, an empty one gets a fallback", () => {
  assert.equal(syncError("fatal: boom\n"), "fatal: boom");
  assert.equal(syncError(""), "git exited with an error");
});
