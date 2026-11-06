// node --test mods/vscode-spaces/test/kept.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { sync, interleave, forget, adopt, liveIndex, reopenArgs, load, CLOSING_MS } from "../kept.js";

const sp = (id, extra = {}) => ({ id, name: id, named: false, folder: `/w/${id}`, machine: null, color: "ansi4", ...extra });
const here = new Set([null]);
const ids = (list) => list.map((r) => `${r.id}${r.live === false ? "-" : ""}`);

test("spaces seen are remembered in Herdr's order", () => {
  assert.deepEqual(ids(sync([], [sp("a"), sp("b")], here)), ["a", "b"]);
});

test("a space Herdr closed stays where it was, marked closed", () => {
  const list = sync([], [sp("a"), sp("b"), sp("c")], here);
  const next = sync(list, [sp("a"), sp("c")], here);
  assert.deepEqual(ids(next), ["a", "b-", "c"]);
  assert.equal(next[1].folder, "/w/b");
  assert.equal(next[1].color, "ansi4");
});

test("a closed first space stays first", () => {
  const next = sync(sync([], [sp("a"), sp("b")], here), [sp("b")], here);
  assert.deepEqual(ids(next), ["a-", "b"]);
});

test("closed rows follow the space before them when the live order changes", () => {
  const list = sync(sync([], [sp("a"), sp("b"), sp("c")], here), [sp("a"), sp("c")], here);
  assert.deepEqual(ids(sync(list, [sp("c"), sp("a")], here)), ["c", "a", "b-"]);
});

test("a new space comes in at its place in Herdr's order", () => {
  const list = sync(sync([], [sp("a"), sp("b")], here), [sp("a")], here);
  assert.deepEqual(ids(sync(list, [sp("a"), sp("n")], here)), ["a", "b-", "n"]);
});

test("nothing is concluded while the space's machine layout isn't readable", () => {
  const list = sync([], [sp("a"), sp("r", { machine: "vps" })], new Set([null, "vps"]));
  const next = sync(list, [sp("a")], here);
  assert.equal(next.find((r) => r.id === "r").live, true);
  assert.deepEqual(ids(interleave([{ id: "a" }], next, (r) => r.id)), ["a"]);
});

test("spaces missing at start, before the layout is read, are not closed", () => {
  const stored = sync([], [sp("a")], here);
  assert.equal(sync(stored, [], new Set())[0].live, true);
  assert.equal(sync(stored, [], here)[0].live, false);
});

test("a space closed on purpose from the menu is forgotten", () => {
  const list = sync([], [sp("a"), sp("b")], here);
  assert.deepEqual(ids(sync(list, [sp("a")], here, { b: 1000 }, 2000)), ["a"]);
});

test("an old Close request (dialog cancelled long ago) doesn't forget it", () => {
  const list = sync([], [sp("a"), sp("b")], here);
  assert.deepEqual(ids(sync(list, [sp("a")], here, { b: 1000 }, 1000 + CLOSING_MS)), ["a", "b-"]);
});

test("a live space with the same machine, folder and name replaces a closed one", () => {
  const list = sync(sync([], [sp("a"), sp("b")], here), [sp("a")], here);
  assert.deepEqual(ids(sync(list, [sp("a"), sp("n", { name: "b", folder: "/w/b" })], here)), ["a", "n"]);
});

test("a closed space keeps its last color when the live one has none", () => {
  const list = sync([], [sp("a", { color: "ansi1" })], here);
  assert.equal(sync(list, [sp("a", { color: undefined })], here)[0].color, "ansi1");
});

test("closed rows are drawn after the shown row they followed", () => {
  const list = sync(sync([], [sp("a"), sp("b"), sp("c"), sp("d")], here), [sp("a"), sp("d")], here);
  const rows = [{ id: "a" }, { id: "d" }];
  assert.deepEqual(interleave(rows, list, (r) => r.id).map((r) => r.id), ["a", "b", "c", "d"]);
});

test("a closed row after a space not shown yet goes after the nearest shown one", () => {
  const list = sync(sync([], [sp("a"), sp("b"), sp("c")], here), [sp("a"), sp("b")], here);
  assert.deepEqual(interleave([{ id: "a" }], list, (r) => r.id).map((r) => r.id), ["a", "c"]);
});

test("Remove from list forgets the row", () => {
  const list = sync(sync([], [sp("a"), sp("b")], here), [sp("a")], here);
  assert.deepEqual(ids(forget(list, "b")), ["a"]);
});

test("a reopened space takes the closed row's place and is moved there", () => {
  const list = sync(sync([], [sp("a"), sp("b"), sp("c")], here), [sp("a"), sp("c")], here);
  const adopted = adopt(list, "b", "n");
  assert.deepEqual(ids(adopted), ["a", "n", "c"]);
  assert.equal(adopted[1].color, "ansi4");
  assert.equal(liveIndex(adopted, "n", new Set(["a", "c", "n"])), 2);
  assert.equal(liveIndex(adopted, "x", new Set()), null);
});

test("space.new reopens it with its folder and machine, its name only if someone named it", () => {
  assert.deepEqual(reopenArgs(sp("b")), { folder: "/w/b", machine: "" });
  assert.deepEqual(reopenArgs(sp("b", { named: true, machine: "vps" })), { name: "b", folder: "/w/b", machine: "vps" });
  assert.deepEqual(reopenArgs(sp("b", { folder: "" })), { machine: "" });
});

test("an unreadable stored list is empty", () => {
  assert.deepEqual(load("{"), []);
  assert.deepEqual(load(null), []);
  assert.deepEqual(load('[{"id":"a"},null,{"x":1}]'), [{ id: "a" }]);
});
