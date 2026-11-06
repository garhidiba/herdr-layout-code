// The terminal editor on a remote space's machine (VS Code Remote's way): a remote space's tabs hold only that
// machine's terminals, so the editor runs there, from a bundle this computer cross-built
// (vscode-settings/native/build-remote.sh → <herdr home>/vscode-core/remote/<platform>/{bundle.tgz, manifest.json}) and
// uploaded once per version into the machine's bundle root. The upload itself runs here (`hc exec -i --on`, the
// bundle on its stdin), never as a tab. No Herdr imports, so node tests load it.
//   platform         found by                          bundle root                       editor
//   linux-aarch64    uname -sm: Linux aarch64|arm64    ~/.local/share/herdr-vscode       yes
//   linux-x86_64     uname -sm: Linux x86_64|amd64     ~/.local/share/herdr-vscode       yes
//   macos            uname -sm: Darwin (universal)     ~/.local/share/herdr-vscode       yes
//   windows-x86_64   PowerShell: AMD64                 %LOCALAPPDATA%\herdr-vscode       not yet (POSIX terminal layer):
//   windows-aarch64  PowerShell: ARM64                 %LOCALAPPDATA%\herdr-vscode       the viewer; the core installs
// A machine without `sh` (or with Git Bash's MINGW/MSYS uname) is asked through PowerShell. Values go into Unix
// scripts as arguments ("$1"), never into their text; PowerShell gets its script as -EncodedCommand (UTF-16LE base64,
// so no command-line quoting), with values validated first and written as single-quoted literals.
import { openArgs, wantsEditor } from "./paths.js";

export const ROOT = ".local/share/herdr-vscode"; // under a Unix machine's $HOME; nothing is written outside it
const WIN_ROOT = "herdr-vscode";                   // under a Windows machine's %LOCALAPPDATA%
const BUNDLES = "vscode-core/remote";              // under <herdr home>
export const APPROVED = "vscode-explorer.remote-approved", INSTALL_REQUEST = "vscode-explorer.remote-install";
export const INSTALL_COMMAND = "vscode-explorer.install-remote";
const REQUEST_AGE = 600000; // a confirm dialog answered later than this installs nothing

// The confirm dialog's yes (INSTALL_COMMAND): the machine it asked about, from INSTALL_REQUEST, or null when stale.
export const requestedMachine = (request, now) => (request?.machine && now - request.at < REQUEST_AGE ? request.machine : null);

// What a machine is, one round trip: `uname -sm` and $HOME (Unix), else the CPU and %LOCALAPPDATA% (Windows).
export const INFO = 'uname -sm; printf "%s\\n" "$HOME"';
export const WIN_INFO = "$env:PROCESSOR_ARCHITECTURE; $env:LOCALAPPDATA";
const POWERSHELL = ["-NoProfile", "-NonInteractive"];

// `uname -sm` → { os, platform }: platform null where no bundle runs; os "windows" for Git Bash and the like
// (PowerShell then says the rest).
export function platformOf(uname) {
  const [os = "", cpu] = String(uname ?? "").trim().split(/\s+/);
  if (/^(MINGW|MSYS|CYGWIN|Windows_NT)/i.test(os)) return { os: "windows", platform: null };
  if (os === "Darwin") return { os: "macos", platform: ["arm64", "x86_64"].includes(cpu) ? "macos" : null };
  if (os !== "Linux") return { os: os || null, platform: null };
  const arch = { aarch64: "aarch64", arm64: "aarch64", x86_64: "x86_64", amd64: "x86_64" }[cpu];
  return { os: "linux", platform: arch ? `linux-${arch}` : null };
}

// INFO's output → { os, platform, home, uname }; home null when it isn't an absolute path.
export function parseInfo(stdout) {
  const [uname = "", home = ""] = String(stdout ?? "").split("\n");
  return { ...platformOf(uname), home: home.startsWith("/") && !home.includes("\0") ? home.replace(/\/+$/, "") : null, uname: uname.trim() };
}

