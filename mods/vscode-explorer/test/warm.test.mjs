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

// A fake Herdr: spaces with tabs, a shared store, hc that starts a core terminal Herdr knows (terminals()) after
// `knownAfter` polls, terminal.keep that gives it a tab and pane after `keptAfter` polls (Infinity: never), and exec
// for the handoff (`handoff`: its exit code) and rm. `real: true` runs exec for real.
function world({ spaces = [{ id: "sp1", tabs: ["tbShell"] }], settings = "{}", knownAfter = 1, keptAfter = 1, hcCode = 0, handoff = 0, real = false, appHome = APP } = {}) {
  const store = {}, calls = [], hcCalls = [], execCalls = [], file = { settings };
  const live = spaces.map(s => ({ id: s.id, machine: s.machine ?? null, folder: s.folder ?? "/p", tabs: s.tabs.map((id, i) => ({ id, active: i === 0 })) }));
  const terms = [], panes = [], later = [];
  let ids = 0, polls = 0, now = 1000;
  const spacesFn = () => live.map(s => ({ ...s, active: s.id === "sp1", tabs: s.tabs.map(t => ({ ...t })) }));
  const show = (address) => { const tab = `tbK${address}`; live[0].tabs.push({ id: tab, active: false }); panes.push({ pane: `p${address}`, tab, terminal: address }); };
  const pool = createWarmPool({
    hc: async (a) => {
      hcCalls.push(a);
      if (a[0] === "run") {
        if (hcCode) return { code: hcCode, stdout: "", stderr: "no core" };
        const labels = Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === "--label" ? [x.split("=")] : [])));
        const t = { address: `t${++ids}`, argv: a.slice(a.indexOf("--") + 1), labels, known: false };
        terms.push(t);
        later.push({ at: polls + knownAfter, run: () => { t.known = true; } });
        return { code: 0, stdout: JSON.stringify({ address: t.address }) };
      }
      if (a[0] === "ls") return { code: 0, stdout: JSON.stringify({ terminals: terms.filter(t => !t.dead && t.labels[WARM_LABEL]).map(t => ({ address: t.address })) }) };
      if (a[0] === "kill") {
        const t = terms.find(x => x.address === a[1]);
        if (t) t.dead = true;
        for (const p of panes.filter(p => p.terminal === a[1])) { panes.splice(panes.indexOf(p), 1); live[0].tabs = live[0].tabs.filter(x => x.id !== p.tab); }
      }
      return { code: 0, stdout: "{}" };
    },
    run: (name, args) => {
      calls.push([name, args]);
      if (name === "terminal.keep") later.push({ at: polls + keptAfter, run: () => show(args.terminal) });
    },
    exec: async (cmd, args) => {
      execCalls.push([cmd, args]);
      if (real) return new Promise(resolve => execFile(cmd, args, (e, stdout, stderr) => resolve({ code: e ? e.code ?? 1 : 0, stdout, stderr })));
      return { code: cmd === "sh" ? handoff : 0, stdout: "", stderr: "" };
    },
    spaces: spacesFn, panes: () => panes.map(p => ({ ...p })), terminals: () => terms.filter(t => !t.dead && t.known),
    machines: () => [{ name: null, layout: "ready" }],
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; }, appHome: () => appHome, home: () => "/home",
    readTextFile: async () => file.settings, newId: () => `id${ids + 1}`, now: () => now, wait: 100, step: 25,
  });
  const cx = { sleep: async () => {
    polls++;
    for (const l of later.filter(l => l.at <= polls)) { later.splice(later.indexOf(l), 1); l.run(); }
  } };
  return { pool, cx, store, calls, hcCalls, execCalls, terms, live, file, panes, show, spaces: spacesFn, advance: (ms) => { now += ms; },
    // a warm terminal from before a restart
    orphan: () => { terms.push({ address: `t${++ids}`, argv: [], labels: { [WARM_LABEL]: "1", "vscode.key": `/h/.vscode-warm/old${ids}` }, known: true }); } };
}

test("each local space gets one warm editor off screen: no Herdr space/tab labels, no tab, --warm and its own label", async () => {
  const w = world({ spaces: [{ id: "sp1", tabs: ["tbShell"] }, { id: "box/sp2", machine: "box", tabs: ["tbR"] }] });
  await w.pool.fill(w.cx);
  assert.deepEqual(w.store[WARM], { sp1: { key: "/h/.vscode-warm/id1", address: "t1" } }, "remote spaces get none");
  const run = w.hcCalls.find(a => a[0] === "run");
  assert.ok(!run.some(a => /^herdr\.(space|tab)=/.test(a)), "Herdr never shows it");
  assert.ok(run.includes(`${WARM_LABEL}=1`) && run.includes("vscode.key=/h/.vscode-warm/id1"));
  assert.deepEqual(run.slice(-4), ["/h/mods/vscode-viewer/editor/vsedit.sh", "--warm", "/h/.vscode-warm/id1", "--close-on-exit"]);
  assert.deepEqual(w.calls, [], "no tab command: nothing on screen");
  assert.equal(w.live[0].tabs.length, 1);
  await w.pool.fill(w.cx);
  assert.equal(w.hcCalls.filter(a => a[0] === "run").length, 1, "one per space, never a second");
  assert.equal(w.pool.due(), null);
});

