// node --test mods/vscode-settings/test/settings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, parse, normalize, coreEngine, withSetting, withDefaults, serialize, updateFile, stepDelay, coreStatus } from "../settings.js";

// An in-memory file with writeTextFile's contract: writes only when `expected` still matches.
function memoryFile(text, { raceOnce = null } = {}) {
  const f = { text, writes: 0 };
  f.io = {
    read: async () => f.text,
    write: async (next, expected) => {
      if (raceOnce) { f.text = raceOnce; raceOnce = null; }
      if (expected !== f.text) throw new Error("stale");
      f.text = next; f.writes++;
    },
  };
  return f;
}

test("a missing or empty file means every default, engine js", () => {
  assert.deepEqual(normalize(parse(null)), DEFAULTS);
  assert.deepEqual(normalize(parse("  ")), DEFAULTS);
  assert.equal(coreEngine({}), "js");
  assert.equal(coreEngine({ "core.engine": "rust" }), "rust");
  assert.equal(coreEngine({ "core.engine": "go" }), "js");
});

test("comments and trailing commas are read; a non-object file is refused", () => {
  assert.equal(normalize(parse('{\n // c\n "editor.tabSize": 2, /* x */\n}'))["editor.tabSize"], 2);
  assert.throws(() => parse("[1]"));
  assert.throws(() => parse("{ broken"));
});

test("invalid values fall back to the default, numbers are clamped", () => {
  const v = normalize({ "files.autoSave": "sometimes", "files.autoSaveDelay": 99999, "editor.tabSize": 0, "editor.insertSpaces": "yes" });
  assert.equal(v["files.autoSave"], "off");
  assert.equal(v["files.autoSaveDelay"], 3600);
  assert.equal(v["editor.tabSize"], 1);
  assert.equal(v["editor.insertSpaces"], true);
  assert.equal(normalize({ "files.autoSaveDelay": 0 })["files.autoSaveDelay"], 0.1);
  assert.equal(normalize({ "editor.tabSize": 2.5 })["editor.tabSize"], 4);
});

test("writing a setting keeps unknown keys and rejects invalid values", () => {
  const raw = { "workbench.colorTheme": "x", "files.autoSave": "off" };
  assert.deepEqual(withSetting(raw, "files.autoSaveDelay", "2.5"), { ...raw, "files.autoSaveDelay": 2.5 });
  assert.throws(() => withSetting(raw, "core.engine", "go"));
  assert.throws(() => withSetting(raw, "files.autoSaveDelay", "abc"));
  assert.deepEqual(withDefaults({ "my.key": 1, "editor.tabSize": 8 }), { "my.key": 1, ...DEFAULTS });
});

test("update writes valid JSON, keeps unknown keys and creates a missing file", async () => {
  const f = memoryFile('// mine\n{ "my.key": [1, 2], "editor.tabSize": 2, }');
  const v = await updateFile(f.io, (raw) => withSetting(raw, "core.engine", "rust"));
  assert.equal(v["core.engine"], "rust");
  assert.deepEqual(JSON.parse(f.text), { "my.key": [1, 2], "editor.tabSize": 2, "core.engine": "rust" });
  const empty = memoryFile(null);
  await updateFile(empty.io, (raw) => withSetting(raw, "editor.tabSize", 3));
  assert.equal(empty.text, serialize({ "editor.tabSize": 3 }));
});

test("a concurrent edit is re-read and merged once, never clobbered", async () => {
  const f = memoryFile('{"a": 1}', { raceOnce: '{"a": 1, "b": 2}' });
  await updateFile(f.io, (raw) => withSetting(raw, "editor.formatOnSave", true));
  assert.deepEqual(JSON.parse(f.text), { a: 1, b: 2, "editor.formatOnSave": true });
  const broken = memoryFile("{ nope");
  await assert.rejects(updateFile(broken.io, (raw) => raw));
  assert.equal(broken.writes, 0);
});

test("delay steps by tenths below a second and whole seconds above, within range", () => {
  assert.equal(stepDelay(1, 1), 2);
  assert.equal(stepDelay(1, -1), 0.9);
  assert.equal(stepDelay(0.5, 1), 0.6);
  assert.equal(stepDelay(0.1, -1), 0.1);
  assert.equal(stepDelay(3600, 1), 3600);
  assert.equal(stepDelay(2.5, -1), 1.5);
});

test("the Rust core status reads its version", () => {
  assert.equal(coreStatus(null), "Rust core: not built");
  assert.equal(coreStatus("vscode-core 0.1.0\n"), "Rust core: built (v0.1.0)");
  assert.equal(coreStatus("ok"), "Rust core: built");
});
