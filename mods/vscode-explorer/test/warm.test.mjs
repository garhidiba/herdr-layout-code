// node --test mods/vscode-explorer/test/warm.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWarmPool, WARM, WARM_LABEL, TIMING, RETRY_MS } from "../warm.js";
import { createOpenTab } from "../launch.js";
import { openArgs, FILE_LABEL } from "../paths.js";

const APP = "/h";
const editor = (file = "/p/a.ts") => openArgs(file, { appHome: APP, folder: "/p" });

// A fake Herdr: spaces with tabs, a shared store, hc that starts a labelled terminal which shows up as its tab after
// `appearsAfter` polls, and exec for the handoff (`handoff`: its exit code) and rm. `real: true` runs exec for real.
function world({ spaces = [{ id: "sp1", tabs: ["tbShell"] }], settings = "{}", appearsAfter = 1, hcCode = 0, handoff = 0, real = false, appHome = APP } = {}) {
  const store = {}, calls = [], hcCalls = [], execCalls = [], file = { settings };
  const live = spaces.map(s => ({ id: s.id, machine: s.machine ?? null, folder: s.folder ?? "/p", tabs: s.tabs.map((id, i) => ({ id, active: i === 0, settled: false })) }));
  const terms = [], pending = [];
  let ids = 0, polls = 0, now = 1000;
  const spacesFn = () => live.map(s => ({ ...s, active: s.id === "sp1", tabs: s.tabs.map(t => ({ ...t })) }));
  const pool = createWarmPool({
    hc: async (a) => {
      hcCalls.push(a);
      if (a[0] === "run") {
        if (hcCode) return { code: hcCode, stdout: "", stderr: "no core" };
        const labels = Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === "--label" ? [x.split("=")] : [])));
        const address = `t${++ids}`;
        terms.push({ address, argv: a.slice(a.indexOf("--") + 1), labels });
        pending.push({ at: polls + appearsAfter, space: labels["herdr.space"], tab: labels["herdr.tab"] });
        return { code: 0, stdout: JSON.stringify({ address }) };
      }
      if (a[0] === "kill") { const t = terms.find(x => x.address === a[1]); if (t) t.dead = true; for (const s of live) s.tabs = s.tabs.filter(x => x.id !== t?.labels["herdr.tab"]); }
      return { code: 0, stdout: "{}" };
    },
    run: (name, args) => {
      calls.push([name, args]);
      const tab = live.flatMap(s => s.tabs).find(t => t.id === args?.id);
      if (name === "tab.settle" && tab) tab.settled = true;
      if (name === "tab.unsettle" && tab) tab.settled = false;
    },
    exec: async (cmd, args) => {
      execCalls.push([cmd, args]);
      if (real) return new Promise(resolve => execFile(cmd, args, (e, stdout, stderr) => resolve({ code: e ? e.code ?? 1 : 0, stdout, stderr })));
      return { code: cmd === "sh" ? handoff : 0, stdout: "", stderr: "" };
    },
    spaces: spacesFn, terminals: () => terms.filter(t => !t.dead), machines: () => [{ name: null, layout: "ready" }],
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; }, appHome: () => appHome, home: () => "/home",
    readTextFile: async () => file.settings, newId: () => `tbW${ids + 1}`, now: () => now, wait: 100, step: 25,
  });
  const cx = { sleep: async () => {
    polls++;
    for (const p of pending.filter(p => p.at <= polls)) { live.find(s => s.id === p.space)?.tabs.push({ id: p.tab, active: false, settled: false }); pending.splice(pending.indexOf(p), 1); }
  } };
  return { pool, cx, store, calls, hcCalls, execCalls, terms, live, file, spaces: spacesFn, advance: (ms) => { now += ms; },
    // Herdr adopting an orphan from before a restart: a labelled terminal already in a tab.
    orphan: (space, tab) => { terms.push({ address: `t${++ids}`, argv: [], labels: { [WARM_LABEL]: "1", "herdr.space": space, "herdr.tab": tab } }); live.find(s => s.id === space).tabs.push({ id: tab, active: false }); } };
}

test("each local space gets one hidden warm editor tab: listed first, started with --warm and its label, then settled", async () => {
  const w = world({ spaces: [{ id: "sp1", tabs: ["tbShell"] }, { id: "box/sp2", machine: "box", tabs: ["tbR"] }] });
  await w.pool.fill(w.cx);
  const entry = w.store[WARM].sp1;
  assert.deepEqual(Object.keys(w.store[WARM]), ["sp1"], "remote spaces get none");
  assert.deepEqual(entry, { tab: "tbW1", key: "/h/.vscode-warm/tbW1", address: "t1" });
  const run = w.hcCalls.find(a => a[0] === "run");
  assert.ok(run.includes(`${WARM_LABEL}=1`) && run.includes("herdr.tab=tbW1") && run.includes("herdr.space=sp1"));
  assert.deepEqual(run.slice(-4), ["/h/mods/vscode-viewer/editor/vsedit.sh", "--warm", "/h/.vscode-warm/tbW1", "--close-on-exit"]);
  assert.deepEqual(w.calls, [["tab.settle", { id: "tbW1" }]]);
  await w.pool.fill(w.cx);
  assert.equal(w.hcCalls.filter(a => a[0] === "run").length, 1, "one per space, never a second");
  assert.equal(w.pool.due(), null);
});

