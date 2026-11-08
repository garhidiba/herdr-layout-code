// node --test mods/vscode-explorer/test/core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { engineOf, createCore, relevant, stampOf, stale, FULL_EVERY } from "../core.js";

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

test("the same call while one runs is made once and both get its result", async () => {
  let release;
  const f = fake({ binary: (args) => (args[0] !== "tree" ? ok(args[0] === "--version" ? { version: "1.0.0" } : {}) : new Promise((r) => { release = () => r(ok({ args })); })) });
  await f.core(["repos", "/p"]); // the version check, out of the way
  const runs = f.runs.length;
  const a = f.core(["tree", "/p"]), b = f.core(["tree", "/p"]);
  while (!release) await new Promise((r) => setTimeout(r, 1));
  release();
  assert.deepEqual(await a, { args: ["tree", "/p"] });
  assert.equal(await b, await a);
  assert.equal(f.runs.length, runs + 1);
  // Once it is done, the next one runs again.
  f.binary = (args) => ok({ again: args });
  assert.deepEqual(await f.core(["tree", "/p"]), { again: ["tree", "/p"] });
});

test("a watch batch counts unless every path is one VS Code's watcher leaves out", () => {
  assert.equal(relevant(["/p/.git/objects/ab/cdef", "/p/node_modules/react/index.js", "/p/.hg/store/data"]), false);
  assert.equal(relevant(["/p/.git/objects/ab/cdef", "/p/.git/index"]), true);
  assert.equal(relevant(["/p/node_modules/new-package"]), true); // a package added or removed shows in the tree
  assert.equal(relevant(["/p/src/a.ts"]), true);
  assert.equal(relevant([]), true);
  assert.equal(relevant(undefined), true);
});

test("a stamp is one stat of the paths in the platform's format, and none on Windows", async () => {
  const runs = [], exec = async (cmd, args) => { runs.push([cmd, ...args]); return { code: 1, stdout: "/p 1.0 1.0 64 7\n", stderr: "/gone: missing" }; };
  assert.equal(await stampOf(exec, ["/p", "/gone"], "macos"), "/p 1.0 1.0 64 7\n");
  assert.deepEqual(runs[0], ["stat", "-L", "-f", "%N %Fm %Fc %z %i", "--", "/p", "/gone"]);
  await stampOf(exec, ["/p"], "linux");
  assert.deepEqual(runs[1], ["stat", "-L", "-c", "%n %y %z %s %i", "--", "/p"]);
  assert.equal(await stampOf(exec, ["/p"], "windows"), null);
  assert.equal(await stampOf(async () => { throw new Error("no stat"); }, ["/p"], "linux"), null);
  assert.equal(runs.length, 2);
});

test("a watched panel reads again only when its stamp moved or 5 minutes passed", async () => {
  const at = 1e12, stamp = (s) => async () => s;
  assert.equal(await stale(null, stamp("a"), at), true); // never read
  assert.equal(await stale({ stamp: "a", at }, stamp("a"), at + 10000), false);
  assert.equal(await stale({ stamp: "a", at }, stamp("b"), at + 10000), true);
  assert.equal(await stale({ stamp: "a", at }, stamp(null), at + 10000), true); // no stat: read as before
  assert.equal(await stale({ stamp: null, at }, stamp(null), at + 10000), true);
  let statted = false;
  assert.equal(await stale({ stamp: "a", at }, async () => { statted = true; return "a"; }, at + FULL_EVERY), true);
  assert.equal(statted, false);
});
