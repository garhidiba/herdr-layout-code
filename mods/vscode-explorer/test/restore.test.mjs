// node --test mods/vscode-explorer/test/restore.test.mjs — editor tabs come back after their machine restarts (restore.js)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestore, missingLabels, restoreStep, relaunchCommand, existsCommand, shellOf, launcherOf, LAUNCHER_LABEL, RESTORE_LABEL, RESTORED_LABEL } from "../restore.js";
import { FILE_LABEL, editorFileOf } from "../paths.js";

const LOCAL = "/h/mods/vscode-viewer/editor/vsedit.sh";
const UNIX = "/root/.local/share/herdr-vscode/1.0.0-092711619330/vsedit.sh";
const WIN = "C:\\Users\\ardi\\AppData\\Local\\herdr-vscode\\1.0.0-092711619330\\vsedit.ps1";
const FIND = 'PATH="/opt/homebrew/bin:$PATH"; command -v "$0" >/dev/null && exec "$0" "$@"';
// As measured (2026-11-24): a local editor started by launch.js directRun; a restored terminal (zsh, PowerShell on
// win-amd64) keeps its address and labels but runs the shell, which is its own foreground while idle.
const EDITOR_ROW = { address: "t5", argv: ["/bin/sh", "-c", FIND, "sh", LOCAL, "/p/a.ts", "--close-on-exit"], labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } };
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const labelsOf = (file, launcher, more = {}) => ({ "herdr.tab": "tb1", [FILE_LABEL]: file, [LAUNCHER_LABEL]: launcher, [RESTORE_LABEL]: "1", ...more });
const zsh = (more = {}) => ({ address: "t5", state: "live", pid: 734, argv: ["/bin/zsh", "-l"], foreground: { argv: ["/bin/zsh", "-l"], name: "zsh", pid: 734 }, labels: labelsOf("/p/a.ts", LOCAL), ...more });
const powershell = (more = {}) => ({ address: "win-amd64/t29", state: "live", pid: 18244, argv: ["powershell.exe", "-NoExit", "-Command", "$global:__hc_prompt = …"],
  foreground: { argv: [PS, "-NoExit"], name: "powershell.exe", pid: 18244 }, labels: labelsOf("C:\\project\\vardi\\.env", WIN), ...more });

test("an editor terminal is labelled with its file and launcher, however it was started", () => {
  assert.deepEqual(missingLabels(EDITOR_ROW), [`${FILE_LABEL}=/p/a.ts`, `${LAUNCHER_LABEL}=${LOCAL}`, `${RESTORE_LABEL}=1`]);
  const remote = { address: "a7z/t12", argv: ["sh", "-c", "shell=${SHELL:-/bin/sh}\n…", "sh", "exec", "sh", UNIX, "/root/x.sh", "--close-on-exit", "--os", "mac", "--settings", "{}"] };
  assert.deepEqual(missingLabels(remote), [`${FILE_LABEL}=/root/x.sh`, `${LAUNCHER_LABEL}=${UNIX}`, `${RESTORE_LABEL}=1`], "Herdr's tab.new wrapping on another machine");
  const win = { address: "win-amd64/t3", argv: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WIN, "C:\\p\\a.ts", "--close-on-exit"] };
  assert.equal(missingLabels(win)[1], `${LAUNCHER_LABEL}=${WIN}`);
  const warm = { address: "t7", argv: ["/bin/sh", "-c", FIND, "sh", LOCAL, "--warm", "/h/.vscode-warm/k", "--close-on-exit"], labels: { [FILE_LABEL]: "/p/b.ts" } };
  assert.equal(missingLabels(warm)[0], `${FILE_LABEL}=/p/b.ts`, "a warm editor's file is its label");
});

test("a terminal that has its labels, a waiting warm editor, a shell and an agent get none", () => {
  assert.equal(missingLabels({ ...EDITOR_ROW, labels: labelsOf("/p/a.ts", LOCAL) }), null);
  assert.equal(missingLabels({ address: "t7", argv: ["/bin/sh", "-c", FIND, "sh", LOCAL, "--warm", "/k", "--close-on-exit"], labels: {} }), null);
  assert.equal(missingLabels(zsh()), null, "a restored shell keeps the labels it has, nothing is added");
  assert.equal(missingLabels({ address: "t9", argv: ["claude"] }), null);
  assert.equal(missingLabels({ address: "a7z/t1" }), null, "a remote row without argv");
});