// WIN_INFO's output → the same shape; home is %LOCALAPPDATA% (a drive path without quotes or control characters).
export function parseWindowsInfo(stdout) {
  const [cpu = "", local = ""] = String(stdout ?? "").split(/\r?\n/).map(l => l.trim());
  const platform = { AMD64: "windows-x86_64", ARM64: "windows-aarch64" }[cpu.toUpperCase()] ?? null;
  const home = /^[A-Za-z]:\\[^"'‘’‚‛\x00-\x1f]*$/.test(local) ? local.replace(/\\+$/, "") : null;
  return { os: "windows", platform, home, uname: `Windows ${cpu}`.trim() };
}

// A PowerShell single-quoted literal (PowerShell also reads curly single quotes as quotes, so they're doubled too).
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;

// -EncodedCommand's text: the script as UTF-16LE, base64.
export function encodeCommand(script) {
  const bytes = [];
  for (let i = 0; i < script.length; i++) { const c = script.charCodeAt(i); bytes.push(c & 0xff, c >> 8); }
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3), n = (a << 16) | (b << 8) | c;
    out += abc[n >> 18] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
  }
  return out;
}

// A version folder's name: <x.y.z>-<12 hex> (build-remote.sh), nothing that could leave the root.
export const VERSION = /^\d+\.\d+\.\d+-[0-9a-f]{12}$/;

// <herdr home>/vscode-core/remote/<platform>/manifest.json → { version, platform, sha256, size, text }, or null when
// it is missing, not this platform, or not what build-remote.sh writes.
export function parseManifest(text, platform) {
  try {
    const m = JSON.parse(text);
    if (m?.platform !== platform || !VERSION.test(m.version) || !/^[0-9a-f]{64}$/.test(m.sha256) || !(m.size > 0)) return null;
    return { version: m.version, platform, sha256: m.sha256, size: m.size, text };
  } catch { return null; }
}

// "2.8 MB"
export const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// The keys of the computer the keyboard is on (Herdr's window().platform), for the editor's VSEDIT_OS.
export const keysOs = (platform) => (platform === "macos" ? "mac" : platform === "windows" ? "win" : "linux");

// On a Unix machine, stdin = the bundle: args root, version, sha256, manifest text. Idempotent (a version folder that
// has its manifest is complete: it only appears whole, by rename); checks the sha256 and that vsedit runs; keeps
// this version and the one before it.
export const REMOTE_INSTALL = `set -eu
root=$1 ver=$2 sum=$3
case $root in /*/.local/share/herdr-vscode) ;; *) echo "refusing to install into $root" >&2; exit 2 ;; esac
case $ver in *[!0-9a-f.-]*|''|.*) echo "bad version $ver" >&2; exit 2 ;; esac
case $sum in *[!0-9a-f]*|'') echo "bad sha256" >&2; exit 2 ;; esac
mkdir -p "$root"
if [ -f "$root/$ver/manifest.json" ]; then cat >/dev/null; echo current; exit 0; fi
tmp=$(mktemp -d "$root/.install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/bundle.tgz"
got=$({ sha256sum "$tmp/bundle.tgz" 2>/dev/null || shasum -a 256 "$tmp/bundle.tgz"; } | cut -d ' ' -f 1)
[ "$got" = "$sum" ] || { echo "the bundle arrived damaged (sha256 $got)" >&2; exit 3; }
mkdir "$tmp/b"
tar -xzf "$tmp/bundle.tgz" -C "$tmp/b" --no-same-owner
chmod 755 "$tmp/b/vsedit" "$tmp/b/vscode-core"
[ "$("$tmp/b/vsedit" --api 2>/dev/null)" = 1 ] || { echo "the editor does not run on $(uname -sm)" >&2; exit 4; }
printf '%s\\n' "$4" > "$tmp/b/manifest.json"
rm -rf "$root/$ver"
mv "$tmp/b" "$root/$ver"
ls -1t "$root" | grep -E '^[0-9]+[.][0-9]+[.][0-9]+-[0-9a-f]{12}$' | tail -n +3 | while IFS= read -r old; do rm -rf "$root/$old"; done
echo installed`;

