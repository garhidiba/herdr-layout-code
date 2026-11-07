// Dragging a tab from the tab bar down into the shown tab, as VS Code drags an editor into an editor group: the
// content area below the bar splits by the pointer into left / right / top / bottom drop zones, a preview covers the
// half the tab will land in, and the release moves the dragged tab's terminal there (move.js). The tab bar only hears
// the pointer while it is over the bar, so once a drag leaves it a full-window overlay of this mod takes over (main.js
// DragOverlay). Pure rules, window coordinates (logical px). No Herdr imports, so node tests load it.

// A press becomes a drag past this many px.
export const THRESHOLD = 4;
export const dragStarted = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) > THRESHOLD;

// The shown tab's content: below the tab bar (`bar`: its bounds) and as wide, down to the window's bottom less the
// status bar (`win`: the window's size).
export const STATUS = 24;
export const contentRect = (bar, win) =>
  ({ x: bar.x, y: bar.y + bar.height, width: bar.width, height: Math.max(0, win.height - bar.y - bar.height - STATUS) });

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

// The terminal a drag of tab `id` moves into the shown tab `shown`: its one terminal pane; null for the shown tab
// itself, a gone tab, or one with more panes or a mod pane (moved one at a time from its pane menu instead).
export function dragTerminal(id, shown, panes) {
  const mine = panes.filter(p => p.tab === id);
  return id !== shown && mine.length === 1 && mine[0].terminal ? mine[0].terminal : null;
}
