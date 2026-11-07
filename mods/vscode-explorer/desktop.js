// A remote editor's inline suggestions come from the desktop typing in it (vscode-viewer/editor/inline.cjs, VS Code
// Remote's way), so the provider's address, model and key stay this desktop's:
// - per remote machine with an editor tab open, link.cjs (vscode-viewer/editor) runs here as an hc terminal (no Herdr
//   labels, so it shows nowhere), tunnelling this desktop's suggestion proxy to that machine's 127.0.0.1 over ssh; it is
//   ended once no editor is left there (and ends itself when the tunnel drops; the next pass starts it again);
// - this window, active with a remote editor focused, marks this desktop as that machine's `active` one, so the editor
//   asks it and no other: of several desktops showing the same terminal, the last to focus it wins.
// A machine reached through a command (hc machine add --via) has no ssh to tunnel: its editors get no suggestions.
// No Herdr imports, so node tests load it.
import { editorFileOf, isEditorTitle } from "./paths.js";

export const DESKTOPS = ".local/share/herdr-vscode/desktops"; // under the machine's $HOME (link.cjs, remote-vsedit.sh)
// There: `active` = $1 (a hex id), through a temp file and a rename.
export const MARK = `d="$HOME/${DESKTOPS}"; mkdir -p "$d" && printf '%s\\n' "$1" > "$d/active.$$" && mv -f "$d/active.$$" "$d/active"`;
// Here, as an hc terminal: $1 the Herdr home (the settings the proxy reads), then link.cjs and its arguments. Herdr's
// PATH may leave node out.
export const LINK = 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH" HERDR_APP_HOME=$1; export PATH HERDR_APP_HOME; shift; exec node "$@"';

// hc terminal names are 1-32 of a-z 0-9 - _: one per machine, from its name's FNV-1a over UTF-8 bytes (read off
// encodeURIComponent: Herdr's QuickJS has no TextEncoder).
export function linkName(machine) {
  let h = 0x811c9dc5;
  const s = encodeURIComponent(machine);
  for (let i = 0; i < s.length; i++) {
    const c = s[i] === "%" ? parseInt(s.slice(i + 1, i + 3), 16) : s.charCodeAt(i);
    if (s[i] === "%") i += 2;
    h = Math.imul(h ^ c, 0x01000193) >>> 0;
  }
  return `vscode-link-${h.toString(16).padStart(8, "0")}`;
}

// The machines with an editor open (a remote terminal's address is "<machine>/t7"): from its terminals() row's argv or
// labels, or from its pane's title (paths.js isEditorTitle), which needs neither.
export const editorMachines = (terminals, panes = []) => new Set([
  ...terminals.filter(t => editorFileOf(t.argv, t.labels)).map(t => t.address),
  ...panes.filter(p => isEditorTitle(p.title)).map(p => p.terminal),
].filter(a => a?.includes("/")).map(a => a.split("/")[0]));

// One pass: the links to start ({ machine, name, target }) and to end (names), from the machines with an editor open
// (`wanted`), `hc machine ls` rows and the live hc terminals' names. A machine reached through a command, or not
// connected now, is left (`via` lists the first).
export function plan(wanted, machines, running) {
  const start = [], stop = [], via = [];
  for (const m of machines) {
    const name = linkName(m.name), on = running.has(name);
    if (!wanted.has(m.name)) { if (on) stop.push(name); }
    else if (m.via) via.push(m.name);
    else if (!on && m.state === "connected" && m.target) start.push({ machine: m.name, name, target: m.target });
  }
  return { start, stop, via };
}

const ID = /^[0-9a-f]{1,64}$/;
// hc(args) and exec(cmd, args, {on}) as Herdr's (resolve {code, stdout, stderr}); appHome() Herdr's home; notify a toast.
// Returns sync(terminals, panes) (the 10s pass) and mark(machine | null) (each draw: the machine of the editor focused in an
// active window).
export function createDesktop({ hc, exec, appHome, notify }) {
  let id = null, marked = null, syncing = false;
  const told = new Set();
  const json = async (args) => { try { const r = await hc(args); return r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
  // This desktop: its hc core's id.
  async function desktopId() {
    if (!id) { const s = await json(["server", "status", "--json"]); if (ID.test(s?.core?.id ?? "")) id = s.core.id; }
    return id;
  }

  async function sync(terminals, panes) {
    const wanted = editorMachines(terminals, panes);
    if (syncing) return;
    syncing = true;
    try {
      const [list, machines, me] = await Promise.all([json(["ls", "--json"]), json(["machine", "ls", "--json"]), desktopId()]);
      if (!list || !machines || !me) return;
      const running = new Set((list.terminals ?? []).filter(t => t.state === "live" && t.name).map(t => t.name));
      const { start, stop, via } = plan(wanted, machines.machines ?? [], running);
      for (const m of via) if (!told.has(m)) {
        told.add(m);
        notify({ title: `No inline suggestions in ${m}'s editor`, body: "They come from this computer through an ssh tunnel, and that machine is reached through a command.", level: "info" });
      }
      await Promise.all([
        ...stop.map(name => hc(["kill", name]).catch(() => {})),
        ...start.map(l => hc(["run", "--bg", "--no-parent", "--rm", "--name", l.name, "--", "sh", "-c", LINK, "herdr-vscode", appHome(),
          `${appHome()}/mods/vscode-viewer/editor/link.cjs`, l.target, me]).then(r => {
          // hc refusing the link is otherwise silent (each pass just tries again): said once per machine
          if (r.code === 0 || told.has(l.name)) return;
          told.add(l.name);
          notify({ title: `No inline suggestions in ${l.machine}'s editor`, body: `hc run failed: ${String(r.stderr ?? "").trim().slice(0, 200) || `exit ${r.code}`}`, level: "warning" });
        }).catch(() => {})),
      ]);
    } finally { syncing = false; }
  }

  async function mark(machine) {
    if (machine === marked) return;
    marked = machine;
    const me = machine && await desktopId();
    if (me && marked === machine) await exec("sh", ["-c", MARK, "herdr-vscode", me], { on: machine }).catch(() => {});
  }

  return { sync, mark };
}
