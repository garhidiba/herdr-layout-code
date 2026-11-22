// The memo's pure rules: where a space's memo lives, the panel's rect (window coordinates, logical px) as it opens and
// while it is moved or resized, its window's layout, the .gitignore line that keeps the memo out of git, and the
// commands that make a remote space's memo and start its editor on that machine. No Herdr imports, so node tests
// load it.

// Each space's memo, under its folder.
export const MEMO = ".herdr/memo.md";

// The button's size; the panel's default and smallest size.
export const BUTTON = 40;
export const PANEL = { width: 440, height: 340 };
export const MIN = { width: 260, height: 160 };

// A press becomes a drag past this many px (vscode-tabs' drag.js THRESHOLD).
export const dragStarted = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) > 4;

// A Windows path (a remote Windows machine's space: `C:\project\app`, or a UNC share).
const isWindowsPath = (p) => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
// `rel` ("a/b") under `folder`, in the folder's own separators.
export const joinPath = (folder, rel) => (isWindowsPath(folder) ? `${folder}\\${rel.replaceAll("/", "\\")}` : `${folder}/${rel}`);

// A space's memo: { folder, on, path }. The folder is where the space's terminals start (`folder`), else its first
// terminal's (vscode-explorer's cache.js freshRoot, the other way round, so a `cd` doesn't move the memo); null
// without either.
export function memoTarget(space, panes) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map(t => t.id));
  const cwd = panes.find(p => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd;
  const raw = space.folder || cwd || "";
  const folder = raw.replace(isWindowsPath(raw) ? /[\\/]+$/ : /\/+$/, "");
  return folder ? { folder, on: space.machine ?? null, path: joinPath(folder, MEMO) } : null;
}

// A remote space's memo editor runs on its machine (as vscode-explorer's remote.js opens remote files): the editor
// bundle the Explorer installed there (<root>/<version>/, newest first), started straight with its own environment
// rather than through the bundle's launcher, which would write the memo's settings over <root>/vscode-settings.json
// that the machine's other editors read. One round trip (`sh`, else PowerShell for Windows and Git Bash's uname)
// makes .herdr/ and the memo, writes the memo's settings to <root>/vscode-memo-settings.json and prints the version
// folder; exit 3 when the editor isn't installed, 9 when the machine is Windows. Values go in as arguments ("$1")
// or validated single-quoted PowerShell literals, never into script text.
export const MEMO_SETTINGS_FILE = "vscode-memo-settings.json";
export const REMOTE_PREPARE = `set -eu
case $(uname -s) in MINGW*|MSYS*|CYGWIN*|Windows_NT*) exit 9 ;; esac
mkdir -p "$(dirname "$1")"
[ -e "$1" ] || : > "$1"
root=$HOME/.local/share/herdr-vscode
ver=$(ls -1t "$root" 2>/dev/null | grep -E '^[0-9]+[.][0-9]+[.][0-9]+-[0-9a-f]{12}$' | while IFS= read -r v; do if [ -f "$root/$v/manifest.json" ]; then echo "$v"; break; fi; done || true)
[ -n "$ver" ] || { echo "no editor in $root" >&2; exit 3; }
printf '%s' "$2" > "$root/${MEMO_SETTINGS_FILE}.tmp.$$" && mv -f "$root/${MEMO_SETTINGS_FILE}.tmp.$$" "$root/${MEMO_SETTINGS_FILE}"
printf '%s\\n' "$root/$ver"`;
export const NOT_INSTALLED = 3, WINDOWS = 9;

// A PowerShell single-quoted literal, and -EncodedCommand's text (UTF-16LE, base64): vscode-explorer's remote.js
// psQuote and encodeCommand (mods don't import each other).
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
export function encodeCommand(script) {
  const bytes = [];
  for (let i = 0; i < script.length; i++) { const c = script.charCodeAt(i); bytes.push(c & 0xff, c >> 8); }
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3), n = (a << 16) | (b << 8) | c;
    out += abc[n >> 18] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
  }
  return out;
}
const POWERSHELL = ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand"];
const windowsValue = (p) => {
  if (!/^([A-Za-z]:\\|\\\\)[^\x00-\x1f]*$/.test(p)) throw new Error(`not a Windows path: ${p}`);
  return psQuote(p);
};

