// When the Image Viewer's two toolbar rows show (image.js, column and dialog alike), unless pinned: a small state
// machine over clicks and the pointer, on a clock the caller passes (ms), so tests drive it with a fake one. Pure.
//   A click in the view (a press and release without a drag; not the second of a double-click) shows them, or hides
//   them when shown, unless it was on the rows. Hovering, panning and wheel zooms never show them.
//   Shown, they hide IDLE_HIDE after the last click or the pointer leaving the rows, LEAVE_HIDE after it leaves the
//   view (coming back in time keeps them); never while it is over them or a drag runs (`busy`).
// Phases: "hidden", "shown", "leaving" (hides at `at`). The rows show in shown and leaving.
export const LEAVE_HIDE = 1200, IDLE_HIDE = 2000;

export const barsStart = () => ({ phase: "hidden", at: 0, moved: 0, over: false });
export const barsShown = (s) => s.phase === "shown" || s.phase === "leaving";

// The deadlines passed by `t`.
export function barsTick(s, t, busy = false) {
  if (s.phase === "leaving" && t >= s.at) return { ...s, phase: "hidden" };
  if (s.phase === "shown" && !s.over && !busy && t - s.moved >= IDLE_HIDE) return { ...s, phase: "hidden" };
  return s;
}

// A click in the view: shows hidden rows; hides shown ones, unless it was on them (then it only counts as use).
export function barsClick(s, t) {
  s = barsTick(s, t);
  if (barsShown(s) && s.over) return { ...s, phase: "shown", moved: t };
  return { ...s, phase: barsShown(s) ? "hidden" : "shown", moved: t };
}

// The pointer moved inside the view: back before the leave ran out keeps the rows (the wait starts again).
export function barsEnter(s, t) {
  s = barsTick(s, t);
  return s.phase === "leaving" ? { ...s, phase: "shown", moved: t } : s;
}

export function barsLeave(s, t) {
  s = barsTick(s, t);
  return { ...s, over: false, phase: barsShown(s) ? "leaving" : "hidden", at: t + LEAVE_HIDE };
}

// The pointer onto the rows (shown ones stay while it does) or off them (the wait starts there).
export const barsOver = (s, t, on) => ({ ...barsTick(s, t), over: on, moved: t });

// Ms until the rows hide by themselves, or null when nothing is due.
export function barsNext(s, t, busy = false) {
  if (s.phase === "leaving") return Math.max(0, s.at - t);
  if (s.phase === "shown" && !s.over && !busy) return Math.max(0, s.moved + IDLE_HIDE - t);
  return null;
}
