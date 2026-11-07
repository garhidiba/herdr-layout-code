// A file editor for a tab: props { file: absolute path, on?: machine, install?: true (the terminal editor isn't on that
// machine yet: an Install Editor button asks the Explorer to install it, as its confirm dialog's yes does), preview?: true
// (shown as rendered markdown whatever its extension: the terminal editor's Markdown preview, editor/mdpreview.cjs) }.
// Opens straight into Herdr's built-in editor (Atom One Dark colors, VS Code's file-type recognition from langs.json),
// saves with Cmd+S ("vscode-viewer.save" in keys.json), flags changes on disk, and shows a VS Code-style status bar.
// Images open as a preview, videos as a still with Open in Player (from another machine both are fetched first:
// preview.js); markdown opens rendered, with Edit to switch to the editor.
// Auto save follows files.autoSave in <herdr home>/vscode-settings.json (shared with the terminal editor). A mod can't stop
// its tab from closing, so unsaved text is kept as a hot-exit backup in close() and offered back on the next open.
import { View, div, image, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, writeTextFile, exec, theme, appHome, nextCommand, focused, panes, spaces, run, shared, setShared } from "herdr";
import { FETCHED, POSTER, fetchFile, prune } from "./preview.js";
import { ownPane } from "./pane.js";
// Herdr starts with PATH=/usr/bin:/bin, so Homebrew/user tools (node, code, codex, trash) are looked up here too.
const userExec = (cmd, args, opts) => exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; exec "$0" "$@"', cmd, ...args], opts);

const ONE_DARK = {
  keyword: "#c678dd", string: "#98c379", comment: "#5c6370", function: "#61afef", type: "#e5c07b",
  number: "#d19a66", constant: "#d19a66", boolean: "#d19a66", variable: "#e06c75",
  operator: "#56b6c2", punctuation: "#abb2bf", "string.escape": "#56b6c2",
};
const NAMES = {
  "source.go": "Go", "source.kotlin": "Kotlin", "source.ts": "TypeScript", "source.tsx": "TypeScript React", "source.js": "JavaScript",
  "source.js.jsx": "JavaScript React", "source.python": "Python", "source.rust": "Rust", "source.java": "Java", "source.shell": "Shell Script",
  "source.toml": "TOML", "source.json": "JSON", "source.json.comments": "JSON with Comments", "source.yaml": "YAML", "text.html.basic": "HTML",
  "source.css": "CSS", "source.css.scss": "SCSS", "text.html.markdown": "Markdown", "source.swift": "Swift", "source.dart": "Dart",
  "source.groovy": "Groovy", "source.dockerfile": "Dockerfile", "source.sql": "SQL", "source.c": "C", "source.cpp": "C++", "source.cs": "C#",
  "source.ruby": "Ruby", "source.php": "PHP", "source.lua": "Lua", "source.makefile": "Makefile", "text.xml": "XML", "source.ini": "Ini",
  "source.dotenv": "Dotenv", "source.diff": "Diff", "source.powershell": "PowerShell", "source.batchfile": "Batch",
};

// File name -> value in a { ext, files, prefixes } table: exact name, name prefix, longest extension.
function lookup(name, table) {
  const n = name.toLowerCase();
  if (table.files[n]) return table.files[n];
  for (const [prefix, value] of Object.entries(table.prefixes)) if (n.startsWith(prefix)) return value;
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const v = table.ext[parts.slice(i).join(".")]; if (v) return v; }
  return null;
}

// Per-file-type role colors measured against VS Code's One Dark rendering (palettes.json: { ext: { role: hex } }).
let palettes = null;
const palettesReady = () => palettes ?? (palettes = readTextFile(`${appHome()}/mods/vscode-viewer/palettes.json`).then(t => JSON.parse(t)).catch(() => ({})));
// Extensions that share a measured palette with a sibling.
const ALIAS = { kts: "kt", yml: "yaml", mjs: "js", cjs: "js", mts: "ts", cts: "ts", h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp", hh: "cpp",
  bash: "sh", zsh: "sh", jsonc: "json", htm: "html", scss: "css", less: "css", pyi: "py" };