test("a warm tab that Herdr made the active one gives the focus back", async () => {
  const w = world();
  const pool = w.pool;
  // Herdr selecting the new tab: the fake shows it as active
  w.cx.sleep = (sleep => async () => { await sleep(); for (const s of w.live) for (const t of s.tabs) t.active = t.id === "tbW1"; })(w.cx.sleep);
  await pool.fill(w.cx);
  assert.deepEqual(w.calls, [["tab.settle", { id: "tbW1" }], ["tab.select", { id: "tbShell" }]]);
});

test("opening a file hands it to the warm tab: no new terminal, the tab unsettled, moved last, named and selected", async () => {
  const w = world({ spaces: [{ id: "sp1", tabs: ["tbShell", "tbOther"] }] });
  await w.pool.fill(w.cx);
  w.calls.length = 0;
  const logs = [];
  const openTab = createOpenTab({ hc: async () => assert.fail("no hc run on a warm open"), run: (n, a) => w.calls.push([n, a]), spaces: w.spaces,
    panes: () => [], warm: w.pool.claim, log: (f) => logs.push(f) });
  await openTab(editor(), w.cx);
  const [cmd, args] = w.execCalls.find(c => c[0] === "sh");
  assert.equal(cmd, "sh");
  assert.deepEqual(args.slice(2), ["warm", "/h/.vscode-warm/tbW1", "/p/a.ts", "/p"]);
  assert.deepEqual(w.calls, [["tab.unsettle", { id: "tbW1" }], ["tab.move", { id: "tbW1", index: 3 }],
    ["tab.rename", { id: "tbW1", name: "a.ts" }], ["tab.select", { id: "tbW1" }]]);
  assert.deepEqual(w.hcCalls.at(-1), ["label", "t1", `${WARM_LABEL}=`, `${FILE_LABEL}=/p/a.ts`], "it now says which file it shows");
  assert.equal(w.store[WARM].sp1, undefined, "taken: the next one starts behind it");
  assert.equal(w.pool.due(), 500);
  assert.deepEqual(logs.map(l => [l.step, l.mode]), [["start", "cold"], ["select", "warm"]]);
  assert.ok(logs.every(l => l.name === "a.ts" && Number.isFinite(l.at) && l.ms >= 0));
  await w.pool.fill(w.cx);
  assert.equal(w.store[WARM].sp1.tab, "tbW2", "a new warm tab replaces the used one");
});

test("no warm tab, one still starting, or a file it can't take: the open starts its own editor as before", async () => {
  const cold = async (w) => {
    const hc = [];
    const openTab = createOpenTab({ hc: async (a) => { hc.push(a); return { code: 1, stdout: "" }; }, run: (n, a) => w.calls.push([n, a]),
      spaces: w.spaces, panes: () => [], warm: w.pool.claim });
    await openTab(editor(), w.cx);
    return hc;
  };
  let w = world();
  assert.equal((await cold(w))[0][0], "run", "none yet");
  w = world();
  w.store[WARM] = { sp1: { tab: "tbW1", key: "/h/.vscode-warm/tbW1", address: null } };
  assert.equal((await cold(w))[0][0], "run", "still starting (no address)");
  w = world({ handoff: 1 });
  await w.pool.fill(w.cx);
  assert.equal((await cold(w))[0][0], "run", "the editor isn't ready or is gone");
  assert.ok(w.hcCalls.some(a => a[0] === "kill" && a[1] === "t1"), "a warm tab that can't take a file is ended");
  assert.ok(w.execCalls.some(([c, a]) => c === "rm" && a.includes("/h/.vscode-warm/tbW1.pid")));
  assert.equal(w.store[WARM].sp1, undefined);
});

test("only the Explorer's local editor is handed over: other programs, the viewer and remote spaces aren't", async () => {
  const w = world();
  await w.pool.fill(w.cx);
  const space = w.spaces()[0];
  assert.equal(await w.pool.claim(space, { name: "x", folder: "/p", argv: ["sh", "/h/mods/vscode-settings/build-core.sh", "/h"] }), null);
  assert.equal(await w.pool.claim(space, { name: "a.png", mod: "vscode-viewer", props: {} }), null);
  assert.equal(await w.pool.claim(space, openArgs("/p/a.ts", { appHome: "/other", folder: "/p" })), null);
  assert.equal(await w.pool.claim({ ...space, machine: "box" }, editor()), null);
  assert.equal(w.execCalls.filter(c => c[0] === "sh").length, 0);
  assert.equal(await w.pool.claim(space, editor()), "tbW1");
});

