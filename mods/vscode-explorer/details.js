// Remote editors' argv and labels. Herdr's terminals() rows for another machine's terminals may carry neither (hc ls
// --json lists them without), so the file an editor there shows (paths.js editorFileOf) comes from one `hc get --json`
// per remote terminal whose pane title is an editor's (isEditorTitle), kept while that pane shows it. A failed ask is
// tried again after RETRY. No Herdr imports, so node tests load it.
import { isEditorTitle } from "./paths.js";

export const RETRY = 10000;

// hc(args) as Herdr's; publish(details) gets { [address]: { argv, labels } } whenever it changes. Returns
// update(terminals, panes) (cheap: call it on every draw).
export function createDetails({ hc, publish, now = Date.now }) {
  const got = {}, failed = new Map(), asking = new Set();
  return function update(terminals, panes) {
    const listed = new Set(terminals.filter(t => Array.isArray(t.argv)).map(t => t.address));
    const want = new Set(panes.filter(p => p.terminal?.includes("/") && isEditorTitle(p.title) && !listed.has(p.terminal)).map(p => p.terminal));
    let changed = false;
    for (const a of Object.keys(got)) if (!want.has(a)) { delete got[a]; changed = true; }
    for (const a of want) {
      if (a in got || asking.has(a) || now() - (failed.get(a) ?? -Infinity) < RETRY) continue;
      asking.add(a);
      hc(["get", a, "--json"]).then(r => (r.code === 0 ? JSON.parse(r.stdout) : null)).catch(() => null).then(t => {
        asking.delete(a);
        if (!Array.isArray(t?.argv)) return failed.set(a, now());
        failed.delete(a);
        got[a] = { argv: t.argv, labels: t.labels ?? {} };
        publish({ ...got });
      });
    }
    if (changed) publish({ ...got });
  };
}