test("the launcher is found in an editor's argv, not in a shell's", () => {
  assert.equal(launcherOf(EDITOR_ROW.argv), LOCAL);
  assert.equal(launcherOf(["/bin/zsh", "-l"]), null);
  assert.equal(launcherOf(undefined), null);
  assert.equal(editorFileOf(zsh().argv, zsh().labels), "/p/a.ts", "a restored shell still reads as that file's editor until it is brought back or forgotten");
});

test("shells by syntax", () => {
  assert.equal(shellOf(zsh()), "posix");
  assert.equal(shellOf(powershell()), "powershell");
  assert.equal(shellOf({ foreground: { name: "pwsh.exe" } }), "powershell");
  assert.equal(shellOf({ foreground: { name: "bash.exe" } }), "posix", "Git Bash");
  assert.equal(shellOf({ argv: ["-zsh"] }), "posix", "a login shell's argv[0]");
  assert.equal(shellOf({ foreground: { name: "cmd.exe" } }), null);
});

test("a restored terminal idle at its shell is relaunched", () => {
  assert.deepEqual(restoreStep(zsh()), { action: "relaunch", file: "/p/a.ts", launcher: LOCAL, shell: "posix" });
  assert.deepEqual(restoreStep(powershell()), { action: "relaunch", file: "C:\\project\\vardi\\.env", launcher: WIN, shell: "powershell" });
});

test("nothing is done while the editor runs, once it was brought back for this shell, or for unlabelled terminals", () => {
  assert.equal(restoreStep({ ...zsh(), argv: EDITOR_ROW.argv }), null, "the editor never went away");
  assert.equal(restoreStep(zsh({ labels: labelsOf("/p/a.ts", LOCAL, { [RESTORED_LABEL]: "734" }) })), null, "an editor that exited and left the shell");
  assert.deepEqual(restoreStep(zsh({ labels: labelsOf("/p/a.ts", LOCAL, { [RESTORED_LABEL]: "100" }) })).action, "relaunch", "a later restart: a new shell");
  assert.equal(restoreStep(zsh({ labels: { [FILE_LABEL]: "/p/a.ts" } })), null, "a warm editor's label alone");
  assert.equal(restoreStep(zsh({ state: "finished" })), null);
  assert.equal(restoreStep(null), null);
});

test("a shell running something waits; one we can't type into is forgotten", () => {
  assert.deepEqual(restoreStep(zsh({ foreground: { name: "vim", pid: 900 } })), { action: "wait" });
  assert.deepEqual(restoreStep(zsh({ foreground: null })), { action: "wait" });
  assert.deepEqual(restoreStep(zsh({ argv: ["cmd.exe"], foreground: { name: "cmd.exe", pid: 734 } })), { action: "forget" });
});

test("the relaunch line starts the launcher as tab.new did, with --os only on another machine", () => {
  assert.equal(relaunchCommand({ file: "/p/it's.ts", launcher: LOCAL, shell: "posix" }), `exec 'sh' '${LOCAL}' '/p/it'\\''s.ts' '--close-on-exit'`);
  assert.equal(relaunchCommand({ file: "/root/x.sh", launcher: UNIX, shell: "posix" }, "mac"), `exec 'sh' '${UNIX}' '/root/x.sh' '--close-on-exit' '--os' 'mac'`);
  assert.equal(relaunchCommand({ file: "C:\\p\\Bob's a.ts", launcher: WIN, shell: "powershell" }, "mac"),
    `& 'powershell' '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' '${WIN}' 'C:\\p\\Bob''s a.ts' '--close-on-exit' '--os' 'mac'`);
  assert.equal(relaunchCommand({ file: "C:\\p\\a.ts", launcher: WIN, shell: "posix" }, "mac").slice(0, 19), "exec 'powershell' '", "Git Bash");
});

