// layouts/vscode.json's `side` row: the side panel (`panel`, Explorer / Source Control; it fills the row) and the Image
// Viewer column (`image-panel`, px) side by side. The panel keeps one width, changed only by Herdr's own gutter between
// the panes and the row (within PANEL_MIN / PANEL_MAX, kept here, not in the layout); the row's px is always that width
// + the column's. The row has no gutter of its own (`resizable: false`, gap 0): Herdr's would squeeze the panel first
// and leave a frame of it before a fix. The 8 px between the two cards is a sash drawn by both mods (the Explorer's /
// Source Control's right 4 px, the column's left 4 px) that opens this mod's SideResize overlay, which sizes the column
// and the row in one handler (sashDrag): the panel slides as a block, unchanged, the panes taking the difference.
// reconcileSide keeps the row fitted after everything else: a column shown or hidden (the tab bar's buttons, cmd-e, the
// Explorer's menu, a drop on the image button), a per-scope column width, the outer gutter (the row's px changed, the
// column's not: the panel's new width). The tab bar (always shown) runs it on every render and on a short timer. Pure
// rules, no Herdr imports, so node tests load it.
import { find, SIDE_ROW as SIDE } from "./drag.js";

export const PANEL = "panel", IMAGE = "image-panel";
// The panel's width when nothing remembers one (its old px in layouts/vscode.json), and its range.
export const PANEL_DEFAULT = 368, PANEL_MIN = 280, PANEL_MAX = 900;
// The panes' narrowest, against the row growing into them.
export const MAIN_MIN = 300;
const PANEL_RANGE = { min: PANEL_MIN, max: PANEL_MAX };
// How long a reconcile waits for its own commands to show in the layout before looking again.
const SETTLE_MS = 600;

const near = (a, b) => Math.abs(a - b) < 1;
const clamp = (v, n) => Math.round(Math.min(n?.max ?? Infinity, Math.max(n?.min ?? 0, v)));

// The widest the row may be in a work column `work` px wide: its `work-body` row less padding, gap and MAIN_MIN.
export function sideMax(tree, work) {
  const body = find(tree, "work-body");
  return Number.isFinite(work) ? work - 2 * (body?.padding ?? 0) - (body?.gap ?? 0) - MAIN_MIN : Infinity;
}

// The sash's press at window x: the panel's and the column's widths then (the drag keeps the panel's), or null.
export function sashStart(tree, x) {
  const side = find(tree, SIDE), image = find(tree, IMAGE);
  if (!side?.size?.px || !image?.size?.px || image.hidden) return null;
  return { x, p: side.size.px - (side.gap ?? 0) - image.size.px, img: image.size.px };
}

// The pointer at window x in a work column `work` px wide: the column's new width (dragging left widens it) within its
// min / max and the panes' MAIN_MIN, and the row's (the kept panel + the column): both commands, sent together.
export function sashDrag(tree, from, x, work) {
  const side = find(tree, SIDE), image = find(tree, IMAGE);
  if (!from || !side || !image) return [];
  const gap = side.gap ?? 0, room = sideMax(tree, work) - from.p - gap;
  const img = Math.max(image.min ?? 0, Math.min(clamp(from.img + from.x - x, image), Math.round(room)));
  return [["layout.resize", { id: IMAGE, px: img }], ["layout.resize", { id: SIDE, px: from.p + gap + img }]];
}

// The work column's width from the window's (`win`) and the layout: less the sidebar while it shows.
export function workWidth(tree, win) {
  const sidebar = find(tree, "sidebar");
  return win - (sidebar && !sidebar.hidden ? sidebar.size?.px ?? 0 : 0);
}

// `tree`: the shown layout; `seen`: what the last call left (null at first); `mem`: the panel's width kept while it is
// hidden (shared, outlives a restart); `at`: now (ms); `max`: the row's widest (sideMax). Returns { commands:
// [[name, args]], seen, mem, missed }: the layout commands to run, in order; `missed`: the last commands' result never
// showed in the layout ({ want, got }), else null.
export function reconcileSide(tree, seen, mem, at, max = Infinity) {
  const side = find(tree, SIDE), panel = find(tree, PANEL), image = find(tree, IMAGE);
  if (!side || !panel || !image) return { commands: [], seen, mem, missed: null };
  const S = side.size?.px ?? 0, I = image.size?.px ?? 0, gap = side.gap ?? 0;
  // Our last commands not landed yet: the layout still shows the state before them.
  // (The column's width counts only when we set it: a gutter drag may be moving it meanwhile.)
  const landed = !seen?.wait || (near(S, seen.side) && (!seen.setImg || near(I, seen.img)) && Boolean(side.hidden) === seen.hidden);
  if (!landed && at < seen.wait) return { commands: [], seen, mem, missed: null };
  const missed = landed ? null : { want: { side: seen.side, img: seen.img, hidden: seen.hidden }, got: { side: S, img: I, hidden: Boolean(side.hidden) } };
  const now = { panel: !panel.hidden, image: !image.hidden };
  const steady = seen && !missed && seen.panel === now.panel && seen.image === now.image;
  const fallback = mem ?? PANEL_DEFAULT;
  // The panel's width: at first sight what it shows (out of range: an older state, the remembered one); after the
  // outer gutter moved (the row's px changed, the column's not), what it shows now; otherwise the kept one.
  const shows = S - (now.image ? I + gap : 0);
  const outer = steady && now.panel && !near(S, seen.side) && near(I, seen.img);
  let p = !seen ? (now.panel && clamp(shows, PANEL_RANGE) === Math.round(shows) ? Math.round(shows) : fallback)
    : outer ? clamp(shows, PANEL_RANGE) : seen.p ?? fallback;
  let img = clamp(I, image);
  // The column alone: the outer gutter is its own edge, so it follows the row.
  if (steady && !now.panel && now.image && !near(S, seen.side) && near(I, seen.img)) img = clamp(S, image);
  const width = () => (now.panel ? p : 0) + (now.panel && now.image ? gap : 0) + (now.image ? img : 0);
  // Past the row's widest: the side that moved gives way (the panel on the outer gutter, else the column: shown, or
  // given its scope's width).
  const over = width() - Math.max(max, 0);
  if (over > 0) {
    if (outer || !now.image) p = Math.max(PANEL_MIN, p - over);
    else img = Math.max(image.min ?? 0, img - over);
  }
  let target = width();
  const commands = [];
  // An older layout state kept the panel's px; as a px sibling it would no longer fill the row.
  if (panel.size?.px !== undefined) commands.push(["layout.resize", { id: PANEL, weight: 1 }]);
  const hidden = !now.panel && !now.image;
  let setImg = false;
  if (hidden) target = S;
  else {
    if (!near(target, S)) commands.push(["layout.resize", { id: SIDE, px: target }]);
    setImg = !near(img, I);
    if (setImg) commands.push(["layout.resize", { id: IMAGE, px: img }]);
  }
  if (hidden !== Boolean(side.hidden)) commands.push([hidden ? "layout.hide" : "layout.show", { id: SIDE }]);
  return {
    commands,
    seen: { ...now, p, side: target, img, setImg, hidden, wait: commands.length ? at + SETTLE_MS : 0 },
    mem: seen?.panel && !now.panel ? p : mem,
    missed,
  };
}
