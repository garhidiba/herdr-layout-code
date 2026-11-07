// The Explorer menu's file operations, on this computer or on a space's machine (`on`), through Herdr's exec
// (passed in, so the tests run them here). Paths only ever go in as arguments ("$1"), never into a script's text.
// On a machine Herdr can't reach, exec rejects; that comes out as an Error with `unreachable: true` (a toast).
import { baseName, parentOf, within, freeName } from "./paths.js";

// Delete on another machine: its `trash`, else `gio trash`, else gone for good (the dialog says so first).
export const REMOTE_DELETE = 'if command -v trash >/dev/null 2>&1; then trash "$1"; elif command -v gio >/dev/null 2>&1 && gio trash "$1" 2>/dev/null; then :; else rm -rf "$1"; fi';
// A new empty file that never replaces one (noclobber).
export const NEW_FILE = 'set -C; : > "$1"';

export function createOps(exec, on = null) {
  const run = (cmd, args) => (on ? exec(cmd, args, { on }) : exec(cmd, args)).catch((e) => {
    if (!on) throw e;
    throw Object.assign(new Error(`${on}: ${e?.message ?? e}`), { unreachable: true });
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
    // Copies files dropped from this computer (Finder) into `folder`, each as a paste: a free name, never a move.
    // Nothing uploads to another machine yet, so a remote tree refuses before copying anything. Answers the copies' paths.
    async drop(paths, folder) {
      if (on) throw new Error("Dropping files onto another machine's folder is not supported yet.");
      const copies = [];
      for (const path of paths) copies.push(await this.paste({ path, dir: (await run("test", ["-d", path])).code === 0 }, folder));
      return copies;
    },
  };
}
