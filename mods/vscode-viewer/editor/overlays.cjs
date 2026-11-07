// Editor overlays drawn over the text: context menu (also the quick fix menu), quick pick (files / commands), input box,
// modal dialog, results panel (references, implementations, calls), the peek box and the hover box. Each has render(P, ed), key(ev, ed) and
// mouse(ev, ed); key/mouse return true when they consumed the event. They act on the editor only through its methods.
const path = require("path");
const W = require("./width.cjs");
const { fit } = require("./paint.cjs");
const { stepMenu } = require("./commands.cjs");

const WHITE = "#ffffff";
const inside = (ev, x, y, w, h) => ev.x >= x && ev.x < x + w && ev.y >= y && ev.y < y + h;
// Box border around (x, y, w, h); the inside is left to the caller.
function frame(P, ed, x, y, w, h, color = ed.colors.border) {
  const c = ed.colors;
  P.move(y, x); P.text("┌" + "─".repeat(w - 2) + "┐", color, c.widget);
  for (let r = 1; r < h - 1; r++) { P.move(y + r, x); P.text("│", color, c.widget); P.move(y + r, x + w - 1); P.text("│", color, c.widget); }
  P.move(y + h - 1, x); P.text("└" + "─".repeat(w - 2) + "┘", color, c.widget);
}
// Keeps index visible in a window of `size` rows starting at top.
const scrollTo = (top, index, size) => (index < top ? index : index >= top + size ? index - size + 1 : top);

// ---------- context menu ----------
class Menu {
  constructor(rows, x, y, parent = null) {
    this.rows = rows; this.parent = parent; this.sub = null;
    this.index = parent ? stepMenu(rows, -1, 1) : -1;
    this.w = Math.max(...rows.map(r => r.sep ? 0 : W.textWidth(r.title, 8) + (r.key || r.submenu ? W.textWidth(r.key || "›", 8) + 6 : 2))) + 4;
    this.h = rows.length + 2; this.x = x; this.y = y;
  }
  place(ed) { // keep it on screen
    this.w = Math.min(this.w, ed.cols); this.h = Math.min(this.h, ed.rows);
    if (this.x + this.w - 1 > ed.cols) this.x = Math.max(1, (this.parent ? this.parent.x - this.w + 1 : ed.cols - this.w + 1));
    if (this.y + this.h - 1 > ed.rows) this.y = Math.max(1, ed.rows - this.h + 1);
  }
  render(P, ed) {
    this.place(ed);
    const c = ed.colors, inner = this.w - 2;
    frame(P, ed, this.x, this.y, this.w, this.h);
    this.rows.slice(0, this.h - 2).forEach((r, i) => {
      if (r.sep) { P.move(this.y + 1 + i, this.x); return P.text("├" + "─".repeat(inner) + "┤", c.border, c.widget); }
      P.move(this.y + 1 + i, this.x + 1);
      const on = i === this.index, fg = !r.enabled ? c.lineNumber : on ? WHITE : c.fg, bg = on ? c.button : c.widget;
      const right = r.submenu ? "›" : r.key, rw = W.textWidth(right, 8);
      P.text(fit(" " + r.title, inner - rw - 1), fg, bg);
      P.text(right + " ", r.enabled ? (on ? WHITE : c.barFg) : c.lineNumber, bg);
    });
    if (this.sub) this.sub.render(P, ed);
  }
  openSub(ed) {
    const r = this.rows[this.index];
    if (!r?.submenu || !r.enabled) return false;
    this.sub = new Menu(r.submenu, this.x + this.w - 1, this.y + this.index, this);
    this.sub.place(ed);
    return true;
  }
  activate(ed) {
    const r = this.rows[this.index];
    if (!r || r.sep || !r.enabled) return;
    if (r.submenu) return this.openSub(ed);
    ed.closePopup();
    if (r.run) r.run(); else ed.runCommand(r.id);
  }
  key(ev, ed) {
    if (this.sub) {
      if (ev.name === "left" || ev.name === "escape") { this.sub = null; return true; }
      return this.sub.key(ev, ed);
    }
    if (ev.type !== "key") return true;
    if (ev.name === "escape" || (ev.name === "left" && !this.parent)) { ed.closePopup(); return true; }
    if (ev.name === "up" || ev.name === "down") { const j = stepMenu(this.rows, this.index, ev.name === "up" ? -1 : 1); if (j !== -1) this.index = j; return true; }
    if (ev.name === "home" || ev.name === "end") { const j = stepMenu(this.rows, ev.name === "home" ? -1 : 0, ev.name === "home" ? 1 : -1); if (j !== -1) this.index = j; return true; }
    if (ev.name === "right") { this.openSub(ed); return true; }
    if (ev.name === "enter" || ev.name === "space") { this.activate(ed); return true; }
    return true;
  }
  // A buttonless motion: true when the highlighted row (here or in an open submenu) changed.
  hover(ev, ed) { const before = this.path(); this.mouse(ev, ed); return this.path() !== before; }
  path() { return this.sub ? `${this.index}>${this.sub.path()}` : String(this.index); }
  mouse(ev, ed) {
    if (this.sub && this.sub.mouse(ev, ed)) return true;
    if (!inside(ev, this.x, this.y, this.w, this.h)) {
      if (!this.parent && !ev.release && !ev.motion && ev.button !== 64 && ev.button !== 65) ed.closePopup();
      return !this.parent;
    }
    const i = ev.y - this.y - 1, r = this.rows[i];
    if (!r || r.sep) return true;
    if (r.enabled) { this.index = i; if (r.submenu) { if (!this.sub) this.openSub(ed); } else this.sub = null; }
    if (ev.button === 0 && !ev.release && !ev.motion) this.activate(ed);
    return true;
  }
}

