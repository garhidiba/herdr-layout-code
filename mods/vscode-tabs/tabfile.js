// Which file a tab shows, for its right-click menu. No Herdr imports, so node tests load it.

// vscode-explorer's tab menu popup (its menu.js TabMenu): rows of 26px, separators of 9px, 10px padding, as its
// paths.js menuHeight gives for tabMenuItems (a fixed set of rows; the test checks it).
export const TAB_MENU = { width: 300, height: 332 };

// The file tab `id` of `space` shows, as the tab menu's props: { tab, file, on, pane, argv, root }. An editor tab is a
// terminal running the editor launcher (vsedit.sh, as vscode-explorer's paths.js editorFileOf reads it: a mod can't
// import another mod's files), its file the argument after it and `argv` the launcher's arguments; a viewer tab is the
// vscode-viewer pane that shared itself as focused (`viewer`, its { pane, file, on }). null for any other tab, which
// keeps Herdr's menu. `root` (Copy Relative Path, Reopen's folder): the editor's folder, which is the Explorer root it
// was opened from, else the space's first terminal's folder, else the space folder.
export function tabFileOf(id, space, panes, terminals, viewer) {
  const tabs = new Set((space?.tabs ?? []).map(t => t.id)), on = space?.machine ?? null;
  const spaceRoot = panes.find(p => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd || space?.folder || null;
  const mine = panes.filter(p => p.tab === id);
  for (const p of mine) {
    const argv = p.terminal ? terminals.find(t => t.address === p.terminal)?.argv : null;
    const i = Array.isArray(argv) ? argv.findIndex(a => /(^|[\\/])vsedit\.sh$/.test(a)) : -1, file = i >= 0 ? argv[i + 1] : null;
    if (typeof file === "string" && file && !file.startsWith("-")) return { tab: id, file, on, pane: p.pane, argv: argv.slice(i), root: p.cwd || spaceRoot };
  }
  const v = viewer?.file && mine.find(p => p.mod === "vscode-viewer" && p.pane === viewer.pane);
  return v ? { tab: id, file: viewer.file, on: viewer.on ?? null, pane: v.pane, argv: null, root: spaceRoot } : null;
}

// An editor's terminal title (vsedit's OSC 2: "a.ts — vsedit", "● a.ts — vsedit" while a file in it is unsaved, then
// " (closing)" while its close dialog asks): "clean", "dirty" or "closing"; null for any other program's title.
export function editorTitleState(title) {
  const m = /^(● )?.+ — vsedit( \(closing\))?$/.exec(title ?? "");
  return m ? (m[2] ? "closing" : m[1] ? "dirty" : "clean") : null;
}

// A pane (panes() row) running an editor with unsaved changes, its close dialog asking or not.
export const isUnsaved = (p) => ["dirty", "closing"].includes(editorTitleState(p?.title));

// The tabs of `space` whose editor has unsaved changes (VS Code's dirty editors), from panes() alone: the tab bar
// reads it on every render.
export function dirtyTabs(space, panes) {
  const tabs = new Set((space?.tabs ?? []).map(t => t.id));
  return new Set(panes.filter(p => tabs.has(p.tab) && p.terminal && isUnsaved(p)).map(p => p.tab));
}
