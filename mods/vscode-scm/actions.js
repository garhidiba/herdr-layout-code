// The changed files' and the Changes header's right-click menus as VS Code's SCM view has them, as pure rules: what a
// file's `git status` says (fileState), which items show (fileMenuItems, groupMenuItems) and what each runs (actionSteps).
// No Herdr imports, so node tests load it.

// One `git status --porcelain=v1 -z --no-renames` entry per file: { path, xy }.
export const parseStatus = (text) => String(text ?? "").split("\0").filter((e) => e.length > 3).map((e) => ({ xy: e.slice(0, 2), path: e.slice(3) }));

// X is the index (staged), Y the working tree (unstaged); "??" untracked. A conflict (U, AA, DD) is unstaged: staging
// it marks it resolved, as VS Code's Stage does.
export function fileState(xy) {
  if (!xy) return { staged: false, unstaged: false, untracked: false, added: false, deleted: false };
  if (xy === "??") return { staged: false, unstaged: true, untracked: true, added: false, deleted: false };
  const [x, y] = xy, conflict = /U|AA|DD/.test(xy);
  return { staged: !conflict && x !== " ", unstaged: conflict || y !== " ", untracked: false, added: x === "A", deleted: y === "D" || (y === " " && x === "D") };
}

// The Changes header's menu reads the whole status: whether anything is staged, unstaged, or changed at all.
export function groupState(entries) {
  const states = entries.map((e) => fileState(e.xy));
  return { staged: states.some((s) => s.staged), unstaged: states.some((s) => s.unstaged), count: states.length };
}

// Rows as the Explorer's menu has them: [label, action, key?, disabled?] or "-" between groups.
const join = (groups) => groups.filter((g) => g.length).flatMap((g, i) => (i ? ["-", ...g] : g));

// A changed file. `state` from fileState; `remote` hides Reveal in Finder (this computer's files only); a deleted file
// has nothing to open or reveal.
export function fileMenuItems(state, { remote = false } = {}) {
  const there = !state.deleted;
  return join([
    [["Open Changes", "diff"], ...(there ? [["Open File", "open"]] : [])],
    [...(state.unstaged ? [["Stage Changes", "stage"]] : []), ...(state.staged ? [["Unstage Changes", "unstage"]] : []),
      ...(state.staged || state.unstaged ? [["Discard Changes", "discard"]] : [])],
    state.untracked ? [["Add to .gitignore", "ignore"]] : [],
    there ? [["Reveal in Explorer View", "revealExplorer"], ...(remote ? [] : [["Reveal in Finder", "reveal", "⌥⌘R"]])] : [],
    [["Copy Path", "copyPath", "⌥⌘C"], ["Copy Relative Path", "copyRelative", "⇧⌥⌘C"]],
  ]);
}

// The Changes header. Discard All needs a commit to go back to: in a repo without one it would delete every file.
export function groupMenuItems(state, { hasHead = true } = {}) {
  return join([[
    ...(state.unstaged ? [["Stage All Changes", "stageAll"]] : []),
    ...(state.staged ? [["Unstage All Changes", "unstageAll"]] : []),
    ...(state.count && hasHead ? [["Discard All Changes", "discardAll"]] : []),
  ]]);
}

export const menuHeight = (rows) => rows.reduce((h, r) => h + (r === "-" ? 9 : 26), 10);

// The commands an action runs in the repo (its root as cwd): [cmd, args] each, in order. Discard goes back to HEAD,
// index and working tree both, since Changes shows HEAD ↔ the working tree: an untracked file is removed (git clean),
// a newly added one removed from both (git rm -f), the rest checked out from HEAD. Add to .gitignore appends
// "/<path>" on a line of its own. Paths are literal (a name with * or : is that file). null for an action that runs nothing here.
const IGNORE = 'f="$1/.gitignore"; if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then printf "\\n" >> "$f"; fi; printf "%s\\n" "$2" >> "$f"';
export function actionSteps(action, { root, path, state, hasHead = true }) {
  const git = (...args) => ["git", ["--literal-pathspecs", ...args]];
  switch (action) {
    case "stage": return [git("add", "-A", "--", path)];
    case "unstage": return [hasHead ? git("reset", "-q", "HEAD", "--", path) : git("rm", "--cached", "-q", "--", path)];
    case "discard":
      if (state.untracked) return [git("clean", "-f", "-q", "--", path)];
      if (state.added || !hasHead) return [git("rm", "-f", "-q", "--", path)];
      return [git("checkout", "-q", "HEAD", "--", path)];
    case "ignore": return [["sh", ["-c", IGNORE, "scm", root, `/${path}`]]];
    case "stageAll": return [git("add", "-A")];
    case "unstageAll": return [hasHead ? git("reset", "-q") : git("rm", "-r", "--cached", "-q", ".")];
    case "discardAll": return hasHead ? [git("reset", "-q", "--hard", "HEAD"), git("clean", "-f", "-d", "-q")] : null;
  }
  return null;
}

// VS Code's confirmations for the destructive ones: { title, detail } or null when the action asks nothing.
export function confirmOf(action, { path, state, count }) {
  const name = String(path ?? "").split("/").pop();
  if (action === "discard") return state.untracked
    ? { title: `Are you sure you want to DELETE ${name}?`, detail: "This is IRREVERSIBLE! This file will be FOREVER LOST if you proceed." }
    : { title: `Are you sure you want to discard changes in ${name}?`, detail: "This action is irreversible!" };
  if (action === "discardAll") return { title: `Are you sure you want to discard ALL changes in ${count} file${count === 1 ? "" : "s"}?`,
    detail: "Untracked files are deleted too. This action is irreversible!" };
  return null;
}

// Copies of vscode-explorer's paths.js / remote.js (mods can't import each other's files).
export const keysOs = (platform) => (platform === "macos" ? "mac" : platform === "windows" ? "win" : "linux");
export function clipboardCommand(os, text) {
  if (os === "win") return ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${text.replaceAll("'", "''")}'`]];
  const tool = os === "mac" ? "pbcopy" : "if command -v wl-copy >/dev/null 2>&1; then wl-copy; else xclip -selection clipboard; fi";
  return ["sh", ["-c", `printf %s "$1" | { ${tool}; }`, "copy", text]];
}
export function revealCommand(os, path) {
  if (os === "win") return ["explorer.exe", [`/select,${path}`]];
  return os === "mac" ? ["open", ["-R", path]] : ["xdg-open", [path.slice(0, path.lastIndexOf("/")) || "/"]];
}
