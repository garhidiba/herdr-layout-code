// node --test mods/vscode-spaces/test/order.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { KEY, settingsOf, machineOrderOf, sortMachines, dragOrder, writeMachineOrder } from "../order.js";

const names = ["vps", "win-amd64", "mini"];

test("without the setting, other machines are listed by name", () => {
  assert.deepEqual(sortMachines(names), ["mini", "vps", "win-amd64"]);
  assert.deepEqual(sortMachines(names, machineOrderOf(settingsOf(null))), ["mini", "vps", "win-amd64"]);
});

test("machines in the setting come first, in its order; the rest follow by name", () => {
  assert.deepEqual(sortMachines(names, ["win-amd64"]), ["win-amd64", "mini", "vps"]);
  assert.deepEqual(sortMachines(names, ["vps", "win-amd64"]), ["vps", "win-amd64", "mini"]);
});

test("names in the setting that aren't machines now change nothing", () => {
  assert.deepEqual(sortMachines(names, ["gone", "win-amd64"]), ["win-amd64", "mini", "vps"]);
});

test("a setting that isn't a list of names is ignored", () => {
  for (const v of ["win-amd64", 3, null, { a: 1 }]) assert.deepEqual(machineOrderOf({ [KEY]: v }), []);
  assert.deepEqual(machineOrderOf({ [KEY]: ["win-amd64", 3, "", "win-amd64", "vps"] }), ["win-amd64", "vps"]);
  assert.deepEqual(machineOrderOf(settingsOf("{ not json")), []);
});

test("the setting is read from a settings file with comments and trailing commas", () => {
  const text = `{\n  // first\n  "spaces.machineOrder": ["win-amd64",],\n}`;
  assert.deepEqual(machineOrderOf(settingsOf(text)), ["win-amd64"]);
});

test("a header dragged down lands below the one dropped on, dragged up above it", () => {
  const shown = ["mini", "vps", "win-amd64"];
  assert.deepEqual(dragOrder([], shown, "mini", "vps"), ["vps", "mini", "win-amd64"]);
  assert.deepEqual(dragOrder([], shown, "win-amd64", "mini"), ["win-amd64", "mini", "vps"]);
});

test("dropping a header on itself or on an unknown one moves nothing", () => {
  assert.equal(dragOrder([], ["a", "b"], "a", "a"), null);
  assert.equal(dragOrder([], ["a", "b"], "a", "x"), null);
});

test("machines in the setting that aren't shown now keep their place after the shown ones", () => {
  assert.deepEqual(dragOrder(["away", "b"], ["b", "a"], "a", "b"), ["a", "b", "away"]);
});

const fakeIo = (text) => {
  const io = { text, writes: 0 };
  io.read = async () => io.text;
  io.write = async (next, expected) => {
    if (expected !== io.text) throw new Error("stale");
    io.writes++;
    io.text = next;
  };
  return io;
};

test("writing the order keeps the other keys and their order", async () => {
  const io = fakeIo(`{\n  "editor.tabSize": 2,\n  "my.key": [1]\n}\n`);
  await writeMachineOrder(io, ["win-amd64"]);
  assert.equal(io.text, `{\n  "editor.tabSize": 2,\n  "my.key": [\n    1\n  ],\n  "${KEY}": [\n    "win-amd64"\n  ]\n}\n`);
});

test("a missing settings file is created with just the order", async () => {
  const io = fakeIo(null);
  await writeMachineOrder(io, ["vps"]);
  assert.deepEqual(JSON.parse(io.text), { [KEY]: ["vps"] });
});

test("a settings file with comments or a syntax error is never overwritten", async () => {
  for (const text of [`{\n  // mine\n  "a": 1\n}`, `{ "a": 1, }`, `[]`]) {
    const io = fakeIo(text);
    await assert.rejects(writeMachineOrder(io, ["vps"]));
    assert.equal(io.text, text);
  }
});

test("an edit made meanwhile is read again, not clobbered", async () => {
  const io = fakeIo(`{ "a": 1 }`);
  const read = io.read;
  let first = true;
  io.read = async () => { const t = await read(); if (first) { first = false; io.text = `{ "a": 2 }`; } return t; };
  await writeMachineOrder(io, ["vps"]);
  assert.deepEqual(JSON.parse(io.text), { a: 2, [KEY]: ["vps"] });
});
