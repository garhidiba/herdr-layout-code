// node --test mods/vscode-status/test/claude-windows.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { claudeWindows, barWindows, surfaceShares } from "../claude-windows.js";

const iso = "2026-11-10T09:00:00+00:00", sec = Date.parse(iso) / 1000;

test("statusLine shape: used_percentage + epoch seconds", () => {
  const w = claudeWindows({ seven_day: { used_percentage: 61, resets_at: sec } });
  assert.deepEqual(w, [{ key: "seven_day", model: null, used_percent: 61, window_minutes: 10080, resets_at: sec }]);
});

test("API shape: utilization + ISO date, main windows first, null windows skipped", () => {
  const w = claudeWindows({
    seven_day_opus: null,
    seven_day_fable: { utilization: 40, resets_at: iso },
    seven_day: { utilization: 61, resets_at: iso },
    five_hour: { utilization: 5, resets_at: iso },
    extra_usage: { is_enabled: false },
  });
  assert.deepEqual(w.map(x => [x.key, x.model, x.window_minutes, x.used_percent]),
    [["five_hour", null, 300, 5], ["seven_day", null, 10080, 61], ["seven_day_fable", "Fable", 10080, 40]]);
  assert.equal(w[2].resets_at, sec);
});

test("unknown suffixes and non-seven_day prefixes still show", () => {
  const w = claudeWindows({ seven_day_oauth_apps: { utilization: 1, resets_at: iso }, tangelo_haiku: { utilization: 2, resets_at: iso }, five_hour_sonnet: { utilization: 3, resets_at: iso } });
  assert.deepEqual(w.map(x => [x.model, x.window_minutes]), [["Sonnet", 300], ["Oauth Apps", 10080], ["Haiku", 10080]]);
});

test("bad input gives no windows", () => {
  for (const v of [null, undefined, "x", {}, { seven_day: { utilization: 5 } }, { seven_day: { resets_at: iso } }]) assert.deepEqual(claudeWindows(v), []);
});

const api = {
  seven_day: { utilization: 62, resets_at: "2026-11-12T10:00:00.153113+00:00" },
  extra_usage: { is_enabled: false },
  limits: [
    { kind: "weekly_all", group: "weekly", percent: 62, severity: "normal", resets_at: "2026-11-12T10:00:00.153113+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 21, severity: "warning", resets_at: "2026-11-13T10:00:00.153113+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
  weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 11, allowance_percent_of_weekly: 50 }],
  seven_day_breakdown: { as_of: "x", rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }, { key: "chat", display_name: "Chats", percent: 0 }, { key: "cowork", percent: 0 }] },
};

test("API limits[]: weekly_all and a scoped Fable window, seven_day de-duplicated", () => {
  const w = claudeWindows(api);
  assert.deepEqual(w.map(x => [x.model, x.used_percent, x.window_minutes, x.severity]), [[null, 62, 10080, "normal"], ["Fable", 21, 10080, "warning"]]);
  assert.equal(w[1].resets_at, Date.parse("2026-11-13T10:00:00.153113+00:00") / 1000);
  assert.equal(w[0].share, undefined);
  assert.deepEqual(w[1].share, { used: 11, allowance: 50 });
});

test("limits[]: five_hour kept from the legacy key when limits lacks it; unknown severity is normal; surface label", () => {
  const w = claudeWindows({
    five_hour: { utilization: 7, resets_at: "2026-11-09T10:00:00Z" },
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 1, severity: "weird", resets_at: "2026-11-12T10:00:00Z" },
      { kind: "weekly_scoped", group: "weekly", percent: 2, resets_at: "2026-11-12T10:00:00Z", scope: { model: null, surface: "Claude Code" } },
    ],
  });
  assert.deepEqual(w.map(x => [x.model, x.window_minutes, x.severity]), [[null, 300, undefined], [null, 10080, "normal"], ["Claude Code", 10080, "normal"]]);
});

test("limits[]: a five-hour group is a main session window and replaces five_hour", () => {
  const w = claudeWindows({ five_hour: { utilization: 9, resets_at: "2026-11-09T10:00:00Z" }, limits: [{ kind: "session", group: "five_hour", percent: 8, resets_at: "2026-11-09T10:00:00Z" }] });
  assert.deepEqual(w.map(x => [x.model, x.window_minutes, x.used_percent]), [[null, 300, 8]]);
});

test("surfaceShares summarizes seven_day_breakdown", () => {
  assert.equal(surfaceShares(api), "Claude Code 100%, Chats 0%, cowork 0%");
  assert.equal(surfaceShares({}), null);
});

test("barWindows keeps a per-model window only when it is the tightest", () => {
  const main = [{ used: 5 }, { used: 61 }];
  assert.equal(barWindows([...main, { used: 40, model: "Fable" }]).length, 2);
  assert.equal(barWindows([...main, { used: 61, model: "Fable" }]).length, 2);
  assert.equal(barWindows([...main, { used: 80, model: "Fable" }]).length, 3);
});
