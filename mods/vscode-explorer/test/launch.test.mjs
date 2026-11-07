// node --test mods/vscode-explorer/test/launch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directRun, createOpenTab } from "../launch.js";
import { openArgs } from "../paths.js";
import { createOpenFile } from "../remote.js";

const editor = { name: "a.ts", folder: "/p", argv: ["exec", "node", "/h/vsedit.cjs", "/p/a.ts", "--close-on-exit"] };
const where = { space: "sp1", tab: "tb1" };

test("the editor starts in a labelled core terminal, straight from sh (no login shell, no `exec` word)", () => {
  const args = directRun(editor, where);
  assert.deepEqual(args.slice(0, 11), ["run", "--bg", "--json", "--no-parent", "--keep", "--cwd", "/p",
    "--label", "herdr.space=sp1", "--label", "herdr.tab=tb1"]);
  const program = args.slice(args.indexOf("--") + 1);
  assert.deepEqual([program[0], program[1]], ["/bin/sh", "-c"]);
  assert.deepEqual(program.slice(3), ["node", "/h/vsedit.cjs", "/p/a.ts", "--close-on-exit"]);
  assert.deepEqual(directRun({ folder: "/p", argv: ["node", "x"] }, where).slice(-2), ["node", "x"]);
});

test("the Explorer's editor argv starts the vsedit.sh launcher straight from sh, keeping --close-on-exit", () => {
  const args = directRun(openArgs("/p/a.ts", { appHome: "/h", folder: "/p" }), where);
  assert.deepEqual(args.slice(args.indexOf("--") + 4), ["sh", "/h/mods/vscode-viewer/editor/vsedit.sh", "/p/a.ts", "--close-on-exit"]);
});

// Runs the launch line as hc would, with a fake login shell that reports how it was called.
function launch(program, path) {
  const dir = mkdtempSync(join(tmpdir(), "launch-"));
  const shell = join(dir, "fake-shell");
  writeFileSync(shell, '#!/bin/sh\nprintf "shell:%s\\n" "$*"\n');
  chmodSync(shell, 0o755);
  const sh = directRun({ folder: dir, argv: ["exec", ...program] }, where).slice(-program.length - 3);
  return execFileSync(sh[0], sh.slice(1), { env: { HOME: dir, PATH: path, SHELL: shell }, encoding: "utf8" });
}

test("a program on PATH (or Homebrew, ~/.local) runs directly with its arguments", () => {
  assert.equal(launch(["printf", "%s|", "a b", "c"], "/usr/bin:/bin"), "a b|c|");
});

test("a program only the login shell knows (nvm) is started through it", () => {
  assert.equal(launch(["no-such-program-xyz", "a b"], "/usr/bin:/bin"),
    'shell:-lic exec "$0" "$@" no-such-program-xyz a b\n');
});

const ok = { code: 0, stdout: "{}" }, unknown = { code: 0, stdout: '{"error":"no such running terminal"}' };
const settle = () => new Promise(r => setTimeout(r, 20));

function harness({ space = { id: "sp1", machine: null }, execResults = [ok], hcResult = { code: 0, stdout: '{"address":"t9"}' }, appearsAfter = 1 } = {}) {
  const calls = [], hcCalls = [], execCalls = [];
  let polls = 0;
  const shown = () => polls >= appearsAfter;
  const spaces = () => [{ ...space, active: true, tabs: [{ id: "tbOld" }, ...(shown() ? [{ id: "tbX" }] : [])] }];
  const panes = () => [{ pane: "box/p1", tab: "tbOld", terminal: "box/t1" }, ...(shown() ? [{ pane: "box/p9", tab: "tbX", terminal: "box/t9" }] : [])];
  const openTab = createOpenTab({
    hc: async (a) => { hcCalls.push(a); if (a[0] === "run" && hcResult instanceof Error) throw hcResult; return hcResult; },
    exec: async (...a) => execResults[Math.min(execCalls.push(a), execResults.length) - 1],
    run: (name, args) => calls.push([name, args]), spaces, panes, newId: () => "tbX", wait: 100, step: 25,
  });
  const cx = { sleep: async () => { polls++; } };
  return { openTab: (args) => openTab(args, cx), calls, hcCalls, execCalls };
}

