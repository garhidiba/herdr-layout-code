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
// Keys never come from this machine's keychain, secrets file or environment: a fake `security` keeps its items in a file.
const FAKE_SECURITY = `#!/bin/sh
echo "$*" >> "$FAKE_KEYCHAIN.argv"
case "$1" in
  find-generic-password) k=$(grep "^$3	" "$FAKE_KEYCHAIN" 2>/dev/null | tail -1 | cut -f2); [ -n "$k" ] && echo "$k" && exit 0; exit 44;;
  delete-generic-password) grep -v "^$3	" "$FAKE_KEYCHAIN" > "$FAKE_KEYCHAIN.tmp" 2>/dev/null; mv "$FAKE_KEYCHAIN.tmp" "$FAKE_KEYCHAIN"; exit 0;;
  -i) read -r line; svc=$(echo "$line" | sed -n 's/.* -s \\([^ ]*\\) .*/\\1/p'); key=$(echo "$line" | sed -n 's/.* -w "\\(.*\\)"$/\\1/p')
      printf '%s\\t%s\\n' "$svc" "$key" >> "$FAKE_KEYCHAIN"; exit 0;;
esac
exit 1
`;
fs.writeFileSync(path.join(tmp, "security"), FAKE_SECURITY, { mode: 0o755 });
Object.assign(process.env, { VSEDIT_SECURITY: path.join(tmp, "security"), FAKE_KEYCHAIN: path.join(tmp, "keychain"), VSEDIT_SECRETS: path.join(tmp, "secrets.json") });
for (const env of [...Object.values(I.HOSTED).map(p => p.env), "OLLAMA_API_KEY", "LMSTUDIO_API_KEY"]) delete process.env[env];
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


// ---------- hosted providers (Codestral, Mercury): one FIM adapter, keys, limits, cost ----------
test("hosted providers: one FIM request shape, their URLs and models, a Bearer key, Codestral's cache key", () => {
  const cfgOf = (provider, extra = {}) => I.config(S.normalize({ "editor.inlineSuggest.provider": provider, ...extra }), () => true);
  const want = { codestral: ["https://api.mistral.ai/v1/fim/completions", "codestral-latest"],
    mercury: ["https://api.inceptionlabs.ai/v1/fim/completions", "mercury-edit-2"] };
  for (const [p, [url, model]] of Object.entries(want)) {
    const cfg = cfgOf(p), r = I.request(cfg, { prefix: "a(", suffix: ")", file: "/p/x.ts" }, true, "sk-test");
    assert.deepEqual([r.url, r.body.model, r.body.prompt, r.body.suffix, r.body.max_tokens, r.body.stream, r.body.stop, r.headers.Authorization],
      [url, model, "a(", ")", 256, true, undefined, "Bearer sk-test"], p);
    assert.equal("prompt_cache_key" in r.body, p === "codestral", p);
    assert.deepEqual([cfg.limit, cfg.hosted], [2000, true], "2,000 requests a day unless set");
  }
  assert.deepEqual(I.request(cfgOf("mercury", { "editor.inlineSuggest.multiline": false }), { prefix: "", suffix: "" }).body.stop, ["\n"]);
  assert.deepEqual([cfgOf("deepseek").provider, cfgOf("deepseek").enabled, I.PROVIDERS.includes("deepseek")], ["off", false, false], "DeepSeek, no longer offered, is off");
  assert.equal(I.request(cfgOf("codestral"), { prefix: "", suffix: "", file: "/p/x.ts" }).body.prompt_cache_key, I.cacheKey("/p/x.ts"));
  assert.equal(cfgOf("codestral", { "editor.inlineSuggest.dailyRequestLimit": 0 }).limit, 0);
  assert.equal(cfgOf("ollama").limit, 0);
  assert.equal(cfgOf("codestral", { "editor.inlineSuggest.endpoint": "http://127.0.0.1:9/fim" }).endpoint, "http://127.0.0.1:9/fim");
});

