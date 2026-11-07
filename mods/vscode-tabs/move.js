// Moving a pane between tabs: an editor (or any terminal, or a viewer) joins another tab of its space beside that
// tab's pane, or leaves a shared tab for a new tab of its own. A terminal moves: Herdr's terminal.park takes its pane
// away (it keeps running), terminal.keep gives it one again, as a new tab or right/down of the focused pane. A viewer
// (a vscode-viewer mod pane, which can't be parked) is opened again there with the same file (pane.split beside the
// target, or tab.new) and then closed. Left/up are right/down and then pane.swap with that neighbour. Herdr applies
// these in the background, so each step waits for panes() to show it. The menus, the pane header (vscode-pane) and
// the tab bar's drag (drag.js) ask through the shared MOVE_REQUEST; the tab bar runs it. No Herdr imports, so node
// tests load it.

// { terminal } or { pane } (a viewer), and { into: tab id (a tab of the same space) | null (a new tab),
// place: PLACES' keys | "tab", beside?: a pane of `into` to split, name?, at }.
export const MOVE_REQUEST = "vscode-tabs.move";
// { [pane]: { file, on } }: what each viewer pane shows, since panes() has no mod props. Whoever opens a viewer
// records it (vscode-explorer's launch.js, this file; withViewer); vscode-viewer also records itself when it can.
export const VIEWER_FILES = "vscode-viewer.files";
// Where beside the target pane: the side terminal.keep / pane.split puts it, then the pane.swap direction.
const PLACES = { right: ["right"], down: ["down"], left: ["right", "left"], up: ["down", "up"] };
const WAIT_MS = 3000, STEP_MS = 25;

// VIEWER_FILES `files` with pane `pane` showing { file, on }, less the panes no longer in `live` (panes() ids).
export const withViewer = (files, live, pane, { file, on = null }) =>
  ({ ...Object.fromEntries(Object.entries(files ?? {}).filter(([k]) => live.has(k))), [pane]: { file, on } });

// The one { file, on } among `known` (files viewers showed) whose file name is `name` (a viewer tab is named after
// its file when it opens), or null when none or several match: a last resort for a viewer nobody recorded.
export function fileByName(name, known) {
  const hits = new Map((known ?? []).filter(k => k?.file && k.file.slice(k.file.lastIndexOf("/") + 1) === name).map(k => [`${k.on ?? ""}:${k.file}`, k]));
  return name && hits.size === 1 ? [...hits.values()][0] : null;
}

// The name a pane's new tab gets: an editor's file (its title "● a.ts — vsedit"), a viewer's file name; else none.
export function tabName(p, viewer) {
  if (viewer?.file) return viewer.file.slice(viewer.file.lastIndexOf("/") + 1);
  return /^(?:● )?(.+?) — vsedit/.exec(p?.title ?? "")?.[1] ?? null;
}

// `viewerOf(pane)`: the { file, on } a viewer pane shows, or null; `remember(pane, { file, on })`: records a viewer this
// opens; `fail(reason)`: tells the person why a move stopped (nothing is said for a move with nowhere to go).
export function createMover({ run, panes, spaces, viewerOf = () => null, remember = () => {}, fail = () => {} }) {
  const until = async (ok, sleep) => { for (let w = 0; !ok() && w < WAIT_MS; w += STEP_MS) await sleep(STEP_MS); return ok() ?? false; };
  const stop = (reason) => { fail(reason); return false; };
  return async function move({ terminal = null, pane = null, into = null, place = "tab", beside = null, name = null }, sleep) {
    const from = terminal ? panes().find(p => p.terminal === terminal) : panes().find(p => p.pane === pane && p.mod === "vscode-viewer");
    if (!from || into === from.tab || (into ? !PLACES[place] : place !== "tab")) return false;
    const viewer = terminal ? null : viewerOf(from.pane);
    if (!terminal && !viewer?.file) return stop("Can't move this viewer: its file isn't known yet. Click into it and try again.");
    // Beside `beside` (the pane a drag was dropped on), else the target tab's focused pane, else its last one; a new
    // tab only for a pane that shares its tab.
    const there = into ? panes().filter(p => p.tab === into) : [];
    const target = there.find(p => p.pane === beside) ?? there.find(p => p.focused) ?? there[there.length - 1];
    if (into ? !target : !panes().some(p => p.tab === from.tab && p.pane !== from.pane)) return false;
    const [side, swap] = PLACES[place] ?? [place];
    const title = name ?? tabName(from, viewer);
    let shown; // the moved pane's panes() row once it shows
    if (terminal) {
      run("terminal.park", { terminal });
      if (!(await until(() => !panes().some(p => p.terminal === terminal), sleep))) return false; // Herdr toasts why
      if (target) {
        // keep splits the focused pane: it must be the target before keep runs, or another pane gets split.
        run("tab.select", { id: into });
        run("pane.focus", { pane: target.pane });
        if (!(await until(() => panes().find(p => p.pane === target.pane)?.focused, sleep))) {
          run("terminal.keep", { terminal, place: "tab" }); // parked: give it its tab back rather than lose it
          return stop(`Can't move ${title ?? "this pane"}: the pane to put it beside didn't take focus.`);
        }
      }
      run("terminal.keep", { terminal, place: side });
      shown = await until(() => panes().find(p => p.terminal === terminal), sleep);
    } else {
      const before = new Set(panes().map(p => p.pane)), props = { file: viewer.file, on: viewer.on ?? null };
      const space = spaces().find(s => s.tabs.some(t => t.id === from.tab));
      if (target) run("pane.split", { direction: side, pane: target.pane, mod: "vscode-viewer", props });
      else run("tab.new", { name: title, space: space?.id, mod: "vscode-viewer", props });
      shown = await until(() => panes().find(p => p.mod === "vscode-viewer" && !before.has(p.pane) && (!into || p.tab === into)), sleep);
      if (!shown) return stop(`Can't move ${title}: its new pane didn't show up.`);
      remember(shown.pane, props);
      run("pane.close", { pane: from.pane });
    }
    if (!shown) return stop(`Can't move ${title ?? "this pane"}: Herdr didn't show it again.`);
    run("tab.select", { id: shown.tab });
    run("pane.focus", { pane: shown.pane });
    // pane.swap moves the focused pane too.
    if (swap && (await until(() => panes().find(p => p.pane === shown.pane)?.focused, sleep))) run("pane.swap", { direction: swap });
    if (!into && title && terminal) run("tab.rename", { id: shown.tab, name: title }); // a viewer's tab.new named it
    // The tab it came from, if Herdr keeps it with no pane left.
    if (!panes().some(p => p.tab === from.tab) && spaces().some(s => s.tabs.some(t => t.id === from.tab))) run("tab.close", { id: from.tab });
    return true;
  };
}
