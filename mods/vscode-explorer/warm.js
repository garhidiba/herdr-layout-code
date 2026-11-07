// Warm editors. Herdr shows a labelled terminal as a tab 0.1-0.5 s after it starts (launch.js), most of the wait when
// a file opens. So each local space keeps one editor already running with no file (`vsedit.sh --warm <key>`:
// terminal.cjs waitForFile, warm.rs) in a core terminal without Herdr's space/tab labels: Herdr shows no such
// terminal, so it is never on screen. Opening a file hands it the file and gives the terminal a tab with
// terminal.keep {place: "tab"} (measured: the tab shows in 32-39 ms, the focus stays), and the next one starts behind
// it. One that shows up in a pane anyway is ended at once and none start again until the Explorer reloads.
// workbench.editor.preloadEditor: false in vscode-settings.json turns it off. Remote spaces open as before. No Herdr
// imports, so node tests load it.
import { directRun, newTabId } from "./launch.js";
import { EDITOR, FILE_LABEL, editorFileOf, settingsOf } from "./paths.js";

// { [space id]: { key, address } }: each local space's warm editor (address null while it starts). Shared, so any copy
// of the Explorer (the tree, its menus) can hand it a file; the tree starts and ends them (fill).
export const WARM = "vscode-explorer.warm";
// The terminal label of a warm editor, until it is handed a file (then it gets paths.js FILE_LABEL).
export const WARM_LABEL = "vscode.warm";
// Shared: whether to log each open's steps (vscode-settings.json's workbench.editor.openTimingLog).
export const TIMING = "vscode-explorer.openTiming";
export const PRELOAD_KEY = "workbench.editor.preloadEditor", TIMING_KEY = "workbench.editor.openTimingLog";
// After a warm editor fails to start or ends by itself, the next try waits this long.
export const RETRY_MS = 30000;
// How often a pass compares the editor build with the one the warm editors started from.
export const STAMP_MS = 10000;

// The editor build: mtime and size of the Rust binary ($1) and of every file under the JS editor folder ($2), whichever
// engine runs. Empty when stat fails (an unknown build: nothing is recycled).
export const STAMP ='S() { stat -c "%Y %s" "$@" 2>/dev/null || stat -f "%m %z" "$@" 2>/dev/null; }; S "$1"; find "$2" -type f | while IFS= read -r f; do S "$f"; done';

// The ids of warm editors started from another build than `stamp` (an entry or stamp without one is left alone).
export const staleIds = (all, stamp) => !stamp ? [] : Object.keys(all).filter(id => all[id].stamp && all[id].stamp !== stamp);

// Hands file and folder to the warm editor of <key> ($1): written to <key>, then SIGUSR2 to the pid in <key>.pid,
// which the editor writes once it can take one. Fails (nonzero) when it isn't ready or is gone.
const HANDOFF = 'pid=$(cat "$1.pid" 2>/dev/null) && [ -n "$pid" ] && printf "%s\\n%s\\n" "$2" "$3" > "$1.tmp" && mv "$1.tmp" "$1" && kill -USR2 "$pid"';

