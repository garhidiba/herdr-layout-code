import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { friendlyError } from "../offline.js";

const RAW = `Error: 'herdr.exec': win-amd64 is unreachable: cannot reach win-amd64: {"error":{"hint":"open Herdr on that Windows machine","kind":"unavailable","message":"refusing to start an elevated Windows core over SSH"}}`;
const SHORT = "win-amd64 is offline — turn it on or start Herdr there, then it reconnects.";

test("an unreachable machine's raw Herdr error becomes one short line naming the machine", () => {
  assert.equal(friendlyError(new Error(RAW.slice(7))), SHORT);
  assert.equal(friendlyError(RAW), SHORT);
});

test("the ops toast prefix and a bare 'cannot reach' both find the machine", () => {
  assert.equal(friendlyError(new Error("box: cannot reach box")), "box is offline — turn it on or start Herdr there, then it reconnects.");
});

test("other errors keep their text", () => {
  assert.equal(friendlyError(new Error("Could not delete")), "Could not delete");
  assert.equal(friendlyError("Error: boom"), "Error: boom");
  assert.equal(friendlyError(undefined), "undefined");
});

test("the per-mod copies stay identical", () => {
  const read = (m) => readFileSync(new URL(`../../${m}/offline.js`, import.meta.url), "utf8");
  assert.equal(read("vscode-scm"), read("vscode-explorer"));
  assert.equal(read("vscode-spaces"), read("vscode-explorer"));
});
