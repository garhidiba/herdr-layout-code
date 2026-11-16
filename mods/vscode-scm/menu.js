// The right-click menus of a changed file and of the Changes header (actions.js has their rules). They run as a popup
// of this same mod (props { menu }), drawn as the Explorer's menu (vscode-explorer menu.js). Git steps go to the panel
// (main.js runRequest) through the shared GIT_REQUEST and the command `vscode-scm.git`, so its busy label, error note
// and refresh are Commit's; Discard asks first with Herdr's shipped confirm dialog, whose yes sends that command.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run, props, openOverlay, closeOverlay, theme, setShared, appHome, window } from "herdr";
import { parseStatus, fileState, groupState, fileMenuItems, groupMenuItems, menuHeight, actionSteps, confirmOf, keysOs, clipboardCommand, revealCommand } from "./actions.js";

export const GIT_REQUEST = "vscode-scm.git-request";
// The Explorer's Reveal in Explorer View request (vscode-explorer menu.js REVEAL): { file, on, at }.
const REVEAL = "vscode-explorer.reveal";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "--literal-pathspecs"];

const short = (hash) => hash ? hash.slice(0, 7) : "∅";
export const baseName = (path) => path.split("/").pop();
// A diff tab named as VS Code names it: "<old name> (<left>) ↔ <name> (<right>)". commit null: HEAD ↔ the working tree.
export function openDiff(repo, on, file, commit, parent) {
  const left = commit ? short(parent) : "HEAD", right = commit ? short(commit) : "Working Tree";
  run("tab.new", { name: `${baseName(file.oldPath ?? file.path)} (${left}) ↔ ${baseName(file.path)} (${right})`, mod: "vscode-diff",
    props: { repo, commit, parent: commit ? parent : "HEAD", path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), on } });
}
// Open File as vscode-diff's button: the terminal editor in a tab of its own; images and remote files in the viewer.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?)$/i;
const openFileArgs = (file, folder, on) => (on || IMAGE.test(file) ? { name: baseName(file), mod: "vscode-viewer", props: { file, on } }
  : { name: baseName(file), folder, argv: ["exec", "sh", `${appHome()}/mods/vscode-viewer/editor/vsedit.sh`, file, "--close-on-exit"] });

const rowsOf = (m) => m.kind === "file" ? fileMenuItems(m.state, { remote: !!m.on }) : groupMenuItems(m.state, { hasHead: m.hasHead });

// Reads the file's (or, for the header, the repo's) status now, so the menu matches the repo and not the last refresh,
// then opens the popup. { kind: "file" | "group", root, on, path?, hasHead }.
export async function openScmMenu(target) {
  const r = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", ...(target.path ? ["--", target.path] : [])], { cwd: target.root, on: target.on });
  if (r.code !== 0) return;
  const entries = parseStatus(r.stdout);
  const menu = { ...target, state: target.kind === "file" ? fileState(entries.find((e) => e.path === target.path)?.xy) : groupState(entries) };
  const rows = rowsOf(menu);
  if (rows.length) openOverlay({ mod: "vscode-scm", kind: "popup", width: 270, height: menuHeight(rows), props: { menu } });
}

const LABEL = { stage: "Stage Changes", unstage: "Unstage Changes", discard: "Discard Changes", ignore: "Add to .gitignore",
  stageAll: "Stage All Changes", unstageAll: "Unstage All Changes", discardAll: "Discard All Changes" };

// Plain class composed by the panel's View for a { menu } overlay.
export class ScmMenu {
  constructor(cx) {
    this.target = props().menu;
    this.at = -1;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() { closeOverlay(props().overlay); }

  choose(action) {
    const m = this.target, file = m.path ? `${m.root}/${m.path}` : m.root, os = keysOs(window()?.platform);
    this.close();
    switch (action) {
      case "diff": return openDiff(m.root, m.on, { path: m.path }, null, null);
      case "open": return run("tab.new", openFileArgs(file, m.root, m.on));
      case "copyPath": return exec(...clipboardCommand(os, file)).catch(() => {});
      case "copyRelative": return exec(...clipboardCommand(os, m.path)).catch(() => {});
      case "reveal": return m.on ? undefined : exec(...revealCommand(os, file)).catch(() => {});
      // As the tab menu's: the Explorer page shows, and the tree reveals the file when it shows this folder's machine.
      case "revealExplorer":
        run("layout.select", { stack: "panel-body", child: "explorer" });
        run("layout.show", { id: "panel" });
        return setShared(REVEAL, { file, on: m.on ?? null, at: Date.now() });
    }
    const steps = actionSteps(action, m);
    if (!steps) return;
    setShared(GIT_REQUEST, { root: m.root, on: m.on ?? null, steps, label: LABEL[action], at: Date.now() });
    const ask = confirmOf(action, { path: m.path, state: m.state, count: m.state.count });
    if (ask) openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 170, props: { ...ask, command: { name: "vscode-scm.git", args: {} } } });
    else run("vscode-scm.git", {});
  }

  render(cx) {
    const t = theme(), rows = rowsOf(this.target), picks = rows.map((r, i) => (r === "-" ? -1 : i)).filter((i) => i >= 0);
    const move = (d) => { const k = picks.indexOf(this.at); this.at = picks[(k + d + picks.length + (k === -1 && d < 0 ? 1 : 0)) % picks.length]; };
    return v_flex().id("scm-menu").track_focus(this.handle).w_full().max_h(480).overflow_y_scrollbar().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") move(1);
        else if (e.key === "up") move(-1);
        else if (e.key === "enter" && this.at >= 0) return this.choose(rows[this.at][1]);
        else if (e.key === "escape") return this.close();
        else return;
        cx.notify();
      })
      .children(rows.map((r, i) => r === "-"
        ? div().mx(7).my(4).h(1).bg(t.border)
        : h_flex().id(`sm-${i}`).h(26).px(10).gap(9).rounded(5).items_center().justify_between().text_color(t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover)).cursor_pointer().on_click(() => this.choose(r[1]))
          .child(div().flex_1().min_w(0).truncate().child(r[0]))
          .child(div().text_size(11).text_color(t.dim).child(r[2] ?? ""))));
  }
}
