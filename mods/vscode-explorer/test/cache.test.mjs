// node --test mods/vscode-explorer/test/cache.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { freshRoot, encode, decode, KEEP, MAX_AGE, MAX_CHARS } from "../cache.js";

const tab = (id) => ({ id });
const panes = [
  { pane: "p1", tab: "t1", terminal: null, mod: "vscode-viewer", cwd: null },
  { pane: "p2", tab: "t1", terminal: "a", cwd: "/w/app" },
  { pane: "p3", tab: "t2", terminal: "b", cwd: "/w/app" },
];

test("a fresh space starts at its first terminal's folder, else its folder", () => {
  assert.deepEqual(freshRoot({ id: "s1", folder: "/w", machine: null, tabs: [tab("t1")] }, panes), { cwd: "/w/app", on: null, space: "s1" });
  // Two spaces on one folder: same root, keys differ only by space.
  assert.deepEqual(freshRoot({ id: "s2", folder: "/w", machine: null, tabs: [tab("t2")] }, panes), { cwd: "/w/app", on: null, space: "s2" });
  assert.deepEqual(freshRoot({ id: "s3", folder: "/w/docs", machine: null, tabs: [tab("t9")] }, panes), { cwd: "/w/docs", on: null, space: "s3" });
  assert.deepEqual(freshRoot({ id: "box/s4", folder: "/srv", machine: "box", tabs: [] }, panes), { cwd: "/srv", on: "box", space: "box/s4" });
  assert.equal(JSON.stringify(freshRoot({ id: "s3", folder: "/w/docs", machine: null, tabs: [] }, [])), '{"cwd":"/w/docs","on":null,"space":"s3"}');
});

const now = 1_000_000_000_000;
const tree = (at, n = 2) => ({ at, folders: new Set(["src"]), entries: new Map([["", [{ name: "src", dir: true }]], ["src", Array.from({ length: n }, (_, i) => ({ name: `f${i}.js`, dir: false }))]]), marks: { "/w/src/f0.js": "M" }, dirty: new Map() });

test("saved trees and lastRoot survive a round trip", () => {
  const loc = { cwd: "/w", on: null, space: "s1" }, k = JSON.stringify(loc);
  const { saved, lastRoot } = decode(encode(new Map([[k, tree(now - 5)]]), { s1: loc, gone: { cwd: "/x", on: null, space: "gone" } }, now), now);
  assert.deepEqual([...saved.keys()], [k]);
  assert.deepEqual(saved.get(k), { at: now - 5, folders: new Set(["src"]), entries: tree(0).entries, marks: { "/w/src/f0.js": "M" } });
  assert.deepEqual(lastRoot, { s1: loc }); // lastRoot only for kept projects
});

test("keeps the newest 30 under 7 days and the size cap", () => {
  const many = new Map(Array.from({ length: 40 }, (_, i) => [`k${i}`, tree(now - i * 1000)]));
  many.set("old", tree(now - MAX_AGE - 1));
  const kept = decode(encode(many, {}, now), now).saved;
  assert.equal(kept.size, KEEP);
  assert.ok(kept.has("k0") && kept.has("k29") && !kept.has("k30") && !kept.has("old"));
  const big = new Map(Array.from({ length: 10 }, (_, i) => [`b${i}`, tree(now - i, 5000)]));
  const text = encode(big, {}, now);
  assert.ok(text.length <= MAX_CHARS + 100);
  const left = decode(text, now).saved;
  assert.ok(left.size > 0 && left.size < 10 && left.has("b0"));
});

test("a missing or corrupt cache is a cold load", () => {
  for (const text of [null, "", "{", '{"v":2}', '{"v":1,"saved":5}']) assert.equal(decode(text, now).saved.size, 0);
  assert.equal(decode(encode(new Map([["k", tree(now)]]), {}, now), now + MAX_AGE).saved.size, 0);
});