// REMOTE_PREPARE on Windows (%LOCALAPPDATA%\herdr-vscode), as [program, args]. A settings text too long for a
// command line (32767 characters) is left for the memo's own settings alone.
export function windowsPrepare(path, settings) {
  const script = (text) => `$ErrorActionPreference = 'Stop'
$memo = ${windowsValue(path)}; $settings = ${psQuote(text)}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($memo)) | Out-Null
if (-not [IO.File]::Exists($memo)) { [IO.File]::WriteAllText($memo, '') }
$root = Join-Path $env:LOCALAPPDATA 'herdr-vscode'
$dir = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^[0-9]+[.][0-9]+[.][0-9]+-[0-9a-f]{12}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json')) } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $dir) { [Console]::Error.WriteLine("no editor in $root"); exit ${NOT_INSTALLED} }
[IO.File]::WriteAllText((Join-Path $root '${MEMO_SETTINGS_FILE}'), $settings, (New-Object Text.UTF8Encoding $false))
$dir.FullName`;
  let encoded = encodeCommand(script(settings));
  if (encoded.length > 30000) encoded = encodeCommand(script(memoSettings(null)));
  return [POWERSHELL[0], [...POWERSHELL.slice(1), encoded]];
}

// The version folder REMOTE_PREPARE (either) printed, else null.
export const preparedDir = (stdout) => String(stdout ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? null;

// Appending `text` to the remote file `file` (a .gitignore), as [program, args].
export const appendCommand = (os, file, text) => (os === "windows"
  ? [POWERSHELL[0], [...POWERSHELL.slice(1), encodeCommand(`[IO.File]::AppendAllText(${windowsValue(file)}, ${psQuote(text)})`)]]
  : ["sh", ["-c", 'printf %s "$2" >> "$1"', "sh", file, text]]);

// The argv starting the memo editor of `path` from the bundle's version folder `dir` on a machine of `os`, with the
// keys `keys` (VSEDIT_OS: the computer the keyboard is on). The environment is the bundle launcher's
// (vscode-settings/native/remote-vsedit.sh / .ps1), but with the memo's settings file.
export function remoteEditorArgv(os, dir, path, keys) {
  if (os === "windows") {
    const script = `$dir = ${windowsValue(dir)}; $root = Split-Path -Parent $dir
$env:HERDR_APP_HOME = $root; $env:VSEDIT_SETTINGS = Join-Path $root '${MEMO_SETTINGS_FILE}'
$env:VSEDIT_KEYBINDINGS = Join-Path $root 'vscode-keybindings.json'; $env:VSEDIT_BACKUPS = Join-Path $root 'backups'
$env:VSEDIT_OS = ${psQuote(keys)}
& (Join-Path $dir 'vsedit.exe') --vscode (Join-Path $dir 'vscode') ${windowsValue(path)}
exit $LASTEXITCODE`;
    return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(script)];
  }
  const root = dir.slice(0, dir.lastIndexOf("/"));
  return ["/usr/bin/env", `HERDR_APP_HOME=${root}`, `VSEDIT_SETTINGS=${root}/${MEMO_SETTINGS_FILE}`,
    `VSEDIT_KEYBINDINGS=${root}/vscode-keybindings.json`, `VSEDIT_BACKUPS=${root}/backups`, `VSEDIT_OS=${keys}`,
    `${dir}/vsedit`, "--vscode", `${dir}/vscode`, path];
}

// The keys of the computer the keyboard is on (Herdr's window().platform), for VSEDIT_OS (vscode-explorer's keysOs).
export const keysOs = (platform) => (platform === "macos" ? "mac" : platform === "windows" ? "win" : "linux");

// `r` kept inside the window `win` ({ width, height }), no larger than it; with the window's size unknown, only off
// its top and left edges.
export function clampRect(r, win) {
  if (!win?.width || !win?.height) return { ...r, x: Math.max(0, r.x), y: Math.max(0, r.y) };
  const width = Math.min(r.width, win.width), height = Math.min(r.height, win.height);
  return {
    x: Math.round(Math.min(Math.max(0, r.x), win.width - width)), y: Math.round(Math.min(Math.max(0, r.y), win.height - height)),
    width: Math.round(width), height: Math.round(height),
  };
}

// `r` after the pointer moved by (dx, dy) holding `edge`: "move" (the title bar), or the border's side or
// corner ("n", "se", …). The opposite side stays put; no smaller than `min`.
export function dragRect(r, edge, dx, dy, min = { width: 0, height: 0 }) {
  if (edge === "move") return { ...r, x: r.x + dx, y: r.y + dy };
  let { x, y, width, height } = r;
  if (edge.includes("e")) width = Math.max(min.width, r.width + dx);
  if (edge.includes("s")) height = Math.max(min.height, r.height + dy);
  if (edge.includes("w")) { width = Math.max(min.width, r.width - dx); x = r.x + r.width - width; }
  if (edge.includes("n")) { height = Math.max(min.height, r.height - dy); y = r.y + r.height - height; }
  return { x, y, width, height };
}

