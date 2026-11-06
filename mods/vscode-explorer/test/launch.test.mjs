// node --test mods/vscode-explorer/test/launch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directRun, createOpenTab } from "../launch.js";
import { openArgs } from "../paths.js";

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

function harness({ space = { id: "sp1", machine: null }, hcResult = { code: 0, stdout: '{"address":"t9"}' }, appearsAfter = 1 } = {}) {
  const calls = [], hcCalls = [];
  let polls = 0;
  const shown = () => polls >= appearsAfter;
  const spaces = () => [{ ...space, active: true, tabs: [{ id: "tbOld" }, ...(shown() ? [{ id: "tbX" }] : [])] }];
  const panes = () => [{ tab: "tbOld", terminal: "box/t1" }, ...(shown() ? [{ tab: "tbX", terminal: "box/t9" }] : [])];
  const openTab = createOpenTab({
    hc: async (a) => { hcCalls.push(a); if (a[0] === "run" && hcResult instanceof Error) throw hcResult; return hcResult; },
    run: (name, args) => calls.push([name, args]), spaces, panes, newId: () => "tbX", wait: 100, step: 25,
  });
  const cx = { sleep: async () => { polls++; } };
  return { openTab: (args) => openTab(args, cx), calls, hcCalls };
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

test("a remote editor (no herdr-app on its machine) gets its right-clicks from here once its tab shows up", async () => {
  let h = harness({ space: { id: "box/sp1", machine: "box" } });
  await h.openTab(editor);
  assert.deepEqual(h.calls, [["tab.new", editor], ["terminal.right_click", { to: "program", terminal: "box/t9" }]]);
  h = harness({ space: { id: "box/sp1", machine: "box" }, appearsAfter: Infinity });
  await h.openTab(editor);
  assert.deepEqual(h.calls, [["tab.new", editor]]);
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

test("vscode-settings carries the same launch.js", () => {
  const read = (mod) => readFileSync(new URL(`../../${mod}/launch.js`, import.meta.url), "utf8");
  assert.equal(read("vscode-settings"), read("vscode-explorer"));
});
