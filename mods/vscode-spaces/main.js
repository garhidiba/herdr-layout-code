// vscode-spaces: Herdr's shipped `spaces` mod plus the icons of the agents in each
// space (one per kind, dim when idle) before the ahead/behind numbers.
//
// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind; details of agents live in the agents list. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, notify, appHome, readTextFile, writeTextFile } from "herdr";
import { spaceAgents, fit, describe } from "./agents.js";
import { sync, interleave, forget, adopt, liveIndex, moveTo, reopenArgs, load } from "./kept.js";
import { settingsOf, machineOrderOf, sortMachines, dragOrder, writeMachineOrder } from "./order.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const settingsPath = () => `${appHome()}/vscode-settings.json`;
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
// Copied from the shipped agents mod (test/agents.test.mjs keeps it equal).
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    // Spaces seen, in list order; the ones Herdr closed stay as gray "closed" rows (kept.js).
    this.kept = load(localStorage.getItem("vscode-spaces.kept"));
    this.reopening = null; // { id, machine, before, at } while space.new runs for a kept row
    this.askAt = shared("vscode-spaces.ask")?.at ?? 0; // the menu's last request, already seen
    // The machine headers' order (order.js), read again every 2s as other mods read vscode-settings.json.
    this.machineOrder = [];
    this.orderReadAt = -Infinity;
    this.draggedMachine = null;
    this.overMachine = null;
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (now - this.orderReadAt >= 2000) this.readOrder(now, cx);
    const keptMoved = this.keep(now, sp, cx);
    // An agent starting, stopping or changing state redraws its space's icons.
    const sig = agents().map((a) => `${a.space}:${a.address}:${a.status}:${a.program?.key}`).join("|");
    const moved = sig !== this.agentSig;
    this.agentSig = sig;
    if (keptMoved || moved || sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // spaces.machineOrder from vscode-settings.json; redraws when it changed.
  readOrder(now, cx) {
    this.orderReadAt = now;
    cx.spawn(async (cx) => {
      const text = await readTextFile(settingsPath()).catch(() => null);
      if (text === this.settingsText) return;
      this.settingsText = text;
      this.machineOrder = machineOrderOf(settingsOf(text));
      cx.notify();
    });
  }

  // `from`'s header dropped on `to`'s: shown in that order at once, then saved as spaces.machineOrder.
  dropMachine(shown, from, to, cx) {
    const next = dragOrder(this.machineOrder, shown, from, to);
    if (!next) return;
    this.machineOrder = next;
    cx.spawn(async () => {
      const io = { read: () => readTextFile(settingsPath()), write: (text, expected) => writeTextFile(settingsPath(), text, expected) };
      try { await writeMachineOrder(io, next); }
      catch (e) {
        notify({ title: "Machine order not saved", body: `vscode-settings.json can't be rewritten safely (${e?.message ?? e}). Set "spaces.machineOrder" there by hand.`, level: "warning" });
      }
      this.settingsText = undefined; // the next read shows the file's order
    });
  }

  // Brings the kept list up to date with spaces(); true when it changed.
  keep(now, sp, cx) {
    const ask = shared("vscode-spaces.ask");
    if (ask?.at > this.askAt) {
      this.askAt = ask.at;
      const k = this.kept.find((r) => r.id === ask.id && r.live === false);
      if (k && ask.action === "open") this.reopen(k, cx);
      if (k && ask.action === "forget") this.kept = forget(this.kept, k.id);
    }
    const { list: next, fresh, index, color } = this.view(now, sp);
    const r = this.reopening;
    if (fresh && !r.fresh) {
      // The new space takes the kept row's place, color and position. Herdr put it last.
      r.fresh = fresh.id;
      r.index = index;
      if (color) setShared("space.colors", { ...(shared("space.colors") ?? {}), [fresh.id]: color });
      if (index && index !== sp.findIndex((s) => s.id === fresh.id) + 1) run("space.move", { id: fresh.id, index });
    }
    // Done once Herdr shows it there (until then view() draws it there); given up after 15s.
    const placed = r?.fresh && (!fresh || !r.index || sp.findIndex((s) => s.id === r.fresh) + 1 === r.index);
    if (r && (placed || now - r.at > 15000)) this.reopening = null;
    // A worktree's space closes before its folder goes: forget it once the folder is gone.
    const was = new Map(this.kept.map((k) => [k.id, k.live]));
    for (const k of next) if (k.live === false && was.get(k.id) === true) this.forgetIfGone(k, 5000, cx);
    const text = JSON.stringify(next);
    this.kept = next;
    if (text === this.keptText) return false;
    this.keptText = text;
    localStorage.setItem("vscode-spaces.kept", text);
    return true;
  }

  // The kept list as spaces() is now, without storing it: render draws this, so a
  // space Herdr just closed is a closed row in the same frame, not after keep()'s tick.
  // `fresh`: the space reopened from a row, `index` the row's space.move index, `color`
  // the row's; `order`: spaces() with it already at that index (Herdr adds it last and
  // moves it a moment later), which the list is drawn and stored in.
  view(now, sp) {
    let list = this.kept;
    const r = this.reopening;
    const fresh = r && sp.find((s) => (r.fresh ? s.id === r.fresh : !r.before.has(s.id) && (s.machine ?? null) === r.machine));
    let index = r?.index ?? null;
    if (fresh && !r.fresh) {
      list = adopt(list, r.id, fresh.id);
      index = liveIndex(list, fresh.id, new Set(sp.map((s) => s.id)));
    }
    const order = fresh ? moveTo(sp, fresh.id, index) : sp;
    const color = fresh ? list.find((k) => k.id === fresh.id)?.color : undefined;
    const colors = { ...(shared("space.colors") ?? {}), ...(color ? { [fresh.id]: color } : {}) };
    const ps = panes();
    const live = order.map((s) => ({ id: s.id, name: s.name, named: s.named, folder: place(s, ps), machine: s.machine ?? null, color: colors[s.id] }));
    const ms = machines();
    const ready = new Set(ms.filter((m) => m.layout === "ready").map((m) => m.name ?? null));
    // Without an entry for this computer, its spaces showing means its layout reads.
    if (!ms.some((m) => (m.name ?? null) === null) && sp.some((s) => !s.machine)) ready.add(null);
    return { list: sync(list, live, ready, shared("vscode-spaces.closing") ?? {}, now), order, fresh, index, color };
  }

  // Forgets a kept space whose folder is gone (true then); unsure (machine away): kept.
  async gone(k) {
    if (!k.folder) return false;
    const r = await exec("test", ["-d", k.folder], { on: k.machine ?? null }).catch(() => null);
    if (r?.code !== 1) return false;
    this.kept = forget(this.kept, k.id);
    return true;
  }

  forgetIfGone(k, wait, cx) {
    cx.spawn(async (cx) => {
      await cx.sleep(wait);
      if (await this.gone(k)) cx.notify();
    });
  }

  // Opens a kept space again: space.new where it was; keep() gives the new one its row.
  reopen(k, cx) {
    if (this.reopening) return;
    this.reopening = { id: k.id, machine: k.machine ?? null, before: new Set(spaces().map((s) => s.id)), at: Date.now() };
    cx.notify();
    cx.spawn(async (cx) => {
      if (await this.gone(k)) {
        this.reopening = null;
        notify({ title: `${k.name} was removed from the list`, body: `${k.folder} no longer exists.`, level: "warning" });
      } else run("space.new", reopenArgs(k));
      cx.notify();
    });
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // vscode-menu: Herdr's space menu (its Close tells keep() the space goes on purpose),
  // or "kept" for a closed space's row (Open, Remove from list).
  menu(w, tab = "space") {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "vscode-menu", kind: "popup", width: 200, height: 260, props: { tab, target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    // In view()'s order: a space reopened from a row is drawn at the row's place at once.
    const view = this.view(Date.now(), spaces());
    const sp = view.order, ps = panes();
    // A space reopened from a row has its place already: no wait for its git.
    if (view.fresh) this.shown.add(view.fresh.id);
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    const kept = (k) => ({ w: { id: k.id, name: k.name, machine: k.machine ?? null }, kept: k });
    return interleave(out.filter(r => this.shown.has(r.w.id)), view.list, (r) => r.w.id).map((r) => (r.w ? r : kept(r)));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (r.kept ? this.keptRow(r.kept, t, collapsed) : collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = sortMachines([...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])], this.machineOrder);
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      // Another machine's header drags to reorder them (This computer stays first), as a space's row does.
      const dragged = this.draggedMachine;
      const head = h_flex().relative().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .when(Boolean(m) && dragged === m && this.overMachine !== m, el => el.opacity(0.5))
        .when(Boolean(m) && dragged !== null && dragged !== m && this.overMachine === m, el => el.child(
          div().absolute().left(0).right(0).h(2).bg(t.accent)
            .when(remote.indexOf(dragged) < remote.indexOf(m), line => line.bottom(0))
            .when(remote.indexOf(dragged) > remote.indexOf(m), line => line.top(0)),
        ))
        .when(Boolean(m), el => el
          .on_mouse_down("left", () => { this.draggedMachine = m; this.overMachine = m; })
          .on_mouse_move((_e, cx) => {
            if (this.draggedMachine !== null && this.overMachine !== m) { this.overMachine = m; cx.notify(); }
          })
          .on_mouse_up("left", (_e, cx) => {
            const from = this.draggedMachine;
            this.draggedMachine = null;
            this.overMachine = null;
            if (from !== null && from !== m) this.dropMachine(remote, from, m, cx);
            cx.notify();
          }))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  // The space's agents, one icon per kind (dim while all of it is idle), "+N" past
  // three, a spinner while one works; the tooltip names them. Null without agents.
  agentIcons(w, t) {
    const kinds = this.kinds?.get(w.id) ?? [];
    if (!kinds.length) return null;
    const { shown, more } = fit(kinds);
    return h_flex()
      .id(`space-agents-${w.id}`)
      .flex_none()
      .gap(3)
      .items_center()
      .tooltip(describe(kinds))
      .children(shown.map((k) => {
        const idle = k.status === "idle";
        const pic = icon(k.program, 13, idle ? t.muted : t.foreground);
        return pic && idle ? div().flex_none().opacity(0.55).child(pic) : pic;
      }).filter(Boolean))
      .when(more > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${more}`)))
      .when(kinds.some((k) => k.status === "working"), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.working).spin(900)));
  }

  gitTail(g, tree, name, t, agentIcons) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(Boolean(agentIcons), (el) => el.child(agentIcons))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t, this.agentIcons(w, t))
            : h_flex().flex_1().min_w(0).justify_end().items_center().child(this.agentIcons(w, t) ?? div())),
      );
  }

  // A space Herdr closed (its last tab went): gray avatar and name, nothing else
  // (its color comes back when it reopens); a click opens it again.
  keptRow(k, t, collapsed) {
    const avatar = h_flex().size(18).flex_none().rounded(5).bg(t.muted).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...k.name][0]?.toUpperCase() ?? "?");
    return h_flex()
      .id(`kept-${k.id}`)
      .h(collapsed ? 26 : 30)
      .flex_none()
      .px(collapsed ? 0 : 8)
      .gap(9)
      .items_center()
      .when(collapsed, (el) => el.justify_center())
      .when(!collapsed, (el) => el.rounded(8))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip("Closed — click to reopen")
      .on_click((_e, cx) => this.reopen(k, cx))
      .on_mouse_down("right", () => this.menu(k, "kept"))
      .child(avatar)
      .when(!collapsed, (el) => el.child(div().flex_shrink(0).max_w(150).truncate().text_color(t.muted).child(k.name)));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.kinds = spaceAgents(agents());
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.draggedMachine = null; this.overMachine = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
