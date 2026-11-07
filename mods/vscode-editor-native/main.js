// Spike: a code editor drawn natively (GPUI through QuickJS) instead of in a terminal. props { file, server?, vscode? }.
// Colors come from `vsedit --serve` (the Rust tokenizer worker, serve.rs) over a loopback socket. Typing and the Korean
// IME go through a Herdr `Input` placed inline at the caret (Monaco's hidden-textarea trick): its preedit draws in
// place, committed text moves into our lines. The header, status bar and event log are instrumentation for the spike.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { show_fps_monitor, hide_fps_monitor, fps_monitor_visible } from "gpui-fps";
import { Buffer } from "buffer";
import net from "net";
import { props, exec, readTextFile, settings, appHome, nextCommand } from "herdr";

const ROW = 20, SIZE = 13, PAD = 14, TAB = "    ";
const BG = "#282c34", FG = "#abb2bf", NUM = "#636d83", CUR_LINE = "#2c313c", SEL = "#3e4451", CARET = "#528bff", BAR = "#21252b", BAR_FG = "#9da5b4";
const now = () => globalThis.performance?.now?.() ?? Date.now();
const isWide = (k) => (k >= 0x1100 && k <= 0x115f) || (k >= 0x2e80 && k <= 0xa4cf) || (k >= 0xac00 && k <= 0xd7a3) || (k >= 0xf900 && k <= 0xfaff) || (k >= 0xff00 && k <= 0xff60);
// A character a Hangul IME may still be composing: it stays in the Input until something else ends the composition.
const composable = (ch) => /[ᄀ-ᇿ㄰-㆏가-힣]/.test(ch ?? "");
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);
const f1 = (x) => (x == null ? "–" : x.toFixed(1));
const cmp = (a, b) => a.l - b.l || a.c - b.c;
const keep = (xs, x, n = 60) => { xs.push(x); if (xs.length > n) xs.shift(); };

// Keystroke → command. Bound in the context "NativeEditor > Input" so they win over the Input's own bindings
// (same depth, registered later); the editor area's on_key_down handles the same table for keys that still reach it.
const KEYS = {
  left: "left", right: "right", up: "up", down: "down", home: "home", end: "end", "cmd-left": "home", "cmd-right": "end",
  "cmd-up": "top", "cmd-down": "bottom", pageup: "pageup", pagedown: "pagedown",
  "shift-left": "s_left", "shift-right": "s_right", "shift-up": "s_up", "shift-down": "s_down", "shift-home": "s_home",
  "shift-end": "s_end", "cmd-shift-left": "s_home", "cmd-shift-right": "s_end",
  backspace: "backspace", delete: "delete", enter: "enter", tab: "tab", escape: "escape",
  "cmd-a": "select_all", "cmd-c": "copy", "cmd-x": "cut", "cmd-v": "paste", "cmd-z": "undo", "cmd-shift-z": "undo",
};

