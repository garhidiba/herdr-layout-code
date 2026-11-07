// A quick memo per space: a button floats over the window; a click opens a panel with that space's
// <folder>/.herdr/memo.md in the terminal editor (vsedit, cut down to a document editor by memo.js MEMO_SETTINGS).
//
// The button is layouts/vscode.json's `floating` block on `work-body` (bottom right, above the status bar): Herdr
// drags it, snaps it to an edge, keeps its spot and keeps it in the window, and no overlay stays open while only the
// button shows. The panel is a `kind: "window"` overlay holding a layout (memo.js panelLayout: a title bar and resize
// grips of this mod around the editor's terminal). Herdr gives mods no window geometry and moves a window only while
// it drags it itself, so the panel's rect is this mod's, in window coordinates: a press on the title bar or a grip
// opens a full-window, frameless overlay (role "grab", as vscode-tabs' drag overlay) that follows the pointer, shows
// where the panel lands, learns the window's size and saves the new rect on release; the floating copy then reopens
// the panel there.
//
// The editor's terminal is started off screen with `hc run --bg` (no Herdr labels: no tab shows it, as
// vscode-explorer's warm editors) and kept running per memo file, so closing the panel or switching spaces never ends
// it; it saves itself 0.5 s after each edit.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, openOverlay, closeOverlay, shared, setShared, spaces, panes, terminals, theme, hc, exec, appHome,
  readTextFile, writeTextFile, nextCommand, run, focused, placement } from "herdr";
import { MIN, CORNER, GRIP, memoTarget, clampRect, dragRect, closesOnPress, panelRect, panelLayout, gitignoreAddition,
  memoSettings, dragStarted } from "./memo.js";

const PANEL = "vscode-memo.panel";    // { x, y, width, height }: the panel's
const WIN = "vscode-memo.window";     // { width, height }: the window's size, as the grab overlay last saw it
const OPEN = "vscode-memo.open";      // { button: bounds, panel: { id, rect, key, address, back, note } }: what is shown
const EDITORS = "vscode-memo.editors"; // { [memo path]: terminal address }: the running memo editors
const PINNED = "vscode-memo.pinned";  // true: a press outside the panel leaves it open
const MOD = "vscode-memo", ICON = "mods/vscode-memo/memo.svg", PIN = "mods/vscode-memo/pin.svg", DOTS = "mods/vscode-memo/grip.svg";

const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const open = () => shared(OPEN) ?? {};
const setOpen = (patch) => setShared(OPEN, { ...open(), ...patch });
const live = (address) => !!address && terminals().some(t => t.address === address);
// Which memo the panel shows: its machine and file.
const memoKey = (t) => JSON.stringify([t?.on ?? null, t?.path ?? null]);
const tryClose = (id) => { if (id) try { closeOverlay(id); } catch {} };

// Closes the panel (its editor keeps running and saves itself) and, unless `refocus` is false (a press outside put the
// keyboard there), gives the keyboard back to where it was before (a pane of the shown space, or a terminal block).
function closePanel(refocus = true) {
  const p = open().panel;
  tryClose(p?.id);
  setOpen({ panel: null });
  if (!refocus) return;
  const b = p?.back, tabs = new Set(spaces().find(s => s.active)?.tabs.map(t => t.id) ?? []);
  if (b?.pane && tabs.has(panes().find(x => x.pane === b.pane)?.tab)) run("pane.focus", { pane: b.pane });
  else if (b?.terminal && !b.pane && live(b.terminal)) focusTerminal(b.terminal);
}

// pane.focus {terminal} through herdr-app, as vscode-explorer's launch.js asks for right clicks: run() shows a miss as
// a toast ("no such pane"), and a terminal block that isn't drawn yet (the panel just opened) or no longer is (a layout
// terminal block that went) is one. Tries `tries` times, `wait` ms apart, silently; true once it took.
async function focusTerminal(address, tries = 1, wait = 0) {
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise(r => setTimeout(r, wait));
    const r = await exec("herdr-app", ["do", "pane.focus", "--terminal", address]).catch(() => null);
    if (r?.code === 0 && !/"error"/.test(r.stdout)) return true;
  }
  return false;
}

