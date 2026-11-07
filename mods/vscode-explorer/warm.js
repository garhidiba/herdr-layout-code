// Warm editor tabs. Herdr shows a labelled terminal as a tab 0.1-0.5 s after it starts (launch.js), most of the wait
// when a file opens. So each local space keeps one hidden tab whose editor already runs with no file (`vsedit.sh
// --warm <key>`: terminal.cjs waitForFile, warm.rs): opening a file hands it the file and shows that tab, and the
// next one starts behind it. The tab is settled (tab.next / tab.prev skip it) and listed in the shared value WARM,
// whose tabs vscode-tabs leaves out. workbench.editor.preloadEditor: false in vscode-settings.json turns it off.
// Remote spaces open as before. No Herdr imports, so node tests load it.
import { directRun, newTabId } from "./launch.js";
import { EDITOR, FILE_LABEL, editorFileOf, settingsOf } from "./paths.js";

// { [space id]: { tab, key, address } }: each local space's warm tab (address null while it starts). Shared, so any copy
// of the Explorer (the tree, its menus) can hand it a file; the tree starts and ends them (fill).
export const WARM = "vscode-explorer.warm";
// The terminal label of a warm editor, until it is handed a file (then it gets paths.js FILE_LABEL).
export const WARM_LABEL = "vscode.warm";
// Shared: whether to log each open's steps (vscode-settings.json's workbench.editor.openTimingLog).
export const TIMING = "vscode-explorer.openTiming";
export const PRELOAD_KEY = "workbench.editor.preloadEditor", TIMING_KEY = "workbench.editor.openTimingLog";
// After a warm editor fails to start or ends by itself, the next try waits this long.
export const RETRY_MS = 30000;

// Hands file and folder to the warm editor of <key> ($1): written to <key>, then SIGUSR2 to the pid in <key>.pid,
// which the editor writes once it can take one. Fails (nonzero) when it isn't ready or is gone.
const HANDOFF = 'pid=$(cat "$1.pid" 2>/dev/null) && [ -n "$pid" ] && printf "%s\\n%s\\n" "$2" "$3" > "$1.tmp" && mv "$1.tmp" "$1" && kill -USR2 "$pid"';

export function createWarmPool({ hc, run, exec, spaces, terminals, machines, shared, setShared, appHome, home, readTextFile,
  newId = newTabId, now = Date.now, wait = 3000, step = 25 }) {
  const dir = () => `${appHome()}/.vscode-warm`;
  const launcher = () => `${appHome()}/${EDITOR}`;
  const entries = () => ({ ...(shared(WARM) ?? {}) });
  const put = (space, entry) => {
    const all = entries();
    if (entry) all[space] = entry; else delete all[space];
    setShared(WARM, all);
  };
  const end = ({ address, key }) => {
    if (address) hc(["kill", address]).catch(() => {});
    exec("rm", ["-f", key, `${key}.pid`]).catch(() => {});
  };
  const spaceOf = (id) => spaces().find(s => s.id === id);
  let filling = false, retryAt = 0, swept = false, enabled = true; // enabled: as the last pass read it

  // The id of `space`'s warm tab, handed tab.new `args` (the Explorer's local editor: paths.js openArgs), unsettled and
  // moved last as a new tab would be; null when there is none ready or args are another program's (the open goes on
  // as before). A tab that can't take it is ended.
  async function claim(space, args) {
    const w = entries()[space.id], file = editorFileOf(args.argv);
    const editor = file && JSON.stringify(args.argv) === JSON.stringify(["exec", "sh", launcher(), file, "--close-on-exit"]);
    if (!editor || space.machine || !w?.address || !space.tabs.some(t => t.id === w.tab)) return null;
    put(space.id, null); // taken: nothing else hands it a file, and fill() starts the next one
    const r = await exec("sh", ["-c", HANDOFF, "warm", w.key, file, args.folder ?? ""]).catch(() => null);
    if (r?.code !== 0) { end(w); return null; }
    hc(["label", w.address, `${WARM_LABEL}=`, `${FILE_LABEL}=${file}`]).catch(() => {});
    run("tab.unsettle", { id: w.tab });
    run("tab.move", { id: w.tab, index: space.tabs.length });
    return w.tab;
  }

  // Whether fill() has work: null for none, else how long to wait first (a space left with only its warm tab: at once).
  function due() {
    if (filling) return null;
    const all = entries(), live = spaces();
    let later = !swept || (enabled && now() >= retryAt && live.some(s => !s.machine && !all[s.id]));
    for (const [id, w] of Object.entries(all)) {
      const s = live.find(x => x.id === id);
      if (s?.tabs.length === 1 && s.tabs[0].id === w.tab) return 0;
      if (!s?.tabs.some(t => t.id === w.tab)) later = true;
    }
    return later ? 500 : null;
  }

  // One pass: reads the settings, ends warm tabs that are off, gone or alone in their space (and, once this computer's
  // layout is read, warm editors left from before: after a restart), then starts one for each local space without.
  async function fill(cx) {
    if (filling) return;
    filling = true;
    try {
      const settings = settingsOf(await readTextFile(`${appHome()}/vscode-settings.json`).catch(() => null));
      enabled = settings[PRELOAD_KEY] !== false;
      if (shared(TIMING) !== (settings[TIMING_KEY] === true)) setShared(TIMING, settings[TIMING_KEY] === true);
      if (!swept && machines().find(m => m.name === null)?.layout === "ready") {
        swept = true;
        const mine = new Set(Object.values(entries()).map(w => w.tab));
        for (const t of terminals()) {
          const tab = t.labels?.["herdr.tab"];
          if (t.labels?.[WARM_LABEL] && !String(t.address).includes("/") && !mine.has(tab)) end({ address: t.address, key: `${dir()}/${tab}` });
        }
      }
      for (const [id, w] of Object.entries(entries())) {
        const s = spaceOf(id), shown = s?.tabs.some(t => t.id === w.tab);
        if (enabled && shown && s.tabs.length > 1) continue;
        end(w);
        put(id, null);
        if (enabled && s && !shown) retryAt = now() + RETRY_MS; // it ended by itself
      }
      if (!enabled || now() < retryAt) return;
      for (const s of spaces()) {
        if (s.machine || entries()[s.id] || !s.tabs.length) continue;
        if (!(await start(s, cx))) { retryAt = now() + RETRY_MS; return; }
      }
    } finally { filling = false; }
  }

  // Starts `space`'s warm tab: listed in WARM before it exists (the tab bar never shows it), settled once Herdr shows
  // it (the tab that was active stays so), claimable once settled. False when it doesn't start or show up.
  async function start(space, cx) {
    const tab = newId(), key = `${dir()}/${tab}`, before = space.tabs.find(t => t.active)?.id;
    put(space.id, { tab, key, address: null });
    const argv = ["sh", launcher(), "--warm", key, "--close-on-exit"];
    const r = await hc(directRun({ folder: space.folder || home(), argv }, { space: space.id, tab }, [`${WARM_LABEL}=1`])).catch(() => null);
    let address = null;
    try { address = r?.code === 0 ? JSON.parse(r.stdout).address : null; } catch {}
    if (!address) { put(space.id, null); return false; }
    const shown = () => spaceOf(space.id)?.tabs.find(t => t.id === tab);
    for (let waited = 0; !shown() && waited < wait; waited += step) await cx.sleep(step);
    if (!shown()) { end({ address, key }); put(space.id, null); return false; }
    run("tab.settle", { id: tab });
    if (shown().active && before && before !== tab) run("tab.select", { id: before });
    put(space.id, { tab, key, address });
    return true;
  }

  return { claim, due, fill };
}
