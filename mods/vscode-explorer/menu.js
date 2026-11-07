// The Explorer's right-click menu, its Rename/New/Delete dialogs and the editor tab menu. They run as overlays of this
// same mod (props { menu }, { dialog } or { tabMenu }), so they share the open rule in paths.js with the tree.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, run, spaces, panes, terminals, machines, props, openOverlay, closeOverlay, theme, shared, setShared, appHome, home, readTextFile, writeTextFile, notify, window } from "herdr";
import { createOpenTab } from "./launch.js";
import { createWarmPool, TIMING } from "./warm.js";
import { menuItems, menuHeight, openWith, baseName, parentOf, relativeTo, nameProblem, vscodeRemoteArgs, isMarkdown, editorTabOf,
  tabMenuItems, closeArgs, fileTabs, splitArgs, clipboardCommand, revealCommand, withDetails, DETAILS } from "./paths.js";
import { createOps } from "./ops.js";
import { createRemote, createOpenFile, keysOs, ROOT, INSTALL_COMMAND, INSTALL_REQUEST } from "./remote.js";

// Herdr's terminals() rows, a remote editor's with its argv and labels (details.js): what editorFileOf reads.
export const terminalRows = () => withDetails(terminals(), shared(DETAILS));

// Each local space's warm editor, off screen (warm.js): the tree keeps them (main.js), any open hands one a file.
export const warm = createWarmPool({ hc, run, exec, spaces, panes, terminals, machines, shared, setShared, appHome, home, readTextFile });
// workbench.editor.openTimingLog: each open's steps as JSON lines in <herdr home>/.vscode-open-timing.log (hidden: no
// mod reload), written after the tab is selected so the timing doesn't pay for it.
let timing = [];
const logOpen = (fields) => {
  if (!shared(TIMING)) return;
  timing = [...timing.slice(-49), JSON.stringify(fields)]; // opens that never select (tab.new) don't pile up
  if (fields.step !== "select") return;
  const text = timing.join("\n") + "\n";
  timing = [];
  exec("sh", ["-c", 'printf %s "$1" >> "$2"', "log", text, `${appHome()}/.vscode-open-timing.log`]).catch(() => {});
};
const openTab = createOpenTab({ hc, run, exec, spaces, panes, warm: warm.claim, log: logOpen });
// The editor on a remote space's machine (remote.js): installing it is asked on each open with the shipped confirm dialog,
// whose yes runs INSTALL_COMMAND for the tree (main.js), naming the machine in the shared value INSTALL_REQUEST.
const askInstall = (machine, size) => {
  setShared(INSTALL_REQUEST, { machine, at: Date.now() });
  openOverlay({ mod: "confirm", kind: "dialog", width: 420, height: 180, props: {
    title: `Install the editor on ${machine} (${size})?`,
    detail: `Its files then open in the terminal editor on ${machine}, with its language servers; it goes into ~/${ROOT}. This file opens in the viewer meanwhile (read-only).`,
    command: { name: INSTALL_COMMAND, args: {} },
  } });
};
export const remote = createRemote({ exec, readTextFile, notify, appHome, platform: () => window()?.platform, shared, setShared, confirm: askInstall });
// Every way the Explorer opens a file: the tree's click, Open / Open With, a new file. A file open in an editor tab of
// this space is selected there instead.
const showOpen = (file, on) => {
  const tab = editorTabOf(file, on, spaces().find(s => s.active), panes(), terminalRows());
  if (tab) run("tab.select", { id: tab });
  return Boolean(tab);
};
export const openFile = createOpenFile({ openTab, remote, appHome, showOpen });
const CLIPBOARD = "vscode-explorer.clipboard", REFRESH = "vscode-explorer.refresh";
export const refreshKey = REFRESH;
// The tab menu's Reveal in Explorer View asks the tree: { file, on, at }.
export const REVEAL = "vscode-explorer.reveal";
// The tab menu's Close items ask the tab bar (vscode-tabs' close.js CLOSE_REQUEST): { tabs: [tab.close args], at }.
const TAB_CLOSE = "vscode-tabs.close";

