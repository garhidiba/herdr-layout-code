// A lazy file explorer for the focused pane's folder, with Material Icon Theme icons.
// Click a file to edit it in a new terminal tab (vsedit, on the remote machine for a remote space once installed
// there); images open in the vscode-viewer mod tab. Cmd+click opens it in VS Code. Right-click opens a VS Code-style menu
// (menu.js), which runs as an overlay of this same mod. The active editor's file is revealed and highlighted in the tree
// (VS Code's explorer.autoReveal).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, terminals, exec, hc, readTextFile, watchFolder, theme, window, appHome, props, shared, setShared, notify, nextCommand, openOverlay, run, layout } from "herdr";
import { freshRoot, encode, decode } from "./cache.js";
import { ExplorerMenu, ExplorerDialog, TabMenu, openMenu, openInCode, explorerAction, refreshKey, openFile, splitOpen, remote, warm, REVEAL, terminalRows, IMAGE_OPEN } from "./menu.js";
import { OPEN_AT } from "./split.js";
import { WARM } from "./warm.js";
import { createCore } from "./core.js";
import { editorFileOf, autoRevealOf, revealPath, within, isImage, DETAILS } from "./paths.js";
import { treeAction, step } from "./keys.js";
import { keysOs } from "./remote.js";
import { ROW, clampTop, rowAt, shown, scrollToShow, dragStarted, dropFolder, dragTarget, targetRange } from "./dnd.js";
import { createDesktop } from "./desktop.js";
import { createDetails } from "./details.js";
import { createOps } from "./ops.js";
// The Image Viewer column's resize zone reaches over this card's right edge (vscode-viewer image.js SASH: one sash of
// its strip, the layout's gap and this edge): a press here starts its resize overlay (a double-click gives it back its
// layout width, 420), a hover lights its line. Only while that column shows, right of this panel.
const IMAGE_SASH = "vscode-viewer.image-sash";
const findNode = (n, id) => n?.id === id ? n : (n?.children ?? []).map(c => findNode(c, id)).find(Boolean) ?? null;
function imageSash(el) {
  const column = findNode(layout(), "image-panel");
  if (!column || column.hidden) return el;
  return el.child(div().id("image-sash").absolute().top(0).bottom(0).right(0).w(4).cursor_col_resize()
    .on_hover((on) => setShared(IMAGE_SASH, on))
    .on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      if (e.click_count === 2) return run("layout.resize", { id: "image-panel", px: 420 });
      openOverlay({ mod: "vscode-viewer", kind: "window", frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1, props: { imageResize: { x: e.position.x } } });
    }));
}
// vscode-tabs' drag.js DRAG_BACK: its drag overlay hands a file drag back to the tree.
const DRAG_BACK = "vscode-tabs.drag-back";
// Herdr starts with PATH=/usr/bin:/bin, so Homebrew/user tools (node, code, codex, trash) are looked up here too.
const userExec = (cmd, args, opts) => exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; exec "$0" "$@"', cmd, ...args], opts);

// The project you work in: the focused terminal's folder. Editor and diff tabs have no folder, so focusing
// them keeps this space's last project instead of reloading; a fresh space starts at its first terminal's folder.
const lastRoot = {};
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = f?.pane === null ? f?.cwd : pane?.terminal ? pane.cwd : null;
  if (cwd) return (lastRoot[space?.id] = { cwd, on, space: space?.id });
  return lastRoot[space?.id] ?? freshRoot(space, panes());
}
const key = () => JSON.stringify(location());
// Remote editors' inline suggestions through this desktop (desktop.js).
const desktop = createDesktop({ hc, exec, appHome, notify });
// Remote editors' argv and labels for terminalRows() (details.js), shared so vscode-tabs reads them too.
const details = createDetails({ hc, publish: (d) => setShared(DETAILS, d) });
const PER_FOLDER = 500, TOTAL = 5000;

