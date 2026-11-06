// A file editor for a tab: props { file: absolute path, on?: machine }.
// Opens straight into Herdr's built-in editor (Atom One Dark colors, VS Code's file-type recognition from langs.json),
// saves with Cmd+S ("vscode-viewer.save" in keys.json), flags changes on disk, and shows a VS Code-style status bar.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { props, readTextFile, writeTextFile, exec, theme, appHome, nextCommand } from "herdr";

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
    this.file = p.file; this.on = p.on ?? null;
    this.text = null;          // what is on disk, as last read or written
    this.code = null; this.dirty = false; this.conflict = false; this.wrap = false;
    this.error = null; this.table = null; this.language = "Plain Text"; this.facts = null;
    this.load(cx);
    cx.timer.every(3000, cx => this.load(cx));
    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "save") await this.save(cx); } });
  }

  build(value) {
    this.code?.release();
    const name = this.file.split("/").pop();
    this.code = EditorState.new({ language: lookup(name, this.table) ?? "text", readonly: Boolean(this.on), value, font_size: 13,
      soft_wrap: this.wrap, syntax: { ...ONE_DARK, ...(this.palette ?? {}) } });
    this.code.on("change", (_e, cx) => { this.dirty = this.code.value() !== this.text; cx.notify(); });
  }

  // Untouched buffers follow the disk; edited ones only flag a conflict.
  load(cx) {
    cx.spawn(async cx => {
      try {
        if (!this.table) {
          this.table = await tableReady("langs.json");
          this.palette = (await palettesReady())[extOf(this.file.split("/").pop())];
          this.icon = fileIcon(this.file.split("/").pop(), await tableReady("../vscode-explorer/icons.json"));
          const scope = lookup(this.file.split("/").pop(), await tableReady("vscode/index.json"));
          this.language = scope ? NAMES[scope] ?? scope.replace(/^(source|text)\./, "") : "Plain Text";
        }
        const disk = await readTextFile(this.file, { on: this.on });
        if (disk === null) this.error = "This file is no longer available";
        else if (disk.includes("\0")) { this.code?.release(); this.code = null; this.error = "Binary file · no text preview"; }
        else if (disk !== this.text) {
          if (this.dirty) this.conflict = true;
          else { this.error = null; this.conflict = false; this.text = disk; this.facts = facts(disk); this.build(disk); }
        }
      } catch { this.error = "Cannot open this file (binary or larger than 1 MiB)"; }
      cx.notify();
    });
  }

  // Writes only if the disk still holds what was loaded; otherwise the conflict banner decides.
  async save(cx, force = false) {
    if (!this.code || !this.dirty || this.on) return;
    const value = this.code.value();
    try {
      const expected = force ? await readTextFile(this.file) : this.text;
      await writeTextFile(this.file, value, expected);
      this.text = value; this.facts = facts(value); this.dirty = false; this.conflict = false; this.error = null;
    } catch { this.conflict = true; }
    cx.notify();
  }

  revert(cx) { this.dirty = false; this.conflict = false; this.text = null; this.load(cx); }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    if (this.code) this.build(this.code.value());
    cx.notify();
  }

  render() {
    const t = theme(), parts = (this.file ?? "").split("/").filter(Boolean), name = parts[parts.length - 1] ?? "";
    // Ghost buttons like VS Code's editor actions: no fill until hovered or active.
    const button = (id, label, onClick, on = false) => div().id(id).px(7).h(22).flex().items_center().rounded(4).cursor_pointer().text_size(11.5)
      .text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
    // Breadcrumbs: the last folders, then the file with its Material icon, as VS Code draws them.
    const crumbs = h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12.5).text_color(t.muted).overflow_hidden()
      .children(parts.slice(-4, -1).flatMap(p => [div().flex_none().child(p), div().flex_none().text_color(t.dim).child("›")]))
      .when(Boolean(this.icon), el => el.child(image(`mods/vscode-explorer/icons/${this.icon}.svg`).w(15).h(15).flex_none()))
      .child(div().flex_none().text_color(t.foreground).child(name));
    return v_flex().id("viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(30).flex_none().pl(16).pr(10).gap(6).items_center()
        .child(crumbs)
        .when(this.dirty, el => el.child(div().size(8).rounded(4).bg("#e5c07b").flex_none()))
        .child(button("wrap", "Wrap", cx => this.toggleWrap(cx), this.wrap))
        .when(this.dirty, el => el.child(button("revert", "Revert", cx => this.revert(cx))))
        .when(!this.on, el => el.child(button("vscode", "Open in VS Code", () => exec("code", [this.file]).catch(() => {}))))
        .when(!this.on, el => el.child(button("save", this.dirty ? "Save ⌘S" : "Saved", cx => this.save(cx), this.dirty))))
      .when(this.conflict, el => el.child(h_flex().flex_none().px(14).py(6).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().text_color("#e5c07b").child("This file changed on disk."))
        .child(button("reload", "Reload (discard my edits)", cx => this.revert(cx)))
        .child(button("overwrite", "Overwrite", cx => this.save(cx, true)))))
      .child(this.code ? Editor.new(this.code).flex_1().min_h(0).bg(EDITOR_BG).text_color(EDITOR_FG) : div().p(12).text_color(t.dim).child(this.error || "Loading file…"))
      .child(h_flex().h(22).flex_none().px(12).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .child(div().child(this.language))
        .when(this.on, el => el.child(div().child("Read-only (remote)")))
        .child(div().flex_1())
        .when(Boolean(this.facts), el => el.child(div().child(`${this.facts.lines.toLocaleString()} lines`)).child(div().child(this.facts.indent)).child(div().child("UTF-8")).child(div().child(this.facts.eol))));
  }
}