// Herdr starts with PATH=/usr/bin:/bin; Homebrew/user tools (code, trash) live elsewhere.
const sh = (script, ...args) => exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; ' + script, "explorer", ...args]);
const refresh = () => setShared(REFRESH, Date.now());
const os = () => keysOs(window()?.platform);
const osRun = ([cmd, args]) => exec(cmd, args);
const copyText = (text) => osRun(clipboardCommand(os(), text)).catch(() => {});
// Finder's Trash (or the `trash` command when installed); never rm.
const TRASH = 'if command -v trash >/dev/null 2>&1; then trash "$1"; else osascript -e "on run argv" -e "tell application \\"Finder\\" to delete POSIX file (item 1 of argv)" -e "end run" "$1" >/dev/null; fi';

// Opens the menu for an entry: { path (absolute), root, dir, on }.
export function openMenu(target) {
  const rows = menuItems({ dir: target.dir, remote: !!target.on, canPaste: !!shared(CLIPBOARD), markdown: isMarkdown(target.path) });
  openOverlay({ mod: "vscode-explorer", kind: "popup", width: 270, height: menuHeight(rows), props: { menu: target } });
}

const dialog = (spec, height = 196) => openOverlay({ mod: "vscode-explorer", kind: "dialog", width: 440, height, props: { dialog: spec } });
// A machine that can't be reached (or VS Code that can't open it) is a toast; any other failure the small dialog.
const toast = (e) => notify({ title: "Explorer", body: String(e?.message ?? e), level: "error" });

async function paste(folder, on) {
  const clip = shared(CLIPBOARD);
  if (!clip) return;
  await createOps(exec, on).paste(clip, folder);
  if (clip.cut) setShared(CLIPBOARD, null);
}

// VS Code on the path: `code` here, or Remote-SSH for a path on an ssh machine.
export async function openInCode(path, on, dir = false) {
  if (!on) return sh('exec code "$1"', path);
  const r = await hc(["machine", "ls", "--json"]);
  let machine = null;
  try { machine = JSON.parse(r.stdout).machines.find(m => m.name === on); } catch {}
  const args = vscodeRemoteArgs(machine, path, dir);
  if (!args) throw Object.assign(new Error(`${on} isn't a plain ssh machine, so VS Code's Remote-SSH can't open it.`), { unreachable: true });
  const c = await sh('command -v code >/dev/null || { echo "The code command is not installed." >&2; exit 127; }; exec code "$@"', ...args);
  if (c.code !== 0) throw Object.assign(new Error(c.stderr.trim() || "VS Code didn't start"), { unreachable: true });
}

