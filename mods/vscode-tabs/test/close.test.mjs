// node --test mods/vscode-tabs/test/close.test.mjs
// Closing tabs (close.js): an unsaved editor is asked and answers in its own dialog; every other tab gets tab.close.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTabCloser, signalCommand, ANSWER_MS } from "../close.js";

// A tab bar: a shell, an unsaved editor, a viewer, a saved editor, an agent, a remote unsaved editor.
const bar = () => [
  { pane: "p1", tab: "a", terminal: "t1", title: "zsh" },
  { pane: "p2", tab: "b", terminal: "t2", title: "● a.ts — vsedit" },
  { pane: "p3", tab: "c", terminal: null, mod: "vscode-viewer", title: "vscode-viewer" },
  { pane: "p4", tab: "d", terminal: "t4", title: "b.ts — vsedit" },
  { pane: "p5", tab: "e", terminal: "t5", title: "✳ Claude Code" },
  { pane: "box/p6", tab: "box/f", terminal: "box/t6", title: "● x.go — vsedit" },
];

// The closer with a fake Herdr: `editors` answers each request (terminal -> what its editor does on each tick, as a
// list of titles, null for "it ended"); `sent` false means the request could not be sent.
function harness({ editors = {}, sent = true } = {}) {
  const panes = bar(), calls = [];
  let clock = 0;
  const ticks = {};
  const closer = createTabCloser({
    run: (name, args) => calls.push([name, args]),
    panes: () => panes,
    requestClose: async (terminal) => { calls.push(["request", terminal]); ticks[terminal] = [...(editors[terminal] ?? [])]; return sent; },
    now: () => clock,
  });
  const sleep = async (ms) => {
    clock += ms;
    for (const [terminal, next] of Object.entries(ticks)) {
      if (!next.length) continue;
      const title = next.shift(), i = panes.findIndex(p => p.terminal === terminal);
      if (title === null) panes.splice(i, 1); else panes[i].title = title;
    }
  };
  return { close: (list) => closer(list, sleep), calls, panes, time: () => clock };
}

test("shells, agents, viewers and saved editors close at once with tab.close, confirmed kept", async () => {
  const h = harness();
  await h.close([{ id: "a" }, { id: "c" }, { id: "d" }, { id: "e", confirmed: true }]);
  assert.deepEqual(h.calls, [["tab.close", { id: "a" }], ["tab.close", { id: "c" }], ["tab.close", { id: "d" }], ["tab.close", { id: "e", confirmed: true }]]);
});

test("an unsaved editor is shown and asked to close; saving or discarding ends it and Herdr closes the tab", async () => {
  const h = harness({ editors: { t2: ["● a.ts — vsedit (closing)", "● a.ts — vsedit (closing)", "a.ts — vsedit", null] } });
  await h.close([{ id: "b" }]);
  assert.deepEqual(h.calls, [["tab.select", { id: "b" }], ["request", "t2"]]);
});

test("a remote editor is asked on its machine's terminal", async () => {
  const h = harness({ editors: { "box/t6": [null] } });
  await h.close([{ id: "box/f" }]);
  assert.deepEqual(h.calls, [["tab.select", { id: "box/f" }], ["request", "box/t6"]]);
});

test("Cancel keeps the tab, and the next tab of a Close All is closed after it", async () => {
  const h = harness({ editors: { t2: ["● a.ts — vsedit (closing)", "● a.ts — vsedit"] } });
  await h.close([{ id: "b" }, { id: "c" }]);
  assert.deepEqual(h.calls, [["tab.select", { id: "b" }], ["request", "t2"], ["tab.close", { id: "c" }]]);
  assert.ok(h.panes.some(p => p.tab === "b"));
});

test("several unsaved editors are asked one at a time, each after the one before answered", async () => {
  const h = harness({ editors: { t2: ["● a.ts — vsedit (closing)", null], "box/t6": ["● x.go — vsedit (closing)", null] } });
  await h.close([{ id: "b" }, { id: "box/f" }]);
  assert.deepEqual(h.calls, [["tab.select", { id: "b" }], ["request", "t2"], ["tab.select", { id: "box/f" }], ["request", "box/t6"]]);
});

