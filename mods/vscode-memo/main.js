// A quick memo per space: a round button floats over the window; a click opens a panel with that space's
// <folder>/.herdr/memo.md in the terminal editor (vsedit, cut down to a document editor by memo.js MEMO_SETTINGS).
//
// Herdr gives mods no window geometry and moves a window only while it drags it, so this mod places everything itself,
// in window coordinates kept in shared values: the button and the panel are `kind: "window"` overlays opened at their
// spot; a press on the button, the panel's title bar or its border opens a full-window, frameless overlay (role
// "grab", as vscode-tabs' drag overlay) that follows the pointer, shows where it lands and saves the new spot on
// release; the copy of this mod in the layout (layouts/vscode.json's root `floating` block, which draws nothing)
// then reopens the window there. The grab overlay also learns the window's size, which keeps both inside it.
//
// The panel holds the editor's terminal (a layout block `{ terminal }`): started off screen with `hc run --bg` (no
// Herdr labels: no tab shows it, as vscode-explorer's warm editors) and kept running per memo file, so closing the
// panel or switching spaces never ends it; it saves itself 0.5 s after each edit.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, openOverlay, closeOverlay, shared, setShared, spaces, panes, terminals, theme, hc, exec, appHome,
  readTextFile, writeTextFile, nextCommand, run, focused } from "herdr";
import { BUTTON, MIN, memoTarget, clampRect, dragRect, buttonRect, buttonPos, panelRect, gitignoreAddition, memoSettings, dragStarted } from "./memo.js";

const POS = "vscode-memo.button";     // { right, bottom }: the button's spot, from the window's bottom-right corner
const PANEL = "vscode-memo.panel";    // { x, y, width, height }: the panel's
const WIN = "vscode-memo.window";     // { width, height }: the window's size, as the grab overlay last saw it
const OPEN = "vscode-memo.open";      // { button: { id, rect }, panel: { id, rect, key, address, back, note } }: what is shown
const TOGGLE = "vscode-memo.toggle";  // a click on the button (its time): the layout's copy opens or closes the panel
const EDITORS = "vscode-memo.editors"; // { [memo path]: terminal address }: the running memo editors
const MOD = "vscode-memo", ICON = "mods/vscode-memo/memo.svg", GRIP = 5, CORNER = 14, TITLE = 30;

const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const open = () => shared(OPEN) ?? {};
const setOpen = (patch) => setShared(OPEN, { ...open(), ...patch });
const live = (address) => !!address && terminals().some(t => t.address === address);
// Which memo the panel shows: its machine and file.
const memoKey = (t) => JSON.stringify([t?.on ?? null, t?.path ?? null]);
const tryClose = (id) => { if (id) try { closeOverlay(id); } catch {} };
// The window's size, from a full-window overlay's (the probe's, the grab's).
const noteWindow = ({ width, height }) => {
  const w = shared(WIN);
  if (width > 0 && height > 0 && (w?.width !== width || w?.height !== height)) setShared(WIN, { width, height });
};

// Closes the panel and gives the keyboard back to where it was before (a pane of the shown space, or a terminal block).
function closePanel() {
  const p = open().panel;
  tryClose(p?.id);
  setOpen({ panel: null });
  const b = p?.back, tabs = new Set(spaces().find(s => s.active)?.tabs.map(t => t.id) ?? []);
  if (b?.pane && tabs.has(panes().find(x => x.pane === b.pane)?.tab)) run("pane.focus", { pane: b.pane });
  else if (b?.terminal && !b.pane && live(b.terminal)) run("pane.focus", { terminal: b.terminal });
}

// A press on the button, the title bar (edge "move") or the border: the grab overlay takes the pointer from here.
function grab(target, edge, rect, e, cx) {
  cx.stop_propagation(); // Herdr would drag the window itself
  if (rect) openOverlay({ mod: MOD, kind: "window", frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1,
    props: { role: "grab", grab: { target, edge, rect, start: e.position } } });
}

