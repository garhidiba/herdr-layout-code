// node --test mods/vscode-status/test/agy-windows.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { agyWindows } from "../agy-windows.js";
import { barWindows } from "../claude-windows.js";
import { parseKeychainPayload } from "../agy-limits.mjs";
import { refreshMinutesOf, refreshMsOf, usageConfigOf, filterProviderWindows } from "../refresh.js";

const iso5h = "2026-11-19T12:05:12Z", sec5h = Date.parse(iso5h) / 1000;
const isoWk = "2026-11-26T07:30:00Z", secWk = Date.parse(isoWk) / 1000;

test("Gemini 5-hour session first, then the Claude/GPT 5-hour and weekly windows", () => {
  const w = agyWindows({
    summary: {
      groups: [{
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", window: "weekly", resetTime: isoWk, remainingFraction: 0.9 },
          { bucketId: "3p-5h", window: "5h", resetTime: iso5h, remainingFraction: 0.75 },
        ],
      }],
    },
    models: {
      "gemini-3-flash": { quotaInfo: { remainingFraction: 0.85, resetTime: iso5h } },
      "gemini-2.5-pro": { quotaInfo: { remainingFraction: 0.8, resetTime: iso5h } },
      "tab_flash_lite_preview": { quotaInfo: { remainingFraction: 1 } },
    },
  });
  assert.deepEqual(w.map(x => [x.key, x.model, x.title, Math.round(x.used_percent), x.window_minutes]), [
    ["gemini-5h", null, "Gemini 5-hour session", 20, 300],
    ["3p-5h", "Claude/GPT", undefined, 25, 300],
    ["3p-weekly", "Claude/GPT", undefined, 10, 10080],
  ]);
  assert.equal(w[0].resets_at, sec5h);
  assert.equal(w[2].resets_at, secWk);
});

test("summary Gemini group de-duplicates fetchAvailableModels Gemini slot", () => {
  const w = agyWindows({
    summary: {
      groups: [{
        displayName: "Gemini models",
        buckets: [{ bucketId: "gemini-5h", window: "5h", resetTime: iso5h, remainingFraction: 0.5 }],
      }],
    },
    models: {
      "gemini-3-flash": {
        quotaInfo: { remainingFraction: 0.9, resetTime: iso5h },
        weeklyQuotaInfo: { remainingFraction: 0.6, resetTime: isoWk },
      },
    },
  });
  assert.deepEqual(w.map(x => [x.key, x.model, x.title, Math.round(x.used_percent), x.window_minutes]), [
    ["gemini-5h", null, "Gemini 5-hour session", 50, 300],
    ["gemini-weekly", null, "Gemini weekly", 40, 10080],
  ]);
});

test("isExhausted without remainingFraction reports 100% used; bad input gives empty list", () => {
  const w = agyWindows({
    models: { "gemini-2.5-pro": { quotaInfo: { isExhausted: true, resetTime: iso5h } } },
  });
  assert.equal(w.length, 1);
  assert.equal(w[0].used_percent, 100);
  for (const v of [null, undefined, "x", {}, { models: { "gemini-2.5-pro": { quotaInfo: { remainingFraction: 0.5 } } } }]) {
    assert.deepEqual(agyWindows(v), []);
  }
});

test("barWindows keeps Gemini main window and surfaces 3P only when tighter", () => {
  const base = [{ used: 20, model: null }, { used: 10, model: "Claude/GPT" }];
  assert.equal(barWindows(base).length, 1);
  const tighter = [{ used: 20, model: null }, { used: 35, model: "Claude/GPT" }];
  assert.equal(barWindows(tighter).length, 2);
});

test("parseKeychainPayload handles go-keyring-base64 and plain oauth_creds JSON", () => {
  const b64 = Buffer.from(JSON.stringify({ token: { access_token: "tok-1", expiry: iso5h } })).toString("base64");
  assert.deepEqual(parseKeychainPayload(`go-keyring-base64:${b64}`), { accessToken: "tok-1", expiryMs: sec5h * 1000 });
  assert.deepEqual(parseKeychainPayload(JSON.stringify({ access_token: "tok-2", expiry_date: secWk * 1000 })), { accessToken: "tok-2", expiryMs: secWk * 1000 });
  assert.equal(parseKeychainPayload(""), null);
});

test("refreshMinutesOf reads statusBar.usageRefreshMinutes with comments, clamping, and fallback", () => {
  assert.equal(refreshMinutesOf(null), 5);
  assert.equal(refreshMinutesOf('{ // comment\n "statusBar.usageRefreshMinutes": 2, }'), 2);
  assert.equal(refreshMsOf('{"statusBar.usageRefreshMinutes": 3}'), 180000);
  assert.equal(refreshMinutesOf('{"statusBar.usageRefreshMinutes": 0}'), 1);
  assert.equal(refreshMinutesOf('{"statusBar.usageRefreshMinutes": 120}'), 60);
  assert.equal(refreshMinutesOf('{"statusBar.usageRefreshMinutes": 2.5}'), 5);
  assert.equal(refreshMinutesOf("{ broken"), 5);
});

test("usageConfigOf and filterProviderWindows toggle each provider's windows independently", () => {
  const cfg = usageConfigOf(JSON.stringify({
    "statusBar.usage.claude.weekly": false,
    "statusBar.usage.codex.session": false,
    "statusBar.usage.agy.claudeGptSession": false,
    "statusBar.usage.agy.geminiWeekly": false,
  }));
  const claudeWins = [
    { key: "five_hour", model: null, weekly: false, used: 10 },
    { key: "seven_day", model: null, weekly: true, used: 40 },
    { key: "fable", model: "Fable", weekly: true, used: 20 },
  ];
  assert.deepEqual(filterProviderWindows("claude", claudeWins, cfg.show).map(w => w.key), ["five_hour", "fable"]);

  const codexWins = [
    { key: "p", model: null, weekly: false, used: 15 },
    { key: "s", model: null, weekly: true, used: 50 },
  ];
  assert.deepEqual(filterProviderWindows("codex", codexWins, cfg.show).map(w => w.key), ["s"]);

  const agyWins = [
    { key: "gemini-5h", model: null, weekly: false, used: 40 },
    { key: "gemini-weekly", model: null, weekly: true, used: 12 },
    { key: "3p-5h", model: "Claude/GPT", weekly: false, used: 100 },
    { key: "3p-weekly", model: "Claude/GPT", weekly: true, used: 72 },
  ];
  assert.deepEqual(filterProviderWindows("agy", agyWins, cfg.show).map(w => w.key), ["gemini-5h", "3p-weekly"]);
});
