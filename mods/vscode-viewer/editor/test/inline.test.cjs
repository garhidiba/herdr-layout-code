// node --test mods/vscode-viewer/editor/test/inline.test.cjs — inline suggestions: the rules (inline.cjs) and the editor
// against a fake provider (a local HTTP stub speaking Ollama's /api/generate). No real model or paid API is called.
process.env.VSEDIT_OS = "linux";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const I = require("../inline.cjs");
const S = require("../settings.cjs");
const H = require("../highlight.cjs");
const { Editor } = require("../vsedit.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vsedit-inline-"));
process.env.VSEDIT_INLINE_USAGE = path.join(tmp, "usage.json");
process.env.VSEDIT_SETTINGS = path.join(tmp, "settings.json");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- rules ----------
test("secret files are never sent: names, path patterns and the user's extra patterns", () => {
  const ex = I.config(S.normalize({ "editor.inlineSuggest.exclude": ["*.tfvars"] })).exclude;
  for (const f of ["/p/.env", "/p/.env.local", "/p/key.pem", "/h/.ssh/config", "/h/id_rsa", "/h/id_ed25519.pub", "/p/prod.tfvars", "/p/.npmrc"])
    assert.ok(I.denied(f, ex), f);
  for (const f of ["/p/main.ts", "/p/env.ts", "/p/README.md"]) assert.ok(!I.denied(f, ex), f);
});

test("a suggestion is asked only where the rest of the line is blank or closers, not inside a word", () => {
  assert.ok(I.atSuggestable("foo(", 4));
  assert.ok(I.atSuggestable("call(x);", 6));
  assert.ok(!I.atSuggestable("value", 2));
  assert.ok(!I.atSuggestable("a + b", 2));
});

test("the context is cut to the prefix and suffix caps, the prefix at a line start", () => {
  const lines = ["0123456789", "abcdefghij", "KLMNOPQRST"];
  assert.deepEqual(I.contextAt(lines, 1, 5, 8, 7), { prefix: "abcde", suffix: "fghij\nK", nextLine: false });
  assert.deepEqual(I.contextAt(lines, 1, 5, 16, 0).prefix, "0123456789\nabcde", "whole lines before the cursor line");
  assert.deepEqual(I.contextAt(lines, 1, 5, 3, 0).prefix, "cde", "only the cursor line is cut");
  assert.deepEqual(I.contextAt(lines, 0, 0, 100, 0), { prefix: "", suffix: "", nextLine: false });
  assert.equal(I.contextAt(["  x = 1;", "}"], 0, 8, 100, 100).nextLine, true, "after a finished statement");
  assert.equal(I.contextAt(["  x = ", "}"], 0, 6, 100, 100).nextLine, false, "inside a statement");
});

test("typing what the suggestion starts with keeps the rest; anything else drops it", () => {
  assert.deepEqual(I.typeThrough(["return a;", "rest"], "re"), ["turn a;", "st"]);
  assert.equal(I.typeThrough(["return"], "x"), null);
  assert.equal(I.typeThrough(["ab"], "ab"), null);
});

test("accept next word takes spaces and one word or punctuation run, or a line break with its indent", () => {
  assert.equal(I.nextWordLength(" foo(bar)"), 4);
  assert.equal(I.nextWordLength("(bar)"), 1);
  assert.equal(I.nextWordLength("\n  next"), 3);
});

test("replies: FIM tokens, a repeated suffix or prefix and line breaks in one-line mode are cut", () => {
  const ctx = { prefix: "function add(a, b) {\n  ", suffix: "\n}\nconsole.log(add(1, 2));" };
  assert.deepEqual(I.clean("return a + b;<|fim_suffix|>junk", { ...ctx, multiline: false }), { text: "return a + b;", anomaly: "fim" });
  assert.deepEqual(I.clean("return a + b;\n}", { ...ctx, multiline: false }), { text: "return a + b;", anomaly: null });
  assert.deepEqual(I.clean("return a + b;\n}\nconsole.log(add(1, 2));", { ...ctx, multiline: true }), { text: "return a + b;", anomaly: null });
  assert.deepEqual(I.clean("}\nconsole.log(add(1, 2));", { ...ctx, multiline: true }), { text: null, anomaly: "echo" });
  assert.deepEqual(I.clean("   \n", { ...ctx, multiline: false }), { text: null, anomaly: "empty" });
  assert.deepEqual(I.clean("\n  return x;\n}", { prefix: "  x();", suffix: "\n}", multiline: false, nextLine: true }), { text: "\n  return x;", anomaly: null },
    "after a finished statement a one-line suggestion may be the next line");
  assert.deepEqual(I.clean("const total = 1;", { prefix: "  const total = ", suffix: "", multiline: false }), { text: " 1;", anomaly: "echo" });
  assert.deepEqual(I.clean("a, b)", { prefix: "f(", suffix: ")", multiline: false }), { text: "a, b", anomaly: null }); // an auto-closed ")" isn't doubled
});

