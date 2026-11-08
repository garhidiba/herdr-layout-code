// A VS Code–style Source Control panel for the active space's folder (like a VS Code workspace; the focused pane's folder when the space has none): its git repos (nested ones too),
// the selected repo's changes and commit (as Herdr's shipped `changes` mod does), and its commit graph.
// Commits expand to their changed files; a file opens a diff tab (vscode-diff mod).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, run, appHome, notify, shared, setShared, openOverlay, layout } from "herdr";
import { freshRoot, encode, decode } from "./cache.js";
import { createCore } from "./core.js";
import { layoutSections, flexSection, sashPair, dragSash } from "./sections.js";
import { syncAction, syncSteps, syncError, BUSY } from "./sync.js";

// The sash to the Image Viewer column right of this panel (vscode-tabs side.js): this card's right 4 px while the column
// shows, half of the 8 px between the cards (the column draws the other half); no line, a col-resize pointer. A press
// opens vscode-tabs' SideResize overlay, which slides this panel as a block while the column resizes.
const findNode = (n, id) => n?.id === id ? n : (n?.children ?? []).map(c => findNode(c, id)).find(Boolean) ?? null;
function imageSash(card) {
  const column = findNode(layout(), "image-panel");
  if (!column || column.hidden) return card;
  return h_flex().size_full().min_h(0).child(card.flex_1().min_w(0))
    .child(div().id("image-sash").w(4).h_full().flex_none().cursor_col_resize()
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "vscode-tabs", kind: "window", frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1, props: { sideResize: { x: e.position.x } } });
      }));
}
// Push and pull never wait on a prompt (no terminal here): a missing credential fails at once, a merge takes git's message.
const NO_PROMPT = ["GIT_TERMINAL_PROMPT=0", "GIT_MERGE_AUTOEDIT=no"];

// The project you work in: the focused terminal's folder. Editor and diff tabs have no folder, so focusing
// them keeps this space's last project instead of reloading; a fresh space starts at its first terminal's folder.
const lastRoot = {};
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = f?.pane === null ? f?.cwd : pane?.terminal ? pane.cwd : null;
  if (cwd) return (lastRoot[space?.id] = { cwd, on });
  return lastRoot[space?.id] ?? freshRoot(space, panes());
}
const key = () => JSON.stringify(location());
// Other spaces' repos load in the background: 3s after start, 2 at a time, again every 10 minutes
// (and when a space appears), skipping ones loaded in the last 2 minutes.
const CACHE = "vscode-scm.cache", FRESH = 120000, PRELOAD_EVERY = 600000, SAVE_EVERY = 60000;
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const ROW = 22, LANE = 12, MAX_LANES = 12, COMMITS = 300, FILES = 1000;
// The panel title row, and the message input plus the Commit button above the changed files.
const TITLE = 36, COMMIT_BOX = 72;

// VS Code's git decoration colors (as vscode-explorer) and its scmGraph.foreground1–5 lane colors.
const GIT_COLOR = { M: "#e2c08d", A: "#73c991", U: "#73c991", D: "#c74e39", R: "#73c991", "!": "#e4676b" };
const gitLetter = (xy) => xy === "??" ? "U" : /U|AA|DD/.test(xy) ? "!" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
const LANE_COLORS = ["#ffb000", "#dc267f", "#994f00", "#40b0a6", "#b66dff"];
const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];

// Prints the folder's own repo (or an empty line), then "@@<repo>" and the branch headers of
// `status --porcelain=v2 --branch` for it and every repo up to 3 levels below (200 at most).
// One entry line after the headers is enough to know the repo is dirty.
const REPOS = 'top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null); printf "%s\\n" "$top"; { [ -n "$top" ] && printf "%s\\n" "$top"; find "$1" -maxdepth 3 -name .git -prune 2>/dev/null | head -200 | sed "s#/\\.git\\$##" | sort; } | awk \'!seen[$0]++\' | head -200 | while IFS= read -r r; do printf "@@%s\\n" "$r"; git --no-optional-locks -c core.fsmonitor=false -C "$r" status --porcelain=v2 --branch --untracked-files=normal 2>/dev/null | head -n 5; done';

