// Shift+click for the terminal editor. Herdr starts its own text selection on a Shift+press in a terminal and never
// hands that press to the program (no setting turns it off), so vsedit never sees Shift+click. An editor pane's header
// (main.js) sees every press in the window (on_mouse_down_out, capture phase) and writes each left press in its pane's
// text to <appHome>/data/vsedit-click/<terminal>.json for the editor to apply (vscode-viewer's editor/clicks.cjs,
// vsedit's clicks.rs): { x, y, count, at, kind: "shift" | "plain", area }. x, y: window px; at: ms since the epoch;
// area: the text box inside terminal_padding, { x, y, width, height } (height null when no header below bounds the
// pane: Herdr gives a header no pane size). A plain press also reaches the editor as SGR at a cell: the pairs of the two
// calibrate px to cells.

export const CLICK_DIR = "data/vsedit-click";

// An editor's terminal on this computer: vsedit's title ("a.ts — vsedit", as vscode-tabs' tabfile.js reads it). Remote
// terminals ("<machine>/t7") are left out: their editor runs on another machine and can't read this folder.
export const isLocalEditor = (p) => !!p?.terminal && !p.terminal.includes("/") && /^(● )?.+ — vsedit( \(closing\))?$/.test(p.title ?? "");

// The record for press `e` (a MouseButtonEvent) seen by the header at `head` (its bounds), or null: a left press below
// the header within its columns and above any header below it (`others`: the bounds of the tab's other headers, less
// `gap`, the panes' gap). Shift: "shift"; no modifier: "plain"; ⌥/Ctrl/⌘ presses reach the editor as they are.
export function clickRecord(e, head, others, pad, gap, at) {
  if (e?.button !== "left" || !e.position || !head) return null;
  const m = e.modifiers ?? {}, kind = m.shift ? "shift" : m.alt || m.control || m.platform ? null : "plain";
  if (!kind) return null;
  const { x, y } = e.position, top = head.y + head.height, right = head.x + head.width;
  const below = others.filter(o => o.y > head.y && o.x < right && o.x + o.width > head.x).map(o => o.y - gap);
  const bottom = below.length ? Math.min(...below) : null;
  if (x < head.x || x >= right || y < top || (bottom !== null && y >= bottom)) return null;
  const [px, py] = Array.isArray(pad) && pad.every(Number.isFinite) ? pad : [0, 0];
  return { x, y, count: e.click_count ?? 1, at, kind,
    area: { x: head.x + px, y: top + py, width: head.width - 2 * px, height: bottom === null ? null : bottom - top - 2 * py } };
}
