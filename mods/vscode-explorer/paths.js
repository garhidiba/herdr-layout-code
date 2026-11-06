// Pure rules for the Explorer: where a file opens, path text, names for new/pasted entries, the context menu's items.

const VIEWER_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?|md|markdown|mdx|mkd)$/i;
// The editor launcher: the Rust editor when vscode-settings.json picks it (and it is built), else vsedit.cjs.
export const EDITOR = "mods/vscode-viewer/editor/vsedit.sh";

export const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
export const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

// Whether a file opens in the terminal editor (else the viewer): code and text files, or when asked.
export const wantsEditor = (file, how = "auto") => how === "editor" || (how === "auto" && !VIEWER_EXT.test(baseName(file)));

// tab.new args: the terminal editor (started in `folder`, default the file's own), or the vscode-viewer tab
// (images, markdown, or when asked). Every way of opening a file goes through here, the remote ones too: a remote
// file takes the editor only with `remote` ({launcher, args}, remote.js: the bundle installed on that machine; the
// tab is in the remote space, so it runs there), else the viewer.
export function openArgs(file, { on = null, appHome, how = "auto", folder = parentOf(file), remote = null }) {
  const name = baseName(file);
  if (!wantsEditor(file, how) || (on && !remote)) return { name, mod: "vscode-viewer", props: { file, on } };
  // exec: the editor replaces the tab's shell, so the tab closes when it exits (see vsedit's --close-on-exit)
  if (on) return { name, folder, argv: ["exec", "sh", remote.launcher, file, "--close-on-exit", ...remote.args] };
  return { name, folder, argv: ["exec", "sh", `${appHome}/${EDITOR}`, file, "--close-on-exit"] };
}

export const relativeTo = (root, abs) => (abs === root ? "." : abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs);

// True when `target` is `dir` itself or below it (a folder can't be pasted into itself).
export const within = (target, dir) => target === dir || target.startsWith(dir + "/");

// Finder-style names for a copy: "a.txt" -> "a copy.txt", "a copy 2.txt"...; folders and dotfiles keep the whole name.
export function copyName(name, n, dir = false) {
  const dot = dir ? -1 : name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
}

// First free name in a folder: the name itself, else its copy names. `exists(name)` may be async.
export async function freeName(name, exists, dir = false) {
  if (!(await exists(name))) return name;
  for (let n = 1; n < 1000; n++) { const c = copyName(name, n, dir); if (!(await exists(c))) return c; }
  throw new Error(`No free name for ${name}`);
}

// Why a new name can't be used, or null.
export function nameProblem(name, taken) {
  if (!name.trim()) return "A file or folder name must be provided.";
  if (name.includes("/") || name.includes("\0")) return "The name can't contain a slash.";
  if (name === "." || name === "..") return `${name} is not a valid name.`;
  if (taken) return `A file or folder ${name} already exists at this location. Please choose a different name.`;
  return null;
}

// Context menu rows: [label, action, hint] or "-" for a separator. A remote entry has the same items but Reveal in
// Finder: Finder only sees this computer, and Copy Path already gives the remote path.
export function menuItems({ dir, remote, canPaste }) {
  const groups = [
    dir ? [["New File…", "newFile"], ["New Folder…", "newFolder"]] : [["Open Preview", "open"], ["Open With…", "openWith"]],
    [...(remote ? [] : [["Reveal in Finder", "reveal", "⌥⌘R"]]), ["Open in Integrated Terminal", "terminal"]],
    [["Cut", "cut", "⌘X"], ["Copy", "copy", "⌘C"], ...(canPaste ? [["Paste", "paste", "⌘V"]] : [])],
    [["Copy Path", "copyPath", "⌥⌘C"], ["Copy Relative Path", "copyRelative", "⇧⌥⌘C"]],
    [["Rename…", "rename", "↵"], ["Delete", "delete", "⌘⌫"]],
  ];
  return groups.flatMap((g, i) => (i ? ["-", ...g] : g));
}

// Open With. A remote file's terminal editor runs on its machine (remote.js; the viewer until it is installed there):
// a remote space's tabs hold only that machine's terminals. System Default is an app on this computer.
export const openWith = (remote) => remote
  ? [["VS Code Editor (terminal)", "editor"], ["Herdr Editor (viewer)", "viewer"], ["Open in VS Code", "code"]]
  : [["VS Code Editor (terminal)", "editor"], ["Herdr Editor (viewer)", "viewer"], ["Open in VS Code", "code"], ["System Default", "system"]];

// `code` arguments opening a remote path through VS Code's Remote-SSH, from the machine's `hc machine ls` row; null
// when the machine isn't plain ssh (a --via command) or its target has characters a URI authority can't take as is.
export function vscodeRemoteArgs(machine, path, dir) {
  const target = machine?.via ? null : machine?.target;
  if (!target || !/^[\w.@:-]+$/.test(target)) return null;
  const uri = `vscode-remote://ssh-remote+${target}${path.split("/").map(encodeURIComponent).join("/")}`;
  return [dir ? "--folder-uri" : "--file-uri", uri];
}

// Popup height for rows (26px each, 9px per separator, 10px padding).
export const menuHeight = (rows) => rows.reduce((h, r) => h + (r === "-" ? 9 : 26), 10);
