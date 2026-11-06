// node --test mods/vscode-spaces/test/kept.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { sync, interleave, forget, adopt, liveIndex, moveTo, reopenArgs, load, CLOSING_MS } from "../kept.js";

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

test("closing one of several spaces with the same name and folder keeps its row", () => {
  const dup = (id, color) => sp(id, { name: "project", folder: "/w/project", color });
  const list = sync([], [dup("p1", "ansi1"), dup("p2", "ansi2"), dup("p3", "ansi3")], here);
  const next = sync(list, [dup("p1", "ansi1"), dup("p3", "ansi3")], here);
  assert.deepEqual(ids(next), ["p1", "p2-", "p3"]);
  assert.equal(next[1].color, "ansi2");
});

test("a new space made by hand in the same place doesn't replace a closed row", () => {
  const list = sync(sync([], [sp("a"), sp("b")], here), [sp("a")], here);
  assert.deepEqual(ids(sync(list, [sp("a"), sp("n", { name: "b", folder: "/w/b" })], here)), ["a", "b-", "n"]);
});

test("only reopening the row itself takes it out: same-named rows keep their places and colors", () => {
  const dup = (id, color) => sp(id, { name: "project", folder: "/w/project", color });
  let list = sync([], [sp("a"), dup("p1", "ansi1"), dup("p2", "ansi2")], here);
  list = sync(list, [sp("a")], here);
  list = adopt(list, "p2", "n");
  assert.equal(liveIndex(list, "n", new Set(["a", "n"])), 2);
  list = sync(list, [sp("a"), dup("n", "ansi2")], here);
  assert.deepEqual(ids(list), ["a", "p1-", "n"]);
  assert.equal(list[1].color, "ansi1");
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

// What render draws: the stored list merged with spaces() right then, no stored step between.
const draw = (stored, live, ready = here, closing = {}, now = 0) =>
  interleave(live.map((s) => ({ id: s.id })), sync(stored, live, ready, closing, now), (r) => r.id).map((r) => r.id);

test("the first draw after Herdr drops a space already shows its closed row in place", () => {
  const stored = sync([], [sp("a"), sp("b"), sp("c")], here); // b still live in what was stored
  assert.deepEqual(draw(stored, [sp("a"), sp("c")]), ["a", "b", "c"]);
});

test("drawing again before the list is stored draws the same rows", () => {
  const stored = sync([], [sp("a"), sp("b"), sp("c")], here);
  const once = sync(stored, [sp("a"), sp("c")], here);
  assert.deepEqual(sync(once, [sp("a"), sp("c")], here), once);
});

test("a space closed from the menu is never drawn as a closed row", () => {
  const stored = sync([], [sp("a"), sp("b")], here);
  assert.deepEqual(draw(stored, [sp("a")], here, { b: 0 }, 10), ["a"]);
});

test("a remote space missing while its layout is unreadable is never drawn closed", () => {
  const stored = sync([], [sp("a"), sp("r", { machine: "vps" })], new Set([null, "vps"]));
  assert.deepEqual(draw(stored, [sp("a")], here), ["a"]);
});

// One reopening as vscode-spaces does it: Herdr adds the new space last; the row's
// place gives its index; the list is synced in the order Herdr will have after the move.
function reopen(list, rowId, newId, live) {
  const adopted = adopt(list, rowId, newId);
  const index = liveIndex(adopted, newId, new Set(live.map((s) => s.id)));
  const order = moveTo(live, newId, index);
  return { index, order, list: sync(adopted, order, here) };
}

test("a reopened space's index is the row's place, not last where Herdr added it", () => {
  const list = sync(sync([], [sp("a"), sp("b"), sp("c")], here), [sp("a"), sp("c")], here);
  const live = [sp("a"), sp("c"), sp("n")];
  // Read after sync() (the bug), the new space is already last: no move was sent.
  assert.equal(liveIndex(sync(adopt(list, "b", "n"), live, here), "n", new Set(["a", "c", "n"])), 3);
  const r = reopen(list, "b", "n", live);
  assert.equal(r.index, 2);
  assert.deepEqual(r.order.map((s) => s.id), ["a", "n", "c"]);
  assert.deepEqual(ids(r.list), ["a", "n", "c"]);
});

test("closed rows don't count in the index Herdr gets", () => {
  const list = sync(sync([], [sp("a"), sp("x"), sp("b"), sp("c")], here), [sp("a"), sp("c")], here);
  const r = reopen(list, "b", "n", [sp("a"), sp("c"), sp("n")]);
  assert.equal(r.index, 2);
  assert.deepEqual(ids(r.list), ["a", "x-", "n", "c"]);
});

test("same-named rows each reopen at their own place with their own color", () => {
  const dup = (id, color) => sp(id, { name: "project", folder: "/w/project", color });
  let list = sync([], [sp("a"), dup("p1", "ansi1"), sp("b"), dup("p2", "ansi2"), sp("c")], here);
  list = sync(list, [sp("a"), sp("b"), sp("c")], here);
  let r = reopen(list, "p2", "n2", [sp("a"), sp("b"), sp("c"), dup("n2")]);
  assert.equal(r.index, 3);
  assert.deepEqual(ids(r.list), ["a", "p1-", "b", "n2", "c"]);
  assert.equal(r.list[3].color, "ansi2");
  r = reopen(r.list, "p1", "n1", [...r.order, dup("n1")]);
  assert.equal(r.index, 2);
  assert.deepEqual(ids(r.list), ["a", "n1", "b", "n2", "c"]);
  assert.equal(r.list[1].color, "ansi1");
});

test("moveTo puts one item at a 1-based index and leaves the rest in order", () => {
  const items = ["a", "b", "c", "d"].map((id) => ({ id }));
  const at = (id, index) => moveTo(items, id, index).map((x) => x.id).join("");
  assert.equal(at("d", 2), "adbc");
  assert.equal(at("a", 4), "bcda");
  assert.equal(at("b", 9), "acdb");
  assert.equal(at("z", 1), "abcd");
  assert.equal(at("c", null), "abcd");
});

test("an unreadable stored list is empty", () => {
  assert.deepEqual(load("{"), []);
  assert.deepEqual(load(null), []);
  assert.deepEqual(load('[{"id":"a"},null,{"x":1}]'), [{ id: "a" }]);
});
