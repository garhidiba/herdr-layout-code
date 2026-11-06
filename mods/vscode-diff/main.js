// A read-only diff tab, like VS Code's inline diff editor: props { repo, commit, parent, path, oldPath?, on? }.
// commit null: HEAD ↔ the working tree. parent null (a root commit): an empty left side.
// Text is colored by VS Code's own engine (vscode-viewer's vscode/ folder) through `node tokens.cjs`.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { props, exec, readTextFile, theme, settings, appHome, run } from "herdr";
import { splitLines, diffLines, visibleRows } from "./diff.js";
// Herdr starts with PATH=/usr/bin:/bin, so Homebrew/user tools (node, code, codex, trash) are looked up here too.
const userExec = (cmd, args, opts) => exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; exec "$0" "$@"', cmd, ...args], opts);

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const MAX_LINES = 20000, MAX_OUTPUT = 8 * 1024 * 1024 - 1024, ROW = 20, GUTTER = 44, SIGN = 18, CHAR = 8, MAX_LINE = 4000;
// Atom One Dark (akamud.vscode-theme-onedark): editor background/foreground and line numbers; diff fills.
const BG = "#282c34", FG = "#abb2bf", NUMBER = "#636d83", REMOVED = "#e06c7520", ADDED = "#98c37920", FOLD = "#2c313c", FOLD_TEXT = "#7f848e";
const short = (rev) => rev ? rev.slice(0, 7) : "∅";
// Open File as the Explorer opens a local file (vscode-explorer paths.js openArgs): the terminal editor in a tab of its
// own, images in the viewer. A remote file opens in the viewer (the Explorer finds the editor installed on its machine).
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?)$/i;
const openFileArgs = (file, name, folder, on) => (on || IMAGE.test(name) ? { name, mod: "vscode-viewer", props: { file, on } }
  : { name, folder, argv: ["exec", "sh", `${appHome()}/mods/vscode-viewer/editor/vsedit.sh`, file, "--close-on-exit"] });
const tabs = (s) => s.replace(/\t/g, "    ");

// Material Icon Theme icon for a file name (the Explorer's table): exact name, then the longest extension.
function fileIcon(name, m) {
  if (!m?.names) return null;
  const n = name.toLowerCase();
  if (m.names[n]) return m.names[n];
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const e = m.ext[parts.slice(i).join(".")]; if (e) return e; }
  return m.file;
}

export default class Diff extends View {
  init(given, cx) {
    const p = { ...props(), ...given };
    this.repo = p.repo; this.commit = p.commit ?? null; this.path = p.path; this.on = p.on ?? null;
    this.parent = this.commit ? p.parent ?? null : "HEAD"; this.oldPath = p.oldPath ?? p.path;
    this.texts = null; this.ops = []; this.rows = []; this.open = new Set(); this.tokens = [null, null]; this.error = null; this.width = 0;
    cx.spawn(async (cx) => {
      try { this.icon = fileIcon(this.path.split("/").pop(), JSON.parse(await readTextFile(`${appHome()}/mods/vscode-explorer/icons.json`))); } catch {}
      cx.notify();
    });
    this.load(cx);
    // A commit never changes; the working tree is read again every 3s.
    if (!this.commit) cx.timer.every(3000, (cx) => this.load(cx));
  }

  // A blob's text, "" when the revision has no such file.
  async blob(rev) {
    const r = await exec("git", [...READ, "cat-file", "blob", rev], { cwd: this.repo, on: this.on });
    if (r.code !== 0) return "";
    if (r.stdout.length >= MAX_OUTPUT) throw new Error("large");
    return r.stdout;
  }

  async newText() {
    if (this.commit) return this.blob(`${this.commit}:${this.path}`);
    return (await readTextFile(`${this.repo}/${this.path}`, { on: this.on })) ?? "";
  }