// A press on the title bar (edge "move") or a grip: the grab overlay takes the pointer from here.
function grab(edge, e, cx) {
  cx.stop_propagation(); // Herdr would drag the window itself
  const rect = open().panel?.rect;
  if (rect) openOverlay({ mod: MOD, kind: "window", frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1,
    props: { role: "grab", grab: { edge, rect, start: e.position } } });
}

// The floating copy: draws the button, opens, moves and closes the panel, starts the editors.
class Host {
  constructor(cx) {
    tryClose(open().panel?.id); // windows from before a restart or a layout switch are gone
    setShared(OPEN, {});
    this.busy = false; this.down = this.up = this.bounds = null; this.dragged = false;
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "toggle") { this.toggle(cx); cx.notify(); } } });
  }

  toggle(cx) {
    if (open().panel) closePanel(); else this.show(cx);
  }

  // Opens the panel for the shown space's memo (closing one that shows another), its editor started if needed.
  show(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const t = memoTarget(spaces().find(s => s.active), panes());
        const note = !t ? "This space has no folder for a memo." : t.on ? "Memo is local-only for now." : null;
        const address = note ? null : await this.editor(t, cx).catch(() => null);
        // The button's bounds as its last press saw them (window coordinates): the panel opens beside it, and a press on
        // it is no press outside the panel (it toggles the panel itself).
        if (this.bounds && !same(open().button, this.bounds)) setOpen({ button: { ...this.bounds } });
        const rect = panelRect(shared(PANEL), open().button, shared(WIN));
        setShared(PANEL, rect);
        // Where the keyboard was before the panel first opened, for closing it.
        const f = focused(), back = open().panel?.back
          ?? (f && !Object.values(shared(EDITORS) ?? {}).includes(f.terminal) ? { pane: f.pane, terminal: f.terminal } : null);
        this.place({ key: memoKey(t), address, back, note: note ?? (address ? null : "The editor didn't start.") }, rect, cx);
      } finally { this.busy = false; cx.notify(); }
    });
  }

  // (Re)opens the panel window at `rect` with the editor's terminal (or a note), and gives the editor the keyboard (a
  // new window doesn't take it; the grab overlay had it while dragging).
  place(p, rect, cx) {
    tryClose(open().panel?.id);
    const body = { type: "block", content: p.address ? { terminal: p.address } : { mod: MOD, props: { role: "note", note: p.note } } };
    const id = openOverlay({ kind: "window", at: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height, layout: panelLayout(MOD, body) });
    setOpen({ panel: { ...p, id, rect } });
    if (p.address) focusTerminal(p.address, 8, 60);
  }

  // The running editor of memo `t`, else a new one: .herdr/ and the file made, the memo ignored by git, the editor's
  // settings written, then vsedit started off screen; its address once Herdr lists it.
  async editor(t, cx) {
    const known = (shared(EDITORS) ?? {})[t.path];
    if (live(known)) return known;
    await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && touch "$1"', "sh", t.path]);
    await this.ignore(t).catch(() => {});
    const file = `${appHome()}/vscode-memo-settings.json`;
    const user = await readTextFile(`${appHome()}/vscode-settings.json`).catch(() => null);
    await writeTextFile(file, memoSettings(user), await readTextFile(file).catch(() => null));
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--cwd", t.folder, "--label", "vscode-memo=1", "--",
      "/usr/bin/env", `VSEDIT_SETTINGS=${file}`, "/bin/sh", `${appHome()}/mods/vscode-viewer/editor/vsedit.sh`, t.path]);
    const address = r.code === 0 ? JSON.parse(r.stdout).address : null;
    for (let waited = 0; address && !live(address) && waited < 3000; waited += 25) await cx.sleep(25);
    if (!live(address)) return null;
    // Editors of memos no space shows any more end; the rest stay for the next open.
    const memos = new Set(spaces().map(s => memoTarget(s, panes())?.path));
    const kept = {};
    for (const [path, a] of Object.entries({ ...(shared(EDITORS) ?? {}), [t.path]: address })) {
      if (memos.has(path) && live(a)) kept[path] = a; else if (live(a)) hc(["kill", a]).catch(() => {});
    }
    setShared(EDITORS, kept);
    return address;
  }

  // A folder with a .gitignore gets `.herdr/memo.md` appended once, unless git (else a line of it) ignores the memo.
  // Appended only: the rest of the file is never written.
  async ignore(t) {
    const gitignore = `${t.folder}/.gitignore`;
    const text = await readTextFile(gitignore);
    if (text === null) return;
    const r = await exec("git", ["-C", t.folder, "check-ignore", "-q", ".herdr/memo.md"]).catch(() => null);
    const add = gitignoreAddition(text, r?.code === 0 ? true : r?.code === 1 ? false : null);
    if (add) await exec("sh", ["-c", 'printf %s "$2" >> "$1"', "sh", gitignore, add]);
  }

  render(cx) {
    const p = open().panel;
    if (p && !this.busy) {
      const t = memoTarget(spaces().find(s => s.active), panes());
      const r = clampRect(shared(PANEL) ?? p.rect, shared(WIN));
      if (p.address && !live(p.address)) closePanel(); // the editor was quit
      else if (memoKey(t) !== p.key) this.show(cx); // another space's memo
      else if (!same(r, p.rect)) this.place(p, r, cx); // moved or resized
    }
    // The button is the float: Herdr's frame (its background, border, shadow) around the icon. Herdr drags the float on
    // a press nothing stops, so nothing here stops it, and a press only notes where the button is (locally: a shared
    // value set then would redraw every mod mid-press); a click that was a drag (placement().dragging seen since the
    // press, or the pointer moved) doesn't toggle the panel.
    const t = theme(), on = Boolean(p);
    if (placement()?.dragging) this.dragged = true;
    return div().id("memo-button").size(32).flex().items_center().justify_center().cursor_pointer().tooltip("Memo")
      .text_color(on ? t.accent : t.foreground)
      .on_mouse_down("left", (e) => { this.down = e.position; this.up = null; this.dragged = false; this.bounds = e.bounds ?? null; })
      .on_mouse_up("left", (e) => { this.up = e.position; })
      .on_click((_e, cx) => {
        const moved = this.dragged || (this.down && this.up && dragStarted(this.down, this.up));
        this.down = this.up = null; this.dragged = false;
        if (!moved) this.toggle(cx);
      })
      .child(svg(ICON).size(20));
  }
}