export default class NativeEditor extends View {
  init(given, cx) {
    const p = { ...props(), ...given };
    this.file = p.file; this.t0 = now();
    this.lines = null; this.tok = []; this.colors = []; this.scope = null;
    this.caret = { l: 0, c: 0 }; this.anchor = null; this.scrollTop = 0; this.scrollLeft = 0;
    this.view = { width: 800, height: 600 }; this.charW = 7.8; this.wideW = 13;
    this.pending = ""; this.events = []; this.lat = []; this.renders = []; this.wheel = [];
    this.seq = 0; this.editLog = []; this.sentView = ""; this.server = "starting"; this.timings = {};
    this.font = settings().font_family ?? "JetBrains Mono";
    this.input = InputState.new({});
    this.input.on("change", (_e, cx) => this.onInput(cx));
    this.input.on("submit", (_e, cx) => this.command("enter", "submit", cx));
    this.input.on("blur", (_e, cx) => { this.log("blur"); this.flush(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.log("focus"); cx.notify(); });
    try {
      const n = cx.bind_keys(Object.entries(KEYS).map(([keystroke, c]) => ({ keystroke, action: `ned_${c}`, context: "NativeEditor > Input" })));
      this.log(`bind_keys: ${n}`);
    } catch (e) { this.log(`bind_keys failed: ${e.message ?? e}`); }
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "focus") { this.input.focus(); cx.notify(); } } });
    this.start(p, cx);
  }

  // The tokenizer server: spawn (it detaches and prints its port), connect, open the file. Without it: plain text.
  start(p, cx) {
    cx.spawn(async (cx) => {
      const bin = p.server ?? `${appHome()}/vscode-core/vsedit`, vscode = p.vscode ?? `${appHome()}/mods/vscode-viewer/vscode`;
      try {
        const r = await exec(bin, ["--serve", "--vscode", vscode]);
        const port = JSON.parse(r.stdout).port;
        if (!port) throw new Error(r.stdout || r.stderr || `exit ${r.code}`);
        this.timings.spawn = now() - this.t0;
        this.sock = await net.connect("127.0.0.1", port);
        this.timings.connect = now() - this.t0;
        this.server = `port ${port}`;
        this.send({ op: "open", file: this.file });
        await this.readLoop(cx);
        this.server = "closed";
      } catch (e) {
        this.server = `none (${String(e.message ?? e).slice(0, 80)})`;
        this.log(`server: ${this.server}`);
        if (!this.lines) {
          const text = (await readTextFile(this.file)) ?? "";
          this.lines = text.split(/\r\n|\r|\n/); this.tok = this.lines.map(() => null);
        }
      }
      cx.notify();
    });
  }

  send(m) {
    if (!this.sock) return;
    const s = JSON.stringify(m) + "\n";
    this.wq = (this.wq ?? Promise.resolve()).then(() => this.sock.write(s)).catch(() => {});
  }

  async readLoop(cx) {
    let rest = new Uint8Array(0);
    for (;;) {
      const chunk = await this.sock.read(1 << 16);
      if (!chunk) return;
      const buf = new Uint8Array(rest.length + chunk.length);
      buf.set(rest); buf.set(chunk, rest.length);
      let start = 0, nl;
      while ((nl = buf.indexOf(10, start)) >= 0) {
        this.onMessage(JSON.parse(Buffer.from(buf.subarray(start, nl)).toString("utf8")));
        start = nl + 1;
      }
      rest = buf.slice(start);
      cx.notify();
    }
  }

  onMessage(m) {
    if (m.op === "opened") {
      this.lines = m.lines; this.tok = m.lines.map(() => null); this.scope = m.scope;
      this.timings.opened = now() - this.t0; this.timings.read = m.ms;
      this.sendView();
      try { this.input.focus(); } catch (e) { this.log(`focus: ${e.message ?? e}`); }
    } else if (m.op === "colors") this.colors = m.colors;
    else if (m.op === "tokens") {
      // Lines edited since the server tokenized them are dropped; later inserts/removals shift the rest.
      const later = this.editLog.filter((e) => e.seq > m.seq);
      this.editLog = later;
      for (const [line0, row] of m.items) {
        let line = line0, gone = false;
        for (const e of later) {
          if (line >= e.start + e.removed) line += e.inserted - e.removed;
          else if (line >= e.start) { gone = true; break; }
        }
        if (!gone && line < this.tok.length) this.tok[line] = row;
      }
      if (!this.timings.colored && this.visibleColored()) this.timings.colored = now() - this.t0;
    }
  }

  visibleColored() {
    const [a, b] = this.visibleRange();
    for (let l = a; l < b; l++) if (!this.tok[l]) return false;
    return true;
  }

  visibleRange() {
    const n = this.lines?.length ?? 0;
    return [Math.max(0, Math.floor(this.scrollTop / ROW)), Math.min(n, Math.ceil((this.scrollTop + this.view.height) / ROW) + 1)];
  }

  sendView() {
    const [a, b] = this.visibleRange(), key = `${a}:${b}`;
    if (key !== this.sentView) { this.sentView = key; this.send({ op: "view", first: a, last: b }); }
  }

  log(s) { keep(this.events, `${(now() - this.t0).toFixed(0)} ${s}`, 8); }

  // ---- text ----
  edit(start, removed, lines) {
    const old = this.tok.slice(start, start + removed);
    this.lines.splice(start, removed, ...lines);
    this.tok.splice(start, removed, ...lines.map((_, i) => old[i] ?? null)); // stale colors until the new ones arrive
    this.seq++;
    this.editLog.push({ seq: this.seq, start, removed, inserted: lines.length });
    this.send({ op: "edit", start, removed, lines });
  }

  selection() { return this.anchor && cmp(this.anchor, this.caret) ? (cmp(this.anchor, this.caret) < 0 ? [this.anchor, this.caret] : [this.caret, this.anchor]) : null; }

  replace(s, e, text) {
    const before = this.lines[s.l].slice(0, s.c), after = this.lines[e.l].slice(e.c), parts = text.split("\n");
    const lastLen = parts[parts.length - 1].length;
    parts[0] = before + parts[0]; parts[parts.length - 1] += after;
    this.edit(s.l, e.l - s.l + 1, parts);
    this.caret = { l: s.l + parts.length - 1, c: (parts.length === 1 ? before.length : 0) + lastLen };
    this.anchor = null;
  }

  insert(text) {
    if (!this.lines) return;
    const sel = this.selection();
    this.replace(sel ? sel[0] : this.caret, sel ? sel[1] : this.caret, text);
  }

  // Moves into the Input go into our lines: everything it holds, once nothing can be composing any more.
  flush() {
    if (!this.pending) return;
    const v = this.input.value();
    this.clearing = true;
    try { this.input.set_value(""); } finally { this.clearing = false; }
    this.pending = "";
    if (v) { this.insert(v); this.log(`commit ${JSON.stringify(v)}`); }
  }

  onInput(cx) {
    const v = this.input.value();
    this.log(`change ${JSON.stringify(v)}${this.clearing ? " (clear)" : ""}`);
    if (this.clearing) return;
    this.pending = v;
    if (v) this.flush(); // `change` only comes on commit (the marked syllable never reaches us), so take it all now
    this.reveal();
    cx.notify();
  }

  step(pos, dir) {
    const line = this.lines[pos.l];
    if (dir < 0) {
      if (pos.c > 0) return { l: pos.l, c: pos.c - (pos.c > 1 && /[\udc00-\udfff]/.test(line[pos.c - 1]) ? 2 : 1) };
      return pos.l > 0 ? { l: pos.l - 1, c: this.lines[pos.l - 1].length } : pos;
    }
    if (pos.c < line.length) return { l: pos.l, c: pos.c + (/[\ud800-\udbff]/.test(line[pos.c]) ? 2 : 1) };
    return pos.l < this.lines.length - 1 ? { l: pos.l + 1, c: 0 } : pos;
  }

  vertical(d) {
    const l = Math.max(0, Math.min(this.lines.length - 1, this.caret.l + d));
    return { l, c: Math.min(this.goal ?? this.caret.c, this.lines[l].length) };
  }

  command(cmd, via, cx) {
    this.keyAt = now();
    this.log(`${via}:${cmd}`);
    if (!this.lines) return;
    this.flush();
    const sel = this.selection(), page = Math.max(1, Math.floor(this.view.height / ROW) - 1);
    const moves = {
      left: () => (sel && !cmd.startsWith("s_") ? sel[0] : this.step(this.caret, -1)),
      right: () => (sel && !cmd.startsWith("s_") ? sel[1] : this.step(this.caret, 1)),
      up: () => this.vertical(-1), down: () => this.vertical(1), pageup: () => this.vertical(-page), pagedown: () => this.vertical(page),
      home: () => ({ l: this.caret.l, c: this.caret.c === this.indent(this.caret.l) ? 0 : this.indent(this.caret.l) }),
      end: () => ({ l: this.caret.l, c: this.lines[this.caret.l].length }),
      top: () => ({ l: 0, c: 0 }), bottom: () => ({ l: this.lines.length - 1, c: this.lines[this.lines.length - 1].length }),
    };
    const base = cmd.replace(/^s_/, "");
    if (moves[base]) {
      const vertical = ["up", "down", "pageup", "pagedown"].includes(base);
      if (vertical) this.goal ??= this.caret.c; else this.goal = undefined;
      if (cmd.startsWith("s_")) this.anchor ??= { ...this.caret }; else this.anchor = null;
      this.caret = moves[base]();
    } else {
      this.goal = undefined;
      switch (cmd) {
        case "backspace": if (sel) this.insert(""); else { const p = this.step(this.caret, -1); if (cmp(p, this.caret)) this.replace(p, this.caret, ""); } break;
        case "delete": if (sel) this.insert(""); else { const p = this.step(this.caret, 1); if (cmp(p, this.caret)) this.replace(this.caret, p, ""); } break;
        case "enter": this.insert("\n" + this.lines[this.caret.l].slice(0, this.indent(this.caret.l))); break;
        case "tab": this.insert(TAB); break;
        case "escape": this.anchor = null; break;
        case "select_all": this.anchor = { l: 0, c: 0 }; this.caret = moves.bottom(); break;
        case "copy": case "cut": {
          const whole = !sel, s = sel ?? [{ l: this.caret.l, c: 0 }, this.step({ l: this.caret.l, c: this.lines[this.caret.l].length }, 1)];
          cx.write_to_clipboard(this.text(s[0], s[1]) + (whole && s[1].l === s[0].l ? "\n" : ""));
          if (cmd === "cut") this.replace(s[0], s[1], "");
          break;
        }
        case "paste": { const t = cx.read_from_clipboard(); if (t) this.insert(t.replace(/\r\n?/g, "\n")); break; }
        case "undo": this.log("undo: not in this spike"); break;
      }
    }
    this.reveal();
    cx.notify();
  }

  indent(l) { return /^[ \t]*/.exec(this.lines[l])[0].length; }

  text(s, e) {
    if (s.l === e.l) return this.lines[s.l].slice(s.c, e.c);
    return [this.lines[s.l].slice(s.c), ...this.lines.slice(s.l + 1, e.l), this.lines[e.l].slice(0, e.c)].join("\n");
  }

  // ---- geometry: x of a UTF-16 column, measured from the font (ASCII and wide widths) ----
  width(s) {
    let w = 0;
    for (const ch of s) { const k = ch.codePointAt(0); w += k === 9 ? TAB.length * this.charW : isWide(k) ? this.wideW : this.charW; }
    return w;
  }

  colAt(l, x) {
    const line = this.lines[l] ?? "";
    let w = 0, c = 0;
    for (const ch of line) {
      const cw = this.width(ch);
      if (x < w + cw / 2) return c;
      w += cw; c += ch.length;
    }
    return c;
  }

  get gutter() { return String(this.lines?.length ?? 1).length * this.charW + 24; }

  posAt(e) {
    const p = e.local_position ?? { x: 0, y: 0 };
    const l = Math.max(0, Math.min(this.lines.length - 1, Math.floor((p.y + this.scrollTop) / ROW)));
    return { l, c: this.colAt(l, p.x - this.gutter - PAD + this.scrollLeft) };
  }

  reveal() {
    if (!this.lines) return;
    const y = this.caret.l * ROW;
    if (y < this.scrollTop) this.scrollTop = y;
    else if (y + ROW > this.scrollTop + this.view.height) this.scrollTop = y + ROW - this.view.height;
    const x = this.width(this.lines[this.caret.l].slice(0, this.caret.c)) + this.width(this.pending), room = this.view.width - this.gutter - PAD - 20;
    if (x < this.scrollLeft) this.scrollLeft = Math.max(0, x - 40);
    else if (x > this.scrollLeft + room) this.scrollLeft = x - room + 40;
    this.sendView();
  }

  scrollBy(dy, dx) {
    const max = Math.max(0, (this.lines?.length ?? 0) * ROW - ROW);
    this.scrollTop = Math.max(0, Math.min(max, this.scrollTop + dy));
    this.scrollLeft = Math.max(0, this.scrollLeft + dx);
    this.sendView();
  }

  // ---- mouse ----
  mouseDown(e, cx) {
    if (!this.lines) return;
    this.flush();
    const pos = this.posAt(e), m = e.modifiers;
    const mods = ["platform", "control", "alt", "shift"].filter((k) => m[k]).map((k) => ({ platform: "⌘", control: "⌃", alt: "⌥", shift: "⇧" })[k]).join("");
    this.log(`click ${mods}${pos.l + 1}:${pos.c + 1} ×${e.click_count}`);
    if (m.platform) this.message = `⌘-click on ${this.wordAt(pos) || "nothing"} (Go to Definition would run here)`;
    if (m.shift) this.anchor ??= { ...this.caret }; else this.anchor = { ...pos };
    this.caret = pos; this.goal = undefined; this.dragging = true;
    if (e.click_count === 2) {
      const line = this.lines[pos.l]; let a = pos.c, b = pos.c;
      while (a > 0 && /\w/.test(line[a - 1])) a--;
      while (b < line.length && /\w/.test(line[b])) b++;
      this.anchor = { l: pos.l, c: a }; this.caret = { l: pos.l, c: b };
    }
    this.input.focus();
    cx.notify();
  }

  // Herdr settles pane focus after the click; take the keyboard back after it (and log whether it held).
  grabKeyboard(cx, why) {
    try { this.input.focus(); } catch (e) { this.log(`focus ${why}: ${e.message ?? e}`); }
    cx.timer.after(30, (cx) => { try { this.input.focus(); } catch (e) { this.log(`focus late: ${e.message ?? e}`); } cx.notify(); });
  }

  wordAt(pos) {
    const line = this.lines[pos.l]; let a = pos.c, b = pos.c;
    while (a > 0 && /\w/.test(line[a - 1])) a--;
    while (b < line.length && /\w/.test(line[b])) b++;
    return line.slice(a, b);
  }

  // ---- benchmark: scroll 3 lines every 16 ms for 240 ticks, timing each render ----
  bench(cx) {
    if (this.benching || !this.lines) return;
    this.benching = true; this.renders = []; this.scrollTop = 0;
    let ticks = 0, last = now();
    const gaps = [];
    const task = cx.timer.every(16, (cx) => {
      const t = now(); gaps.push(t - last); last = t;
      this.scrollBy(3 * ROW, 0);
      if (++ticks >= 240) {
        task.cancel();
        this.benching = false;
        this.message = `scroll bench: ${ticks} ticks, render p50 ${f1(pct(this.renders, 0.5))} / p95 ${f1(pct(this.renders, 0.95))} ms, tick gap p50 ${f1(pct(gaps, 0.5))} / p95 ${f1(pct(gaps, 0.95))} ms`;
        this.log(this.message);
      }
      cx.notify();
    });
  }

  // ---- render ----
  // Each piece sits at its computed x (not flowed): flowed pieces round their widths, so a split at the caret or a
  // composition would nudge the text after it by a fraction of a pixel.
  spans(l, from, to, shift = 0) {
    const line = this.lines[l], row = this.tok[l], out = [];
    let at = 0, x = shift;
    const piece = (a, b, color, style) => {
      if (b <= a) return;
      x += this.width(line.slice(at, a)); at = a;
      const left = x;
      x += this.width(line.slice(a, b)); at = b;
      out.push(div().absolute().top(0).left(left).h(ROW).flex().items_center().whitespace_nowrap().text_color(color ?? FG).when(Boolean(style & 1), (el) => el.italic()).when(Boolean(style & 2), (el) => el.font_bold())
        .when(Boolean(style & 4), (el) => el.underline()).child(line.slice(a, b).replace(/\t/g, TAB)));
    };
    if (!row || !this.colors.length) piece(from, to);
    else for (let i = 0; i < row.length; i += 3) {
      const a = Math.max(from, row[i]), b = Math.min(to, i + 3 < row.length ? row[i + 3] : line.length);
      piece(a, b, this.colors[row[i + 1]], row[i + 2]);
    }
    return out;
  }

  row(l, sel) {
    const line = this.lines[l], y = l * ROW - this.scrollTop, x0 = this.gutter + PAD - this.scrollLeft, isCaret = l === this.caret.l;
    const el = div().absolute().top(y).left(0).w_full().h(ROW).when(isCaret && !sel, (e) => e.bg(CUR_LINE));
    if (sel && l >= sel[0].l && l <= sel[1].l) {
      const a = l === sel[0].l ? this.width(line.slice(0, sel[0].c)) : 0;
      const b = l === sel[1].l ? this.width(line.slice(0, sel[1].c)) : this.width(line) + this.charW;
      el.child(div().absolute().top(0).h(ROW).left(x0 + a).w(Math.max(0, b - a)).bg(SEL));
    }
    const text = div().absolute().top(0).left(x0).h(ROW).w_full();
    text.children(this.spans(l, 0, line.length));
    return el.child(text).child(div().absolute().top(0).left(0).w(this.gutter).h(ROW).flex().items_center().justify_end()
      .text_color(isCaret ? FG : NUM).child(String(l + 1)));
  }

  // The IME sink: laid over the composition (so the candidate window sits there), its own text invisible.
  inputEl() {
    return Input.new(this.input).flex_none().w(Math.ceil(this.wideW * 1.5) + 2).h(ROW).p(0).border_0().rounded(0)
      .bg("#00000000").text_color(FG).text_size(SIZE).font_family(this.font);
  }

  render() {
    const t0 = now(), sel = this.lines && this.selection();
    if (this.keyAt) { keep(this.lat, t0 - this.keyAt); this.keyAt = 0; }
    if (this.wheelAt) { keep(this.wheel, t0 - this.wheelAt); this.wheelAt = 0; }
    if (this.lines && this.timings.firstRender == null) this.timings.firstRender = t0 - this.t0;
    const area = div().id("ned-area").flex_1().min_h(0).relative().overflow_hidden().bg(BG).cursor_text().key_context("NativeEditor")
      .on_size_change((size, cx) => { this.view = size; this.sendView(); cx.notify(); })
      .on_scroll_wheel((e, cx) => {
        const d = e.delta_lines ? { x: e.delta_lines.x * ROW, y: e.delta_lines.y * ROW } : e.delta;
        this.wheelAt = now(); this.scrollBy(-d.y, -d.x); cx.notify();
      })
      .on_mouse_down("left", (e, cx) => this.mouseDown(e, cx))
      .on_mouse_move((e, cx) => { if (this.dragging && this.lines) { this.caret = this.posAt(e); cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { this.dragging = false; this.grabKeyboard(cx, "up"); })
      .on_key_down((e, cx) => {
        const c = KEYS[e.keystroke];
        if (c) { cx.stop_propagation(); this.command(c, "key", cx); return; }
        this.keyAt = now();
        this.log(`key ${e.keystroke}${e.key_char ? ` "${e.key_char}"` : ""}`);
      });
    for (const c of new Set(Object.values(KEYS))) area.on_action(`ned_${c}`, (_e, cx) => this.command(c, "act", cx));
    if (this.lines) {
      const [a, b] = this.visibleRange();
      for (let l = a; l < b; l++) area.child(this.row(l, sel));
      const cl = this.caret.l, cy = cl * ROW - this.scrollTop;
      // The Input sits at the caret, visible: it draws the IME's marked syllable (which never reaches us) and the caret.
      const px = this.gutter + PAD - this.scrollLeft + this.width(this.lines[cl].slice(0, this.caret.c)), visible = cl >= a && cl < b;
      area.child(div().absolute().top(visible ? cy : 0).left(visible ? px : -4000).h(ROW).child(this.inputEl()));
    } else area.child(div().p(12).text_color(NUM).child(`Loading ${this.file ?? "(no file prop)"}…`));
    // Font metrics: 100 ASCII and 50 Hangul characters, laid out off screen.
    area.child(div().id("m-ascii").absolute().top(-200).left(0).flex_none().whitespace_nowrap().text_color("#00000000")
      .on_size_change((s, cx) => { if (s.width > 0) { this.charW = s.width / 100; cx.notify(); } }).child("M".repeat(100)));
    area.child(div().id("m-wide").absolute().top(-200).left(0).flex_none().whitespace_nowrap().text_color("#00000000")
      .on_size_change((s, cx) => { if (s.width > 0) { this.wideW = s.width / 50; cx.notify(); } }).child("가".repeat(50)));

    const t = this.timings, small = (s) => div().flex_none().child(s);
    const header = h_flex().h(26).flex_none().px(10).gap(14).items_center().bg(BAR).text_color(BAR_FG).text_size(11.5)
      .child(div().flex_none().text_color(FG).child((this.file ?? "").split("/").pop()))
      .child(small(`server ${this.server}`))
      .child(small(`spawn ${f1(t.spawn)} · connect ${f1(t.connect)} · opened ${f1(t.opened)} · 1st render ${f1(t.firstRender)} · colored ${f1(t.colored)} ms`))
      .child(div().flex_1())
      .child(div().id("bench").px(6).rounded(4).cursor_pointer().hover((s) => s.bg(CUR_LINE)).on_click((_e, cx) => this.bench(cx)).child("Scroll bench"))
      .child(div().id("fps").px(6).rounded(4).cursor_pointer().hover((s) => s.bg(CUR_LINE))
        .on_click((_e, cx) => { if (fps_monitor_visible()) hide_fps_monitor(); else show_fps_monitor({ anchor: "top_right" }); cx.notify(); }).child("FPS HUD"));
    const last = this.renders.length ? this.renders[this.renders.length - 1] : null;
    const status = h_flex().h(22).flex_none().px(10).gap(14).items_center().bg(BAR).text_color(BAR_FG).text_size(11.5)
      .child(small(`Ln ${this.caret.l + 1}, Col ${this.caret.c + 1}${sel ? ` (${this.text(sel[0], sel[1]).length} selected)` : ""}`))
      .child(small(`key→render p50 ${f1(pct(this.lat, 0.5))} / p95 ${f1(pct(this.lat, 0.95))} ms (${this.lat.length})`))
      .child(small(`render ${f1(last)} ms, p95 ${f1(pct(this.renders, 0.95))} · wheel→render p50 ${f1(pct(this.wheel, 0.5))}`))
      .child(small(`char ${this.charW.toFixed(2)} / wide ${this.wideW.toFixed(2)} px`))
      .child(small(`IME ${JSON.stringify(this.pending)}`))
      .child(div().flex_1().truncate().text_color(FG).child(this.message ?? ""));
    const log = v_flex().h(5 * 14 + 6).flex_none().px(10).py(3).bg("#1e2127").text_color(NUM).text_size(11).font_family(this.font)
      .children([...this.events].reverse().slice(0, 5).map((s) => div().h(14).truncate().child(s)));
    const root = v_flex().id("ned").size_full().bg(BG).text_color(FG).text_size(SIZE).font_family(this.font)
      .child(header).child(area).child(status).child(log);
    keep(this.renders, now() - t0);
    return root;
  }

  async close() { try { this.sock?.close(); } catch {} }
}
