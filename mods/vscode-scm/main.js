// A VS Code–style Source Control panel for the focused pane's folder: its git repos (nested ones too),
// the selected repo's changes with diff and commit (as Herdr's shipped `changes` mod does), and its commit graph.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const ROW = 22, LANE = 12, MAX_LANES = 12, COMMITS = 300, FILES = 1000;

// VS Code's git decoration colors (as vscode-explorer) and its scmGraph.foreground1–5 lane colors.
const GIT_COLOR = { M: "#e2c08d", A: "#73c991", U: "#73c991", D: "#c74e39", "!": "#e4676b" };
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

// Numbers each diff line once, so a frame only draws the rows on screen (from the shipped `changes` mod).
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class SourceControl extends View {
  init(_props, cx) {
    this.repos = []; this.chosen = new Map(); this.handle = cx.focus_handle(); this.last = 0;
    try { this.collapsed = JSON.parse(localStorage.getItem("collapsed") ?? "{}"); } catch { this.collapsed = {}; }
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
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  clearRepo() {
    this.files = []; this.commits = []; this.open = null; this.note = null; this.limited = false; this.hasHead = true;
    this.setLines([]);
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
      this.context = context; this.on = on; this.repos = []; this.selected = this.chosen.get(context) ?? null;
      this.clearRepo(); this.error = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true; this.queued = false; this.last = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", REPOS, "scm", cwd], { on });
        if (key() !== context) return;
        const { top, repos } = parseRepos(r.stdout), selected = pickRepo(repos, top, this.selected);
        this.repos = repos; this.error = repos.length ? null : "No git repositories in this folder";
        if (selected !== this.selected) { this.selected = selected; this.clearRepo(); }
        this.watch(top || cwd, cx);
        if (selected) await this.loadRepo(context, selected);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.queued) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async loadRepo(context, root) {
    const repo = this.repos.find((r) => r.path === root), on = this.on, git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr);
    const entries = status.stdout.split("\0").filter(Boolean);
    const files = entries.slice(0, FILES).map((entry) => ({ path: entry.slice(3), status: gitLetter(entry.slice(0, 2)), fresh: entry.startsWith("??") }));
    const hasHead = repo?.oid !== "(initial)";
    let commits = [];
    if (hasHead) {
      // The branch and, like VS Code's graph, its upstream (only when it still exists: `branch.ab` is there).
      const log = await git(["log", "--topo-order", "--date-order", "-n", String(COMMITS), LOG_FORMAT, "HEAD", ...(repo?.ahead !== null && repo?.upstream ? [repo.upstream] : []), "--"]);
      if (log.code === 0) commits = graph(parseLog(log.stdout));
    }
    if (key() !== context || this.selected !== root) return;
    this.files = files; this.limited = entries.length > FILES; this.hasHead = hasHead; this.commits = commits;
    if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
    if (this.open) {
      try { await this.load(this.open, context, root); }
      catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
    }
  }

  // From the shipped `changes` mod: untracked (and, before the first commit, added) files show whole.
  async load(path, context, root) {
    const file = this.files.find((f) => f.path === path), on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else lines = [`@@ -0,0 +1,${countLines(text)} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? ["No text diff (binary file or mode change)"] : all.slice(first);
    }
    if (key() === context && this.selected === root && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.diff = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  select(path, cx) {
    if (path === this.selected) return;
    this.selected = path; this.chosen.set(this.context, path); this.clearRepo();
    this.refresh(cx);
    cx.notify();
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    const context = this.context, root = this.selected;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context, root); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // As the shipped `changes` mod: stages everything in the repo, then commits.
  commit(cx) {
    if (!this.message.trim() || !this.selected || this.busy || this.loading || this.context !== key()) return;
    const root = this.selected, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
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

  toggle(id, cx) {
    this.collapsed[id] = !this.collapsed[id];
    try { localStorage.setItem("collapsed", JSON.stringify(this.collapsed)); } catch {}
    cx.notify();
  }

  section(id, title, t, extra) {
    const open = !this.collapsed[id];
    return h_flex().id(`scm-section-${id}`).h(ROW).flex_none().px(4).gap(2).items_center().cursor_pointer().border_t(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(id, cx))
      .child(svg(`mods/vscode-scm/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().text_size(11).font_bold().child(title.toUpperCase()))
      .child(h_flex().flex_1().min_w(0).gap(6).justify_end().items_center().children(extra ?? []));
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

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), color = GIT_COLOR[f.status];
    return h_flex().id(`scm-file-${f.path}`).h(ROW).flex_none().pl(22).pr(10).gap(6).items_center().cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().max_w(220).flex_none().truncate().text_color(color).when(f.status === "D", (e) => e.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(parts.join("/")))
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(f.status));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
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

  graphRow(row, t) {
    const color = laneColor(row.col);
    return h_flex().w_full().h(ROW).flex_none().pr(10).gap(6).items_center()
      .child(this.lanes(row, t))
      .child(div().flex_1().min_w(0).truncate().when(row.refs.some((r) => r.head), (e) => e.font_semibold()).child(row.subject || " "))
      .children(row.refs.slice(0, 2).map((r) => div().flex_none().max_w(110).truncate().px(5).h(16).flex().items_center().rounded(8).text_size(10)
        .border_1().border_color(r.tag ? t.border : color).bg(r.tag ? t.raised : color + "33").text_color(r.tag ? t.muted : t.foreground).child(r.name)))
      .when(row.refs.length > 2, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${row.refs.length - 2}`)))
      .child(div().flex_none().max_w(80).truncate().text_size(11).text_color(t.dim).child(row.author));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), repo = this.repos.find((r) => r.path === this.selected), shown = (id) => !this.collapsed[id];
    const enabled = Boolean(this.message.trim() && repo && !this.busy && !this.loading);
    const empty = (text) => div().h(ROW).flex_none().px(22).flex().items_center().text_size(12).text_color(t.dim).child(text);
    return v_flex().id("scm").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center()
        .child(div().font_semibold().child("Source Control"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.loading && !this.repos.length ? "Loading…" : "")))
      .child(this.section("repos", "Repositories", t, [this.badge(String(this.repos.length), t)]))
      .when(shown("repos"), (el) => el.child(v_flex().id("scm-repos").flex_none().max_h(5 * ROW).overflow_y_scrollbar()
        .children(this.repos.map((r) => this.repoRow(r, t)))
        .when(!this.repos.length, (e) => e.child(empty(this.error || (this.loading ? "Looking for repositories…" : "No folder"))))))
      .child(this.section("changes", "Changes", t, repo ? [div().max_w(140).truncate().text_size(11).text_color(t.dim).child(repo.name), this.badge(String(this.files.length), t)] : []))
      .when(shown("changes") && Boolean(repo), (el) => el
        .child(v_flex().flex_none().px(10).pt(4).pb(6).gap(6)
          .child(div().id("scm-message").w_full().h(28).px(8).flex().items_center().rounded(4).bg(t.surface).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().id("scm-commit").w_full().h(28).gap(6).justify_center().items_center().rounded(4).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12)
            .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx))
            .child(this.busy ? "Committing…" : `✓ Commit${repo ? ` on ${repo.branch === "(detached)" ? repo.oid.slice(0, 7) : repo.branch}` : ""}`)))
        .when(Boolean(this.note), (e) => e.child(div().px(10).pb(6).text_size(11).text_color(t.ansi1).child(this.note)))
        .child(v_flex().id("scm-files").flex_none().max_h(8 * ROW).overflow_y_scrollbar()
          .children(this.files.map((f) => this.fileRow(f, t)))
          .when(!this.files.length, (e) => e.child(empty(this.loading ? "Loading changes…" : "No uncommitted changes"))))
        .when(this.limited, (e) => e.child(empty("Showing the first 1,000 changed files")))
        .when(Boolean(this.open), (e) => e.child(div().h(240).flex_none().relative().border_t(1).border_color(t.border).font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
          .child(div().id("scm-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("scm-diff", this.diff.length, 20, (i) => String(i),
              (range) => this.diff.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
          .child(Scrollbar.vertical("scm-diff").viewport_from_layout().absolute().inset_0()))))
      .child(this.section("graph", "Graph", t, repo?.upstream && repo.ahead !== null ? [div().max_w(160).truncate().text_size(11).text_color(t.dim).child(`${repo.branch} · ${repo.upstream}`)] : []))
      .when(shown("graph"), (el) => el.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("scm-graph", this.commits.length, ROW, (i) => this.commits[i].hash,
          (range) => this.commits.slice(range.start, range.end).map((row) => this.graphRow(row, t))).size_full())
        .child(Scrollbar.vertical("scm-graph").viewport_from_layout().absolute().inset_0())
        .when(!this.commits.length, (e) => e.child(div().absolute().top(0).w_full().child(empty(repo ? (this.hasHead ? (this.loading ? "Loading commits…" : "No commits") : "No commits yet") : "No repository"))))));
  }
}
