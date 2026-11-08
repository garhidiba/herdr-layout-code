// The Explorer's right-click menu, its Rename/New/Delete dialogs and the editor tab menu. They run as overlays of this
// same mod (props { menu }, { dialog } or { tabMenu }), so they share the open rule in paths.js with the tree.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, run, spaces, panes, terminals, machines, props, openOverlay, closeOverlay, theme, shared, setShared, appHome, home, readTextFile, writeTextFile, notify, window } from "herdr";
import { createOpenTab, noteViewer } from "./launch.js";
import { createWarmPool, TIMING } from "./warm.js";
import { menuItems, menuHeight, openWith, baseName, parentOf, relativeTo, nameProblem, vscodeRemoteArgs, isMarkdown, isImage, editorPaneOf, viewerPaneOf, wantsEditor,
  tabMenuItems, moveRows, outRows, moveOf, closeArgs, fileTabs, splitArgs, clipboardCommand, revealCommand, withDetails, deleteTitle, extraLines, closesForDeleted, DETAILS } from "./paths.js";
import { createOps } from "./ops.js";
import { createSplitOpen } from "./split.js";
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
// Each viewer pane the Explorer opens, { [pane]: { file, on } } (vscode-tabs' move.js VIEWER_FILES; gone panes dropped).
const VIEWER_FILES = "vscode-viewer.files";
const rememberViewer = (pane, file) => {
  const live = new Set(panes().map(p => p.pane));
  setShared(VIEWER_FILES, { ...Object.fromEntries(Object.entries(shared(VIEWER_FILES) ?? {}).filter(([k]) => live.has(k))), [pane]: file });
};
// A deleted file's or folder's tabs and panes close, but not unsaved editors (paths.js closesForDeleted).
const closeDeleted = (path, on) => closesForDeleted(path, on, { spaces: spaces(), panes: panes(), terminals: terminalRows(),
  viewers: shared(VIEWER_FILES), focusedViewer: shared("vscode-viewer.focused") }).forEach(([name, args]) => run(name, args));
const openTab = createOpenTab({ hc, run, exec, spaces, panes, warm: warm.claim, log: logOpen, remember: rememberViewer });
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
// this space (a viewer's file: in a viewer tab) is selected there instead.
const openPaneOf = (file, on, editor = wantsEditor(file)) => {
  const space = spaces().find(s => s.active);
  return editor ? editorPaneOf(file, on, space, panes(), terminalRows())
    : viewerPaneOf(file, on, space, panes(), shared(VIEWER_FILES), shared("vscode-viewer.focused"));
};
const showOpen = (file, on, editor) => {
  const pane = openPaneOf(file, on, editor);
  if (pane) { run("tab.select", { id: pane.tab }); run("pane.focus", { pane: pane.pane }); } // it may share its tab
  return Boolean(pane);
};
export const openFile = createOpenFile({ openTab, remote, appHome, showOpen });
const CLIPBOARD = "vscode-explorer.clipboard", REFRESH = "vscode-explorer.refresh";
export const refreshKey = REFRESH;
// The tab menu's Reveal in Explorer View asks the tree: { file, on, at }.
export const REVEAL = "vscode-explorer.reveal";
// The tab menu's Close items ask the tab bar (vscode-tabs' close.js CLOSE_REQUEST): { tabs: [tab.close args], at }.
const TAB_CLOSE = "vscode-tabs.close";
// Move into Tab / Move to New Tab ask the tab bar too (vscode-tabs' move.js MOVE_REQUEST).
const MOVE = "vscode-tabs.move";
// A file dragged from the tree onto a pane opens beside it (split.js; the tree runs the drop's request).
export const splitOpen = createSplitOpen({ run, panes, open: openFile,
  openPane: (file, on) => openPaneOf(file, on, true),
  move: (request) => setShared(MOVE, { ...request, at: Date.now() }) });

// Herdr starts with PATH=/usr/bin:/bin; Homebrew/user tools (code, trash) live elsewhere.
const sh = (script, ...args) => exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; ' + script, "explorer", ...args]);
const refresh = () => setShared(REFRESH, Date.now());
const os = () => keysOs(window()?.platform);
const osRun = ([cmd, args]) => exec(cmd, args);
const copyText = (text) => osRun(clipboardCommand(os(), text)).catch(() => {});
// Finder's Trash (or the `trash` command when installed); never rm.
const TRASH = 'if command -v trash >/dev/null 2>&1; then trash "$1"; else osascript -e "on run argv" -e "tell application \\"Finder\\" to delete POSIX file (item 1 of argv)" -e "end run" "$1" >/dev/null; fi';

// vscode-viewer's image.js IMAGE_OPEN: { file, on, at } shows that image in the Image Viewer, its own column right of
// this panel (layouts/vscode.json `image-panel`), as vscode-tabs' drag overlay does for a file dropped on its button.
export const IMAGE_OPEN = "vscode-viewer.image-open";
export function openInImagePanel(file, on) {
  setShared(IMAGE_OPEN, { file, on: on ?? null, at: Date.now() });
  run("layout.show", { id: "image-panel" });
}

