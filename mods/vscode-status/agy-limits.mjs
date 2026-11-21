// Reads Antigravity (agy) OAuth token from macOS Keychain (fallback: ~/.gemini/oauth_creds.json),
// refreshes expired/rejected tokens via `agy models`, and queries Google's Cloud Code quota endpoints.
//   node agy-limits.mjs -> one JSON line: { at, summary, models }
// Exit codes: 0 ok, 2 error/timeout, 3 credentials not found.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 10000;
const REFRESH_TIMEOUT_MS = 15000;
const BASE = process.env.AGY_QUOTA_BASE || "https://daily-cloudcode-pa.googleapis.com/v1internal";
const USER_AGENT = "antigravity/99.0.0 darwin/arm64";

class Fail extends Error {
  constructor(msg, code = 2, status = null) {
    super(msg);
    this.code = code;
    this.status = status;
  }
}

export function parseKeychainPayload(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const decoded = text.startsWith("go-keyring-base64:")
    ? Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8")
    : text;
  const obj = JSON.parse(decoded);
  const tok = typeof obj?.token === "object" && obj.token ? obj.token : obj;
  const accessToken = typeof tok?.access_token === "string" ? tok.access_token : null;
  if (!accessToken) return null;
  const rawExpiry = typeof tok.expiry === "string" ? Date.parse(tok.expiry)
    : (typeof tok.expiry_date === "number" ? tok.expiry_date : NaN);
  return { accessToken, expiryMs: Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry : null };
}

// Match agy's own expiry check so we don't spawn `agy models` while keyringAuth still sees expired=false.
export const isTokenExpired = (rec, now = Date.now()) =>
  rec?.expiryMs != null && rec.expiryMs <= now;

function readToken() {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const parsed = parseKeychainPayload(raw);
    if (parsed?.accessToken) return parsed;
  } catch {}
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".gemini", "oauth_creds.json"), "utf8");
    const parsed = parseKeychainPayload(raw);
    if (parsed?.accessToken) return parsed;
  } catch {}
  throw new Fail("agy credentials not found", 3);
}

// `agy models` runs agy's keyringAuth flow, refreshing the Keychain token without polluting cli.log.
function refreshViaCli() {
  const bin = process.env.AGY_BIN || "agy";
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH || ""}`,
  };
  execFileSync(bin, ["--log-file", "/dev/null", "models"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: REFRESH_TIMEOUT_MS,
  });
}

const errorLine = (e) => String(e?.stderr || e?.message || e).trim().split("\n").pop() || "refresh failed";

async function postJson(endpoint, token, base = BASE) {
  const res = await fetch(`${base}:${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Fail(`${endpoint} HTTP ${res.status}`, 2, res.status);
  return res.json();
}

function slimModels(raw) {
  const models = raw?.models;
  if (!models || typeof models !== "object") return null;
  const out = {};
  for (const [id, m] of Object.entries(models)) {
    if (!m?.quotaInfo && !m?.weeklyQuotaInfo) continue;
    out[id] = {
      displayName: m.displayName ?? null,
      ...(m.quotaInfo && { quotaInfo: m.quotaInfo }),
      ...(m.weeklyQuotaInfo && { weeklyQuotaInfo: m.weeklyQuotaInfo }),
    };
  }
  return out;
}

export async function queryQuota(token, base = BASE) {
  const [summaryRes, modelsRes] = await Promise.allSettled([
    postJson("retrieveUserQuotaSummary", token, base),
    postJson("fetchAvailableModels", token, base),
  ]);
  const summary = summaryRes.status === "fulfilled" ? summaryRes.value : null;
  const models = modelsRes.status === "fulfilled" ? slimModels(modelsRes.value) : null;
  if (!summary && !models) {
    const reasons = [summaryRes.reason, modelsRes.reason].filter(Boolean);
    const err = reasons.find((e) => e?.status === 401) ?? reasons[0];
    throw new Fail(err?.message || "request failed", 2, err?.status ?? null);
  }
  return { at: Math.floor(Date.now() / 1000), summary, models };
}

export async function fetchQuota(deps = {}) {
  const load = deps.readToken ?? readToken;
  const refresh = deps.refreshToken ?? refreshViaCli;
  const query = deps.queryQuota ?? queryQuota;
  const now = deps.now ?? Date.now;

  let rec = load();
  let refreshed = false;
  let refreshError = null;
  if (isTokenExpired(rec, now())) {
    refreshed = true;
    try {
      await refresh();
      rec = load();
    } catch (e) {
      refreshError = errorLine(e);
    }
  }

  try {
    return await query(rec.accessToken);
  } catch (err) {
    if (err?.status === 401 && !refreshed) {
      try {
        await refresh();
      } catch (e) {
        throw new Fail(`${err.message} (token refresh failed: ${errorLine(e)})`, 2, 401);
      }
      const next = load();
      if (next.accessToken !== rec.accessToken) return await query(next.accessToken);
    }
    if (err?.status === 401 && refreshError) {
      throw new Fail(`${err.message} (token refresh failed: ${refreshError})`, 2, 401);
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchQuota().then(
    (out) => { process.stdout.write(JSON.stringify(out) + "\n"); process.exit(0); },
    (e) => { process.stderr.write(`agy-limits: ${e.message}\n`); process.exit(e instanceof Fail ? e.code : 2); },
  );
}