test("once Herdr shows the new tab, it is named after the file and selected", async () => {
  const h = harness();
  await h.openTab(editor);
  assert.equal(h.hcCalls[0][0], "run");
  assert.ok(h.hcCalls[0].includes("herdr.tab=tbX"));
  assert.deepEqual(h.calls, [["tab.rename", { id: "tbX", name: "a.ts" }], ["tab.select", { id: "tbX" }]]);
});

test("mod tabs and remote spaces open with tab.new as before", async () => {
  const viewer = { name: "a.md", mod: "vscode-viewer", props: { file: "/p/a.md" } };
  let h = harness();
  await h.openTab(viewer);
  assert.deepEqual(h.calls, [["tab.new", viewer]]);
  h = harness({ space: { id: "box/sp1", machine: "box" } });
  await h.openTab(editor);
  assert.deepEqual(h.hcCalls, []);
  assert.equal(h.calls[0][0], "tab.new");
});

test("a remote editor gets its right-clicks from here (through exec, never run) once its tab shows up, retried until Herdr knows it", async () => {
  let h = harness({ space: { id: "box/sp1", machine: "box" }, execResults: [unknown, unknown, ok] });
  await h.openTab(editor);
  await settle();
  assert.deepEqual(h.calls, [["tab.new", editor]]);
  assert.equal(h.execCalls.length, 3);
  assert.deepEqual(h.execCalls[0], ["herdr-app", ["do", "terminal.right_click", "--to", "program", "--terminal", "box/t9"]]);
  h = harness({ space: { id: "box/sp1", machine: "box" }, appearsAfter: Infinity });
  await h.openTab(editor);
  assert.deepEqual(h.calls, [["tab.new", editor]]);
  assert.deepEqual(h.execCalls, []);
});

test("a remote editor's right-click retry gives up quietly after 10 s (every 150 ms), without run", async () => {
  const h = harness({ space: { id: "box/sp1", machine: "box" }, execResults: [unknown] });
  await h.openTab(editor);
  await settle();
  assert.deepEqual(h.calls, [["tab.new", editor]]);
  assert.equal(h.execCalls.length, 67);
});

// Settings' files and Rust core are on this computer: with a remote space focused it uses a local space.
function localHarness({ hcResult = { code: 0, stdout: '{"address":"t9"}' }, appearsAfter = 1 } = {}) {
  const calls = [], hcCalls = [];
  let polls = 0;
  const spaces = () => [{ id: "box/sp1", machine: "box", active: true, tabs: [] },
    { id: "sp2", machine: null, active: false, tabs: polls >= appearsAfter ? [{ id: "tbX" }] : [] }];
  const openTab = createOpenTab({ hc: async (a) => { hcCalls.push(a); return hcResult; }, run: (n, a) => calls.push([n, a]),
    spaces, local: true, newId: () => "tbX", wait: 100, step: 25 });
  return { openTab: (args) => openTab(args, { sleep: async () => { polls++; } }), calls, hcCalls };
}

test("local: a remote space in focus still opens the tab on this computer (local space id, no --on)", async () => {
  const h = localHarness();
  await h.openTab(editor);
  assert.ok(h.hcCalls[0].includes("herdr.space=sp2") && h.hcCalls[0].includes("herdr.tab=tbX"));
  assert.ok(!h.hcCalls[0].includes("--on") && !h.hcCalls[0].some(a => String(a).includes("box")));
  assert.deepEqual(h.calls, [["space.select", { id: "sp2" }], ["tab.rename", { id: "tbX", name: "a.ts" }], ["tab.select", { id: "tbX" }]]);
});

test("local: when hc can't start it, tab.new names the local space, never the remote one", async () => {
  const h = localHarness({ hcResult: { code: 1, stdout: "" } });
  await h.openTab(editor);
  assert.deepEqual(h.calls, [["tab.new", { ...editor, space: "sp2" }]]);
});