// The copy in the layout: shows the button, opens, moves and closes the panel, starts the editors.
class Host {
  constructor(cx) {
    const o = open(); // windows from before a restart or a layout switch are gone
    tryClose(o.button?.id); tryClose(o.panel?.id);
    setShared(OPEN, {});
    // The window's size (the button's spot is from its bottom-right corner): a full-window overlay that closes as
    // soon as it is laid out.
    openOverlay({ mod: MOD, kind: "window", frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1, props: { role: "probe" } });
    this.toggleAt = shared(TOGGLE); this.busy = false;
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
        const win = shared(WIN) ?? { width: 1200, height: 800 };
        const rect = panelRect(shared(PANEL), open().button?.rect ?? buttonRect(shared(POS), win), win);
        setShared(PANEL, rect);
        // Where the keyboard was before the panel first opened, for closing it.
        const f = focused(), back = open().panel?.back
          ?? (f && !Object.values(shared(EDITORS) ?? {}).includes(f.terminal) ? { pane: f.pane, terminal: f.terminal } : null);
        this.place({ key: memoKey(t), address, back, note: note ?? (address ? null : "The editor didn't start.") }, rect, cx);
      } finally { this.busy = false; cx.notify(); }
    });
  }

  // (Re)opens the panel window at `rect`: a title bar, the border's grips and the editor's terminal (or a note), and
  // gives the editor the keyboard (a new window doesn't take it; the grab overlay had it while dragging).
  place(p, rect, cx) {
    tryClose(open().panel?.id);
    const grip = (edge, px) => ({ type: "block", ...(px ? { size: { px } } : {}), content: { mod: MOD, props: { role: "grip", edge } } });
    const body = p.address ? { type: "block", content: { terminal: p.address } } : { type: "block", content: { mod: MOD, props: { role: "note", note: p.note } } };
    const id = openOverlay({ kind: "window", at: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height, layout: { type: "column", children: [
      { type: "row", size: { px: GRIP }, children: [grip("nw", CORNER), grip("n"), grip("ne", CORNER)] },
      { type: "block", size: { px: TITLE }, content: { mod: MOD, props: { role: "title" } } },
      { type: "row", children: [grip("w", GRIP), body, grip("e", GRIP)] },
      { type: "row", size: { px: GRIP }, children: [grip("sw", CORNER), grip("s"), grip("se", CORNER)] },
    ] } });
    setOpen({ panel: { ...p, id, rect } });
    if (p.address) cx.timer.after(50, () => { if (open().panel?.id === id) run("pane.focus", { terminal: p.address }); });
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
    const o = open(), win = shared(WIN);
    // The button where it was left (kept inside the window), once the window's size is known.
    const b = win && buttonRect(shared(POS), win);
    if (b && !same(o.button?.rect, b)) {
      tryClose(o.button?.id);
      setOpen({ button: { id: openOverlay({ mod: MOD, kind: "window", frame: "none", at: { x: b.x, y: b.y }, width: BUTTON, height: BUTTON,
        props: { role: "button" } }), rect: b } });
    }
    const ask = shared(TOGGLE);
    if (ask !== this.toggleAt) { this.toggleAt = ask; this.toggle(cx); }
    const p = open().panel;
    if (p && !this.busy) {
      const t = memoTarget(spaces().find(s => s.active), panes());
      const r = clampRect(shared(PANEL) ?? p.rect, win);
      if (p.address && !live(p.address)) closePanel(); // the editor was quit
      else if (memoKey(t) !== p.key) this.show(cx); // another space's memo
      else if (!same(r, p.rect)) this.place(p, r, cx); // moved or resized
    }
    return div();
  }
}

