// The memo's pure rules: where a space's memo lives, the button's and the panel's rects (window coordinates, logical
// px) while they are dragged, moved or resized, and the .gitignore line that keeps the memo out of git. No Herdr
// imports, so node tests load it.

// Each space's memo, under its folder.
export const MEMO = ".herdr/memo.md";

// The button's size; the panel's default and smallest size.
export const BUTTON = 40;
export const PANEL = { width: 440, height: 340 };
export const MIN = { width: 260, height: 160 };

// A press becomes a drag past this many px (vscode-tabs' drag.js THRESHOLD).
export const dragStarted = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) > 4;

// A space's memo: { folder, on, path }. The folder is where the space's terminals start (`folder`), else its first
// terminal's (vscode-explorer's cache.js freshRoot, the other way round, so a `cd` doesn't move the memo); null
// without either.
export function memoTarget(space, panes) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map(t => t.id));
  const cwd = panes.find(p => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd;
  const folder = (space.folder || cwd || "").replace(/\/+$/, "");
  return folder ? { folder, on: space.machine ?? null, path: `${folder}/${MEMO}` } : null;
}

// `r` kept inside the window `win` ({ width, height }), no larger than it; with the window's size unknown, only off
// its top and left edges.
export function clampRect(r, win) {
  if (!win?.width || !win?.height) return { ...r, x: Math.max(0, r.x), y: Math.max(0, r.y) };
  const width = Math.min(r.width, win.width), height = Math.min(r.height, win.height);
  return {
    x: Math.round(Math.min(Math.max(0, r.x), win.width - width)), y: Math.round(Math.min(Math.max(0, r.y), win.height - height)),
    width: Math.round(width), height: Math.round(height),
  };
}

// `r` after the pointer moved by (dx, dy) holding `edge`: "move" (the title bar, the button), or the border's side or
// corner ("n", "se", …). The opposite side stays put; no smaller than `min`.
export function dragRect(r, edge, dx, dy, min = { width: 0, height: 0 }) {
  if (edge === "move") return { ...r, x: r.x + dx, y: r.y + dy };
  let { x, y, width, height } = r;
  if (edge.includes("e")) width = Math.max(min.width, r.width + dx);
  if (edge.includes("s")) height = Math.max(min.height, r.height + dy);
  if (edge.includes("w")) { width = Math.max(min.width, r.width - dx); x = r.x + r.width - width; }
  if (edge.includes("n")) { height = Math.max(min.height, r.height - dy); y = r.y + r.height - height; }
  return { x, y, width, height };
}

// The button's spot is kept as its distance from the window's right and bottom edges, so it stays in its corner as
// the window resizes. First: 16 px in from the right, 16 px above the status bar (layouts/vscode.json: 28 px).
export const DEFAULT_POS = { right: 16, bottom: 28 + 16 };
// The button's rect in window `win` for its spot `pos` ({ right, bottom }; an older { x, y } as is), inside the window.
export function buttonRect(pos, win) {
  const p = pos?.right != null || pos?.x != null ? pos : DEFAULT_POS;
  const x = p.right != null ? win.width - p.right - BUTTON : p.x, y = p.bottom != null ? win.height - p.bottom - BUTTON : p.y;
  return clampRect({ x, y, width: BUTTON, height: BUTTON }, win);
}
// The spot to keep for a button at `r`.
export const buttonPos = (r, win) => ({ right: Math.round(win.width - r.x - r.width), bottom: Math.round(win.height - r.y - r.height) });

const inside = (r, p) => !!r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
// Whether a press at `pos` closes the panel: an unpinned one, pressed outside it and outside the button (which toggles
// it itself). Its title bar and border are inside: moving and resizing never close it.
export const closesOnPress = (pos, { panel, button, pinned }) => !pinned && !!panel && !inside(panel, pos) && !inside(button, pos);

// Where the panel opens: where it was left, else above the button and to its left, its right edge at the button's.
export function panelRect(saved, button, win) {
  return clampRect(saved ?? { x: button.x + button.width - PANEL.width, y: button.y - 8 - PANEL.height, ...PANEL }, win);
}

// Lines that already ignore the memo when git can't say (no git, not a repo).
const IGNORES = new Set([MEMO, `/${MEMO}`, ".herdr", "/.herdr", ".herdr/", "/.herdr/", ".herdr/*", "/.herdr/*", "**/.herdr/"]);

// What to append to a .gitignore holding `text` so the memo is ignored, or null if it already is. `git`: what
// `git check-ignore` said (true ignored, false not), null when it couldn't tell (then a line match decides).
export function gitignoreAddition(text, git) {
  if (git === true) return null;
  if (git === null && text.split(/\r?\n/).some(l => IGNORES.has(l.trim()))) return null;
  return `${text && !text.endsWith("\n") ? "\n" : ""}${MEMO}\n`;
}

// The memo editor's settings over the user's vscode-settings.json (`text`, comments and trailing commas allowed, as
// vscode-explorer's paths.js settingsOf): the same editor (its engine, keys, look), cut down to a document editor.
// vsedit.sh and both editors read the file VSEDIT_SETTINGS names.
export const MEMO_SETTINGS = {
  "editor.wordWrap": "on",
  "files.autoSave": "afterDelay", "files.autoSaveDelay": 0.5,
  "breadcrumbs.enabled": false, "editor.hover.enabled": false, "editor.codeLens": false,
  "extensions.ignoreRecommendations": true, "editor.inlineSuggest.provider": "off",
};
export function memoSettings(text) {
  let user = {};
  try {
    user = JSON.parse(String(text ?? "").replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1")) ?? {};
  } catch {}
  return `${JSON.stringify({ ...user, ...MEMO_SETTINGS }, null, 2)}\n`;
}
