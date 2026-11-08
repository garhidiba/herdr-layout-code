import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, terminals, run, openOverlay, closeOverlay, props, theme, window, shared, setShared, layout, settings, hc, exec, notify } from "herdr";
import { tabFileOf, dirtyTabs, TAB_MENU, withDetails, DETAILS } from "./tabfile.js";
import { createTabCloser, signalCommand, CLOSE_REQUEST } from "./close.js";
import { createMover, withViewer, fileByName, MOVE_REQUEST, VIEWER_FILES } from "./move.js";
import { reconcileSide, sideMax, sashStart, sashDrag, workWidth } from "./side.js";
import { find, dragStarted, panesRect, headersRect, paneRects, dropTarget, dropZone, zoneRect, dragSource, panelButtonRect, DRAG_BACK } from "./drag.js";
// side.js' remembered width of the side panel while it is hidden (shared values outlive a restart).
const PANEL_WIDTH = "vscode-tabs.panel-width";
// side.js' last commands that never showed in the layout ({ at, want, got, commands }), for debugging.
const SIDE_DEBUG = "vscode-tabs.side-debug";
// How often the side row is reconciled besides renders (ms): often while the Image Viewer shows (its gutter pushes the
// row), rarely otherwise.
const SIDE_TICK = { image: 100, idle: 1000 };
// vscode-pane's { [pane]: bounds }: where each shown pane's header is, for dropping onto one pane.
const PANE_BOUNDS = "vscode-pane.bounds";

// The Image Viewer's own column, right of the side panel (layouts/vscode.json): its button shows and hides it alone.
const IMAGE_COLUMN = "image-panel";
// The side panel's pages and the Image Viewer, as the bar's buttons show them (left to right): [id, label, icon].
const PANELS = [
  ["explorer", "Explorer", "mods/vscode-tabs/files.svg"],
  ["changes", "Source Control", "mods/vscode-tabs/source-control.svg"],
  ["image", "Image Viewer", "mods/vscode-tabs/image.svg"],
];
// The pages with a button: the shared `workspace.panels`. An empty saved list (left by an uninstalled layout) would hide
// every panel button; treat it as unset.
function shownPanels() {
  const saved = shared("workspace.panels"), enabled = saved?.length ? saved : ["explorer", "changes", "image"];
  return PANELS.filter(([id]) => enabled.includes(id));
}

// Asks the editor in terminal `address` to close (close.js): its first process from hc, signalled on its machine.
async function requestClose(address) {
  try {
    const pid = JSON.parse((await hc(["get", address, "--json"])).stdout).pid;
    if (!Number.isInteger(pid)) return false;
    const [command, args] = signalCommand(pid);
    return (await exec(command, args, { on: address.includes("/") ? address.split("/")[0] : null })).code === 0;
  } catch {
    return false;
  }
}
const closeTabs = createTabCloser({ run, panes, requestClose });
// A viewer's file: as its opener (or the viewer, once clicked) recorded it, else as the viewer shared it when it was last
// focused, else the one known file named as its tab is (move.js fileByName).
const viewerOf = (pane) => {
  const focusedViewer = shared("vscode-viewer.focused"), files = shared(VIEWER_FILES) ?? {};
  const tab = panes().find(p => p.pane === pane)?.tab, name = spaces().flatMap(s => s.tabs).find(t => t.id === tab)?.name;
  return files[pane] ?? (focusedViewer?.pane === pane ? focusedViewer : null) ?? fileByName(name, [...Object.values(files), focusedViewer]);
};
const movePane = createMover({ run, panes, spaces, viewerOf,
  remember: (pane, file) => setShared(VIEWER_FILES, withViewer(shared(VIEWER_FILES), new Set(panes().map(p => p.pane)), pane, file)),
  fail: (body) => notify({ title: "Move", body, level: "error" }) });

