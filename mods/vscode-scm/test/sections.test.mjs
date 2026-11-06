// node --test mods/vscode-scm/test/sections.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { layoutSections, flexSection, sashPair, dragSash } from "../sections.js";

const sections = (repos, changes, graph) => [
  { id: "repos", min: 22, ...repos },
  { id: "changes", min: 94, ...changes },
  { id: "graph", min: 44, ...graph },
];

test("Changes takes the height the other open sections leave", () => {
  const s = sections({ open: true, size: 110 }, { open: true }, { open: true, size: 200 });
  assert.deepEqual(layoutSections(s, 600, "changes"), { repos: 110, changes: 290, graph: 200 });
});

test("a collapsed section gives its space back to Changes", () => {
  const s = sections({ open: true, size: 110 }, { open: true }, { open: false, size: 200 });
  assert.deepEqual(layoutSections(s, 600, "changes"), { repos: 110, changes: 490 });
});

test("with Changes collapsed, the last open section takes the rest", () => {
  const s = sections({ open: true, size: 110 }, { open: false }, { open: true, size: 200 });
  assert.deepEqual(layoutSections(s, 600, "changes"), { repos: 110, graph: 490 });
});

test("stored sizes shrink so Changes keeps its minimum, earlier sections first", () => {
  const s = sections({ open: true, size: 300 }, { open: true }, { open: true, size: 300 });
  assert.deepEqual(layoutSections(s, 400, "changes"), { repos: 262, changes: 94, graph: 44 });
});

test("a panel shorter than every minimum gives each open section its minimum", () => {
  const s = sections({ open: true, size: 110 }, { open: true }, { open: true, size: 200 });
  assert.deepEqual(layoutSections(s, 50, "changes"), { repos: 22, changes: 94, graph: 44 });
});

test("a section without a stored size starts at its minimum; nothing open lays out nothing", () => {
  assert.deepEqual(layoutSections(sections({ open: true }, { open: true }, { open: false }), 300, "changes"), { repos: 22, changes: 278 });
  assert.deepEqual(layoutSections(sections({ open: false }, { open: false }, { open: false }), 300, "changes"), {});
});

test("the flex section is Changes while open, else the last open section", () => {
  assert.equal(flexSection(sections({ open: true }, { open: true }, { open: true }), "changes").id, "changes");
  assert.equal(flexSection(sections({ open: true }, { open: false }, { open: false }), "changes").id, "repos");
  assert.equal(flexSection(sections({ open: false }, { open: false }, { open: false }), "changes"), undefined);
});

test("a sash sits between the nearest open sections above and below it", () => {
  const all = sections({ open: true }, { open: true }, { open: true });
  assert.deepEqual(sashPair(all, 1), ["repos", "changes"]);
  assert.deepEqual(sashPair(all, 2), ["changes", "graph"]);
  const changesShut = sections({ open: true }, { open: false }, { open: true });
  assert.deepEqual(sashPair(changesShut, 1), ["repos", "graph"]);
  assert.deepEqual(sashPair(changesShut, 2), ["repos", "graph"]);
});

test("no sash above the first section or without an open section on both sides", () => {
  assert.equal(sashPair(sections({ open: true }, { open: true }, { open: true }), 0), null);
  assert.equal(sashPair(sections({ open: false }, { open: true }, { open: true }), 1), null);
  assert.equal(sashPair(sections({ open: true }, { open: true }, { open: false }), 2), null);
});

test("dragging a sash moves height between its two sections", () => {
  const heights = { repos: 110, changes: 290 }, mins = { repos: 22, changes: 94 };
  assert.deepEqual(dragSash(heights, mins, ["repos", "changes"], 50), { repos: 160, changes: 240 });
  assert.deepEqual(dragSash(heights, mins, ["repos", "changes"], -30), { repos: 80, changes: 320 });
});

test("a drag stops at either section's minimum", () => {
  const heights = { repos: 110, changes: 290 }, mins = { repos: 22, changes: 94 };
  assert.deepEqual(dragSash(heights, mins, ["repos", "changes"], 1000), { repos: 306, changes: 94 });
  assert.deepEqual(dragSash(heights, mins, ["repos", "changes"], -1000), { repos: 22, changes: 378 });
});
