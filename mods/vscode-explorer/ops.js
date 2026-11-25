// The Explorer menu's file operations, on this computer or on a space's machine (`on`), through Herdr's exec
// (passed in, so the tests run them here). Paths only ever go in as arguments ("$1"), never into a script's text.
// On a machine Herdr can't reach, exec rejects; that comes out as an Error with `unreachable: true` (a toast).
import { baseName, parentOf, within, freeName, downloadName, isWindowsPath } from "./paths.js";
import { psQuote, encodeCommand } from "./remote.js";
import { friendlyError } from "./offline.js";

// Delete on another machine: its `trash`, else `gio trash`, else gone for good (the dialog says so first).
export const REMOTE_DELETE = 'if command -v trash >/dev/null 2>&1; then trash "$1"; elif command -v gio >/dev/null 2>&1 && gio trash "$1" 2>/dev/null; then :; else rm -rf "$1"; fi';
// A new empty file that never replaces one (noclobber).
export const NEW_FILE = 'set -C; : > "$1"';
// Here, as an hc terminal: uploads to machine $1 ("" this one) into folder $2 the pairs that follow, a local path and its
// free name there. Each goes as a tar in 6 MB pieces (hc exec takes at most 8 MB piped in; 10 min a piece) into a temp
// folder beside its target, is extracted there (owned by the user there: -o) and renamed into place, never over an entry.
// Herdr's PATH may leave hc out; COPYFILE_DISABLE and --no-xattrs keep macOS's ._ files and xattrs out of the tar.
export const UPLOAD = `PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; export COPYFILE_DISABLE=1
m=$1 to=$2 r=; shift 2
on() { if [ -n "$m" ]; then hc exec --on "$m" --timeout 600 "$@"; else hc exec --timeout 600 "$@"; fi; }
t=$(mktemp -d) || exit 1
trap 'rm -rf "$t"; [ -z "$r" ] || on -- rm -rf "$r"' EXIT
while [ $# -gt 1 ]; do
  b=$(basename "$1")
  tar --no-xattrs -C "$(dirname "$1")" -cf "$t/a.tar" "./$b" && split -b 6000000 "$t/a.tar" "$t/c." && rm "$t/a.tar" || exit 1
  r=$(on -- mktemp -d "$to/.explorer-drop.XXXXXX") || exit 1
  for c in "$t"/c.*; do on -i -- sh -c 'cat >> "$1"' explorer "$r/in.tar" < "$c" || exit 1; done
  rm -f "$t"/c.*
  on -- sh -c 'mkdir "$1/x" && tar -xof "$1/in.tar" -C "$1/x" && if [ -e "$2/$4" ] || [ -L "$2/$4" ]; then echo "$4 already exists" >&2; false; else mv "$1/x/$3" "$2/$4"; fi; s=$?; rm -rf "$1"; exit $s' explorer "$r" "$to" "$b" "$2" || exit 1
  r=; shift 2
done`;