// A drag once it left its source, a tab out of the bar or a file out of vscode-explorer's tree (drag.js, its props): a
// full-window, frameless overlay of this mod that follows the pointer over the shown tab's panes, shows where the drop
// will land and asks the source's `request` on release. Escape, a release outside the panes or any new press cancels;
// the pointer back over `back` hands the drag back.
class DragOverlay {
  constructor(cx) {
    this.drag = props().drag;
    this.win = null;
    this.pos = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  end() { closeOverlay(props().overlay); }

  // The pane under `pos` and its zone (drag.js dropTarget), from the shown tab's pane headers' bounds (vscode-pane).
  target(pos) {
    if (!this.win || !pos) return null;
    const d = this.drag, headers = shared(PANE_BOUNDS), ids = panes().filter(p => p.tab === d.into).map(p => p.pane);
    const area = d.bar ? panesRect(d.bar, this.win, layout()) : headersRect(headers, ids, this.win, layout());
    return area && dropTarget(paneRects(headers, ids, area), area, pos);
  }

  // An image's other target, the Image Viewer's panel button (drag.js panelButtonRect), and whether `pos` is on it.
  imageButton(pos) {
    if (!this.drag.image || !this.win) return null;
    const rect = panelButtonRect(this.win, layout(), shownPanels().map(([id]) => id), "image", window()?.buttons);
    const near = rect && { x: rect.x - 4, y: rect.y - 4, width: rect.width + 8, height: rect.height + 8 };
    return rect && { rect, over: Boolean(pos && dropZone(near, pos)) };
  }

  render() {
    const t = theme(), d = this.drag, button = this.imageButton(this.pos), hit = button?.over ? null : this.target(this.pos);
    const area = hit && zoneRect(hit.rect, hit.zone);
    const box = (r) => div().absolute().left(r.x).top(r.y).w(r.width).h(r.height);
    return div().id("tab-drag").size_full().relative().track_focus(this.handle)
      .on_size_change((size) => { this.win = size; })
      .on_key_down((e) => { if (e.key === "escape") this.end(); })
      .on_mouse_move((e, cx) => {
        if (d.back && dropZone(d.back, e.position)) { setShared(DRAG_BACK, d.id); return this.end(); }
        this.pos = e.position; cx.notify();
      })
      .on_mouse_up("left", (e) => {
        if (this.imageButton(e.position)?.over) {
          setShared(d.image, { ...d.source, at: Date.now() });
          run("layout.show", { id: IMAGE_COLUMN });
          return this.end();
        }
        const drop = this.target(e.position);
        if (drop && d.request) setShared(d.request, { ...d.source, into: d.into, place: drop.zone, beside: drop.beside, at: Date.now() });
        this.end();
      })
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.end(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.end(); })
      .when(Boolean(area), el => el.child(box(area).bg(t.accent).opacity(0.2)).child(box(area).border(2).border_color(t.accent).rounded(4)))
      // While an image is dragged its button is ringed; on it, filled.
      .when(Boolean(button), el => el.when(button.over, el => el.child(box(button.rect).bg(t.accent).opacity(0.25).rounded(6)))
        .child(box(button.rect).border(2).border_color(t.accent).rounded(6)))
      .when(Boolean(this.pos), el => el.child(div().absolute().left(this.pos.x + 12).top(this.pos.y + 10).px(8).py(3).rounded(6)
        .bg(t.raised).border(1).border_color(t.border).text_size(12.8).text_color(t.foreground).child(button?.over ? `Open ${d.title} in Image Viewer` : d.title)));
  }
}

// The sash between the side panel and the Image Viewer column (side.js): drawn by vscode-explorer, vscode-scm and
// vscode-viewer, whose press opens this frameless full-window overlay (props { sideResize: { x } }) because the pointer
// soon leaves the 8 px. Each move sizes the column and the row together (sashDrag); a release, a press or Escape ends it.
class SideResize {
  constructor(cx) {
    this.from = sashStart(layout(), props().sideResize?.x);
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.win = null;
    this.last = null;
  }
  end() { closeOverlay(props().overlay); }
  render() {
    return div().id("side-resizing").size_full().cursor_col_resize().track_focus(this.handle)
      .on_size_change((size) => { this.win = size; })
      .on_key_down((e) => { if (e.key === "escape") this.end(); })
      .on_mouse_move((e) => {
        const tree = layout(), commands = sashDrag(tree, this.from, e.position.x, this.win ? workWidth(tree, this.win.width) : NaN);
        const key = JSON.stringify(commands);
        if (key === this.last) return;
        this.last = key;
        for (const [name, args] of commands) run(name, args);
      })
      .on_mouse_up("left", () => this.end())
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.end(); });
  }
}