// ---------- quick pick ----------
// source(text) -> [{ label, detail, key, hits, run }]; the list is recomputed on each change. note: dim text at the
// input's right end (where the results come from).
class Picker {
  constructor(text, source, placeholder, note = "") { this.text = text; this.source = source; this.placeholder = placeholder; this.note = note; this.index = 0; this.top = 0; this.refresh(); }
  refresh() { this.items = this.source(this.text); this.index = 0; this.top = 0; }
  box(ed) { const w = Math.min(ed.cols - 2, 80), size = Math.max(1, Math.min(12, this.items.length || 1, ed.rows - 6)); return { x: Math.floor((ed.cols - w) / 2) + 1, y: 2, w, size }; }
  render(P, ed) {
    const c = ed.colors, { x, y, w, size } = this.box(ed), inner = w - 2;
    frame(P, ed, x, y, w, size + 3);
    P.move(y + 1, x + 1);
    const shown = this.text || "";
    const note = this.note && W.textWidth(this.note, 8) + 4 < inner / 2 ? this.note + " " : "";
    P.text(" ", c.fg, c.input);
    P.text(fit(shown || this.placeholder, inner - 2 - W.textWidth(note, 8)), shown ? c.fg : c.lineNumber, c.input);
    P.text(note, c.lineNumber, c.input);
    P.text(" ", c.fg, c.input);
    this.cursor = [y + 1, x + 2 + Math.min(inner - 3, W.textWidth(shown, 8))];
    this.top = scrollTo(this.top, this.index, size);
    for (let r = 0; r < size; r++) {
      P.move(y + 2 + r, x + 1);
      const it = this.items[this.top + r];
      if (!it) { P.text(fit(r === 0 ? " No matching results" : "", inner), c.lineNumber, c.widget); continue; }
      const on = this.top + r === this.index, bg = on ? c.selection : c.widget, key = it.key ? it.key + " " : "";
      let used = 1;
      P.text(" ", c.fg, bg);
      const hits = new Set(it.hits ?? []);
      let i = 0;
      for (const ch of it.label) {
        const cw = W.charWidth(ch.codePointAt(0));
        if (used + cw > inner - W.textWidth(key, 8) - 1) break;
        P.text(ch, hits.has(i) ? c.highlight : c.fg, bg, hits.has(i) ? 2 : 0);
        used += cw; i += ch.length;
      }
      const room = inner - used - W.textWidth(key, 8);
      P.text(fit(it.detail ? "  " + it.detail : "", room), c.lineNumber, bg);
      P.text(key, c.barFg, bg);
    }
  }
  key(ev, ed) {
    if (ev.type === "text" || ev.type === "paste") { this.text += ev.text.split(/\r?\n|\r/)[0]; this.refresh(); return true; }
    if (ev.type !== "key") return true;
    const n = this.items.length, size = this.box(ed).size;
    switch (ev.name) {
      case "escape": ed.closePopup(); break;
      case "backspace": this.text = [...this.text].slice(0, -1).join(""); this.refresh(); break;
      case "up": if (n) this.index = (this.index - 1 + n) % n; break;
      case "down": if (n) this.index = (this.index + 1) % n; break;
      case "pageup": this.index = Math.max(0, this.index - size); break;
      case "pagedown": this.index = Math.min(Math.max(0, n - 1), this.index + size); break;
      case "enter": { const it = this.items[this.index]; ed.closePopup(); if (it) it.run(); break; }
    }
    return true;
  }
  mouse(ev, ed) {
    const { x, y, w, size } = this.box(ed);
    if (!inside(ev, x, y, w, size + 3)) { if (ev.button === 0 && !ev.release && !ev.motion) ed.closePopup(); return true; }
    const r = ev.y - y - 2;
    if (ev.button === 0 && !ev.release && !ev.motion && r >= 0 && r < size && this.items[this.top + r]) { this.index = this.top + r; this.key({ type: "key", name: "enter" }, ed); }
    return true;
  }
}

