// node --test mods/vscode-settings/test/settings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, parse, normalize, coreEngine, editorEngine, withSetting, withDefaults, serialize, updateFile, stepDelay, coreStatus, coreCurrent,
  editorStatus, editorCurrent, modelChoices, chosenModel, modelStatus, modelWarning, keyLine, endpointProblem, withProvider, withOwn, ownValue, ownKey } from "../settings.js";

// An in-memory file with writeTextFile's contract: writes only when `expected` still matches.
function memoryFile(text, { raceOnce = null } = {}) {
  const f = { text, writes: 0 };
  f.io = {
    read: async () => f.text,
    write: async (next, expected) => {
      if (raceOnce) { f.text = raceOnce; raceOnce = null; }
      if (expected !== f.text) throw new Error("stale");
      f.text = next; f.writes++;
    },
  };
  return f;
}

test("a missing or empty file means every default, engine js", () => {
  assert.deepEqual(normalize(parse(null)), { ...DEFAULTS, "editor.engine": "js", "editor.inlineSuggest.enabled": true });
  assert.deepEqual(normalize(parse("  ")), { ...DEFAULTS, "editor.engine": "js", "editor.inlineSuggest.enabled": true });
  assert.equal(coreEngine({}), "js");
  assert.equal(coreEngine({ "core.engine": "rust" }), "rust");
  assert.equal(coreEngine({ "core.engine": "go" }), "js");
});

test("the editor's engine is editor.engine, else the core's, as vsedit.sh picks it with RUST_READY=1", () => {
  assert.equal(editorEngine({}), "js");
  assert.equal(editorEngine({ "core.engine": "rust" }), "rust");
  assert.equal(editorEngine({ "core.engine": "rust", "editor.engine": "js" }), "js");
  assert.equal(editorEngine({ "editor.engine": "rust" }), "rust");
  assert.equal(editorEngine({ "core.engine": "rust", "editor.engine": "go" }), "rust");
  assert.throws(() => withSetting({}, "editor.engine", "go"));
  assert.deepEqual(withDefaults({ "editor.engine": "rust", "core.engine": "rust", "my.key": 1 }), { "my.key": 1, ...DEFAULTS });
});

test("comments and trailing commas are read; a non-object file is refused", () => {
  assert.equal(normalize(parse('{\n // c\n "editor.tabSize": 2, /* x */\n}'))["editor.tabSize"], 2);
  assert.throws(() => parse("[1]"));
  assert.throws(() => parse("{ broken"));
});

test("invalid values fall back to the default, numbers are clamped", () => {
  const v = normalize({ "files.autoSave": "sometimes", "files.autoSaveDelay": 99999, "editor.tabSize": 0, "editor.insertSpaces": "yes" });
  assert.equal(v["files.autoSave"], "off");
  assert.equal(v["files.autoSaveDelay"], 3600);
  assert.equal(v["editor.tabSize"], 1);
  assert.equal(v["editor.insertSpaces"], true);
  assert.equal(normalize({ "files.autoSaveDelay": 0 })["files.autoSaveDelay"], 0.1);
  assert.equal(normalize({ "editor.tabSize": 2.5 })["editor.tabSize"], 4);
});

test("cursor settings take VS Code's values only", () => {
  assert.deepEqual([normalize({})["editor.cursorStyle"], normalize({})["editor.cursorBlinking"]], ["line", "blink"]);
  assert.equal(normalize({ "editor.cursorStyle": "underline-thin" })["editor.cursorStyle"], "underline-thin");
  assert.equal(normalize({ "editor.cursorStyle": "fat" })["editor.cursorStyle"], "line");
  assert.equal(normalize({ "editor.cursorBlinking": "solid" })["editor.cursorBlinking"], "solid");
});

test("writing a setting keeps unknown keys and rejects invalid values", () => {
  const raw = { "workbench.colorTheme": "x", "files.autoSave": "off" };
  assert.deepEqual(withSetting(raw, "files.autoSaveDelay", "2.5"), { ...raw, "files.autoSaveDelay": 2.5 });
  assert.throws(() => withSetting(raw, "core.engine", "go"));
  assert.throws(() => withSetting(raw, "files.autoSaveDelay", "abc"));
  assert.deepEqual(withDefaults({ "my.key": 1, "editor.tabSize": 8 }), { "my.key": 1, ...DEFAULTS });
});