export default class Tabs extends View {
  init(_props, cx) {
    if (props()?.drag) return void (this.dragView = new DragOverlay(cx));
    if (props()?.sideResize) return void (this.dragView = new SideResize(cx));
    this.pressed = null;
    this.press = null; // { id, title, at }: the tab pressed and where, until a release or a drag out of the bar
    this.dragging = false;
    this.bar = null; // the bar's window bounds, from the pointer's moves over it
    this.hoverClose = null; // the tab whose close slot the pointer is on
    this.closeAt = null; // the tab menu's last close request taken (close.js CLOSE_REQUEST)
    this.moveAt = null; // the menus' last move request taken (move.js MOVE_REQUEST)
    this.side = null; // side.js reconcileSide's `seen`
    this.work = null; // the bar's width: the work column's, for side.js sideMax
    // A render may not follow a layout change made elsewhere (the Explorer's menu, cmd-e, a gutter drag): a timer too.
    cx.spawn(async (cx) => {
      for (;;) {
        this.sideAsked(cx);
        await cx.sleep(find(layout(), "image-panel")?.hidden === false ? SIDE_TICK.image : SIDE_TICK.idle);
      }
    });
  }

  closeList(list, cx) { // not close(): that is the View's own end call
    cx.spawn(async (cx) => closeTabs(list, (ms) => cx.sleep(ms)));
  }

  // The tab menu's Close items (vscode-explorer, an overlay that closes at once) leave their tabs here: once each,
  // dropped after 5s (shared values outlive a restart).
  closeAsked(cx) {
    const ask = shared(CLOSE_REQUEST);
    if (!Array.isArray(ask?.tabs) || ask.at === this.closeAt || Date.now() - ask.at > 5000) return;
    this.closeAt = ask.at;
    this.closeList(ask.tabs, cx);
  }

  // The menus' Move into Tab / Move to New Tab (vscode-explorer's tab menu, vscode-menu), the pane header's (vscode-pane)
  // and the drag leave a move here, the same way.
  moveAsked(cx) {
    const ask = shared(MOVE_REQUEST);
    if ((typeof ask?.terminal !== "string" && typeof ask?.pane !== "string") || ask.at === this.moveAt || Date.now() - ask.at > 5000) return;
    this.moveAt = ask.at;
    cx.spawn(async (cx) => movePane(ask, (ms) => cx.sleep(ms)));
  }

  // The `side` row's width follows the side panel and the Image Viewer column showing or hiding (side.js).
  sideAsked(cx) {
    const kept = shared(PANEL_WIDTH), mem = Number.isFinite(kept) ? kept : null;
    const tree = layout(), r = reconcileSide(tree, this.side, mem, Date.now(), sideMax(tree, this.work));
    this.side = r.seen;
    if (!r.commands.length && r.mem === mem) return;
    cx.spawn(async () => {
      if (r.missed) setShared(SIDE_DEBUG, { at: Date.now(), ...r.missed, commands: r.commands });
      if (r.mem !== mem) setShared(PANEL_WIDTH, r.mem);
      for (const [name, args] of r.commands) run(name, args);
    });
  }

  // The side panel (Explorer / Source Control) is one global state: switching spaces leaves it as it is.

  // A press dragged out of the bar: the overlay takes it over when the tab has one pane to move into the shown tab.
  dragOut(space) {
    const p = this.press, active = space?.tabs.find(c => c.active)?.id;
    this.press = null; this.pressed = null; this.dragging = false;
    const source = p && this.bar ? dragSource(p.id, active, panes()) : null;
    if (source) openOverlay({ mod: "vscode-tabs", kind: "window", frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1,
      props: { drag: { source, request: MOVE_REQUEST, into: active, title: p.title, bar: this.bar } } });
  }