// ---------- input box (go to line, rename, change all, auto save delay) ----------
// opts: { label, text, at: null (top) | { row, col } (under a text position), onChange?, onAccept, onCancel? }
class Input {
  constructor(opts) { Object.assign(this, opts); this.text ??= ""; this.selectAll ??= !!this.text; } // selectAll: false types after the text
  render(P, ed) {
    const c = ed.colors;
    if (!this.at) {
      const label = ` ${this.label} `;
      P.move(2, 1); P.text(fit(label + this.text, ed.cols), c.fg, c.widget);
      this.cursor = [2, Math.min(ed.cols, W.textWidth(label + this.text, 8) + 1)];
      return;
    }
    const w = Math.min(ed.cols, Math.max(28, W.textWidth(this.text, 8) + 4)), x = Math.max(1, Math.min(this.at.col, ed.cols - w + 1)), y = this.at.row;
    frame(P, ed, x, y, w, 3, c.accent);
    P.move(y + 1, x + 1);
    P.text(fit(" " + this.text, w - 2), this.selectAll ? WHITE : c.fg, this.selectAll ? c.selection : c.input);
    if (this.label) { P.move(y + 2, x + 2); P.text(fit(` ${this.label} `, w - 4), c.barFg, c.widget); }
    this.cursor = [y + 1, x + 2 + Math.min(w - 4, W.textWidth(this.text, 8))];
  }
  set(v) { this.text = v; this.selectAll = false; this.onChange?.(v); }
  key(ev, ed) {
    if (ev.type === "text" || ev.type === "paste") { this.set((this.selectAll ? "" : this.text) + ev.text.split(/\r?\n|\r/)[0]); return true; }
    if (ev.type !== "key") return true;
    if (ev.name === "escape") { ed.closePopup(); this.onCancel?.(); }
    else if (ev.name === "enter") { ed.closePopup(); this.onAccept(this.text); }
    else if (ev.name === "backspace") this.set(this.selectAll ? "" : [...this.text].slice(0, -1).join(""));
    else if (ev.name === "left" || ev.name === "right" || ev.name === "home" || ev.name === "end") this.selectAll = false;
    return true;
  }
  mouse() { return true; }
}

