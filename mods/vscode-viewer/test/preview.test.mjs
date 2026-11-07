// node --test mods/vscode-viewer/test/preview.test.mjs
// Fetching another machine's file for a preview, against a stand-in machine: a stand-in `hc` (found through $HOME, as
// FETCH's PATH puts it) logs each --on and runs `hc exec`'s program here, keeping only the first 8 MiB of its output as
// the real one does. Nothing touches a real remote.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, chmodSync, utimesSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pieces, fetchFile, overflow, prune, REMOTE_MAX } from "../preview.js";

function machine() {
  const d = mkdtempSync(join(tmpdir(), "viewer-preview-")), bin = join(d, "home", ".local", "bin"), log = join(d, "on.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hc"), `#!/bin/sh
[ "$1" = exec ] || exit 9; shift
while :; do case $1 in --on) echo "$2" >> "${log}"; shift 2;; --) shift; break;; *) exit 9;; esac; done
"$@" | head -c 8388608
`);
  chmodSync(join(bin, "hc"), 0o755);
  const exec = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, HOME: join(d, "home"), PATH: "/usr/bin:/bin" } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { d, exec, ons: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

test("a file is fetched in 4 MB pieces, each well under hc exec's 8 MiB output", () => {
  assert.deepEqual(pieces(0), []);
  assert.deepEqual(pieces(1), [0]);
  assert.deepEqual(pieces(4e6), [0]);
  assert.deepEqual(pieces(4e6 + 1), [0, 4]);
  assert.deepEqual(pieces(12e6), [0, 4, 8]);
});

test("a binary file larger than one exec's output arrives byte for byte, from the space's machine", async () => {
  const { d, exec, ons } = machine(), src = join(d, `it's "한글" $x.mp4`), out = join(d, "out.mp4"), data = randomBytes(9_500_000);
  writeFileSync(src, data);
  const seen = [];
  await fetchFile(exec, "box", src, out, data.length, p => seen.push(p));
  assert.ok(readFileSync(out).equals(data));
  assert.deepEqual(ons(), ["box", "box", "box"]);
  assert.equal(seen.at(-1), 1);
  assert.ok(!existsSync(`${out}.part`));
  rmSync(d, { recursive: true });
});

test("a file that changed size while fetching, or can't be read, leaves nothing behind and says why", async () => {
  const { d, exec } = machine(), src = join(d, "a.png"), out = join(d, "out.png");
  writeFileSync(src, "short");
  await assert.rejects(fetchFile(exec, "box", src, out, 50), /changed on box while fetching/);
  await assert.rejects(fetchFile(exec, "box", join(d, "gone.png"), out, 5), /Cannot fetch this file from box|changed on box/);
  assert.deepEqual(readdirSync(d).filter(n => n.startsWith("out")), []);
  rmSync(d, { recursive: true });
});

test("files over the size cap are refused before anything is fetched", async () => {
  const { d, exec, ons } = machine();
  await assert.rejects(fetchFile(exec, "box", join(d, "big.mov"), join(d, "out"), REMOTE_MAX + 1), /Larger than 200 MB · too big to preview from box/);
  assert.deepEqual(ons(), []);
  rmSync(d, { recursive: true });
});

test("the cache drops its oldest files until it fits, never the one on screen or one still fetching", () => {
  const f = (name, mtime, size) => ({ name, mtime, size });
  const files = [f("new", 3, 40), f("old", 1, 40), f("shown", 0, 40), f("x.part", 0, 40), f("mid", 2, 40)];
  assert.deepEqual(overflow(files, 120, ["shown"]), ["old", "mid"]);
  assert.deepEqual(overflow(files, 1000, ["shown"]), []);
});

test("pruning the cache folder deletes only what overflow names", async () => {
  const { d, exec } = machine(), dir = join(d, "cache");
  mkdirSync(dir);
  for (const [n, t] of [["a-1-1.png", 1000], ["b-1-1.png", 2000], ["c-1-1.mp4", 3000]]) {
    writeFileSync(join(dir, n), Buffer.alloc(100)); utimesSync(join(dir, n), t, t);
  }
  await prune(exec, dir, ["a-1-1.png"], 200);
  assert.deepEqual(readdirSync(dir).sort(), ["a-1-1.png", "c-1-1.mp4"]);
  rmSync(d, { recursive: true });
});
