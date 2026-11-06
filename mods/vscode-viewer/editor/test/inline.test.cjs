// node --test mods/vscode-viewer/editor/test/inline.test.cjs — inline suggestions: the rules (inline.cjs) and the editor
// against a fake provider (a local HTTP stub speaking Ollama's /api/generate). No real model is called.
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

test("a provider pauses after N errors or 4N dropped replies in a row, at once on FIM tokens; empty replies never", () => {
  const h = new I.Health(3);
  h.record(null, "Ollama is not running"); h.record(null, "Ollama is not running");
  assert.equal(h.record(null), null, "a good reply resets the count");
  for (let i = 0; i < 2; i++) h.record(null, "Ollama is not running");
  assert.match(h.record(null, "Ollama is not running") ?? "", /3 errors in a row/);
  const d = new I.Health(3);
  for (let i = 0; i < 50; i++) assert.equal(d.record("empty"), null);
  assert.match(d.note, /empty/);
  for (let i = 0; i < 11; i++) assert.equal(d.record(i % 2 ? "prose" : "fence"), null);
  assert.equal(d.note, "the last reply was dropped: it was a Markdown code fence");
  assert.match(d.record("prose") ?? "", /12 replies in a row were dropped \(the last: it was prose, not code\); a base model does better/);
  assert.match(new I.Health(5).record("fim"), /FIM template tokens/);
});

test("FIM prompts per model family, sent raw with their stop tokens; other models use Ollama's suffix", () => {
  const cfg = I.config(S.normalize({}), () => true), ctx = { prefix: "a(", suffix: ")" };
  const body = (model, extra = {}) => I.request({ ...cfg, model, ...extra }, ctx, true).body;
  assert.deepEqual([body("qwen2.5-coder:1.5b-base").prompt, body("qwen2.5-coder:1.5b-base").raw], ["<|fim_prefix|>a(<|fim_suffix|>)<|fim_middle|>", true]);
  assert.ok(body("qwen2.5-coder:7b").options.stop.includes("<|endoftext|>"));
  assert.equal(body("codestral:22b").prompt, "[SUFFIX])[PREFIX] a(");
  assert.equal(body("deepseek-coder:6.7b-base").prompt, "<｜fim▁begin｜>a(<｜fim▁hole｜>)<｜fim▁end｜>");
  assert.equal(body("starcoder2:3b").prompt, "<fim_prefix>a(<fim_suffix>)<fim_middle>");
  assert.deepEqual([body("llama3").prompt, body("llama3").suffix, body("llama3").raw, body("llama3").options.stop], ["a(", ")", undefined, undefined]);
  assert.deepEqual(body("llama3", { multiline: false }).options.stop, ["\n"]);
  assert.equal(body("qwen2.5-coder:7b", { multiline: false }).options.stop.at(-1), "\n");
  assert.equal(body("qwen2.5-coder:7b").stream, true);
});

test("prose and Markdown fences are dropped or stripped, except in prose files, comments and strings", () => {
  const c = (raw, prefix = "services:\n  app:\n\n", extra = {}) => I.clean(raw, { prefix, suffix: "", multiline: true, ...extra });
  assert.deepEqual(c("This Docker Compose file defines two services: `selenium` and `app`. Here's a breakdown:"), { text: null, anomaly: "prose" });
  assert.deepEqual(c("\nThis `docker-compose.yml` file defines two services: `selenium` and `app`."), { text: null, anomaly: "prose" });
  assert.deepEqual(c("Here's the updated file:\n```yaml\nfoo: 1\n```"), { text: null, anomaly: "prose" });
  assert.deepEqual(c("```dockerfile"), { text: null, anomaly: "fence" });
  assert.deepEqual(c(" ```yaml\n"), { text: null, anomaly: "fence" });
  assert.deepEqual(c("```dockerfile\nCMD [\"python\", \"app.py\"]\n```\nThat runs it."), { text: "CMD [\"python\", \"app.py\"]", anomaly: null });
  assert.deepEqual(c("Return the lines without breaks.", '    """'), { text: "Return the lines without breaks.", anomaly: null }, "a docstring");
  assert.deepEqual(c("Starts the app and waits for it.", "  # "), { text: "Starts the app and waits for it.", anomaly: null }, "a comment");
  assert.deepEqual(c("Here's how it works.", "# Notes\n", { prose: true }), { text: "Here's how it works.", anomaly: null }, "Markdown");
  assert.deepEqual(c("SELECT name FROM users WHERE id = 1;", ""), { text: "SELECT name FROM users WHERE id = 1;", anomaly: null });
  assert.deepEqual(c("RUN apt-get update && apt-get install -y curl", ""), { text: "RUN apt-get update && apt-get install -y curl", anomaly: null });
  assert.deepEqual(I.clean("}", { prefix: "  x();\n", suffix: "\n}\n", multiline: true }), { text: null, anomaly: "echo" }, "only the text after the cursor");
  assert.ok(I.proseFile("/p/README.md") && I.proseFile("/p/notes.txt") && !I.proseFile("/p/compose.yml"));
});

