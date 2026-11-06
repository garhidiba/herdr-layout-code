// What survives a restart and what the background preload needs: no Herdr imports, so node tests load it.

// The root location() gives a space shown fresh: its first terminal's folder, else the space folder.
export function freshRoot(space, panes) {
  const tabs = new Set((space?.tabs ?? []).map(t => t.id));
  const first = panes.find(p => tabs.has(p.tab) && p.terminal && p.cwd);
  return { cwd: first?.cwd || space?.folder, on: space?.machine ?? null, space: space?.id };
}

export const KEEP = 30, MAX_AGE = 7 * 864e5, MAX_CHARS = 1e6;

// The saved trees (key → { at, folders, entries, marks }) as JSON: newest first, under 7 days old,
// at most 30 and 1,000,000 characters; lastRoot only for spaces whose project is kept.
export function encode(saved, lastRoot, now = Date.now()) {
  const parts = [], kept = new Set();
  let size = 0;
  for (const [key, s] of [...saved].filter(([, s]) => now - (s.at ?? 0) < MAX_AGE).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP)) {
    const part = JSON.stringify([key, { at: s.at, folders: [...s.folders], entries: [...s.entries], marks: s.marks }]);
    if (size + part.length > MAX_CHARS) break;
    parts.push(part); kept.add(key); size += part.length;
  }
  const roots = Object.fromEntries(Object.entries(lastRoot).filter(([, l]) => kept.has(JSON.stringify(l))));
  return `{"v":1,"saved":[${parts.join(",")}],"lastRoot":${JSON.stringify(roots)}}`;
}

// A missing, old-format or corrupt cache is an empty one (a cold load).
export function decode(text, now = Date.now()) {
  const saved = new Map(), lastRoot = {};
  try {
    const data = JSON.parse(text);
    if (data?.v !== 1) return { saved, lastRoot };
    for (const [key, s] of data.saved) if (now - s.at < MAX_AGE) saved.set(key, { at: s.at, folders: new Set(s.folders), entries: new Map(s.entries), marks: s.marks ?? {} });
    Object.assign(lastRoot, data.lastRoot);
  } catch { saved.clear(); }
  return { saved, lastRoot };
}
