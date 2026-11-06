// node --test mods/vscode-scm/test/cache.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { freshRoot, encode, decode, KEEP, MAX_AGE, MAX_CHARS } from "../cache.js";

test("a fresh space starts at its first terminal's folder, else its folder; spaces on one folder share a key", () => {
  const panes = [{ pane: "p1", tab: "t1", terminal: "a", cwd: "/w/app" }, { pane: "p2", tab: "t2", terminal: null, mod: "x", cwd: null }];
  const a = freshRoot({ id: "s1", folder: "/w", machine: null, tabs: [{ id: "t1" }] }, panes);
  const b = freshRoot({ id: "s2", folder: "/w/app", machine: null, tabs: [{ id: "t2" }] }, panes);
  assert.equal(JSON.stringify(a), '{"cwd":"/w/app","on":null}');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(freshRoot({ id: "box/s3", folder: "/srv", machine: "box", tabs: [] }, panes), { cwd: "/srv", on: "box" });
});

const now = 1_000_000_000_000;
const commit = (i) => ({ hash: `h${i}`.padEnd(40, "0"), parents: [], refs: [], subject: `c${i}`, author: "me", date: "1 day ago", col: 0, lines: [], links: [], width: 1, merge: false });
const repo = (at, n = 3) => ({ at, files: [{ path: "a.js", status: "M" }], limited: false, hasHead: true, commits: Array.from({ length: n }, (_, i) => commit(i)),
  expanded: new Set([commit(0).hash, commit(1).hash]), commitFiles: new Map([[commit(0).hash, [{ path: "a.js", status: "M" }]], [commit(1).hash, "Loading…"]]) });
const ctx = (cwd) => JSON.stringify({ cwd, on: null });

test("caches survive a round trip without lanes or files still loading", () => {
  const state = {
    seen: new Map([[ctx("/w"), { repos: [{ path: "/w", name: "w" }], at: now - 5 }]]),
    repoCache: new Map([["/w", repo(now - 5)]]),
    lastSelected: new Map([[ctx("/w"), "/w"], [ctx("/gone"), "/gone"]]),
    chosen: new Map([[ctx("/w"), "/w"]]),
    lastRoot: { s1: { cwd: "/w", on: null }, s2: { cwd: "/gone", on: null } },
  };
  const back = decode(encode(state, now), now);
  assert.deepEqual(back.seen, state.seen);
  assert.deepEqual([...back.lastSelected], [[ctx("/w"), "/w"]]);
  assert.deepEqual([...back.chosen], [[ctx("/w"), "/w"]]);
  assert.deepEqual(back.lastRoot, { s1: { cwd: "/w", on: null } });
  const c = back.repoCache.get("/w");
  assert.deepEqual(c.commits[0], { hash: commit(0).hash, parents: [], refs: [], subject: "c0", author: "me", date: "1 day ago" });
  assert.deepEqual(c.expanded, new Set([commit(0).hash]));
  assert.deepEqual([...c.commitFiles.keys()], [commit(0).hash]);
  assert.equal(c.at, now - 5);
});

test("keeps the newest 30 under 7 days and the size cap", () => {
  const empty = { lastSelected: new Map(), chosen: new Map(), lastRoot: {} };
  const seen = new Map(Array.from({ length: 40 }, (_, i) => [ctx(`/p${i}`), { repos: [], at: now - i }]));
  const repoCache = new Map(Array.from({ length: 40 }, (_, i) => [`/p${i}`, repo(now - i)]));
  repoCache.set("/old", repo(now - MAX_AGE - 1));
  const back = decode(encode({ ...empty, seen, repoCache }, now), now);
  assert.equal(back.seen.size, KEEP);
  assert.equal(back.repoCache.size, KEEP);
  assert.ok(back.repoCache.has("/p0") && !back.repoCache.has("/p30") && !back.repoCache.has("/old"));
  const big = new Map(Array.from({ length: 30 }, (_, i) => [`/b${i}`, repo(now - i, 300)]));
  const text = encode({ ...empty, seen: new Map(), repoCache: big }, now);
  assert.ok(text.length <= MAX_CHARS + 200);
  const left = decode(text, now).repoCache;
  assert.ok(left.size > 0 && left.size < 30 && left.has("/b0"));
});

test("a missing or corrupt cache is a cold load", () => {
  for (const text of [null, "", "{", '{"v":2}', '{"v":1,"seen":7}']) assert.equal(decode(text, now).seen.size, 0);
});
