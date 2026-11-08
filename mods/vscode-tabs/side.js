// layouts/vscode.json's `side` row: the side panel (`panel`, Explorer / Source Control; it fills the row) and the Image
// Viewer column (`image-panel`, px) side by side, so Herdr's own gutter between them trades their widths as the one
// between the panes and `side` does. The row itself has a px width, which has to follow its children: showing or hiding
// one of them would otherwise squeeze or stretch the panel. The tab bar (always shown) reconciles it on every render and
// on a short timer, whatever showed or hid a column (its buttons, cmd-e, the Explorer's menu, a drop on the image
// button) or dragged a gutter. The panel's min / max are kept here (PANEL_MIN / PANEL_MAX), not in the layout, so
// Herdr's gutter never stops at them: dragging the column wider than the panel can give pushes the whole row (the
// panel at its min) into the panes, as the user expects of "pushing the Explorer". Pure rules, no Herdr imports, so
// node tests load it.
import { find, SIDE_ROW as SIDE } from "./drag.js";

export const PANEL = "panel", IMAGE = "image-panel";
// The panel's width when nothing remembers one (its old px in layouts/vscode.json).
export const PANEL_DEFAULT = 368, PANEL_MIN = 280, PANEL_MAX = 900;
const PANEL_RANGE = { min: PANEL_MIN, max: PANEL_MAX };
// How long a reconcile waits for its own commands to show in the layout before looking again.
const SETTLE_MS = 600;

const near = (a, b) => Math.abs(a - b) < 1;
const clamp = (v, n) => Math.round(Math.min(n?.max ?? Infinity, Math.max(n?.min ?? 0, v)));

// `tree`: the shown layout; `seen`: what the last call left (null at first); `mem`: the panel's width while it is
// hidden; `at`: now (ms). Returns { commands: [[name, args]], seen, mem, missed }: the layout commands to run, in
// order; `missed`: the last commands' result never showed in the layout ({ want, got }), else null.
export function reconcileSide(tree, seen, mem, at) {
  const side = find(tree, SIDE), panel = find(tree, PANEL), image = find(tree, IMAGE);
  if (!side || !panel || !image) return { commands: [], seen, mem, missed: null };
  const S = side.size?.px ?? 0, I = image.size?.px ?? 0, gap = side.gap ?? 0;
  // Our last commands not landed yet: the layout still shows the state before them.
  // (The column's width counts only when we set it: a gutter drag may be moving it meanwhile.)
  const landed = !seen?.wait || (near(S, seen.side) && (!seen.setImg || near(I, seen.img)) && Boolean(side.hidden) === seen.hidden);
  if (!landed && at < seen.wait) return { commands: [], seen, mem, missed: null };
  const missed = landed ? null : { want: { side: seen.side, img: seen.img, hidden: seen.hidden }, got: { side: S, img: I, hidden: Boolean(side.hidden) } };
  const now = { panel: !panel.hidden, image: !image.hidden };
  const was = seen ?? { ...now, side: S, img: I };
  const steady = was.panel === now.panel && was.image === now.image;
  // The panel's width: what it had while it showed (the row less the column), else the remembered one.
  // At first sight (a restart, an older layout state) an out-of-range width is the row not yet fitted: the remembered one.
  // (After commands that never landed, the width they were for.)
  const [rs, ri] = missed ? [seen.side, seen.img] : [S, I];
  const raw = was.panel ? rs - (was.image ? ri + gap : 0) : mem ?? PANEL_DEFAULT;
  const width = !seen && clamp(raw, PANEL_RANGE) !== Math.round(raw) ? mem ?? PANEL_DEFAULT : raw;
  const p = clamp(width, PANEL_RANGE);
  let img = I, target;
  if (now.panel && now.image && steady && !near(I, was.img) && near(S, was.side) && width > PANEL_MAX) {
    img = clamp(S - gap - p, image); // the column dragged narrower than the panel's max allows: the column stops
    target = S;
  } else if (!now.panel && now.image && steady && !near(S, was.side)) {
    img = clamp(S, image); // the column alone, its row dragged wider or narrower: the column follows
    target = img;
  } else target = (now.panel ? p : 0) + (now.panel && now.image ? gap : 0) + (now.image ? img : 0);
  const commands = [];
  // An older layout state kept the panel's px; as a px sibling it would no longer fill the row.
  if (panel.size?.px !== undefined) commands.push(["layout.resize", { id: PANEL, weight: 1 }]);
  const hidden = !now.panel && !now.image;
  let setImg = false;
  if (hidden) target = S;
  else {
    if (!near(target, S)) commands.push(["layout.resize", { id: SIDE, px: target }]);
    if (!near(img, I)) commands.push(["layout.resize", { id: IMAGE, px: img }]);
    setImg = !near(img, I);
  }
  if (hidden !== Boolean(side.hidden)) commands.push([hidden ? "layout.hide" : "layout.show", { id: SIDE }]);
  return {
    commands,
    seen: { ...now, side: target, img, setImg, hidden, wait: commands.length ? at + SETTLE_MS : 0 },
    mem: was.panel && !now.panel ? p : mem,
    missed,
  };
}
