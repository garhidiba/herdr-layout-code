// node --test mods/vscode-explorer/test/remote.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archOf, parseInfo, parseManifest, keysOs, megabytes, rootOf, dirOf, REMOTE_INSTALL, UPLOAD, INFO, createRemote, createOpenFile, ASKED, APPROVED, INSTALL_REQUEST } from "../remote.js";

const VER = "1.0.0-0123456789ab", SUM = "a".repeat(64);
const manifestText = (arch, version = VER, sha256 = SUM) => JSON.stringify({ version, arch, sha256, size: 2843587, files: {} });

test("a machine's arch: Linux on aarch64 or x86_64 only", () => {
  assert.equal(archOf("Linux aarch64"), "aarch64");
  assert.equal(archOf("Linux arm64\n"), "aarch64");
  assert.equal(archOf("Linux x86_64"), "x86_64");
  assert.equal(archOf("Linux armv7l"), null);
  assert.equal(archOf("Darwin arm64"), null);
  assert.equal(archOf(""), null);
  assert.deepEqual(parseInfo("Linux aarch64\n/root\n"), { arch: "aarch64", home: "/root", uname: "Linux aarch64" });
  assert.equal(parseInfo("Linux x86_64\nrelative\n").home, null);
  assert.equal(rootOf("/home/ardi"), "/home/ardi/.local/share/herdr-vscode");
  assert.equal(dirOf("/root", VER), `/root/.local/share/herdr-vscode/${VER}`);
});

test("only a manifest build-remote.sh writes, for this arch, names a bundle", () => {
  assert.equal(parseManifest(manifestText("aarch64"), "aarch64").version, VER);
  assert.equal(parseManifest(manifestText("x86_64"), "aarch64"), null);
  assert.equal(parseManifest(manifestText("aarch64", "../../etc"), "aarch64"), null);
  assert.equal(parseManifest(manifestText("aarch64", VER, "zz"), "aarch64"), null);
  assert.equal(parseManifest("{ broken", "aarch64"), null);
  assert.equal(parseManifest(null, "aarch64"), null);
  assert.equal(megabytes(2843587), "2.8 MB");
  assert.deepEqual(["macos", "windows", "linux", null].map(keysOs), ["mac", "win", "linux", "linux"]);
});

// A real install with this computer's sh: a fake bundle (vsedit prints its api) under a temp $HOME.
function bundle(dir, api = "1") {
  const b = join(dir, "b");
  mkdirSync(join(b, "vscode"), { recursive: true });
  writeFileSync(join(b, "vsedit"), `#!/bin/sh\necho ${api}\n`);
  writeFileSync(join(b, "vscode-core"), "#!/bin/sh\necho 1.0.0\n");
  writeFileSync(join(b, "vsedit.sh"), "echo launcher\n");
  const tgz = join(dir, "bundle.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", b, "."]);
  return { tgz, sum: createHash("sha256").update(readFileSync(tgz)).digest("hex") };
}
const install = (root, ver, sum, tgz, manifest = "{}") =>
  spawnSync("sh", ["-c", REMOTE_INSTALL, "herdr-vscode", root, ver, sum, manifest], { input: readFileSync(tgz), encoding: "utf8" });

test("the install checks the bundle, makes it runnable and swaps the version folder in whole, once", () => {
  const home = mkdtempSync(join(tmpdir(), "remote-")), root = rootOf(home), { tgz, sum } = bundle(home);
  const r = install(root, VER, sum, tgz, '{"version": "it\'s"}');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "installed");
  assert.equal(readFileSync(join(root, VER, "manifest.json"), "utf8"), '{"version": "it\'s"}\n');
  assert.equal(execFileSync(join(root, VER, "vsedit"), { encoding: "utf8" }).trim(), "1");
  assert.equal(install(root, VER, sum, tgz).stdout.trim(), "current"); // idempotent
  assert.deepEqual(readdirSync(root).filter(n => n.startsWith(".")), []); // no temp folder left
});

