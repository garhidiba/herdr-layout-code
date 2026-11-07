// Pure rules for the Explorer: where a file opens, path text, names for new/pasted entries, the context menu's items.

// What the viewer previews: images. Everything else opens in the editor, as in VS Code: it reads the file's first
// bytes and shows text (any name or extension, dotfiles and files without one too) or, with NUL bytes, the hex viewer.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx|mkd)$/i;
// The editor launcher: the Rust editor when vscode-settings.json picks it (and it is built), else vsedit.cjs.
export const EDITOR = "mods/vscode-viewer/editor/vsedit.sh";

export const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
export const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

// Whether a file opens in the terminal editor (else the viewer): all but images, or when asked.
export const wantsEditor = (file, how = "auto") => how === "editor" || (how === "auto" && !IMAGE_EXT.test(baseName(file)));
export const isMarkdown = (file) => MARKDOWN_EXT.test(baseName(file));

// tab.new args: the terminal editor (started in `folder`, default the file's own), or the vscode-viewer tab
// (images, Open Preview, or when asked). Every way of opening a file goes through here, the remote ones too: a remote
// file takes the editor only with `remote` ({launcher, args}, remote.js: the bundle installed on that machine; the
// tab is in the remote space, so it runs there), else the viewer, which offers the install when `remote` is
// { install: true } (not installed there yet).
export function openArgs(file, { on = null, appHome, how = "auto", folder = parentOf(file), remote = null }) {
  const name = baseName(file);
  if (!wantsEditor(file, how) || (on && !remote?.launcher)) return { name, mod: "vscode-viewer", props: { file, on, ...(remote?.install ? { install: true } : {}) } };
  // exec: the editor replaces the tab's shell, so the tab closes when it exits (see vsedit's --close-on-exit)
  if (on) return { name, folder, argv: ["exec", "sh", remote.launcher, file, "--close-on-exit", ...remote.args] };
  return { name, folder, argv: ["exec", "sh", `${appHome}/${EDITOR}`, file, "--close-on-exit"] };
}

// The file an editor tab shows: the argument after the launcher (EDITOR, or remote.js's copy: both end in vsedit.sh) in
// its terminal's argv, however Herdr wrapped it; null for any other program.
export function editorFileOf(argv) {
  const i = Array.isArray(argv) ? argv.findIndex(a => /(^|[\\/])vsedit\.sh$/.test(a)) : -1;
  const file = i >= 0 ? argv[i + 1] : null;
  return typeof file === "string" && file && !file.startsWith("-") ? file : null;
}

// A path with repeated slashes, `.` and `..` resolved, so two spellings of one file compare equal.
export function normalPath(p) {
  const out = [];
  for (const part of String(p ?? "").split("/")) {
    if (part === "..") { if (out.length && out[out.length - 1] !== "") out.pop(); }
    else if (part !== "." && (part || !out.length)) out.push(part);
  }
  return out.join("/") || "/";
}

// The tab of `space` (a spaces() row) whose editor shows `file` on machine `on` (null: this computer), as VS Code
// goes to a file's open editor instead of opening it again; null when none. `panes` and `terminals` are Herdr's.
export function editorTabOf(file, on, space, panes, terminals) {
  const tabs = new Set((space?.tabs ?? []).map(t => t.id)), want = normalPath(file);
  const argv = new Map(terminals.map(t => [t.address, t.argv]));
  const machine = (address) => (address.includes("/") ? address.split("/")[0] : null);
  const shows = (address) => { const f = editorFileOf(argv.get(address)); return f !== null && normalPath(f) === want; };
  return panes.find(p => p.terminal && tabs.has(p.tab) && machine(p.terminal) === (on ?? null) && shows(p.terminal))?.tab ?? null;
}

// VS Code's explorer.autoReveal in vscode-settings.json (comments and trailing commas allowed, as vscode-settings'
// loose()): on unless it is false.
export function autoRevealOf(text) {
  try {
    return JSON.parse(String(text ?? "").replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"))?.["explorer.autoReveal"] !== false;
  } catch { return true; }
}

// Where the tree reveals `file`: its path below `root` and the folders to open above it, outermost first; null for a
// file outside the root (or the root itself), which leaves the tree as it is.
export function revealPath(root, file) {
  if (!root || !file) return null;
  const base = root.endsWith("/") ? root : `${root}/`;
  if (!file.startsWith(base) || file.length === base.length) return null;
  const path = file.slice(base.length), parts = path.split("/");
  return { path, folders: parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")) };
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
// Finder: Finder only sees this computer, and Copy Path already gives the remote path. Markdown adds Open Preview.
export function menuItems({ dir, remote, canPaste, markdown = false }) {
  const groups = [
    dir ? [["New File…", "newFile"], ["New Folder…", "newFolder"]]
      : [["Open", "open"], ...(markdown ? [["Open Preview", "preview"]] : []), ["Open With…", "openWith"]],
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