const extOf = (name) => { const n = name.toLowerCase(), e = n.includes(".") ? n.split(".").pop() : n; return ALIAS[e] ?? e; };
// Atom One Dark editor colors (akamud.vscode-theme-onedark: editor.background / editor.foreground).
const EDITOR_BG = "#282c34", EDITOR_FG = "#abb2bf";

// What the tab shows: an image preview, a video still, markdown (preview + editor) or code. Extension -> format name.
const IMAGES = { png: "PNG", jpg: "JPEG", jpeg: "JPEG", gif: "GIF", webp: "WebP", bmp: "BMP", ico: "ICO", svg: "SVG", tif: "TIFF", tiff: "TIFF" };
const VIDEOS = { mp4: "MPEG-4", m4v: "MPEG-4", mov: "QuickTime", webm: "WebM", mkv: "Matroska", avi: "AVI" };
const MARKDOWN = ["md", "markdown", "mdx", "mkd"];
function kindOf(name) {
  const n = name.toLowerCase(), e = n.includes(".") ? n.split(".").pop() : "";
  return IMAGES[e] ? "image" : VIDEOS[e] ? "video" : MARKDOWN.includes(e) ? "markdown" : "code";
}
const sizeText = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
// `sips -g pixelWidth -g pixelHeight` output -> "W × H" (null when it has none).
function sipsSize(out) {
  const w = /pixelWidth: (\d+)/.exec(out ?? ""), h = /pixelHeight: (\d+)/.exec(out ?? "");
  return w && h ? `${w[1]} × ${h[1]}` : null;
}
// image() only loads from the app's folder, so images are copied to <app>/mods/vscode-viewer/.cache/<path hash>-<mtime>-<size>.<ext>
// (a video's still: that name + .png; a remote file's hash covers its machine too).
const CACHE = "mods/vscode-viewer/.cache";
const pathHash = (s) => { let h = 5381; for (const c of s) h = (h * 33 ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
// Hot-exit backups: <app>/mods/vscode-viewer/.backups/<path hash>.json, the format editor/backup.cjs reads and writes:
// { path, text, cursor, time, mtimeMs, size } (mtimeMs/size: the file on disk at backup time; compared to the second).
const BACKUPS = "mods/vscode-viewer/.backups";
// { mtime (s), size } of a file here or on machine `on`, or null.
async function statOf(file, on = null) {
  const st = await exec("sh", ["-c", `stat -c '%Y %s' "$1" 2>/dev/null || stat -f '%m %z' "$1"`, "sh", file], { on }).catch(() => null);
  const [mtime, size] = (st?.stdout ?? "").trim().split(" ").map(Number);
  return st?.code === 0 && Number.isFinite(size) ? { mtime, size } : null;
}
// VS Code settings files allow comments and trailing commas.
const loose = (s) => JSON.parse(s.replace(/^\uFEFF/, "").replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));
// files.autoSave / files.autoSaveDelay (seconds, 0.1-3600) from vscode-settings.json; off when missing or invalid.
async function readAutoSave() {
  try {
    const raw = loose(await readTextFile(`${appHome()}/vscode-settings.json`));
    const mode = ["afterDelay", "onFocusChange"].includes(raw["files.autoSave"]) ? raw["files.autoSave"] : "off";
    const d = Number(raw["files.autoSaveDelay"]);
    return { mode, delay: Number.isFinite(d) && raw["files.autoSaveDelay"] != null ? Math.max(0.1, Math.min(3600, d)) : 1 };
  } catch { return { mode: "off", delay: 1 }; }
}
const timeText = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();

const tables = {};  // shared by every viewer: highlighter names (langs.json) and VS Code language scopes (vscode/index.json)
const tableReady = (path) => tables[path] ??= readTextFile(`${appHome()}/mods/vscode-viewer/${path}`).then(t => JSON.parse(t)).catch(() => ({ ext: {}, files: {}, prefixes: {} }));

// Material Icon Theme icon for a file name (the Explorer's table): exact name, then the longest extension.
function fileIcon(name, m) {
  if (!m?.names) return null;
  const n = name.toLowerCase();
  if (m.names[n]) return m.names[n];
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const e = m.ext[parts.slice(i).join(".")]; if (e) return e; }
  return m.file;
}

