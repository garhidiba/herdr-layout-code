// The Explorer menu's file operations, on this computer or on a space's machine (`on`), through Herdr's exec
// (passed in, so the tests run them here). Paths only ever go in as arguments ("$1"), never into a script's text.
// On a machine Herdr can't reach, exec rejects; that comes out as an Error with `unreachable: true` (a toast).
import { baseName, parentOf, within, freeName } from "./paths.js";
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

// hc(args) as Herdr's: only a drop onto another machine uses it.
export function createOps(exec, on = null, hc = null) {
  const run = (cmd, args) => (on ? exec(cmd, args, { on }) : exec(cmd, args)).catch((e) => {
    if (!on) throw e;
    const text = String(e?.message ?? e), short = friendlyError(text);
    throw Object.assign(new Error(short === text ? `${on}: ${text}` : short), { unreachable: true });
  });
  const must = async (cmd, args, what) => { const r = await run(cmd, args); if (r.code !== 0) throw new Error(r.stderr.trim() || what); };
  // A dangling link is there too: its name is taken and it can be deleted.
  const exists = async (p) => (await run("sh", ["-c", '[ -e "$1" ] || [ -L "$1" ]', "explorer", p])).code === 0;
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
      const job = `explorer-up-${Date.now().toString(36)}`;
      const started = await hc(["run", "--bg", "--no-parent", "--name", job, "--", "sh", "-c", UPLOAD, "explorer", on, folder, ...pairs]);
      if (started.code !== 0) throw new Error(started.stderr.trim() || "Upload failed");
      let end;
      do end = JSON.parse((await hc(["wait", job, "--timeout", "20", "--json"])).stdout); while (!end.ended);
      const why = end.exit_code === 0 ? "" : (await hc(["read", job])).stdout.trim().split("\n").pop();
      await hc(["rm", job]).catch(() => {});
      if (end.exit_code !== 0) throw new Error(`Upload to ${on} failed: ${why || `exit ${end.exit_code}`}`);
      return copies;
    },
  };
}