function parseRepos(text) {
  const lines = text.split("\n"), top = lines.shift() ?? "", repos = [];
  let repo = null;
  for (const line of lines) {
    if (line.startsWith("@@")) repos.push(repo = { path: line.slice(2), name: line.slice(2).split("/").pop(), branch: "", oid: "", dirty: false, ahead: null, behind: null, upstream: null });
    else if (!repo || !line) continue;
    else if (line.startsWith("# branch.oid ")) repo.oid = line.slice(13);
    else if (line.startsWith("# branch.head ")) repo.branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) repo.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) { const [a, b] = line.slice(12).split(" "); repo.ahead = Math.abs(Number(a)) || 0; repo.behind = Math.abs(Number(b)) || 0; }
    else if (!line.startsWith("#")) repo.dirty = true;
  }
  return { top, repos: repos.filter((r) => r.branch) };
}

const scanRepos = async (cwd, on) => parseRepos((await exec("sh", ["-c", REPOS, "scm", cwd], { on })).stdout);

// Keeps the current choice while it exists; else the folder's own repo, the first dirty one, the first.
const pickRepo = (repos, top, current) =>
  (repos.find((r) => r.path === current) ?? repos.find((r) => r.path === top) ?? repos.find((r) => r.dirty) ?? repos[0])?.path ?? null;

const LOG_FORMAT = "--format=%H%x00%P%x00%D%x00%s%x00%an%x00%ar%x1e";
function parseLog(text) {
  return text.split("\x1e").map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
    const [hash, parents, refs, subject, author, date] = record.split("\0");
    return { hash, parents: parents ? parents.split(" ") : [], refs: parseRefs(refs), subject, author, date };
  });
}
const parseRefs = (d) => !d ? [] : d.split(", ").filter((r) => !r.endsWith("/HEAD")).map((r) =>
  r.startsWith("HEAD -> ") ? { name: r.slice(8), head: true } : r.startsWith("tag: ") ? { name: r.slice(5), tag: true } : { name: r, head: r === "HEAD" });

// Lanes for a topo-ordered log: each lane waits for the commit it leads to. Per row it says which lanes
// have a line in the top half (coming from above) and the bottom half (going on below), and which
// lanes join the commit's node with a horizontal link (branches ending here, and merge parents).
function graph(commits) {
  const lanes = [];
  return commits.map((c) => {
    let col = lanes.indexOf(c.hash);
    const tip = col < 0;
    if (tip) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; lanes[col] = c.hash; }
    const before = lanes.slice(), links = [];
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === c.hash) { lanes[i] = null; links.push(i); }
    lanes[col] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) { k = lanes.indexOf(null); if (k < 0) k = lanes.length; lanes[k] = p; }
      if (k !== col) links.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(before.length, lanes.length), lines = [];
    for (let i = 0; i < width; i++) {
      const top = i === col ? !tip : before[i] != null, bottom = lanes[i] != null;
      if (top || bottom) lines.push({ lane: i, top, bottom });
    }
    return { ...c, col, lines, links, width, merge: c.parents.length > 1 };
  });
}

// `git show --name-status -z` -> [{ status, path, oldPath? }]: renames and copies carry the old path first.
const NAME_STATUS = { M: "M", A: "A", D: "D", R: "R", C: "A", T: "M", U: "!" };
function parseNameStatus(text) {
  const fields = text.split("\0"), files = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i].trim();
    if (!code) continue;
    if (code[0] === "R" || code[0] === "C") { files.push({ status: NAME_STATUS[code[0]], oldPath: fields[i + 1], path: fields[i + 2] }); i += 2; }
    else { files.push({ status: NAME_STATUS[code[0]] ?? "M", path: fields[i + 1] }); i += 1; }
  }
  return files.filter((f) => f.path);
}

// Material Icon Theme (the Explorer's table): exact file name, then the longest extension, then the default.
function fileIcon(name, m) {
  if (!m?.names) return null;
  const n = name.toLowerCase();
  if (m.names[n]) return m.names[n];
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const e = m.ext[parts.slice(i).join(".")]; if (e) return e; }
  return m.file;
}