// Opens the menu for an entry: { path (absolute), root, dir, on }.
export function openMenu(target) {
  const rows = menuItems({ dir: target.dir, remote: !!target.on, canPaste: !!shared(CLIPBOARD), markdown: isMarkdown(target.path), image: !target.dir && isImage(target.path) });
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

// A menu item that needs no open tab, for an entry { path (absolute), root, dir, on }: the menu's pick and the tree's
// keys (main.js, keys.js). Reveal in Finder is for this computer's files only, as the menu shows it.
export function explorerAction(action, t) {
  const folder = t.dir ? t.path : parentOf(t.path);
  const fail = (e) => e?.unreachable ? toast(e) : dialog({ kind: "error", text: String(e?.message ?? e) }, 150 + extraLines(String(e?.message ?? e), 50, 18));
  switch (action) {
    case "code": return openInCode(t.path, t.on, t.dir).catch(fail);
    case "system": return exec("open", [t.path]).catch(fail);
    case "reveal": return t.on ? undefined : osRun(revealCommand(os(), t.path)).catch(fail);
    case "terminal": return run("terminal.open", { folder, place: "tab" });
    case "cut": case "copy": return setShared(CLIPBOARD, { path: t.path, dir: t.dir, cut: action === "cut", on: t.on ?? null });
    case "paste": return paste(folder, t.on).then(refresh, fail);
    case "copyPath": return copyText(t.path);
    case "copyRelative": return copyText(relativeTo(t.root, t.path));
    case "newFile": case "newFolder": return dialog({ kind: action, folder, root: t.root, on: t.on });
    // Room for the name-taken error under the field, which names the file.
    case "rename": return dialog({ kind: "rename", path: t.path, root: t.root, on: t.on }, 196 + extraLines(nameProblem(baseName(t.path), true), 56, 16, 2));
    case "delete": return dialog({ kind: "delete", path: t.path, dir: t.dir, on: t.on }, 170 + extraLines(deleteTitle(t.path), 40, 20));
  }
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
    return this.withList ? openWith(!!t.on) : menuItems({ dir: t.dir, remote: !!t.on, canPaste: !!shared(CLIPBOARD), markdown: isMarkdown(t.path), image: !t.dir && isImage(t.path) });
  }

  close() { closeOverlay(props().overlay); }

  choose(action, cx) {
    const t = this.target;
    if (action === "openWith") { this.withList = true; this.at = -1; return cx.notify(); }
    // Closed once the tab is shown: closing first could end the wait. A second pick meanwhile is ignored.
    const open = (how, place) => !this.opening && (this.opening = true) && cx.spawn(async cx => { try { await openFile(t.path, { on: t.on, how, folder: t.root, place }, cx); } finally { this.close(); } });
    if (action === "open") return open("auto");
    if (action === "openSide") return open("auto", "right");
    if (action === "preview") return open("viewer");
    if (action === "imagePanel") { this.close(); return openInImagePanel(t.path, t.on); }
    if (action === "editor" || action === "viewer") return open(action);
    this.close();
    return explorerAction(action, t);
  }

  render(cx) {
    const t = theme(), rows = this.rows(), picks = rows.map((r, i) => (r === "-" || r[3] ? -1 : i)).filter(i => i >= 0);
    const move = (d) => { const k = picks.indexOf(this.at); this.at = picks[(k + d + picks.length + (k === -1 && d < 0 ? 1 : 0)) % picks.length]; };
    return v_flex().id("explorer-menu").track_focus(this.handle).w_full().max_h(480).overflow_y_scrollbar().p(5).bg(t.popover).text_size(12.8)
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
    if (this.withList) return openWith(!!t.on).slice(0, 2).filter(r => r[1] !== (t.argv ? "editor" : "viewer"));
    const space = spaces().find(s => s.tabs.some(x => x.id === t.tab));
    if (this.moving === "into") return moveRows(space, t.tab, panes());
    if (this.moving === "out") return outRows(t.tab, panes(), shared(VIEWER_FILES));
    return tabMenuItems({ remote: !!t.on, os: os(), lone: (space?.tabs.length ?? 0) < 2, alone: panes().filter(p => p.tab === t.tab).length < 2 });
  }

  choose(action, cx) {
    const t = this.target;
    if (action === "reopenWith") { this.withList = true; this.at = -1; return cx.notify(); }
    // Move into Tab… / Move to New Tab… list the tabs or the tab's panes in place (a popup opened from this one didn't show).
    if (action === "moveInto" || action === "moveOut") { this.moving = action === "moveInto" ? "into" : "out"; this.at = -1; return cx.notify(); }
    // Reopen: the new tab first (closing the old one first could close the space), then the old one.
    if (action === "editor" || action === "viewer") return !this.opening && (this.opening = true) && cx.spawn(async cx => {
      try { await openFile(t.file, { on: t.on, how: action, folder: t.root ?? undefined }, cx); run("tab.close", { id: t.tab }); } finally { this.close(); }
    });
    // A viewer's Split Right: its new pane is remembered as the Explorer's opens are, so it can move too (closed once shown).
    if (action === "split" && !t.argv) return !this.opening && (this.opening = true) && cx.spawn(async cx => {
      try { await noteViewer({ panes, remember: rememberViewer, open: () => run("pane.split", splitArgs(t)), props: { file: t.file, on: t.on }, cx }); } finally { this.close(); }
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
    // vscode-tabs' move.js moves the pane: this file's into the tab picked from moveRows, or the one picked from outRows
    // out to a new tab. A terminal (the editor) or a viewer pane (`argv` null).
    const terminal = panes().find(p => p.pane === t.pane)?.terminal;
    const move = moveOf(action, t.argv ? { terminal } : { pane: t.pane }, panes());
    if (move && (move.terminal || move.pane)) setShared(MOVE, { ...move, at: Date.now() });
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
      // Gone already (a stale row): no error, submit() refreshes the tree; its tabs close all the same.
      if (await ops.exists(s.path)) {
        if (s.on) await ops.remove(s.path);
        else {
          const r = await sh(TRASH, s.path);
          if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not move to Trash");
        }
      }
      return closeDeleted(s.path, s.on ?? null);
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
      ?? deleteTitle(s.path);
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
      // min_w(0) lets a long title (a file name) wrap instead of running past the dialog's edge.
      .child(h_flex().items_start().gap(8).child(div().flex_1().min_w(0).text_size(15).font_semibold().text_color(t.foreground).child(title))
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
