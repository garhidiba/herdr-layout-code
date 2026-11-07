// node --test mods/vscode-explorer/test/remote.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformOf, parseInfo, parseWindowsInfo, parseManifest, keysOs, megabytes, rootOf, dirOf, psQuote, encodeCommand, windowsInstall, SYSTEMS, REMOTE_INSTALL, UPLOAD, INFO, WIN_INFO, createRemote, createOpenFile, APPROVED, INSTALL_REQUEST } from "../remote.js";

const VER = "1.0.0-0123456789ab", SUM = "a".repeat(64);
const manifestText = (platform, version = VER, sha256 = SUM) => JSON.stringify({ version, platform, sha256, size: 2843587, files: {} });
const LOCAL = "C:\\Users\\me\\AppData\\Local";

test("a machine's platform from uname: Linux and macOS; Windows shells and other CPUs are not a bundle", () => {
  assert.deepEqual(platformOf("Linux aarch64"), { os: "linux", platform: "linux-aarch64" });
  assert.deepEqual(platformOf("Linux arm64\n"), { os: "linux", platform: "linux-aarch64" });
  assert.deepEqual(platformOf("Linux x86_64"), { os: "linux", platform: "linux-x86_64" });
  assert.deepEqual(platformOf("Linux armv7l"), { os: "linux", platform: null });
  assert.deepEqual(platformOf("Darwin arm64"), { os: "macos", platform: "macos" });
  assert.deepEqual(platformOf("Darwin x86_64"), { os: "macos", platform: "macos" });
  assert.deepEqual(platformOf("MINGW64_NT-10.0-19045 x86_64"), { os: "windows", platform: null }); // Git Bash: ask PowerShell
  assert.deepEqual(platformOf("FreeBSD amd64"), { os: "FreeBSD", platform: null });
  assert.deepEqual(platformOf(""), { os: null, platform: null });
  assert.deepEqual(parseInfo("Linux aarch64\n/root\n"), { os: "linux", platform: "linux-aarch64", home: "/root", uname: "Linux aarch64" });
  assert.equal(parseInfo("Linux x86_64\nrelative\n").home, null);
});

test("a Windows machine's platform and %LOCALAPPDATA% from PowerShell", () => {
  assert.deepEqual(parseWindowsInfo(`AMD64\r\n${LOCAL}\r\n`), { os: "windows", platform: "windows-x86_64", home: LOCAL, uname: "Windows AMD64" });
  assert.equal(parseWindowsInfo(`ARM64\r\n${LOCAL}\\\r\n`).platform, "windows-aarch64");
  assert.equal(parseWindowsInfo(`ARM64\r\n${LOCAL}\\\r\n`).home, LOCAL);
  assert.equal(parseWindowsInfo("x86\r\nC:\\x\r\n").platform, null);
  assert.equal(parseWindowsInfo("AMD64\r\nC:\\it's\r\n").home, null); // no quotes in a path that goes into a script
  assert.equal(parseWindowsInfo("AMD64\r\n\\\\server\\share\r\n").home, null);
});

test("bundle roots and version folders per OS", () => {
  assert.equal(rootOf("/home/ardi"), "/home/ardi/.local/share/herdr-vscode");
  assert.equal(dirOf("/root", VER), `/root/.local/share/herdr-vscode/${VER}`);
  assert.equal(dirOf("/Users/me", VER, "macos"), `/Users/me/.local/share/herdr-vscode/${VER}`);
  assert.equal(rootOf(LOCAL, "windows"), `${LOCAL}\\herdr-vscode`);
  assert.equal(dirOf(LOCAL, VER, "windows"), `${LOCAL}\\herdr-vscode\\${VER}`);
  assert.deepEqual(SYSTEMS.unix.installed("/r/v"), ["test", ["-f", "/r/v/manifest.json"]]);
  assert.match(SYSTEMS.windows.installed(`${LOCAL}\\herdr-vscode\\${VER}`)[1].at(-1), /^if \(Test-Path -LiteralPath 'C:\\Users\\me\\AppData\\Local\\herdr-vscode\\1\.0\.0-0123456789ab\\manifest\.json'\)/);
  assert.equal(SYSTEMS.unix.editor && !SYSTEMS.windows.editor, true);
});

