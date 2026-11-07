import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, terminals, run, openOverlay, theme, window, shared, layout, settings, hc, exec } from "herdr";
import { tabFileOf, dirtyTabs, shownTabs, TAB_MENU, WARM } from "./tabfile.js";
import { createTabCloser, signalCommand, CLOSE_REQUEST } from "./close.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
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

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.hoverClose = null; // the tab whose close slot the pointer is on
    this.closeAt = null; // the tab menu's last close request taken (close.js CLOSE_REQUEST)
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

  // The side panel (Explorer / Source Control) is one global state: switching spaces leaves it as it is.

  render(cx) {
    this.closeAsked(cx);
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = shownTabs(space, shared(WARM)); // not the Explorer's hidden warm editor tabs
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
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        // A tab showing a file gets VS Code's editor tab menu (vscode-explorer's), any other Herdr's.
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          const file = tabFileOf(c.id, space, panes(), terminals(), shared("vscode-viewer.focused"));
          openOverlay(file ? { mod: "vscode-explorer", kind: "popup", ...TAB_MENU, props: { tabMenu: { ...file, dirty: [...dirty] } } }
            : { mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } });
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
    // An empty saved list (left by an uninstalled layout) would hide every panel button; treat it as unset.
    const saved = shared("workspace.panels"), enabled = (saved?.length ? saved : ["explorer", "changes"]).filter(id => id !== "files");
    // Icon-only, as VS Code's Activity Bar: the label is the tooltip; the shown view gets the foreground color and an accent underline.
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return div().id(`panel-${id}`).size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .border_b(2).border_color(on ? t.accent : t.chrome).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .tooltip(label).accessibility_label(label)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(18));
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("explorer"), el => el.child(panelButton("explorer", "Explorer", "mods/vscode-tabs/files.svg")))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Source Control", "mods/vscode-tabs/source-control.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/vscode-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/vscode-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/vscode-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
