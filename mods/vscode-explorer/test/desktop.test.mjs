// node --test mods/vscode-explorer/test/desktop.test.mjs — a remote editor's suggestions through this desktop (desktop.js)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkName, editorMachines, plan, createDesktop, MARK, LINK, DESKTOPS } from "../desktop.js";

const ME = "8dc19e97794336f4c322e0926122c176";
const editor = (address, file = "/srv/a.yml") => ({ address, argv: ["sh", "/root/.local/share/herdr-vscode/1.0.0-0123456789ab/vsedit.sh", file, "--close-on-exit"], labels: {} });
const machine = (name, extra = {}) => ({ name, state: "connected", target: `root@${name}`, via: false, ...extra });

test("one link per machine, named as hc allows", () => {
  assert.match(linkName("orangepi"), /^vscode-link-[0-9a-f]{8}$/);
  assert.equal(linkName("orangepi"), linkName("orangepi"));
  assert.notEqual(linkName("orangepi"), linkName("raspberry"));
  assert.ok(linkName("Ünïcode machine.local").length <= 32);
});

test("the machines with an editor open: remote editor terminals only", () => {
  const terms = [editor("orangepi/t7"), editor("t3"), { address: "raspberry/t2", argv: ["zsh"], labels: {} }, { address: "a7z/t9", argv: ["sh"], labels: { "vscode.file": "/x" } }];
  assert.deepEqual([...editorMachines(terms)], ["orangepi", "a7z"]);
});

test("a pass starts a link where an editor is open, ends it where none is left, and skips what can't tunnel", () => {
  const machines = [machine("orangepi"), machine("raspberry"), machine("fly", { via: true, target: "fly ssh console" }), machine("a7z", { state: "unreachable" })];
  const running = new Set([linkName("raspberry")]);
  const p = plan(new Set(["orangepi", "fly", "a7z"]), machines, running);
  assert.deepEqual(p.start, [{ machine: "orangepi", name: linkName("orangepi"), target: "root@orangepi" }]);
  assert.deepEqual(p.stop, [linkName("raspberry")], "no editor left there");
  assert.deepEqual(p.via, ["fly"], "reached through a command: no ssh to tunnel");
  assert.deepEqual(plan(new Set(["raspberry"]), machines, running), { start: [], stop: [], via: [] }, "already linked");
});

// A fake hc: `server status`, `ls` and `machine ls` answer the given rows; every call is logged.
function fakeHc({ live = [], machines = [] } = {}) {
  const calls = [];
  const hc = async (args) => {
    calls.push(args);
    const out = args[0] === "server" ? { core: { id: ME } } : args[0] === "ls" ? { terminals: live.map(name => ({ name, state: "live" })) }
      : args[0] === "machine" ? { machines } : {};
    return { code: 0, stdout: JSON.stringify(out), stderr: "" };
  };
  return { hc, calls };
}

test("sync runs link.cjs as an hc terminal with the machine's ssh target and this desktop's id; ends the unwanted", async () => {
  const { hc, calls } = fakeHc({ live: [linkName("raspberry")], machines: [machine("orangepi", { target: "root@192.168.50.5" }), machine("raspberry")] });
  const d = createDesktop({ hc, exec: async () => ({ code: 0 }), appHome: () => "/H", notify: () => {} });
  await d.sync([editor("orangepi/t7")]);
  const run = calls.find(c => c[0] === "run");
  assert.deepEqual(run, ["run", "--bg", "--no-parent", "--rm", "--name", linkName("orangepi"), "--", "sh", "-c", LINK, "herdr-vscode", "/H",
    "/H/mods/vscode-viewer/editor/link.cjs", "root@192.168.50.5", ME]);
  assert.deepEqual(calls.find(c => c[0] === "kill"), ["kill", linkName("raspberry")]);
});

test("a machine reached through a command is told once", async () => {
  const { hc } = fakeHc({ machines: [machine("fly", { via: true })] });
  const told = [];
  const d = createDesktop({ hc, exec: async () => ({ code: 0 }), appHome: () => "/H", notify: (n) => told.push(n.title) });
  await d.sync([editor("fly/t1")]);
  await d.sync([editor("fly/t1")]);
  assert.deepEqual(told, ["No inline suggestions in fly's editor"]);
});

test("a remote editor known only by its pane's title is linked; hc refusing the link is told once", async () => {
  const { hc: base, calls } = fakeHc({ machines: [machine("a7z", { target: "root@192.168.50.241" })] });
  const hc = async (args) => (args[0] === "run" ? (calls.push(args), { code: 2, stdout: "", stderr: "error: bad name\n" }) : base(args));
  const told = [];
  const d = createDesktop({ hc, exec: async () => ({ code: 0 }), appHome: () => "/H", notify: (n) => told.push(n.body) });
  const row = { address: "a7z/t12", agent: "sh", cwd: "/root", state: "live" }, pane = { terminal: "a7z/t12", title: "install_beszel.sh — vsedit" };
  await d.sync([row], [pane]);
  await d.sync([row], [pane]);
  assert.equal(calls.filter(c => c[0] === "run").length, 2, "each pass tries again");
  assert.deepEqual(told, ["hc run failed: error: bad name"]);
});

test("focusing a remote editor in an active window marks this desktop active there, once per change", async () => {
  const { hc } = fakeHc();
  const execs = [];
  const d = createDesktop({ hc, exec: async (cmd, args, opts) => { execs.push([cmd, args, opts]); return { code: 0 }; }, appHome: () => "/H", notify: () => {} });
  await d.mark("orangepi");
  await d.mark("orangepi");
  await d.mark(null); // another tab, or the window not active
  await d.mark("orangepi");
  assert.deepEqual(execs, [["sh", ["-c", MARK, "herdr-vscode", ME], { on: "orangepi" }], ["sh", ["-c", MARK, "herdr-vscode", ME], { on: "orangepi" }]]);
});

test("the mark there: `active` names this desktop; the link's runner hands node the Herdr home", () => {
  const home = mkdtempSync(join(tmpdir(), "desktop-"));
  execFileSync("sh", ["-c", MARK, "herdr-vscode", ME], { env: { ...process.env, HOME: home } });
  assert.equal(readFileSync(join(home, DESKTOPS, "active"), "utf8"), `${ME}\n`);
  const out = execFileSync("sh", ["-c", LINK, "herdr-vscode", "/H", "-e", "console.log(process.env.HERDR_APP_HOME)"], { encoding: "utf8" });
  assert.equal(out, "/H\n");
});
