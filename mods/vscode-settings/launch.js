// Opens a tab.new {name, folder, argv} tab without Herdr's login shell showing first.
// Herdr runs every tab.new argv inside the login+interactive shell (`$SHELL -lic '"$@"; exec "$0" -li'`), so the new
// tab is an empty shell while the rc files load (0.2-0.8 s). A core terminal labelled herdr.space/herdr.tab shows up
// as that tab instead (Herdr's docs: "A terminal with those labels shows up there"), started straight from `sh -c`;
// once Herdr shows it, the tab is named and selected. Mod tabs, remote spaces, an hc failure or a tab that never
// shows up go through tab.new as before.
// `local` (Settings: its files and the Rust core are on this computer) opens the tab in a space on this computer even
// while a remote space is focused: tab.new has no machine argument, only `space` (and the new tab's folder is local).
// The same file is in vscode-explorer and vscode-settings (mods are installed on their own); a test keeps them equal.
import { randomUUID } from "crypto";

// The program is looked up where the panels look (Homebrew, ~/.local), else through the login shell (nvm and the like).
const FIND = 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; command -v "$0" >/dev/null && exec "$0" "$@"; '
  + 'exec "${SHELL:-/bin/sh}" -lic \'exec "$0" "$@"\' "$0" "$@"';

// `hc` arguments for tab.new {folder, argv} as tab `tab` of `space` (ids on this machine).
export function directRun({ folder, argv }, { space, tab }) {
  const program = argv[0] === "exec" ? argv.slice(1) : argv; // `exec` only matters inside Herdr's shell
  return ["run", "--bg", "--json", "--no-parent", "--keep", "--cwd", folder, "--label", `herdr.space=${space}`,
    "--label", `herdr.tab=${tab}`, "--", "/bin/sh", "-c", FIND, ...program];
}

// `herdr`'s hc, run, spaces and panes; `newId` makes the tab id. Returns openTab(args, cx), awaitable.
export function createOpenTab({ hc, run, spaces, panes, local = false, newId = () => `tb${randomUUID().replaceAll("-", "")}`, wait = 3000, step = 25 }) {
  const tabsOf = (space) => spaces().find(s => s.id === space)?.tabs.map(t => t.id) ?? [];
  const hasTab = (space, tab) => tabsOf(space).includes(tab);
  return async function openTab(args, cx) {
    const all = spaces(), active = all.find(s => s.active);
    const space = local && active?.machine ? all.find(s => !s.machine) : active;
    const tabNew = () => run("tab.new", local && space ? { ...args, space: space.id } : args);
    if (!args.argv || !space) return tabNew();
    if (space.machine) return remoteTab(space.id, tabNew, cx);
    const tab = newId();
    const r = await hc(directRun(args, { space: space.id, tab })).catch(() => null);
    let address = null;
    try { address = r?.code === 0 ? JSON.parse(r.stdout).address : null; } catch {}
    if (!address) return tabNew();
    for (let waited = 0; !hasTab(space.id, tab) && waited < wait; waited += step) await cx.sleep(step);
    if (!hasTab(space.id, tab)) { await hc(["kill", address]).catch(() => null); return tabNew(); }
    if (!space.active) run("space.select", { id: space.id });
    run("tab.rename", { id: tab, name: args.name });
    run("tab.select", { id: tab });
  };

  // The editor on another machine has no herdr-app there to send its right-clicks to it: once its terminal shows up
  // in a new tab of the space, this computer does (the tab closes with the editor, so nothing gives them back).
  async function remoteTab(space, tabNew, cx) {
    const before = new Set(tabsOf(space));
    tabNew();
    const shown = () => panes().find(p => p.terminal && tabsOf(space).includes(p.tab) && !before.has(p.tab))?.terminal;
    for (let waited = 0; !shown() && waited < wait; waited += step) await cx.sleep(step);
    const terminal = shown();
    if (terminal) run("terminal.right_click", { to: "program", terminal });
  }
}
