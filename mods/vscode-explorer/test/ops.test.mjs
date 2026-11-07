// node --test mods/vscode-explorer/test/ops.test.mjs
// The menu's file operations against a stand-in machine: `exec` runs the commands here, in a temp folder, and records
// which machine each was meant for. Nothing touches a real remote.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOps } from "../ops.js";

const runHere = (path = process.env.PATH) => async (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, PATH: path } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
function machine(on = "box") {
  const calls = [], here = runHere();
  const exec = (cmd, args, ...opts) => { calls.push({ cmd, opts }); return here(cmd, args); };
  return { ops: createOps(exec, on), calls };
}
const tmp = () => mkdtempSync(join(tmpdir(), "explorer-ops-"));

test("commands run on the space's machine, and locally exactly as before (no options)", async () => {
  const d = tmp(), remote = machine("box"), local = machine(null);
  await remote.ops.exists(d);
  await local.ops.exists(d);
  assert.deepEqual(remote.calls[0].opts, [{ on: "box" }]);
  assert.deepEqual(local.calls[0].opts, []);
  rmSync(d, { recursive: true });
});

test("paths with quotes, spaces, dollars and dashes stay arguments", async () => {
  const d = tmp(), { ops } = machine();
  const odd = join(d, `-x it's "$HOME" ; touch pwned`);
  await ops.newFile(odd);
  assert.ok(existsSync(odd));
  await ops.mkdir(join(d, "$(touch pwned)"));
  assert.ok(existsSync(join(d, "$(touch pwned)")));
  assert.ok(!existsSync(join(d, "pwned")) && !existsSync("pwned"));
  rmSync(d, { recursive: true });
});

test("new file never replaces one; mkdir and rename never overwrite", async () => {
  const d = tmp(), { ops } = machine(), f = join(d, "a.txt");
  writeFileSync(f, "keep");
  await assert.rejects(ops.newFile(f));
  assert.equal(readFileSync(f, "utf8"), "keep");
  mkdirSync(join(d, "dir"));
  await assert.rejects(ops.mkdir(join(d, "dir")));
  writeFileSync(join(d, "b.txt"), "b");
  await ops.move(join(d, "b.txt"), f); // mv -n
  assert.equal(readFileSync(f, "utf8"), "keep");
  await ops.move(join(d, "b.txt"), join(d, "c.txt"));
  assert.equal(readFileSync(join(d, "c.txt"), "utf8"), "b");
  rmSync(d, { recursive: true });
});

test("delete uses the machine's trash when it has one, else removes for good", async () => {
  const d = tmp(), bin = join(d, "bin"), log = join(d, "trashed");
  mkdirSync(bin);
  writeFileSync(join(bin, "trash"), `#!/bin/sh\necho "$1" >> "${log}"\n`);
  chmodSync(join(bin, "trash"), 0o755);
  const f = join(d, "a b.txt");
  writeFileSync(f, "x");
  await createOps(runHere(`${bin}:/usr/bin:/bin`), "box").remove(f);
  assert.equal(readFileSync(log, "utf8"), `${f}\n`);
  mkdirSync(join(d, "folder"));
  writeFileSync(join(d, "folder", "x"), "x");
  await createOps(runHere("/usr/bin:/bin"), "box").remove(join(d, "folder")); // no trash, no gio here
  assert.ok(!existsSync(join(d, "folder")));
  rmSync(d, { recursive: true });
});

test("paste copies under a free name, moves on cut, and stays on one machine", async () => {
  const d = tmp(), { ops } = machine("box");
  mkdirSync(join(d, "to"));
  writeFileSync(join(d, "a.txt"), "a");
  writeFileSync(join(d, "to", "a.txt"), "old");
  await ops.paste({ path: join(d, "a.txt"), dir: false, cut: false, on: "box" }, join(d, "to"));
  assert.equal(readFileSync(join(d, "to", "a copy.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(d, "to", "a.txt"), "utf8"), "old");
  await ops.paste({ path: join(d, "a.txt"), dir: false, cut: true, on: "box" }, join(d, "to"));
  assert.ok(!existsSync(join(d, "a.txt")) && existsSync(join(d, "to", "a copy 2.txt")));
  await assert.rejects(ops.paste({ path: join(d, "to"), dir: true, cut: false, on: "box" }, join(d, "to")), /into itself/);
  await assert.rejects(ops.paste({ path: join(d, "x"), dir: false, cut: false, on: null }, join(d, "to")), /between machines/);
  await assert.rejects(ops.paste({ path: join(d, "x"), dir: false, cut: false, on: "other" }, join(d, "to")), /between machines/);
  rmSync(d, { recursive: true });
});

test("dropped files and folders are copied in under free names, never moved or overwritten", async () => {
  const d = tmp(), { ops } = machine(null), to = join(d, "to"), odd = join(d, `it's "한글" $x.txt`);
  mkdirSync(to); mkdirSync(join(d, "my.dir"));
  writeFileSync(join(d, "my.dir", "x"), "x");
  writeFileSync(odd, "new");
  writeFileSync(join(to, `it's "한글" $x.txt`), "old");
  await ops.drop([odd, join(d, "my.dir")], to);
  assert.equal(readFileSync(join(to, `it's "한글" $x.txt`), "utf8"), "old");
  assert.equal(readFileSync(join(to, `it's "한글" $x copy.txt`), "utf8"), "new");
  assert.equal(readFileSync(join(to, "my.dir", "x"), "utf8"), "x");
  assert.ok(existsSync(odd) && existsSync(join(d, "my.dir")));
  await ops.drop([join(d, "my.dir")], to);
  assert.ok(existsSync(join(to, "my.dir copy", "x"))); // a folder keeps its whole name
  rmSync(d, { recursive: true });
});

test("a drop onto another machine's tree is refused before anything is copied", async () => {
  const { ops, calls } = machine("box");
  await assert.rejects(ops.drop(["/local/a.txt"], "/remote/to"), /not supported yet/);
  assert.equal(calls.length, 0);
});

test("a machine that can't be reached rejects as unreachable; locally the error passes through as is", async () => {
  const down = createOps(async () => { throw new Error("cannot reach box"); }, "box");
  await assert.rejects(down.mkdir("/x"), (e) => e.unreachable === true && e.message === "box: cannot reach box");
  const broken = createOps(async () => { throw new Error("no sh"); }, null);
  await assert.rejects(broken.mkdir("/x"), (e) => !e.unreachable && e.message === "no sh");
});
