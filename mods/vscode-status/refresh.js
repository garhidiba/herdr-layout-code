// Unified usage refresh interval and per-provider visibility settings from <herdr home>/vscode-settings.json; pure, no host APIs.
export const REFRESH_SETTING = "statusBar.usageRefreshMinutes";
export const DEFAULT_REFRESH_MINUTES = 5;
export const MIN_REFRESH_MINUTES = 1;
export const MAX_REFRESH_MINUTES = 60;

const loose = (s) => JSON.parse(
  s.replace(/^\uFEFF/, "")
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1")
);

function parseObj(text) {
  if (!text || !String(text).trim()) return {};
  try {
    const o = loose(String(text));
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

const bool = (o, key) => (typeof o[key] === "boolean" ? o[key] : true);

function clampMinutes(raw) {
  const n = Number(raw);
  if (raw == null || raw === "" || typeof raw === "boolean" || !Number.isFinite(n) || !Number.isInteger(n)) {
    return DEFAULT_REFRESH_MINUTES;
  }
  return Math.max(MIN_REFRESH_MINUTES, Math.min(MAX_REFRESH_MINUTES, n));
}

export function refreshMinutesOf(text) {
  return clampMinutes(parseObj(text)[REFRESH_SETTING]);
}

export const refreshMsOf = (text) => refreshMinutesOf(text) * 60000;

export function usageConfigOf(text) {
  const o = parseObj(text);
  const refreshMinutes = clampMinutes(o[REFRESH_SETTING]);
  return {
    refreshMinutes,
    refreshMs: refreshMinutes * 60000,
    show: {
      claude: {
        session: bool(o, "statusBar.usage.claude.session"),
        weekly: bool(o, "statusBar.usage.claude.weekly"),
        models: bool(o, "statusBar.usage.claude.models"),
      },
      codex: {
        session: bool(o, "statusBar.usage.codex.session"),
        weekly: bool(o, "statusBar.usage.codex.weekly"),
        credits: bool(o, "statusBar.usage.codex.credits"),
      },
      agy: {
        geminiSession: bool(o, "statusBar.usage.agy.geminiSession"),
        geminiWeekly: bool(o, "statusBar.usage.agy.geminiWeekly"),
        claudeGptSession: bool(o, "statusBar.usage.agy.claudeGptSession"),
        claudeGptWeekly: bool(o, "statusBar.usage.agy.claudeGptWeekly"),
      },
    },
  };
}

export function filterProviderWindows(provider, wins, show) {
  if (!Array.isArray(wins) || !wins.length) return [];
  const cfg = show?.[provider];
  if (!cfg) return wins;
  if (provider === "claude") {
    const any = cfg.session || cfg.weekly || cfg.models;
    return wins.filter(w => {
      if (w.used === null) return any;
      if (w.model) return cfg.models;
      return w.weekly ? cfg.weekly : cfg.session;
    });
  }
  if (provider === "codex") {
    return wins.filter(w => (w.weekly ? cfg.weekly : cfg.session));
  }
  if (provider === "agy") {
    return wins.filter(w => {
      if (w.model) return w.weekly ? cfg.claudeGptWeekly : cfg.claudeGptSession;
      return w.weekly ? cfg.geminiWeekly : cfg.geminiSession;
    });
  }
  return wins;
}