test("a provider pauses after N bad replies in a row, at once on FIM tokens; a good reply resets the count", () => {
  const h = new I.Health(3);
  assert.equal(h.record("empty"), null); assert.equal(h.record(null), null);
  h.record("empty"); h.record("echo");
  assert.match(h.record(null, "Ollama is not running") ?? "", /3 errors in a row/);
  assert.match(new I.Health(5).record("fim"), /FIM template tokens/);
});

test("defaults: Ollama with qwen2.5-coder:7b on 127.0.0.1, on when Ollama can run, local means no daily limit", () => {
  const cfg = I.config(S.normalize({}), () => true);
  assert.deepEqual([cfg.provider, cfg.model, cfg.endpoint, cfg.enabled, cfg.limit, cfg.maxTokens, cfg.debounce, cfg.trigger, cfg.keepAlive],
    ["ollama", "qwen2.5-coder:7b", "http://127.0.0.1:11434", true, 0, 64, 250, "auto", "30m"]);
  assert.equal(I.config(S.normalize({}), () => false).enabled, false);
  assert.equal(I.config(S.normalize({ "editor.inlineSuggest.enabled": true }), () => false).enabled, true);
  assert.equal(I.config(S.normalize({ "editor.inlineSuggest.provider": "off" })).enabled, false);
  const body = I.request(cfg, { prefix: "p", suffix: "s" }).body;
  assert.deepEqual([body.prompt, body.suffix, body.keep_alive, body.options.num_predict, body.options.stop], ["p", "s", "30m", 64, ["\n"]]);
  assert.equal(I.request({ ...cfg, multiline: true }, { prefix: "", suffix: "" }).body.options.stop, undefined);
  assert.equal(I.request(cfg, { prefix: "", suffix: "", nextLine: true }).body.options.stop, undefined);
  assert.equal(I.warmup(cfg).body.options.num_predict, 1);
});

