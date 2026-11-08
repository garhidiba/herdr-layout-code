// Claude usage windows from either source (statusLine `rate_limits` or the OAuth usage API); pure, no host APIs.
// The API's `limits[]` is the primary source; five_hour / seven_day (and `<prefix>_<model>` keys) are the fallback.
const MAIN = { five_hour: 300, seven_day: 10080 };
const titleCase = (s) => s.split("_").filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join(" ");
const epoch = (at) => typeof at === "number" ? at : Date.parse(at) / 1000;
const SEVERITIES = ["normal", "warning", "critical"];

// Windows from the legacy keys. `model` null = a main window.
function legacyWindows(rl) {
  const out = [];
  for (const [key, w] of Object.entries(rl)) {
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    const pct = w.used_percentage ?? w.utilization, at = epoch(w.resets_at);
    if (typeof pct !== "number" || !Number.isFinite(at)) continue;
    const m = key.match(/^(five_hour|seven_day)(?:_(.+))?$/);
    const suffix = m ? m[2] : key.includes("_") ? key.slice(key.lastIndexOf("_") + 1) : key;
    out.push({ key, model: suffix ? titleCase(suffix) : null, used_percent: pct, window_minutes: MAIN[m?.[1]] ?? 10080, resets_at: at });
  }
  return out;
}

// The scope's label: model name, else surface (a string or a named object).
const scopeLabel = (s) => {
  const name = (x) => typeof x === "string" ? x : x?.display_name ?? x?.name ?? null;
  return name(s?.model) ?? name(s?.surface);
};

// Windows from `limits[]`: weekly_all / session kinds are main windows, scoped ones are labelled.
function limitWindows(u) {
  const shares = Array.isArray(u.weekly_scoped_shares) ? u.weekly_scoped_shares : [];
  return u.limits.flatMap((l, i) => {
    const at = epoch(l?.resets_at);
    if (typeof l?.percent !== "number" || !Number.isFinite(at)) return [];
    const session = /five|session|hour/.test(`${l.group} ${l.kind}`);
    const model = scopeLabel(l.scope) ?? (session || /_all$/.test(l.kind ?? "") ? null : titleCase(String(l.kind ?? "limit")));
    const share = shares.find(s => s.limit_index === i);
    return [{
      key: `limits[${i}]`, model, used_percent: l.percent, window_minutes: session ? 300 : 10080, resets_at: at,
      severity: SEVERITIES.includes(l.severity) ? l.severity : "normal",
      ...(share && { share: { used: share.used_percent_of_weekly, allowance: share.allowance_percent_of_weekly } }),
    }];
  });
}

/** @returns {{key:string, model:string|null, used_percent:number, window_minutes:number, resets_at:number, severity?:string, share?:{used:number, allowance:number}}[]} resets_at in epoch seconds */
export function claudeWindows(rl) {
  if (!rl || typeof rl !== "object") return [];
  const legacy = legacyWindows(rl);
  const limits = Array.isArray(rl.limits) ? limitWindows(rl) : [];
  const rank = (w) => (w.model ? 2 : w.window_minutes < 10080 ? 0 : 1);
  // Legacy windows only fill main slots `limits` doesn't cover (seven_day duplicates weekly_all).
  const covered = (w) => limits.some(l => !l.model && l.window_minutes === w.window_minutes);
  const all = limits.length ? [...limits, ...legacy.filter(w => !w.model && !covered(w))] : legacy;
  return all.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** "Claude Code 100%, Chats 0%" from the API's seven_day_breakdown, or null. */
export function surfaceShares(u) {
  const rows = (Array.isArray(u?.seven_day_breakdown?.rows) ? u.seven_day_breakdown.rows : []).filter(r => typeof r?.percent === "number");
  return rows.length ? rows.map(r => `${r.display_name ?? r.key} ${Math.round(r.percent)}%`).join(", ") : null;
}

/** Windows for the compact bar: the main ones, plus a per-model window only when it is the tightest. */
export function barWindows(wins) {
  const top = Math.max(0, ...wins.filter(w => !w.model).map(w => w.used));
  return wins.filter(w => !w.model || w.used > top);
}