test("PowerShell gets values as single-quoted literals inside an encoded script", () => {
  assert.equal(psQuote("C:\\a b"), "'C:\\a b'");
  assert.equal(psQuote("it's ‘x’ $env:X `n"), "'it''s ‘‘x’’ $env:X `n'");
  for (const s of ["", "a", "ab", "abc", "한글 é\n'$x'", "x".repeat(1000)]) assert.equal(encodeCommand(s), Buffer.from(s, "utf16le").toString("base64"));
  const script = windowsInstall(`${LOCAL}\\herdr-vscode`, VER, SUM, `{"name": "it's"}`);
  assert.match(script, /\$root = 'C:\\Users\\me\\AppData\\Local\\herdr-vscode'; \$ver = '1\.0\.0-0123456789ab'/);
  assert.match(script, /\$manifest = '\{"name": "it''s"\}'/);
  const [program, args] = SYSTEMS.windows.install(`${LOCAL}\\herdr-vscode`, { version: VER, sha256: SUM, text: "{}" });
  assert.deepEqual([program, ...args.slice(0, 3)], ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.match(Buffer.from(args[3], "base64").toString("utf16le"), /Move-Item -LiteralPath \$b -Destination \$dir/);
  assert.throws(() => windowsInstall("C:\\Windows", VER, SUM, "{}"), /refusing/);
  assert.throws(() => windowsInstall(`${LOCAL}\\herdr-vscode`, "..\\x", SUM, "{}"), /refusing/);
  assert.throws(() => windowsInstall(`${LOCAL}\\herdr-vscode`, VER, "'; evil", "{}"), /refusing/);
});

test("only a manifest build-remote.sh writes, for this platform, names a bundle", () => {
  assert.equal(parseManifest(manifestText("linux-aarch64"), "linux-aarch64").version, VER);
  assert.equal(parseManifest(manifestText("linux-x86_64"), "linux-aarch64"), null);
  assert.equal(parseManifest(manifestText("linux-aarch64", "../../etc"), "linux-aarch64"), null);
  assert.equal(parseManifest(manifestText("linux-aarch64", VER, "zz"), "linux-aarch64"), null);
  assert.equal(parseManifest("{ broken", "linux-aarch64"), null);
  assert.equal(parseManifest(null, "linux-aarch64"), null);
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
  const r = spawnSync("sh", ["-c", UPLOAD, "herdr-vscode", "orange pi", tgz, "sh", "-c", REMOTE_INSTALL, "herdr-vscode", root, VER, sum, `{"a": "b c"}`], { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(log, "utf8"), /^exec -i --on orange pi --timeout 300 -- sh -c /);
  assert.equal(readFileSync(join(root, VER, "manifest.json"), "utf8"), '{"a": "b c"}\n');
});

// A fake Herdr for createRemote: machines (machine → `uname -sm`/$HOME output, an Error, or { ps } for a Windows
// machine without sh: PowerShell's output), installed folders on them, local files.
function fake({ machines = { box: "Linux aarch64\n/root\n" }, files = {}, installed = [], approved = {}, uploadCode = 0 } = {}) {
  const f = { runs: [], toasts: [], asks: [], store: { [APPROVED]: approved }, t: 1e12 };
  const local = { "/h/vscode-settings.json": '{"files.autoSave": "off"}', ...files };
  for (const p of ["linux-aarch64", "linux-x86_64", "macos", "windows-x86_64"]) if (!(`/h/vscode-core/remote/${p}/manifest.json` in local)) local[`/h/vscode-core/remote/${p}/manifest.json`] = manifestText(p);
  f.remote = createRemote({
    appHome: () => "/h",
    platform: () => "macos",
    readTextFile: async (p) => local[p] ?? null,
    exec: async (cmd, args, opts = {}) => {
      f.runs.push({ cmd, args, on: opts.on ?? null });
      if (opts.on) {
        const m = machines[opts.on];
        if (m instanceof Error) throw m;
        if (cmd === "powershell" && args.at(-1) === WIN_INFO) return m.ps ? { code: 0, stdout: m.ps, stderr: "" } : { code: 1, stdout: "", stderr: "no powershell" };
        if (m.ps) throw new Error(`cannot start ${cmd}: program not found`);
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

test("not installed: the viewer opens with the offer and the machine is asked on every open", async () => {
  const f = fake();
  assert.deepEqual(await f.remote.prepare("box"), { install: true });
  assert.deepEqual(await f.remote.prepare("box"), { install: true });
  assert.deepEqual(f.asks, [["box", "2.8 MB"], ["box", "2.8 MB"]]);
  assert.ok(!f.runs.some(r => r.args[1] === UPLOAD)); // nothing sent without a yes
});

test("a machine that said yes gets a new version on its own, with progress toasts", async () => {
  const f = fake({ approved: { box: true } });
  assert.deepEqual((await f.remote.prepare("box")).launcher, launcher);
  const upload = f.runs.find(r => r.args[1] === UPLOAD);
  assert.deepEqual(upload.args.slice(3, 7), ["box", "/h/vscode-core/remote/linux-aarch64/bundle.tgz", "sh", "-c"]);
  assert.deepEqual(upload.args.slice(8, 12), ["herdr-vscode", "/root/.local/share/herdr-vscode", VER, SUM]);
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
  const unbuilt = fake({ files: { "/h/vscode-core/remote/linux-aarch64/manifest.json": null } });
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

test("a macOS machine takes the universal bundle and its editor", async () => {
  const f = fake({ machines: { mac: "Darwin arm64\n/Users/me\n" }, installed: [`/Users/me/.local/share/herdr-vscode/${VER}/manifest.json`] });
  assert.equal((await f.remote.prepare("mac")).launcher, `/Users/me/.local/share/herdr-vscode/${VER}/vsedit.sh`);
});

test("a Windows machine is found through PowerShell and opens the viewer; its core bundle installs with PowerShell", async () => {
  const f = fake({ machines: { win: { ps: `AMD64\r\n${LOCAL}\r\n` } } });
  assert.equal(await f.remote.prepare("win"), null);
  assert.equal(await f.remote.prepare("win"), null);
  assert.deepEqual(f.toasts.map(t => t.title), ["No terminal editor on win yet"]);
  assert.deepEqual(f.runs.map(r => r.cmd), ["sh", "powershell"]); // asked once, no install check, no upload
  await f.remote.install("win");
  const upload = f.runs.at(-1);
  assert.deepEqual(upload.args.slice(3, 9), ["win", "/h/vscode-core/remote/windows-x86_64/bundle.tgz", "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.match(Buffer.from(upload.args[9], "base64").toString("utf16le"), /\$root = 'C:\\Users\\me\\AppData\\Local\\herdr-vscode'/);
  const bash = fake({ machines: { gb: Object.assign(new String("MINGW64_NT-10.0 x86_64\n/c/Users/me\n"), { ps: null }) } });
  assert.equal(await bash.remote.prepare("gb"), null); // Git Bash without PowerShell's answer: still Windows
  assert.match(bash.toasts[0].title, /No terminal editor on gb/);
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
  await openFile("/srv/.env", { on: "box", folder: "/srv" });
  await openFile("/srv/README.md", { on: "box", folder: "/srv" });
  assert.deepEqual(asked, ["box", "box", "box"]);
  assert.equal(opened[0].argv[2], "/r/vsedit.sh");
  assert.equal(opened[1].mod, "vscode-viewer");
  assert.equal(opened[2].argv[2], "/h/mods/vscode-viewer/editor/vsedit.sh");
  assert.equal(opened[3].argv[3], "/srv/.env");
  assert.equal(opened[4].argv[3], "/srv/README.md");
});

test("openFile on a machine without the editor: the viewer with the install offer", async () => {
  const opened = [];
  const openFile = createOpenFile({ openTab: async (args) => opened.push(args), appHome: () => "/h", remote: fake().remote });
  await openFile("/srv/x.toml", { on: "box", folder: "/srv" });
  assert.deepEqual(opened[0], { name: "x.toml", mod: "vscode-viewer", props: { file: "/srv/x.toml", on: "box", install: true } });
});

test("openFile goes to a file's open editor tab, and a second click while it opens does nothing", async () => {
  const opened = [], shown = [];
  let release = () => {};
  const openTab = async (args) => { opened.push(args); if (args.argv) await new Promise((r) => (release = r)); };
  const openFile = createOpenFile({ openTab, appHome: () => "/h", remote: fake().remote,
    showOpen: (file, on) => (shown.push(file), file === "/p/open.go") });
  await openFile("/p/open.go", { folder: "/p" });
  assert.equal(opened.length, 0);
  const first = openFile("/p/a.go", { folder: "/p" });
  await openFile("/p/./a.go", { folder: "/p" }); // the double-click's second click, before the tab shows
  assert.equal(opened.length, 1);
  release(); await first;
  const again = openFile("/p/a.go", { folder: "/p" }); // its tab was closed since: opens again
  release(); await again;
  assert.equal(opened.length, 2);
  await openFile("/p/logo.png", { folder: "/p" }); // the viewer: not looked for among editor tabs
  assert.equal(opened.length, 3);
  assert.deepEqual(shown, ["/p/open.go", "/p/a.go", "/p/a.go"]);
});