export function createWarmPool({ hc, run, exec, spaces, panes, terminals, machines, shared, setShared, appHome, home, readTextFile,
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
  const live = (address) => terminals().some(t => t.address === address);
  const readStamp = async () => {
    const r = await exec("sh", ["-c", STAMP, "stamp", `${appHome()}/vscode-core/vsedit`, `${appHome()}/mods/vscode-viewer/editor`]).catch(() => null);
    return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  const paneOf = (address) => panes().find(p => p.terminal === address);
  // enabled: as the last pass read it. broken: a warm editor showed up on screen: none start until a reload.
  let filling = false, retryAt = 0, checkAt = 0, swept = false, enabled = true, broken = false;

  // The id of the tab now showing `space`'s warm editor, handed tab.new `args` (the Explorer's local editor: paths.js
  // openArgs); null when there is none ready or args are another program's (the open goes on as before). One that
  // can't take the file or get a tab is ended.
  // `place` "right" / "down" (launch.js Open to the Side): the pane goes beside the focused one instead of a new tab.
  async function claim(space, args, cx, place = "tab") {
    const w = entries()[space.id], file = editorFileOf(args.argv);
    const editor = file && JSON.stringify(args.argv) === JSON.stringify(["exec", "sh", launcher(), file, "--close-on-exit"]);
    if (!editor || space.machine || !w?.address) return null;
    put(space.id, null); // taken: nothing else hands it a file, and fill() starts the next one
    run("terminal.keep", { terminal: w.address, place }); // the tab (or pane) while the editor opens the file
    const r = await exec("sh", ["-c", HANDOFF, "warm", w.key, file, args.folder ?? ""]).catch(() => null);
    for (let waited = 0; r?.code === 0 && !paneOf(w.address) && waited < wait; waited += step) await cx.sleep(step);
    const tab = r?.code === 0 ? paneOf(w.address)?.tab : null;
    if (!tab) { end(w); return null; }
    hc(["label", w.address, `${WARM_LABEL}=`, `${FILE_LABEL}=${file}`]).catch(() => {});
    return tab;
  }

  // Whether fill() has work: null for none, else how long to wait first (a warm editor on screen: at once).
  function due() {
    if (filling) return null;
    const all = entries(), ids = new Set(spaces().map(s => s.id));
    let later = !swept || (enabled && now() >= checkAt && Object.keys(all).length > 0) ||
       (enabled && !broken && now() >= retryAt && spaces().some(s => !s.machine && !all[s.id]));
    for (const [id, w] of Object.entries(all)) {
      if (w.address && paneOf(w.address)) return 0;
      if (!ids.has(id) || (w.address && !live(w.address))) later = true;
    }
    return later ? 500 : null;
  }

  // One pass: reads the settings, ends warm editors that are off, on screen, gone, of a closed space or started from an
  // older editor build (a reinstall; handed-over editors are no longer in the pool, so they stay), (and, once this
  // computer's layout is read, ones left from before: after a restart), then starts one for each local space without.
  async function fill(cx) {
    if (filling) return;
    filling = true;
    try {
      const settings = settingsOf(await readTextFile(`${appHome()}/vscode-settings.json`).catch(() => null));
      enabled = settings[PRELOAD_KEY] !== false;
      const stamp = enabled ? await readStamp() : null;
      checkAt = now() + STAMP_MS;
      if (shared(TIMING) !== (settings[TIMING_KEY] === true)) setShared(TIMING, settings[TIMING_KEY] === true);
      if (!swept && machines().find(m => m.name === null)?.layout === "ready") {
        swept = true;
        // `hc ls --label` (its JSON rows carry no labels); terminals() rows name the hand-off file.
        const listed = await hc(["ls", "--json", "--label", `${WARM_LABEL}=1`]).catch(() => null);
        let found = [];
        try { found = listed?.code === 0 ? JSON.parse(listed.stdout).terminals ?? [] : []; } catch {}
        const mine = new Set(Object.values(entries()).map(w => w.address));
        for (const { address } of found) {
          if (typeof address !== "string" || address.includes("/") || mine.has(address)) continue;
          const key = terminals().find(t => t.address === address)?.labels?.["vscode.key"];
          end({ address, key: key ?? `${dir()}/none` });
        }
      }
      const ids = new Set(spaces().map(s => s.id)), stale = new Set(staleIds(entries(), stamp));
      for (const [id, w] of Object.entries(entries())) {
        if (w.address && paneOf(w.address)) broken = true; // Herdr showed it: never again this session
        else if (enabled && !broken && ids.has(id) && w.address && live(w.address) && !stale.has(id)) continue;
        end(w);
        put(id, null);
        if (enabled && ids.has(id) && w.address && !stale.has(id) && !live(w.address)) retryAt = now() + RETRY_MS; // it ended by itself
      }
      if (!enabled || broken || now() < retryAt) return;
      for (const s of spaces()) {
        if (s.machine || entries()[s.id]) continue;
        if (!(await start(s, cx, stamp))) { retryAt = now() + RETRY_MS; return; }
      }
    } finally { filling = false; }
  }

  // Starts `space`'s warm editor off screen (no herdr.space/herdr.tab labels), listed at once and claimable once Herdr
  // knows the terminal (terminal.keep fails before). False when it doesn't start or isn't known in time.
  async function start(space, cx, stamp) {
    const key = `${dir()}/${newId()}`;
    put(space.id, { key, address: null, ...(stamp && { stamp }) });
    const argv = ["sh", launcher(), "--warm", key, "--close-on-exit"];
    const r = await hc(directRun({ folder: space.folder || home(), argv }, null, [`${WARM_LABEL}=1`, `vscode.key=${key}`])).catch(() => null);
    let address = null;
    try { address = r?.code === 0 ? JSON.parse(r.stdout).address : null; } catch {}
    if (!address) { put(space.id, null); return false; }
    for (let waited = 0; !live(address) && waited < wait; waited += step) await cx.sleep(step);
    if (!live(address) || paneOf(address)) { end({ address, key }); put(space.id, null); if (paneOf(address)) broken = true; return false; }
    put(space.id, { key, address, ...(stamp && { stamp }) });
    return true;
  }

  return { claim, due, fill };
}