test("update writes valid JSON, keeps unknown keys and creates a missing file", async () => {
  const f = memoryFile('// mine\n{ "my.key": [1, 2], "editor.tabSize": 2, }');
  const v = await updateFile(f.io, (raw) => withSetting(raw, "core.engine", "rust"));
  assert.equal(v["core.engine"], "rust");
  assert.deepEqual(JSON.parse(f.text), { "my.key": [1, 2], "editor.tabSize": 2, "core.engine": "rust" });
  const empty = memoryFile(null);
  await updateFile(empty.io, (raw) => withSetting(raw, "editor.tabSize", 3));
  assert.equal(empty.text, serialize({ "editor.tabSize": 3 }));
});

test("a concurrent edit is re-read and merged once, never clobbered", async () => {
  const f = memoryFile('{"a": 1}', { raceOnce: '{"a": 1, "b": 2}' });
  await updateFile(f.io, (raw) => withSetting(raw, "editor.formatOnSave", true));
  assert.deepEqual(JSON.parse(f.text), { a: 1, b: 2, "editor.formatOnSave": true });
  const broken = memoryFile("{ nope");
  await assert.rejects(updateFile(broken.io, (raw) => raw));
  assert.equal(broken.writes, 0);
});

test("delay steps by tenths below a second and whole seconds above, within range", () => {
  assert.equal(stepDelay(1, 1), 2);
  assert.equal(stepDelay(1, -1), 0.9);
  assert.equal(stepDelay(0.5, 1), 0.6);
  assert.equal(stepDelay(0.1, -1), 0.1);
  assert.equal(stepDelay(3600, 1), 3600);
  assert.equal(stepDelay(2.5, -1), 1.5);
});

test("the Rust core status reads its version", () => {
  assert.equal(coreStatus(null), "Rust core: not built");
  assert.equal(coreStatus('{"version":"1.0.0","backend":"git","git":"2.54.0"}\n'), "Rust core: built (v1.0.0)");
  assert.equal(coreStatus('{"version":"0.1.0"}'), "Rust core: v0.1.0 is out of date (rebuild it)");
  assert.equal(coreStatus("ok"), "Rust core: built");
});

test("the Rust editor status reads its version and launch API", () => {
  assert.equal(editorStatus(null), "Rust editor: not built");
  assert.equal(editorStatus("vsedit 1.0.0 (api 2)\n"), "Rust editor: built (v1.0.0)");
  assert.equal(editorStatus("vsedit 1.0.0 (api 1)"), "Rust editor: v1.0.0 is out of date (rebuild it)");
  assert.equal(editorStatus("vsedit 0.9.0"), "Rust editor: v0.9.0 is out of date (rebuild it)");
  assert.equal(editorCurrent("vsedit 1.0.0 (api 2)"), true);
  assert.equal(editorCurrent(null), false);
});

test("only a binary of the mods' major version counts as built", () => {
  assert.equal(coreCurrent('{"version":"1.2.0"}'), true);
  assert.equal(coreCurrent('{"version":"0.1.0"}'), false);
  assert.equal(coreCurrent("ok"), false);
  assert.equal(coreCurrent(null), false);
});

test("inline suggestions: on unless set off, the provider one of the editor's, Reset to defaults removes the switch", () => {
  assert.equal(normalize({})["editor.inlineSuggest.enabled"], true);
  assert.equal(normalize({ "editor.inlineSuggest.enabled": false })["editor.inlineSuggest.enabled"], false);
  assert.equal(normalize({ "editor.inlineSuggest.provider": "nope" })["editor.inlineSuggest.provider"], "ollama");
  assert.deepEqual(withSetting({}, "editor.inlineSuggest.provider", "off"), { "editor.inlineSuggest.provider": "off" });
  for (const p of ["lmstudio", "codestral", "mercury"]) assert.equal(normalize({ "editor.inlineSuggest.provider": p })["editor.inlineSuggest.provider"], p);
  assert.equal(normalize({ "editor.inlineSuggest.provider": "deepseek" })["editor.inlineSuggest.provider"], "off", "DeepSeek, no longer offered, reads as Off");
  assert.deepEqual(withProvider({ "editor.inlineSuggest.provider": "deepseek", "editor.inlineSuggest.model": "deepseek-flash" }, "lmstudio"),
    { "editor.inlineSuggest.provider": "lmstudio", "editor.inlineSuggest.model": "" }, "picking another one keeps nothing of it");
  assert.throws(() => withSetting({}, "editor.inlineSuggest.enabled", "yes"));
  assert.equal("editor.inlineSuggest.enabled" in withDefaults({ "editor.inlineSuggest.enabled": false }), false);
});

