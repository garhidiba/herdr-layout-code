// The terminal editor on a remote space's machine (VS Code Remote's way): a remote space's tabs hold only that
// machine's terminals, so the editor runs there, from a bundle this computer cross-built
// (vscode-settings/native/build-remote.sh → <herdr home>/vscode-core/remote/<arch>/{bundle.tgz, manifest.json}) and
// uploaded once per version into ~/.local/share/herdr-vscode/<version>/ on the machine. The upload itself runs here
// (`hc exec -i --on`, the bundle on its stdin), never as a tab. No Herdr imports, so node tests load it.
// Every path and value goes into a script as an argument ("$1"), never into its text.
import { openArgs, wantsEditor } from "./paths.js";

export const ROOT = ".local/share/herdr-vscode"; // under the machine's $HOME; nothing is written outside it
const BUNDLES = "vscode-core/remote";              // under <herdr home>
const ASK_AGAIN = 24 * 3600 * 1000;                // a machine whose install wasn't confirmed is asked again after a day
export const ASKED = "vscode-explorer.remote-asked", APPROVED = "vscode-explorer.remote-approved", PENDING = "vscode-explorer.remote-pending";
export const INSTALL_COMMAND = "vscode-explorer.install-remote";

// What a machine is: `uname -sm` and $HOME, one round trip.
export const INFO = 'uname -sm; printf "%s\\n" "$HOME"';

// The bundle's arch for `uname -sm` ("Linux aarch64"), or null where none runs (not Linux, another CPU).
export function archOf(uname) {
  const [os, cpu] = String(uname ?? "").trim().split(/\s+/);
  if (os !== "Linux") return null;
  return { aarch64: "aarch64", arm64: "aarch64", x86_64: "x86_64", amd64: "x86_64" }[cpu] ?? null;
}

// INFO's output → { arch, home, uname }; home null when it isn't an absolute path.
export function parseInfo(stdout) {
  const [uname = "", home = ""] = String(stdout ?? "").split("\n");
  return { arch: archOf(uname), home: home.startsWith("/") && !home.includes("\0") ? home.replace(/\/+$/, "") : null, uname: uname.trim() };
}

export const rootOf = (home) => `${home}/${ROOT}`;
export const dirOf = (home, version) => `${rootOf(home)}/${version}`;

// A version folder's name: <x.y.z>-<12 hex> (build-remote.sh), nothing that could leave the root.
export const VERSION = /^\d+\.\d+\.\d+-[0-9a-f]{12}$/;

// <herdr home>/vscode-core/remote/<arch>/manifest.json → { version, arch, sha256, size, text }, or null when it is
// missing, not this arch, or not what build-remote.sh writes.
export function parseManifest(text, arch) {
  try {
    const m = JSON.parse(text);
    if (m?.arch !== arch || !VERSION.test(m.version) || !/^[0-9a-f]{64}$/.test(m.sha256) || !(m.size > 0)) return null;
    return { version: m.version, arch, sha256: m.sha256, size: m.size, text };
  } catch { return null; }
}

// "2.8 MB"
export const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// The keys of the computer the keyboard is on (Herdr's window().platform), for the editor's VSEDIT_OS.
export const keysOs = (platform) => (platform === "macos" ? "mac" : platform === "windows" ? "win" : "linux");

// On the machine, stdin = the bundle: args root, version, sha256, manifest text. Idempotent (a version folder that
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
got=$(sha256sum "$tmp/bundle.tgz" | cut -d ' ' -f 1)
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

// Here: sends the bundle ($7) to machine $1 and runs REMOTE_INSTALL ($2) there with $3-$6.
export const UPLOAD = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; '
  + 'exec hc exec -i --on "$1" --timeout 300 -- sh -c "$2" herdr-vscode "$3" "$4" "$5" "$6" < "$7"';

// exec, readTextFile, notify, appHome, platform (window().platform), shared/setShared and confirm(machine, size)
// (asks to install; its yes runs INSTALL_COMMAND) come from Herdr. Returns:
//   prepare(machine) → { launcher, args } to open a file in the editor there, or null for the viewer (not supported,
//     no bundle built, not installed yet: asks once a day, or the install failed);
//   install(machine) → the installed { launcher } (throws with the reason; toasts its progress), one at a time per machine.
export function createRemote({ exec, readTextFile, notify, appHome, platform = () => null, shared = () => null, setShared = () => {}, confirm = () => {}, now = Date.now }) {
  const info = new Map(), ready = new Map(), installing = new Map(), told = new Set();
  const once = (key, n) => { if (!told.has(key)) { told.add(key); notify(n); } };

  async function machineInfo(machine) {
    if (!info.has(machine)) {
      const r = await exec("sh", ["-c", INFO], { on: machine });
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${machine} did not answer`);
      info.set(machine, parseInfo(r.stdout));
    }
    return info.get(machine);
  }

  // The machine and the bundle built for it, or null (with a toast once per session saying why).
  async function target(machine) {
    const m = await machineInfo(machine);
    if (!m.arch || !m.home) {
      once(`arch:${machine}`, { title: `No editor for ${machine}`, body: `${m.uname || "Its system"} isn't Linux on aarch64 or x86_64; its files open in the viewer.`, level: "info" });
      return null;
    }
    const dir = `${appHome()}/${BUNDLES}/${m.arch}`;
    const manifest = parseManifest(await readTextFile(`${dir}/manifest.json`).catch(() => null), m.arch);
    if (!manifest) {
      once("bundle", { title: "Remote editor not built", body: `Files on ${machine} open in the viewer. Build it with: sh ${appHome()}/mods/vscode-settings/native/build-remote.sh`, level: "info" });
      return null;
    }
    return { ...m, manifest, bundle: `${dir}/bundle.tgz`, dir: dirOf(m.home, manifest.version) };
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
      notify({ title: `Installing the editor on ${machine}…`, body: `${megabytes(t.manifest.size)} into ~/${ROOT}/${t.manifest.version}`, level: "info" });
      const r = await exec("sh", ["-c", UPLOAD, "herdr-vscode", machine, REMOTE_INSTALL, rootOf(t.home), t.manifest.version, t.manifest.sha256, t.manifest.text, t.bundle]);
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
      const t = await target(machine);
      if (!t) return null;
      if (ready.get(machine) === t.dir) return launch(t);
      if ((await exec("test", ["-f", `${t.dir}/manifest.json`], { on: machine })).code === 0) {
        ready.set(machine, t.dir);
        return launch(t);
      }
      // a machine that said yes once updates on its own; the others are asked (the viewer opens meanwhile)
      if (shared(APPROVED)?.[machine]) return launch(await install(machine));
      const asked = shared(ASKED) ?? {};
      if (!(now() - (asked[machine] ?? 0) < ASK_AGAIN)) {
        setShared(ASKED, { ...asked, [machine]: now() });
        confirm(machine, megabytes(t.manifest.size));
      }
      return null;
    } catch (e) {
      notify({ title: `Editor on ${machine}: opening the viewer`, body: String(e?.message ?? e), level: "warning" });
      return null;
    }
  }

  return { prepare, install };
}

// Opens a file as the Explorer does: on a remote space the terminal editor runs on its machine when it is (or gets)
// installed there, else the viewer. `openTab` is launch.js's.
export function createOpenFile({ openTab, remote, appHome }) {
  return async function openFile(file, { on = null, how = "auto", folder }, cx) {
    const launch = on && wantsEditor(file, how) ? await remote.prepare(on) : null;
    return openTab(openArgs(file, { on, appHome: appHome(), how, folder, remote: launch }), cx);
  };
}