// The button's spot is kept as its distance from the window's right and bottom edges, so it stays in its corner as
// the window resizes. First: 16 px in from the right, 16 px above the status bar (layouts/vscode.json: 28 px).
export const DEFAULT_POS = { right: 16, bottom: 28 + 16 };
// The button's rect in window `win` for its spot `pos` ({ right, bottom }; an older { x, y } as is), inside the window.
export function buttonRect(pos, win) {
  const p = pos?.right != null || pos?.x != null ? pos : DEFAULT_POS;
  const x = p.right != null ? win.width - p.right - BUTTON : p.x, y = p.bottom != null ? win.height - p.bottom - BUTTON : p.y;
  return clampRect({ x, y, width: BUTTON, height: BUTTON }, win);
}
// The spot to keep for a button at `r`.
export const buttonPos = (r, win) => ({ right: Math.round(win.width - r.x - r.width), bottom: Math.round(win.height - r.y - r.height) });

const inside =(r, p) => !!r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
// Whether a press at `pos` closes the panel: an unpinned one, pressed outside it and outside the button (which toggles
// it itself). Its title bar and border are inside: moving and resizing never close it.
export const closesOnPress = (pos, { panel, button, pinned }) => !pinned && !!panel && !inside(panel, pos) && !inside(button, pos);

// Where the panel opens: where it was left, else above the button (its bounds) and to its left, its right edge at the
// button's; with neither known, in the middle of the window.
export function panelRect(saved, button, win) {
  const fresh = button ? { x: button.x + button.width - PANEL.width, y: button.y - 8 - PANEL.height }
    : { x: ((win?.width ?? PANEL.width) - PANEL.width) / 2, y: ((win?.height ?? PANEL.height) - PANEL.height) / 2 };
  return clampRect(saved ?? { ...fresh, ...PANEL }, win);
}

// The panel window's layout: the title bar over `body` (the editor's terminal block), framed by grips of `mod` (role
// "grip", props.edge) that resize it: GRIP px edges, and corners CORNER px along both sides; the title bar fills the
// top corners' inside (its own grips), so they take a CORNER px square, and the bottom strip is FOOT px tall.
export const GRIP = 5, CORNER = 16, TITLE = 30, FOOT = 12;
export function panelLayout(mod, body) {
  const grip = (edge, px) => ({ type: "block", ...(px ? { size: { px } } : {}), content: { mod, props: { role: "grip", edge } } });
  const side = (top, edge, bottom) => ({ type: "column", size: { px: GRIP }, children: [grip(top, CORNER), grip(edge), grip(bottom, CORNER)] });
  return { type: "row", children: [
    side("nw", "w", "sw"),
    { type: "column", children: [
      { type: "row", size: { px: GRIP }, children: [grip("nw", CORNER - GRIP), grip("n"), grip("ne", CORNER - GRIP)] },
      { type: "block", size: { px: TITLE }, content: { mod, props: { role: "title" } } },
      body,
      { type: "row", size: { px: FOOT }, children: [grip("sw", CORNER - GRIP), grip("s"), grip("se", CORNER - GRIP)] },
    ] },
    side("ne", "e", "se"),
  ] };
}

// Lines that already ignore the memo when git can't say (no git, not a repo).
const IGNORES = new Set([MEMO, `/${MEMO}`, ".herdr", "/.herdr", ".herdr/", "/.herdr/", ".herdr/*", "/.herdr/*", "**/.herdr/"]);

// What to append to a .gitignore holding `text` so the memo is ignored, or null if it already is. `git`: what
// `git check-ignore` said (true ignored, false not), null when it couldn't tell (then a line match decides).
export function gitignoreAddition(text, git) {
  if (git === true) return null;
  if (git === null && text.split(/\r?\n/).some(l => IGNORES.has(l.trim()))) return null;
  return `${text && !text.endsWith("\n") ? "\n" : ""}${MEMO}\n`;
}

// The memo editor's settings over the user's vscode-settings.json (`text`, comments and trailing commas allowed, as
// vscode-explorer's paths.js settingsOf): the same editor (its engine, keys, look), cut down to a document editor.
// vsedit.sh and both editors read the file VSEDIT_SETTINGS names.
export const MEMO_SETTINGS = {
  "editor.wordWrap": "on",
  "files.autoSave": "afterDelay", "files.autoSaveDelay": 0.5,
  "breadcrumbs.enabled": false, "editor.hover.enabled": false, "editor.codeLens": false,
  "extensions.ignoreRecommendations": true, "editor.inlineSuggest.provider": "off",
  "workbench.statusBar.visible": false,
};
export function memoSettings(text) {
  let user = {};
  try {
    user = JSON.parse(String(text ?? "").replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1")) ?? {};
  } catch {}
  return `${JSON.stringify({ ...user, ...MEMO_SETTINGS }, null, 2)}\n`;
}