test("a damaged bundle, an editor that doesn't run, or a folder outside the root installs nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "remote-")), root = rootOf(home), { tgz, sum } = bundle(home);
  const bad = install(root, VER, "b".repeat(64), tgz);
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /damaged/);
  const other = mkdtempSync(join(tmpdir(), "remote-")), broken = bundle(other, "2");
  assert.equal(install(root, VER, broken.sum, broken.tgz).status, 4);
  assert.equal(install(join(home, "elsewhere"), VER, sum, tgz).status, 2);
  assert.equal(install(root, "../x", sum, tgz).status, 2);
  assert.ok(!existsSync(join(root, VER)));
  assert.deepEqual(readdirSync(root), []);
});

test("an install keeps the new version and the one before it", () => {
  const home = mkdtempSync(join(tmpdir(), "remote-")), root = rootOf(home), { tgz, sum } = bundle(home);
  const vers = ["1.0.0-000000000001", "1.0.0-000000000002", "1.0.0-000000000003"];
  vers.forEach((v, i) => {
    assert.equal(install(root, v, sum, tgz).status, 0);
    utimesSync(join(root, v), 1e9 + i * 100, 1e9 + i * 100); // install order, whatever the clock's resolution
  });
  mkdirSync(join(root, "backups"));
  assert.equal(install(root, "1.0.0-000000000004", sum, tgz).status, 0);
  assert.deepEqual(readdirSync(root).sort(), ["1.0.0-000000000003", "1.0.0-000000000004", "backups"]);
});

