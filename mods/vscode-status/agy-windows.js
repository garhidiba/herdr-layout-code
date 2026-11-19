// Antigravity (agy) usage windows from retrieveUserQuotaSummary + fetchAvailableModels; pure, no host APIs.
const WINDOW_MINUTES = { "5h": 300, weekly: 10080 };
const epoch = (at) => typeof at === "number" ? at : Date.parse(at) / 1000;

function usedFrom(quota) {
  if (!quota || typeof quota !== "object") return null;
  const at = epoch(quota.resetTime);
  if (!Number.isFinite(at)) return null;
  if (typeof quota.remainingFraction === "number" && Number.isFinite(quota.remainingFraction)) {
    const rem = Math.min(1, Math.max(0, quota.remainingFraction));
    return { used_percent: (1 - rem) * 100, resets_at: at };
  }
  if (quota.isExhausted === true) return { used_percent: 100, resets_at: at };
  return null;
}

function windowMinutes(bucket) {
  const w = String(bucket?.window ?? "").toLowerCase();
  if (WINDOW_MINUTES[w]) return WINDOW_MINUTES[w];
  const id = `${bucket?.bucketId ?? ""} ${bucket?.displayName ?? ""}`.toLowerCase();
  if (/week/.test(id)) return 10080;
  if (/5h|five|hour|session/.test(id)) return 300;
  return 300;
}

function groupLabel(group) {
  const name = String(group?.displayName ?? "").trim();
  if (!name || /^gemini\b/i.test(name)) return null;
  if (/claude/i.test(name) && /gpt/i.test(name)) return "Claude/GPT";
  return name;
}

function summaryWindows(summary) {
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];
  const out = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const model = groupLabel(group);
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (let bi = 0; bi < buckets.length; bi++) {
      const b = buckets[bi];
      const u = usedFrom(b);
      if (!u) continue;
      out.push({
        key: String(b.bucketId || `group[${gi}][${bi}]`),
        model,
        used_percent: u.used_percent,
        window_minutes: windowMinutes(b),
        resets_at: u.resets_at,
      });
    }
  }
  return out;
}

// Tightest (highest used_percent) Gemini quota from fetchAvailableModels, for slots summary didn't cover.
function geminiModelWindows(models, coveredMain) {
  if (!models || typeof models !== "object" || Array.isArray(models)) return [];
  const pickTightest = (field, windowMins, key) => {
    if (coveredMain.has(windowMins)) return null;
    let best = null;
    for (const [id, m] of Object.entries(models)) {
      if (!/^gemini-/i.test(id)) continue;
      const u = usedFrom(m?.[field]);
      if (!u) continue;
      if (!best || u.used_percent > best.used_percent || (u.used_percent === best.used_percent && u.resets_at < best.resets_at)) {
        best = { key, model: null, used_percent: u.used_percent, window_minutes: windowMins, resets_at: u.resets_at };
      }
    }
    return best;
  };
  return [
    pickTightest("quotaInfo", 300, "gemini-5h"),
    pickTightest("weeklyQuotaInfo", 10080, "gemini-weekly"),
  ].filter(Boolean);
}

/** @returns {{key:string, model:string|null, used_percent:number, window_minutes:number, resets_at:number}[]} resets_at in epoch seconds */
export function agyWindows(data) {
  if (!data || typeof data !== "object") return [];
  const summary = summaryWindows(data.summary);
  const coveredMain = new Set(summary.filter(w => !w.model).map(w => w.window_minutes));
  const gemini = geminiModelWindows(data.models, coveredMain);
  // Gemini windows are the main ones (titled "Gemini …" so they don't read as the Claude/GPT group's).
  const all = [...summary, ...gemini].map(w => w.model ? w : { ...w, title: `Gemini ${w.window_minutes >= 10080 ? "weekly" : "5-hour session"}` });
  const rank = (w) => (w.model ? 2 : 0) + (w.window_minutes < 10080 ? 0 : 1);
  return all.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}
