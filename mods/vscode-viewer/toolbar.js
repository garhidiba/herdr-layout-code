// When the Image Viewer's two toolbar rows show (image.js, column and dialog alike), unless pinned: a small state
// machine over the pointer, on a clock the caller passes (ms), so tests drive it with a fake one. Pure, no imports.
//   shown after the pointer has been inside SHOW_DELAY, or at once in the top TOP_BAND px (or over the rows);
//   hidden LEAVE_HIDE after it leaves, or IDLE_HIDE after its last move inside, unless it is over the rows or a drag /
//   zoom runs (`busy`); any move shows them again, after the same delay.
// Phases: "hidden", "waiting" (shows at `at`), "shown", "leaving" (hides at `at`). The rows show in shown and leaving.
export const SHOW_DELAY = 150, LEAVE_HIDE = 1200, IDLE_HIDE = 2000, TOP_BAND = 48;

export const barsStart = () => ({ phase: "hidden", at: 0, moved: 0, over: false });
export const barsShown = (s) => s.phase === "shown" || s.phase === "leaving";

// The deadlines passed by `t`.
export function barsTick(s, t, busy = false) {
  if (s.phase === "leaving" && t >= s.at) return { ...s, phase: "hidden" };
  if (s.phase === "waiting" && t >= s.at) s = { ...s, phase: "shown" };
  if (s.phase === "shown" && !s.over && !busy && t - s.moved >= IDLE_HIDE) return { ...s, phase: "hidden" };
  return s;
}

// The pointer moved inside (a wheel counts too); `y`: its height in the view from the top, when known.
export function barsMove(s, t, y = null) {
  s = barsTick(s, t);
  const top = y !== null && y >= 0 && y < TOP_BAND;
  const phase = top || barsShown(s) ? "shown" : "waiting";
  return { ...s, phase, at: s.phase === "waiting" ? s.at : t + SHOW_DELAY, moved: t };
}

export function barsLeave(s, t) {
  s = barsTick(s, t);
  return { ...s, over: false, phase: barsShown(s) ? "leaving" : "hidden", at: t + LEAVE_HIDE };
}

// The pointer onto the rows (shown at once, kept while it stays) or off them.
export const barsOver = (s, t, on) => on ? { ...barsTick(s, t), phase: "shown", over: true, moved: t } : { ...s, over: false, moved: t };

// Ms until the rows may show or hide by themselves, or null when nothing is due.
export function barsNext(s, t, busy = false) {
  if (s.phase === "waiting" || s.phase === "leaving") return Math.max(0, s.at - t);
  if (s.phase === "shown" && !s.over && !busy) return Math.max(0, s.moved + IDLE_HIDE - t);
  return null;
}