test("the POSIX relaunch line hands the launcher exactly its arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-")), launcher = join(dir, "vsedit.sh");
  writeFileSync(launcher, 'for a in "$@"; do printf "[%s]" "$a"; done');
  const line = relaunchCommand({ file: "/p/a b/it's $x.ts", launcher, shell: "posix" }, "mac");
  assert.equal(execFileSync("sh", ["-c", line]).toString(), "[/p/a b/it's $x.ts][--close-on-exit][--os][mac]");
});

test("the file and the launcher are checked on their machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-")), file = join(dir, "a.ts"), launcher = join(dir, "vsedit.sh");
  writeFileSync(launcher, "");
  const run = (f) => { const [p, a] = existsCommand({ file: f, launcher }); try { execFileSync(p, a); return 0; } catch (e) { return e.status; } };
  assert.equal(run(file), 1, "gone");
  writeFileSync(file, "");
  assert.equal(run(file), 0);
  const [program, args] = existsCommand({ file: "C:\\p\\Bob's.ts", launcher: WIN });
  assert.equal(program, "powershell");
  assert.match(args.at(-1), /Test-Path -LiteralPath 'C:\\p\\Bob''s\.ts'\) -and \(Test-Path -LiteralPath 'C:\\Users/);
});

// A fake core: `terms` by address (hc get's JSON, mutated by hc label), every hc and exec call logged.
function core(terms, { exists = 0, labelCode = 0 } = {}) {
  const hcCalls = [], execCalls = [];
  const hc = async (a) => {
    hcCalls.push(a);
    if (a[0] === "ls") return { code: 0, stdout: JSON.stringify({ terminals: Object.values(terms).filter(t => t.labels?.[RESTORE_LABEL] === "1").map(t => ({ address: t.address, agent: "zsh" })) }) };
    if (a[0] === "get") return terms[a[1]] ? { code: 0, stdout: JSON.stringify(terms[a[1]]) } : { code: 1, stdout: "", stderr: "no such terminal" };
    if (a[0] === "label") {
      if (labelCode) return { code: labelCode, stdout: "" };
      const t = terms[a[1]];
      for (const kv of a.slice(2)) { const [k, ...v] = kv.split("="); if (v.join("=")) t.labels[k] = v.join("="); else delete t.labels[k]; }
      return { code: 0, stdout: "{}" };
    }
    return { code: 0, stdout: "{}" };
  };
  const exec = async (cmd, args, opts) => { execCalls.push({ cmd, args, opts }); if (exists === "throw") throw new Error("unreachable"); return { code: exists, stdout: "" }; };
  return { hc, exec, hcCalls, execCalls };
}
const cx = { sleeps: 0, async sleep() { this.sleeps++; } };
const sends = (calls) => calls.filter(a => a[0] === "send");

test("a pass types the editor into a restored local shell once, after marking it", async () => {
  const terms = { t5: zsh() }, c = core(terms), r = createRestore({ hc: c.hc, exec: c.exec, os: () => "mac" });
  await r.pass(cx, [{ address: "t5", argv: ["/bin/zsh", "-l"] }]);
  assert.deepEqual(c.execCalls[0], { cmd: "sh", args: ["-c", 'test -e "$1" && test -f "$2"', "restore", "/p/a.ts", LOCAL], opts: undefined });
  assert.deepEqual(sends(c.hcCalls), [["send", "t5", `exec 'sh' '${LOCAL}' '/p/a.ts' '--close-on-exit'`]]);
  assert.match(terms.t5.labels[RESTORED_LABEL], /^734 \w+$/);
  await r.pass(cx, []);
  assert.equal(sends(c.hcCalls).length, 1, "never twice for the same shell");
});

test("of two desktops bringing back the same terminal, only the last to mark it types", async () => {
  const terms = { t5: zsh() }, c = core(terms), r = createRestore({ hc: c.hc, exec: c.exec });
  const other = { async sleep() { terms.t5.labels[RESTORED_LABEL] = "734 otherdesk"; } };
  await r.pass(other);
  assert.equal(sends(c.hcCalls).length, 0);
});