const short = (hash) => hash ? hash.slice(0, 7) : "∅";
const baseName = (path) => path.split("/").pop();
// A diff tab named as VS Code names it: "<old name> (<left>) ↔ <name> (<right>)". commit null: HEAD ↔ the working tree.
function openDiff(repo, on, file, commit, parent) {
  const left = commit ? short(parent) : "HEAD", right = commit ? short(commit) : "Working Tree";
  run("tab.new", { name: `${baseName(file.oldPath ?? file.path)} (${left}) ↔ ${baseName(file.path)} (${right})`, mod: "vscode-diff",
    props: { repo, commit, parent: commit ? parent : "HEAD", path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), on } });
}

// A repo's changes and graph. `repo` is its row from the repo list (branch, upstream), if known.
async function readRepo(repo, root, on) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr);
  const entries = status.stdout.split("\0").filter(Boolean);
  const files = entries.slice(0, FILES).map((entry) => ({ path: entry.slice(3), status: gitLetter(entry.slice(0, 2)) }));
  const hasHead = repo?.oid !== "(initial)";
  let commits = [];
  if (hasHead) {
    // The branch and, like VS Code's graph, its upstream (only when it still exists: `branch.ab` is there).
    const log = await git(["log", "--topo-order", "--date-order", "-n", String(COMMITS), LOG_FORMAT, "HEAD", ...upstreamOf(repo), "--"]);
    if (log.code === 0) commits = graph(parseLog(log.stdout));
  }
  return { files, limited: entries.length > FILES, hasHead, commits };
}

// With "core.engine": "rust", vscode-core does the reads (same shapes); each falls back to the JS above when it gives null.
const core = createCore({ exec, readTextFile, notify, appHome, shared, setShared });
const upstreamOf = (repo) => repo?.ahead !== null && repo?.upstream ? [repo.upstream] : [];
const repoList = async (cwd, on) => (await core(["repos", cwd], on)) ?? scanRepos(cwd, on);
const repoData = async (repo, root, on) => (await core(["repo", root, ...upstreamOf(repo).flatMap((u) => ["--upstream", u])], on)) ?? readRepo(repo, root, on);
async function commitFiles(root, hash, on) {
  const fast = await core(["commit-files", root, hash], on);
  if (fast) return fast;
  const r = await exec("git", [...READ, "show", "--name-status", "-z", "--format=", "-M", "-m", "--first-parent", hash], { cwd: root, on });
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return parseNameStatus(r.stdout).slice(0, FILES);
}