test("a person may take their time in the dialog: no timeout once it asks", async () => {
  const h = harness({ editors: { t2: Array(200).fill("● a.ts — vsedit (closing)").concat([null]) } });
  await h.close([{ id: "b" }]);
  assert.ok(h.time() > ANSWER_MS);
  assert.ok(!h.calls.some(([name]) => name === "tab.close"));
});

test("an editor that neither asks nor ends within 5 s gets tab.close (its hot-exit backup keeps the text)", async () => {
  const h = harness({ editors: { t2: [] } });
  await h.close([{ id: "b", confirmed: true }]);
  assert.deepEqual(h.calls, [["tab.select", { id: "b" }], ["request", "t2"], ["tab.close", { id: "b", confirmed: true }]]);
  assert.equal(h.time(), ANSWER_MS);
});

test("a request that can't be sent closes the tab as before", async () => {
  const h = harness({ sent: false });
  await h.close([{ id: "b" }]);
  assert.deepEqual(h.calls, [["tab.select", { id: "b" }], ["request", "t2"], ["tab.close", { id: "b" }]]);
});

test("an editor already asking is not asked again, and a tab that is gone closes nothing", async () => {
  const h = harness();
  h.panes[1].title = "● a.ts — vsedit (closing)";
  await h.close([{ id: "b" }, { id: "gone" }]);
  assert.deepEqual(h.calls, [["tab.select", { id: "b" }]]);
});

test("a second × while the first request waits sends nothing more", async () => {
  const h = harness({ editors: { t2: ["● a.ts — vsedit (closing)", "● a.ts — vsedit (closing)", null] } });
  await Promise.all([h.close([{ id: "b" }]), h.close([{ id: "b" }])]);
  assert.deepEqual(h.calls, [["tab.select", { id: "b" }], ["request", "t2"]]);
});

// The real script against a process tree like a remote tab's: a shell, the launcher (vsedit.sh), the editor below it.
test("the request reaches the editor below its launcher, never the launcher", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-tabs-close-")), got = path.join(dir, "got"), ready = path.join(dir, "ready");
  const until = async (file) => { for (let i = 0; i < 200 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 25)); };
  fs.writeFileSync(path.join(dir, "vsedit.sh"), `"$(dirname "$0")/vsedit"\necho launcher-left > "${got}.launcher"\n`);
  // the fake editor says it is ready once its SIGUSR2 handler is set
  fs.writeFileSync(path.join(dir, "vsedit"), `#!/bin/sh\ntrap 'echo usr2 > "${got}"; exit 0' USR2\n: > "${ready}"\nwhile :; do sleep 0.05; done\n`, { mode: 0o755 });
  const tree = spawn("sh", ["-c", `sh "${dir}/vsedit.sh"; echo shell-left > "${got}.shell"`], { stdio: "ignore" });
  let alone = null;
  try {
    await until(ready);
    execFileSync(...signalCommand(tree.pid));
    await until(got + ".shell");
    assert.equal(fs.readFileSync(got, "utf8"), "usr2\n", "the editor got it");
    assert.ok(fs.existsSync(got + ".launcher") && fs.existsSync(got + ".shell"), "the launcher and the shell went on to their end");
    assert.throws(() => execFileSync(...signalCommand(tree.pid), { stdio: "ignore" }), "no editor left: exit 1");
    // This computer's tab: the launcher execs the editor, so the terminal's process is the editor itself.
    fs.rmSync(got); fs.rmSync(ready);
    alone = spawn(path.join(dir, "vsedit"), [], { stdio: "ignore" });
    await until(ready);
    execFileSync(...signalCommand(alone.pid));
    await until(got);
    assert.equal(fs.readFileSync(got, "utf8"), "usr2\n");
  } finally {
    tree.kill("SIGKILL"); alone?.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