test("the upload sends the bundle through hc exec -i --on with every value as its own argument", () => {
  // a fake hc on the PATH UPLOAD adds ($HOME/.local/bin): `hc exec -i --on <m> --timeout <s> -- <argv>` runs argv here
  const home = mkdtempSync(join(tmpdir(), "remote me-")), bin = join(home, ".local/bin"), log = join(home, "hc.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nprintf '%s\\n' "$*" > '${log}'\n[ "$1 $2 $3" = "exec -i --on" ] || exit 9\nshift 6\nexec "$@"\n`);
  chmodSync(join(bin, "hc"), 0o755);
  const { tgz, sum } = bundle(home), root = rootOf(home);
  const r = spawnSync("sh", ["-c", UPLOAD, "herdr-vscode", "orange pi", REMOTE_INSTALL, root, VER, sum, `{"a": "b c"}`, tgz], { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(log, "utf8"), /^exec -i --on orange pi --timeout 300 -- sh -c /);
  assert.equal(readFileSync(join(root, VER, "manifest.json"), "utf8"), '{"a": "b c"}\n');
});

// A fake Herdr for createRemote: machines (machine → uname/home, or an Error), installed folders on them, local files.
function fake({ machines = { box: "Linux aarch64\n/root\n" }, files = {}, installed = [], approved = {}, uploadCode = 0 } = {}) {
  const f = { runs: [], toasts: [], asks: [], store: { [APPROVED]: approved }, t: 1e12 };
  const local = { "/h/vscode-core/remote/aarch64/manifest.json": manifestText("aarch64"), "/h/vscode-settings.json": '{"files.autoSave": "off"}', ...files };
  f.remote = createRemote({
    appHome: () => "/h",
    platform: () => "macos",
    readTextFile: async (p) => local[p] ?? null,
    exec: async (cmd, args, opts = {}) => {
      f.runs.push({ cmd, args, on: opts.on ?? null });
      if (opts.on) {
        const m = machines[opts.on];
        if (m instanceof Error) throw m;
        if (args[1] === INFO) return { code: 0, stdout: m, stderr: "" };
        if (cmd === "test") return { code: installed.includes(args[1]) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[1] === UPLOAD) return { code: uploadCode, stdout: "installed\n", stderr: uploadCode ? "the bundle arrived damaged" : "" };
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    },
    notify: (n) => f.toasts.push(n),
    shared: (k) => f.store[k], setShared: (k, v) => { f.store[k] = v; },
    confirm: (machine, size) => f.asks.push([machine, size]),
    now: () => f.t,
  });
  return f;
}
const launcher = `/root/.local/share/herdr-vscode/${VER}/vsedit.sh`;

test("an installed machine opens the editor with this computer's keys and settings", async () => {
  const f = fake({ installed: [`/root/.local/share/herdr-vscode/${VER}/manifest.json`] });
  assert.deepEqual(await f.remote.prepare("box"), { launcher, args: ["--os", "mac", "--settings", '{"files.autoSave": "off"}'] });
  await f.remote.prepare("box");
  assert.equal(f.runs.length, 2); // uname once, the install check once
  assert.deepEqual(f.toasts, []);
});

test("not installed: the viewer opens and the machine is asked once a day", async () => {
  const f = fake();
  assert.equal(await f.remote.prepare("box"), null);
  assert.equal(await f.remote.prepare("box"), null);
  assert.deepEqual(f.asks, [["box", "2.8 MB"]]);
  assert.equal(f.store[ASKED].box, f.t);
  f.t += 25 * 3600 * 1000;
  await f.remote.prepare("box");
  assert.equal(f.asks.length, 2);
  assert.ok(!f.runs.some(r => r.args[1] === UPLOAD)); // nothing sent without a yes
});

test("a machine that said yes gets a new version on its own, with progress toasts", async () => {
  const f = fake({ approved: { box: true } });
  assert.deepEqual((await f.remote.prepare("box")).launcher, launcher);
  const upload = f.runs.find(r => r.args[1] === UPLOAD);
  assert.deepEqual(upload.args.slice(3, 8), ["box", upload.args[4], "/root/.local/share/herdr-vscode", VER, SUM]);
  assert.equal(upload.args.at(-1), "/h/vscode-core/remote/aarch64/bundle.tgz");
  assert.equal(upload.on, null); // the upload runs on this computer
  assert.deepEqual(f.toasts.map(t => t.level), ["info", "success"]);
  assert.deepEqual(f.asks, []);
});

test("a failed install, an unreachable or unsupported machine, or no built bundle open the viewer", async () => {
  const failed = fake({ approved: { box: true }, uploadCode: 3 });
  assert.equal(await failed.remote.prepare("box"), null);
  assert.match(failed.toasts.at(-1).body, /damaged/);
  const away = fake({ machines: { box: new Error("box is not connected") } });
  assert.equal(await away.remote.prepare("box"), null);
  assert.equal(away.toasts[0].level, "warning");
  const arm32 = fake({ machines: { box: "Linux armv7l\n/root\n" } });
  assert.equal(await arm32.remote.prepare("box"), null);
  await arm32.remote.prepare("box");
  assert.equal(arm32.toasts.length, 1); // said once
  const unbuilt = fake({ files: { "/h/vscode-core/remote/aarch64/manifest.json": null } });
  assert.equal(await unbuilt.remote.prepare("box"), null);
  assert.match(unbuilt.toasts[0].body, /build-remote\.sh/);
});

test("the confirm dialog's yes approves the machine it asked about and installs there; a stale one does nothing", async () => {
  const f = fake();
  f.store[INSTALL_REQUEST] = { machine: "box", at: f.t - 1000 };
  await f.remote.installRequested();
  assert.deepEqual(f.store[APPROVED], { box: true });
  assert.equal(f.store[INSTALL_REQUEST], null);
  assert.equal(f.runs.filter(r => r.args[1] === UPLOAD).length, 1);
  const stale = fake();
  stale.store[INSTALL_REQUEST] = { machine: "box", at: stale.t - 3600 * 1000 };
  await stale.remote.installRequested();
  assert.deepEqual(stale.store[APPROVED], {});
  assert.deepEqual(stale.runs, []);
});

test("two opens while installing share one upload", async () => {
  const f = fake({ approved: { box: true } });
  await Promise.all([f.remote.prepare("box"), f.remote.prepare("box")]);
  assert.equal(f.runs.filter(r => r.args[1] === UPLOAD).length, 1);
});

test("openFile asks the machine only for files the editor takes", async () => {
  const opened = [], asked = [];
  const openFile = createOpenFile({ openTab: async (args) => opened.push(args), appHome: () => "/h",
    remote: { prepare: async (m) => (asked.push(m), { launcher: "/r/vsedit.sh", args: [] }) } });
  await openFile("/srv/a.rs", { on: "box", folder: "/srv" });
  await openFile("/srv/a.png", { on: "box", folder: "/srv" });
  await openFile("/p/a.rs", { folder: "/p" });
  assert.deepEqual(asked, ["box"]);
  assert.equal(opened[0].argv[2], "/r/vsedit.sh");
  assert.equal(opened[1].mod, "vscode-viewer");
  assert.equal(opened[2].argv[2], "/h/mods/vscode-viewer/editor/vsedit.sh");
});
