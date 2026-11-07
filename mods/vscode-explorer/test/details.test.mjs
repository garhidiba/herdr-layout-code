// node --test mods/vscode-explorer/test/details.test.mjs — a remote editor told apart without its terminal's argv
// (details.js, paths.js isEditorTitle / withDetails, desktop.js editorMachines)
import test from "node:test";
import assert from "node:assert/strict";
import { createDetails, RETRY } from "../details.js";
import { isEditorTitle, withDetails, editorFileOf, editorTabOf, fileTabs } from "../paths.js";
import { editorMachines } from "../desktop.js";

// As measured on a7z (2026-11-07): `hc ls --json` lists a remote editor's terminal without argv or labels; its pane
// carries the editor's title; `hc get --json` has the launcher's argv, wrapped by Herdr's login shell.
const ROW = { address: "a7z/t12", agent: "sh", cwd: "/root", state: "live", turn: 0, where: "root / install_beszel.sh" };
const PANE = { pane: "a7z/pn1", terminal: "a7z/t12", tab: "a7z/tb1", title: "install_beszel.sh — vsedit", cwd: "/root" };
const LAUNCHER = "/root/.local/share/herdr-vscode/1.0.0-092711619330/vsedit.sh";
const GET = { address: "a7z/t12", argv: ["sh", "-c", "shell=${SHELL:-/bin/sh}\n…", "sh", "exec", "sh", LAUNCHER, "/root/install_beszel.sh", "--close-on-exit", "--os", "mac"],
  labels: { "herdr.space": "spebc", "herdr.tab": "tb3d" } };
const SHELL = { address: "a7z/t2", agent: "bash", cwd: "/root", state: "live", turn: 0 };

test("an editor's title, plain, unsaved or closing; any other program's is not one", () => {
  for (const t of ["install_beszel.sh — vsedit", "● a.ts — vsedit", "a.ts — vsedit (closing)"]) assert.ok(isEditorTitle(t), t);
  for (const t of ["root@a7z: ~", "vsedit", " — vsedit", "", null, undefined]) assert.equal(isEditorTitle(t), false, String(t));
});

test("a machine whose editor's row has no argv still counts, from its pane's title", () => {
  assert.equal(editorFileOf(ROW.argv, ROW.labels), null, "the row alone says nothing");
  assert.deepEqual([...editorMachines([ROW, SHELL], [PANE, { ...PANE, terminal: "a7z/t2", title: "root@a7z: ~" }])], ["a7z"]);
  assert.deepEqual([...editorMachines([ROW], [{ ...PANE, terminal: "t3", title: "a.ts — vsedit" }])], [], "a local editor is no machine's");
});

// A fake hc get answering `answers[address]` (an object, or a failure); every call is logged.
function fakeHc(answers) {
  const calls = [];
  const hc = async (args) => {
    calls.push(args);
    const a = answers[args[1]];
    return a ? { code: 0, stdout: JSON.stringify(a), stderr: "" } : { code: 1, stdout: "", stderr: "no such terminal" };
  };
  return { hc, calls };
}
const settle = () => new Promise(r => setImmediate(r));

test("a remote editor without argv is asked of hc once, and its argv and labels published", async () => {
  const { hc, calls } = fakeHc({ "a7z/t12": GET });
  const out = [];
  const update = createDetails({ hc, publish: d => out.push(d) });
  update([ROW, SHELL], [PANE]);
  update([ROW, SHELL], [PANE]); // a draw while it is asked
  await settle();
  update([ROW, SHELL], [PANE]);
  assert.deepEqual(calls, [["get", "a7z/t12", "--json"]]);
  assert.deepEqual(out, [{ "a7z/t12": { argv: GET.argv, labels: GET.labels } }]);
});

test("a row that has argv, a local pane or a shell's pane asks nothing", async () => {
  const { hc, calls } = fakeHc({});
  createDetails({ hc, publish: () => {} })([{ ...ROW, argv: GET.argv }], [PANE, { ...PANE, terminal: "t3" }, { ...PANE, terminal: "a7z/t2", title: "root@a7z: ~" }]);
  await settle();
  assert.deepEqual(calls, []);
});

test("its details go when its pane does; a failed ask waits RETRY before the next", async () => {
  let now = 0;
  const { hc, calls } = fakeHc({ "a7z/t12": GET });
  const out = [];
  const update = createDetails({ hc, publish: d => out.push(d), now: () => now });
  update([ROW], [PANE]); await settle();
  update([ROW], []);
  assert.deepEqual(out.at(-1), {}, "the tab closed");
  const lost = { ...PANE, terminal: "a7z/t99" };
  update([], [lost]); await settle();
  update([], [lost]); await settle();
  now = RETRY;
  update([], [lost]); await settle();
  assert.deepEqual(calls.filter(c => c[1] === "a7z/t99").length, 2);
});

test("with its details, a remote editor names its file to every editorFileOf caller", () => {
  const rows = withDetails([ROW, SHELL], { "a7z/t12": { argv: GET.argv, labels: GET.labels } });
  const space = { id: "a7z/sp1", machine: "a7z", tabs: [{ id: "a7z/tb1" }] };
  assert.equal(editorFileOf(rows[0].argv, rows[0].labels), "/root/install_beszel.sh");
  assert.equal(editorTabOf("/root/install_beszel.sh", "a7z", space, [PANE], rows), "a7z/tb1", "go to its tab, not a second one");
  assert.deepEqual([...fileTabs(space, [PANE], rows)], ["a7z/tb1"]);
  assert.equal(rows[1], SHELL, "a row without details is left as is");
  const own = { ...ROW, argv: ["sh", LAUNCHER, "/own"] };
  assert.equal(withDetails([own], { "a7z/t12": { argv: GET.argv } })[0], own, "a row's own argv wins");
});
