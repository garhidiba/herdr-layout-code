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

test("a paste and a drop answer where each copy went, so the tree can show it", async () => {
  const d = tmp(), { ops } = machine(null), to = join(d, "to");
  mkdirSync(to);
  writeFileSync(join(d, "a.txt"), "a");
  assert.deepEqual(await ops.drop([join(d, "a.txt"), join(d, "a.txt")], to), [join(to, "a.txt"), join(to, "a copy.txt")]);
  assert.equal(await ops.paste({ path: join(to, "a.txt"), dir: false, cut: true, on: null }, to), null, "cut into its own folder");
  rmSync(d, { recursive: true });
});

test("a dragged item moves into a folder under its own name, never over another, never into itself", async () => {
  const d = tmp(), { ops } = machine("box"), to = join(d, "to");
  mkdirSync(join(to, "sub"), { recursive: true });
  writeFileSync(join(d, "a b.txt"), "new");
  assert.equal(await ops.moveInto(join(d, "a b.txt"), to), join(to, "a b.txt"));
  assert.ok(!existsSync(join(d, "a b.txt")));
  writeFileSync(join(d, "a b.txt"), "other");
  await assert.rejects(ops.moveInto(join(d, "a b.txt"), to), /already exists in to/);
  assert.equal(readFileSync(join(to, "a b.txt"), "utf8"), "new");
  assert.equal(readFileSync(join(d, "a b.txt"), "utf8"), "other");
  assert.equal(await ops.moveInto(join(to, "a b.txt"), to), null, "already there: nothing happens");
  await assert.rejects(ops.moveInto(to, join(to, "sub")), /into itself/);
  await assert.rejects(ops.moveInto(to, to), /into itself/);
  rmSync(d, { recursive: true });
});

test("a dangling link counts as there: its name is taken", async () => {
  const d = tmp(), { ops } = machine(null);
  spawnSync("ln", ["-s", join(d, "gone"), join(d, "link")]);
  assert.equal(await ops.exists(join(d, "link")), true);
  assert.equal(await ops.exists(join(d, "gone")), false);
  rmSync(d, { recursive: true });
});

// Herdr's hc() for a drop onto "box": `hc run` runs the upload here at once with a stand-in `hc` (found through $HOME,
// as the script's PATH puts it) that logs each --on and runs `hc exec`'s program here; `hc wait` says it ended on the
// second ask, as a long upload would.
function uploader(d, beforeRun = () => {}) {
  const bin = join(d, "home", ".local", "bin"), log = join(d, "on.log"), seen = [];
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hc"), `#!/bin/sh
[ "$1" = exec ] || exit 9; shift
while :; do case $1 in --on) echo "$2" >> "${log}"; shift 2;; --timeout) shift 2;; -i) shift;; --) shift; break;; *) exit 9;; esac; done
exec "$@"
`);
  chmodSync(join(bin, "hc"), 0o755);
  let done, waits = 0;
  const hc = async (args) => {
    seen.push(args[0]);
    if (args[0] === "run") {
      beforeRun();
      const argv = args.slice(args.indexOf("--") + 1);
      done = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: { ...process.env, HOME: join(d, "home"), PATH: "/usr/bin:/bin" } });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "wait") return { code: 0, stdout: JSON.stringify(++waits < 2 ? { ended: false } : { ended: true, exit_code: done.status }), stderr: "" };
    if (args[0] === "read") return { code: 0, stdout: `${done.stdout}${done.stderr}\n\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { ops: createOps(runHere(), "box", hc), log, seen };
}

test("files and folders dropped onto another machine's tree upload under free names, executable bits kept", async () => {
  const d = tmp(), { ops, log, seen } = uploader(d), to = join(d, "to"), src = join(d, "src");
  mkdirSync(to); mkdirSync(join(src, "-dir", "sub"), { recursive: true });
  writeFileSync(join(src, `it's "한글" $x.txt`), "new");
  writeFileSync(join(to, `it's "한글" $x.txt`), "old");
  writeFileSync(join(src, "-dir", "sub", "run.sh"), "#!/bin/sh\n");
  chmodSync(join(src, "-dir", "sub", "run.sh"), 0o755);
  const copies = await ops.drop([join(src, `it's "한글" $x.txt`), join(src, "-dir"), join(src, "-dir")], to);
  assert.deepEqual(copies, [join(to, `it's "한글" $x copy.txt`), join(to, "-dir"), join(to, "-dir copy")]);
  assert.equal(readFileSync(join(to, `it's "한글" $x.txt`), "utf8"), "old");
  assert.equal(readFileSync(join(to, `it's "한글" $x copy.txt`), "utf8"), "new");
  assert.ok(spawnSync("test", ["-x", join(to, "-dir copy", "sub", "run.sh")]).status === 0);
  assert.ok(readFileSync(log, "utf8").trim().split("\n").every(m => m === "box"));
  assert.deepEqual(spawnSync("ls", ["-A", to], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort(),
    [`it's "한글" $x copy.txt`, `it's "한글" $x.txt`, "-dir", "-dir copy"].sort(), "no temp folder left behind");
  assert.deepEqual(seen, ["run", "wait", "wait", "rm"]);
  rmSync(d, { recursive: true });
});

test("an upload never replaces an entry that appeared meanwhile, and says why it failed", async () => {
  const d = tmp(), to = join(d, "to");
  // the free name is picked first; an entry of that name shows up before the upload lands
  const { ops } = uploader(d, () => writeFileSync(join(to, "a.txt"), "old"));
  mkdirSync(to);
  writeFileSync(join(d, "a.txt"), "new");
  await assert.rejects(ops.drop([join(d, "a.txt")], to), /Upload to box failed: a.txt already exists/);
  assert.equal(readFileSync(join(to, "a.txt"), "utf8"), "old");
  assert.deepEqual(spawnSync("ls", ["-A", to], { encoding: "utf8" }).stdout, "a.txt\n", "no temp folder left behind");
  rmSync(d, { recursive: true });
});

test("a machine that can't be reached rejects as unreachable; locally the error passes through as is", async () => {
  const down = createOps(async () => { throw new Error("cannot reach box"); }, "box");
  await assert.rejects(down.mkdir("/x"), (e) => e.unreachable === true && e.message === "box is offline — turn it on or start Herdr there, then it reconnects.");
  const odd = createOps(async () => { throw new Error("disk full"); }, "box");
  await assert.rejects(odd.mkdir("/x"), (e) => e.unreachable === true && e.message === "box: disk full");
  const broken = createOps(async () => { throw new Error("no sh"); }, null);
  await assert.rejects(broken.mkdir("/x"), (e) => !e.unreachable && e.message === "no sh");
});