// The same on Windows (PowerShell 5.1+, tar.exe of Windows 10+): stdin = the bundle, the core checked with --version.
// The values are checked here (a root under a drive, the version and sha256 patterns) before they are quoted in.
export function windowsInstall(root, version, sha256, manifest) {
  if (!/^[A-Za-z]:\\.*\\herdr-vscode$/.test(root) || !VERSION.test(version) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`refusing to install ${version} into ${root}`);
  return `$ErrorActionPreference = 'Stop'
$root = ${psQuote(root)}; $ver = ${psQuote(version)}; $sum = ${psQuote(sha256)}; $manifest = ${psQuote(manifest)}
$dir = Join-Path $root $ver
New-Item -ItemType Directory -Force -Path $root | Out-Null
if (Test-Path -LiteralPath (Join-Path $dir 'manifest.json')) { 'current'; exit 0 }
$tmp = Join-Path $root ('.install.' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$code = 0
try {
  $tgz = Join-Path $tmp 'bundle.tgz'
  $in = [Console]::OpenStandardInput(); $out = [IO.File]::Create($tgz); $in.CopyTo($out); $out.Close()
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $tgz).Hash.ToLowerInvariant()
  if ($got -ne $sum) { [Console]::Error.WriteLine("the bundle arrived damaged (sha256 $got)"); $code = 3 }
  else {
    $b = Join-Path $tmp 'b'; New-Item -ItemType Directory -Path $b | Out-Null
    & tar.exe -xzf $tgz -C $b
    if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('tar.exe could not unpack the bundle'); $code = 5 }
    else {
      & (Join-Path $b 'vscode-core.exe') --version | Out-Null
      if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('vscode-core does not run here'); $code = 4 }
      else {
        [IO.File]::WriteAllText((Join-Path $b 'manifest.json'), $manifest + [char]10)
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
        Move-Item -LiteralPath $b -Destination $dir
        Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -match '^[0-9]+[.][0-9]+[.][0-9]+-[0-9a-f]{12}$' } |
          Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | Remove-Item -Recurse -Force
        'installed'
      }
    }
  }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
exit $code`;
}

// Per OS: the bundle root and a version's folder, the "is it installed" check and the install, as [program, args].
export const SYSTEMS = {
  unix: {
    root: (home) => `${home}/${ROOT}`,
    dir: (root, version) => `${root}/${version}`,
    installed: (dir) => ["test", ["-f", `${dir}/manifest.json`]],
    install: (root, m) => ["sh", ["-c", REMOTE_INSTALL, "herdr-vscode", root, m.version, m.sha256, m.text]],
    editor: true,
  },
  windows: {
    root: (home) => `${home}\\${WIN_ROOT}`,
    dir: (root, version) => `${root}\\${version}`,
    installed: (dir) => ["powershell", [...POWERSHELL, "-Command", `if (Test-Path -LiteralPath ${psQuote(`${dir}\\manifest.json`)}) { exit 0 } else { exit 1 }`]],
    install: (root, m) => ["powershell", [...POWERSHELL, "-EncodedCommand", encodeCommand(windowsInstall(root, m.version, m.sha256, m.text))]],
    editor: false,
  },
};
export const systemOf = (os) => SYSTEMS[os === "windows" ? "windows" : "unix"];
export const rootOf = (home, os = "linux") => systemOf(os).root(home);
export const dirOf = (home, version, os = "linux") => { const s = systemOf(os); return s.dir(s.root(home), version); };

// Here: sends the bundle ($2) to machine $1 and runs the rest there (the OS's install), the bundle on its stdin.
export const UPLOAD = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; '
  + 'm=$1 bundle=$2; shift 2; exec hc exec -i --on "$m" --timeout 300 -- "$@" < "$bundle"';

