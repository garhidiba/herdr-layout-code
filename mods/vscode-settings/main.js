// VS Code-style Settings dialog for <herdr home>/vscode-settings.json (the file the terminal editor and the viewer read,
// re-reading it every 2s), with a Keyboard Shortcuts page for <herdr home>/vscode-keybindings.json (the editor's user
// keybindings). Opened as a dialog with `mod.open vscode-settings`: the status bar's gear, cmd-, in the vscode layout,
// and the editor's "Preferences: Open Settings" / "Open Keyboard Shortcuts". Every change is written at once
// (read-modify-write, unknown keys and entries kept, writeTextFile with the text it read so a concurrent edit isn't
// clobbered). keys.json is written only by the "Pass this key to the editor in Herdr" button.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, run, exec, hc, spaces, appHome, readTextFile, writeTextFile, closeOverlay, keys } from "herdr";
import { FILE, normalize, parse, loose, withSetting, withDefaults, rewrite, updateFile, stepDelay, coreStatus, coreCurrent, DEFAULTS,
  PAGE_FILE, requestedPage, editorStatus, editorCurrent, HOSTED_PROVIDERS, modelChoices, chosenModel, keyLine } from "./settings.js";
import { FILE as KB_FILE, fromHerdr, label, matchesRow, conflicts, parseFile, serializeFile, withKey, withoutKey, withReset,
  hasUserEntries, herdrRoute, withPassthrough, recordStep } from "./keybindings.js";
import { createOpenTab } from "./launch.js";

const openTab = createOpenTab({ hc, run, spaces, local: true }); // Settings acts on this computer, whatever space is focused
const settingsPath = () => `${appHome()}/${FILE}`;
const kbPath = () => `${appHome()}/${KB_FILE}`;
const keysPath = () => `${appHome()}/keys.json`;
const corePath = () => `${appHome()}/vscode-core/vscode-core`;
const editorPath = () => `${appHome()}/vscode-core/vsedit`; // the Rust editor, built with the core
const EDITOR = "mods/vscode-viewer/editor/vsedit.sh"; // same launcher the Explorer opens files with
const KB_TABLE = "mods/vscode-viewer/editor/keybindings.cjs"; // `--table <file>`: the editor's commands and keys in effect
// The editor's inline suggestion rules and key store: `--models`, `--key`, `--save-key <file>`, `--remove-key`, `--test`.
const INLINE_CLI = "mods/vscode-viewer/editor/inline.cjs";
const PROVIDER = "editor.inlineSuggest.provider", MODEL = "editor.inlineSuggest.model";
// Herdr starts with PATH=/usr/bin:/bin, so node (Homebrew, ~/.local) is looked up there too (as the viewer does).
const userExec = (cmd, args) => exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; exec "$0" "$@"', cmd, ...args]);
const fileIo = (path) => ({ read: () => readTextFile(path), write: (text, expected) => writeTextFile(path, text, expected) });
const herdrKeys = () => { try { return keys() ?? []; } catch { return []; } };