  render(cx) {
    if (this.dragView) return this.dragView.render(cx);
    this.closeAsked(cx);
    this.moveAsked(cx);
    this.sideAsked(cx);
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const dirty = dirtyTabs(space, panes());
    // A tab's × on the space's last tab closes without Herdr's "Close space?": vscode-spaces keeps the space as a gray row.
    // An unsaved editor asks first (close.js).
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).when(this.dragging && this.press?.id === c.id, el => el.opacity(0.5))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation(); this.pressed = i; this.press = { id: c.id, title: name, at: e.position };
          if (e.click_count === 2) run("tab.rename", { id: c.id });
        })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        // A tab showing a file gets VS Code's editor tab menu (vscode-explorer's), any other Herdr's items with Move into
        // tab… (vscode-menu: rows of 31px, a separator, 10px padding; the move only for a tab of one terminal).
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          const file = tabFileOf(c.id, space, panes(), withDetails(terminals(), shared(DETAILS)), shared("vscode-viewer.focused"));
          // Its rows: Rename, New tab, Move into tab… (a tab of one terminal), Move ‹pane› to new tab for each of several panes, Close.
          const mine = panes().filter(p => p.tab === c.id), movable = shown.length > 1 && mine.length === 1 && mine[0].terminal;
          const rows = 3 + (movable ? 1 : 0) + (mine.length > 1 ? mine.length : 0);
          openOverlay(file ? { mod: "vscode-explorer", kind: "popup", ...TAB_MENU, props: { tabMenu: { ...file, dirty: [...dirty] } } }
            : { mod: "vscode-menu", kind: "popup", width: 240, height: 19 + 31 * rows, props: { tab: "tab", target: { id: c.id, space: space.id } } });
        })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        // As VS Code's: an unsaved editor's tab shows ● where the × goes, on every tab, and × while the pointer is on it.
        .when(c.active || dirty.has(c.id), el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop)
          .on_hover((on, cx) => { if (on || this.hoverClose === c.id) { this.hoverClose = on ? c.id : null; cx.notify(); } })
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeList([shown.length === 1 ? { id: c.id, confirmed: true } : { id: c.id }], cx); })
          .child(dirty.has(c.id) && this.hoverClose !== c.id
            ? div().size(12).flex().items_center().justify_center().child(div().size(8).rounded(4).bg(c.active ? t.foreground : t.muted))
            : svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Icon-only, as VS Code's Activity Bar: the label is the tooltip; the shown view gets the foreground color and an accent underline.
    const imageColumn = find(root, IMAGE_COLUMN);
    const panelButton = (id, label, icon) => {
      const on = id === "image" ? Boolean(imageColumn && !imageColumn.hidden) : panel && !panel.hidden && body?.active === id;
      return div().id(`panel-${id}`).size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .border_b(2).border_color(on ? t.accent : t.chrome).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .tooltip(label).accessibility_label(label)
        .on_click((_e, cx) => {
          if (id === "image") run(on ? "layout.hide" : "layout.show", { id: IMAGE_COLUMN });
          else if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
          this.sideAsked(cx); // the row's width at once, when the layout already shows the change
        }).child(svg(icon).size(18));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_size_change((s) => { this.work = s.width; })
      .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.press = null; if (this.dragging) { this.dragging = false; cx.notify(); } })
      // A press on a tab dragged past THRESHOLD is a drag (the tab dims); leaving the bar hands it to the overlay.
      .on_mouse_move((e, cx) => {
        this.bar = e.bounds;
        if (this.press && !this.dragging && dragStarted(this.press.at, e.position)) { this.dragging = true; cx.notify(); }
      })
      .on_hover((on) => { if (!on && this.dragging) this.dragOut(space); })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item))
        // New tab sits right after the last tab, as a browser's does.
        .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))))
      .children(shownPanels().map(([id, label, icon]) => panelButton(id, label, icon)))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/vscode-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/vscode-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/vscode-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
