// Talks to the local Codex app-server (JSON-RPC over stdio, one object per line) with the user's Codex login.
//   node codex-limits.mjs read                         -> one JSON line: rate_limits (rollout-log shape), ordinaryUsageAllowed, resets
//   node codex-limits.mjs consume <creditId> <key>     -> one JSON line: { outcome }. Spends a reset credit; "" lets Codex pick.
// Exit codes: 0 ok, 1 usage, 2 error/timeout, 3 codex not found. CODEX_BIN overrides the executable.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 20000;

// App-server window/credits -> the shape the rollout logs use, so the status bar parses both the same way.
const win = (w) => w ? { used_percent: w.usedPercent ?? 0, window_minutes: w.windowDurationMins ?? 0, resets_at: w.resetsAt ?? 0 } : null;

export function summarize(r) {
  const rl = r?.rateLimits ?? {}, c = rl.credits, s = r?.rateLimitResetCredits;
  return {
    rate_limits: {
      primary: win(rl.primary),
      secondary: win(rl.secondary),
      credits: c ? { balance: c.balance ?? null, has_credits: Boolean(c.hasCredits), unlimited: Boolean(c.unlimited) } : null,
    },
    ordinaryUsageAllowed: r?.ordinaryUsageAllowed ?? null,
    resets: s ? {
      availableCount: s.availableCount ?? 0,
      // null: Codex gave only the count.
      credits: s.credits ? s.credits.map(({ id, description, expiresAt, status }) => ({ id, description: description ?? null, expiresAt: expiresAt ?? null, status })) : null,
    } : null,
  };
}

class Fail extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }

// Starts `codex app-server`, initializes, runs one request, always kills the child.
export async function call(method, params, bin = process.env.CODEX_BIN || "codex") {
  const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1, stderr = "";
  const failAll = (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); };
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-500); });
  child.on("error", (e) => failAll(e.code === "ENOENT" ? new Fail(`codex not found (${bin})`, 3) : new Fail(e.message)));
  child.on("exit", (code) => failAll(new Fail(`codex app-server exited (${code}) ${stderr.trim().split("\n").pop() ?? ""}`.trim())));
  child.stdin.on("error", () => {});
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const p = m?.id != null && m.method == null ? pending.get(m.id) : null;
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Fail(m.error.message ?? JSON.stringify(m.error))) : p.resolve(m.result);
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await request("initialize", { clientInfo: { name: "herdr-vscode-status", version: "0.1.0" } });
        send({ method: "initialized" });
        return await request(method, params);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Fail(`timeout after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

async function main([cmd, creditId, key]) {
  if (cmd === "read") return summarize(await call("account/rateLimits/read", {}));
  if (cmd === "consume" && key) {
    const r = await call("account/rateLimitResetCredit/consume", { creditId: creditId || null, idempotencyKey: key });
    return { outcome: r?.outcome ?? null };
  }
  throw new Fail("usage: codex-limits.mjs read | consume <creditId> <idempotencyKey>", 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (out) => { process.stdout.write(JSON.stringify(out) + "\n"); process.exit(0); },
    (e) => { process.stderr.write(`codex-limits: ${e.message}\n`); process.exit(e instanceof Fail ? e.code : 2); },
  );
}
