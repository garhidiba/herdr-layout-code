// The Explorer's right-click menu and its Rename/New/Delete dialogs. They run as overlays of this same mod
// (props { menu } or { dialog }), so they share the open rule in paths.js with the tree.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, run, spaces, props, openOverlay, closeOverlay, theme, shared, setShared, appHome, writeTextFile } from "herdr";
import { createOpenTab } from "./launch.js";
import { menuItems, menuHeight, OPEN_WITH, openArgs, baseName, parentOf, relativeTo, within, freeName, nameProblem } from "./paths.js";

const openTab = createOpenTab({ hc, run, spaces });
const CLIPBOARD = "vscode-explorer.clipboard", REFRESH = "vscode-explorer.refresh";
export const refreshKey = REFRESH;

// Herdr starts with PATH=/usr/bin:/bin; Homebrew/user tools (code, trash) live elsewhere.
const sh = (script, ...args) => exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; ' + script, "explorer", ...args]);
const exists = async (p) => (await exec("test", ["-e", p])).code === 0;
const refresh = () => setShared(REFRESH, Date.now());
const copyText = (text) => sh('printf %s "$1" | pbcopy', text).catch(() => {});
// Finder's Trash (or the `trash` command when installed); never rm.
const TRASH = 'if command -v trash >/dev/null 2>&1; then trash "$1"; else osascript -e "on run argv" -e "tell application \\"Finder\\" to delete POSIX file (item 1 of argv)" -e "end run" "$1" >/dev/null; fi';

// Opens the menu for an entry: { path (absolute), root, dir, on }.
export function openMenu(target) {
  const rows = menuItems({ dir: target.dir, remote: !!target.on, canPaste: !!shared(CLIPBOARD) });
  openOverlay({ mod: "vscode-explorer", kind: "popup", width: 270, height: menuHeight(rows), props: { menu: target } });
}

const dialog = (spec, height = 196) => openOverlay({ mod: "vscode-explorer", kind: "dialog", width: 440, height, props: { dialog: spec } });

async function paste(folder) {
  const clip = shared(CLIPBOARD);
  if (!clip) return;
  const src = clip.path;
  if (within(folder, src)) throw new Error(`Cannot paste ${baseName(src)} into itself.`);
  if (clip.cut && parentOf(src) === folder) { setShared(CLIPBOARD, null); return; }
  const name = await freeName(baseName(src), (n) => exists(`${folder}/${n}`), clip.dir);
  const r = await exec(clip.cut ? "mv" : "cp", [...(clip.cut ? ["-n"] : ["-R", "-n"]), src, `${folder}/${name}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Paste failed");
  if (clip.cut) setShared(CLIPBOARD, null);
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
    return this.withList ? OPEN_WITH : menuItems({ dir: t.dir, remote: !!t.on, canPaste: !!shared(CLIPBOARD) });
  }

  close() { closeOverlay(props().overlay); }

  choose(action, cx) {
    const t = this.target, folder = t.dir ? t.path : parentOf(t.path);
    if (action === "openWith") { this.withList = true; this.at = -1; return cx.notify(); }
    // Closed once the tab is shown: closing first could end the wait. A second pick meanwhile is ignored.
    const open = (args) => !this.opening && (this.opening = true) && cx.spawn(async cx => { try { await openTab(args, cx); } finally { this.close(); } });
    if (action === "open") return open(openArgs(t.path, { on: t.on, appHome: appHome(), folder: t.root }));
    if (action === "editor" || action === "viewer") return open(openArgs(t.path, { appHome: appHome(), how: action, folder: t.root }));
    this.close();
    const fail = (e) => dialog({ kind: "error", text: String(e?.message ?? e) }, 150);
    switch (action) {
      case "code": return sh('exec code "$1"', t.path).catch(fail);
      case "system": return exec("open", [t.path]).catch(fail);
      case "reveal": return exec("open", ["-R", t.path]).catch(fail);
      case "terminal": return run("terminal.open", { folder, place: "tab" });
      case "cut": case "copy": return setShared(CLIPBOARD, { path: t.path, dir: t.dir, cut: action === "cut" });
      case "paste": return paste(folder).then(refresh, fail);
      case "copyPath": return copyText(t.path);
      case "copyRelative": return copyText(relativeTo(t.root, t.path));
      case "newFile": case "newFolder": return dialog({ kind: action, folder, root: t.root });
      case "rename": return dialog({ kind: "rename", path: t.path, root: t.root });
      case "delete": return dialog({ kind: "delete", path: t.path, dir: t.dir }, 170);
    }
  }

  render(cx) {
    const t = theme(), rows = this.rows(), picks = rows.map((r, i) => (r === "-" ? -1 : i)).filter(i => i >= 0);
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
        : h_flex().id(`em-${i}`).h(26).px(10).gap(9).rounded(5).items_center().justify_between().text_color(t.foreground)
          .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => this.choose(r[1], cx))
          .child(div().flex_1().min_w(0).truncate().child(r[0]))
          .child(div().text_size(11).text_color(t.dim).child(r[2] ?? ""))));
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
    const s = this.spec;
    if (s.kind === "delete") {
      const r = await sh(TRASH, s.path);
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not move to Trash");
      return;
    }
    const name = this.input.value().trim();
    const folder = s.kind === "rename" ? parentOf(s.path) : s.folder, target = `${folder}/${name}`;
    if (s.kind === "rename" && name === baseName(s.path)) return;
    const problem = nameProblem(name, name && !name.includes("/") && await exists(target));
    if (problem) throw new Error(problem);
    if (s.kind === "newFolder") { const r = await exec("mkdir", [target]); if (r.code !== 0) throw new Error(r.stderr.trim()); return; }
    if (s.kind === "newFile") { await writeTextFile(target, "", null); await openTab(openArgs(target, { appHome: appHome(), folder: s.root }), cx); return; }
    const r = await exec("mv", ["-n", s.path, target]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Rename failed");
  }

  submit(cx) {
    if (this.spec.kind === "error") return this.close();
    cx.spawn(async (cx) => {
      try { await this.apply(cx); this.close(); refresh(); }
      catch (e) { this.error = String(e?.message ?? e); cx.notify(); }
    });
  }

  render(cx) {
    const t = theme(), s = this.spec;
    const title = { newFile: "New File", newFolder: "New Folder", rename: "Rename", error: "Explorer" }[s.kind]
      ?? `Are you sure you want to delete '${baseName(s.path)}'?`;
    const detail = s.kind === "delete" ? `You can restore this ${s.dir ? "folder" : "file"} from the Trash.` : s.kind === "error" ? s.text : null;
    const yes = s.kind === "delete" ? "Move to Trash" : s.kind === "error" ? "OK" : s.kind === "rename" ? "Rename" : "Create";
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