// The full-window overlay while the panel is moved or resized: an outline where it will land; the release saves it.
// Escape or another press cancels.
class Grab {
  constructor(cx) {
    this.g = props().grab; this.pos = null; this.win = null;
    this.handle = cx.focus_handle(); this.handle.focus();
  }
  end() { closeOverlay(props().overlay); }
  rect() {
    const g = this.g;
    return clampRect(dragRect(g.rect, g.edge, this.pos.x - g.start.x, this.pos.y - g.start.y, MIN), this.win);
  }
  render() {
    const t = theme(), r = this.pos && dragStarted(this.g.start, this.pos) ? this.rect() : null;
    return div().id("memo-grab").size_full().relative().track_focus(this.handle)
      .on_size_change((size) => {
        this.win = size;
        const w = shared(WIN);
        if (size.width > 0 && (w?.width !== size.width || w?.height !== size.height)) setShared(WIN, { width: size.width, height: size.height });
      })
      .on_key_down((e) => { if (e.key === "escape") this.end(); })
      .on_mouse_move((e, cx) => { this.pos = e.position; cx.notify(); })
      .on_mouse_up("left", (e) => {
        this.pos = e.position;
        if (dragStarted(this.g.start, this.pos)) setShared(PANEL, this.rect());
        this.end();
      })
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.end(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.end(); })
      .when(Boolean(r), el => el.child(div().absolute().left(r.x).top(r.y).w(r.width).h(r.height).rounded(8).border(2)
        .border_color(t.accent).bg(t.accent).opacity(0.25)));
  }
}

