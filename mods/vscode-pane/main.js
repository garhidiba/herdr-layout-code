// A pane's header: the shipped `pane` mod's (the program's icon, the agent's name or the terminal's title, the folder,
// the agent's status; split, zoom and close buttons) plus Move to New Tab while the pane shares its tab (an editor or a
// viewer moved in, vscode-tabs' move.js): it gets a tab of its own again. Props from the app: { pane, terminal }.
// Click: focus the pane. The shipped buttons' icons are the `pane` mod's (always installed). An editor's header also
// passes the presses in its pane on to the editor (click.js), since Herdr keeps Shift+click for its own selection.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, theme, home, shared, setShared, settings, appHome } from "herdr";
import * as fs from "fs/promises";
import { CLICK_DIR, isLocalEditor, clickRecord } from "./click.js";

// vscode-tabs' move.js MOVE_REQUEST: the tab bar moves the pane ({ terminal } or { pane }: a viewer).
const MOVE = "vscode-tabs.move";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// { [pane]: { x, y, width, height } }: where each pane's header is in the window, for vscode-tabs' drag to drop a tab
// onto one pane (Herdr gives mods no pane geometry). A header learns its bounds from GPUI's pointer events: any press
// elsewhere (a tab pressed to drag it) and the pointer moving over it. Written only when it changed; gone panes dropped.
const BOUNDS = "vscode-pane.bounds";
function share(pane, b) {
  if (!b || !pane) return;
  const all = shared(BOUNDS) ?? {}, was = all[pane];
  if (was && was.x === b.x && was.y === b.y && was.width === b.width && was.height === b.height) return;
  const live = new Set(panes().map((p) => p.pane));
  setShared(BOUNDS, { ...Object.fromEntries(Object.entries(all).filter(([k]) => live.has(k))), [pane]: { x: b.x, y: b.y, width: b.width, height: b.height } });
}

// An editor pane's press (click.js): written for vsedit to apply. After a Shift+press, Herdr's selection highlight is
// cleared where Herdr can (terminal.clear_selection and terminals()[].selection, on Herdr's master, not released yet).
function recordClick(e, p, cx) {
  const all = shared(BOUNDS) ?? {};
  const others = panes().filter((x) => x.tab === p.tab && x.pane !== p.pane && all[x.pane]).map((x) => all[x.pane]);
  const rec = clickRecord(e, e.bounds, others, settings()?.terminal_padding, 8, Date.now()); // 8: layouts/vscode.json's pane gap
  if (!rec) return;
  const dir = `${appHome()}/${CLICK_DIR}`, terminal = p.terminal;
  fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(`${dir}/${terminal}.json`, JSON.stringify(rec))).catch(() => {});
  if (rec.kind === "shift") cx.timer.after(250, () => {
    const t = terminals().find((r) => r.address === terminal);
    if (t && "selection" in t && t.selection) run("terminal.clear_selection", { terminal });
  });
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, tip, action) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
      })
      .child(svg(icon).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const shipped = (id, file, tip, command, args) => this.button(t, id, `mods/pane/${file}.svg`, tip, () => run(command, args));
    const source = p.terminal ? { terminal: p.terminal } : p.mod === "vscode-viewer" ? { pane } : null;
    const shared = source && panes().filter((x) => x.tab === p.tab).length > 1;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_mouse_down_out((e, cx) => { share(pane, e.bounds); if (isLocalEditor(p)) recordClick(e, p, cx); })
      .on_mouse_move((e) => share(pane, e.bounds))
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .when(Boolean(shared), el => el.child(this.button(t, `ph-t-${pane}`, "mods/vscode-pane/new-tab.svg", "Move to New Tab",
          () => setShared(MOVE, { ...source, into: null, place: "tab", at: Date.now() }))))
        .child(shipped(`ph-r-${pane}`, "split-right", "Split Right", "pane.split", { direction: "right", pane }))
        .child(shipped(`ph-d-${pane}`, "split-down", "Split Down", "pane.split", { direction: "down", pane }))
        .child(shipped(`ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", p.zoomed ? "Restore" : "Maximize", "pane.zoom", { pane }))
        .child(shipped(`ph-x-${pane}`, "close", "Close", "pane.close", { pane })));
  }
}
