// Claude usage windows from either source (statusLine `rate_limits` or the OAuth usage API); pure, no host APIs.
// five_hour / seven_day are the main windows; any `<prefix>_<model>` window (seven_day_fable, seven_day_opus, ...) is per-model.
const MAIN = { five_hour: 300, seven_day: 10080 };
const titleCase = (s) => s.split("_").filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join(" ");

/** @returns {{key:string, model:string|null, used_percent:number, window_minutes:number, resets_at:number}[]} resets_at in epoch seconds */
export function claudeWindows(rl) {
  if (!rl || typeof rl !== "object") return [];
  const out = [];
  for (const [key, w] of Object.entries(rl)) {
    if (!w || typeof w !== "object") continue;
    const pct = w.used_percentage ?? w.utilization;
    const at = typeof w.resets_at === "number" ? w.resets_at : Date.parse(w.resets_at) / 1000;
    if (typeof pct !== "number" || !Number.isFinite(at)) continue;
    const m = key.match(/^(five_hour|seven_day)(?:_(.+))?$/);
    const suffix = m ? m[2] : key.includes("_") ? key.slice(key.lastIndexOf("_") + 1) : key;
    out.push({ key, model: suffix ? titleCase(suffix) : null, used_percent: pct, window_minutes: MAIN[m?.[1]] ?? 10080, resets_at: at });
  }
  const rank = (w) => (w.key in MAIN ? Object.keys(MAIN).indexOf(w.key) : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

/** Top-level keys whose value is not null: key names only, safe to show for debugging. */
export const presentKeys = (u) => u && typeof u === "object" ? Object.keys(u).filter(k => u[k] != null) : [];

/** Windows for the compact bar: the main ones, plus a per-model window only when it is the tightest. */
export function barWindows(wins) {
  const top = Math.max(0, ...wins.filter(w => !w.model).map(w => w.used));
  return wins.filter(w => !w.model || w.used > top);
}