// Here, as an hc terminal: downloads machine $1's $2 to the new local path $3. $4: "file", "dir" (a Unix folder, tarred
// into a temp file there first, removed after) or "win" (a Windows file: $5 says its size, $6 sends a piece, both
// PowerShell -EncodedCommand). It comes in pieces of 4 MB (hc exec keeps only 8 MiB of output; a Windows piece comes
// as base64, 5.3 MB), each with dd at its offset as vscode-viewer's preview.js fetchFile does (or PowerShell, the piece's
// first MB on its stdin), into a hidden temp file beside $3. Only a copy of exactly the size there lands, and never over
// an entry: a file is linked into place (ln fails on a taken name), a folder is unpacked and moved in.
export const DOWNLOAD = `PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
m=$1 src=$2 out=$3 kind=$4 r=
on() { hc exec --on "$m" --timeout 600 "$@"; }
mkdir -p "$(dirname "$out")" && tmp=$(mktemp "$(dirname "$out")/.download.XXXXXX") || exit 1
trap 'rm -rf "$tmp" "$tmp.b" "$tmp.d"; [ -z "$r" ] || on -- rm -f "$r"' EXIT
case $kind in
  win) size=$(on -- powershell -NoProfile -NonInteractive -EncodedCommand "$5") || exit 1 ;;
  dir) r=$(on -- sh -c 'mktemp "\${TMPDIR:-/tmp}/herdr-download.XXXXXX"') || exit 1
    size=$(on -- sh -c 'cd "$(dirname "$2")" && COPYFILE_DISABLE=1 tar -cf "$1" "./$(basename "$2")" && wc -c < "$1"' explorer "$r" "$src") || exit 1
    src=$r ;;
  *) size=$(on -- sh -c 'if [ -f "$1" ]; then wc -c < "$1"; else echo "$1 is not a file" >&2; exit 1; fi' explorer "$src") || exit 1 ;;
esac
size=$(printf %s "$size" | tr -dc 0-9); [ -n "$size" ] || { echo "Cannot read the size of $src"; exit 1; }
skip=0
while [ $((skip * 1000000)) -lt "$size" ]; do
  if [ "$kind" = win ]; then
    echo "$skip" | on -i -- powershell -NoProfile -NonInteractive -EncodedCommand "$6" > "$tmp.b" && base64 --decode < "$tmp.b" >> "$tmp" || exit 1
  else
    on -- sh -c 'exec dd if="$1" bs=1000000 skip="$2" count=4 2>/dev/null' explorer "$src" "$skip" >> "$tmp" || exit 1
  fi
  skip=$((skip + 4))
done
n=$(wc -c < "$tmp" | tr -d ' ')
[ "$n" = "$size" ] || { echo "only $n of $size bytes arrived"; exit 4; }
if [ "$kind" = dir ]; then
  mkdir "$tmp.d" && tar -xf "$tmp" -C "$tmp.d" || exit 1
  if [ -e "$out" ] || [ -L "$out" ]; then echo "$(basename "$out") already exists"; exit 5; fi
  mv "$tmp.d/$(basename "$2")" "$out"
else
  ln "$tmp" "$out" 2>/dev/null || { echo "$(basename "$out") already exists"; exit 5; }
fi`;
// There (Windows), for DOWNLOAD: the size of file `path`, and the base64 of its 4 MB piece from the MB its stdin names.
const winFile = (path, body) => {
  if (!isWindowsPath(path) || /[\x00-\x1f]/.test(path)) throw new Error(`Cannot download ${path}`);
  return `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
try { ${body} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 5 }`;
};
export const windowsSize = (path) => winFile(path,
  `$i = Get-Item -LiteralPath ${psQuote(path)} -Force; if ($i.PSIsContainer) { throw "$($i.Name) is a folder" }; [Console]::Out.Write($i.Length)`);
export const windowsPiece = (path) => winFile(path, `$skip = [long][Console]::In.ReadLine()
  $f = [IO.File]::OpenRead(${psQuote(path)})
  try {
    [void]$f.Seek($skip * 1000000, 'Begin'); $buf = New-Object byte[] 4000000; $n = 0
    while ($n -lt $buf.Length) { $k = $f.Read($buf, $n, $buf.Length - $n); if ($k -le 0) { break }; $n += $k }
    [Console]::Out.Write([Convert]::ToBase64String($buf, 0, $n))
  } finally { $f.Close() }`);
// DOWNLOAD's arguments after the script's name, for machine `on`'s `path` (a folder when `dir`) coming to `out`.
export function downloadArgs(on, path, dir, out) {
  if (!isWindowsPath(path)) return [on, path, out, dir ? "dir" : "file"];
  if (dir) throw new Error("Folders on a Windows machine can't be downloaded.");
  return [on, path, out, "win", encodeCommand(windowsSize(path)), encodeCommand(windowsPiece(path))];
}