test("replies of every shape; errors and a refused key say what to do", () => {
  const cfg = I.config(S.normalize({ "editor.inlineSuggest.provider": "codestral" }), () => true);
  assert.deepEqual(I.reply(cfg, 200, { choices: [{ message: { content: "x" } }] }), ["x"]);
  assert.deepEqual(I.reply(cfg, 200, { choices: [{ text: "y" }] }), ["y"]);
  assert.deepEqual(I.reply(cfg, 200, { response: "z" }), ["z"]);
  assert.throws(() => I.reply(cfg, 401, { message: "Unauthorized" }), /Codestral: the API key was refused \(HTTP 401\); no API key: security add-generic-password -U -s herdr-vscode-codestral/);
  assert.throws(() => I.reply(cfg, 429, { error: { message: "Rate limit" } }), /^Error: Codestral: Rate limit$/);
  assert.throws(() => I.reply(cfg, 422, { object: "error", message: "bad suffix" }), /Codestral: bad suffix/);
});

test("usage shows today's approximate cost at the provider's price, which settings override", () => {
  const u = { requests: 2, inChars: 4_000_000, outChars: 400_000, ms: [] }; // 1M tokens in, 0.1M out
  const cfgOf = (extra = {}) => I.config(S.normalize({ "editor.inlineSuggest.provider": "codestral", ...extra }), () => true);
  assert.match(I.usageText(cfgOf(), u), /today 2 requests \(limit 2000\) · ~1000.0k in \/ 100.0k out tokens · ~\$0\.39$/);
  assert.match(I.usageText(cfgOf({ "editor.inlineSuggest.price": { input: 1, output: 10 } }), u), /~\$2\.00$/);
  assert.equal(I.cost(I.config(S.normalize({})), u), null, "Ollama is free");
});