test("a block ends at a shallower line, a closed bracket, two blank lines or the text after the cursor", () => {
  const cut = (text, prefix, suffix = "", final = true) => I.blockCut(text, { prefix, suffix }, final);
  // the rest of a function body: up to the line less indented than its first ("}" exists after the cursor)
  assert.deepEqual(cut("const s = xs.sort();\n  return s[0];\n}\n\nfunction g() {", "function f(xs) {\n  ", "\n}"), { text: "const s = xs.sort();\n  return s[0];", done: true });
  // a block the first line opens: up to its closing line
  assert.deepEqual(cut("if (a) {\n    go();\n  }\n  stop();", "  "), { text: "if (a) {\n    go();\n  }", done: true });
  // a statement sequence goes on past an inner block
  assert.deepEqual(cut("let n = 0;\n  for (const x of xs) {\n    n += x;\n  }\n  return n;\n}", "  ", "\n}").text, "let n = 0;\n  for (const x of xs) {\n    n += x;\n  }\n  return n;");
  // after an opener before the cursor: the body, not the brace closing it, unless the file ends there
  assert.deepEqual(cut("\n  return 1;\n}\nnext();", "function f() {", "\nmore();"),{ text: "\n  return 1;", done: true });
  assert.deepEqual(cut("\n  return 1;\n}\nnext();", "function f() {", ""), { text: "\n  return 1;\n}", done: true });
  // Python and YAML by indentation
  assert.deepEqual(cut("    with open(p) as f:\n        return f.read()\n\ndef main():", "def read(p):\n", "").text, "    with open(p) as f:\n        return f.read()");
  assert.deepEqual(cut("  db:\n    image: postgres\n  cache:\n    image: redis\nvolumes:\n  data:", "services:\n  app:\n    build: .\n").text, "  db:\n    image: postgres\n  cache:\n    image: redis");
  // two blank lines; the line the text after the cursor goes on with
  assert.deepEqual(cut("a = 1\n\n\nb = 2", ""), { text: "a = 1", done: true });
  assert.deepEqual(cut("xs.reduce((a, b) => a + b, 0);\n  return sum / xs.length;", "  const sum = ", "\n  return sum / xs.length;\n}"), { text: "xs.reduce((a, b) => a + b, 0);", done: true });
  // while streaming only complete lines count
  assert.deepEqual(cut("if (a) {\n    go();\n  }", "  ", "", false), { text: "if (a) {\n    go();", done: false });
  assert.deepEqual(I.clean("if (a) {\n    go();\n  }\n  stop();", { prefix: "  ", suffix: "", multiline: true }), { text: "if (a) {\n    go();\n  }", anomaly: null });
});

test("no suggestion after typing on a blank line after blank lines at the end; Accept Next Line takes a line", () => {
  assert.ok(I.quietEnd(["a: 1", "", ""], 2));
  assert.ok(!I.quietEnd(["a: 1", ""], 1), "right after the text");
  assert.ok(!I.quietEnd(["a: 1", "", "", "b: 2"], 2), "text below");
  assert.deepEqual([I.nextLineLength("abc\n  d"), I.nextLineLength("\n  d\n  e"), I.nextLineLength("abc")], [3, 4, 3]);
});

test("the model probe: missing (ollama pull), a chat template, or unknown", () => {
  const cfg = I.config(S.normalize({}), () => true);
  assert.deepEqual(I.modelInfo(404, { error: "model 'x' not found" }), { missing: true, chat: false });
  assert.deepEqual(I.modelInfo(200, { template: "{{- if .Suffix }}<|fim_prefix|>…{{ else }}{{ .Prompt }}{{ end }}" }), { missing: false, chat: false });
  assert.deepEqual(I.modelInfo(200, { template: "{{- range $i, $_ := .Messages }}…" }), { missing: false, chat: true });
  assert.equal(I.modelInfo(500, null), null);
  assert.equal(I.chatModel({ ...cfg, model: "qwen2.5-coder:7b" }, undefined), false, "not asked yet");
  assert.equal(I.chatModel({ ...cfg, model: "qwen2.5-coder:7b" }, null), true, "unknown: by its name");
  assert.equal(I.chatModel(cfg, null), false);
  assert.equal(I.show(cfg).url, "http://127.0.0.1:11434/api/show");
});

