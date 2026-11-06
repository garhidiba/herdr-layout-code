// Spaces the list keeps after Herdr closes them. Herdr closes a space with its
// last tab (an editor or shell exiting, the tab's ×, tab.close); the list keeps
// such a space as a "no tabs" row that reopens it. Pure (no Herdr imports) so
// it can be tested with plain node.
//
// A record: { id, name, named, folder, machine, color, live }. live false: Herdr
// closed it and the row stays. live true but missing from spaces(): its machine's
// layout isn't readable now (starting, away), so nothing is concluded.

// A space closed on purpose (the menu's Close) within this long is forgotten,
// not kept; the confirm dialog it asks first can sit open a while.
export const CLOSING_MS = 60000;

const on = (r) => r.machine ?? null;

// The list after a look at spaces(). `live`: spaces() in order as records
// (folder: where it is now); `ready`: machine names (null: this one) whose layout
// is readable; `closing`: id -> when the menu's Close was chosen for it.
// Each kept row stays after the space it followed; new spaces come in Herdr's order.
export function sync(list, live, ready, closing = {}, now = Date.now()) {
  const byId = new Map(live.map((s) => [s.id, s]));
  const kept = [];
  for (const r of list ?? []) {
    const s = byId.get(r.id);
    if (s) kept.push({ ...r, ...s, color: s.color ?? r.color, live: true });
    else if (!r.live || !ready.has(on(r))) kept.push(r);
    else if (!(now - (closing[r.id] ?? -Infinity) < CLOSING_MS)) kept.push({ ...r, live: false });
  }
  // A kept row goes only by its own reopening (adopt) or Remove from list: spaces
  // sharing its name or folder are other spaces, as VS Code's recent list keeps both.
  const after = follow(kept, (r) => byId.has(r.id));
  const known = new Map(kept.map((r) => [r.id, r]));
  const out = [...(after.get(null) ?? [])];
  for (const s of live) out.push(known.get(s.id) ?? { ...s, live: true }, ...(after.get(s.id) ?? []));
  return out;
}

// anchor id (null: the top) -> the records after it up to the next anchor.
function follow(list, isAnchor) {
  const after = new Map();
  let anchor = null;
  for (const r of list) {
    if (isAnchor(r)) anchor = r.id;
    else after.set(anchor, [...(after.get(anchor) ?? []), r]);
  }
  return after;
}

// The drawn rows with the closed spaces put back where they were: each after
// the shown row it followed in `list`. Closed ones come back as their records.
export function interleave(rows, list, idOf) {
  const ids = new Set(rows.map(idOf));
  const after = follow(list ?? [], (r) => ids.has(r.id));
  const closed = (id) => (after.get(id) ?? []).filter((r) => r.live === false);
  return [...closed(null), ...rows.flatMap((row) => [row, ...closed(idOf(row))])];
}

export const forget = (list, id) => (list ?? []).filter((r) => r.id !== id);

// A reopened space takes the kept row's place: same position, color and name.
export const adopt = (list, oldId, newId) => (list ?? []).map((r) => (r.id === oldId ? { ...r, id: newId, live: true } : r));

// Its space.move index (1 = first): after the live spaces listed before it.
export function liveIndex(list, id, liveIds) {
  const at = list.findIndex((r) => r.id === id);
  return at < 0 ? null : list.slice(0, at).filter((r) => liveIds.has(r.id)).length + 1;
}

// space.new's arguments to open a kept space again where it was.
export function reopenArgs(r) {
  return { ...(r.named ? { name: r.name } : {}), ...(r.folder ? { folder: r.folder } : {}), machine: r.machine ?? "" };
}

// Reads the stored list; anything unreadable is an empty list.
export function load(text) {
  try {
    const v = JSON.parse(text ?? "[]");
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}