test("the Inline Suggestion Model row: the default first, base models recommended, pulled or not, the file's own model", () => {
  const ollama = { models: ["qwen2.5-coder:1.5b-base", "qwen2.5-coder:7b-base", "qwen2.5-coder:7b"],
    recommended: ["qwen2.5-coder:1.5b-base", "qwen2.5-coder:7b-base"], pulled: ["qwen2.5-coder:7b-base", "qwen2.5-coder:7b"] };
  assert.deepEqual(modelChoices("", ollama, "ollama"), [["", "qwen2.5-coder:1.5b-base (default, not installed)"],
    ["qwen2.5-coder:7b-base", "qwen2.5-coder:7b-base (recommended)"], ["qwen2.5-coder:7b", "qwen2.5-coder:7b"]]);
  assert.deepEqual(modelChoices("starcoder2:3b", ollama).at(-1), ["starcoder2:3b", "starcoder2:3b"]);
  assert.deepEqual(modelChoices("", { models: ["codestral-latest", "codestral-2508"], recommended: ["codestral-latest"] }),
    [["", "codestral-latest (default)"], ["codestral-2508", "codestral-2508"]]);
  assert.equal(chosenModel("codestral-latest", { recommended: ["codestral-latest"] }), "", "the default's own name picks the default");
  assert.equal(chosenModel("codestral-2508", { recommended: ["codestral-latest"] }), "codestral-2508");
  assert.deepEqual(modelChoices("", null), [["", "Default"]]);
  assert.equal(withSetting({}, "editor.inlineSuggest.model", " codestral-2508 ")["editor.inlineSuggest.model"], "codestral-2508");
  assert.throws(() => withSetting({}, "editor.inlineSuggest.model", 3));
});

test("a local model is checked against the server's models; Ollama's foo is foo:latest", () => {
  const ollama = { models: ["a:latest", "b:7b"], recommended: [], pulled: ["a:latest", "b:7b"] };
  assert.equal(modelStatus("ollama", "a", ollama), "ok");
  assert.equal(modelStatus("ollama", "b", ollama), "missing", "only :latest may be left out");
  assert.equal(modelStatus("ollama", "b:7b", ollama), "ok");
  assert.equal(modelStatus("lmstudio", "a", { pulled: ["a:latest"] }), "missing", "LM Studio ids compare exactly");
  assert.equal(modelStatus("ollama", "a", null), null, "still listing: no verdict");
  assert.equal(modelStatus("ollama", "a", { error: "node: not found" }), null, "the listing failed: unknown");
  assert.equal(modelStatus("ollama", "a", { models: ["x"], recommended: ["x"], pulled: null }), "unreachable");
  assert.equal(modelStatus("codestral", "a", { models: ["x"], recommended: ["x"] }), null, "a hosted catalog isn't checked");
});

test("the Model field's note says how to get a missing model, or that the server can't be reached", () => {
  assert.equal(modelWarning("ollama", "foo", { pulled: [] }), "Not on this server. Run: ollama pull foo");
  assert.match(modelWarning("lmstudio", "foo", { pulled: [] }), /^Not on this server\. Download foo in LM Studio/);
  assert.equal(modelWarning("ollama", "foo", { pulled: null }), "Server unreachable: cannot check the model.");
  assert.equal(modelWarning("ollama", "foo", { pulled: ["foo:latest"] }), null);
  assert.equal(modelWarning("ollama", "foo", null), null);
  // unreachable: chips aren't marked, since nothing is known
  assert.deepEqual(modelChoices("", { models: ["x", "y"], recommended: ["x", "y"], pulled: null }, "ollama"), [["", "x (default)"], ["y", "y (recommended)"]]);
});

test("the API Key row shows where the key is and only its ends, or how to add one", () => {
  assert.equal(keyLine({ from: "keychain", masked: "sk-a…mnop" }), "Saved in the macOS keychain: sk-a…mnop");
  assert.match(keyLine({ from: "file", masked: "••••" }), /vscode-secrets.json \(mode 600\): ••••/);
  assert.match(keyLine({ from: "env", masked: "sk-a…mnop" }), /Editors Herdr opens may not see it/);
  assert.match(keyLine({ from: null, loose: true }), /^No key yet \(vscode-secrets.json is readable by others: chmod 600 it\)\. .*never to settings.json/);
  assert.equal(keyLine(null), "Checking for a key…");
  assert.match(keyLine({ error: "node: not found" }), /Cannot check the key: node: not found/);
  // a local server's key is optional: none is no warning
  assert.match(keyLine({ from: null }, true), /^No key \(none needed unless the server asks for one\)\. .*never to settings.json/);
  assert.equal(keyLine({ from: "keychain", masked: "••••" }, true), "Saved in the macOS keychain: ••••");
});

