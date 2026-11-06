// node --test mods/vscode-spaces/test/agents.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spaceAgents, fit, describe } from "../agents.js";

const claude = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, agent: true };
const codex = { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: true, agent: true };
const agent = (space, address, program, status = "idle", app = null) => ({ space, address, program, status, app });

test("agents are grouped by the space they run in", () => {
  const map = spaceAgents([agent("s1", "t1", claude), agent("s2", "t2", codex)]);
  assert.deepEqual([...map.keys()], ["s1", "s2"]);
  assert.equal(map.get("s1")[0].key, "claude");
  assert.equal(map.get("s2")[0].key, "codex");
});

test("a space without agents has no entry, so its row shows no icons", () => {
  assert.equal(spaceAgents([agent("s1", "t1", claude)]).get("s2"), undefined);
  assert.equal(spaceAgents(undefined).size, 0);
});

test("two agents of one kind make one icon that shows the more urgent status", () => {
  const [kind, ...rest] = spaceAgents([agent("s1", "t1", claude, "idle"), agent("s1", "t2", claude, "working"), agent("s1", "t3", claude, "idle")]).get("s1");
  assert.equal(rest.length, 0);
  assert.equal(kind.status, "working");
  assert.deepEqual(kind.names, ["Claude Code", "Claude Code", "Claude Code"]);
});

test("kinds keep the order they first appear in", () => {
  const kinds = spaceAgents([agent("s1", "t1", codex), agent("s1", "t2", claude), agent("s1", "t3", codex)]).get("s1");
  assert.deepEqual(kinds.map((k) => k.key), ["codex", "claude"]);
});

test("agents the program table doesn't know go by what they reported", () => {
  const unknown = { key: "agent", name: "Agent", icon: null, tint: false, agent: true };
  const kinds = spaceAgents([agent("s1", "t1", unknown, "idle", "pi"), agent("s1", "t2", unknown, "idle", "goose")]).get("s1");
  assert.deepEqual(kinds.map((k) => k.key), ["pi", "goose"]);
});

test("up to three kinds all show; more show two and +N", () => {
  const kinds = ["a", "b", "c", "d", "e"].map((key) => ({ key }));
  assert.deepEqual(fit(kinds.slice(0, 3)), { shown: kinds.slice(0, 3), more: 0 });
  assert.deepEqual(fit(kinds.slice(0, 4)), { shown: kinds.slice(0, 2), more: 2 });
  assert.deepEqual(fit(kinds), { shown: kinds.slice(0, 2), more: 3 });
  assert.deepEqual(fit([]), { shown: [], more: 0 });
});

test("the tooltip names each kind, how many and its status", () => {
  const kinds = spaceAgents([agent("s1", "t1", claude, "working"), agent("s1", "t2", claude), agent("s1", "t3", codex, "blocked")]).get("s1");
  assert.equal(describe(kinds), "Claude Code ×2 · working, Codex · blocked");
});

// main.js draws icons with a copy of the shipped agents mod's icon(); mods can't import each other.
test("the icon helper is the shipped agents mod's", (t) => {
  const shipped = join(process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"), "mods/agents/main.js");
  if (!existsSync(shipped)) return t.skip("Herdr's agents mod is not installed here");
  const fn = (text) => text.match(/function icon\(p, size, color\) \{[\s\S]*?\n\}/)?.[0];
  const mine = fn(readFileSync(new URL("../main.js", import.meta.url), "utf8"));
  assert.ok(mine);
  assert.equal(mine, fn(readFileSync(shipped, "utf8")));
});
