// Moving a terminal's pane between tabs: an editor (or any terminal) joins another tab of its space beside that tab's
// pane, or leaves a shared tab for a new tab of its own. Herdr's terminal.park takes the pane away (the terminal keeps
// running), terminal.keep gives it one again: as a new tab, or right/down of the focused pane. Both finish in the
// background, so each step waits for panes() to show it. The menus ask through the shared MOVE_REQUEST (they close at
// once); the tab bar runs it. No Herdr imports, so node tests load it.

// { terminal, into: tab id (a tab of the same space) | null (a new tab), place: "right" | "down" | "tab", name?, at }.
export const MOVE_REQUEST = "vscode-tabs.move";
const WAIT_MS = 3000, STEP_MS = 25;

export function createMover({ run, panes, spaces }) {
  const paneOf = (terminal) => panes().find(p => p.terminal === terminal);
  const until = async (ok, sleep) => { for (let w = 0; !ok() && w < WAIT_MS; w += STEP_MS) await sleep(STEP_MS); return Boolean(ok()); };
  return async function move({ terminal, into = null, place = "tab", name = null }, sleep) {
    const from = paneOf(terminal);
    if (!from || into === from.tab || (into ? place === "tab" : place !== "tab")) return false;
    // Beside the target tab's focused pane, else its last one; a new tab only for a pane that shares its tab.
    const there = into ? panes().filter(p => p.tab === into) : [];
    const target = there.find(p => p.focused) ?? there[there.length - 1];
    if (into ? !target : !panes().some(p => p.tab === from.tab && p.pane !== from.pane)) return false;
    run("terminal.park", { terminal });
    if (!(await until(() => !paneOf(terminal), sleep))) return false; // Herdr toasts why
    if (target) { run("tab.select", { id: into }); run("pane.focus", { pane: target.pane }); }
    run("terminal.keep", { terminal, place });
    if (!(await until(() => paneOf(terminal), sleep))) return false;
    const tab = paneOf(terminal).tab;
    run("tab.select", { id: tab });
    run("pane.focus", { terminal });
    if (!into && name) run("tab.rename", { id: tab, name });
    // The tab it came from, if Herdr keeps it with no pane left.
    if (!panes().some(p => p.tab === from.tab) && spaces().some(s => s.tabs.some(t => t.id === from.tab))) run("tab.close", { id: from.tab });
    return true;
  };
}