// Plain class composed by the mod's View for a { menu } overlay.
export class ExplorerMenu {
  constructor(cx) {
    this.target = props().menu;
    this.withList = false;
    this.at = -1;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  rows() {
    const t = this.target;
    return this.withList ? openWith(!!t.on) : menuItems({ dir: t.dir, remote: !!t.on, canPaste: !!shared(CLIPBOARD), markdown: isMarkdown(t.path) });
  }

  close() { closeOverlay(props().overlay); }

  choose(action, cx) {
    const t = this.target, folder = t.dir ? t.path : parentOf(t.path);
    if (action === "openWith") { this.withList = true; this.at = -1; return cx.notify(); }
    // Closed once the tab is shown: closing first could end the wait. A second pick meanwhile is ignored.
    const open = (how) => !this.opening && (this.opening = true) && cx.spawn(async cx => { try { await openFile(t.path, { on: t.on, how, folder: t.root }, cx); } finally { this.close(); } });
    if (action === "open") return open("auto");
    if (action === "preview") return open("viewer");
    if (action === "editor" || action === "viewer") return open(action);
    this.close();
    const fail = (e) => e?.unreachable ? toast(e) : dialog({ kind: "error", text: String(e?.message ?? e) }, 150);
    switch (action) {
      case "code": return openInCode(t.path, t.on, t.dir).catch(fail);
      case "system": return exec("open", [t.path]).catch(fail);
      case "reveal": return osRun(revealCommand(os(), t.path)).catch(fail);
      case "terminal": return run("terminal.open", { folder, place: "tab" });
      case "cut": case "copy": return setShared(CLIPBOARD, { path: t.path, dir: t.dir, cut: action === "cut", on: t.on ?? null });
      case "paste": return paste(folder, t.on).then(refresh, fail);
      case "copyPath": return copyText(t.path);
      case "copyRelative": return copyText(relativeTo(t.root, t.path));
      case "newFile": case "newFolder": return dialog({ kind: action, folder, root: t.root, on: t.on });
      case "rename": return dialog({ kind: "rename", path: t.path, root: t.root, on: t.on });
      case "delete": return dialog({ kind: "delete", path: t.path, dir: t.dir, on: t.on }, 170);
    }
  }

  render(cx) {
    const t = theme(), rows = this.rows(), picks = rows.map((r, i) => (r === "-" || r[3] ? -1 : i)).filter(i => i >= 0);
    const move = (d) => { const k = picks.indexOf(this.at); this.at = picks[(k + d + picks.length + (k === -1 && d < 0 ? 1 : 0)) % picks.length]; };
    return v_flex().id("explorer-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") move(1);
        else if (e.key === "up") move(-1);
        else if (e.key === "enter" && this.at >= 0) return this.choose(rows[this.at][1], cx);
        else if (e.key === "escape") return this.close();
        else return;
        cx.notify();
      })
      .children(rows.map((r, i) => r === "-"
        ? div().mx(7).my(4).h(1).bg(t.border)
        : h_flex().id(`em-${i}`).h(26).px(10).gap(9).rounded(5).items_center().justify_between().text_color(r[3] ? t.dim : t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          .when(!r[3], el => el.hover(s => s.bg(t.hover)).cursor_pointer().on_click((_e, cx) => this.choose(r[1], cx)))
          .child(div().flex_1().min_w(0).truncate().child(r[0]))
          .child(div().text_size(11).text_color(t.dim).child(r[2] ?? ""))));
  }
}

// The editor tab menu, for a { tabMenu: { tab, file, on, pane, argv, root, dirty } } overlay (vscode-tabs' tabfile.js): VS Code's
// editor tab context menu, the items Herdr can do (paths.js tabMenuItems). Closing goes through the tab bar as the tab's
// × does: an unsaved editor asks Save / Don't Save / Cancel, one at a time.
export class TabMenu extends ExplorerMenu {
  constructor(cx) {
    super(cx);
    this.target = props().tabMenu;
  }

  rows() {
    const t = this.target;
    // Reopen offers the other editor: the same one would find this tab open (openFile's showOpen) and only select it.
    return this.withList ? openWith(!!t.on).slice(0, 2).filter(r => r[1] !== (t.argv ? "editor" : "viewer"))
      : tabMenuItems({ remote: !!t.on, os: os() });
  }

  choose(action, cx) {
    const t = this.target;
    if (action === "reopenWith") { this.withList = true; this.at = -1; return cx.notify(); }
    // Reopen: the new tab first (closing the old one first could close the space), then the old one.
    if (action === "editor" || action === "viewer") return !this.opening && (this.opening = true) && cx.spawn(async cx => {
      try { await openFile(t.file, { on: t.on, how: action, folder: t.root ?? undefined }, cx); run("tab.close", { id: t.tab }); } finally { this.close(); }
    });
    this.close();
    switch (action) {
      case "close": case "closeOthers": case "closeRight": case "closeSaved": case "closeAll": {
        const space = spaces().find(s => s.tabs.some(x => x.id === t.tab));
        const dirty = new Set(t.dirty ?? []);
        // The tab bar closes them (it outlives this popup): an unsaved editor asks Save / Don't Save / Cancel first.
        return setShared(TAB_CLOSE, { tabs: closeArgs(action, space?.tabs ?? [], t.tab, fileTabs(space, panes(), terminalRows()), dirty), at: Date.now() });
      }
      case "copyPath": return copyText(t.file);
      case "copyRelative": return copyText(t.root ? relativeTo(t.root, t.file) : t.file);
      case "reveal": return osRun(revealCommand(os(), t.file)).catch(toast);
      // The tree follows the focused tab's folder, so the tab is shown first; the tree reveals the file even with
      // explorer.autoReveal off (main.js).
      case "revealExplorer":
        run("tab.select", { id: t.tab });
        run("layout.select", { stack: "panel-body", child: "explorer" });
        run("layout.show", { id: "panel" });
        return setShared(REVEAL, { file: t.file, on: t.on, at: Date.now() });
      case "split": return run("pane.split", splitArgs(t));
    }
  }
}