// ---------- modal dialog ----------
// opts: { title, detail?, buttons: [{ label, key (accelerator letter), run, cancel? }] }; Enter = focused (first),
// Esc = the cancel button, or just closes when there is none.
class Dialog {
  constructor(opts) { Object.assign(this, opts); this.focus = 0; this.rects = []; }
  render(P, ed) {
    const c = ed.colors;
    const btnW = this.buttons.reduce((n, b) => n + W.textWidth(b.label, 8) + 4, 0) + 2;
    const w = Math.min(ed.cols, Math.max(44, W.textWidth(this.title, 8) + 6, W.textWidth(this.detail ?? "", 8) + 6, btnW + 2));
    const h = this.detail ? 7 : 6, x = Math.max(1, Math.floor((ed.cols - w) / 2) + 1), y = Math.max(1, Math.floor((ed.rows - h) / 2));
    frame(P, ed, x, y, w, h, c.accent);
    const line = (r, text, fg, style = 0) => { P.move(y + r, x + 1); P.text(fit(text, w - 2), fg, c.widget, style); };
    line(1, "", c.fg); line(2, "  " + this.title, c.fg, 2);
    if (this.detail) line(3, "  " + this.detail, c.barFg);
    line(h - 3, "", c.fg);
    P.move(y + h - 2, x + 1);
    let col = x + 1 + Math.max(0, w - 2 - btnW);
    P.text(" ".repeat(Math.max(0, w - 2 - btnW)), c.fg, c.widget);
    this.rects = [];
    this.buttons.forEach((b, i) => {
      const label = ` ${b.label} `, on = i === this.focus;
      P.text("  ", c.fg, c.widget); col += 2;
      P.text(label, on ? WHITE : c.fg, on ? c.button : c.input);
      this.rects.push({ x: col, y: y + h - 2, w: W.textWidth(label, 8), i }); col += W.textWidth(label, 8);
    });
    P.text(fit("", x + w - 1 - col), c.fg, c.widget);
  }
  press(i, ed) { const b = this.buttons[i]; if (!b) return; ed.closePopup(); b.run(); }
  key(ev, ed) {
    const n = this.buttons.length;
    if (ev.type === "text") { const i = this.buttons.findIndex(b => b.key === ev.text.toLowerCase()); if (i !== -1) this.press(i, ed); return true; }
    if (ev.type !== "key") return true;
    if (ev.name === "escape") { const i = this.buttons.findIndex(b => b.cancel); if (i === -1) ed.closePopup(); else this.press(i, ed); }
    else if (ev.name === "enter" || ev.name === "space") this.press(this.focus, ed);
    else if (ev.name === "right" || (ev.name === "tab" && !ev.shift)) this.focus = (this.focus + 1) % n;
    else if (ev.name === "left" || ev.name === "tab") this.focus = (this.focus - 1 + n) % n;
    else { const i = this.buttons.findIndex(b => b.key === ev.name && !ev.ctrl && !ev.cmd); if (i !== -1) this.press(i, ed); }
    return true;
  }
  mouse(ev, ed) {
    if (ev.button !== 0 || ev.release || ev.motion) return true;
    const r = this.rects.find(r => inside(ev, r.x, r.y, r.w, 1));
    if (r) this.press(r.i, ed);
    return true;
  }
}

