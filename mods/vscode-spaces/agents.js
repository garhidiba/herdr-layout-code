// Which agents each space has, one entry per kind, for the icons on its row.
// Pure (no Herdr imports) so it can be tested with plain node.

// The agents mod's ranks: the most urgent status of a kind is the one it shows.
export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// A kind is the program table's key ("claude", "codex"); an agent the table
// doesn't know ("agent") goes by what it reported, so two unknown agents differ.
const kindOf = (a) => (a.program?.key && a.program.key !== "agent" ? a.program.key : a.app || a.program?.key || "agent");
const nameOf = (a) => a.program?.name || a.app || "Agent";

// agents() (space, tab, pane order) -> Map spaceId -> [{ key, program, status, names }],
// kinds in the order they first appear in that space.
export function spaceAgents(list) {
  const out = new Map();
  for (const a of list ?? []) {
    if (!a?.space) continue;
    const kinds = out.get(a.space) ?? [];
    if (!out.has(a.space)) out.set(a.space, kinds);
    const key = kindOf(a);
    const kind = kinds.find((k) => k.key === key);
    if (!kind) kinds.push({ key, program: a.program ?? null, status: a.status, names: [nameOf(a)] });
    else {
      if ((RANK[a.status] ?? 0) > (RANK[kind.status] ?? 0)) kind.status = a.status;
      kind.names.push(nameOf(a));
    }
  }
  return out;
}

// At most `max` slots: all kinds when they fit, else the first max-1 and "+N" for the rest.
export function fit(kinds, max = 3) {
  if (kinds.length <= max) return { shown: kinds, more: 0 };
  const shown = kinds.slice(0, Math.max(0, max - 1));
  return { shown, more: kinds.length - shown.length };
}

// The tooltip, one part per agent kind: "Claude Code ×2 · working, Codex · idle".
export function describe(kinds) {
  return kinds.map((k) => `${k.names[0]}${k.names.length > 1 ? ` ×${k.names.length}` : ""} · ${k.status}`).join(", ");
}