export default class SourceControl extends View {
  init(_props, cx) {
    // Every project's repos, changes and graph from before the restart, shown at once and refreshed behind.
    let cache = null;
    try { cache = localStorage.getItem(CACHE); } catch {}
    const restored = decode(cache);
    ({ seen: this.seen, repoCache: this.repoCache, lastSelected: this.lastSelected, chosen: this.chosen } = restored);
    try { for (const c of this.repoCache.values()) c.commits = graph(c.commits); } catch { this.repoCache.clear(); }
    Object.assign(lastRoot, restored.lastRoot);
    this.repos = []; this.handle = cx.focus_handle(); this.last = 0; this.icons = null;
    cx.spawn(async (cx) => {
      try { this.icons = JSON.parse(await readTextFile(`${appHome()}/mods/vscode-explorer/icons.json`)); } catch {}
      cx.notify();
    });
    try { this.collapsed = JSON.parse(localStorage.getItem("collapsed") ?? "{}"); } catch { this.collapsed = {}; }
    // Section heights the sashes were dragged to (px by section id), and the panel's height.
    try { this.sizes = JSON.parse(localStorage.getItem("sizes") ?? "{}") || {}; } catch { this.sizes = {}; }
    this.height = 0; this.drag = null;
    this.clearRepo();
    this.input = InputState.new({ placeholder: "Message (Enter to commit)" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => {
      this.refresh(cx);
      if (this.known && spaces().some((s) => !this.known.has(s.id))) this.preloadAll(cx);
    });
    cx.timer.after(3000, (cx) => this.preloadAll(cx));
    cx.timer.every(PRELOAD_EVERY, (cx) => this.preloadAll(cx));
  }

  // Saves the caches 2s after a change, at most once a minute.
  changed(cx) {
    if (this.saving) return;
    this.saving = true;
    cx.timer.after(Math.max(2000, (this.savedAt ?? 0) + SAVE_EVERY - Date.now()), () => {
      this.saving = false; this.savedAt = Date.now();
      try { localStorage.setItem(CACHE, encode({ seen: this.seen, repoCache: this.repoCache, lastSelected: this.lastSelected, chosen: this.chosen, lastRoot })); } catch {}
    });
  }

  // Loads every other local space's repo list and default repo into the caches, as refresh() would show them.
  // Spaces sharing a folder share a context, so it loads once. The shown state is never touched.
  preloadAll(cx) {
    if (this.preloading) return;
    const all = spaces(), list = panes(), now = Date.now(), jobs = new Map();
    this.known = new Set(all.map((s) => s.id));
    for (const space of all) {
      if (space.machine) continue;
      // Pinned, so switching there with an editor tab focused gives this same key.
      const loc = (lastRoot[space.id] ??= freshRoot(space, list)), context = JSON.stringify(loc);
      if (loc.cwd && context !== this.context && !(now - (this.seen.get(context)?.at ?? 0) < FRESH)) jobs.set(context, loc);
    }
    const queue = [...jobs];
    if (!queue.length) return;
    this.preloading = true;
    cx.spawn(async (cx) => {
      const worker = async () => {
        for (let job; (job = queue.shift());) { await this.preload(...job).catch(() => {}); this.changed(cx); }
      };
      try { await Promise.all([worker(), worker()]); } finally { this.preloading = false; }
    });
  }

  // With the Rust core, one `vscode-core all` call reads the repos and the picked repo's changes and graph.
  async preload(context, { cwd, on }) {
    const current = this.chosen.get(context) ?? this.lastSelected.get(context);
    const fast = await core(["all", cwd, ...(current ? ["--repo", current] : [])], on);
    const { top, repos } = fast?.repos ?? await scanRepos(cwd, on);
    if (context === this.context) return;
    const selected = pickRepo(repos, top, current);
    this.seen.set(context, { repos, at: Date.now() }); this.lastSelected.set(context, selected);
    if (!selected || selected === this.selected || Date.now() - (this.repoCache.get(selected)?.at ?? 0) < FRESH) return;
    const data = (fast?.selected === selected && fast.repo) || await readRepo(repos.find((r) => r.path === selected), selected, on), old = this.repoCache.get(selected);
    if (selected !== this.selected) this.repoCache.set(selected, { ...data, expanded: old?.expanded ?? new Set(), commitFiles: old?.commitFiles ?? new Map(), at: Date.now() });
  }

  // Switching to a repo shows its last changes, graph and expanded commits at once (if seen before) while it reloads.
  clearRepo(root = null) {
    const c = root && this.repoCache?.get(root);
    this.files = c?.files ?? []; this.commits = c?.commits ?? []; this.note = null; this.limited = c?.limited ?? false; this.hasHead = c?.hasHead ?? true;
    this.expanded = c?.expanded ?? new Set(); this.commitFiles = c?.commitFiles ?? new Map();
    if (this.message) this.input.set_value("");
    this.message = "";
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context && this.watched === root) {
          await watchFolder(root);
          // A busy tree (a build) would refresh nonstop; the 10s timer catches what this skips.
          if (this.context === context && this.watched === root && Date.now() - this.last > 2000) this.refresh(cx);
        }
      } catch { if (this.context === context) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.queued = !this.busy; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      // Each project's last repo list stays (set below), so switching back shows it at once while it refreshes.
      this.context = context; this.on = on; this.repos = this.seen.get(context)?.repos ?? [];
      this.selected = this.chosen.get(context) ?? this.lastSelected.get(context) ?? null;
      this.clearRepo(this.selected); this.error = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true; this.queued = false; this.last = Date.now();
    cx.spawn(async (cx) => {
      try {
        const { top, repos } = await repoList(cwd, on);
        if (key() !== context) return;
        const selected = pickRepo(repos, top, this.selected);
        this.repos = repos; this.error = repos.length ? null : "No git repositories in this folder";
        if (selected !== this.selected) { this.selected = selected; this.clearRepo(selected); }
        this.seen.set(context, { repos, at: Date.now() }); this.lastSelected.set(context, selected);
        this.watch(top || cwd, cx);
        if (selected) await this.loadRepo(context, selected);
        this.changed(cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.queued) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async loadRepo(context, root) {
    const data = await repoData(this.repos.find((r) => r.path === root), root, this.on);
    if (key() !== context || this.selected !== root) return;
    Object.assign(this, data);
    this.repoCache.set(root, { ...data, expanded: this.expanded, commitFiles: this.commitFiles, at: Date.now() });
  }

  select(path, cx) {
    if (path === this.selected) return;
    this.selected = path; this.chosen.set(this.context, path); this.clearRepo(path);
    this.refresh(cx);
    cx.notify();
  }

  // Expands a commit to its changed files (against its first parent), loaded once per commit.
  toggleCommit(row, cx) {
    if (this.expanded.delete(row.hash)) return cx.notify();
    this.expanded.add(row.hash);
    if (!this.commitFiles.has(row.hash)) {
      const root = this.selected, context = this.context, on = this.on, files = this.commitFiles;
      files.set(row.hash, "Loading…");
      cx.spawn(async (cx) => {
        try {
          const list = await commitFiles(root, row.hash, on);
          files.set(row.hash, list.length ? list : "No changed files");
        } catch (e) { files.set(row.hash, `Cannot list the files: ${e}`); }
        if (this.context === context && this.selected === root) cx.notify();
      });
    }
    cx.notify();
  }

  // Keys from the graph list: "c:<hash>" toggles a commit, "f:<hash>:<path>" opens that file's diff.
  graphClick(id, cx) {
    const hash = id.slice(2, 42), row = this.commits.find((c) => c.hash === hash);
    if (!row) return;
    if (id.startsWith("c:")) return this.toggleCommit(row, cx);
    const files = this.commitFiles.get(hash), file = Array.isArray(files) && files.find((f) => f.path === id.slice(43));
    if (id.startsWith("f:") && file) openDiff(this.selected, this.on, file, row.hash, row.parents[0] ?? null);
  }

  // The graph's rows: each commit, then the files of the expanded ones (or a note while they load).
  graphItems() {
    const items = [];
    for (const row of this.commits) {
      items.push({ key: `c:${row.hash}`, row });
      if (!this.expanded.has(row.hash)) continue;
      const files = this.commitFiles.get(row.hash);
      if (Array.isArray(files)) for (const file of files) items.push({ key: `f:${row.hash}:${file.path}`, row, file });
      else items.push({ key: `n:${row.hash}`, row, note: files ?? "Loading…" });
    }
    return items;
  }

  // As the shipped `changes` mod: stages everything in the repo, then commits.
  commit(cx) {
    if (!this.message.trim() || !this.selected || this.busy || this.loading || this.context !== key()) return;
    const root = this.selected, on = this.on, context = this.context, message = this.message.trim();
    this.busy = "Committing…"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context && this.selected === root) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // With nothing to commit: push, pull, sync (pull then push) or publish the selected repo's branch (syncAction).
  // Each git call is Herdr's exec, so one taking over its 30 s limit is stopped and shown as failed.
  sync(action, cx) {
    const repo = this.repos.find((r) => r.path === this.selected);
    if (!action || !repo || this.busy || this.loading || this.context !== key()) return;
    const root = this.selected, on = this.on, context = this.context;
    this.busy = BUSY[action.kind]; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const remotes = action.kind === "publish" ? (await exec("git", [...READ, "remote"], { cwd: root, on })).stdout.split("\n").filter(Boolean) : [];
        for (const args of syncSteps(action.kind, repo.branch, remotes)) {
          let r;
          try { r = await exec("env", [...NO_PROMPT, "git", ...args], { cwd: root, on }); }
          catch (e) { throw new Error(`${e?.message ?? e} (Herdr stops a command after 30 s; run \`git ${args.join(" ")}\` in a terminal for a slow remote.)`); }
          if (r.code !== 0) throw new Error(syncError(r.stderr || r.stdout));
        }
      } catch (e) { if (key() === context) this.note = `${action.kind[0].toUpperCase()}${action.kind.slice(1)} failed:${e?.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  toggle(id, cx) {
    this.collapsed[id] = !this.collapsed[id];
    try { localStorage.setItem("collapsed", JSON.stringify(this.collapsed)); } catch {}
    cx.notify();
  }

  // A sash drag: the root follows the pointer while it is over the panel; releasing or leaving ends it.
  dragTo(y, cx) {
    if (!this.drag) return;
    const { pair, from, heights, mins } = this.drag;
    Object.assign(this.sizes, dragSash(heights, mins, pair, y - from));
    cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null;
    try { localStorage.setItem("sizes", JSON.stringify(this.sizes)); } catch {}
    cx.notify();
  }

  // A section header; `sash` ({pair, heights, mins} or null) puts a resize handle on its top edge.
  section(id, title, t, extra, sash) {
    const open = !this.collapsed[id], dragging = this.drag?.id === id;
    const header = h_flex().id(`scm-section-${id}`).h(ROW).flex_none().px(4).gap(2).items_center().cursor_pointer().border_t(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(id, cx))
      .child(svg(`mods/vscode-scm/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().text_size(11).font_bold().child(title.toUpperCase()))
      .child(h_flex().flex_1().min_w(0).gap(6).justify_end().items_center().children(extra ?? []));
    if (!sash) return header;
    return div().relative().flex_none().child(header)
      .child(div().id(`scm-sash-${id}`).absolute().left(0).top(-2).w_full().h(4).cursor_row_resize().hover((s) => s.bg(t.accent)).when(dragging, (e) => e.bg(t.accent))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.drag = { id, from: e.position.y, ...sash }; cx.notify(); }));
  }

  badge(text, t) {
    return div().px(6).rounded(9).bg(t.raised).text_size(10).text_color(t.muted).child(text);
  }

  repoRow(r, t) {
    const on = r.path === this.selected, branch = r.branch === "(detached)" ? r.oid.slice(0, 7) : r.branch;
    return h_flex().id(`scm-repo-${r.path}`).h(ROW).flex_none().pl(8).pr(10).gap(6).items_center().cursor_pointer().when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.select(r.path, cx))
      .child(div().size(6).rounded(3).flex_none().when(on, (e) => e.bg(t.accent)))
      .child(div().flex_1().min_w(0).truncate().child(r.name))
      .child(svg("mods/vscode-scm/branch.svg").size(12).flex_none().text_color(t.dim))
      .child(div().max_w(130).truncate().text_size(12).text_color(t.muted).child(branch + (r.dirty ? "*" : "")))
      .when(r.ahead !== null, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`↑${r.ahead} ↓${r.behind}`)));
  }

  // A changed file: name in its git color (struck through when deleted), folder dimmed, letter on the right.
  fileLabel(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), color = GIT_COLOR[f.status];
    return [div().max_w(220).flex_none().truncate().text_color(color).when(f.status === "D", (e) => e.line_through()).child(name),
      div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(parts.join("/")),
      div().w(12).flex_none().text_size(11).text_color(color).child(f.status)];
  }

  // A row of the Changes list (a virtual list: no handlers here, clicks come through `on_item_click`).
  fileRow(f, t) {
    return h_flex().w_full().h(ROW).flex_none().pl(22).pr(10).gap(6).items_center().cursor_pointer().children(this.fileLabel(f, t));
  }

  // The lane column: half lines per lane, horizontal links to the node, and the node (a ring for merges).
  lanes(row, t) {
    const x = (i) => 4 + i * LANE + LANE / 2, mid = ROW / 2, shown = (i) => i < MAX_LANES, parts = [];
    for (const { lane, top, bottom } of row.lines.filter((l) => shown(l.lane))) {
      if (top) parts.push(div().absolute().left(x(lane) - 1).top(0).w(2).h(mid).bg(laneColor(lane)));
      if (bottom) parts.push(div().absolute().left(x(lane) - 1).top(mid).w(2).h(mid).bg(laneColor(lane)));
    }
    for (const lane of row.links.filter(shown)) {
      const a = Math.min(x(lane), x(row.col)), b = Math.max(x(lane), x(row.col));
      parts.push(div().absolute().left(a).top(mid - 1).w(b - a).h(2).bg(laneColor(lane)));
    }
    if (shown(row.col)) {
      const dot = div().absolute().left(x(row.col) - 4).top(mid - 4).size(8).rounded(4);
      parts.push(row.merge ? dot.bg(t.background).border_2().border_color(laneColor(row.col)) : dot.bg(laneColor(row.col)));
    }
    return div().relative().w(8 + Math.min(Math.max(row.width, 1), MAX_LANES) * LANE).h(ROW).flex_none().children(parts);
  }

  // Under an expanded commit: the lanes that go on below it, at full height.
  throughLanes(row) {
    const parts = row.lines.filter((l) => l.bottom && l.lane < MAX_LANES)
      .map(({ lane }) => div().absolute().left(4 + lane * LANE + LANE / 2 - 1).top(0).w(2).h(ROW).bg(laneColor(lane)));
    return div().relative().w(8 + Math.min(Math.max(row.width, 1), MAX_LANES) * LANE).h(ROW).flex_none().children(parts);
  }

  // A file of an expanded commit (or the note while its files load), indented under the subject.
  graphFileRow({ row, file, note }, t) {
    const el = h_flex().w_full().h(ROW).flex_none().pr(10).gap(6).items_center().child(this.throughLanes(row)).child(div().w(10).flex_none());
    if (!file) return el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(note));
    const icon = fileIcon(baseName(file.path), this.icons);
    return el.cursor_pointer().child(icon ? image(`mods/vscode-explorer/icons/${icon}.svg`).w(16).h(16).flex_none() : div().w(16).flex_none())
      .children(this.fileLabel(file, t));
  }

  graphRow(row, t) {
    const color = laneColor(row.col);
    return h_flex().w_full().h(ROW).flex_none().pr(10).gap(6).items_center().cursor_pointer().when(this.expanded.has(row.hash), (e) => e.bg(t.selected))
      .child(this.lanes(row, t))
      .child(div().flex_1().min_w(0).truncate().when(row.refs.some((r) => r.head), (e) => e.font_semibold()).child(row.subject || " "))
      .children(row.refs.slice(0, 2).map((r) => div().flex_none().max_w(110).truncate().px(5).h(16).flex().items_center().rounded(8).text_size(10)
        .border_1().border_color(r.tag ? t.border : color).bg(r.tag ? t.raised : color + "33").text_color(r.tag ? t.muted : t.foreground).child(r.name)))
      .when(row.refs.length > 2, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${row.refs.length - 2}`)))
      .child(div().flex_none().max_w(80).truncate().text_size(11).text_color(t.dim).child(row.author));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), repo = this.repos.find((r) => r.path === this.selected), shown = (id) => !this.collapsed[id], items = this.graphItems(), files = this.files;
    // Nothing to commit (neither the loaded files nor the repo list says dirty) but commits to push or pull:
    // the button pushes, pulls, syncs or publishes instead.
    const action = syncAction(repo, files.length || Number(Boolean(repo?.dirty)));
    const enabled = Boolean((action || this.message.trim()) && repo && !this.busy && !this.loading);
    const empty = (text) => div().h(ROW).flex_none().px(22).flex().items_center().text_size(12).text_color(t.dim).child(text);
    // VS Code's layout: open sections share the height below the title and the three headers. Repositories and
    // Graph keep their dragged size; Changes (else the last open section) takes the rest; collapsed ones give theirs back.
    const available = this.height - 2 - TITLE - 3 * ROW;
    const list = [
      { id: "repos", open: shown("repos"), size: this.sizes.repos ?? Math.min(Math.max(this.repos.length, 1), 5) * ROW, min: ROW },
      { id: "changes", open: shown("changes") && Boolean(repo), size: this.sizes.changes, min: COMMIT_BOX + ROW },
      { id: "graph", open: shown("graph"), size: this.sizes.graph ?? Math.round(available * 0.4), min: 2 * ROW },
    ];
    const heights = layoutSections(list, available, "changes"), flex = flexSection(list, "changes")?.id;
    const mins = Object.fromEntries(list.map((s) => [s.id, s.min]));
    const sash = (i) => { const pair = sashPair(list, i); return pair && { pair, heights, mins }; };
    // The flex section fills by layout (no rounding gap); the others get their computed height. Both are definite,
    // which a scroll area needs: under a max_h alone its viewport grows with its rows and never scrolls.
    const fit = (id, el) => id === flex ? el.flex_1().min_h(0) : el.flex_none().h(heights[id]);
    return imageSash(v_flex().id("scm").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { if (size.height !== this.height) { this.height = size.height; cx.notify(); } })
      .on_mouse_move((e, cx) => this.dragTo(e.position.y, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(TITLE).flex_none().px(14).gap(8).items_center()
        .child(div().font_semibold().child("Source Control"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.loading && !this.repos.length ? "Loading…" : "")))
      .child(this.section("repos", "Repositories", t, [this.badge(String(this.repos.length), t)], sash(0)))
      .when(list[0].open, (el) => el.child(fit("repos", v_flex().id("scm-repos")).overflow_y_scrollbar()
        .children(this.repos.map((r) => this.repoRow(r, t)))
        .when(!this.repos.length, (e) => e.child(empty(this.error || (this.loading ? "Looking for repositories…" : "No folder"))))))
      .child(this.section("changes", "Changes", t, repo ? [div().max_w(140).truncate().text_size(11).text_color(t.dim).child(repo.name), this.badge(String(files.length), t)] : [], sash(1)))
      .when(list[1].open, (el) => el.child(fit("changes", v_flex())
        .child(v_flex().flex_none().px(10).pt(4).pb(6).gap(6)
          .child(div().id("scm-message").w_full().h(28).px(8).flex().items_center().rounded(4).bg(t.surface).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().id("scm-commit").w_full().h(28).gap(6).justify_center().items_center().rounded(4).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12)
            .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => action ? this.sync(action, cx) : this.commit(cx))
            .child(this.busy ? this.busy : action ? action.label : `✓ Commit${repo ? ` on ${repo.branch === "(detached)" ? repo.oid.slice(0, 7) : repo.branch}` : ""}`)))
        .when(Boolean(this.note), (e) => e.child(div().flex_none().px(10).pb(6).text_size(11).text_color(t.ansi1).child(this.note)))
        .child(files.length ? div().flex_1().min_h(0).relative()
          .child(v_virtual_list("scm-files", files.length, ROW, (i) => files[i].path,
            (range) => files.slice(range.start, range.end).map((f) => this.fileRow(f, t))).size_full()
            .on_item_click((path, cx) => { const f = this.files.find((f) => f.path === path); if (f) openDiff(this.selected, this.on, f, null, null); }))
          .child(Scrollbar.vertical("scm-files").viewport_from_layout().absolute().inset_0())
          : empty(this.loading ? "Loading changes…" : "No uncommitted changes"))
        .when(this.limited, (e) => e.child(empty("Showing the first 1,000 changed files")))))
      .child(this.section("graph", "Graph", t, repo?.upstream && repo.ahead !== null ? [div().max_w(160).truncate().text_size(11).text_color(t.dim).child(`${repo.branch} · ${repo.upstream}`)] : [], sash(2)))
      .when(list[2].open, (el) => el.child(fit("graph", div().relative())
        .child(v_virtual_list("scm-graph", items.length, ROW, (i) => items[i].key,
          (range) => items.slice(range.start, range.end).map((item) => item.file || item.note ? this.graphFileRow(item, t) : this.graphRow(item.row, t))).size_full()
          .on_item_click((id, cx) => this.graphClick(id, cx)))
        .child(Scrollbar.vertical("scm-graph").viewport_from_layout().absolute().inset_0())
        .when(!this.commits.length, (e) => e.child(div().absolute().top(0).w_full().child(empty(repo ? (this.hasHead ? (this.loading ? "Loading commits…" : "No commits") : "No commits yet") : "No repository")))))));
  }
}