// ---------- results panel ----------
// items: [{ file, line, col, preview, name?, detail? }]. Rows group them by file, like VS Code's references view.
class Panel {
  constructor(title, items, opts = {}) {
    Object.assign(this, opts); this.title = title; this.items = items; this.focused = true; this.top = 0;
    const files = [...new Set(items.map(i => i.file))];
    this.rows = files.flatMap(f => [{ file: f, count: items.filter(i => i.file === f).length }, ...items.filter(i => i.file === f).map(item => ({ item }))]);
    this.index = this.rows.findIndex(r => r.item);
    this.files = files.length;
  }
  height(ed) { return Math.max(4, Math.floor(ed.rows * 0.4)); }
  render(P, ed) {
    const c = ed.colors, h = this.height(ed), y0 = ed.rows - h;
    const summary = this.items.length ? `${this.items.length} result${this.items.length === 1 ? "" : "s"} in ${this.files} file${this.files === 1 ? "" : "s"}` : "No results";
    const hint = (this.toggle ? "Tab: " + this.toggle + " · " : "") + "Enter open · Esc close ";
    P.move(y0, 1);
    P.text(fit(` ${this.title.toUpperCase()}   ${summary}`, Math.max(0, ed.cols - W.textWidth(hint, 8))), c.fg, c.bar, 2);
    if (W.textWidth(hint, 8) < ed.cols) P.text(hint, c.barFg, c.bar);
    const size = h - 1;
    this.top = scrollTo(this.top, Math.max(0, this.index), size);
    for (let r = 0; r < size; r++) {
      P.move(y0 + 1 + r, 1);
      const row = this.rows[this.top + r], on = this.top + r === this.index, bg = on ? (this.focused ? c.selection : c.currentLine) : c.widget;
      if (!row) { P.text(" ".repeat(ed.cols), c.fg, c.widget); continue; }
      if (!row.item) {
        const name = path.basename(row.file), dir = path.relative(ed.root, path.dirname(row.file)) || ".";
        P.text(" ▾ ", c.barFg, bg); P.text(name, c.fg, bg, 2);
        P.text(fit(`  ${dir}  (${row.count})`, Math.max(0, ed.cols - 3 - W.textWidth(name, 8))), c.lineNumber, bg);
        continue;
      }
      const it = row.item, lead = `     ${`${it.line + 1}:${it.col + 1}`.padEnd(8)} `;
      const text = it.name ? `${it.name}${it.detail ? "  " + it.detail : ""}   ${(it.preview ?? "").trim()}` : (it.preview ?? "").trim();
      P.text(lead, c.lineNumber, bg);
      P.text(fit(text, Math.max(0, ed.cols - W.textWidth(lead, 8))), c.fg, bg);
    }
  }
  step(dir) { for (let j = this.index + dir; j >= 0 && j < this.rows.length; j += dir) if (this.rows[j].item) { this.index = j; return; } }
  current() { return this.rows[this.index]?.item ?? null; }
  key(ev, ed) {
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "escape": ed.panel = null; return true;
      case "up": this.step(-1); return true;
      case "down": this.step(1); return true;
      case "pageup": for (let k = 0; k < this.height(ed) - 2; k++) this.step(-1); return true;
      case "pagedown": for (let k = 0; k < this.height(ed) - 2; k++) this.step(1); return true;
      case "enter": { const it = this.current(); if (it) { this.focused = false; ed.jumpTo(it); } return true; }
      case "tab": if (this.onToggle) this.onToggle(); return true;
    }
    return false;
  }
  mouse(ev, ed) {
    const h = this.height(ed), y0 = ed.rows - h;
    if (ev.y < y0 || ev.y > ed.rows - 1) return false;
    if (ev.button === 64 || ev.button === 65) { this.top = Math.max(0, Math.min(this.rows.length - 1, this.top + (ev.button === 64 ? -3 : 3))); return true; }
    if (ev.button !== 0 || ev.release || ev.motion) return true;
    this.focused = true;
    const i = this.top + ev.y - y0 - 1;
    if (this.rows[i]?.item) { this.index = i; this.key({ type: "key", name: "enter" }, ed); this.focused = true; }
    return true;
  }
}

// ---------- peek ----------
// Shows ~8 lines around items[index] in a box under the cursor line; ↑/↓ switch between results.
class Peek {
  static LINES = 8;
  constructor(title, items) { this.title = title; this.items = items; this.index = 0; }
  get height() { return Peek.LINES + 2; }
  render(P, ed, row) {
    const c = ed.colors, it = this.items[this.index], w = ed.cols, st = ed.docFor(it.file);
    const right = `${this.items.length > 1 ? `${this.index + 1} of ${this.items.length} · ↑↓ · ` : ""}Enter open · Esc close `;
    const head = ` ${path.basename(it.file)}  ${path.relative(ed.root, path.dirname(it.file)) || "."}  — ${this.title}`;
    P.move(row, 1);
    P.text(fit(head, Math.max(0, w - W.textWidth(right, 8))), c.fg, c.widget, 0);
    if (W.textWidth(right, 8) < w) P.text(right, c.barFg, c.widget);
    const first = Math.max(0, it.line - 2), gw = 7;
    for (let r = 0; r < Peek.LINES; r++) {
      P.move(row + 1 + r, 1);
      const l = first + r, target = l === it.line;
      if (!st || l >= st.buf.lines.length) { P.text(fit(r === 0 && !st ? "  Loading…" : "", w), c.lineNumber, c.peek); continue; }
      st.hl.ensure(l, Date.now() + 30);
      const bg = target ? c.peekLine : c.peek;
      P.text(String(l + 1).padStart(gw - 2) + "  ", target ? c.lineNumberActive : c.lineNumber, bg);
      const end = it.end && it.end.line === l ? it.end.col : it.col;
      const { x } = ed.paintText(P, st.buf.lines[l], st.hl.tokens[l] ?? null, w - gw, 0, bg, (i) => (target && i >= it.col && i < end ? c.match : null), st.indent.size);
      if (x < w - gw) P.text(" ".repeat(w - gw - x), c.fg, bg);
    }
    P.move(row + Peek.LINES + 1, 1);
    P.text("─".repeat(w), c.accent, c.bg);
  }
  key(ev, ed) {
    if (ev.type !== "key") return false;
    if (ev.name === "escape") { ed.peek = null; return true; }
    if (ev.name === "enter") { const it = this.items[this.index]; ed.peek = null; ed.jumpTo(it); return true; }
    if ((ev.name === "up" || ev.name === "down") && this.items.length > 1 && !ev.shift && !ev.alt && !ev.cmd) {
      this.index = (this.index + (ev.name === "up" ? -1 : 1) + this.items.length) % this.items.length; return true;
    }
    return false;
  }
}

