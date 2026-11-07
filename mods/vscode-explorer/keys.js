// The tree's keys while it holds the keyboard, as VS Code's explorer binds them on each OS ("mac" | "win" | "linux",
// remote.js keysOs). Action ids are the right-click menu's (menu.js explorerAction), plus the moves and "open".
// A key is "<mods>-<key>" with cmd/ctrl/alt/shift; cmd is the platform key, so it is spelled only for macOS.
const KEYS = {
  up: { all: ["up"] }, down: { all: ["down"] }, left: { all: ["left"] }, right: { all: ["right"] },
  open: { mac: ["space", "cmd-down"], other: ["space", "enter"] },
  rename: { mac: ["enter"], other: ["f2"] },
  copy: { mac: ["cmd-c"], other: ["ctrl-c"] },
  cut: { mac: ["cmd-x"], other: ["ctrl-x"] },
  paste: { mac: ["cmd-v"], other: ["ctrl-v"] },
  delete: { mac: ["cmd-backspace"], other: ["delete"] },
  copyPath: { mac: ["cmd-alt-c"], win: ["shift-alt-c"], linux: ["ctrl-alt-c"] },
  // Windows' is a chord (Ctrl+K Ctrl+Shift+C), which a single key press can't be.
  copyRelative: { mac: ["cmd-alt-shift-c"], linux: ["ctrl-alt-shift-c"] },
  reveal: { mac: ["cmd-alt-r"], win: ["shift-alt-r"], linux: ["ctrl-alt-r"] },
};
const MODS = { cmd: "platform", ctrl: "control", alt: "alt", shift: "shift" };

const matches = (spec, e) => {
  const parts = spec.split("-"), key = parts.pop(), m = e.modifiers ?? {};
  return e.key === key && Object.entries(MODS).every(([name, field]) => Boolean(m[field]) === parts.includes(name));
};

// The action a key press means in the tree, or null (the key then goes on as if the tree weren't there).
export function treeAction(e, os) {
  for (const [action, by] of Object.entries(KEYS)) {
    if ((by.all ?? by[os] ?? (os === "mac" ? [] : by.other) ?? []).some(spec => matches(spec, e))) return action;
  }
  return null;
}

// What an arrow does from the selected row `path` (null: none) over the shown rows: { select: path } or
// { toggle: path } (open or close a folder), or null. ↑/↓ step (from nothing, the first row); → opens a folder, then
// goes to its first child; ← closes an open folder, else goes to the folder above.
export function step(rows, path, action) {
  if (!rows.length) return null;
  const i = rows.findIndex(r => r.path === path), r = rows[i];
  if (i < 0) return { select: rows[0].path };
  if (action === "up" || action === "down") return { select: rows[Math.max(0, Math.min(rows.length - 1, i + (action === "up" ? -1 : 1)))].path };
  if (action === "right") return !r.dir ? null : !r.open ? { toggle: r.path } : rows[i + 1]?.depth > r.depth ? { select: rows[i + 1].path } : null;
  if (action === "left") {
    if (r.dir && r.open) return { toggle: r.path };
    const parent = r.path.slice(0, r.path.lastIndexOf("/"));
    return parent && rows.some(p => p.path === parent) ? { select: parent } : null;
  }
  return null;
}