test("local: a local space in focus opens as usual, without space.select", async () => {
  const h = harness();
  const openTab = createOpenTab({ hc: async () => ({ code: 0, stdout: '{"address":"t9"}' }), run: (n, a) => h.calls.push([n, a]),
    spaces: () => [{ id: "sp1", machine: null, active: true, tabs: [{ id: "tbX" }] }], local: true, newId: () => "tbX" });
  await openTab(editor, { sleep: async () => {} });
  assert.deepEqual(h.calls.map(c => c[0]), ["tab.rename", "tab.select"]);
});

test("when hc can't start it, tab.new opens it instead", async () => {
  for (const hcResult of [{ code: 1, stdout: "", stderr: "no core" }, { code: 0, stdout: "not json" }, new Error("spawn")]) {
    const h = harness({ hcResult });
    await h.openTab(editor);
    assert.deepEqual(h.calls, [["tab.new", editor]]);
  }
});

test("a tab Herdr never shows is ended and opened with tab.new instead", async () => {
  const h = harness({ appearsAfter: Infinity });
  await h.openTab(editor);
  assert.deepEqual(h.hcCalls[1], ["kill", "t9"]);
  assert.deepEqual(h.calls, [["tab.new", editor]]);
});

test("a warm tab handed the open is named and selected, with no hc run; none (or a failing hand-off) opens as before", async () => {
  let h = harness();
  const openTab = (warm, log) => createOpenTab({ hc: async (a) => { h.hcCalls.push(a); return { code: 0, stdout: '{"address":"t9"}' }; },
    run: (n, a) => h.calls.push([n, a]), spaces: () => [{ id: "sp1", machine: null, active: true, tabs: [{ id: "tbX" }, { id: "tbW" }] }],
    panes: () => [], newId: () => "tbX", warm, log });
  const asked = [];
  await openTab(async (space, args) => { asked.push([space.id, args.name]); return "tbW"; })(editor, { sleep: async () => {} });
  assert.deepEqual(asked, [["sp1", "a.ts"]]);
  assert.deepEqual(h.hcCalls, []);
  assert.deepEqual(h.calls, [["tab.rename", { id: "tbW", name: "a.ts" }], ["tab.select", { id: "tbW" }]]);
  for (const warm of [async () => null, async () => { throw new Error("gone"); }]) {
    h = harness();
    await openTab(warm)(editor, { sleep: async () => {} });
    assert.equal(h.hcCalls[0][0], "run");
    assert.deepEqual(h.calls.map(c => c[0]), ["tab.rename", "tab.select"]);
  }
});

test("the timing log gets each step of an open: warm (start, select) and cold (start, hc-run, shown, select)", async () => {
  const logs = [];
  const opener = (warm) => createOpenTab({ hc: async () => ({ code: 0, stdout: '{"address":"t9"}' }), run: () => {},
    spaces: () => [{ id: "sp1", machine: null, active: true, tabs: [{ id: "tbX" }] }], panes: () => [], newId: () => "tbX", warm, log: (f) => logs.push(f) });
  await opener(async () => "tbW")(editor, { sleep: async () => {} });
  await opener(null)(editor, { sleep: async () => {} });
  assert.deepEqual(logs.map(l => `${l.step}:${l.mode}`), ["start:cold", "select:warm", "start:cold", "hc-run:cold", "shown:cold", "select:cold"]);
  assert.ok(logs.every(l => l.name === "a.ts" && l.ms >= 0 && l.at >= l.ms));
});

test("Open to the Side: a warm editor kept right of the focused pane, its tab not renamed; else terminal.open / pane.split", async () => {
  const calls = [], asked = [];
  const opener = (warm) => createOpenTab({ hc: async () => { throw new Error("no hc run for a pane"); }, run: (n, a) => calls.push([n, a]),
    spaces: () => [{ id: "sp1", machine: null, active: true, tabs: [{ id: "tbW" }] }], panes: () => [], newId: () => "tbX", warm });
  await opener(async (space, args, cx, place) => { asked.push(place); return "tbW"; })(editor, { sleep: async () => {} }, "right");
  assert.deepEqual(asked, ["right"]);
  assert.deepEqual(calls.splice(0), [["tab.select", { id: "tbW" }]]);
  await opener(async () => null)(editor, { sleep: async () => {} }, "right");
  assert.deepEqual(calls.splice(0), [["terminal.open", { argv: editor.argv, folder: editor.folder, place: "right" }]]);
  const viewer = { name: "a.png", mod: "vscode-viewer", props: { file: "/p/a.png" } };
  await opener(null)(viewer, { sleep: async () => {} }, "right");
  assert.deepEqual(calls.splice(0), [["pane.split", { direction: "right", mod: "vscode-viewer", props: viewer.props }]]);
});