test("a restored Windows terminal gets the PowerShell line with this keyboard's keys, checked there", async () => {
  const terms = { "win-amd64/t29": powershell() }, c = core(terms), r = createRestore({ hc: c.hc, exec: c.exec, os: () => "mac" });
  await r.pass(cx);
  assert.equal(c.execCalls[0].cmd, "powershell");
  assert.deepEqual(c.execCalls[0].opts, { on: "win-amd64" });
  assert.equal(sends(c.hcCalls)[0][2], `& 'powershell' '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' '${WIN}' 'C:\\project\\vardi\\.env' '--close-on-exit' '--os' 'mac'`);
});

test("a gone file leaves the shell and its labels go, so it is a plain shell from then on", async () => {
  const terms = { t5: zsh() }, c = core(terms, { exists: 1 }), r = createRestore({ hc: c.hc, exec: c.exec });
  await r.pass(cx);
  assert.equal(sends(c.hcCalls).length, 0);
  assert.deepEqual(terms.t5.labels, { "herdr.tab": "tb1" });
  assert.equal(editorFileOf(terms.t5.argv, terms.t5.labels), null);
});

test("a machine that can't be asked, or a label that doesn't stick, is tried again on the next pass", async () => {
  const terms = { "a7z/t2": zsh({ address: "a7z/t2", labels: labelsOf("/root/x.sh", UNIX) }) };
  const down = core(terms, { exists: "throw" });
  await createRestore({ hc: down.hc, exec: down.exec }).pass(cx);
  assert.equal(sends(down.hcCalls).length, 0);
  assert.equal(terms["a7z/t2"].labels[FILE_LABEL], "/root/x.sh", "kept for the next try");
  const stuck = core(terms, { labelCode: 1 });
  await createRestore({ hc: stuck.hc, exec: stuck.exec }).pass(cx);
  assert.equal(sends(stuck.hcCalls).length, 0, "not typed without the mark that stops a second time");
});

test("a shell still busy after the wait is left alone and forgotten; one that settles is relaunched", async () => {
  const busy = { t5: zsh({ foreground: { name: "make", pid: 900 } }) }, c = core(busy), slow = { sleeps: 0, async sleep() { this.sleeps++; } };
  await createRestore({ hc: c.hc, exec: c.exec, tries: 3 }).pass(slow);
  assert.equal(slow.sleeps, 3);
  assert.equal(sends(c.hcCalls).length, 0);
  assert.equal(busy.t5.labels[FILE_LABEL], undefined);
  const settling = { t5: zsh({ foreground: { name: "brew", pid: 901 } }) }, d = core(settling);
  const once = { async sleep() { settling.t5.foreground = { name: "zsh", pid: 734 }; } };
  await createRestore({ hc: d.hc, exec: d.exec }).pass(once);
  assert.equal(sends(d.hcCalls).length, 1, "rc files done loading");
});

test("terminals whose rows still name the launcher aren't asked about", async () => {
  const terms = { t5: zsh() }, c = core(terms), r = createRestore({ hc: c.hc, exec: c.exec });
  await r.pass(cx, [EDITOR_ROW]);
  assert.equal(c.hcCalls.filter(a => a[0] === "get").length, 0);
});

test("label() asks hc once per editor and again only after a failure", async () => {
  const calls = [];
  let code = 1;
  const r = createRestore({ hc: async (a) => { calls.push(a); return { code }; }, exec: async () => ({ code: 0 }) });
  r.label([EDITOR_ROW, { address: "t9", argv: ["claude"] }]);
  await new Promise(res => setImmediate(res));
  r.label([EDITOR_ROW]);
  await new Promise(res => setImmediate(res));
  code = 0;
  r.label([EDITOR_ROW]);
  r.label([EDITOR_ROW]);
  await new Promise(res => setImmediate(res));
  assert.deepEqual(calls.map(a => a.slice(0, 2)), [["label", "t5"], ["label", "t5"], ["label", "t5"]]);
  assert.deepEqual(calls[0].slice(2), [`${FILE_LABEL}=/p/a.ts`, `${LAUNCHER_LABEL}=${LOCAL}`, `${RESTORE_LABEL}=1`]);
});