test("workbench.editor.preloadEditor false: none start, a running one ends on the next pass, opens go as before", async () => {
  const off = world({ settings: '// mine\n{ "workbench.editor.preloadEditor": false, }' });
  await off.pool.fill(off.cx);
  assert.deepEqual(off.hcCalls, []);
  assert.deepEqual(off.store[WARM] ?? {}, {});
  assert.equal(off.pool.due(), null, "nothing to do while off");
  const w = world();
  await w.pool.fill(w.cx);
  w.file.settings = '{ "workbench.editor.preloadEditor": false }';
  await w.pool.fill(w.cx);
  assert.deepEqual(w.hcCalls.at(-1), ["kill", "t1"]);
  assert.deepEqual(w.store[WARM], {});
  assert.equal(await w.pool.claim(w.spaces()[0], editor()), null);
});

test("a space left with only its warm tab: it ends at once (so the space closes); a closed space's entry goes", async () => {
  const w = world({ spaces: [{ id: "sp1", tabs: ["tbShell"] }, { id: "sp2", tabs: ["tbB"] }] });
  await w.pool.fill(w.cx);
  assert.deepEqual(Object.keys(w.store[WARM]).sort(), ["sp1", "sp2"]);
  w.live[0].tabs = w.live[0].tabs.filter(t => t.id !== "tbShell"); // its last tab closed
  w.live.splice(1, 1); // sp2 closed with its tabs
  assert.equal(w.pool.due(), 0, "at once");
  await w.pool.fill(w.cx);
  assert.ok(w.hcCalls.some(a => a[0] === "kill" && a[1] === "t1"));
  assert.deepEqual(w.store[WARM], {});
  assert.equal(w.hcCalls.filter(a => a[0] === "run").length, 2, "no new one for a space with no tab of its own");
});

test("a warm editor that ends by itself, or doesn't start, is tried again only after a while", async () => {
  const w = world();
  await w.pool.fill(w.cx);
  w.live[0].tabs = w.live[0].tabs.filter(t => t.id !== "tbW1"); // it exited
  assert.equal(w.pool.due(), 500);
  await w.pool.fill(w.cx);
  assert.equal(w.hcCalls.filter(a => a[0] === "run").length, 1, "not again at once");
  assert.equal(w.pool.due(), null);
  w.advance(RETRY_MS);
  await w.pool.fill(w.cx);
  assert.equal(w.store[WARM].sp1.tab, "tbW2");
  const never = world({ appearsAfter: Infinity });
  await never.pool.fill(never.cx);
  assert.deepEqual(never.hcCalls.at(-1), ["kill", "t1"], "a tab Herdr never shows is ended");
  assert.deepEqual(never.store[WARM], {});
  assert.equal(never.pool.due(), null);
  const broken = world({ hcCode: 1 });
  await broken.pool.fill(broken.cx);
  assert.deepEqual(broken.store[WARM], {});
  assert.equal(broken.pool.due(), null);
});

test("warm editors left from before a restart (labelled, not listed) are ended once this computer's layout is read", async () => {
  const w = world();
  w.orphan("sp1", "tbOld1");
  w.orphan("sp1", "tbOld2");
  await w.pool.fill(w.cx);
  assert.deepEqual(w.hcCalls.filter(a => a[0] === "kill").map(a => a[1]).sort(), ["t1", "t2"]);
  assert.ok(w.execCalls.some(([c, a]) => c === "rm" && a.includes("/h/.vscode-warm/tbOld1.pid")));
  assert.equal(w.store[WARM].sp1.tab, "tbW3", "the space gets a new one of its own");
  const kills = w.hcCalls.filter(a => a[0] === "kill").length;
  await w.pool.fill(w.cx);
  assert.equal(w.hcCalls.filter(a => a[0] === "kill").length, kills, "swept once: a handed-over editor keeps its label a moment");
});

test("the timing log follows workbench.editor.openTimingLog", async () => {
  const w = world({ settings: '{ "workbench.editor.openTimingLog": true }' });
  await w.pool.fill(w.cx);
  assert.equal(w.store[TIMING], true);
  w.file.settings = "{}";
  await w.pool.fill(w.cx);
  assert.equal(w.store[TIMING], false);
});

// The handoff script against the real JS editor waiting with --warm: the file reaches it, the files are cleaned up.
test("the handoff reaches a real warm editor (vsedit.cjs --warm), which then opens the file", async () => {
  const home = mkdtempSync(join(tmpdir(), "warm-home-"));
  const key = join(home, ".vscode-warm", "tbW1");
  const child = spawn(process.execPath, [new URL("../../vscode-viewer/editor/vsedit.cjs", import.meta.url).pathname, "--warm", key, "--close-on-exit"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  for (let i = 0; i < 100 && !existsSync(`${key}.pid`); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readFileSync(`${key}.pid`, "utf8"), String(child.pid));
  const w = world({ real: true, appHome: home });
  w.store[WARM] = { sp1: { tab: "tbW1", key, address: "t9" } };
  w.live[0].tabs.push({ id: "tbW1", active: false });
  const args = openArgs(join(home, "a.ts"), { appHome: home, folder: home });
  assert.equal(await w.pool.claim(w.spaces()[0], args), "tbW1");
  assert.equal(await exited, 1); // the editor without a terminal stops at its first check, past the wait
  assert.match(err, /needs a terminal/);
  assert.equal(existsSync(key) || existsSync(`${key}.pid`), false);
});