test("defaults: Ollama with qwen2.5-coder:1.5b-base on 127.0.0.1, blocks, on when Ollama can run, no daily limit", () => {
  const cfg = I.config(S.normalize({}), () => true);
  assert.deepEqual([cfg.provider, cfg.model, cfg.endpoint, cfg.enabled, cfg.limit, cfg.maxTokens, cfg.debounce, cfg.trigger, cfg.keepAlive, cfg.prefixChars, cfg.suffixChars, cfg.multiline],
    ["ollama", "qwen2.5-coder:1.5b-base", "http://127.0.0.1:11434", true, 0, 256, 250, "auto", "30m", 4000, 300, true]);
  assert.equal(I.config(S.normalize({}), () => false).enabled, false);
  assert.equal(I.config(S.normalize({ "editor.inlineSuggest.enabled": true }), () => false).enabled, true);
  assert.equal(I.config(S.normalize({ "editor.inlineSuggest.provider": "off" })).enabled, false);
  const body = I.request(cfg, { prefix: "p", suffix: "s" }).body;
  assert.deepEqual([body.prompt, body.raw, body.stream, body.keep_alive, body.options.num_predict], ["<|fim_prefix|>p<|fim_suffix|>s<|fim_middle|>", true, false, "30m", 256]);
  assert.ok(!body.options.stop.includes("\n"));
  assert.ok(!I.request({ ...cfg, multiline: false }, { prefix: "", suffix: "", nextLine: true }).body.options.stop.includes("\n"));
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
// A fake Ollama: answer(body) -> { response } | { chunks } (streamed) | { status, error } | null (never answers); delay in
// ms; /api/show answers s.show. prefixOf(body): the text before the cursor in a raw FIM prompt.
async function stub(answer, delay = 0) {
  const s = { bodies: [], closed: 0 };
  s.server = http.createServer((req, res) => {
    let data = "";
    req.on("data", d => { data += d; });
    req.on("end", () => {
      const body = JSON.parse(data);
      if (req.url === "/api/show") return res.end(JSON.stringify(s.show ?? { template: "{{ .Prompt }}" }));
      if (body.prompt === "" && body.options?.num_predict === 1) return res.end("{}"); // warmup
      s.bodies.push(body);
      res.on("close", () => { if (!res.writableEnded) s.closed++; });
      const a = answer(body);
      if (a == null) return;
      if (a.chunks) { // streamed: one NDJSON line per chunk, `delay` ms apart; the connection closed early stops it
        const send = (i) => { if (res.destroyed) return; if (i === a.chunks.length) return res.end(JSON.stringify({ response: "", done: true }) + "\n");
          res.write(JSON.stringify({ response: a.chunks[i], done: false }) + "\n"); s.sent = i + 1; setTimeout(() => send(i + 1), delay); };
        return send(0);
      }
      setTimeout(() => { res.statusCode = a.status ?? 200; res.end(JSON.stringify(a.error ? { error: a.error } : { response: a.response, done: true })); }, delay);
    });
  });
  await new Promise(r => s.server.listen(0, "127.0.0.1", r));
  s.endpoint = `http://127.0.0.1:${s.server.address().port}`;
  return s;
}
const prefixOf = (body) => body.prompt.slice("<|fim_prefix|>".length, body.prompt.indexOf("<|fim_suffix|>"));
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
  assert.equal(prefixOf(s.bodies[0]), "function add(a, b) {\n  return");
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

test("prose replies are never shown and pause the provider after 4N in a row; empty ones don't; a click resumes it", async () => {
  const s = await stub((b) => ({ response: prefixOf(b).endsWith("x") ? "" : "Here's a breakdown of each service:" }));
  const ed = await editorWith(s.endpoint, ["let a = 1;"], { "editor.inlineSuggest.stopAfter": 1 });
  for (const ch of "xxxx") { type(ed, ch); await waitFor(() => !ed.inline.busy && !ed.inline.timer, 500); await sleep(40); }
  assert.equal(s.bodies.length, 4, "empty replies don't pause");
  assert.match(ed.inlineStatus().hover(), /the last reply was empty/);
  for (const ch of "abcde") { type(ed, ch); await waitFor(() => !ed.inline.busy && !ed.inline.timer, 500); await sleep(40); assert.equal(ghost(ed), null, "prose shown"); }
  assert.equal(s.bodies.length, 8, "the 5th prose edit asks nothing");
  const st = ed.inlineStatus();
  assert.equal(st.text, "Ollama: paused");
  assert.match(st.hover(), /4 replies in a row were dropped \(the last: it was prose, not code\)/);
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

test("warm-up asks about the model and loads it once per provider and model", async () => {
  const hits = [];
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { hits.push(req.url); res.end(req.url === "/api/show" ? '{"template":"{{ .Prompt }}"}' : "{}"); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const ed = await editorWith(`http://127.0.0.1:${server.address().port}`, [""]);
  ed.inlineWarmup(); ed.inlineWarmup();
  assert.ok(await waitFor(() => hits.length === 2));
  assert.deepEqual(hits, ["/api/show", "/api/generate"]);
  assert.equal(ed.inlineStatus().text, "Ollama");
  server.close();
});

test("a model not pulled: the status bar says ollama pull, nothing is asked; a chat model gets a hint but is asked", async () => {
  const s = await stub(() => ({ response: "1;" }));
  s.show = { error: "model 'qwen2.5-coder:1.5b-base' not found" };
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.statusCode = 404; res.end(JSON.stringify(s.show)); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  let ed = await editorWith(`http://127.0.0.1:${server.address().port}`, ["x = "]);
  ed.inlineWarmup();
  assert.ok(await waitFor(() => ed.inline.models.size === 1));
  assert.equal(ed.inlineStatus().text, "Ollama: ollama pull qwen2.5-coder:1.5b-base");
  ed.inlineTrigger();
  assert.match(ed.message.text, /model qwen2.5-coder:1.5b-base not found \(run: ollama pull qwen2.5-coder:1.5b-base\)/);
  server.close();
  s.show = { template: "{{- range .Messages }}" };
  ed = await editorWith(s.endpoint, ["x = "], { "editor.inlineSuggest.model": "qwen2.5-coder:7b" });
  ed.inlineWarmup();
  assert.ok(await waitFor(() => ed.inline.models.size === 1));
  assert.equal(ed.inlineStatus().text, "Ollama: chat model");
  assert.match(ed.inlineStatus().hover(), /qwen2.5-coder:7b is a chat model .*\(ollama pull qwen2.5-coder:1.5b-base/);
  type(ed, "1");
  assert.ok(await waitFor(() => ghost(ed) === "1;"));
  s.server.close();
});

test("a streamed block shows its first lines as they come and stops reading where the block ends", async () => {
  const chunks = ["if (a) {\n", "    go();\n", "  }\n", "  stop();\n", "  more();\n", "  more();\n", "  more();\n"];
  const s = await stub(() => ({ chunks }), 60);
  const ed = await editorWith(s.endpoint, ["function f() {", "  ", "}"]);
  ed.moveTo({ line: 1, col: 2 }); ed.afterEvent();
  type(ed, "x"); key(ed, "backspace");
  assert.ok(await waitFor(() => ghost(ed) === "if (a) {"), "the first line before the rest");
  assert.ok(await waitFor(() => ghost(ed) === "if (a) {\n    go();\n  }" && !ed.inline.busy));
  assert.ok(await waitFor(() => s.closed === 1), "the reply was read to its end");
  assert.ok(s.sent < chunks.length);
  key(ed, "tab");
  assert.deepEqual(ed.lines, ["function f() {", "  if (a) {", "    go();", "  }", "}"]);
  s.server.close();
});

test("Accept Next Line takes one line of a block at a time", async () => {
  const s = await stub(() => ({ response: "a();\n  b();" }));
  const ed = await editorWith(s.endpoint, ["{", "  ", "}"]);
  ed.moveTo({ line: 1, col: 2 }); ed.afterEvent();
  type(ed, "x"); key(ed, "backspace");
  assert.ok(await waitFor(() => ghost(ed)));
  ed.runCommand("editor.action.inlineSuggest.acceptNextLine");
  assert.equal(ed.lines[1], "  a();");
  assert.equal(ghost(ed), "\n  b();");
  ed.runCommand("editor.action.inlineSuggest.acceptNextLine");
  assert.deepEqual(ed.lines.slice(0, 3), ["{", "  a();", "  b();"]);
  assert.equal(ghost(ed), null);
  s.server.close();
});

test("typing on a blank line after blank lines at the end asks nothing; Alt+\\ still does", async () => {
  const s = await stub(() => ({ response: "volumes:" }));
  const ed = await editorWith(s.endpoint, ["services:", "  app: {}", "", ""]);
  type(ed, " "); key(ed, "backspace");
  await sleep(100);
  assert.equal(s.bodies.length, 0);
  key(ed, "\\", { alt: true });
  assert.ok(await waitFor(() => ghost(ed) === "volumes:"));
  s.server.close();
});