test("a warm editor is claimable only once Herdr knows its terminal (terminal.keep fails before)", async () => {
  const w = world({ knownAfter: 3 });
  const seen = [];
  const sleep = w.cx.sleep;
  await w.pool.fill({ sleep: async () => {
    if (!seen.length) seen.push(w.store[WARM].sp1, await w.pool.claim(w.spaces()[0], editor(), w.cx));
    await sleep();
  } });
  assert.deepEqual(seen, [{ key: "/h/.vscode-warm/id1", address: null }, null], "listed while it starts, not claimable");
  assert.deepEqual(w.calls, []);
  assert.equal(w.store[WARM].sp1.address, "t1");
  const slow = world({ knownAfter: Infinity });
  await slow.pool.fill(slow.cx);
  assert.deepEqual(slow.store[WARM], {});
  assert.ok(slow.hcCalls.some(a => a[0] === "kill" && a[1] === "t1"), "one Herdr never knows is ended");
});

test("opening a file hands it over and gives the terminal a tab with terminal.keep, which is named and selected", async () => {
  const w = world();
  await w.pool.fill(w.cx);
  const logs = [];
  const openTab = createOpenTab({ hc: async () => assert.fail("no hc run on a warm open"), run: (n, a) => w.calls.push([n, a]), spaces: w.spaces,
    panes: () => [], warm: w.pool.claim, log: (f) => logs.push(f) });
  await openTab(editor(), w.cx);
  const [, args] = w.execCalls.find(c => c[0] === "sh");
  assert.deepEqual(args.slice(2), ["warm", "/h/.vscode-warm/id1", "/p/a.ts", "/p"]);
  assert.deepEqual(w.calls, [["terminal.keep", { terminal: "t1", place: "tab" }],
    ["tab.rename", { id: "tbKt1", name: "a.ts" }], ["tab.select", { id: "tbKt1" }]]);
  assert.deepEqual(w.hcCalls.at(-1), ["label", "t1", `${WARM_LABEL}=`, `${FILE_LABEL}=/p/a.ts`], "it now says which file it shows");
  assert.equal(w.store[WARM].sp1, undefined, "taken: the next one starts behind it");
  assert.equal(w.pool.due(), 500);
  assert.deepEqual(logs.map(l => [l.step, l.mode]), [["start", "cold"], ["select", "warm"]]);
  await w.pool.fill(w.cx);
  assert.equal(w.store[WARM].sp1.address, "t2", "a new warm editor replaces the used one");
  assert.ok(!w.hcCalls.some(a => a[0] === "kill"), "the handed-over editor is the user's now");
});

test("no warm editor, a failing hand-off or a tab that never comes: the open starts its own editor as before", async () => {
  const cold = async (w) => {
    const hc = [];
    const openTab = createOpenTab({ hc: async (a) => { hc.push(a); return { code: 1, stdout: "" }; }, run: (n, a) => w.calls.push([n, a]),
      spaces: w.spaces, panes: () => [], warm: w.pool.claim });
    await openTab(editor(), w.cx);
    return hc[0]?.[0];
  };
  let w = world();
  assert.equal(await cold(w), "run", "none yet");
  for (const opts of [{ handoff: 1 }, { keptAfter: Infinity }]) {
    w = world(opts);
    await w.pool.fill(w.cx);
    assert.equal(await cold(w), "run", JSON.stringify(opts));
    assert.ok(w.hcCalls.some(a => a[0] === "kill" && a[1] === "t1"), "the warm editor is ended");
    assert.ok(w.execCalls.some(([c, a]) => c === "rm" && a.includes("/h/.vscode-warm/id1.pid")));
    assert.equal(w.store[WARM].sp1, undefined);
  }
});

test("only the Explorer's local editor is handed over: other programs, the viewer and remote spaces aren't", async () => {
  const w = world();
  await w.pool.fill(w.cx);
  const space = w.spaces()[0];
  assert.equal(await w.pool.claim(space, { name: "x", folder: "/p", argv: ["sh", "/h/mods/vscode-settings/build-core.sh", "/h"] }, w.cx), null);
  assert.equal(await w.pool.claim(space, { name: "a.png", mod: "vscode-viewer", props: {} }, w.cx), null);
  assert.equal(await w.pool.claim(space, openArgs("/p/a.ts", { appHome: "/other", folder: "/p" }), w.cx), null);
  assert.equal(await w.pool.claim({ ...space, machine: "box" }, editor(), w.cx), null);
  assert.deepEqual(w.calls, []);
  assert.equal(await w.pool.claim(space, editor(), w.cx), "tbKt1");
});

