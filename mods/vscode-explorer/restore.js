// Editor tabs after a restart. A machine that reboots (or whose core crashes) gets its kept terminals back with the
// same address, labels and tab, but as a plain shell in the last folder: Herdr never runs the original command again.
// So every editor terminal (its argv names the launcher, local or remote, however it was opened: the Explorer, Source
// Control, a diff, Split Right, Settings) is labelled with its file and launcher, and a labelled terminal found running
// an idle shell instead (its argv no longer names the launcher) gets the editor typed into it once: the same tab, the
// same file. One that is busy, has an unknown shell or whose file (or launcher) is gone loses the labels and stays a
// shell. No Herdr imports, so node tests load it.
import { FILE_LABEL, editorFileOf, launcherArgv } from "./paths.js";
import { psQuote } from "./remote.js";

// FILE_LABEL (paths.js) is the file; these are the launcher it ran, the marker `hc ls --label` finds them by, and the
// "<shell pid> <desktop token>" the editor was typed into (once per restart: an editor that exits and leaves that shell
// isn't started again).
export const LAUNCHER_LABEL = "vscode.launcher", RESTORE_LABEL = "vscode.restore", RESTORED_LABEL = "vscode.restored";
const LAUNCHER = /(^|[\\/])vsedit\.(sh|ps1)$/;

// The launcher in an argv (EDITOR, or a remote machine's vsedit.sh / vsedit.ps1), however Herdr wrapped it; null for
// any other program, a shell Herdr gave back after a restart included.
export const launcherOf = (argv) => (Array.isArray(argv) ? argv.find(a => typeof a === "string" && LAUNCHER.test(a)) : null) ?? null;

// The `hc label` k=v list an editor terminal (a terminals() row) still lacks; null when it has them all or is no editor.
// The file is editorFileOf's (a warm editor's argv has none: its FILE_LABEL).
export function missingLabels(t) {
  const launcher = launcherOf(t?.argv), file = launcher && editorFileOf(t.argv, t.labels);
  if (!file) return null;
  const want = [[FILE_LABEL, file], [LAUNCHER_LABEL, launcher], [RESTORE_LABEL, "1"]];
  return want.every(([k, v]) => t.labels?.[k] === v) ? null : want.map(([k, v]) => `${k}=${v}`);
}

// Which syntax the terminal's shell takes: "powershell" (Windows PowerShell, pwsh), "posix" (sh, bash (Git Bash too),
// zsh, fish…), else null.
export function shellOf(t) {
  const name = String(t?.foreground?.name ?? t?.argv?.[0] ?? "").split(/[\\/]/).pop().toLowerCase().replace(/^-/, "").replace(/\.exe$/, "");
  return /^(pwsh|powershell)$/.test(name) ? "powershell" : /^(sh|bash|zsh|dash|ksh|mksh|ash|fish)$/.test(name) ? "posix" : null;
}

// What to do with a labelled terminal (`hc get --json`): null = nothing (the editor still runs, it was brought back
// already, or it isn't one of ours); "wait" = something runs in its shell (rc files may still be loading); "forget" =
// a shell we can't type into; "relaunch" with { file, launcher, shell }.
export function restoreStep(t) {
  const labels = t?.labels ?? {}, file = labels[FILE_LABEL], launcher = labels[LAUNCHER_LABEL];
  if (t?.state !== "live" || labels[RESTORE_LABEL] !== "1" || !file || !launcher) return null;
  if (launcherOf(t.argv) || String(labels[RESTORED_LABEL] ?? "").split(" ")[0] === String(t.pid)) return null;
  if (!t.foreground || t.foreground.pid !== t.pid) return { action: "wait" };
  const shell = shellOf(t);
  return shell ? { action: "relaunch", file, launcher, shell } : { action: "forget" };
}

const shQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
// The line typed into the shell: the launcher as paths.js launcherArgv starts it, the file, --close-on-exit (the tab
// closes with the editor, as before) and, on another machine, --os (this keyboard's keys). Its settings are the copies
// written there at the last launch. POSIX shells `exec` it (as tab.new did); PowerShell runs it with `&` and
// vsedit.ps1 ends the terminal afterwards.
export function relaunchCommand({ file, launcher, shell }, os = null) {
  const start = launcherArgv(launcher), argv = [...(start[0] === "exec" ? start.slice(1) : start), file, "--close-on-exit", ...(os ? ["--os", os] : [])];
  return shell === "powershell" ? `& ${argv.map(psQuote).join(" ")}` : `exec ${argv.map(shQuote).join(" ")}`;
}

// [program, args] exiting 0 when the file and the launcher are both there (1 when not), on the machine they are on.
export function existsCommand({ file, launcher }) {
  return /\.ps1$/.test(launcher)
    ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `if ((Test-Path -LiteralPath ${psQuote(file)}) -and (Test-Path -LiteralPath ${psQuote(launcher)})) { exit 0 } else { exit 1 }`]]
    : ["sh", ["-c", 'test -e "$1" && test -f "$2"', "restore", file, launcher]];
}

// hc(args) and exec(cmd, args, {on}) as Herdr's; os() this keyboard's keys (remote.js keysOs). Returns
// label(rows) (cheap: call it with terminals() rows on every draw) and pass(cx) (lists the labelled terminals and brings
// back the restored ones; a machine that can't be asked now is tried again on the next pass). `tries` × `step` ms: how
// long a busy shell is waited for before it is left alone.
export function createRestore({ hc, exec, os = () => null, tries = 6, step = 500 }) {
  const labelled = new Set(), token = Math.random().toString(36).slice(2, 10);
  let passing = false;
  const json = async (args) => { try { const r = await hc(args); return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
  const forget = (address) => hc(["label", address, `${FILE_LABEL}=`, `${LAUNCHER_LABEL}=`, `${RESTORE_LABEL}=`, `${RESTORED_LABEL}=`]).catch(() => {});

  function label(rows) {
    const live = new Set(rows.map(t => t.address));
    for (const a of labelled) if (!live.has(a)) labelled.delete(a);
    for (const t of rows) {
      const missing = labelled.has(t.address) ? null : missingLabels(t);
      if (!missing) continue;
      labelled.add(t.address);
      hc(["label", t.address, ...missing]).then(r => { if (r?.code !== 0) labelled.delete(t.address); }, () => labelled.delete(t.address));
    }
  }

  async function bringBack(address, cx) {
    for (let n = 0; ; n++) {
      const t = await json(["get", address, "--json"]), next = restoreStep(t);
      if (!next) return;
      if (next.action === "wait" && n < tries) { await cx.sleep(step); continue; }
      if (next.action !== "relaunch") return forget(address);
      const on = address.includes("/") ? address.split("/")[0] : null, [program, args] = existsCommand(next);
      const r = await exec(program, args, ...(on ? [{ on }] : [])).catch(() => null);
      if (r?.code === 1) return forget(address);
      if (r?.code !== 0) return;
      // Marked first, so it is typed once even if the send fails; another desktop showing the same machine may be
      // bringing it back too: the last mark wins, read back a moment later.
      const mark = `${t.pid} ${token}`, marked = await hc(["label", address, `${RESTORED_LABEL}=${mark}`]).catch(() => null);
      if (marked?.code !== 0) return;
      await cx.sleep(step);
      if ((await json(["get", address, "--json"]))?.labels?.[RESTORED_LABEL] !== mark) return;
      await hc(["send", address, relaunchCommand(next, on ? os() : null)]).catch(() => {});
      return;
    }
  }

  // `rows`: terminals() rows; a terminal whose row still names the launcher runs its editor and isn't asked about.
  async function pass(cx, rows = []) {
    if (passing) return;
    passing = true;
    try {
      const listed = await json(["ls", "--json", "--label", `${RESTORE_LABEL}=1`]);
      const running = new Set(rows.filter(t => launcherOf(t.argv)).map(t => t.address));
      for (const { address } of listed?.terminals ?? []) {
        if (typeof address === "string" && !running.has(address)) await bringBack(address, cx);
      }
    } finally { passing = false; }
  }

  return { label, pass };
}
