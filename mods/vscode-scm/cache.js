// What survives a restart and what the background preload needs: no Herdr imports, so node tests load it.

// The root location() gives a space shown fresh: its first terminal's folder, else the space folder.
export function freshRoot(space, panes) {
  const tabs = new Set((space?.tabs ?? []).map(t => t.id));
  const first = panes.find(p => tabs.has(p.tab) && p.terminal && p.cwd);
  return { cwd: first?.cwd || space?.folder, on: space?.machine ?? null };
}

export const KEEP = 30, MAX_AGE = 7 * 864e5, MAX_CHARS = 1e6;

// The newest rows of a Map whose values carry `at`: under 7 days old, at most 30, within `budget` characters.
function newest(map, now, budget, toJSON) {
  const parts = [], kept = new Set();
  let size = 0;
  for (const [key, v] of [...map].filter(([, v]) => now - (v.at ?? 0) < MAX_AGE).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP)) {
    const part = JSON.stringify([key, toJSON(v)]);
    if (size + part.length > budget) break;
    parts.push(part); kept.add(key); size += part.length;
  }
  return { text: `[${parts.join(",")}]`, kept, size };
}

// A repo's cache without the graph lanes (recomputed on load) or files still loading.
const repoJSON = (c) => {
  const files = [...c.commitFiles].filter(([, f]) => Array.isArray(f)), loaded = new Set(files.map(([h]) => h));
  return {
    at: c.at, files: c.files, limited: c.limited, hasHead: c.hasHead,
    commits: c.commits.map(({ hash, parents, refs, subject, author, date }) => ({ hash, parents, refs, subject, author, date })),
    expanded: [...c.expanded].filter(h => loaded.has(h)), commitFiles: files,
  };
};

// seen: context → { repos, at }; repoCache: repo → { at, files, commits, limited, hasHead, expanded, commitFiles };
// lastSelected/chosen: context → repo; lastRoot: space → { cwd, on }. Everything is kept for the kept contexts only,
// and the whole stays under 1,000,000 characters.
export function encode({ seen, repoCache, lastSelected, chosen, lastRoot }, now = Date.now()) {
  const contexts = newest(seen, now, MAX_CHARS / 2, (v) => v);
  const repos = newest(repoCache, now, MAX_CHARS - contexts.size, repoJSON);
  const only = (entries) => JSON.stringify(entries.filter(([k]) => contexts.kept.has(k)));
  return `{"v":1,"seen":${contexts.text},"repoCache":${repos.text},"lastSelected":${only([...lastSelected])},"chosen":${only([...chosen])},` +
    `"lastRoot":${JSON.stringify(Object.fromEntries(Object.entries(lastRoot).filter(([, l]) => contexts.kept.has(JSON.stringify(l)))))}}`;
}

// A missing, old-format or corrupt cache is an empty one (a cold load). Commits come back without lanes.
export function decode(text, now = Date.now()) {
  const empty = () => ({ seen: new Map(), repoCache: new Map(), lastSelected: new Map(), chosen: new Map(), lastRoot: {} });
  try {
    const data = JSON.parse(text);
    if (data?.v !== 1) return empty();
    const fresh = (rows) => rows.filter(([, v]) => now - v.at < MAX_AGE);
    return {
      seen: new Map(fresh(data.seen).filter(([, v]) => Array.isArray(v.repos))),
      repoCache: new Map(fresh(data.repoCache).filter(([, c]) => Array.isArray(c.files) && Array.isArray(c.commits)).map(([k, c]) => [k, { ...c, expanded: new Set(c.expanded), commitFiles: new Map(c.commitFiles) }])),
      lastSelected: new Map(data.lastSelected), chosen: new Map(data.chosen), lastRoot: { ...data.lastRoot },
    };
  } catch { return empty(); }
}
