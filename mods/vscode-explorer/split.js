// A file dragged from the tree onto a pane (vscode-tabs' drag overlay asks through OPEN_AT): it opens beside that pane,
// as Open to the Side does beside the focused one: the pane is focused first (terminal.keep / terminal.open /
// pane.split split the focused pane), then the file opens right / down of it; left / up are right / down and then
// pane.swap with that neighbour, as vscode-tabs' move.js. A file already open in an editor (or a viewer) of this space is
// not opened twice (two editors on one file would fight over saving): in the dropped-on tab it is only focused, from
// another tab it is moved there (move.js, through `move`). No Herdr imports, so node tests load it.

// { file, on, folder, into: the shown tab, place: "left" | "right" | "up" | "down", beside: a pane of `into` | null, at }.
export const OPEN_AT = "vscode-explorer.open-at";
const PLACES = { right: ["right"], down: ["down"], left: ["right", "left"], up: ["down", "up"] };
const WAIT_MS = 3000, STEP_MS = 25;

// `open(file, { on, folder, place }, cx)`: menu.js openFile; `openPane(file, on)`: the editor (or viewer) pane showing it
// in this space, or null; `move(request)`: asks move.js to move a terminal or a viewer (MOVE_REQUEST's shape, less `at`).
export function createSplitOpen({ run, panes, open, openPane, move }) {
  const until = async (ok, cx) => { for (let w = 0; !ok() && w < WAIT_MS; w += STEP_MS) await cx.sleep(STEP_MS); return ok() ?? false; };
  return async function openAt({ file, on = null, folder, into, beside = null, place }, cx) {
    const [side, swap] = PLACES[place] ?? [];
    const there = panes().filter(p => p.tab === into);
    const target = there.find(p => p.pane === beside) ?? there.find(p => p.focused) ?? there[there.length - 1];
    if (!file || !side || !target) return false;
    const already = openPane(file, on);
    if (already?.tab === into) { run("pane.focus", { pane: already.pane }); return true; }
    if (already) { move({ ...(already.terminal ? { terminal: already.terminal } : { pane: already.pane }), into, place, beside: target.pane }); return true; }
    run("tab.select", { id: into });
    run("pane.focus", { pane: target.pane });
    if (!(await until(() => panes().find(p => p.pane === target.pane)?.focused, cx))) return false;
    const before = new Set(panes().map(p => p.pane));
    await open(file, { on, folder, place: side }, cx);
    if (!swap) return true;
    const shown = await until(() => panes().find(p => p.tab === into && !before.has(p.pane)), cx);
    if (!shown) return false;
    run("pane.focus", { pane: shown.pane });
    if (await until(() => panes().find(p => p.pane === shown.pane)?.focused, cx)) run("pane.swap", { direction: swap });
    return true;
  };
}