// hc(args) as Herdr's: only a drop onto another machine and a download use it.
export function createOps(exec, on = null, hc = null) {
  const run = (cmd, args) => (on ? exec(cmd, args, { on }) : exec(cmd, args)).catch((e) => {
    if (!on) throw e;
    const text = String(e?.message ?? e), short = friendlyError(text);
    throw Object.assign(new Error(short === text ? `${on}: ${text}` : short), { unreachable: true });
  });
  const must = async (cmd, args, what) => { const r = await run(cmd, args); if (r.code !== 0) throw new Error(r.stderr.trim() || what); };
  // A dangling link is there too: its name is taken and it can be deleted.
  const exists = async (p) => (await run("sh", ["-c", '[ -e "$1" ] || [ -L "$1" ]', "explorer", p])).code === 0;
  // Runs sh `script` with `args` here as a background hc terminal, past exec's 30 s, waited on 20 s at a time; the last
  // line it printed is the error (`what: <line>`).
  const background = async (prefix, script, args, what) => {
    const job = `${prefix}-${Date.now().toString(36)}`;
    const started = await hc(["run", "--bg", "--no-parent", "--name", job, "--", "sh", "-c", script, "explorer", ...args]);
    if (started.code !== 0) throw new Error(started.stderr.trim() || what);
    let end;
    do end = JSON.parse((await hc(["wait", job, "--timeout", "20", "--json"])).stdout); while (!end.ended);
    const why = end.exit_code === 0 ? "" : (await hc(["read", job])).stdout.trim().split("\n").pop();
    await hc(["rm", job]).catch(() => {});
    if (end.exit_code !== 0) throw new Error(`${what}: ${why || `exit ${end.exit_code}`}`);
  };
  return {
    exists,
    mkdir: (p) => must("mkdir", [p], "Could not create the folder"),
    move: (from, to) => must("mv", ["-n", from, to], "Rename failed"),
    newFile: (p) => must("sh", ["-c", NEW_FILE, "explorer", p], "Could not create the file"),
    remove: (p) => must("sh", ["-c", REMOTE_DELETE, "explorer", p], "Could not delete"),
    // Copies or moves the clipboard's entry into `folder` under a free name; never overwrites, never into itself,
    // only on the machine it was cut or copied on. Cut into its own folder does nothing. Answers where it went (null: nowhere).
    async paste(clip, folder) {
      if ((clip.on ?? null) !== on) throw new Error("Paste between machines is not supported.");
      const src = clip.path;
      if (within(folder, src)) throw new Error(`Cannot paste ${baseName(src)} into itself.`);
      if (clip.cut && parentOf(src) === folder) return null;
      const name = await freeName(baseName(src), (n) => exists(`${folder}/${n}`), clip.dir);
      await must(clip.cut ? "mv" : "cp", [...(clip.cut ? ["-n"] : ["-R", "-n"]), src, `${folder}/${name}`], "Paste failed");
      return `${folder}/${name}`;
    },
    // A tree item dragged into `folder` keeps its name, as VS Code's move: never into itself, never over an entry of that
    // name (an error instead), nothing when it is there already. Answers where it went (null: nowhere).
    async moveInto(src, folder) {
      if (within(folder, src)) throw new Error(`Cannot move ${baseName(src)} into itself.`);
      if (parentOf(src) === folder) return null;
      const to = `${folder}/${baseName(src)}`;
      if (await exists(to)) throw new Error(`A file or folder ${baseName(src)} already exists in ${baseName(folder)}.`);
      await must("mv", ["-n", src, to], "Move failed");
      return to;
    },
    // Copies files dropped from this computer (Finder) into `folder`, each as a paste: a free name, never a move. Onto
    // another machine they upload (UPLOAD) in a background hc terminal, past exec's 30 s, waited on 20 s at a time; the
    // last line it printed is the error. Answers the copies' paths.
    async drop(paths, folder) {
      const copies = [], isDir = async (p) => (await exec("test", ["-d", p])).code === 0;
      if (!on) {
        for (const path of paths) copies.push(await this.paste({ path, dir: await isDir(path) }, folder));
        return copies;
      }
      const pairs = [];
      for (const path of paths) {
        const name = await freeName(baseName(path), (n) => copies.includes(`${folder}/${n}`) || exists(`${folder}/${n}`), await isDir(path));
        copies.push(`${folder}/${name}`); pairs.push(path, name);
      }
      await background("explorer-up", UPLOAD, [on, folder, ...pairs], `Upload to ${on} failed`);
      return copies;
    },
    // Downloads this machine's `path` (a folder when `dir`) into the local folder `to` (~/Downloads) under a free name
    // there ("a (1).txt"), in a background hc terminal (DOWNLOAD) as a drop's upload. Answers the local path.
    async download(path, dir, to) {
      const name = path.split(/[\\/]/).pop();
      const free = await freeName(name, async (n) => (await exec("sh", ["-c", '[ -e "$1" ] || [ -L "$1" ]', "explorer", `${to}/${n}`])).code === 0, dir, downloadName);
      const out = `${to}/${free}`;
      await background("explorer-down", DOWNLOAD, downloadArgs(on, path, dir, out), `Download from ${on} failed`);
      return out;
    },
  };
}