test("a warm editor that shows up on screen unasked is ended at once, and none start again until a reload", async () => {
  const w = world();
  await w.pool.fill(w.cx);
  w.show("t1");
  assert.equal(w.pool.due(), 0, "at once");
  await w.pool.fill(w.cx);
  assert.ok(w.hcCalls.some(a => a[0] === "kill" && a[1] === "t1"));
  assert.deepEqual(w.store[WARM], {});
  w.advance(RETRY_MS * 10);
  assert.equal(w.pool.due(), null);
  await w.pool.fill(w.cx);
  assert.equal(w.hcCalls.filter(a => a[0] === "run").length, 1);
});

test("workbench.editor.preloadEditor false: none start, a running one ends on the next pass, opens go as before", async () => {
  const off = world({ settings: '// mine\n{ "workbench.editor.preloadEditor": false, }' });
  await off.pool.fill(off.cx);
  assert.deepEqual(off.hcCalls.filter(a => a[0] !== "ls"), []);
  assert.deepEqual(off.store[WARM] ?? {}, {});
  assert.equal(off.pool.due(), null, "nothing to do while off");
  const w = world();
  await w.pool.fill(w.cx);
  w.file.settings = '{ "workbench.editor.preloadEditor": false }';
  await w.pool.fill(w.cx);
  assert.deepEqual(w.hcCalls.at(-1), ["kill", "t1"]);
  assert.deepEqual(w.store[WARM], {});
  assert.equal(await w.pool.claim(w.spaces()[0], editor(), w.cx), null);
});

test("a closed space's warm editor is ended", async () => {
  const w = world({ spaces: [{ id: "sp1", tabs: ["tbShell"] }, { id: "sp2", tabs: ["tbB"] }] });
  await w.pool.fill(w.cx);
  assert.deepEqual(Object.keys(w.store[WARM]).sort(), ["sp1", "sp2"]);
  w.live.splice(1, 1);
  assert.equal(w.pool.due(), 500);
  await w.pool.fill(w.cx);
  assert.ok(w.hcCalls.some(a => a[0] === "kill" && a[1] === "t2"));
  assert.deepEqual(Object.keys(w.store[WARM]), ["sp1"]);
});

test("a warm editor that ends by itself, or doesn't start, is tried again only after a while", async () => {
  const w = world();
  await w.pool.fill(w.cx);
  w.terms[0].dead = true; // it exited
  assert.equal(w.pool.due(), 500);
  await w.pool.fill(w.cx);
  assert.equal(w.hcCalls.filter(a => a[0] === "run").length, 1, "not again at once");
  assert.equal(w.pool.due(), null);
  w.advance(RETRY_MS);
  await w.pool.fill(w.cx);
  assert.equal(w.store[WARM].sp1.address, "t2");
  const broken = world({ hcCode: 1 });
  await broken.pool.fill(broken.cx);
  assert.deepEqual(broken.store[WARM], {});
  assert.equal(broken.pool.due(), null);
});

test("warm editors left from before a restart (labelled, not listed) are ended once this computer's layout is read", async () => {
  const w = world();
  w.orphan();
  w.orphan();
  await w.pool.fill(w.cx);
  assert.deepEqual(w.hcCalls.filter(a => a[0] === "kill").map(a => a[1]).sort(), ["t1", "t2"]);
  assert.ok(w.execCalls.some(([c, a]) => c === "rm" && a.includes("/h/.vscode-warm/old1.pid")));
  assert.equal(w.store[WARM].sp1.address, "t3", "the space gets a new one of its own");
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
  const key = join(home, ".vscode-warm", "id1");
  const child = spawn(process.execPath, [new URL("../../vscode-viewer/editor/vsedit.cjs", import.meta.url).pathname, "--warm", key, "--close-on-exit"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  for (let i = 0; i < 100 && !existsSync(`${key}.pid`); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readFileSync(`${key}.pid`, "utf8"), String(child.pid));
  const w = world({ real: true, appHome: home });
  w.store[WARM] = { sp1: { key, address: "t9" } };
  const args = openArgs(join(home, "a.ts"), { appHome: home, folder: home });
  assert.equal(await w.pool.claim(w.spaces()[0], args, w.cx), "tbKt9");
  assert.equal(await exited, 1); // the editor without a terminal stops at its first check, past the wait
  assert.match(err, /needs a terminal/);
  assert.equal(existsSync(key) || existsSync(`${key}.pid`), false);
});
