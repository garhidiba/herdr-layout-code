// The Rust core (<herdr home>/vscode-core/vscode-core) behind the "core.engine" setting, and when a panel reads its
// folder again (relevant, stampOf, stale). The same file is in vscode-explorer and vscode-scm (a mod can't import
// another mod's files). No Herdr imports, so node tests load it.

export const CORE_API = 1; // the binary's major version these mods speak (vscode-settings' CORE_API)
const READ_EVERY = 2000, RETRY = 60000, TOAST_KEY = "vscode-core.toast", TOAST_GAP = 10000;

// vscode-settings' coreEngine(): "rust" only when vscode-settings.json (comments and trailing commas allowed) says so.
export function engineOf(text) {
  try {
    const raw = JSON.parse(String(text ?? "").replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));
    return raw?.["core.engine"] === "rust" ? "rust" : "js";
  } catch { return "js"; }
}

// run(args, on) resolves the binary's JSON, or null when the caller takes its JavaScript path: the engine is "js"
// (the binary is never run), the space is remote, the binary reports an error for this call (the JS path then
// shows its own), or the core is missing, too old or prints no JSON. That last case shows one toast and keeps
// to JS until vscode-settings.json changes or a minute passes (a build from Settings is picked up then).
export function createCore({ exec, readTextFile, notify, appHome, shared = () => null, setShared = () => {}, now = Date.now }) {
  let text, engine = "js", readAt = -Infinity, ready = null, brokenAt = null, toasted = false;
  const bin = () => `${appHome()}/vscode-core/vscode-core`;

  async function settings() {
    if (now() - readAt < READ_EVERY) return;
    readAt = now();
    const next = await readTextFile(`${appHome()}/vscode-settings.json`).catch(() => null);
    if (next !== text) { text = next; engine = engineOf(next); ready = null; brokenAt = null; toasted = false; }
  }

  function broken(title, body) {
    brokenAt = now(); ready = null;
    if (toasted) return;
    toasted = true;
    // The other mod may have said the same a moment ago.
    const last = Number(shared(TOAST_KEY));
    if (last && now() - last < TOAST_GAP) return;
    setShared(TOAST_KEY, now());
    notify({ title, body, level: "warning", action: { name: "mod.open", args: { name: "vscode-settings" } } });
  }

  // The parsed JSON, or { error } for a failed call; throws when the binary can't run or prints no JSON.
  async function call(args) {
    const r = await exec(bin(), args);
    const out = JSON.parse(r.stdout);
    if (!out || typeof out !== "object") throw new Error("no JSON");
    return r.code === 0 ? out : { error: out.error ?? r.stderr };
  }

  // The --version handshake, once per settings read (shared by concurrent calls).
  function handshake() {
    ready ??= call(["--version"]).then(
      (v) => Number.parseInt(v.version) === CORE_API || (broken("Rust core is out of date — using JavaScript", "Rebuild it in Settings."), false),
      () => (broken("Rust core not built — using JavaScript", "Build it in Settings."), false));
    return ready;
  }

  // The same call while one is running (a refresh and a preload of the same folder) shares its result.
  const running = new Map();
  function joined(args) {
    const id = args.join("\0");
    if (!running.has(id)) running.set(id, call(args).finally(() => running.delete(id)));
    return running.get(id);
  }

  return async function run(args, on = null) {
    if (on) return null;
    await settings();
    if (engine !== "rust" || (brokenAt !== null && now() - brokenAt < RETRY)) return null;
    if (!(await handshake())) return null;
    try {
      const out = await joined(args);
      return out.error === undefined ? out : null;
    } catch { broken("Rust core call failed — using JavaScript", "It passed its version check; one call failed (a mod reload can do this). Trying again in a minute."); return null; }
  };
}

// Whether a watchFolder() batch can change what a panel shows: not when every path is one VS Code's files.watcherExclude
// leaves out by default (git's object store, inside an installed package, Mercurial's store). Empty means unknown: yes.
const UNWATCHED = /\/\.git\/(objects|subtree-cache)\/|\/node_modules\/[^/]+\/|\/\.hg\/store\//;
export const relevant = (paths) => !paths?.length || paths.some((p) => !UNWATCHED.test(p));

// One `stat` of the paths (mtime, ctime, size and inode; a missing path prints nothing) as a string to compare, or
// null when it can't run (Windows). Cheap next to a listing: no folder is read.
export async function stampOf(exec, paths, platform) {
  if (platform === "windows" || !paths.length) return null;
  const format = platform === "macos" ? ["-f", "%N %Fm %Fc %z %i"] : ["-c", "%n %y %z %s %i"];
  const r = await exec("stat", ["-L", ...format, "--", ...paths]).catch(() => null);
  return r ? r.stdout : null;
}

// A watched local panel's 10s timer reads again only 5 minutes after its last read or when the stamp of what it
// shows moved since then (`seen`: { stamp, at } of that read). The folder watch reads on changes; this catches what it
// can't see, such as a commit in a repo whose .git is above the watched folder.
export const FULL_EVERY = 300000;
export async function stale(seen, stamp, now = Date.now()) {
  if (!seen || now - seen.at >= FULL_EVERY) return true;
  const s = await stamp();
  return s === null || s !== seen.stamp;
}