// The file the focused tab shows, { file, on }: an editor terminal's (its argv or label), or a viewer tab's (it shares its file
// when focused). null for any other tab; undefined while the focused terminal isn't listed yet.
const VIEWER_FOCUS = "vscode-viewer.focused"; // vscode-viewer's
function activeFile(f, viewer) {
  if (f?.terminal) {
    const term = terminalRows().find(t => t.address === f.terminal);
    if (!term) return undefined;
    const file = editorFileOf(term.argv, term.labels);
    return file && { file, on: f.terminal.includes("/") ? f.terminal.split("/")[0] : null };
  }
  return f?.pane && viewer?.pane === f.pane && viewer.file ? { file: viewer.file, on: viewer.on ?? null } : null;
}
// Other spaces' trees load in the background: 3s after start, 2 at a time, again every 10 minutes
// (and when a space appears), skipping ones loaded in the last 2 minutes.
const CACHE = "vscode-explorer.cache", FRESH = 120000, PRELOAD_EVERY = 600000, SAVE_EVERY = 60000, REMOTE_POLL = 3000;

// VS Code's git decoration colors and how severe each state is (a folder shows its worst child).
const GIT_COLOR = { M: "#e2c08d", A: "#73c991", U: "#73c991", D: "#c74e39", "!": "#e4676b" };
const GIT_RANK = { U: 1, A: 1, M: 2, D: 3, "!": 4 };
const gitLetter = (xy) => xy === "??" ? "U" : /U|AA|DD/.test(xy) ? "!" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";

// Every folder above a changed file takes the worst state below it, like VS Code's colored folders and dots.
function dirtyOf(marks) {
  const dirty = new Map();
  // A deleted file colors itself only; VS Code doesn't pass deletions up to the folders.
  for (const [file, letter] of Object.entries(marks).filter(([, l]) => l !== "D")) for (let i = file.lastIndexOf("/"); i > 0; i = file.lastIndexOf("/", i - 1)) {
    const folder = file.slice(0, i);
    if ((GIT_RANK[dirty.get(folder)] ?? 0) < GIT_RANK[letter]) dirty.set(folder, letter);
  }
  return dirty;
}

// Git repos below the folder (up to 3 levels), each with its own status: for a folder that holds many projects.
// Prints "@@<repo>" then that repo's `status -z`. Untracked folders are collapsed to one entry.
const NESTED_STATUS = 'find "$1" -maxdepth 3 -name .git -prune 2>/dev/null | head -200 | while IFS= read -r g; do r=${g%/.git}; printf "@@%s\\n" "$r"; git --no-optional-locks -c core.fsmonitor=false -C "$r" status --porcelain=v1 -z --no-renames --untracked-files=normal 2>/dev/null; printf "\\n"; done';

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// The git state of a folder: its own repo's status plus the repos nested below it, path → letter.
async function gitMarks(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  const marks = {};
  if (top?.code === 0) {
    // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
    const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
    if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
      marks[`${top.stdout.trim()}/${entry.slice(3)}`] = gitLetter(entry.slice(0, 2));
    }
  }
  // Projects below this folder that are repos of their own.
  const nested = await exec("sh", ["-c", NESTED_STATUS, "explorer", cwd], { on }).catch(() => null);
  if (nested?.code === 0) for (const part of nested.stdout.split("@@").slice(1)) {
    const nl = part.indexOf("\n"), repo = part.slice(0, nl);
    for (const entry of part.slice(nl + 1).split("\0").filter(Boolean).slice(0, TOTAL)) {
      if (entry.length > 3) marks[`${repo}/${entry.slice(3).replace(/\/$/, "").replace(/\n$/, "")}`] ??= gitLetter(entry.slice(0, 2));
    }
  }
  return marks;
}

// With "core.engine": "rust", the folder listings and git marks come from one `vscode-core tree` call; null means
// the JS path (directory() per folder, then gitMarks()). `--expanded` splits on commas, so such a folder takes JS.
const core = createCore({ exec, readTextFile, notify, appHome, shared, setShared });
const coreTree = (cwd, on, folders) => [...folders].some(f => f.includes(",")) ? null
  : core(["tree", cwd, ...(folders.size ? ["--expanded", [...folders].join(",")] : [])], on);