test("API keys: the keychain, then the secrets file only at mode 600, then the environment; saved through stdin", () => {
  const kc = process.env.FAKE_KEYCHAIN, file = process.env.VSEDIT_SECRETS;
  fs.rmSync(kc, { force: true }); fs.rmSync(kc + ".argv", { force: true }); fs.rmSync(file, { force: true });
  assert.deepEqual(I.apiKey("codestral"), { key: null, loose: false });
  process.env.MISTRAL_API_KEY = "env-key";
  assert.deepEqual(I.apiKey("codestral"), { key: "env-key", from: "env" });
  fs.writeFileSync(file, JSON.stringify({ codestral: "file-key" }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.deepEqual(I.apiKey("codestral"), { key: "env-key", from: "env" }, "a file others can read is ignored");
  fs.chmodSync(file, 0o600);
  assert.deepEqual(I.apiKey("codestral"), { key: "file-key", from: "file" });
  assert.equal(I.saveKey("codestral", "kc-key-1234567890"), "keychain");
  assert.deepEqual(I.apiKey("codestral"), { key: "kc-key-1234567890", from: "keychain" });
  assert.ok(!fs.readFileSync(kc + ".argv", "utf8").includes("kc-key"), "the key was in security's arguments");
  I.removeKey("codestral");
  delete process.env.MISTRAL_API_KEY;
  assert.deepEqual(I.apiKey("codestral"), { key: null, loose: false }, "removed from the keychain and the file");
  // no keychain: the file, created at 600
  process.env.VSEDIT_SECURITY = "/usr/bin/false";
  fs.rmSync(file, { force: true });
  assert.equal(I.saveKey("mercury", "m-key"), "file");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(I.apiKey("mercury"), { key: "m-key", from: "file" });
  assert.throws(() => I.saveKey("mercury", 'a "quoted" key'), /characters/);
  process.env.VSEDIT_SECURITY = path.join(tmp, "security");
  assert.equal(I.maskKey("sk-abcdefghijklmnop"), "sk-a…mnop");
});

// A fake hosted FIM API: SSE events in the provider's shape (Mistral's chat-like delta, Mercury's text).
async function hostedStub(provider, answer) {
  const s = { bodies: [], auth: [] };
  s.server = http.createServer((req, res) => {
    let data = "";
    req.on("data", d => { data += d; });
    req.on("end", () => {
      const body = JSON.parse(data), text = answer(body);
      s.bodies.push(body); s.auth.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer sk-good") { res.statusCode = 401; return res.end(JSON.stringify({ message: "Unauthorized" })); }
      res.setHeader("Content-Type", "text/event-stream");
      for (const piece of text.match(/[^\n]*\n?/g).filter(Boolean)) {
        const choice = provider === "codestral" ? { delta: { content: piece } } : { text: piece };
        res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise(r => s.server.listen(0, "127.0.0.1", r));
  s.endpoint = `http://127.0.0.1:${s.server.address().port}/v1/fim/completions`;
  return s;
}

test("hosted providers in the editor: streamed blocks cut, fences stripped, prose dropped; no key says how to add one", async () => {
  fs.rmSync(process.env.VSEDIT_SECRETS, { force: true }); fs.rmSync(process.env.FAKE_KEYCHAIN, { force: true });
  const replies = { q: "```js\nuit();\n```", p: "Here's a breakdown of each service:", i: "f (a) {\n    go();\n  }\n  stop();" };
  for (const provider of ["codestral", "mercury"]) {
    const s = await hostedStub(provider, (b) => replies[b.prompt.at(-1)] ?? "");
    const env = I.HOSTED[provider].env;
    process.env[env] = "sk-good";
    const ed = await editorWith(s.endpoint, ["function f() {", "  ", "}"], { "editor.inlineSuggest.provider": provider });
    ed.moveTo({ line: 1, col: 2 }); ed.afterEvent();
    type(ed, "i");
    assert.ok(await waitFor(() => ghost(ed) === "f (a) {\n    go();\n  }" && !ed.inline.busy), `${provider}: the block`);
    assert.equal(s.auth[0], "Bearer sk-good");
    key(ed, "backspace"); type(ed, "q");
    assert.ok(await waitFor(() => ghost(ed) === "uit();"), `${provider}: the fenced reply`);
    key(ed, "escape"); key(ed, "backspace"); type(ed, "p");
    assert.ok(await waitFor(() => !ed.inline.busy && s.bodies.at(-1).prompt.endsWith("p")), provider);
    assert.equal(ghost(ed), null, `${provider}: prose shown`);
    assert.equal(ed.inlineStatus().text, LABEL[provider]);
    assert.match(ed.inlineStatus().hover(), /the last reply was dropped: it was prose/);
    delete process.env[env];
    s.server.close();
  }
  const ed = await editorWith("http://127.0.0.1:9/fim", ["x = "], { "editor.inlineSuggest.provider": "mercury" });
  assert.equal(ed.inlineStatus().text, "Mercury: no API key");
  ed.inlineTrigger();
  assert.match(ed.message.text, /Mercury: no API key: security add-generic-password -U -s herdr-vscode-mercury -a herdr -w <key>/);
});
const LABEL = { codestral: "Codestral", mercury: "Mercury" };

test("a refused key is an error in the status bar", async () => {
  const s = await hostedStub("mercury", () => "x");
  process.env.INCEPTION_API_KEY = "sk-bad";
  const ed = await editorWith(s.endpoint, ["x = "], { "editor.inlineSuggest.provider": "mercury" });
  type(ed, "1");
  assert.ok(await waitFor(() => ed.inline.error));
  assert.match(ed.inline.error, /Mercury: the API key was refused \(HTTP 401\)/);
  assert.equal(ed.inlineStatus().text, "Mercury: error");
  delete process.env.INCEPTION_API_KEY;
  s.server.close();
});

test("the Settings dialog's helper: a masked key, saving from a file it deletes, a test request, the model lists", async () => {
  const cli = (...args) => require("child_process").spawnSync(process.execPath, [path.join(__dirname, "..", "inline.cjs"), ...args], { encoding: "utf8", env: process.env });
  const out = (...args) => JSON.parse(cli(...args).stdout);
  fs.rmSync(process.env.FAKE_KEYCHAIN, { force: true });
  assert.match(out("--key", "codestral").help, /security add-generic-password/);
  const dir = fs.mkdtempSync(path.join(tmp, "key-")), file = path.join(dir, "key");
  fs.writeFileSync(file, "sk-good\n", { mode: 0o600 });
  assert.deepEqual(out("--save-key", "codestral", file), { from: "keychain", masked: "••••" });
  assert.ok(!fs.existsSync(dir), "the key file and its folder are deleted");
  assert.deepEqual(out("--key", "codestral"), { from: "keychain", masked: "••••" });
  const s = await hostedStub("codestral", () => " a + b");
  const ok = await new Promise(r => require("child_process").execFile(process.execPath, [path.join(__dirname, "..", "inline.cjs"), "--test", "codestral", "", s.endpoint], { env: process.env }, (_e, o) => r(JSON.parse(o))));
  assert.equal(ok.ok, true); assert.equal(typeof ok.ms, "number");
  assert.equal(s.bodies[0].max_tokens, 16);
  s.server.close();
  assert.deepEqual(out("--remove-key", "codestral"), { removed: true });
  assert.equal(out("--key", "codestral").from, null);
  assert.deepEqual(out("--models", "mercury").recommended, ["mercury-edit-2"]);
  assert.match(out("--key", "ollama").help, /security add-generic-password -U -s herdr-vscode-ollama .*OLLAMA_API_KEY/);
});

// ---------- local servers: their own address and model, LM Studio ----------
test("each provider keeps its own server address and model; the shared keys apply only where a provider has none", () => {
  const raw = { "editor.inlineSuggest.ollama.endpoint": "http://192.168.1.20:11434/", "editor.inlineSuggest.ollama.model": "starcoder2:3b",
    "editor.inlineSuggest.lmstudio.endpoint": "http://127.0.0.1:4321/v1", "editor.inlineSuggest.lmstudio.model": "qwen2.5-coder-7b" };
  const of = (provider, extra = {}) => I.config(I.normalize({ ...raw, "editor.inlineSuggest.provider": provider, ...extra }));
  assert.deepEqual([of("ollama").endpoint, of("ollama").model], ["http://192.168.1.20:11434", "starcoder2:3b"]);
  assert.deepEqual([of("lmstudio").endpoint, of("lmstudio").model], ["http://127.0.0.1:4321", "qwen2.5-coder-7b"], "LM Studio's /v1 is the requests' own");
  assert.deepEqual([of("lmstudio", { "editor.inlineSuggest.lmstudio.model": " " }).model, of("lmstudio").label], ["qwen2.5-coder-1.5b", "LM Studio"]);
  const codestral = of("codestral");
  assert.deepEqual([codestral.endpoint, codestral.model], ["https://api.mistral.ai/v1/fim/completions", "codestral-latest"], "nothing crosses to another provider");
  assert.equal(of("codestral", { "editor.inlineSuggest.endpoint": "http://127.0.0.1:9/fim" }).endpoint, "http://127.0.0.1:9/fim");
  assert.equal(of("ollama", { "editor.inlineSuggest.model": "shared" }).model, "starcoder2:3b", "the provider's own model wins");
  assert.deepEqual([I.config(I.normalize({ "editor.inlineSuggest.provider": "lmstudio" })).endpoint, of("ollama").customEndpoint], ["http://127.0.0.1:1234", true]);
});

test("LM Studio's request: /v1/completions with the raw FIM prompt and its stops; a model without a template sends `suffix`", () => {
  const ctx = { prefix: "a = ", suffix: "\nb", nextLine: false };
  const cfg = I.config(I.normalize({ "editor.inlineSuggest.provider": "lmstudio", "editor.inlineSuggest.multiline": false }));
  const r = I.request(cfg, ctx, true);
  assert.equal(r.url, "http://127.0.0.1:1234/v1/completions");
  assert.deepEqual(r.headers, { "Content-Type": "application/json" });
  assert.equal(r.body.prompt, "<|fim_prefix|>a = <|fim_suffix|>\nb<|fim_middle|>");
  assert.deepEqual([r.body.model, r.body.max_tokens, r.body.stream, "suffix" in r.body, r.body.stop.at(-1)], ["qwen2.5-coder-1.5b", 256, true, false, "\n"]);
  const plain = I.request({ ...cfg, model: "llama-3.2-1b" }, ctx);
  assert.deepEqual([plain.body.prompt, plain.body.suffix, plain.body.stop], ["a = ", "\nb", ["\n"]]);
  assert.equal(I.failure(cfg, { cause: { code: "ECONNREFUSED" } }), "LM Studio is not running at http://127.0.0.1:1234 (start its server: the Developer tab, or lms server start)");
  assert.throws(() => I.reply(cfg, 404, { error: { message: "Model 'x' not found" } }), /LM Studio: model qwen2.5-coder-1.5b not found \(download and load it in LM Studio, or run: lms get qwen2.5-coder-1.5b\)/);
});

// A fake LM Studio: GET /v1/models lists `models`; POST /v1/completions answers SSE `choices[].text` (or `error`).
async function lmStub(models, answer) {
  const s = { bodies: [], urls: [] };
  s.server = http.createServer((req, res) => {
    let data = "";
    req.on("data", d => { data += d; });
    req.on("end", () => {
      s.urls.push(`${req.method} ${req.url}`);
      if (req.url === "/v1/models") return res.end(JSON.stringify({ object: "list", data: models.map(id => ({ id, object: "model" })) }));
      if (req.url !== "/v1/completions") { res.statusCode = 404; return res.end("{}"); }
      const body = JSON.parse(data), a = answer(body);
      s.bodies.push(body);
      if (a.error) { res.statusCode = a.status ?? 400; return res.end(JSON.stringify({ error: { message: a.error } })); }
      if (!body.stream) return res.end(JSON.stringify({ choices: [{ text: a.text }] }));
      res.setHeader("Content-Type", "text/event-stream");
      for (const piece of a.text.match(/[^\n]*\n?/g).filter(Boolean)) res.write(`data: ${JSON.stringify({ choices: [{ text: piece }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise(r => s.server.listen(0, "127.0.0.1", r));
  s.endpoint = `http://127.0.0.1:${s.server.address().port}`;
  return s;
}

test("the editor with LM Studio: its own address and model reach the request, Ollama's don't", async () => {
  const s = await lmStub([], () => ({ text: " a + b;" }));
  const ed = await editorWith("", ["function add(a, b) {", "  "], { "editor.inlineSuggest.provider": "lmstudio",
    "editor.inlineSuggest.lmstudio.endpoint": `${s.endpoint}/v1`, "editor.inlineSuggest.lmstudio.model": "qwen2.5-coder-7b",
    "editor.inlineSuggest.ollama.endpoint": "http://127.0.0.1:9", "editor.inlineSuggest.ollama.model": "starcoder2:3b" });
  type(ed, "return");
  assert.ok(await waitFor(() => ghost(ed) === " a + b;"), "no suggestion");
  assert.deepEqual(s.urls, ["POST /v1/completions"]);
  assert.equal(s.bodies[0].model, "qwen2.5-coder-7b");
  assert.equal(prefixOf(s.bodies[0]), "function add(a, b) {\n  return");
  assert.equal(ed.inlineStatus().text, "LM Studio");
  s.server.close();
});

test("the Settings dialog's helper for local servers: their models (none when off), and a Test that says why it failed", async () => {
  const run = (...args) => new Promise(r => require("child_process").execFile(process.execPath, [path.join(__dirname, "..", "inline.cjs"), ...args], { env: process.env }, (_e, o) => r(JSON.parse(o))));
  const s = await lmStub(["qwen2.5-coder-14b", "qwen2.5-coder-7b-instruct", "text-embedding-nomic-embed-text-v1.5", "llama-3.2-1b"],
    (b) => b.model === "missing" ? { status: 404, error: "Model 'missing' not found" } : b.model === "deepseek-coder-1.3b-base" ? { text: "<｜fim▁hole｜>x" } : { text: " a + b" });
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, "127.0.0.1", r));
  const dead = `http://127.0.0.1:${closed.address().port}`; // nothing answers there
  closed.close();
  const listed = await run("--models", "lmstudio", s.endpoint);
  assert.deepEqual(listed.pulled, ["qwen2.5-coder-14b", "qwen2.5-coder-7b-instruct", "llama-3.2-1b"], "embedding models aren't listed");
  assert.deepEqual(listed.recommended, ["qwen2.5-coder-1.5b", "qwen2.5-coder-7b", "deepseek-coder-6.7b-base", "starcoder2-3b", "qwen2.5-coder-14b"]);
  assert.deepEqual(listed.models.slice(-2), ["qwen2.5-coder-7b-instruct", "llama-3.2-1b"]);
  const off = await run("--models", "lmstudio", dead);
  assert.deepEqual([off.pulled, off.models], [null, off.recommended], "a server that is off: only the recommended, none marked not pulled");
  assert.equal((await run("--models", "ollama", dead)).pulled, null);
  const ok = await run("--test", "lmstudio", "qwen2.5-coder-14b", s.endpoint);
  assert.equal(ok.ok, true);
  assert.deepEqual([s.bodies[0].model, s.bodies[0].max_tokens, s.bodies[0].stream], ["qwen2.5-coder-14b", 16, false]);
  assert.match((await run("--test", "lmstudio", "missing", s.endpoint)).error, /^LM Studio: model missing not found/);
  assert.match((await run("--test", "lmstudio", "llama-3.2-1b", s.endpoint)).error, /^LM Studio: FIM not supported: llama-3.2-1b has no fill-in-the-middle template/);
  assert.match((await run("--test", "lmstudio", "deepseek-coder-1.3b-base", s.endpoint)).error, /^LM Studio: FIM not supported: the reply had template tokens/);
  assert.ok((await run("--test", "lmstudio", "", dead)).error.startsWith(`LM Studio is not running at ${dead} (`));
  assert.ok((await run("--test", "ollama", "", dead)).error.startsWith(`Ollama is not running at ${dead} (`));
  s.server.close();
  const o = await stub(() => ({ status: 400, error: "starcoder2:3b does not support insert" }));
  assert.match((await run("--test", "ollama", "starcoder2:3b", o.endpoint)).error, /^Ollama: FIM not supported: starcoder2:3b does not support insert/);
  o.server.close();
});

// ---------- a local server's optional key (a proxy or a protected server in front of it) ----------
test("a local server gets a Bearer key only when one is stored; a 401 / 403 says it needs one", () => {
  const ctx = { prefix: "a = ", suffix: "", nextLine: false };
  for (const p of ["ollama", "lmstudio"]) {
    const cfg = I.config(I.normalize({ "editor.inlineSuggest.provider": p }));
    assert.deepEqual(I.request(cfg, ctx, true).headers, { "Content-Type": "application/json" }, p);
    assert.equal(I.request(cfg, ctx, true, "fake-key").headers.Authorization, "Bearer fake-key", p);
  }
  const ollama = I.config(I.normalize({}));
  assert.equal(I.show(ollama, "fake-key").headers.Authorization, "Bearer fake-key");
  assert.equal(I.warmup(ollama, "fake-key").headers.Authorization, "Bearer fake-key");
  assert.equal(I.show(ollama).headers.Authorization, undefined);
  assert.throws(() => I.reply(ollama, 401, { error: "Unauthorized" }), /^Error: Ollama: the server needs an API key or refused it \(HTTP 401\); add one: security add-generic-password -U -s herdr-vscode-ollama .*OLLAMA_API_KEY\)$/);
  const lm = I.config(I.normalize({ "editor.inlineSuggest.provider": "lmstudio" }));
  assert.throws(() => I.reply(lm, 403, {}), /^Error: LM Studio: the server needs an API key or refused it \(HTTP 403\); .*herdr-vscode-lmstudio.*LMSTUDIO_API_KEY\)$/);
});

// A protected local server (both shapes: Ollama's /api/*, LM Studio's /v1/*): answers only `Bearer <s.need>`, else 401;
// s.auth logs each request's Authorization header (null: none).
async function guardedStub() {
  const s = { auth: [], need: null };
  s.server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      s.auth.push(`${req.url} ${req.headers.authorization ?? null}`);
      if (s.need && req.headers.authorization !== `Bearer ${s.need}`) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Unauthorized" })); }
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b-base" }] }));
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "qwen2.5-coder-7b" }] }));
      if (req.url === "/api/show") return res.end(JSON.stringify({ template: "{{ .Prompt }}" }));
      res.end(JSON.stringify(req.url === "/v1/completions" ? { choices: [{ text: " 1" }] } : { response: " 1", done: true }));
    });
  });
  await new Promise(r => s.server.listen(0, "127.0.0.1", r));
  s.endpoint = `http://127.0.0.1:${s.server.address().port}`;
  return s;
}