export default class Settings extends View {
  init(_props, cx) {
    this.v = normalize({});
    this.error = null; this.saved = 0; this.core = null; this.built = false; this.editor = null; this.editorBuilt = false;
    this.inputs = {};
    this.number("files.autoSaveDelay");
    this.number("editor.tabSize");
    this.page = "settings";
    this.kb = null; this.kbOs = "mac"; this.kbEntries = []; this.kbText = undefined; this.kbError = null; this.query = ""; this.rec = null;
    this.search = InputState.new({ placeholder: "Type to search in keybindings" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.recH = cx.focus_handle();
    cx.spawn(async (cx) => { // the editor's "Open Keyboard Shortcuts" asks for that page
      const text = await readTextFile(`${appHome()}/${PAGE_FILE}`).catch(() => null);
      if (requestedPage(text, Date.now()) === "keybindings") { this.page = "keybindings"; cx.notify(); }
    });
    // Inline suggestions: the provider's models and stored key (loaded when the provider changes), what the last
    // Save / Remove / Test said; the key field is masked and emptied once saved.
    this.inl = { provider: null, listed: null, key: null, note: null, busy: false };
    this.modelInput = InputState.new({ placeholder: "Another model name, then Enter" });
    this.modelInput.on("submit", (_e, cx) => { const m = this.modelInput.value().trim(); if (m) { this.set(MODEL, m, cx); this.modelInput.set_value(""); } });
    this.keyInput = InputState.new({ placeholder: "Paste the API key" });
    this.keyInput.set_masked(true);
    this.keyInput.on("submit", (_e, cx) => this.saveKey(cx));
    this.load(cx); this.checkCore(cx); this.loadKeys(cx);
    // Edits made elsewhere (settings.json in the editor, the palette) show up; a build shows up when it finishes.
    cx.timer.every(2000, (cx) => { this.load(cx); this.loadKeys(cx); if (this.building) this.checkCore(cx); });
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

  load(cx) {
    if (this.writing) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(settingsPath()).catch(() => null);
      try { this.show(normalize(parse(text))); this.error = null; if (this.v[PROVIDER] !== this.inl.provider) this.loadInline(cx); }
      catch { this.error = "vscode-settings.json has a syntax error. Fix it in settings.json; nothing is written until then."; }
      cx.notify();
    });
  }

  write(change, cx) {
    this.writing = true;
    cx.spawn(async (cx) => {
      try {
        this.show(await updateFile(fileIo(settingsPath()), change));
        this.error = null;
        if (this.v[PROVIDER] !== this.inl.provider) this.loadInline(cx);
        this.flashSaved(cx);
      } catch (e) {
        this.error = /Invalid value/.test(e?.message) ? e.message : `Cannot write settings: ${e?.message ?? e}`;
        this.show(this.v, true); // put the field back to the last good value
      }
      this.writing = false;
      cx.notify();
    });
  }

  flashSaved(cx) {
    const token = ++this.saved;
    cx.timer.after(1500, (cx) => { if (this.saved === token) { this.saved = 0; cx.notify(); } });
  }

  // Another inline suggestion provider starts from its own default model.
  set(key, value, cx) {
    this.write((raw) => (key === PROVIDER && raw[key] !== value ? withSetting(withSetting(raw, key, value), MODEL, "") : withSetting(raw, key, value)), cx);
  }

  // ----- inline suggestions: models, the API key (never shown again in full, never in settings.json) -----
  inlineCli(args) {
    return userExec("node", [`${appHome()}/${INLINE_CLI}`, ...args])
      .then((r) => JSON.parse(r.stdout.trim().split("\n").pop() || "null") ?? { error: (r.stderr || `exit ${r.code}`).trim() })
      .catch((e) => ({ error: e?.message ?? String(e) }));
  }
  loadInline(cx) {
    const p = this.v[PROVIDER];
    this.inl = { provider: p, listed: null, key: null, note: null, busy: false };
    if (p === "off") return;
    cx.spawn(async (cx) => {
      const [listed, key] = await Promise.all([this.inlineCli(["--models", p]), HOSTED_PROVIDERS.includes(p) ? this.inlineCli(["--key", p]) : null]);
      if (this.inl.provider !== p) return;
      Object.assign(this.inl, { listed, key });
      cx.notify();
    });
  }
  // The typed key goes to the store through a file in a folder only this user can open (exec has no stdin), which
  // inline.cjs deletes; the key is never a command-line argument.
  saveKey(cx) {
    const p = this.inl.provider, key = this.keyInput.value().trim();
    if (!key || this.inl.busy) return;
    this.inl.busy = true;
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/.vscode-key-${Date.now()}`;
      try {
        const mk = await exec("mkdir", ["-m", "700", dir]);
        if (mk.code !== 0) throw new Error(mk.stderr.trim() || "mkdir failed");
        await writeTextFile(`${dir}/key`, key, null);
        const r = await this.inlineCli(["--save-key", p, `${dir}/key`]);
        if (r.error) throw new Error(r.error);
        this.keyInput.set_value("");
        this.inl.key = r;
        this.inl.note = null;
      } catch (e) { this.inl.note = `Cannot save the key: ${e.message}`; }
      await exec("rm", ["-rf", dir]).catch(() => {});
      this.inl.busy = false;
      cx.notify();
    });
  }
  removeKey(cx) {
    const p = this.inl.provider;
    cx.spawn(async (cx) => {
      const r = await this.inlineCli(["--remove-key", p]);
      this.inl.note = r.error ? `Cannot remove the key: ${r.error}` : "Removed from the keychain and vscode-secrets.json.";
      this.inl.key = await this.inlineCli(["--key", p]);
      cx.notify();
    });
  }
  // One short completion with the stored key, only on the button.
  testKey(cx) {
    const p = this.inl.provider;
    this.inl.note = "Testing…";
    cx.spawn(async (cx) => {
      const r = await this.inlineCli(["--test", p, this.v[MODEL]]);
      this.inl.note = r.ok ? `Works: a completion in ${r.ms} ms.` : `Test failed: ${r.error}`;
      cx.notify();
    });
  }

  // ----- keyboard shortcuts -----
  // The user file's entries, and the editor's table for them (re-run only when the file's text changed).
  loadKeys(cx, force = false) {
    if (this.kbWriting) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(kbPath()).catch(() => null);
      if (!force && this.kb && text === this.kbText) return;
      this.kbText = text;
      try { this.kbEntries = parseFile(text, loose); this.kbError = null; }
      catch { this.kbEntries = []; this.kbError = `${KB_FILE} has a syntax error. Fix it in the JSON file; nothing is written until then.`; }
      const r = await userExec("node", [`${appHome()}/${KB_TABLE}`, "--table", kbPath()]).catch((e) => ({ code: -1, stderr: e?.message ?? String(e) }));
      try {
        if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().split("\n").pop());
        const table = JSON.parse(r.stdout);
        this.kb = table.rows; this.kbOs = table.os ?? "mac"; // the OS whose keys the editor uses: labels in its style
      } catch (e) { this.kbError = `Cannot list the editor's commands (node ${KB_TABLE}): ${e.message}`; }
      cx.notify();
    });
  }

  writeKeys(change, cx) {
    this.kbWriting = true;
    cx.spawn(async (cx) => {
      let ok = false;
      try { await rewrite(fileIo(kbPath()), change, (text) => parseFile(text, loose), serializeFile); ok = true; this.flashSaved(cx); }
      catch (e) { this.kbError = `Cannot write ${KB_FILE}: ${e?.message ?? e}`; } // stays until the file changes
      this.kbWriting = false;
      if (ok) this.loadKeys(cx, true);
      cx.notify();
    });
  }

  // Adds "<key>": "terminal" to keys.json's terminal section (Herdr reloads it); only from the row's button.
  passKey(key, cx) {
    cx.spawn(async (cx) => {
      try { await rewrite(fileIo(keysPath()), (k) => withPassthrough(k, key), (text) => (text?.trim() ? loose(text) : {})); this.flashSaved(cx); }
      catch (e) { this.kbError = `Cannot write keys.json: ${e?.message ?? e}`; }
      cx.notify();
    });
  }

  startRecord(row, cx) {
    this.rec = { row, key: null };
    this.recH.focus();
    cx.timer.after(30, () => this.recH.focus()); // again once the recorder is drawn and tracks the handle
    cx.notify();
  }
  // The recorder takes the next keystrokes (two make a chord); Enter saves, Escape cancels (VS Code's Define Keybinding).
  recordKey(e, cx) {
    cx.stop_propagation();
    if (e.keystroke === "escape") this.rec = null;
    else if (e.keystroke === "enter") { if (this.rec.key) this.saveRecord(cx); }
    else { const k = fromHerdr(e.keystroke); if (k) this.rec.key = recordStep(this.rec.key, k); }
    cx.notify();
  }
  saveRecord(cx) {
    const { row, key } = this.rec;
    this.rec = null;
    this.writeKeys((entries) => withKey(entries, row, key), cx);
  }

  checkCore(cx) {
    cx.spawn(async (cx) => {
      const [r, e] = await Promise.all([corePath(), editorPath()].map((bin) => exec(bin, ["--version"]).catch(() => null)));
      this.built = r?.code === 0 && coreCurrent(r.stdout);
      this.core = coreStatus(r?.code === 0 ? r.stdout : null);
      this.editorBuilt = e?.code === 0 && editorCurrent(e.stdout);
      this.editor = editorStatus(e?.code === 0 ? e.stdout : null);
      if (!this.needsBuild()) this.building = false;
      cx.notify();
    });
  }

  buildCore(cx) {
    this.building = true;
    return openTab({ name: "Build Rust core", folder: appHome(), argv: ["sh", `${appHome()}/mods/vscode-settings/build-core.sh`, appHome()] }, cx);
  }

  // The dialog closes once the editor tab is shown: closing first could end the wait (see launch.js).
  async openJson(name, path, cx) {
    if (this.opening) return;
    this.opening = true;
    try { await openTab({ name, folder: appHome(), argv: ["exec", "sh", `${appHome()}/${EDITOR}`, path] }, cx); } // exec: the tab closes with the editor
    finally { this.opening = false; closeOverlay(props().overlay); }
  }
  openKeysJson(cx) {
    cx.spawn(async (cx) => {
      if (this.kbText == null) await writeTextFile(kbPath(), "[]\n", null).catch(() => {}); // the editor opens a missing file as new, but empty
      await this.openJson(KB_FILE, kbPath(), cx);
    });
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

  // A chosen Rust engine whose binary is missing or out of date (one build makes both: build-core.sh).
  needsBuild() {
    return Boolean((this.v["core.engine"] === "rust" && this.core && !this.built) || (this.v["editor.engine"] === "rust" && this.editor && !this.editorBuilt));
  }

  // The binary's status, and the Build button (on the core's row, else the editor's) while a chosen one isn't current.
  statusLine(t, id, status, built, checking, button) {
    return h_flex().gap(10).items_center()
      .child(div().flex_1().text_size(11.5).text_color(built ? t.done : t.dim).child(status ?? checking))
      .when(button && this.needsBuild(), (el) => el.child(this.button(t, id, this.building ? "Building… (see tab)" : "Build Rust core", (_e, cx) => cx.spawn((cx) => this.buildCore(cx)))));
  }

  // ----- keyboard shortcuts page -----
  small(t, id, text, aria, onClick) {
    return div().id(id).h(22).px(7).flex().items_center().rounded(4).text_size(11).cursor_pointer().accessibility_label(aria)
      .border_1().border_color(t.input).bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick).child(text);
  }

  kbd(t, c, big = false) {
    return div().flex_none().h(big ? 32 : 20).px(big ? 12 : 6).flex().items_center().rounded(4).border_1().border_color(t.input)
      .bg(t.background).text_size(big ? 16 : 11.5).text_color(t.foreground).child(label(c, this.kbOs));
  }

  // "⇧⌘D doesn't reach the editor…" with the button that passes it (and what that takes from other terminals).
  passNote(t, rowId, key, route) {
    const k = label(key, this.kbOs), taken = route.loses.map((l) => `${l.action} (${l.section})`).join(", ");
    const why = taken ? `Herdr runs ${taken} for it.` : `Herdr keeps ${this.kbOs === "mac" ? "⌘" : "Super"} keys unless keys.json passes them to terminal programs.`;
    const cost = taken ? `Passing it sends ${k} to the program in every terminal, so ${taken} no longer runs while a terminal has focus.`
      : `Nothing in Herdr uses ${k}, so other terminals lose nothing.`;
    return h_flex().gap(10).items_center().pb(8)
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.ansi3).child(`${k} doesn't reach the editor: ${why} ${cost}`))
      .child(this.button(t, `pass-${rowId}`, "Pass this key to the editor in Herdr", (_e, cx) => this.passKey(key, cx)));
  }

  keyRow(t, r, bindings) {
    const rowId = `${r.id}|${r.key}`, name = r.title || r.id;
    const route = r.source === "User" && r.key ? herdrRoute(bindings, r.key) : null;
    return v_flex().border_b(1).border_color(t.border)
      .child(h_flex().min_h(36).py(4).gap(10).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).truncate().child(name))
          .child(div().text_size(10.5).text_color(t.dim).truncate().child(r.id)))
        .child(h_flex().w(160).flex_none().child(r.key ? this.kbd(t, r.key) : div().text_size(11.5).text_color(t.dim).child("—")))
        .child(div().w(56).flex_none().text_size(11.5).text_color(r.source === "User" ? t.foreground : t.muted).child(r.source))
        .child(h_flex().w(236).flex_none().gap(4).justify_end()
          .child(this.small(t, `change-${rowId}`, r.key ? "Change" : "Add", `Change keybinding of ${name}`, (_e, cx) => this.startRecord(r, cx)))
          .when(Boolean(r.key), (el) => el.child(this.small(t, `remove-${rowId}`, "Remove", `Remove keybinding of ${name}`,
            (_e, cx) => this.writeKeys((en) => withoutKey(en, r), cx))))
          .when(hasUserEntries(this.kbEntries, r.id), (el) => el.child(this.small(t, `reset-${rowId}`, "Reset to default", `Reset keybindings of ${name}`,
            (_e, cx) => this.writeKeys((en) => withReset(en, r.id), cx))))))
      .when(Boolean(route && !route.passes), (el) => el.child(this.passNote(t, rowId, r.key, route)));
  }

  // VS Code's Define Keybinding box: the chord pressed so far, conflicts, Enter to save.
  recorder(t) {
    const { row, key } = this.rec, n = key ? conflicts(this.kb ?? [], key, row) : 0;
    const route = key ? herdrRoute(herdrKeys(), key) : null;
    return v_flex().flex_1().min_h(0).items_center().justify_center()
      .child(v_flex().id("recorder").track_focus(this.recH).on_key_down((e, cx) => this.recordKey(e, cx)).on_click(() => this.recH.focus())
        .w(460).p(18).gap(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.raised)
        .child(div().text_size(13).font_semibold().child("Press desired key combination and then press Enter"))
        .child(div().text_size(11.5).text_color(t.muted).child(row.title || row.id))
        .child(key ? this.kbd(t, key, true) : div().h(32).flex().items_center().text_size(12).text_color(t.dim).child("Waiting for a key…"))
        .when(n > 0, (el) => el.child(div().text_size(11.5).text_color(t.ansi3)
          .child(`${n} existing command${n > 1 ? "s have" : " has"} this keybinding`)))
        .when(Boolean(route && !route.passes), (el) => el.child(div().text_size(11).text_color(t.muted)
          .child("Herdr doesn't pass this key to terminal programs yet; after saving, its row offers to.")))
        .child(h_flex().gap(8).pt(4)
          .child(this.button(t, "rec-cancel", "Cancel", (_e, cx) => { this.rec = null; cx.notify(); }))
          .when(Boolean(key), (el) => el.child(this.button(t, "rec-save", "Save", (_e, cx) => this.saveRecord(cx), true)))));
  }

  keysPage(t) {
    if (this.rec) return this.recorder(t);
    const all = this.kb ?? [], rows = all.filter((r) => matchesRow(r, this.query, this.kbOs)), bindings = herdrKeys();
    const head = (text, w) => (w ? div().w(w).flex_none() : div().flex_1()).child(text);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().px(18).pt(10).pb(6).gap(10).items_center()
        .child(div().flex_1().h(28).px(8).flex().items_center().rounded(4).border_1().border_color(t.input).bg(t.background).text_size(12)
          .child(Input.new(this.search).w_full()))
        .child(div().text_size(11).text_color(t.dim).child(this.kb ? `${rows.length} of ${all.length}` : "Loading…")))
      .child(h_flex().px(18).h(26).gap(10).items_center().border_b(1).border_color(t.border).text_size(11).font_semibold().text_color(t.dim)
        .child(head("Command", 0)).child(head("Keybinding", 160)).child(head("Source", 56)).child(head("", 236)))
      .child(v_flex().id("kb-rows").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
        .children(rows.map((r) => this.keyRow(t, r, bindings)))
        .when(Boolean(this.kb) && !rows.length, (el) => el.child(div().py(16).text_size(12).text_color(t.muted).child("No keybindings match the search."))));
  }

  settingsPage(t) {
    return v_flex().id("body").flex_1().min_h(0).px(18).pb(10).overflow_y_scrollbar()
      .child(this.section(t, "Core engine"))
      .child(this.row(t, "Core", "Engine", "File and git scanning for the explorer and source control. JavaScript works everywhere; Rust is faster but must be built first.",
        this.segmented(t, "core.engine", [["js", "JavaScript"], ["rust", "Rust"]]),
        this.statusLine(t, "build-core", this.core, this.built, "Rust core: checking…", this.v["core.engine"] === "rust")))
      .child(this.row(t, "Editor", "Engine", "The terminal editor; follows the core's engine until you pick one. Rust opens files faster and never stalls typing on long lines; language features (Go to Definition, rename, hover, the command palette and context menu) are JavaScript-only for now.",
        this.segmented(t, "editor.engine", [["js", "JavaScript"], ["rust", "Rust"]]),
        this.statusLine(t, "build-editor", this.editor, this.editorBuilt, "Rust editor: checking…", this.v["core.engine"] !== "rust")))
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
      .child(this.row(t, "Editor", "Insert Spaces", "Insert spaces when pressing Tab, for files with no indentation to detect.", this.toggle(t, "editor.insertSpaces", "Insert Spaces")))
      .child(this.row(t, "Editor", "Cursor Style", "The editor's cursor shape. Terminals have no thin cursors, so the thin styles look like Line and Underline, and Block Outline like Block.",
        this.segmented(t, "editor.cursorStyle", [["line", "Line"], ["block", "Block"], ["underline", "Underline"], ["line-thin", "Line Thin"], ["underline-thin", "Underline Thin"], ["block-outline", "Block Outline"]])))
      .child(this.row(t, "Editor", "Cursor Blinking", "Solid keeps the cursor steady; the other styles all blink.",
        this.segmented(t, "editor.cursorBlinking", [["blink", "Blink"], ["smooth", "Smooth"], ["phase", "Phase"], ["expand", "Expand"], ["solid", "Solid"]])))
      .child(this.row(t, "Editor", "Inline Suggestions", "Gray ghost text from a code model while you type: Tab accepts, Esc hides, ⌘→ / Ctrl+→ takes a word. The status bar item turns it on and off.",
        this.toggle(t, "editor.inlineSuggest.enabled", "Inline Suggestions")))
      .child(this.row(t, "Editor", "Inline Suggestion Provider", "Ollama runs a model on this machine, free. Codestral (Mistral), DeepSeek and Mercury (Inception) are paid APIs with your key; they get the code around the cursor, 2,000 requests a day by default, and the status bar shows the cost.",
        this.segmented(t, PROVIDER, [["ollama", "Ollama"], ["codestral", "Codestral"], ["deepseek", "DeepSeek"], ["mercury", "Mercury"], ["off", "Off"]])))
      .when(this.v[PROVIDER] !== "off", (el) => el.child(this.modelRow(t)))
      .when(HOSTED_PROVIDERS.includes(this.v[PROVIDER]), (el) => el.child(this.keyRow(t)));
  }

  modelRow(t) {
    const listed = this.inl.listed, current = this.v[MODEL], chosen = chosenModel(current, listed);
    const desc = this.v[PROVIDER] === "ollama" ? "The models pulled here (ollama list). Pick a base model: an instruct / chat one answers in prose." : "The provider's code completion models.";
    const chips = !listed ? div().text_size(11.5).text_color(t.dim).child("Loading models…")
      : listed.error ? div().text_size(11.5).text_color(t.ansi3).child(`Cannot list models: ${listed.error}`)
        : h_flex().flex_wrap().gap(6).children(modelChoices(current, listed).map(([value, label]) => {
          const on = value === chosen;
          return div().id(`model-${value || "default"}`).h(24).px(10).flex().items_center().rounded(4).text_size(12).cursor_pointer()
            .role("radio_button").accessibility_label(label).border_1().border_color(on ? t.accent : t.input)
            .bg(on ? t.accent : t.background).text_color(on ? t.accent_foreground : t.muted)
            .when(!on, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.set(MODEL, value, cx)))
            .child(label);
        }));
    return this.row(t, "Editor", "Inline Suggestion Model", desc,
      div().w(220).h(28).px(8).flex().items_center().rounded(4).border_1().border_color(t.input).bg(t.background).text_size(12).child(Input.new(this.modelInput).w_full()),
      chips);
  }

  keyRow(t) {
    const stored = Boolean(this.inl.key?.from && this.inl.key.from !== "env");
    return this.row(t, "Editor", "API Key", "Saved in the macOS keychain (herdr-vscode-<provider>), elsewhere in vscode-secrets.json (mode 600); never in settings.json. Test sends one short completion.",
      h_flex().gap(6).items_center()
        .child(div().w(200).h(28).px(8).flex().items_center().rounded(4).border_1().border_color(t.input).bg(t.background).text_size(12).child(Input.new(this.keyInput).w_full()))
        .child(this.button(t, "key-save", this.inl.busy ? "Saving…" : "Save", (_e, cx) => this.saveKey(cx), true))
        .when(stored, (el) => el.child(this.button(t, "key-remove", "Remove", (_e, cx) => this.removeKey(cx))))
        .when(Boolean(this.inl.key?.from), (el) => el.child(this.button(t, "key-test", "Test", (_e, cx) => this.testKey(cx)))),
      v_flex().gap(3)
        .child(div().text_size(11.5).text_color(this.inl.key?.from ? t.done : t.dim).child(keyLine(this.inl.key)))
        .when(Boolean(this.inl.note), (el) => el.child(div().text_size(11.5).text_color(/^(Cannot|Test failed)/.test(this.inl.note ?? "") ? t.ansi3 : t.muted).child(this.inl.note))));
  }

  pageTab(t, page, text) {
    const on = this.page === page;
    return div().id(`page-${page}`).h(44).px(2).flex().items_center().cursor_pointer().role("tab").accessibility_label(text)
      .text_size(on ? 14 : 13).border_b(2).border_color(on ? t.accent : t.popover).text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.font_semibold())
      .when(!on, (el) => el.hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.page = page; this.rec = null; cx.notify(); }))
      .child(text);
  }

  render(cx) {
    const t = theme(), keysOn = this.page === "keybindings", error = keysOn ? this.kbError : this.error;
    return v_flex().id("vscode-settings").size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(44).px(18).gap(18).items_center().border_b(1).border_color(t.border)
        .child(this.pageTab(t, "settings", "Settings"))
        .child(this.pageTab(t, "keybindings", "Keyboard Shortcuts"))
        .child(div().text_size(11).text_color(t.dim).child(keysOn ? KB_FILE : FILE))
        .child(div().flex_1())
        .when(this.saved > 0, (el) => el.child(div().text_size(11.5).text_color(t.done).child("✓ Saved")))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(error), (el) => el.child(div().px(18).py(6).text_size(11.5).bg(t.background).text_color(t.ansi1).child(error)))
      .child(keysOn ? this.keysPage(t) : this.settingsPage(t))
      .child(h_flex().h(52).px(18).gap(8).items_center().border_t(1).border_color(t.border)
        .when(!keysOn, (el) => el
          .child(this.button(t, "open-json", "Open settings.json", (_e, cx) => cx.spawn((cx) => this.openJson(FILE, settingsPath(), cx))))
          .child(this.button(t, "reset", "Reset to defaults", (_e, cx) => this.write(withDefaults, cx))))
        .when(keysOn, (el) => el.child(this.button(t, "open-kb-json", `Open ${KB_FILE}`, (_e, cx) => this.openKeysJson(cx))))
        .child(div().flex_1())
        .child(this.button(t, "close", "Close", () => closeOverlay(props().overlay), true)));
  }
}
