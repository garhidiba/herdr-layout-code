// The order of the machine headers in the list: "spaces.machineOrder" in <herdr home>/vscode-settings.json (machine
// names), written back when a header is dragged. Pure (no Herdr imports) so it can be tested with plain node.

export const KEY = "spaces.machineOrder";

// vscode-settings.json's keys (comments and trailing commas allowed, as vscode-settings' loose()); {} when unreadable.
export function settingsOf(text) {
  try {
    return JSON.parse(String(text ?? "").replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1")) ?? {};
  } catch { return {}; }
}

// The setting's machine names, once each; [] when it is missing or not a list.
export function machineOrderOf(settings) {
  const v = settings?.[KEY];
  return Array.isArray(v) ? [...new Set(v.filter((m) => typeof m === "string" && m))] : [];
}

// Other machines' names as listed: the ones in `order` first, in its order, then the rest by name (This computer is
// always above them all; the caller puts it first).
export function sortMachines(names, order = []) {
  const rank = new Map(order.map((m, i) => [m, i]));
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...names].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || byName(a, b));
}

// The setting after `from`'s header is dropped on `to`'s, among `shown` (the headers as listed): `from` lands below
// `to` when dragged down, above it when dragged up, and every shown machine is written so the rest stay where they
// are. Names in `order` not shown now (a machine away or removed) keep their place after them. Null: nothing moves.
export function dragOrder(order, shown, from, to) {
  const a = shown.indexOf(from), b = shown.indexOf(to);
  if (a < 0 || b < 0 || a === b) return null;
  const next = shown.filter((m) => m !== from);
  next.splice(b, 0, from);
  return [...next, ...order.filter((m) => !shown.includes(m))];
}

// Read-modify-write of vscode-settings.json with the order set. `io` as vscode-settings' rewrite: read() -> text|null,
// write(text, expected) rejects when the file changed since `expected` (one retry after reading again). Only plain
// JSON is rewritten: a file with comments or a syntax error throws and is never overwritten, so no comment is lost;
// the other keys and their order stay.
export async function writeMachineOrder(io, order) {
  for (let attempt = 0; ; attempt++) {
    const text = await io.read();
    const raw = text?.trim() ? JSON.parse(text.replace(/^﻿/, "")) : {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("vscode-settings.json is not a JSON object");
    try { await io.write(JSON.stringify({ ...raw, [KEY]: order }, null, 2) + "\n", text ?? null); return; }
    catch (e) { if (attempt >= 1) throw e; }
  }
}