  load(cx) {
    if (this.loading || !this.repo || !this.path) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const texts = [this.parent ? await this.blob(`${this.parent}:${this.oldPath}`) : "", await this.newText()];
        if (this.texts && texts[0] === this.texts[0] && texts[1] === this.texts[1]) return;
        this.texts = texts; this.tokens = [null, null]; this.error = null; this.ops = []; this.open = new Set();
        if (texts.some((t) => t.includes("\0"))) this.error = "Binary file · no text diff";
        else {
          const [a, b] = texts.map(splitLines);
          if (a.length > MAX_LINES || b.length > MAX_LINES) this.error = "File too large to diff";
          else {
            this.lines = [a, b]; this.ops = diffLines(a, b);
            this.width = 2 * GUTTER + SIGN + 40 + CHAR * Math.min(MAX_LINE, Math.max(0, ...a.map((l) => tabs(l).length), ...b.map((l) => tabs(l).length)));
            if (!this.on) this.color(texts, cx);
          }
        }
        this.layout();
      } catch { this.error = "File too large to diff"; this.ops = []; this.layout(); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Both sides through tokens.cjs; plain #abb2bf text when node or the engine is missing.
  color(texts, cx) {
    const helper = `${appHome()}/mods/vscode-diff/tokens.cjs`, engine = `${appHome()}/mods/vscode-viewer/vscode`, name = this.path.split("/").pop();
    const sides = [this.parent && `${this.parent}:${this.oldPath}`, this.commit ? `${this.commit}:${this.path}` : null];
    sides.forEach((rev, i) => {
      if (!texts[i]) return;
      cx.spawn(async (cx) => {
        try {
          const r = rev
            ? await exec("sh", ["-c", 'PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; git --no-optional-locks -C "$1" cat-file blob "$2" | node "$3" "$4" "$5" "" "$6"', "diff", this.repo, rev, helper, engine, name, String(MAX_LINES)])
            : await userExec("node", [helper, engine, name, `${this.repo}/${this.path}`, String(MAX_LINES)]);
          if (r.code === 0 && this.texts === texts) { this.tokens[i] = JSON.parse(r.stdout); cx.notify(); }
        } catch {}
      });
    });
  }

  layout() { this.rows = visibleRows(this.ops, this.open); }

  unfold(key, cx) {
    if (!key.startsWith("fold:")) return;
    this.open.add(Number(key.slice(5))); this.layout(); cx.notify();
  }

  // One line: old and new numbers, the sign, then the text in VS Code's token colors.
  line({ t, o, n }) {
    const side = t === "-" ? 0 : 1, index = side ? n : o, tokens = this.tokens[side], spans = [];
    const row = tokens?.lines[index];
    if (Array.isArray(row)) for (let i = 0; i < row.length; i += 3) {
      if (!row[i]) continue;
      const style = row[i + 2];
      spans.push(div().flex_none().text_color(tokens.colors[row[i + 1]] ?? FG).when(Boolean(style & 1), (e) => e.italic()).when(Boolean(style & 2), (e) => e.font_bold())
        .when(Boolean(style & 4), (e) => e.underline()).child(tabs(row[i].slice(0, MAX_LINE))));
    }
    else spans.push(div().flex_none().child(tabs(this.lines[side][index] ?? "").slice(0, MAX_LINE)));
    return h_flex().w_full().h(ROW).flex_none().items_center().when(t === "-", (e) => e.bg(REMOVED)).when(t === "+", (e) => e.bg(ADDED))
      .child(div().w(GUTTER).flex_none().text_right().text_color(NUMBER).child(o === undefined ? "" : String(o + 1)))
      .child(div().w(GUTTER).flex_none().text_right().text_color(NUMBER).child(n === undefined ? "" : String(n + 1)))
      .child(div().w(SIGN).ml(8).flex_none().text_color(NUMBER).child(t === " " ? "" : t))
      .child(h_flex().flex_none().children(spans));
  }

  fold(row) {
    return h_flex().w_full().h(ROW).flex_none().items_center().bg(FOLD).text_color(FOLD_TEXT).cursor_pointer()
      .child(div().w(2 * GUTTER + SIGN + 8).flex_none().text_center().child("⋯"))
      .child(div().flex_none().child(`${row.count.toLocaleString()} unchanged line${row.count === 1 ? "" : "s"}`));
  }

  body(t) {
    if (this.error || !this.texts) return div().p(12).text_color(t.dim).child(this.error || "Loading diff…");
    if (!this.rows.length) return div().p(12).text_color(t.dim).child("Empty file");
    const key = (i) => { const r = this.rows[i]; return r.fold !== undefined ? `fold:${r.fold}` : `l:${r.op.o ?? ""}:${r.op.n ?? ""}`; };
    return div().flex_1().min_h(0).relative().bg(BG).text_color(FG).font_family(settings().font_family ?? "JetBrains Mono").text_size(13)
      .child(div().id("diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("diff-rows", this.rows.length, ROW, key,
          (range) => this.rows.slice(range.start, range.end).map((r) => r.fold !== undefined ? this.fold(r) : this.line(r.op))).size_full()
          .on_item_click((key, cx) => this.unfold(key, cx)))))
      .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0());
  }

  render() {
    const t = theme(), parts = (this.path ?? "").split("/").filter(Boolean), name = parts[parts.length - 1] ?? "", file = `${this.repo}/${this.path}`;
    const button = (id, label, onClick) => div().id(id).px(7).h(22).flex().items_center().rounded(4).cursor_pointer().text_size(11.5)
      .text_color(t.muted).hover((s) => s.bg(t.hover)).on_click(() => onClick()).child(label);
    // Breadcrumbs as the editor tab draws them, then the two revisions.
    const crumbs = h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12.5).text_color(t.muted).overflow_hidden()
      .children(parts.slice(-4, -1).flatMap((p) => [div().flex_none().child(p), div().flex_none().text_color(t.dim).child("›")]))
      .when(Boolean(this.icon), (el) => el.child(image(`mods/vscode-explorer/icons/${this.icon}.svg`).w(15).h(15).flex_none()))
      .child(div().flex_none().text_color(t.foreground).child(name))
      .child(div().flex_none().ml(6).text_size(11.5).text_color(t.dim).child(`${short(this.parent)} ↔ ${this.commit ? short(this.commit) : "Working Tree"}`));
    return v_flex().id("diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(30).flex_none().pl(16).pr(10).gap(6).items_center()
        .child(crumbs)
        .child(button("open-file", "Open File", () => run("tab.new", openFileArgs(file, name, this.repo, this.on))))
        .when(!this.on, (el) => el.child(button("vscode", "Open in VS Code", () => userExec("code", [file]).catch(() => {})))))
      .child(this.body(t));
  }
}
