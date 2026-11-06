// VS Code-style Settings dialog for <herdr home>/vscode-settings.json (the file the terminal editor and the viewer read,
// re-reading it every 2s). Opened as a dialog with `mod.open vscode-settings`: the status bar's gear, cmd-, in the
// vscode layout, and the editor's "Preferences: Open Settings". Every change is written at once (read-modify-write,
// unknown keys kept, writeTextFile with the text it read so a concurrent edit isn't clobbered).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, run, exec, appHome, readTextFile, writeTextFile, closeOverlay } from "herdr";
import { FILE, normalize, parse, withSetting, withDefaults, updateFile, stepDelay, coreStatus, DEFAULTS } from "./settings.js";

const settingsPath = () => `${appHome()}/${FILE}`;
const corePath = () => `${appHome()}/vscode-core/vscode-core`;
const EDITOR = "mods/vscode-viewer/editor/vsedit.cjs"; // same path the Explorer opens files with

export default class Settings extends View {
  init(_props, cx) {
    this.v = { ...DEFAULTS };
    this.error = null; this.saved = 0; this.core = null; this.built = false;
    this.inputs = {};
    this.number("files.autoSaveDelay");
    this.number("editor.tabSize");
    this.load(cx); this.checkCore(cx);
    // Edits made elsewhere (settings.json in the editor, the palette) show up; a build shows up when it finishes.
    cx.timer.every(2000, (cx) => { this.load(cx); if (this.building) this.checkCore(cx); });
  }

  // A number field committed on Enter or blur; while focused, the file's value doesn't overwrite what is typed.
  number(key) {
    const s = InputState.new({ value: String(DEFAULTS[key]) });
    const entry = { state: s, focused: false };
    s.on("focus", () => { entry.focused = true; });
    s.on("blur", (_e, cx) => { entry.focused = false; this.commit(key, cx); });
    s.on("submit", (_e, cx) => this.commit(key, cx));
    this.inputs[key] = entry;
  }

  commit(key, cx) {
    const typed = this.inputs[key].state.value().trim();
    if (typed !== String(this.v[key])) this.set(key, typed, cx);
  }

  show(values, force = false) {
    this.v = values;
    for (const [key, e] of Object.entries(this.inputs))
      if ((force || !e.focused) && e.state.value() !== String(values[key])) e.state.set_value(String(values[key]));
  }

  io() {
    return { read: () => readTextFile(settingsPath()), write: (text, expected) => writeTextFile(settingsPath(), text, expected) };
  }

