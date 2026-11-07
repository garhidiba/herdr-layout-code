// Opens a tab.new {name, folder, argv} tab without Herdr's login shell showing first.
// Herdr runs every tab.new argv inside the login+interactive shell (`$SHELL -lic '"$@"; exec "$0" -li'`), so the new
// tab is an empty shell while the rc files load (0.2-0.8 s). A core terminal labelled herdr.space/herdr.tab shows up
// as that tab instead (Herdr's docs: "A terminal with those labels shows up there"), started straight from `sh -c`;
// once Herdr shows it, the tab is named and selected. Mod tabs, remote spaces, an hc failure or a tab that never
// shows up go through tab.new as before. Herdr takes 0.1-0.5 s to show such a tab: `warm` (vscode-explorer's
// warm.js) may hand the open to an editor started off screen ahead of time instead.
// `local` (Settings: its files and the Rust core are on this computer) opens the tab in a space on this computer even
// while a remote space is focused: tab.new has no machine argument, only `space` (and the new tab's folder is local).
// The same file is in vscode-explorer and vscode-settings (mods are installed on their own); a test keeps them equal.
import { randomUUID } from "crypto";

// The program is looked up where the panels look (Homebrew, ~/.local), else through the login shell (nvm and the like).
const FIND = 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; command -v "$0" >/dev/null && exec "$0" "$@"; '
  + 'exec "${SHELL:-/bin/sh}" -lic \'exec "$0" "$@"\' "$0" "$@"';

export const newTabId = () => `tb${randomUUID().replaceAll("-", "")}`;

// `hc` arguments for tab.new {folder, argv} as tab `tab` of `space` (ids on this machine; null `where`: no tab, off
// screen), with `labels` (k=v) too.
export function directRun({ folder, argv }, where, labels = []) {
  const program = argv[0] === "exec" ? argv.slice(1) : argv; // `exec` only matters inside Herdr's shell
  const all = [...(where ? [`herdr.space=${where.space}`, `herdr.tab=${where.tab}`] : []), ...labels];
  return ["run", "--bg", "--json", "--no-parent", "--keep", "--cwd", folder, ...all.flatMap(l => ["--label", l]),
    "--", "/bin/sh", "-c", FIND, ...program];
}

// `herdr`'s hc, run, spaces and panes; `newId` makes the tab id. Returns openTab(args, cx), awaitable.
// `warm(space, args, cx)`: the id of a tab already showing args' program (it is named and selected as a new one), or null.
// `log(fields)`: each step of a local open, for timing: { step, mode: "warm" | "cold", ms since the open began, at:
// epoch ms, name }; steps start, hc-run and shown (cold only), select.
export function createOpenTab({ hc, run, exec, spaces, panes, local = false, newId = newTabId, wait = 3000, step = 25, warm = null, log = null }) {
  const tabsOf = (space) => spaces().find(s => s.id === space)?.tabs.map(t => t.id) ?? [];
  const hasTab = (space, tab) => tabsOf(space).includes(tab);
  const routing = new Set(); // terminals whose right-click retry loop is running
  // `place` "right" / "down" (VS Code's Open to the Side): a pane beside the focused one, in its tab, instead of a tab.
  return async function openTab(args, cx, place = "tab") {
    const began = Date.now(), side = place !== "tab";
    let mode = "cold";
    const mark = (step) => log?.({ step, mode, ms: Date.now() - began, at: Date.now(), name: args.name });
    const all = spaces(), active = all.find(s => s.active);
    const space = local && active?.machine ? all.find(s => !s.machine) : active;
    const tabNew = () => (!side ? run("tab.new", local && space ? { ...args, space: space.id } : args)
      : args.argv ? run("terminal.open", { argv: args.argv, folder: args.folder, place })
      : run("pane.split", { direction: place, mod: args.mod, props: args.props }));
    if (!args.argv || !space) return tabNew();
    if (space.machine) return remoteTab(space.id, tabNew, cx);
    mark("start");
    const show = (tab) => {
      if (!space.active) run("space.select", { id: space.id });
      if (!side) run("tab.rename", { id: tab, name: args.name });
      run("tab.select", { id: tab });
      mark("select");
    };
    const warmTab = warm ? await warm(space, args, cx, place).catch(() => null) : null;
    if (warmTab) { mode = "warm"; return show(warmTab); }
    if (side) return tabNew(); // a labelled terminal shows only as a tab of its own
    const tab = newId();
    const r = await hc(directRun(args, { space: space.id, tab })).catch(() => null);
    let address = null;
    try { address = r?.code === 0 ? JSON.parse(r.stdout).address : null; } catch {}
    if (!address) return tabNew();
    mark("hc-run");
    for (let waited = 0; !hasTab(space.id, tab) && waited < wait; waited += step) await cx.sleep(step);
    if (!hasTab(space.id, tab)) { await hc(["kill", address]).catch(() => null); return tabNew(); }
    mark("shown");
    show(tab);
  };

  // The editor on another machine has no herdr-app there to send its right-clicks to it: once its terminal shows up
  // in a new tab of the space, this computer does (the tab closes with the editor, so nothing gives them back).
  // Herdr may not know the terminal yet (`{"error": "no such running terminal"}`), and run() shows a failure as a toast:
  // so herdr-app is asked through exec, again every 150 ms for 10 s, silently, one loop per terminal (as vsedit does).
  async function rightClicks(terminal, cx) {
    if (routing.has(terminal)) return;
    routing.add(terminal);
    try {
      for (let waited = 0; waited <= 10000; waited += 150) {
        const r = await exec("herdr-app", ["do", "terminal.right_click", "--to", "program", "--terminal", terminal]);
        if (r.code === 0 && !/"error"/.test(r.stdout)) return;
        await cx.sleep(150);
      }
    } catch {} finally { routing.delete(terminal); }
  }
  async function remoteTab(space, tabNew, cx) {
    const inSpace = () => panes().filter(p => tabsOf(space).includes(p.tab));
    const before = new Set(inSpace().map(p => p.pane)); // a new tab's pane, or one beside the focused pane
    tabNew();
    const shown = () => inSpace().find(p => p.terminal && !before.has(p.pane))?.terminal;
    for (let waited = 0; !shown() && waited < wait; waited += step) await cx.sleep(step);
    const terminal = shown();
    if (terminal) rightClicks(terminal, cx);
  }
}