export default class Files extends View {
  init(_props, cx) {
    const p = props();
    if (p?.menu) { this.overlay = new ExplorerMenu(cx); return; }
    if (p?.dialog) { this.overlay = new ExplorerDialog(cx); return; }
    if (p?.tabMenu) { this.overlay = new TabMenu(cx); return; }
    // Every project's last tree from before the restart, so each space shows at once and refreshes behind it.
    let cache = null;
    try { cache = localStorage.getItem(CACHE); } catch {}
    const restored = decode(cache);
    this.saved = restored.saved;
    for (const s of this.saved.values()) s.dirty = dirtyOf(s.marks);
    Object.assign(lastRoot, restored.lastRoot);
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.dirty = new Map();
    this.icons = null;
    // The tree scrolls itself (dnd.js): `top` pixels scrolled, `height` the viewport's. The handle takes the keyboard
    // while a row is dragged, for Escape.
    this.top = 0; this.height = 0;
    this.handle = cx.focus_handle();
    cx.spawn(async cx => {
      try { this.icons = JSON.parse(await readTextFile(`${appHome()}/mods/vscode-explorer/icons.json`)); } catch {}
      cx.notify();
    });
    // The confirm dialog's yes for installing the editor on a remote machine (menu.js askInstall).
    cx.spawn(async () => { for (;;) if (await nextCommand() === "install-remote") remote.installRequested(); });
    this.refresh(cx);
    // The warm editors (warm.js) are this tree's: ones listed from before (a restart, a reload) are forgotten, and
    // the first pass ends their editors. Every 10s a pass reads workbench.editor.preloadEditor; render() runs one when due.
    setShared(WARM, {});
    setShared(DETAILS, {}); // shared values persist: ones from before name terminals that may be gone
    this.warmFill(cx, 0);
    cx.timer.every(10000, cx => {
      cx.spawn(() => desktop.sync(terminals(), panes()));
      this.warmFill(cx, 0);
      this.refresh(cx);
      if (this.known && spaces().some(s => !this.known.has(s.id))) this.preloadAll(cx);
    });
    // Remote folders can't be watched (watchFolder is local), so a remote tree polls in its place.
    cx.timer.every(REMOTE_POLL, cx => { if (this.on) this.refresh(cx); });
    cx.timer.after(3000, cx => this.preloadAll(cx));
    cx.timer.every(PRELOAD_EVERY, cx => this.preloadAll(cx));
  }

  // One warm editor pass (warm.js fill) after `delay` ms; never two at once.
  warmFill(cx, delay) {
    if (this.warming) return;
    this.warming = true;
    cx.spawn(async cx => {
      try { if (delay) await cx.sleep(delay); await warm.fill(cx); } finally { this.warming = false; }
    });
  }

  // Saves the trees 2s after a change, at most once a minute.
  changed(cx) {
    if (this.saving) return;
    this.saving = true;
    cx.timer.after(Math.max(2000, (this.savedAt ?? 0) + SAVE_EVERY - Date.now()), () => {
      this.saving = false; this.savedAt = Date.now();
      try { localStorage.setItem(CACHE, encode(this.saved, lastRoot)); } catch {}
    });
  }

  // Loads every other local space's tree and git state into `saved`, as refresh() would show it there.
  // Spaces sharing a folder load it once. The shown tree is never touched.
  preloadAll(cx) {
    if (this.preloading) return;
    const all = spaces(), list = panes(), now = Date.now(), roots = new Map();
    this.known = new Set(all.map(s => s.id));
    for (const space of all) {
      if (space.machine) continue;
      // Pinned, so switching there with an editor tab focused gives this same key.
      const loc = (lastRoot[space.id] ??= freshRoot(space, list)), k = JSON.stringify(loc);
      if (!loc.cwd || k === this.context?.key || now - (this.saved.get(k)?.at ?? 0) < FRESH) continue;
      const root = JSON.stringify([loc.cwd, loc.on]);
      roots.set(root, [...(roots.get(root) ?? []), k]);
    }
    const jobs = [...roots.values()];
    if (!jobs.length) return;
    this.preloading = true;
    cx.spawn(async cx => {
      const worker = async () => {
        for (let keys; (keys = jobs.shift());) { await this.preload(keys).catch(() => {}); this.changed(cx); }
      };
      try { await Promise.all([worker(), worker()]); } finally { this.preloading = false; }
    });
  }

