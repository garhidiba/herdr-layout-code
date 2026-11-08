// Which resampled copy of the Image Viewer's picture to draw (image.js, imagefit.js resampleWidth): a small state machine
// on a clock the caller passes (ms), so tests drive it with a fake one. Pure, no imports.
// A copy is asked SETTLE ms after the wanted one (`key`, "<picture path>@<width>") last changed and not while a resize
// drag runs (`busy`): a column settling over a few frames asks once. One job at a time; a job that lands for a key no
// longer wanted is dropped. A landed copy is warmed first (drawn under the shown picture, where nothing shows it, so
// GPUI has it decoded) and swapped in WARM_MS later, still wanted: no blank frame at the swap.
// A failed job (no resampler, an odd file) isn't asked again for that key.
// State: { want, since, running, failed, warming: { key, path }, shown: { key, path } }.
export const SETTLE = 250, WARM_MS = 120;

export const sharpStart = () => ({ want: null, since: 0, running: null, failed: null, warming: null, shown: null });

// The copy wanted now (null: the original serves).
export const sharpAsk = (s, key, at) => key === s.want ? s : { ...s, want: key, since: at };

// What to do at `at`: { start: key } (run the job now), { wait: ms } (look again then), or null (nothing due).
export function sharpDue(s, at, busy = false) {
  if (!s.want || s.running || [s.shown?.key, s.warming?.key, s.failed].includes(s.want)) return null;
  if (busy) return null;
  const left = s.since + SETTLE - at;
  return left > 0 ? { wait: left } : { start: s.want };
}

export const sharpStarted = (s, key) => ({ ...s, running: key });

// The job for `key` ended: its copy at `path` (null: it failed) warms when still wanted, else it is dropped.
export function sharpDone(s, key, path) {
  s = { ...s, running: s.running === key ? null : s.running, failed: path ? s.failed : key };
  return path && key === s.want ? { ...s, warming: { key, path } } : s;
}

// WARM_MS after a copy began warming: shown when still wanted.
export function sharpWarmed(s, key) {
  if (s.warming?.key !== key) return s;
  return key === s.want ? { ...s, shown: s.warming, warming: null } : { ...s, warming: null };
}

// The shown copy for the picture at `path` while a copy is wanted for it (an older width, stretched, until the new one
// swaps in), else null: the original.
export const sharpShown = (s, path) => s.want && s.shown && s.shown.key.startsWith(`${path}@`) ? s.shown : null;