// What VS Code's status bar shows besides the language: line endings and the indentation the file uses.
function facts(text) {
  const lines = text.split(/\r\n|\r|\n/);
  let tabs = 0; const steps = {};
  for (const l of lines.slice(0, 2000)) {
    if (l.startsWith("\t")) tabs++;
    else { const m = l.match(/^( +)\S/); if (m && m[1].length <= 8) steps[m[1].length] = (steps[m[1].length] ?? 0) + 1; }
  }
  const spaceLines = Object.values(steps).reduce((a, b) => a + b, 0);
  const step = Object.keys(steps).map(Number).sort((a, b) => a - b).find(k => steps[k] >= Math.max(2, spaceLines * 0.1)) ?? 4;
  return { lines: lines.length, eol: text.includes("\r\n") ? "CRLF" : "LF", indent: tabs > spaceLines ? "Tabs" : `Spaces: ${step}` };
}

export default class Viewer extends View {
  init(given, cx) {
    const p = { ...props(), ...given };
    this.file = p.file; this.on = p.on ?? null; this.install = p.on && p.install ? "offer" : null;
    this.text = null;          // what is on disk, as last read or written
    this.code = null; this.dirty = false; this.conflict = false; this.wrap = false;
    this.error = null; this.table = null; this.language = "Plain Text"; this.facts = null;
    this.kind = p.preview ? "markdown" : kindOf(this.file ?? ""); this.preview = this.kind === "markdown"; this.img = null;
    this.autoSave = { mode: "off", delay: 1 }; this.autoToken = 0; this.hadFocus = false; this.restore = null; this.pane = null;
    this.load(cx);
    // Every 3 s; a local markdown preview every second, so it follows the terminal editor's saves.
    let tick = 0;
    cx.timer.every(1000, cx => { if (++tick % 3 === 0 || (this.preview && !this.on)) this.load(cx); });
    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "save") await this.save(cx); } });
    // onFocusChange: save when this tab stops being the focused pane.
    cx.timer.every(500, cx => {
      // Its own pane: props().pane (Herdr gives a tab's mod none), else learnPane's, else the only viewer pane there is.
      const mine = props().pane ?? this.pane ?? (panes().filter(p => p.mod === "vscode-viewer").length === 1 ? panes().find(p => p.mod === "vscode-viewer").pane : null);
      const now = !!mine && focused()?.pane === mine;
      if (this.hadFocus && !now && this.autoSave.mode === "onFocusChange") this.save(cx);
      // The Explorer reveals the focused tab's file (its autoReveal).
      if (now && !this.hadFocus) setShared("vscode-viewer.focused", { pane: mine, file: this.file, on: this.on });
      // Every viewer pane's file, for moving it to another tab (vscode-tabs' move.js VIEWER_FILES); gone panes dropped.
      const files = shared("vscode-viewer.files") ?? {};
      if (mine && (files[mine]?.file !== this.file || files[mine]?.on !== this.on)) {
        const live = new Set(panes().map(p => p.pane));
        setShared("vscode-viewer.files", { ...Object.fromEntries(Object.entries(files).filter(([k]) => live.has(k))), [mine]: { file: this.file, on: this.on } });
      }
      this.hadFocus = now;
    });
  }

  // Learns its own pane while on screen (pane.js ownPane: laid out or under the pointer means in the shown tab) and shares
  // its file for moving it to another tab at once (vscode-tabs' move.js VIEWER_FILES; gone panes dropped).
  learnPane(bounds) {
    if (this.pane || props().pane) return;
    const tab = spaces().find(s => s.active)?.tabs.find(t => t.active)?.id;
    const pane = ownPane({ panes: panes(), tab, bounds, headers: shared("vscode-pane.bounds") });
    const files = shared("vscode-viewer.files") ?? {}, live = new Set(panes().map(p => p.pane));
    if (!pane || (files[pane] && files[pane].file !== this.file)) return; // another viewer's, as its opener recorded it
    this.pane = pane;
    setShared("vscode-viewer.files", { ...Object.fromEntries(Object.entries(files).filter(([k]) => live.has(k))), [this.pane]: { file: this.file, on: this.on } });
  }

  // Herdr calls this when the tab closes: keep unsaved text as a hot-exit backup (bounded: one stat and one write).
  async close() {
    if (!this.code || !this.dirty || this.on) return;
    try {
      const st = await statOf(this.file);
      await exec("mkdir", ["-p", `${appHome()}/${BACKUPS}`]);
      await writeTextFile(this.backupPath(), JSON.stringify({ path: this.file, text: this.code.value(), cursor: null, time: Date.now(),
        mtimeMs: st ? st.mtime * 1000 : null, size: st?.size ?? null }));
    } catch {}
  }
  backupPath() { return `${appHome()}/${BACKUPS}/${pathHash(this.file)}.json`; }
  removeBackup() { if (!this.on) exec("rm", ["-f", this.backupPath()]).catch(() => {}); }
  // On first load: a backup with other text than the disk is offered back.
  async findBackup(disk) {
    if (this.on) return;
    const b = await readTextFile(this.backupPath()).then(t => JSON.parse(t)).catch(() => null);
    if (!b || b.path !== this.file || typeof b.text !== "string") return;
    if (b.text === disk) return this.removeBackup();
    const st = await statOf(this.file);
    const changed = b.mtimeMs == null ? !!st : !st || Math.floor(b.mtimeMs / 1000) !== st.mtime || b.size !== st.size;
    this.restore = { text: b.text, time: b.time, changed };
  }
  restoreBackup(cx) {
    const r = this.restore;
    this.restore = null;
    if (!r || !this.code) return cx.notify();
    this.preview = false; this.build(r.text); this.dirty = r.text !== this.text;
    cx.notify();
  }
  discardBackup(cx) { this.restore = null; this.removeBackup(); cx.notify(); }
  // afterDelay: save `delay` seconds after the last change (a newer change restarts the wait).
  scheduleAutoSave(cx) {
    if (this.autoSave.mode !== "afterDelay" || !this.dirty || this.on) return;
    const token = ++this.autoToken;
    cx.timer.after(this.autoSave.delay * 1000, cx => { if (token === this.autoToken && !this.conflict) this.save(cx); });
  }

  build(value) {
    this.code?.release();
    const name = this.file.split("/").pop();
    this.code = EditorState.new({ language: lookup(name, this.table) ?? "text", readonly: Boolean(this.on), value, font_size: 13,
      soft_wrap: this.wrap, syntax: { ...ONE_DARK, ...(this.palette ?? {}) } });
    this.code.on("change", (_e, cx) => { this.dirty = this.code.value() !== this.text; this.scheduleAutoSave(cx); cx.notify(); });
  }

  // Untouched buffers follow the disk; edited ones only flag a conflict.
  load(cx) {
    cx.spawn(async cx => {
      try {
        this.autoSave = await readAutoSave();
        if (!this.table) {
          this.table = await tableReady("langs.json");
          this.palette = (await palettesReady())[extOf(this.file.split("/").pop())];
          this.icon = fileIcon(this.file.split("/").pop(), await tableReady("../vscode-explorer/icons.json"));
          const scope = lookup(this.file.split("/").pop(), await tableReady("vscode/index.json"));
          this.language = scope ? NAMES[scope] ?? scope.replace(/^(source|text)\./, "") : "Plain Text";
        }
        if (this.kind === "image" || this.kind === "video") return await this.loadPreview(cx);
        const disk = await readTextFile(this.file, { on: this.on });
        if (disk === null) this.error = "This file is no longer available";
        else if (disk.includes("\0")) { this.code?.release(); this.code = null; this.error = "Binary file · no text preview"; }
        else if (disk !== this.text) {
          if (this.dirty) this.conflict = true;
          else {
            const first = this.text === null;
            this.error = null; this.conflict = false; this.text = disk; this.facts = facts(disk); this.build(disk);
            if (first) await this.findBackup(disk);
          }
        }
      } catch { this.error = "Cannot open this file (binary or larger than 1 MiB)"; }
      finally { cx.notify(); }
    });
  }

  // Re-copies the image (or the video's still) into the cache when its mtime or size changes, dropping this file's older
  // copies; a remote file is fetched first (preview.js), and not again after a failure until it changes.
  async loadPreview(cx) {
    if (this.copying) return;
    this.copying = true;
    try {
      const st = await statOf(this.file, this.on);
      if (!st) { this.img = null; this.error = "This file is no longer available"; return; }
      const { mtime, size } = st, key = `${mtime}-${size}`;
      if (this.img?.key === key || this.failed === key) return;
      const dir = `${appHome()}/${CACHE}`, id = pathHash(this.on ? `${this.on}:${this.file}` : this.file), name = `${id}-${key}.${extOf(this.file)}`;
      const shown = this.kind === "video" ? `${name}.png` : name;
      const fail = (why) => { this.img = null; this.error = why; this.failed = key; };
      if ((await exec("sh", ["-c", 'mkdir -p "$1" && rm -rf "$1/$2"-*', "sh", dir, id])).code !== 0) return fail("Cannot write the preview cache");
      let local = this.file;
      if (this.on && FETCHED.includes(this.kind)) {
        local = `${dir}/${name}`;
        this.img = null; this.error = null; this.fetching = `Fetching from ${this.on}…`; cx.notify();
        try { await fetchFile(exec, this.on, this.file, local, size, p => { this.fetching = `Fetching from ${this.on}… ${Math.round(p * 100)}%`; cx.notify(); }); }
        catch (e) { return fail(e.message); }
        finally { this.fetching = null; }
      }
      const made = this.kind === "video" ? await exec("sh", ["-c", POSTER, "sh", local, `${dir}/${id}-ql`, `${dir}/${shown}`])
        : local === this.file ? await exec("cp", [this.file, `${dir}/${name}`]) : { code: 0 };
      if (made.code !== 0) return fail(`Cannot preview this ${this.kind}`);
      const dims = this.kind === "image" ? await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", local]).then(r => sipsSize(r.stdout)).catch(() => null) : null;
      this.img = { key, path: `${CACHE}/${shown}`, local, size, dims }; this.error = null; this.failed = null;
      await prune(exec, dir, [name, shown]).catch(() => {});
    } finally { this.copying = false; }
  }

  // Writes only if the disk still holds what was loaded; otherwise the conflict banner decides.
  async save(cx, force = false) {
    if (!this.code || !this.dirty || this.on) return;
    const value = this.code.value();
    try {
      const expected = force ? await readTextFile(this.file) : this.text;
      await writeTextFile(this.file, value, expected);
      this.text = value; this.facts = facts(value); this.dirty = false; this.conflict = false; this.error = null;
      this.removeBackup();
    } catch { this.conflict = true; }
    cx.notify();
  }

  // The Explorer's install (vscode-explorer remote.js: INSTALL_REQUEST, then its install-remote command); its toasts
  // tell how it went, and the file's next open takes the editor.
  installEditor(cx) {
    setShared("vscode-explorer.remote-install", { machine: this.on, at: Date.now() });
    run("vscode-explorer.install-remote");
    this.install = "asked";
    cx.notify();
  }

  revert(cx) { this.dirty = false; this.conflict = false; this.text = null; this.restore = null; this.removeBackup(); this.load(cx); }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    if (this.code) this.build(this.code.value());
    cx.notify();
  }

  body(t) {
    if (this.kind === "image" || this.kind === "video") return this.img
      ? v_flex().flex_1().min_h(0).relative().items_center().justify_center().p(16).overflow_hidden().bg(EDITOR_BG)
        .child(window.paint_path(RECT(), Background.checkerboard("#323842", 8)).absolute().top(0).left(0).size_full())
        .child(image(this.img.path).max_w("100%").max_h("100%"))
      : div().p(12).text_color(t.dim).child(this.error || this.fetching || `Loading ${this.kind}…`);
    if (!this.code) return div().p(12).text_color(t.dim).child(this.error || "Loading file…");
    if (this.preview) return TextView.markdown("preview", this.code.value()).scrollable(true).selectable(true)
      .flex_1().min_h(0).px(28).py(16).bg(EDITOR_BG).text_color(EDITOR_FG).text_size(14);
    return Editor.new(this.code).flex_1().min_h(0).bg(EDITOR_BG).text_color(EDITOR_FG);
  }

  render() {
    const t = theme(), text = this.kind !== "image" && this.kind !== "video", parts = (this.file ?? "").split("/").filter(Boolean), name = parts[parts.length - 1] ?? "";
    // Ghost buttons like VS Code's editor actions: no fill until hovered or active.
    const button = (id, label, onClick, on = false) => div().id(id).px(7).h(22).flex().items_center().rounded(4).cursor_pointer().text_size(11.5)
      .text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
    // Breadcrumbs: the last folders, then the file with its Material icon, as VS Code draws them.
    const crumbs = h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12.5).text_color(t.muted).overflow_hidden()
      .children(parts.slice(-4, -1).flatMap(p => [div().flex_none().child(p), div().flex_none().text_color(t.dim).child("›")]))
      .when(Boolean(this.icon), el => el.child(image(`mods/vscode-explorer/icons/${this.icon}.svg`).w(15).h(15).flex_none()))
      .child(div().flex_none().text_color(t.foreground).child(name));
    return v_flex().id("viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change(() => this.learnPane(null)).on_mouse_move((e) => this.learnPane(e.bounds))
      .on_mouse_down("left", (e) => this.learnPane(e.bounds ?? null))
      .child(h_flex().h(30).flex_none().pl(16).pr(10).gap(6).items_center()
        .child(crumbs)
        .when(this.dirty, el => el.child(div().size(8).rounded(4).bg("#e5c07b").flex_none()))
        .when(this.kind === "markdown", el => el.child(button("preview", this.preview ? "Edit" : "Preview", cx => { this.preview = !this.preview; cx.notify(); })))
        .when(text && !this.preview, el => el.child(button("wrap", "Wrap", cx => this.toggleWrap(cx), this.wrap)))
        .when(this.dirty, el => el.child(button("revert", "Revert", cx => this.revert(cx))))
        .when(this.kind === "video" && Boolean(this.img), el => el.child(button("play", "Open in Player", () => exec("open", [this.img.local]).catch(() => {}))))
        .when(Boolean(this.install), el => el.child(button("install", this.install === "asked" ? "Installing…" : `Install Editor on ${this.on}`, cx => this.install === "offer" && this.installEditor(cx))))
        .when(!this.on, el => el.child(button("vscode", "Open in VS Code", () => userExec("code", [this.file]).catch(() => {}))))
        .when(text && !this.on, el => el.child(button("save", this.dirty ? "Save ⌘S" : "Saved", cx => this.save(cx), this.dirty))))
      .when(this.conflict, el => el.child(h_flex().flex_none().px(14).py(6).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().text_color("#e5c07b").child("This file changed on disk."))
        .child(button("reload", "Reload (discard my edits)", cx => this.revert(cx)))
        .child(button("overwrite", "Overwrite", cx => this.save(cx, true)))))
      .when(Boolean(this.restore), el => el.child(h_flex().flex_none().px(14).py(6).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().text_color("#e5c07b").child(`Restore unsaved changes from ${timeText(this.restore.time)}?${this.restore.changed ? " The file has changed on disk since." : ""}`))
        .child(button("restore", "Restore", cx => this.restoreBackup(cx)))
        .child(button("discard", "Discard", cx => this.discardBackup(cx)))))
      .child(this.body(t))
      .child(h_flex().h(22).flex_none().px(12).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .child(div().child(text ? this.language : IMAGES[extOf(this.file)] ?? VIDEOS[extOf(this.file)]))
        .when(this.on, el => el.child(div().child("Read-only (remote)")))
        .when(text && !this.on && this.autoSave.mode !== "off", el => el.child(div().child(this.autoSave.mode === "afterDelay" ? `Auto Save: after ${this.autoSave.delay}s` : "Auto Save: on focus change")))
        .child(div().flex_1())
        .when(Boolean(this.img), el => el.when(Boolean(this.img.dims), el => el.child(div().child(this.img.dims))).child(div().child(sizeText(this.img.size))))
        .when(Boolean(this.facts), el => el.child(div().child(`${this.facts.lines.toLocaleString()} lines`)).child(div().child(this.facts.indent)).child(div().child("UTF-8")).child(div().child(this.facts.eol))));
  }
}
