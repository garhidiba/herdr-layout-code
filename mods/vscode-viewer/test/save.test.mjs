// node --test mods/vscode-viewer/test/save.test.mjs
// Saving to another machine, against a stand-in machine: a stand-in `hc` (found through $HOME, as SEND's PATH puts it)
// logs its flags and runs `hc exec -i`'s program here with its stdin. Nothing touches a real remote.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveArgv, saveRemote, utf8Length, windowsSave, isWindowsPath, psQuote, SAVE_UNIX } from "../save.js";

function machine({ cut = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), "viewer-save-")), bin = join(d, "home", ".local", "bin"), log = join(d, "hc.log");
  mkdirSync(bin, { recursive: true });
  // `cut`: the transfer stops after 3 bytes.
  writeFileSync(join(bin, "hc"), `#!/bin/sh
echo "$*" >> "${log}"
[ "$1" = exec ] || exit 9; shift
while :; do case $1 in -i) shift;; --on|--timeout) shift 2;; --) shift; break;; *) exit 9;; esac; done
${cut ? 'head -c 3 | "$@"' : '"$@"'}
`);
  chmodSync(join(bin, "hc"), 0o755);
  const exec = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, HOME: join(d, "home"), PATH: "/usr/bin:/bin" } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const writeTextFile = async (path, text, expected) => {
    assert.equal(expected, null);
    assert.equal(existsSync(path), false, "a fresh temp file");
    writeFileSync(path, text, "utf8");
  };
  return { d, exec, writeTextFile, log: () => readFileSync(log, "utf8") };
}

test("the buffer lands byte for byte: UTF-8, CRLF, no trailing newline, a quote-laden path", async () => {
  const m = machine(), file = join(m.d, `it's "a" $file.csv`), tmp = join(m.d, "x.save.part");
  writeFileSync(file, "old\n");
  chmodSync(file, 0o640);
  const text = "이름,값\r\n\"a,b\",😀\r\nend";
  await saveRemote(m.exec, m.writeTextFile, { on: "win-amd64", path: file, text, tmp });
  assert.equal(readFileSync(file, "utf8"), text);
  assert.equal(statSync(file).mode & 0o777, 0o640, "written into the same file");
  assert.equal(existsSync(tmp), false, "the local copy is removed");
  assert.match(m.log(), /^exec -i --on win-amd64 --timeout \d+ -- sh -c /);
});

test("a cut-off transfer leaves the file as it was and rejects with why", async () => {
  const m = machine({ cut: true }), file = join(m.d, "a.csv"), tmp = join(m.d, "x.save.part");
  writeFileSync(file, "keep me\n");
  await assert.rejects(saveRemote(m.exec, m.writeTextFile, { on: "box", path: file, text: "new text", tmp }), /Cannot save to box: only 3 of 8 bytes arrived/);
  assert.equal(readFileSync(file, "utf8"), "keep me\n");
  assert.equal(existsSync(tmp), false);
});

test("a write that fails there rejects (a missing folder)", async () => {
  const m = machine(), tmp = join(m.d, "x.save.part");
  await assert.rejects(saveRemote(m.exec, m.writeTextFile, { on: "box", path: join(m.d, "nope", "a.csv"), text: "x", tmp }), /Cannot save to box/);
});

test("Unix paths get the sh writer, the path only as an argument", () => {
  const argv = saveArgv("/home/me/$(rm -rf).csv", 12);
  assert.deepEqual(argv, ["sh", "-c", SAVE_UNIX, "herdr-save", "/home/me/$(rm -rf).csv", "12"]);
  assert.equal(SAVE_UNIX.includes("rm -rf)"), false);
});

test("Windows paths get the PowerShell writer, -EncodedCommand of a validated single-quoted path", () => {
  for (const p of ["C:\\project\\refine-mods\\a.csv", "C:/project/refine-mods/a.csv", "\\\\server\\share\\a.csv", "d:\\x.tsv"]) assert.ok(isWindowsPath(p), p);
  for (const p of ["/c/project/a.csv", "/home/me/a.csv", "relative\\a.csv"]) assert.equal(isWindowsPath(p), false, p);
  const path = "C:\\project\\it's\\a.csv", argv = saveArgv(path, 42);
  assert.deepEqual(argv.slice(0, 4), ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(argv[4], "base64").toString("utf16le");
  assert.equal(script, windowsSave(path, 42));
  assert.ok(script.includes(`[IO.File]::WriteAllBytes('C:\\project\\it''s\\a.csv', $buf.ToArray())`));
  assert.ok(script.includes("-ne 42"));
  assert.equal(psQuote("a’b"), "'a’’b'");
  assert.throws(() => windowsSave("C:\\a\nb.csv", 1));
  assert.throws(() => windowsSave("C:\\a.csv", -1));
});

test("utf8Length counts the bytes the text takes", () => {
  for (const s of ["", "abc", "\r\n", "é", "한글", "😀", "a😀b\u00a0", "\ud800x"]) assert.equal(utf8Length(s), Buffer.byteLength(s, "utf8"), JSON.stringify(s));
});