test("the Settings helper sends each local server its own key, only when stored, to --models and --test", async () => {
  const run = (...args) => new Promise(r => require("child_process").execFile(process.execPath, [path.join(__dirname, "..", "inline.cjs"), ...args], { env: process.env }, (_e, o) => r(JSON.parse(o))));
  fs.rmSync(process.env.FAKE_KEYCHAIN, { force: true }); fs.rmSync(process.env.VSEDIT_SECRETS, { force: true });
  const s = await guardedStub();
  assert.equal((await run("--test", "ollama", "", s.endpoint)).ok, true, "no key, an open server: works as before");
  assert.deepEqual(s.auth, ["/api/generate null"], "no key: no Authorization header");
  s.need = "ol-fake"; s.auth = [];
  assert.match((await run("--test", "ollama", "", s.endpoint)).error, /^Ollama: the server needs an API key or refused it \(HTTP 401\)/);
  assert.equal((await run("--models", "ollama", s.endpoint)).pulled, null, "refused: listed as a server that didn't answer");
  fs.writeFileSync(process.env.FAKE_KEYCHAIN, "herdr-vscode-lmstudio\tlm-fake\n"); // LM Studio's key only
  assert.match((await run("--test", "ollama", "", s.endpoint)).error, /HTTP 401/, "LM Studio's key is not Ollama's");
  assert.ok(s.auth.every(a => a.endsWith(" null")), "Ollama never got another provider's key");
  fs.writeFileSync(process.env.VSEDIT_SECRETS, JSON.stringify({ ollama: "ol-fake" }), { mode: 0o600 });
  s.auth = [];
  assert.equal((await run("--test", "ollama", "", s.endpoint)).ok, true);
  assert.deepEqual((await run("--models", "ollama", s.endpoint)).pulled, ["qwen2.5-coder:7b-base"]);
  assert.deepEqual(s.auth, ["/api/generate Bearer ol-fake", "/api/tags Bearer ol-fake"]);
  s.need = "lm-fake"; s.auth = [];
  assert.deepEqual((await run("--models", "lmstudio", s.endpoint)).pulled, ["qwen2.5-coder-7b"]);
  assert.equal((await run("--test", "lmstudio", "", s.endpoint)).ok, true);
  assert.deepEqual(s.auth, ["/v1/models Bearer lm-fake", "/v1/completions Bearer lm-fake"]);
  assert.deepEqual(await run("--key", "lmstudio"), { from: "keychain", masked: "••••" });
  fs.rmSync(process.env.FAKE_KEYCHAIN, { force: true }); fs.rmSync(process.env.VSEDIT_SECRETS, { force: true });
  s.server.close();
});

