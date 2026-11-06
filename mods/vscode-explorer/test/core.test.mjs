// node --test mods/vscode-explorer/test/core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { engineOf, createCore } from "../core.js";

// A fake Herdr: a settings file, a binary (a function from args to { code, stdout }, or null when it isn't
// there), a clock, the shared store, and what was run and toasted.
function fake({ settings = '{ "core.engine": "rust" }', binary = (args) => ok(args[0] === "--version" ? { version: "1.0.0" } : { args }) } = {}) {
  const f = { settings, binary, t: 1e12, runs: [], toasts: [], store: {} };
  f.io = {
    appHome: () => "/home",
    readTextFile: async (path) => (path === "/home/vscode-settings.json" ? f.settings : null),
    exec: async (cmd, args) => {
      f.runs.push([cmd, ...args].join(" "));
      if (!f.binary) throw new Error(`cannot start ${cmd}: program not found`);
      return f.binary(args);
    },
    notify: (n) => f.toasts.push(n),
    shared: (k) => f.store[k], setShared: (k, v) => { f.store[k] = v; },
    now: () => f.t,
  };
  f.core = createCore(f.io);
  return f;
}
const ok = (out) => ({ code: 0, stdout: JSON.stringify(out), stderr: "" });

test("the engine is rust only when the settings file says so", () => {
  assert.equal(engineOf(null), "js");
  assert.equal(engineOf("{}"), "js");
  assert.equal(engineOf('{ "core.engine": "js" }'), "js");
  assert.equal(engineOf('// mine\n{ "core.engine": "rust", /* fast */ }'), "rust");
  assert.equal(engineOf('{ "core.engine": "go" }'), "js");
  assert.equal(engineOf("{ broken"), "js");
});

test("with the JavaScript engine the binary is never run", async () => {
  const f = fake({ settings: null });
  assert.equal(await f.core(["tree", "/p"]), null);
  assert.deepEqual(f.runs, []);
});

test("with the Rust engine a call returns the binary's JSON, after one version check", async () => {
  const f = fake();
  assert.deepEqual(await f.core(["tree", "/p"]), { args: ["tree", "/p"] });
  assert.deepEqual(await f.core(["repos", "/p"]), { args: ["repos", "/p"] });
  assert.deepEqual(f.runs, ["/home/vscode-core/vscode-core --version", "/home/vscode-core/vscode-core tree /p", "/home/vscode-core/vscode-core repos /p"]);
});

test("a remote space takes the JavaScript path", async () => {
  const f = fake();
  assert.equal(await f.core(["tree", "/p"], "box"), null);
  assert.deepEqual(f.runs, []);
});

test("a missing binary falls back to JS with one toast, and is not run again until the settings change", async () => {
  const f = fake({ binary: null });
  assert.equal(await f.core(["tree", "/p"]), null);
  f.t += 3000;
  assert.equal(await f.core(["tree", "/p"]), null);
  assert.equal(f.runs.length, 1);
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0].title, /not built/);
  assert.deepEqual(f.toasts[0].action, { name: "mod.open", args: { name: "vscode-settings" } });

  f.settings = '{ "core.engine": "rust", "editor.tabSize": 2 }';
  f.t += 3000;
  assert.equal(await f.core(["tree", "/p"]), null);
  assert.equal(f.runs.length, 2);
});

test("a build is picked up a minute later without a second toast", async () => {
  const f = fake({ binary: null });
  await f.core(["tree", "/p"]);
  f.binary = (args) => ok(args[0] === "--version" ? { version: "1.0.0" } : { built: true });
  f.t += 61000;
  assert.deepEqual(await f.core(["tree", "/p"]), { built: true });
  assert.equal(f.toasts.length, 1);
});

test("a binary of another major version is not used and asks for a rebuild", async () => {
  const f = fake({ binary: () => ok({ version: "0.1.0" }) });
  assert.equal(await f.core(["repo", "/p"]), null);
  assert.equal(f.runs.length, 1);
  assert.match(f.toasts[0].title, /out of date/);
});

test("an error for one call takes JS for that call only, without a toast", async () => {
  const f = fake({ binary: (args) => (args[0] === "--version" ? ok({ version: "1.0.0" }) : { code: 1, stdout: '{"error":"Cannot run git in /gone"}', stderr: "" }) });
  assert.equal(await f.core(["repo", "/gone"]), null);
  assert.equal(await f.core(["repo", "/gone"]), null);
  assert.equal(f.runs.length, 3);
  assert.equal(f.toasts.length, 0);
});

test("output that is not JSON counts as a broken core", async () => {
  const f = fake({ binary: (args) => (args[0] === "--version" ? ok({ version: "1.0.0" }) : { code: 0, stdout: "Segmentation fault", stderr: "" }) });
  assert.equal(await f.core(["tree", "/p"]), null);
  assert.equal(f.toasts.length, 1);
});

test("the Explorer and Source Control together show one toast", async () => {
  const a = fake({ binary: null });
  const other = createCore({ ...a.io }); // the second mod: its own state, the same Herdr
  await a.core(["tree", "/p"]);
  await other(["repos", "/p"]);
  assert.equal(a.toasts.length, 1);
});