// The full-window overlay while the button or the panel is dragged: an outline where it will land; the release saves
// that spot (a press that didn't move is a click on the button: TOGGLE). Escape or another press cancels.
class Grab {
  constructor(cx) {
    this.g = props().grab; this.pos = null; this.win = null;
    this.handle = cx.focus_handle(); this.handle.focus();
  }
  end() { closeOverlay(props().overlay); }
  moved() { return !!this.pos && dragStarted(this.g.start, this.pos); }
  rect() {
    const g = this.g, min = g.target === "button" ? { width: BUTTON, height: BUTTON } : MIN;
    return clampRect(dragRect(g.rect, g.edge, this.pos.x - g.start.x, this.pos.y - g.start.y, min), this.win);
  }
  render() {
    const t = theme(), g = this.g, r = this.moved() ? this.rect() : null;
    return div().id("memo-grab").size_full().relative().track_focus(this.handle)
      .on_size_change((size) => { this.win = size; noteWindow(size); })
      .on_key_down((e) => { if (e.key === "escape") this.end(); })
      .on_mouse_move((e, cx) => { this.pos = e.position; cx.notify(); })
      .on_mouse_up("left", (e) => {
        this.pos = e.position;
        if (!this.moved()) { if (g.target === "button") setShared(TOGGLE, Date.now()); }
        else if (g.target === "button") { if (this.win) setShared(POS, buttonPos(this.rect(), this.win)); }
        else setShared(PANEL, this.rect());
        this.end();
      })
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.end(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.end(); })
      .when(Boolean(r), el => el.child(g.target === "button"
        ? div().absolute().left(r.x).top(r.y).size(BUTTON).rounded_full().bg(t.accent).opacity(0.6)
        : div().absolute().left(r.x).top(r.y).w(r.width).h(r.height).rounded(8).border(2).border_color(t.accent).bg(t.accent).opacity(0.25)));
  }
}

// The floating button, a memo icon on a circle.
function button() {
  const t = theme();
  return div().id("memo-button").size(BUTTON).rounded_full().flex().items_center().justify_center().cursor_pointer()
    .bg(t.raised).border(1).border_color(t.border).shadow_sm().text_color(t.muted)
    .hover(s => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (e, cx) => grab("button", "move", open().button?.rect, e, cx))
    .child(svg(ICON).size(18));
}

// The panel's title bar: drags the panel; × closes it (the editor keeps running and has saved).
function title() {
  const t = theme(), space = spaces().find(s => s.active);
  const close = (_e, cx) => { cx.stop_propagation(); closePanel(); };
  return h_flex().id("memo-title").size_full().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .text_size(12.5).text_color(t.foreground).cursor_move()
    .on_mouse_down("left", (e, cx) => grab("panel", "move", open().panel?.rect, e, cx))
    .child(svg(ICON).size(14).flex_none().text_color(t.muted))
    .child(div().flex_none().font_semibold().child("Memo"))
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(space?.name ?? ""))
    .child(div().id("memo-close").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", close).child("×"));
}

// A side or corner of the panel's border: the OS's resize pointer, and a press resizes from there.
const CURSORS = { n: "ns", s: "ns", e: "ew", w: "ew", nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw" };
function grip() {
  const t = theme(), edge = props().edge;
  return div().id(`memo-grip-${edge}`).size_full().bg(t.chrome)[`cursor_${CURSORS[edge]}_resize`]()
    .on_mouse_down("left", (e, cx) => grab("panel", edge, open().panel?.rect, e, cx));
}

export default class Memo extends View {
  init(_props, cx) {
    const role = props()?.role;
    if (role === "grab") this.part = new Grab(cx);
    else if (!role) this.part = new Host(cx);
    else if (role === "probe") cx.timer.after(1000, () => tryClose(props().overlay)); // closes itself even unsized
  }
  render(cx) {
    if (this.part) return this.part.render(cx);
    const role = props().role, t = theme();
    if (role === "probe") return div().id("memo-probe").size_full().on_size_change((size) => { noteWindow(size); tryClose(props().overlay); });
    if (role === "button") return button();
    if (role === "title") return title();
    if (role === "grip") return grip();
    return div().size_full().p(16).bg(t.background).text_color(t.muted).text_size(13).child(props().note ?? "");
  }
}
