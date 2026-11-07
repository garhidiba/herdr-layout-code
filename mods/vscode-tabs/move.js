// Moving a pane between tabs: an editor (or any terminal, or a viewer) joins another tab of its space beside that
// tab's pane, or leaves a shared tab for a new tab of its own. A terminal moves: Herdr's terminal.park takes its pane
// away (it keeps running), terminal.keep gives it one again, as a new tab or right/down of the focused pane. A viewer
// (a vscode-viewer mod pane, which can't be parked) is opened again there with the same file (pane.split beside the
// target, or tab.new) and then closed. Left/up are right/down and then pane.swap with that neighbour. Herdr applies
// these in the background, so each step waits for panes() to show it. The menus, the pane header (vscode-pane) and
// the tab bar's drag (drag.js) ask through the shared MOVE_REQUEST; the tab bar runs it. No Herdr imports, so node
// tests load it.

// { terminal } or { pane } (a viewer), and { into: tab id (a tab of the same space) | null (a new tab),
// place: PLACES' keys | "tab", name?, at }.
export const MOVE_REQUEST = "vscode-tabs.move";
// vscode-viewer's { [pane]: { file, on } }: what each viewer pane shows (its props aren't in panes()).
export const VIEWER_FILES = "vscode-viewer.files";
// Where beside the target pane: the side terminal.keep / pane.split puts it, then the pane.swap direction.
const PLACES = { right: ["right"], down: ["down"], left: ["right", "left"], up: ["down", "up"] };
const WAIT_MS = 3000, STEP_MS = 25;

// The name a pane's new tab gets: an editor's file (its title "● a.ts — vsedit"), a viewer's file name; else none.
export function tabName(p, viewer) {
  if (viewer?.file) return viewer.file.slice(viewer.file.lastIndexOf("/") + 1);
  return /^(?:● )?(.+?) — vsedit/.exec(p?.title ?? "")?.[1] ?? null;
}

// `viewers()`: shared VIEWER_FILES.
export function createMover({ run, panes, spaces, viewers = () => ({}) }) {
  const until = async (ok, sleep) => { for (let w = 0; !ok() && w < WAIT_MS; w += STEP_MS) await sleep(STEP_MS); return ok() ?? false; };
  return async function move({ terminal = null, pane = null, into = null, place = "tab", name = null }, sleep) {
    const from = terminal ? panes().find(p => p.terminal === terminal) : panes().find(p => p.pane === pane && p.mod === "vscode-viewer");
    const viewer = !terminal && from ? viewers()?.[from.pane] : null;
    if (!from || (!terminal && !viewer?.file) || into === from.tab || (into ? !PLACES[place] : place !== "tab")) return false;
    // Beside the target tab's focused pane, else its last one; a new tab only for a pane that shares its tab.
    const there = into ? panes().filter(p => p.tab === into) : [];
    const target = there.find(p => p.focused) ?? there[there.length - 1];
    if (into ? !target : !panes().some(p => p.tab === from.tab && p.pane !== from.pane)) return false;
    const [side, swap] = PLACES[place] ?? [place];
    const title = name ?? tabName(from, viewer);
    let shown; // the moved pane's panes() row once it shows
    if (terminal) {
      run("terminal.park", { terminal });
      if (!(await until(() => !panes().some(p => p.terminal === terminal), sleep))) return false; // Herdr toasts why
      if (target) { run("tab.select", { id: into }); run("pane.focus", { pane: target.pane }); }
      run("terminal.keep", { terminal, place: side });
      shown = await until(() => panes().find(p => p.terminal === terminal), sleep);
    } else {
      const before = new Set(panes().map(p => p.pane)), props = { file: viewer.file, on: viewer.on ?? null };
      const space = spaces().find(s => s.tabs.some(t => t.id === from.tab));
      if (target) run("pane.split", { direction: side, pane: target.pane, mod: "vscode-viewer", props });
      else run("tab.new", { name: title, space: space?.id, mod: "vscode-viewer", props });
      shown = await until(() => panes().find(p => p.mod === "vscode-viewer" && !before.has(p.pane) && (!into || p.tab === into)), sleep);
      if (shown) run("pane.close", { pane: from.pane });
    }
    if (!shown) return false;
    run("tab.select", { id: shown.tab });
    run("pane.focus", { pane: shown.pane });
    if (swap) run("pane.swap", { direction: swap });
    if (!into && title && terminal) run("tab.rename", { id: shown.tab, name: title }); // a viewer's tab.new named it
    // The tab it came from, if Herdr keeps it with no pane left.
    if (!panes().some(p => p.tab === from.tab) && spaces().some(s => s.tabs.some(t => t.id === from.tab))) run("tab.close", { id: from.tab });
    return true;
  };
}
