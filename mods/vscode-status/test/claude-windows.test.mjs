// node --test mods/vscode-status/test/claude-windows.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { claudeWindows, barWindows } from "../claude-windows.js";

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

test("barWindows keeps a per-model window only when it is the tightest", () => {
  const main = [{ used: 5 }, { used: 61 }];
  assert.equal(barWindows([...main, { used: 40, model: "Fable" }]).length, 2);
  assert.equal(barWindows([...main, { used: 61, model: "Fable" }]).length, 2);
  assert.equal(barWindows([...main, { used: 80, model: "Fable" }]).length, 3);
});
