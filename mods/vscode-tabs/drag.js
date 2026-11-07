// Dragging a tab from the tab bar down into the shown tab, as VS Code drags an editor into an editor group: the
// panes' area below the bar splits by the pointer into left / right / top / bottom drop zones, a preview covers the
// half the tab will land in, and the release moves the dragged tab's pane there (move.js). The tab bar only hears
// the pointer while it is over the bar, so once a drag leaves it a full-window overlay of this mod takes over (main.js
// DragOverlay). Pure rules, window coordinates (logical px). No Herdr imports, so node tests load it.

// A press becomes a drag past this many px.
export const THRESHOLD = 4;
export const dragStarted = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) > THRESHOLD;

// A node of a layout tree (layout(), layouts/*.json) by id, or null.
export function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The shown tab's panes: below the tab bar (`bar`: its bounds; it spans the work column, the side panel's too) inside
// layouts/vscode.json's `work-body` row (its padding), left of the side `panel` while it shows (its width and the
// row's gap), above the `status` bar; `win` is the window's size, `tree` the shown layout. The sidebar (spaces) is
// left of the bar already.
export function panesRect(bar, win, tree) {
  const body = find(tree, "work-body"), panel = find(tree, "panel"), status = find(tree, "status");
  const pad = body?.padding ?? 0, gap = body?.gap ?? 0;
  const side = panel && !panel.hidden ? (panel.size?.px ?? 0) + gap : 0;
  const top = bar.y + bar.height + pad, bottom = win.height - (status && !status.hidden ? status.size?.px ?? 0 : 0) - pad;
  return { x: bar.x + pad, y: top, width: Math.max(0, bar.width - 2 * pad - side), height: Math.max(0, bottom - top) };
}

// Each pane of the shown tab as a rect, from its header's bounds (vscode-pane shares them: `headers`, { [pane]: {x, y,
// width, height} }; Herdr gives mods no pane geometry): as wide as its header, from the header's top down to the next
// header below it in the same columns (less `gap`, layouts/vscode.json's pane gap), else to the panes' bottom
// (`area`, panesRect). `ids`: the shown tab's pane ids; panes without a header are left out.
export function paneRects(headers, ids, area, gap = 8) {
  const known = ids.filter(id => headers?.[id]).map(id => ({ pane: id, ...headers[id] }));
  return known.map(h => {
    const below = known.filter(o => o.y > h.y && o.x < h.x + h.width && o.x + o.width > h.x).map(o => o.y - gap);
    const bottom = Math.min(area.y + area.height, ...below);
    return { pane: h.pane, x: h.x, y: h.y, width: h.width, height: Math.max(0, bottom - h.y) };
  });
}

// Where a drag over the panes lands: the pane under `pos` (`rects`: paneRects) and its zone, splitting that pane; with
// no pane known there, the zone of the whole `area` (the tab's focused pane is split). null outside the panes.
export function dropTarget(rects, area, pos) {
  const r = rects.find(x => dropZone(x, pos));
  if (r) return { beside: r.pane, rect: r, zone: dropZone(r, pos) };
  const zone = dropZone(area, pos);
  return zone ? { beside: null, rect: area, zone } : null;
}

// The drop zone under `pos` in `rect`: the nearest edge, as a share of the size ("left" | "right" | "up" | "down"), or
// null outside it.
export function dropZone(rect, pos) {
  if (!rect?.width || !rect.height) return null;
  const fx = (pos.x - rect.x) / rect.width, fy = (pos.y - rect.y) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const edges = [["left", fx], ["right", 1 - fx], ["up", fy], ["down", 1 - fy]];
  return edges.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

// The half of `rect` the preview covers for `zone`.
export function zoneRect(rect, zone) {
  const w = rect.width / 2, h = rect.height / 2;
  return {
    left: { ...rect, width: w }, right: { ...rect, x: rect.x + w, width: w },
    up: { ...rect, height: h }, down: { ...rect, y: rect.y + h, height: h },
  }[zone] ?? null;
}

// What a drag of tab `id` moves into the shown tab `shown` (a move.js request's source): its one pane, a terminal
// ({ terminal }) or a viewer ({ pane }); null for the shown tab itself, a gone tab, or one with more panes (moved one
// at a time from the pane header or the tab menu instead).
export function dragSource(id, shown, panes) {
  const mine = panes.filter(p => p.tab === id);
  if (id === shown || mine.length !== 1) return null;
  return mine[0].terminal ? { terminal: mine[0].terminal } : mine[0].mod === "vscode-viewer" ? { pane: mine[0].pane } : null;
}
