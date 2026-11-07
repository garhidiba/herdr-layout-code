// Which pane a viewer is in. Herdr gives a tab's mod no props().pane, yet moving a viewer to another tab (vscode-tabs'
// move.js) needs its pane's file. A viewer that hears the pointer or is laid out is on screen, so it is in the shown
// tab (`tab`): its one vscode-viewer pane there, or, with several, the one whose header (vscode-pane's shared bounds,
// `headers`) sits right on top of this viewer's own window `bounds`. null when that can't be told. No Herdr imports,
// so node tests load it.
export function ownPane({ panes, tab, bounds = null, headers = null }) {
  const mine = panes.filter(p => p.tab === tab && p.mod === "vscode-viewer");
  if (mine.length === 1) return mine[0].pane;
  if (!bounds) return null;
  const near = (a, b) => Math.abs(a - b) < 3;
  const hits = mine.filter(p => {
    const h = headers?.[p.pane];
    return h && near(h.x, bounds.x) && near(h.width, bounds.width) && near(h.y + h.height, bounds.y);
  });
  return hits.length === 1 ? hits[0].pane : null;
}

// How a viewer closes its own pane `pane` ([command, args]): its tab when the pane is all the tab holds (confirmed when
// that is its space's last tab, so the space stays as a gray row, as the tab's ×), else the pane alone, so the tab
// keeps its other panes. null when the pane is gone.
export function closeOwnArgs(pane, panes, spaces) {
  const tab = panes.find(p => p.pane === pane)?.tab;
  if (!tab) return null;
  if (panes.some(p => p.tab === tab && p.pane !== pane)) return ["pane.close", { pane }];
  const last = (spaces ?? []).find(s => s.tabs.some(t => t.id === tab))?.tabs.length === 1;
  return ["tab.close", last ? { id: tab, confirmed: true } : { id: tab }];
}
