// Pure rules for the Explorer: where a file opens, path text, names for new/pasted entries, the context menu's items.

const VIEWER_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?|md|markdown|mdx|mkd)$/i;
export const EDITOR = "mods/vscode-viewer/editor/vsedit.cjs";

export const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
export const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

// tab.new args: the terminal editor (started in `folder`, default the file's own), or the vscode-viewer tab
// (images, markdown, remote files, or when asked).
export function openArgs(file, { on = null, appHome, how = "auto", folder = parentOf(file) }) {
  const name = baseName(file);
  if (how === "viewer" || on || (how === "auto" && VIEWER_EXT.test(name))) return { name, mod: "vscode-viewer", props: { file, on } };
  return { name, folder, argv: ["node", `${appHome}/${EDITOR}`, file] };
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

// Context menu rows: [label, action, hint] or "-" for a separator.
export function menuItems({ dir, remote, canPaste }) {
  const local = !remote;
  const groups = [
    dir && local ? [["New File…", "newFile"], ["New Folder…", "newFolder"]] : [],
    dir ? [] : [["Open Preview", "open"], ...(local ? [["Open With…", "openWith"]] : [])],
    local ? [["Reveal in Finder", "reveal", "⌥⌘R"], ["Open in Integrated Terminal", "terminal"]] : [],
    local ? [["Cut", "cut", "⌘X"], ["Copy", "copy", "⌘C"], ...(canPaste ? [["Paste", "paste", "⌘V"]] : [])] : [],
    [["Copy Path", "copyPath", "⌥⌘C"], ["Copy Relative Path", "copyRelative", "⇧⌥⌘C"]],
    local ? [["Rename…", "rename", "↵"], ["Delete", "delete", "⌘⌫"]] : [],
  ].filter(g => g.length);
  return groups.flatMap((g, i) => (i ? ["-", ...g] : g));
}

export const OPEN_WITH = [
  ["VS Code Editor (terminal)", "editor"],
  ["Herdr Editor (viewer)", "viewer"],
  ["Open in VS Code", "code"],
  ["System Default", "system"],
];

// Popup height for rows (26px each, 9px per separator, 10px padding).
export const menuHeight = (rows) => rows.reduce((h, r) => h + (r === "-" ? 9 : 26), 10);