// ---------- hover ----------
// Hover Markdown as terminal lines [{ text, code?, rule? }], each at most `width` cells: code blocks keep their lines,
// other text loses its Markdown marks (headings, emphasis, inline code ticks, links and JSDoc {@link}s to their text,
// escapes) and wraps at spaces; runs of blank lines become one, none at the ends.
function markdownLines(md, width) {
  const out = [];
  let fence = false;
  const push = (line) => { if (line.text || (out.length && out.at(-1).text)) out.push(line); };
  const hardWrap = (line, code) => { // pieces of at most `width` cells; the last one is returned
    for (;;) {
      let i = 0, w = 0;
      for (const ch of line) { const cw = W.charWidth(ch.codePointAt(0)); if (w + cw > width) break; w += cw; i += ch.length; }
      if (i >= line.length) return line;
      push(code ? { text: line.slice(0, i), code } : { text: line.slice(0, i) }); line = line.slice(i);
    }
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) { push({ text: hardWrap(raw.replace(/\t/g, "    "), true), code: true }); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) { push({ text: "─".repeat(width), rule: true }); continue; }
    const text = raw.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\{@link(?:code|plain)?\s+([^}|\s]+)[|\s]?([^}]*)\}/g, (_, target, label) => label.trim() || target)
      .replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[^\w*])[*_](?=\S)(.+?)[*_](?![\w*])/g, "$1$2").replace(/`([^`]+)`/g, "$1")
      .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1").replace(/&nbsp;/g, " ").replace(/<br\s*\/?>/gi, "").trimEnd();
    let line = "";
    for (const word of text.split(/(?<=\S)(?= )/)) { // words keep the spaces before them, so indentation stays
      if (line && W.textWidth(line + word, 8) > width) { push({ text: line }); line = word.trimStart(); } else line += word;
      line = hardWrap(line, false);
    }
    push({ text: line });
  }
  while (out.length && !out.at(-1).text) out.pop();
  return out;
}

// Markdown in a box over the text, above `at` (the screen cell of the hovered word) or below it without room there;
// not modal: the editor closes it on the next key or when the pointer leaves.
class Hover {
  static ROWS = 14; // VS Code's 250px
  constructor(markdown, at) { this.markdown = markdown; this.at = at; }
  box(ed) {
    const max = Math.max(10, Math.min(ed.cols - 2, 80)), lines = markdownLines(this.markdown, max - 2);
    const w = Math.min(max, Math.max(...lines.map(l => (l.rule ? 0 : W.textWidth(l.text, 8)))) + 4), rows = Math.min(lines.length, Hover.ROWS, ed.rows - 4);
    const h = rows + 2, y = this.at.row - h >= 1 ? this.at.row - h : Math.min(this.at.row + 1, ed.rows - h);
    return { x: Math.max(1, Math.min(this.at.col - 1, ed.cols - w + 1)), y, w, h, lines: lines.slice(0, rows), more: lines.length > rows };
  }
  render(P, ed) {
    const c = ed.colors, b = this.box(ed), inner = b.w - 2;
    this.rect = b;
    frame(P, ed, b.x, b.y, b.w, b.h, c.hoverBorder);
    b.lines.forEach((l, i) => {
      P.move(b.y + 1 + i, b.x + 1);
      const last = b.more && i === b.lines.length - 1;
      P.text(l.rule ? "─".repeat(inner) : fit(" " + (last ? "…" : l.text), inner), l.rule ? c.border : l.code ? c.highlight : c.fg, c.hoverBg);
    });
  }
  contains(ev) { const r = this.rect; return !!r && inside(ev, r.x, r.y, r.w, r.h); }
}

module.exports = { Menu, Picker, Input, Dialog, Panel, Peek, Hover, markdownLines };