test("Open to the Side in a remote space: terminal.open there, its new pane gets the right-clicks", async () => {
  const calls = [], execCalls = [];
  let polls = 0;
  const panes = () => [{ pane: "box/p1", tab: "box/tb1", terminal: "box/t1" }, ...(polls ? [{ pane: "box/p9", tab: "box/tb1", terminal: "box/t9" }] : [])];
  const openTab = createOpenTab({ hc: async () => ok, exec: async (...a) => { execCalls.push(a); return ok; }, run: (n, a) => calls.push([n, a]),
    spaces: () => [{ id: "box/sp1", machine: "box", active: true, tabs: [{ id: "box/tb1" }] }], panes, wait: 100, step: 25 });
  await openTab(editor, { sleep: async () => { polls++; } }, "right");
  await settle();
  assert.deepEqual(calls, [["terminal.open", { argv: editor.argv, folder: editor.folder, place: "right" }]]);
  assert.deepEqual(execCalls[0], ["herdr-app", ["do", "terminal.right_click", "--to", "program", "--terminal", "box/t9"]]);
});

test("a viewer the Explorer opens is remembered by its new pane's id, so it can be moved to another tab", async () => {
  const calls = [], remembered = [];
  let shown = false;
  const openTab = createOpenTab({ hc: async () => ok, run: (n, a) => { calls.push([n, a]); }, remember: (pane, file) => remembered.push([pane, file]),
    spaces: () => [{ id: "sp1", machine: null, active: true, tabs: [] }], wait: 100, step: 25,
    panes: () => [{ pane: "p1", tab: "t", mod: "vscode-viewer" }, ...(shown ? [{ pane: "p2", tab: "t2", mod: "vscode-viewer" }] : [])] });
  const viewer = { name: "a.png", mod: "vscode-viewer", props: { file: "/p/a.png", on: null } };
  await openTab(viewer, { sleep: async () => { shown = true; } });
  assert.deepEqual(calls, [["tab.new", viewer]]);
  assert.deepEqual(remembered, [["p2", { file: "/p/a.png", on: null }]]);
});

test("the tree's click on an image (openFile, then openTab) remembers the viewer pane Herdr shows a few frames later", async () => {
  const remembered = [], rows = [{ pane: "p1", tab: "t1", terminal: "x1", mod: undefined }];
  let frames = 0;
  const run = (n, a) => { if (n === "tab.new") setTimeout(() => rows.push({ pane: "p9", tab: "t9", terminal: null, mod: a.mod }), 0); };
  const openTab = createOpenTab({ hc: async () => ok, run, panes: () => rows, remember: (pane, file) => remembered.push([pane, file]),
    spaces: () => [{ id: "sp1", machine: null, active: true, tabs: [] }], wait: 1000, step: 25 });
  const openFile = createOpenFile({ openTab, remote: {}, appHome: () => "/h" });
  await openFile("/p/logo.png", { on: null, folder: "/p", place: "tab" }, { sleep: (ms) => { frames++; return new Promise(r => setTimeout(r, 1)); } });
  assert.ok(frames >= 1, "it waited for Herdr");
  assert.deepEqual(remembered, [["p9", { file: "/p/logo.png", on: null }]]);
});

test("extra labels go on the terminal with Herdr's", () => {
  const args = directRun(editor, where, ["vscode.warm=1"]);
  assert.deepEqual(args.slice(7, 13), ["--label", "herdr.space=sp1", "--label", "herdr.tab=tb1", "--label", "vscode.warm=1"]);
  assert.equal(args[13], "--");
});

test("vscode-settings carries the same launch.js", () => {
  const read = (mod) => readFileSync(new URL(`../../${mod}/launch.js`, import.meta.url), "utf8");
  assert.equal(read("vscode-settings"), read("vscode-explorer"));
});