// exec, readTextFile, notify, appHome, platform (window().platform), shared/setShared and confirm(machine, size)
// (asks to install; its yes runs INSTALL_COMMAND) come from Herdr. Returns:
//   prepare(machine) → { launcher, args } to open a file in the editor there; { install: true } for the viewer when it
//     isn't installed yet (asks on every open); null for the viewer (no editor for its system, no bundle built, or the
//     install failed);
//   install(machine) → the installed target (throws with the reason; toasts its progress), one at a time per machine;
//   installRequested() → the confirm dialog's yes.
export function createRemote({ exec, readTextFile, notify, appHome, platform = () => null, shared = () => null, setShared = () => {}, confirm = () => {}, now = Date.now }) {
  const info = new Map(), ready = new Map(), installing = new Map(), told = new Set();
  const once = (key, n) => { if (!told.has(key)) { told.add(key); notify(n); } };

  // Unix first; a machine without sh (exec rejects or fails) or with a Windows uname is asked through PowerShell.
  async function machineInfo(machine) {
    if (!info.has(machine)) {
      let found = null, failure = null;
      try {
        const r = await exec("sh", ["-c", INFO], { on: machine });
        if (r.code === 0) found = parseInfo(r.stdout); else failure = new Error(r.stderr.trim() || `${machine} did not answer`);
      } catch (e) { failure = e; }
      if (!found || found.os === "windows") {
        const r = await exec("powershell", [...POWERSHELL, "-Command", WIN_INFO], { on: machine }).catch(() => null);
        if (r?.code === 0) found = parseWindowsInfo(r.stdout);
        else if (!found) throw failure;
      }
      info.set(machine, found);
    }
    return info.get(machine);
  }

  // The machine and the bundle built for it, or null (with a toast once per session saying why).
  async function target(machine) {
    const m = await machineInfo(machine);
    if (!m.platform || !m.home) {
      once(`platform:${machine}`, { title: `No editor for ${machine}`, body: `${m.uname || "Its system"} isn't Linux or Windows on aarch64 or x86_64, or macOS; its files open in the viewer.`, level: "info" });
      return null;
    }
    const dir = `${appHome()}/${BUNDLES}/${m.platform}`;
    const manifest = parseManifest(await readTextFile(`${dir}/manifest.json`).catch(() => null), m.platform);
    if (!manifest) {
      once("bundle", { title: "Remote editor not built", body: `Files on ${machine} open in the viewer. Build it with: sh ${appHome()}/mods/vscode-settings/native/build-remote.sh`, level: "info" });
      return null;
    }
    const system = systemOf(m.os), root = system.root(m.home);
    return { ...m, system, root, manifest, bundle: `${dir}/bundle.tgz`, dir: system.dir(root, manifest.version) };
  }

  async function launch(t) {
    const read = (name) => readTextFile(`${appHome()}/${name}`).catch(() => null);
    const [settings, keybindings] = await Promise.all([read("vscode-settings.json"), read("vscode-keybindings.json")]);
    const args = ["--os", keysOs(platform())];
    if (settings != null) args.push("--settings", settings);
    if (keybindings != null) args.push("--keybindings", keybindings);
    return { launcher: `${t.dir}/vsedit.sh`, args };
  }

  async function install(machine) {
    if (installing.has(machine)) return installing.get(machine);
    const job = (async () => {
      const t = await target(machine);
      if (!t) throw new Error(`No editor bundle for ${machine}`);
      notify({ title: `Installing the editor on ${machine}…`, body: `${megabytes(t.manifest.size)} into ${t.dir}`, level: "info" });
      const [program, args] = t.system.install(t.root, t.manifest);
      const r = await exec("sh", ["-c", UPLOAD, "herdr-vscode", machine, t.bundle, program, ...args]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `the install exited with ${r.code}`);
      ready.set(machine, t.dir);
      notify({ title: `Editor installed on ${machine}`, body: `Its files open in the terminal editor there (${t.manifest.version}).`, level: "success" });
      return t;
    })();
    installing.set(machine, job);
    try { return await job; } finally { installing.delete(machine); }
  }

  async function prepare(machine) {
    try {
      if (!systemOf((await machineInfo(machine)).os).editor) {
        once(`editor:${machine}`, { title: `No terminal editor on ${machine} yet`, body: "The editor's terminal layer is POSIX only, so Windows files open in the viewer.", level: "info" });
        return null;
      }
      const t = await target(machine);
      if (!t) return null;
      if (ready.get(machine) === t.dir) return launch(t);
      const [program, args] = t.system.installed(t.dir);
      if ((await exec(program, args, { on: machine })).code === 0) {
        ready.set(machine, t.dir);
        return launch(t);
      }
      // a machine that said yes once updates on its own; the others are asked each time (the viewer opens meanwhile,
      // with the same offer)
      if (shared(APPROVED)?.[machine]) return launch(await install(machine));
      confirm(machine, megabytes(t.manifest.size));
      return { install: true };
    } catch (e) {
      notify({ title: `Editor on ${machine}: opening the viewer`, body: String(e?.message ?? e), level: "warning" });
      return null;
    }
  }

  // The confirm dialog's yes: that machine is approved from now on (new versions install on their own), then installed.
  async function installRequested() {
    const machine = requestedMachine(shared(INSTALL_REQUEST), now());
    if (!machine) return;
    setShared(INSTALL_REQUEST, null);
    setShared(APPROVED, { ...(shared(APPROVED) ?? {}), [machine]: true });
    await install(machine).catch((e) => notify({ title: `Could not install the editor on ${machine}`, body: String(e?.message ?? e), level: "error" }));
  }

  return { prepare, install, installRequested };
}

// Opens a file as the Explorer does: on a remote space the terminal editor runs on its machine when it is (or gets)
// installed there, else the viewer. `openTab` is launch.js's.
export function createOpenFile({ openTab, remote, appHome }) {
  return async function openFile(file, { on = null, how = "auto", folder }, cx) {
    const launch = on && wantsEditor(file, how) ? await remote.prepare(on) : null;
    return openTab(openArgs(file, { on, appHome: appHome(), how, folder, remote: launch }), cx);
  };
}
