// Reads Antigravity (agy) OAuth token from macOS Keychain (fallback: ~/.gemini/oauth_creds.json)
// and queries Google's Cloud Code quota endpoints.
//   node agy-limits.mjs -> one JSON line: { at, summary, models }
// Exit codes: 0 ok, 2 error/timeout, 3 credentials not found.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 10000;
const BASE = process.env.AGY_QUOTA_BASE || "https://daily-cloudcode-pa.googleapis.com/v1internal";
const USER_AGENT = "antigravity/99.0.0 darwin/arm64";

class Fail extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }

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
  const expiryMs = typeof tok.expiry === "string" ? Date.parse(tok.expiry) : Number(tok.expiry_date);
  return { accessToken, expiryMs: Number.isFinite(expiryMs) ? expiryMs : null };
}

function readToken() {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const parsed = parseKeychainPayload(raw);
    if (parsed?.accessToken) return parsed.accessToken;
  } catch {}
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".gemini", "oauth_creds.json"), "utf8");
    const parsed = parseKeychainPayload(raw);
    if (parsed?.accessToken) return parsed.accessToken;
  } catch {}
  throw new Fail("agy credentials not found", 3);
}

async function postJson(endpoint, token) {
  const res = await fetch(`${BASE}:${endpoint}`, {
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
  if (!res.ok) throw new Fail(`${endpoint} HTTP ${res.status}`, 2);
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

async function main() {
  const token = readToken();
  const [summaryRes, modelsRes] = await Promise.allSettled([
    postJson("retrieveUserQuotaSummary", token),
    postJson("fetchAvailableModels", token),
  ]);
  const summary = summaryRes.status === "fulfilled" ? summaryRes.value : null;
  const models = modelsRes.status === "fulfilled" ? slimModels(modelsRes.value) : null;
  if (!summary && !models) {
    const reason = summaryRes.reason?.message || modelsRes.reason?.message || "request failed";
    throw new Fail(reason, 2);
  }
  return { at: Math.floor(Date.now() / 1000), summary, models };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (out) => { process.stdout.write(JSON.stringify(out) + "\n"); process.exit(0); },
    (e) => { process.stderr.write(`agy-limits: ${e.message}\n`); process.exit(e instanceof Fail ? e.code : 2); },
  );
}