  load(cx) {
    if (this.writing) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(settingsPath()).catch(() => null);
      try { this.show(normalize(parse(text))); this.error = null; }
      catch { this.error = "vscode-settings.json has a syntax error. Fix it in settings.json; nothing is written until then."; }
      cx.notify();
    });
  }

  write(change, cx) {
    this.writing = true;
    cx.spawn(async (cx) => {
      try {
        this.show(await updateFile(this.io(), change));
        this.error = null;
        const token = ++this.saved;
        cx.timer.after(1500, (cx) => { if (this.saved === token) { this.saved = 0; cx.notify(); } });
      } catch (e) {
        this.error = /Invalid value/.test(e?.message) ? e.message : `Cannot write settings: ${e?.message ?? e}`;
        this.show(this.v, true); // put the field back to the last good value
      }
      this.writing = false;
      cx.notify();
    });
  }

  set(key, value, cx) { this.write((raw) => withSetting(raw, key, value), cx); }

  checkCore(cx) {
    cx.spawn(async (cx) => {
      const r = await exec(corePath(), ["--version"]).catch(() => null);
      this.built = r?.code === 0;
      this.core = coreStatus(this.built ? r.stdout : null);
      if (this.built) this.building = false;
      cx.notify();
    });
  }

  buildCore() {
    this.building = true;
    run("tab.new", { name: "Build Rust core", folder: appHome(), argv: ["sh", `${appHome()}/mods/vscode-settings/build-core.sh`, appHome()] });
  }

  openJson() {
    closeOverlay(props().overlay);
    run("tab.new", { name: FILE, folder: appHome(), argv: ["node", `${appHome()}/${EDITOR}`, settingsPath()] });
  }

  // ----- controls -----
  segmented(t, key, options) {
    return h_flex().flex_none().p(2).gap(2).rounded(6).bg(t.background).border_1().border_color(t.input).children(options.map(([value, label]) => {
      const on = this.v[key] === value;
      return div().id(`${key}-${value}`).h(24).px(10).flex().items_center().rounded(4).text_size(12).cursor_pointer()
        .role("radio_button").accessibility_label(label)
        .bg(on ? t.accent : t.background).text_color(on ? t.accent_foreground : t.muted)
        .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.set(key, value, cx)))
        .child(label);
    }));
  }

  toggle(t, key, label) {
    const on = this.v[key];
    return div().id(key).flex_none().w(34).h(18).p(2).rounded(9).flex().items_center().cursor_pointer()
      .role("switch").accessibility_label(`${label}: ${on ? "on" : "off"}`)
      .when(on, (el) => el.justify_end()).bg(on ? t.accent : t.input)
      .on_click((_e, cx) => this.set(key, !on, cx))
      .child(div().size(14).rounded(7).bg(on ? t.accent_foreground : t.muted));
  }

  stepper(t, key, step) {
    const btn = (id, label, dir) => div().id(`${key}-${id}`).size(26).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .border_1().border_color(t.input).bg(t.background).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .accessibility_label(`${dir < 0 ? "Decrease" : "Increase"}`).on_click((_e, cx) => this.set(key, step(this.v[key], dir), cx))
      .child(label);
    return h_flex().flex_none().gap(4).items_center()
      .child(btn("dec", "−", -1))
      .child(div().w(72).h(26).px(6).flex().items_center().rounded(4).border_1().border_color(t.input).bg(t.background).text_size(12)
        .child(Input.new(this.inputs[key].state).w_full()))
      .child(btn("inc", "+", 1));
  }

  row(t, category, name, description, control, extra = null) {
    return v_flex().gap(6).py(10).border_b(1).border_color(t.border)
      .child(h_flex().gap(16).items_center()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().text_size(13).child(div().text_color(t.muted).child(`${category}: `)).child(div().font_semibold().text_color(t.foreground).child(name)))
          .child(div().text_size(11.5).text_color(t.muted).child(description)))
        .child(control))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  section(t, title) {
    return div().pt(14).pb(2).text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase());
  }

  button(t, id, label, onClick, primary = false) {
    return div().id(id).h(28).px(12).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
  }

  coreLine(t) {
    const needsBuild = this.v["core.engine"] === "rust" && this.core && !this.built;
    return h_flex().gap(10).items_center()
      .child(div().flex_1().text_size(11.5).text_color(this.built ? t.done : t.dim).child(this.core ?? "Rust core: checking…"))
      .when(needsBuild, (el) => el.child(this.button(t, "build-core", this.building ? "Building… (see tab)" : "Build Rust core", () => this.buildCore())));
  }

  render(cx) {
    const t = theme();
    return v_flex().id("vscode-settings").size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(44).px(18).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(15).font_semibold().child("Settings"))
        .child(div().text_size(11).text_color(t.dim).child(FILE))
        .child(div().flex_1())
        .when(this.saved > 0, (el) => el.child(div().text_size(11.5).text_color(t.done).child("✓ Saved")))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(this.error), (el) => el.child(div().px(18).py(6).text_size(11.5).bg(t.background).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
        .child(this.section(t, "Core engine"))
        .child(this.row(t, "Core", "Engine", "File and git scanning for the explorer and source control. JavaScript works everywhere; Rust is faster but must be built first.",
          this.segmented(t, "core.engine", [["js", "JavaScript"], ["rust", "Rust"]]), this.coreLine(t)))
        .child(this.section(t, "Files"))
        .child(this.row(t, "Files", "Auto Save", "Save dirty editors automatically.",
          this.segmented(t, "files.autoSave", [["off", "Off"], ["afterDelay", "After Delay"], ["onFocusChange", "On Focus Change"]])))
        .child(this.row(t, "Files", "Auto Save Delay", "Seconds after the last edit, when Auto Save is After Delay (0.1–3600).",
          this.stepper(t, "files.autoSaveDelay", stepDelay)))
        .child(this.row(t, "Files", "Trim Trailing Whitespace", "Remove trailing whitespace when saving.", this.toggle(t, "files.trimTrailingWhitespace", "Trim Trailing Whitespace")))
        .child(this.row(t, "Files", "Insert Final Newline", "End the file with a newline when saving.", this.toggle(t, "files.insertFinalNewline", "Insert Final Newline")))
        .child(this.section(t, "Editor"))
        .child(this.row(t, "Editor", "Format On Save", "Format the file when saving (needs a formatter for the language).", this.toggle(t, "editor.formatOnSave", "Format On Save")))
        .child(this.row(t, "Editor", "Tab Size", "Spaces a tab equals, for files with no indentation to detect (1–16).",
          this.stepper(t, "editor.tabSize", (v, dir) => v + dir)))
        .child(this.row(t, "Editor", "Insert Spaces", "Insert spaces when pressing Tab, for files with no indentation to detect.", this.toggle(t, "editor.insertSpaces", "Insert Spaces"))))
      .child(h_flex().h(52).px(18).gap(8).items_center().border_t(1).border_color(t.border)
        .child(this.button(t, "open-json", "Open settings.json", () => this.openJson()))
        .child(this.button(t, "reset", "Reset to defaults", (_e, cx) => this.write(withDefaults, cx)))
        .child(div().flex_1())
        .child(this.button(t, "close", "Close", () => closeOverlay(props().overlay), true)));
  }
}