// A side or corner of the panel's border: the OS's resize pointer, and a press resizes from there.
const CURSORS = { n: "ns", s: "ns", e: "ew", w: "ew", nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw" };
const gripArea = (edge, el) => el[`cursor_${CURSORS[edge]}_resize`]().on_mouse_down("left", (e, cx) => grab(edge, e, cx));

// The panel's title bar: drags the panel; pin and × on the right. Its top corners are the corner grips' inside (memo.js
// panelLayout), above its own handlers. Unpinned (the default), a press outside the panel closes it, and the keyboard
// stays where that press put it.
function title() {
  const t = theme(), space = spaces().find(s => s.active), pinned = shared(PINNED) === true, inner = CORNER - GRIP;
  const tool = (id, tip, on, child, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(5)
    .cursor_pointer().tooltip(tip).text_color(on ? t.accent : t.muted).when(on, el => el.bg(t.selected))
    .hover(s => s.bg(t.hover).text_color(on ? t.accent : t.foreground))
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); action(); }).child(child);
  return h_flex().id("memo-title").size_full().relative().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .text_size(12.5).text_color(t.foreground).cursor_move()
    .on_mouse_down("left", (e, cx) => grab("move", e, cx))
    .on_mouse_down_out((e) => {
      const o = open();
      if (closesOnPress(e.position, { panel: o.panel?.rect, button: o.button, pinned: shared(PINNED) === true })) closePanel(false);
    })
    .child(svg(ICON).size(14).flex_none().text_color(t.muted))
    .child(div().flex_none().font_semibold().child("Memo"))
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(space?.name ?? ""))
    .child(tool("memo-pin", pinned ? "Unpin memo" : "Pin memo", pinned, svg(PIN).size(16), () => setShared(PINNED, !pinned)))
    .child(tool("memo-close", "Close", false, svg("mods/pane/close.svg").size(16), () => closePanel()))
    .child(gripArea("nw", div().id("memo-corner-nw").absolute().top(0).left(0).size(inner)))
    .child(gripArea("ne", div().id("memo-corner-ne").absolute().top(0).right(0).size(inner)));
}

// A grip block; the bottom-right one shows a resize hint.
function grip() {
  const t = theme(), edge = props().edge;
  return gripArea(edge, div().id(`memo-grip-${edge}`).size_full().relative().bg(t.chrome))
    .when(edge === "se", el => el.child(svg(DOTS).absolute().right(1).bottom(1).size(8).text_color(t.dim)));
}

export default class Memo extends View {
  init(_props, cx) {
    const role = props()?.role, overlay = props()?.overlay;
    if (role === "grab") this.part = new Grab(cx);
    else if (!overlay) this.part = new Host(cx);
  }
  render(cx) {
    if (this.part) return this.part.render(cx);
    const role = props().role, overlay = props().overlay, t = theme();
    // A window this mod no longer opens (an earlier version's always-open button, its size probe: any open window
    // keeps Herdr's pointer popups, the tab and Explorer menus, from opening), or a panel that isn't the one shown
    // (left from before a reload), closes itself.
    if (!["title", "grip", "note"].includes(role) || open().panel?.id !== overlay) { tryClose(overlay); return div(); }
    if (role === "title") return title();
    if (role === "grip") return grip();
    return div().size_full().p(16).bg(t.background).text_color(t.muted).text_size(13).child(props().note ?? "");
  }
}