test("word wrap: VS Code's modes and indents, the column clamped to 1-500, off / 80 / same by default", () => {
  const v = normalize({});
  assert.deepEqual([v["editor.wordWrap"], v["editor.wordWrapColumn"], v["editor.wrappingIndent"]], ["off", 80, "same"]);
  const w = normalize({ "editor.wordWrap": "bounded", "editor.wordWrapColumn": 9999, "editor.wrappingIndent": "deepIndent" });
  assert.deepEqual([w["editor.wordWrap"], w["editor.wordWrapColumn"], w["editor.wrappingIndent"]], ["bounded", 500, "deepIndent"]);
  assert.equal(normalize({ "editor.wordWrap": "wrap" })["editor.wordWrap"], "off");
  assert.deepEqual(withSetting({}, "editor.wordWrapColumn", 0), { "editor.wordWrapColumn": 1 });
});

test("explorer.autoReveal: on by default, a boolean the toggle writes, anything else reads as on", () => {
  assert.equal(normalize({})["explorer.autoReveal"], true);
  assert.equal(normalize({ "explorer.autoReveal": false })["explorer.autoReveal"], false);
  assert.equal(normalize({ "explorer.autoReveal": "no" })["explorer.autoReveal"], true);
  assert.deepEqual(withSetting({ "my.key": 1 }, "explorer.autoReveal", false), { "my.key": 1, "explorer.autoReveal": false });
  assert.throws(() => withSetting({}, "explorer.autoReveal", "off"));
});

test("workbench.editor.preloadEditor: on by default, a boolean", () => {
  assert.equal(normalize({})["workbench.editor.preloadEditor"], true);
  assert.equal(normalize({ "workbench.editor.preloadEditor": false })["workbench.editor.preloadEditor"], false);
  assert.equal(normalize({ "workbench.editor.preloadEditor": "no" })["workbench.editor.preloadEditor"], true);
});

test("a server address is checked as typed: http(s), a host, a port in range; empty is the default", () => {
  for (const ok of ["", "  ", "http://127.0.0.1:11434", "http://192.168.0.10:1234/v1", "https://gpu.lan", "http://[::1]:11434/", "HTTP://Box:8080"]) assert.equal(endpointProblem(ok), null, ok);
  assert.match(endpointProblem("localhost:11434"), /^Start the address with http:\/\//);
  assert.match(endpointProblem("http://"), /^Not a server address/);
  assert.match(endpointProblem("http://a b:1"), /^Not a server address/);
  assert.match(endpointProblem("http://host:70000"), /^The port is 1–65535/);
  assert.throws(() => withOwn({}, "ollama", "endpoint", "ollama.lan:11434"), /Invalid value/);
});

test("each provider keeps its own model and address; switching moves the shared ones to the provider left", () => {
  let raw = withOwn({}, "ollama", "endpoint", "http://192.168.0.10:11434/");
  raw = withOwn(raw, "ollama", "model", "qwen2.5-coder:7b-base");
  raw = withProvider(raw, "lmstudio");
  raw = withOwn(raw, "lmstudio", "model", "qwen2.5-coder-7b");
  const v = normalize(raw);
  assert.deepEqual([ownValue(v, "ollama", "endpoint"), ownValue(v, "ollama", "model")], ["http://192.168.0.10:11434", "qwen2.5-coder:7b-base"]);
  assert.deepEqual([ownValue(v, "lmstudio", "endpoint"), ownValue(v, "lmstudio", "model")], ["", "qwen2.5-coder-7b"], "nothing from Ollama");
  assert.equal(ownValue(normalize(withProvider(raw, "codestral")), "codestral", "model"), "");
  // a file from before: the shared model and address belonged to the provider then chosen
  const moved = withProvider({ "editor.inlineSuggest.provider": "ollama", "editor.inlineSuggest.model": "starcoder2:3b", "editor.inlineSuggest.endpoint": "http://box:11434" }, "lmstudio");
  assert.deepEqual(moved, { "editor.inlineSuggest.provider": "lmstudio", "editor.inlineSuggest.model": "",
    [ownKey("ollama", "model")]: "starcoder2:3b", [ownKey("ollama", "endpoint")]: "http://box:11434" });
  assert.equal("editor.inlineSuggest.endpoint" in withOwn({ "editor.inlineSuggest.endpoint": "http://a:1" }, "ollama", "endpoint", ""), false);
  // invalid ones read as absent; Reset to defaults removes them all
  assert.equal(ownKey("lmstudio", "endpoint") in normalize({ [ownKey("lmstudio", "endpoint")]: "nope" }), false);
  assert.deepEqual(withDefaults(raw), { ...DEFAULTS });
});