  async preload(keys) {
    const { cwd, on } = JSON.parse(keys[0]), context = { key: keys[0], cwd, on };
    const tree = { entries: new Map(), folders: new Set(keys.flatMap(k => [...this.saved.get(k)?.folders ?? []])), limited: false };
    const fast = await coreTree(cwd, on, tree.folders);
    if (fast) tree.entries = new Map(Object.entries(fast.entries));
    else for (const path of ["", ...tree.folders]) {
      await this.loadFolder(path, context, tree).catch(e => { if (!path) throw e; tree.folders.delete(path); });
    }
    const marks = fast?.marks ?? await gitMarks(cwd, on), dirty = dirtyOf(marks), at = Date.now();
    for (const k of keys) if (k !== this.context?.key) {
      this.saved.set(k, { folders: new Set(this.saved.get(k)?.folders), entries: tree.entries, marks, dirty, at });
    }
  }

  // Material Icon Theme: exact file name, then the longest matching extension, then the default.
  icon(name, dir, open) {
    const m = this.icons;
    if (!m) return null;
    const n = name.toLowerCase();
    if (dir) return open ? m.foldersOpen[n] ?? m.folderOpen : m.folders[n] ?? m.folder;
    if (m.names[n]) return m.names[n];
    const parts = n.split(".");
    for (let i = 1; i < parts.length; i++) { const e = m.ext[parts.slice(i).join(".")]; if (e) return e; }
    return m.file;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  // `tree` is the shown one (this) or a background preload's { entries, folders, limited }.
  async loadFolder(path, context, tree = this) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if ((tree === this && !this.current(context)) || (path && !tree.folders.has(path))) return;
    const used = [...tree.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    tree.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) tree.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      // Keep each project's last tree and git state, so coming back shows it at once and only refreshes behind it.
      if (this.context) this.saved.set(this.context.key, { ...this.saved.get(this.context.key), folders: this.folders, entries: this.entries, marks: this.marks, dirty: this.dirty });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(saved?.entries); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = saved?.marks ?? {}; this.dirty = new Map(saved?.dirty); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.again = false; this.active = null; this.selected = null; this.revealing = null;
    }
    if (!cwd) return;
    // A file operation's refresh during a load runs once that load ends: the load may have listed the folder before the
    // change, and a row left for a deleted file would offer to delete it again.
    if (this.loading) { this.again = true; return; }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        const fast = await coreTree(cwd, on, this.folders);
        if (fast && !this.current(context)) return;
        if (fast) {
          for (const [path, list] of Object.entries(fast.entries)) if (!path || this.folders.has(path)) this.entries.set(path, list);
          this.limited = fast.limited;
        } else for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          // An open folder that is gone (deleted, moved) closes, as preload() drops it.
          await this.loadFolder(path, context).catch(e => { if (!path) throw e; this.forget(path); });
        }
        const marks = fast?.marks ?? await gitMarks(cwd, on);
        if (!this.current(context)) return;
        this.marks = marks; this.dirty = dirtyOf(marks); this.error = null; this.watch(cwd, cx);
        this.saved.set(context.key, { folders: this.folders, entries: this.entries, marks, dirty: this.dirty, at: Date.now() });
        this.changed(cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) { this.loading = false; if (this.again) { this.again = false; this.refresh(cx); } }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) this.forget(path);
    else this.expand(path, cx);
    cx.notify();
  }

  // Closes the folder at `path` and every folder below it (collapsed, or moved away).
  forget(path) {
    for (const folder of [...this.folders]) if (within(folder, path)) {
      this.folders.delete(folder);
      this.entries.delete(folder);
    }
  }

  // Opens a folder, listing it unless it is listed or being listed.
  expand(path, cx) {
    this.folders.add(path);
    if (this.entries.has(path) || this.pending.has(path)) return;
    const context = this.context;
    this.pending.add(path);
    cx.spawn(async cx => {
      try { await this.loadFolder(path, context); }
      catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
    });
  }

  // Once per focused tab (and tree): an editor's file below the root gets its folders opened, its row highlighted and
  // scrolled to (render() does that once the row is listed). Any other tab or file keeps the last highlight, as VS
  // Code does. The setting is read then, so turning it off in Settings applies from the next tab.
  autoReveal(cx) {
    const f = focused(), viewer = shared(VIEWER_FOCUS);
    const sig = JSON.stringify([this.context?.key, f?.terminal, f?.pane, viewer]);
    if (sig === this.revealSig || !this.root) return;
    const active = activeFile(f, viewer);
    if (active === undefined) return;
    this.revealSig = sig;
    if (!active || active.on !== this.on) return;
    const context = this.context;
    cx.spawn(async cx => {
      const on = autoRevealOf(await readTextFile(`${appHome()}/vscode-settings.json`).catch(() => null));
      if (this.context !== context || this.revealSig !== sig) return;
      if (on) this.reveal(active.file, cx);
      else if (this.active !== this.askedRow) this.active = null; // a Reveal in Explorer View's row stays, as VS Code's selection
      cx.notify();
    });
  }

  // The tab menu's Reveal in Explorer View (menu.js REVEAL), whatever explorer.autoReveal says: once, when the tree shows
  // the file's machine and folder (the menu shows its tab first, so the tree may switch to it a draw later). A request
  // older than 5s is dropped: shared values outlive a restart.
  revealAsked(cx) {
    const ask = shared(REVEAL);
    if (!ask || ask.at === this.revealedAt || Date.now() - ask.at > 5000 || (ask.on ?? null) !== this.on) return;
    if (this.reveal(ask.file, cx)) { this.revealedAt = ask.at; this.askedRow = this.active; }
  }

  // A file dropped on a pane (split.js): once each, dropped after 5s (shared values outlive a restart).
  openAtAsked(cx) {
    const ask = shared(OPEN_AT);
    if (!ask?.file || ask.at === this.openedAt || Date.now() - ask.at > 5000) return;
    this.openedAt = ask.at;
    cx.spawn(cx => splitOpen(ask, cx));
  }

  // Opens the folders above `file`, highlights its row and scrolls to it once listed (scrollToRevealed); false for a
  // file outside the tree.
  reveal(file, cx) {
    const target = revealPath(this.root, file);
    if (!target) return false;
    this.active = target.path; this.revealing = target;
    for (const folder of target.folders) this.expand(folder, cx);
    return true;
  }

  // Scrolls to the revealed row once it is listed (nothing moves when it is on screen already); gives up when its
  // folders are listed without it.
  // A reveal waits for the viewport's size, and for a reload under way (a copy shows up only once its folder is relisted).
  scrollToRevealed(rows) {
    const target = this.revealing;
    if (!target || !this.height) return;
    const i = rows.findIndex(r => r.path === target.path);
    if (i >= 0) this.top = scrollToShow(this.top, i, this.height);
    if (i >= 0 || (!this.loading && target.folders.every(f => !this.pending.has(f)))) this.revealing = null;
  }

  open(path, cx, place = "tab") {
    // The editor tab is a terminal: started in the Explorer's root, so focusing it keeps the tree where it is.
    const [file, on, folder] = [`${this.root}/${path}`, this.on, this.root];
    cx.spawn(cx => openFile(file, { on, folder, place }, cx));
  }

  menu(abs, dir, cx) {
    cx.stop_propagation();
    if (this.root) openMenu({ path: abs, root: this.root, dir, on: this.on });
  }

  // The shown rows as data (render() draws the ones on screen). `inherited` is "U" below an untracked folder:
  // git lists the folder once, its files are untracked too.
  rows(prefix, depth, out, inherited = null) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, abs = `${this.root}/${path}`, open = this.folders.has(path), own = this.marks[abs];
      const status = own ?? (entry.dir ? this.dirty.get(abs) : null) ?? inherited;
      out.push({ path, abs, depth, open, status, name: entry.name, dir: entry.dir });
      if (entry.dir && open) this.rows(path, depth + 1, out, own === "U" ? "U" : inherited);
    }
    return out;
  }

  // The active editor's file takes the selection color (VS Code's list.inactiveSelectionBackground); the folder a drag
  // would land in, and the rows below it, the hover color. The selected row takes `selection` while the tree holds the
  // keyboard (list.activeSelectionBackground), else `selected` as the active file.
  row(r, t, target, focused) {
    const color = GIT_COLOR[r.status], icon = this.icon(r.name, r.dir, r.open), picked = r.path === this.selected;
    const active = r.path === this.active || picked, fill = picked && focused ? t.selection : t.selected;
    return h_flex().w_full().h(ROW).flex_none().pl(6 + r.depth * 12).pr(16).gap(5).items_center().rounded(4).cursor_pointer()
      .when(active, el => el.bg(fill)).when(!active && target, el => el.bg(t.hover)).when(!active, el => el.hover(s => s.bg(t.hover)))
      .child(r.dir ? svg(`mods/vscode-explorer/chevron-${r.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(icon ? image(`mods/vscode-explorer/icons/${icon}.svg`).w(16).h(16).flex_none() : div().w(16).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(color ?? t.foreground).child(r.name))
      .when(Boolean(r.status), el => el.child(r.dir ? div().size(6).rounded(3).bg(color).flex_none() : div().text_size(11).text_color(color).child(r.status)));
  }

  // A press on the rows: on a row it may become a drag (pointerMove), otherwise its release is a click (release).
  press(e, rows) {
    if (!e.local_position) return;
    this.platform = Boolean(e.modifiers?.platform); // Cmd+click opens in VS Code
    const i = rowAt(this.top, e.local_position.y, rows.length);
    this.pressed = { i, row: rows[i], from: e.local_position, at: e.local_position, dragging: false, folder: null };
  }

  pointerMove(e, rows, cx) {
    this.hoverY = e.local_position.y; // where a drop from Finder lands (render's on_drop)
    this.rowsBounds = e.bounds; // where a drag handed to the overlay (dragOut) comes back
    // Back from the overlay: the drag goes on here; any other end of it there (a drop, Escape) ends it here too.
    if (this.pressed?.out) { if (shared(DRAG_BACK) !== this.pressed.out) return this.cancelDrag(cx); this.pressed.out = null; }
    if (this.thumb) {
      const top = clampTop(this.thumb.top + (e.position.y - this.thumb.y) * this.thumb.ratio, rows.length, this.height);
      if (top !== this.top) { this.top = top; cx.notify(); }
      return;
    }
    const p = this.pressed;
    if (!p?.row || (!p.dragging && !dragStarted(p.from, e.local_position))) return;
    if (!p.dragging) { p.dragging = true; this.handle.focus(); }
    p.at = e.local_position;
    p.folder = dragTarget(p.row, rows, rowAt(this.top, p.at.y, rows.length));
    cx.notify();
  }

  // A drag let go on a folder moves the row there (with Alt/Option, copies it); a press let go on the row it began on
  // is a click.
  release(e, rows, cx) {
    const p = this.pressed;
    this.pressed = null; this.thumb = null;
    if (!p || p.out || !e.local_position) return cx.notify();
    const i = rowAt(this.top, e.local_position.y, rows.length);
    if (!p.dragging) return i >= 0 && i === p.i ? this.click(rows[i], cx) : undefined;
    const folder = dragTarget(p.row, rows, i), r = p.row;
    if (folder !== null) this.place(folder, e.modifiers?.alt
      ? (ops, dir) => ops.paste({ path: r.abs, dir: r.dir, cut: false, on: this.on }, dir)
      : async (ops, dir) => { const to = await ops.moveInto(r.abs, dir); if (to && r.dir) this.forget(r.path); return to; }, cx);
    cx.notify();
  }

  // A file dragged out of the tree toward the panes: vscode-tabs' drag overlay takes it over (its drag.js props), a drop
  // on a pane asks OPEN_AT (split.js), the pointer back over the rows hands it back here (DRAG_BACK); an image may also
  // drop on the panel's Image Viewer button (`image`: IMAGE_OPEN). Folders don't leave the tree: that cancels, as before.
  dragOut(cx) {
    const p = this.pressed, into = spaces().find(s => s.active)?.tabs.find(t => t.active)?.id;
    if (!p?.dragging || p.row.dir || !this.root || !into || !this.rowsBounds) return this.cancelDrag(cx);
    p.out = Date.now(); p.folder = null;
    openOverlay({ mod: "vscode-tabs", kind: "window", frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1, props: { drag: {
      source: { file: p.row.abs, on: this.on, folder: this.root }, request: OPEN_AT, into, title: p.row.name, back: this.rowsBounds, id: p.out,
      ...(isImage(p.row.abs) ? { image: IMAGE_OPEN } : {}) } } });
    cx.notify();
  }

  // Ends a drag (or a scrollbar drag) without doing anything: Escape, or the pointer leaving the tree.
  cancelDrag(cx) {
    if (!this.pressed && !this.thumb) return;
    this.pressed = null; this.thumb = null;
    cx.notify();
  }

  // Runs a drop's or a drag's file operation into `folder` (below the root, "" for it), then shows the result: its
  // folder opened, the first new entry selected and scrolled to. A failure is a toast.
  place(folder, job, cx) {
    const context = this.context, dir = folder ? `${this.root}/${folder}` : this.root;
    cx.spawn(async cx => {
      try {
        const to = [].concat(await job(createOps(exec, this.on, hc), dir)).find(Boolean);
        if (this.context !== context) return;
        if (to) this.reveal(to, cx);
        this.refresh(cx);
      } catch (err) { notify({ title: "Explorer", body: String(err?.message ?? err), level: "error" }); }
      cx.notify();
    });
  }

  // A drop onto a remote tree uploads (ops.js drop), which can take a while: said when it starts and when it is done.
  async upload(ops, paths, dir) {
    const n = paths.length === 1 ? paths[0].split("/").pop() : `${paths.length} items`, on = this.on;
    notify({ title: "Explorer", body: `Uploading ${n} to ${on}…`, level: "info" });
    const copies = await ops.drop(paths, dir);
    notify({ title: "Explorer", body: `Uploaded ${n} to ${on}.`, level: "success" });
    return copies;
  }

  // A key while the tree holds the keyboard (keys.js): arrows move the selection, the rest are the right-click menu's
  // items on the selected row (paste with nothing selected goes into the root). False for a key the tree doesn't use.
  treeKey(e, rows, cx) {
    const action = treeAction(e, keysOs(window()?.platform));
    if (!action) return false;
    const i = rows.findIndex(r => r.path === this.selected), r = rows[i];
    if (["up", "down", "left", "right"].includes(action)) {
      const to = step(rows, this.selected, action);
      if (to?.toggle) this.toggle(to.toggle, cx);
      if (to?.select) {
        this.selected = to.select;
        this.top = scrollToShow(this.top, rows.findIndex(x => x.path === to.select), this.height);
        cx.notify();
      }
    } else if (action === "open") { this.platform = false; if (r) this.click(r, cx); } // not a Cmd+click
    else if (action === "openSide") { if (r && !r.dir) { this.active = r.path; this.open(r.path, cx, "right"); } } // Open to the Side
    else if (r || action === "paste") {
      explorerAction(action, { path: r?.abs ?? this.root, root: this.root, dir: r ? r.dir : true, on: this.on });
      cx.notify();
    }
    return true;
  }

  // A click selects the row and gives the tree the keyboard (treeKey), as VS Code's.
  click(r, cx) {
    if (!r) return;
    this.selected = r.path;
    this.handle.focus();
    if (r.dir) return this.toggle(r.path, cx);
    if (this.platform && !this.on) userExec("code", [r.abs]).catch(() => {});
    else if (this.platform) openInCode(r.abs, this.on).catch(err => notify({ title: "Explorer", body: String(err?.message ?? err), level: "error" }));
    else {
      // Selected at once, as VS Code does, rather than once the editor tab shows and autoReveal() marks it.
      this.active = r.path;
      cx.notify();
      this.open(r.path, cx);
    }
  }

  render(cx) {
    if (this.overlay) return this.overlay.render(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    // A file operation from the menu asks for a reload.
    const asked = shared(refreshKey);
    if (asked !== this.asked) { if (this.asked !== undefined) this.refresh(cx); this.asked = asked; }
    details(terminals(), panes());
    this.autoReveal(cx);
    this.revealAsked(cx);
    this.openAtAsked(cx);
    // an editor focused in this active window: this desktop answers its machine's suggestions (desktop.js)
    const editorOn = window()?.active ? activeFile(focused(), null)?.on ?? null : null;
    if (editorOn !== this.editorOn) { this.editorOn = editorOn; cx.spawn(() => desktop.mark(editorOn)); }
    const due = warm.due(); // a space without its warm editor (one was just used), or one to end
    if (due !== null) this.warmFill(cx, due);
    const t = theme(), rows = this.rows("", 0, []), count = rows.length;
    this.scrollToRevealed(rows);
    const height = this.height, top = (this.top = clampTop(this.top, count, height)), over = count * ROW - height;
    // Only the rows on screen are drawn (a tall screenful until the viewport's size is known), each at its scrolled y.
    const [first, end] = shown(top, height || 1600, count);
    const drag = this.pressed?.dragging && !this.pressed.out ? this.pressed : null, keyboard = this.handle.is_focused();
    // A drag from Finder isn't lit: Herdr tells it from a hover over an inactive window only by guesswork, and a wrong
    // guess lit the tree on plain hovers.
    const target = drag?.folder ?? null;
    const [hiFrom, hiTo] = target ? targetRange(rows, target) : [0, 0];
    const thumb = Math.max(24, height * height / (count * ROW || 1));
    return imageSash(v_flex().id("explorer").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Explorer"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("explorer-tree").flex_1().min_h(0).p(4).track_focus(this.handle)
        .on_key_down((e, cx) => {
          if (e.key === "escape" && this.pressed) { cx.stop_propagation(); this.cancelDrag(cx); }
          else if (this.treeKey(e, rows, cx)) cx.stop_propagation();
        })
        // A press elsewhere takes the keyboard away: the selection is drawn unfocused then.
        .on_mouse_down_out((_e, cx) => cx.notify())
        .on_mouse_down("right", (_e, cx) => this.menu(this.root, true, cx))
        // Files dropped from Finder are copied into the folder under the pointer (dnd.js dropFolder; ops.js drop): the
        // drop names no position, so the last one the pointer reported over the rows says where; elsewhere the root.
        .on_drop((e, cx) => {
          const i = this.hoverY == null ? -1 : rowAt(this.top, this.hoverY, count);
          if (this.root && e.paths?.length) this.place(dropFolder(rows, i), (ops, dir) => this.on ? this.upload(ops, e.paths, dir) : ops.drop(e.paths, dir), cx);
        })
        .when(count > 0, el => el.child(div().id("explorer-rows").flex_1().min_h(0).relative().overflow_hidden()
          .when(target === "", el => el.bg(t.hover))
          .on_size_change((s, cx) => { if (s.height !== this.height) { this.height = s.height; cx.notify(); } })
          .on_scroll_wheel((e, cx) => {
            const next = clampTop(this.top - (e.delta_lines ? e.delta_lines.y * ROW : e.delta.y), count, this.height);
            if (next !== this.top) { this.top = next; cx.notify(); }
          })
          .on_mouse_down("left", e => this.press(e, rows))
          .on_mouse_down("right", (e, cx) => {
            const r = e.local_position ? rows[rowAt(this.top, e.local_position.y, count)] : null;
            if (r) this.menu(r.abs, r.dir, cx);
          })
          .on_mouse_move((e, cx) => this.pointerMove(e, rows, cx))
          .on_mouse_up("left", (e, cx) => this.release(e, rows, cx))
          .on_hover((on, cx) => {
            if (on || this.pressed?.out) return;
            this.hoverY = null;
            if (this.pressed?.dragging) this.dragOut(cx); else this.cancelDrag(cx);
            cx.notify();
          })
          .children(rows.slice(first, end).map((r, k) => this.row(r, t, first + k >= hiFrom && first + k < hiTo, keyboard).absolute().left(0).top((first + k) * ROW - top)))
          .when(over > 0 && height > 0, el => el.child(div().absolute().right(1).top((height - thumb) * top / over).w(6).h(thumb).rounded(3).bg(t.dim).opacity(0.45)
            .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.thumb = { y: e.position.y, top: this.top, ratio: over / (height - thumb) }; })))
          // What is dragged, by the pointer: its icon and name.
          .when(Boolean(drag), el => {
            const icon = this.icon(drag.row.name, drag.row.dir, false);
            return el.child(h_flex().absolute().left(drag.at.x + 14).top(drag.at.y + 6).h(ROW).px(8).gap(5).items_center().rounded(4)
              .bg(t.popover).border_1().border_color(t.border).text_size(12)
              .child(icon ? image(`mods/vscode-explorer/icons/${icon}.svg`).w(16).h(16).flex_none() : div())
              .child(drag.row.name));
          })))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))));
  }
}