test("the editor with a protected local server: no key is an error, not a warning; a key saved after it is used", async () => {
  fs.rmSync(process.env.FAKE_KEYCHAIN, { force: true }); fs.rmSync(process.env.VSEDIT_SECRETS, { force: true });
  const s = await guardedStub();
  s.need = "lm-fake";
  const ed = await editorWith("", ["x = "], { "editor.inlineSuggest.provider": "lmstudio", "editor.inlineSuggest.lmstudio.endpoint": s.endpoint });
  assert.equal(ed.inlineStatus().text, "LM Studio", "no key: no warning");
  type(ed, "1");
  assert.ok(await waitFor(() => ed.inline.error));
  assert.match(ed.inline.error, /^LM Studio: the server needs an API key or refused it \(HTTP 401\)/);
  assert.deepEqual(s.auth, ["/v1/completions null"]);
  fs.writeFileSync(process.env.FAKE_KEYCHAIN, "herdr-vscode-lmstudio\tlm-fake\n");
  type(ed, " ");
  assert.ok(await waitFor(() => s.auth.length === 2), "no request after the key was saved");
  assert.equal(s.auth[1], "/v1/completions Bearer lm-fake");
  assert.ok(await waitFor(() => ghost(ed)), `no suggestion: ${ed.inline.error}`);
  fs.rmSync(process.env.FAKE_KEYCHAIN, { force: true });
  s.server.close();
});
