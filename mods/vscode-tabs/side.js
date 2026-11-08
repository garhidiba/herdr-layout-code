// layouts/vscode.json's `side` row: the side panel (`panel`, Explorer / Source Control; it fills the row) and the Image
// Viewer column (`image-panel`, px) side by side, so Herdr's own gutter between them trades their widths as the one
// between the panes and `side` does. The row itself has a px width, which has to follow its children: showing or hiding
// one of them would otherwise squeeze or stretch the panel. The tab bar (always shown) reconciles it on every render,
// whatever showed or hid a column (its buttons, cmd-e, the Explorer's menu, a drop on the image button). Pure rules, no
// Herdr imports, so node tests load it.
import { find, SIDE_ROW as SIDE } from "./drag.js";

export const PANEL = "panel", IMAGE = "image-panel";
// The panel's width when nothing remembers one (its old px in layouts/vscode.json).
export const PANEL_DEFAULT = 368;
// How long a reconcile waits for its own commands to show in the layout before looking again.
const SETTLE_MS = 600;

const near = (a, b) => Math.abs(a - b) < 1;
const clamp = (v, n) => Math.round(Math.min(n?.max ?? Infinity, Math.max(n?.min ?? 0, v)));

// `tree`: the shown layout; `seen`: what the last call left (null at first); `mem`: the panel's width while it is
// hidden; `at`: now (ms). Returns { commands: [[name, args]], seen, mem }: the layout commands to run, in order.
export function reconcileSide(tree, seen, mem, at) {
  const side = find(tree, SIDE), panel = find(tree, PANEL), image = find(tree, IMAGE);
  if (!side || !panel || !image) return { commands: [], seen, mem };
  const S = side.size?.px ?? 0, I = image.size?.px ?? 0, gap = side.gap ?? 0;
  // Our last commands not landed yet: the layout still shows the state before them.
  if (seen && at < seen.wait && !(near(S, seen.side) && near(I, seen.img) && Boolean(side.hidden) === seen.hidden))
    return { commands: [], seen, mem };
  const now = { panel: !panel.hidden, image: !image.hidden };
  const was = seen ?? { ...now, side: S, img: I };
  const steady = was.panel === now.panel && was.image === now.image;
  // The panel's width: what it had while it showed (the row less the column), else the remembered one.
  const width = was.panel ? S - (was.image ? I + gap : 0) : mem ?? PANEL_DEFAULT;
  const p = clamp(width, panel);
  let img = I, target;
  if (now.panel && now.image && steady && !near(I, was.img) && near(S, was.side) && p !== Math.round(width)) {
    img = clamp(S - gap - p, image); // the gutter between them dragged past the panel's min / max: the column gives
    target = S;
  } else if (!now.panel && now.image && steady && !near(S, was.side)) {
    img = clamp(S, image); // the column alone, its row dragged wider or narrower: the column follows
    target = img;
  } else target = (now.panel ? p : 0) + (now.panel && now.image ? gap : 0) + (now.image ? img : 0);
  const commands = [];
  // An older layout state kept the panel's px; as a px sibling it would no longer fill the row.
  if (panel.size?.px !== undefined) commands.push(["layout.resize", { id: PANEL, weight: 1 }]);
  const hidden = !now.panel && !now.image;
  if (hidden) target = S;
  else {
    if (!near(target, S)) commands.push(["layout.resize", { id: SIDE, px: target }]);
    if (!near(img, I)) commands.push(["layout.resize", { id: IMAGE, px: img }]);
  }
  if (hidden !== Boolean(side.hidden)) commands.push([hidden ? "layout.hide" : "layout.show", { id: SIDE }]);
  return {
    commands,
    seen: { ...now, side: target, img, hidden, wait: commands.length ? at + SETTLE_MS : 0 },
    mem: was.panel && !now.panel ? p : mem,
  };
}
