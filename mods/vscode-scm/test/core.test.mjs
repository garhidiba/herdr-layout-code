// node --test mods/vscode-scm/test/core.test.mjs
// core.js is the same file in vscode-explorer (mods can't import each other's files); its tests are there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Source Control's core.js is the Explorer's", () => {
  const read = (mod) => readFileSync(new URL(`../../${mod}/core.js`, import.meta.url), "utf8");
  assert.equal(read("vscode-scm"), read("vscode-explorer"));
});