test("usage: requests, characters and latencies per day and provider; percentiles", () => {
  const file = path.join(tmp, "u.json");
  I.recordUsage("ollama:m", { inChars: 400, outChars: 40, ms: 100 }, file, "2026-01-01");
  I.recordUsage("ollama:m", { inChars: 400, outChars: 0 }, file, "2026-01-01");
  const u = I.usageOf("ollama:m", file, "2026-01-01");
  assert.deepEqual([u.requests, u.inChars, u.outChars, u.ms], [2, 800, 40, [100]]);
  assert.equal(I.usageOf("ollama:m", file, "2026-01-02").requests, 0);
  assert.equal(I.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(I.percentile([1, 2, 3, 4, 100], 95), 100);
  assert.match(I.usageText({ label: "Ollama", model: "m", limit: 0 }, u), /today 2 requests · ~200 in \/ 10 out tokens · p50 100 ms, p95 100 ms/);
});

// ---------- the editor against a stub provider ----------
// A fake Ollama: answer(body) -> { response } | { status, error } | null (never answers); delay in ms.
async function stub(answer, delay = 0) {
  const s = { bodies: [], closed: 0 };
  s.server = http.createServer((req, res) => {
    let data = "";
    req.on("data", d => { data += d; });
    req.on("end", () => {
      const body = JSON.parse(data);
      if (body.prompt === "" && body.options?.num_predict === 1) return res.end("{}"); // warmup
      s.bodies.push(body);
      res.on("close", () => { if (!res.writableEnded) s.closed++; });
      const a = answer(body);
      if (a == null) return;
      setTimeout(() => { res.statusCode = a.status ?? 200; res.end(JSON.stringify(a.error ? { error: a.error } : { response: a.response, done: true })); }, delay);
    });
  });
  await new Promise(r => s.server.listen(0, "127.0.0.1", r));
  s.endpoint = `http://127.0.0.1:${s.server.address().port}`;
  return s;
}
async function editorWith(endpoint, lines, extra = {}, file = path.join(tmp, "add.js")) {
  const settings = S.normalize({ "editor.inlineSuggest.endpoint": endpoint, "editor.inlineSuggest.debounce": 30, ...extra });
  const ed = new Editor(file, { lines, eol: "\n", finalNewline: true }, await H.loadGrammar(null), H.loadTheme(), null, settings);
  ed.rows = 20; ed.cols = 80;
  ed.redraw = () => ed.afterEvent();
  ed.moveTo({ line: lines.length - 1, col: lines[lines.length - 1].length });
  ed.afterEvent();
  return ed;
}
const type = (ed, text) => { for (const ch of text) { ed.handle({ type: "text", text: ch }); ed.afterEvent(); } };
const key = (ed, name, mods = {}) => { ed.handle({ type: "key", name, ...mods }); ed.afterEvent(); };
const ghost = (ed) => ed.inline.ghost?.items[ed.inline.ghost.index] ?? null;
const waitFor = async (f, ms = 2000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(10); return f(); };

test("typing fast asks once after the pause; the reply shows dim, Tab accepts it", async () => {
  const s = await stub(() => ({ response: " a + b;" }));
  const ed = await editorWith(s.endpoint, ["function add(a, b) {", "  "]);
  type(ed, "return");
  assert.ok(await waitFor(() => ghost(ed)), "no suggestion");
  assert.equal(s.bodies.length, 1, "one request for a burst of typing");
  assert.equal(s.bodies[0].prompt, "function add(a, b) {\n  return");
  assert.match(ed.render().out, new RegExp("\\x1b\\[38;2;113;115;120m a \\+ b;"), "the ghost text in editorGhostText's color");
  key(ed, "tab");
  assert.equal(ed.lines[1], "  return a + b;");
  assert.equal(ghost(ed), null);
  s.server.close();
});

test("typing the suggestion's own characters keeps the rest without asking again; Esc hides it", async () => {
  const s = await stub(() => ({ response: "onsole.log(x);" }));
  const ed = await editorWith(s.endpoint, ["let x = 1;", ""]);
  type(ed, "c");
  assert.ok(await waitFor(() => ghost(ed)));
  type(ed, "onso");
  assert.equal(ghost(ed), "le.log(x);");
  await sleep(80);
  assert.equal(s.bodies.length, 1, "no new request while typing through");
  key(ed, "escape");
  assert.equal(ghost(ed), null);
  assert.equal(ed.lines[1], "conso");
  s.server.close();
});

test("accept next word (Ctrl+→ on Linux) takes one word and leaves the rest showing", async () => {
  const s = await stub(() => ({ response: "turn value;" }));
  const ed = await editorWith(s.endpoint, ["re"]);
  type(ed, "t");
  assert.ok(await waitFor(() => ghost(ed)));
  key(ed, "right", { ctrl: true });
  assert.equal(ed.lines[0], "retturn");
  assert.equal(ghost(ed), " value;");
  key(ed, "right", { ctrl: true });
  assert.equal(ed.lines[0], "retturn value");
  s.server.close();
});

test("a deny-listed file sends nothing", async () => {
  const s = await stub(() => ({ response: "x" }));
  const ed = await editorWith(s.endpoint, ["API_KEY="], {}, path.join(tmp, ".env"));
  type(ed, "a");
  await sleep(120);
  assert.equal(s.bodies.length, 0);
  ed.inlineTrigger(); await sleep(60);
  assert.equal(s.bodies.length, 0);
  assert.match(ed.message.text, /No inline suggestions for this file/);
  s.server.close();
});

test("a new edit aborts the request in flight", async () => {
  const s = await stub(() => null); // never answers
  const ed = await editorWith(s.endpoint, [""]);
  type(ed, "a");
  assert.ok(await waitFor(() => s.bodies.length === 1));
  assert.ok(ed.inline.busy);
  type(ed, "b");
  assert.ok(await waitFor(() => s.closed === 1), "the first request was not aborted");
  assert.ok(await waitFor(() => s.bodies.length === 2));
  ed.inlineHide();
  assert.ok(await waitFor(() => s.closed === 2));
  s.server.close();
});

test("empty replies N times in a row pause the provider for the session; a click resumes it", async () => {
  const s = await stub(() => ({ response: "" }));
  const ed = await editorWith(s.endpoint, [""], { "editor.inlineSuggest.stopAfter": 3 });
  for (const ch of "abcd") { type(ed, ch); await waitFor(() => !ed.inline.busy && !ed.inline.timer, 500); await sleep(40); }
  assert.equal(s.bodies.length, 3, "the 4th edit asks nothing");
  const st = ed.inlineStatus();
  assert.equal(st.text, "Ollama: paused");
  assert.match(st.hover(), /3 empty or repeated replies in a row/);
  st.run(); // toggles off (resumes the count); on again
  ed.inlineStatus().run();
  assert.equal(ed.inlineStatus().text, "Ollama");
  s.server.close();
});

test("the daily request limit stops asking for the day", async () => {
  const s = await stub(() => ({ response: "1" }));
  const ed = await editorWith(s.endpoint, [""], { "editor.inlineSuggest.dailyRequestLimit": 2 });
  fs.rmSync(process.env.VSEDIT_INLINE_USAGE, { force: true });
  for (const ch of "xyz") { type(ed, ch); await waitFor(() => !ed.inline.busy && !ed.inline.timer, 500); await sleep(40); }
  assert.equal(s.bodies.length, 2);
  assert.equal(ed.inlineStatus().text, "Ollama: limit");
  ed.inlineTrigger();
  assert.match(ed.message.text, /today's limit of 2 requests/);
  s.server.close();
});

test("manual trigger: nothing while typing, Alt+\\ asks; the same position reuses the reply", async () => {
  const s = await stub(() => ({ response: "42;" }));
  const ed = await editorWith(s.endpoint, ["x = "], { "editor.inlineSuggest.trigger": "manual" });
  type(ed, " ");
  await sleep(100);
  assert.equal(s.bodies.length, 0);
  key(ed, "\\", { alt: true });
  assert.ok(await waitFor(() => ghost(ed) === "42;"));
  key(ed, "escape");
  key(ed, "\\", { alt: true });
  assert.equal(ghost(ed), "42;", "cached for the same text and position");
  assert.equal(s.bodies.length, 1);
  s.server.close();
});

test("a multi-line suggestion pushes the lines below down; the rest of the line follows its last line", async () => {
  const s = await stub(() => ({ response: "if (a) {\n    go();\n  }" }));
  const ed = await editorWith(s.endpoint, ["function f() {", "  ", "}", "tail();"], { "editor.inlineSuggest.multiline": true });
  ed.moveTo({ line: 1, col: 2 }); ed.afterEvent();
  type(ed, "x");
  assert.ok(await waitFor(() => ghost(ed)));
  const rows = ed.render().out.split(/\x1b\[(\d+);1H/);
  const text = (row) => { const i = rows.indexOf(String(row)); return rows[i + 1].replace(/\x1b\[[\d;:]*m/g, ""); };
  assert.match(text(3), /^ +2 +│? ?xif \(a\) \{ *$/); // the cursor line: "  x", then the ghost
  assert.match(text(4), /^ {6} {4}go\(\); *$/);
  assert.match(text(5), /^ {6} {2}\} *$/);
  assert.match(text(6), /^ +3 +\}/, "line 3 pushed down by two rows");
  assert.deepEqual(ed.cellToPos(10, 6), { line: 2, col: 1 });
  s.server.close();
});

test("warm-up loads the model once per provider and model", async () => {
  let warm = 0;
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { warm++; res.end("{}"); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const ed = await editorWith(`http://127.0.0.1:${server.address().port}`, [""]);
  ed.inlineWarmup(); ed.inlineWarmup();
  assert.ok(await waitFor(() => warm === 1));
  server.close();
});