// Plain class composed by the mod's View for a { dialog } overlay: new file/folder, rename, delete, error.
export class ExplorerDialog {
  constructor(cx) {
    this.spec = props().dialog;
    this.error = null;
    this.handle = cx.focus_handle();
    const k = this.spec.kind;
    if (k === "rename" || k === "newFile" || k === "newFolder") {
      const value = k === "rename" ? baseName(this.spec.path) : "";
      this.input = InputState.new({ value });
      const dot = value.lastIndexOf(".");
      if (value) this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : value.length }); // the stem, like VS Code
      this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      this.input.on("submit", (_e, cx) => this.submit(cx));
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    } else this.handle.focus();
  }

  close() { closeOverlay(props().overlay); }

  async apply(cx) {
    const s = this.spec, ops = createOps(exec, s.on ?? null);
    if (s.kind === "delete") {
      if (s.on) return ops.remove(s.path);
      const r = await sh(TRASH, s.path);
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not move to Trash");
      return;
    }
    const name = this.input.value().trim();
    const folder = s.kind === "rename" ? parentOf(s.path) : s.folder, target = `${folder}/${name}`;
    if (s.kind === "rename" && name === baseName(s.path)) return;
    const problem = nameProblem(name, name && !name.includes("/") && await ops.exists(target));
    if (problem) throw new Error(problem);
    if (s.kind === "newFolder") return ops.mkdir(target);
    if (s.kind === "newFile") {
      if (s.on) await ops.newFile(target); else await writeTextFile(target, "", null);
      await openFile(target, { on: s.on, folder: s.root }, cx);
      return;
    }
    await ops.move(s.path, target);
  }

  submit(cx) {
    if (this.spec.kind === "error") return this.close();
    cx.spawn(async (cx) => {
      try { await this.apply(cx); this.close(); refresh(); }
      catch (e) {
        if (e?.unreachable) { toast(e); return this.close(); }
        this.error = String(e?.message ?? e); cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme(), s = this.spec;
    const title = { newFile: "New File", newFolder: "New Folder", rename: "Rename", error: "Explorer" }[s.kind]
      ?? `Are you sure you want to delete '${baseName(s.path)}'?`;
    const detail = s.kind === "delete" ? (s.on ? `On ${s.on} it goes to the Trash when trash or gio is installed there; otherwise it is deleted for good.`
      : `You can restore this ${s.dir ? "folder" : "file"} from the Trash.`) : s.kind === "error" ? s.text : null;
    const yes = s.kind === "delete" ? (s.on ? "Delete" : "Move to Trash") : s.kind === "error" ? "OK" : s.kind === "rename" ? "Rename" : "Create";
    const button = (id, label, primary, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .cursor_pointer().hover(st => st.opacity(0.88)).on_click(onClick).child(label);
    return v_flex().id("explorer-dialog").track_focus(this.handle).size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter" && !this.input) this.submit(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(detail), el => el.child(div().text_color(t.muted).child(detail)))
      .when(Boolean(this.input), el => el.child(Input.new(this.input).h(34).px(10).rounded(8).border_1()
        .border_color(this.error ? "#e06c75" : t.accent).bg(t.background).text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.error), el => el.child(div().text_size(11.5).text_color("#e06c75").child(this.error)))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8).text_size(12)
        .when(s.kind !== "error", el => el.child(button("ed-no", "Cancel", false, () => this.close())))
        .child(button("ed-yes", yes, true, (_e, cx) => this.submit(cx))));
  }
}
