// A lazy file explorer for the focused pane's folder, with Material Icon Theme icons.
// Click a file to edit it in a new terminal tab (vsedit, on the remote machine for a remote space once installed
// there); images open in the vscode-viewer mod tab. Cmd+click opens it in VS Code. Right-click opens a VS Code-style menu
// (menu.js), which runs as an overlay of this same mod.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, window, appHome, props, shared, setShared, notify, nextCommand } from "herdr";
import { freshRoot, encode, decode } from "./cache.js";
import { ExplorerMenu, ExplorerDialog, openMenu, openInCode, refreshKey, openFile, remote } from "./menu.js";
import { createCore } from "./core.js";
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
const PER_FOLDER = 500, TOTAL = 5000;
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
    // Every project's last tree from before the restart, so each space shows at once and refreshes behind it.
    let cache = null;
    try { cache = localStorage.getItem(CACHE); } catch {}
    const restored = decode(cache);
    this.saved = restored.saved;
    for (const s of this.saved.values()) s.dirty = dirtyOf(s.marks);
    Object.assign(lastRoot, restored.lastRoot);
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.dirty = new Map();
    this.icons = null;
    cx.spawn(async cx => {
      try { this.icons = JSON.parse(await readTextFile(`${appHome()}/mods/vscode-explorer/icons.json`)); } catch {}
      cx.notify();
    });
    // The confirm dialog's yes for installing the editor on a remote machine (menu.js askInstall).
    cx.spawn(async () => { for (;;) if (await nextCommand() === "install-remote") remote.installRequested(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => {
      this.refresh(cx);
      if (this.known && spaces().some(s => !this.known.has(s.id))) this.preloadAll(cx);
    });
    // Remote folders can't be watched (watchFolder is local), so a remote tree polls in its place.
    cx.timer.every(REMOTE_POLL, cx => { if (this.on) this.refresh(cx); });
    cx.timer.after(3000, cx => this.preloadAll(cx));
    cx.timer.every(PRELOAD_EVERY, cx => this.preloadAll(cx));
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
      this.loading = false;
    }
    if (!cwd || this.loading) return;
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
          await this.loadFolder(path, context);
        }
        const marks = fast?.marks ?? await gitMarks(cwd, on);
        if (!this.current(context)) return;
        this.marks = marks; this.dirty = dirtyOf(marks); this.error = null; this.watch(cwd, cx);
        this.saved.set(context.key, { folders: this.folders, entries: this.entries, marks, dirty: this.dirty, at: Date.now() });
        this.changed(cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  open(path, cx) {
    // The editor tab is a terminal: started in the Explorer's root, so focusing it keeps the tree where it is.
    const [file, on, folder] = [`${this.root}/${path}`, this.on, this.root];
    cx.spawn(cx => openFile(file, { on, folder }, cx));
  }

  menu(abs, dir, cx) {
    cx.stop_propagation();
    if (this.root) openMenu({ path: abs, root: this.root, dir, on: this.on });
  }

  // `inherited` is "U" below an untracked folder: git lists the folder once, its files are untracked too.
  rows(prefix, depth, out, t, inherited = null) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, abs = `${this.root}/${path}`, open = this.folders.has(path), own = this.marks[abs];
      const status = own ?? (entry.dir ? this.dirty.get(abs) : null) ?? inherited, color = GIT_COLOR[status], icon = this.icon(entry.name, entry.dir, open);
      out.push(h_flex().id(`file-${path}`).h(22).flex_none().pl(6 + depth * 12).pr(8).gap(5).items_center().rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
        .on_mouse_down("right", (_e, cx) => this.menu(abs, entry.dir, cx))
        .on_click((e, cx) => {
          if (entry.dir) return this.toggle(path, cx);
          if (e.modifiers.platform && !this.on) userExec("code", [abs]).catch(() => {});
          else if (e.modifiers.platform) openInCode(abs, this.on).catch(err => notify({ title: "Explorer", body: String(err?.message ?? err), level: "error" }));
          else this.open(path, cx);
        })
        .child(entry.dir ? svg(`mods/vscode-explorer/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(icon ? image(`mods/vscode-explorer/icons/${icon}.svg`).w(16).h(16).flex_none() : div().w(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(color ?? t.foreground).child(entry.name))
        .when(Boolean(status), el => el.child(entry.dir ? div().size(6).rounded(3).bg(color).flex_none() : div().text_size(11).text_color(color).child(status))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, own === "U" ? "U" : inherited);
    }
    return out;
  }

  render(cx) {
    if (this.overlay) return this.overlay.render(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    // A file operation from the menu asks for a reload.
    const asked = shared(refreshKey);
    if (asked !== this.asked) { if (this.asked !== undefined) this.refresh(cx); this.asked = asked; }
    const t = theme();
    return v_flex().id("explorer").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Explorer"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("explorer-tree").flex_1().min_h(0).overflow_y_scrollbar().p(4)
        .on_mouse_down("right", (_e, cx) => this.menu(this.root, true, cx)).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
