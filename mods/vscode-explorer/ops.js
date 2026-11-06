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
  const exists = async (p) => (await run("test", ["-e", p])).code === 0;
  return {
    exists,
    mkdir: (p) => must("mkdir", [p], "Could not create the folder"),
    move: (from, to) => must("mv", ["-n", from, to], "Rename failed"),
    newFile: (p) => must("sh", ["-c", NEW_FILE, "explorer", p], "Could not create the file"),
    remove: (p) => must("sh", ["-c", REMOTE_DELETE, "explorer", p], "Could not delete"),
    // Copies or moves the clipboard's entry into `folder` under a free name; never overwrites, never into itself,
    // only on the machine it was cut or copied on. Cut into its own folder does nothing.
    async paste(clip, folder) {
      if ((clip.on ?? null) !== on) throw new Error("Paste between machines is not supported.");
      const src = clip.path;
      if (within(folder, src)) throw new Error(`Cannot paste ${baseName(src)} into itself.`);
      if (clip.cut && parentOf(src) === folder) return;
      const name = await freeName(baseName(src), (n) => exists(`${folder}/${n}`), clip.dir);
      await must(clip.cut ? "mv" : "cp", [...(clip.cut ? ["-n"] : ["-R", "-n"]), src, `${folder}/${name}`], "Paste failed");
    },
  };
}
