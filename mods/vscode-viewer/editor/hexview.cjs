// Read-only hex viewer for binary files, in the editor's look: rows of offset | 16 bytes (8+8) | ASCII, read lazily in
// chunks (never the whole file), go to offset, find hex bytes or text, a data inspector, copy as hex. Also the
// "this file is binary" prompt the editor shows before it.
const fs = require("fs");
const { Painter, fit, themePalette } = require("./paint.cjs");
const { Dialog, Input } = require("./overlays.cjs");
const { chordOf } = require("./commands.cjs");
const T = require("./terminal.cjs");

// Names that are clearly binary: these skip the prompt and open in hex right away.
const BINARY_NAME = /(^|\/)\.DS_Store$|\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|heic|psd|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|dmg|iso|pkg|deb|rpm|exe|dll|so|dylib|o|a|obj|lib|class|pyc|wasm|bin|ttf|otf|woff2?|eot|pdf|sqlite3?|db|mp3|mp4|m4a|mov|avi|mkv|wav|flac|ogg|webm)$/i;
const binaryName = (file) => BINARY_NAME.test(file);

// ---------- row layout ----------
const ROW = 16;
const BYTE_COLORS = { zero: "#5c6370", text: "#98c379", other: "#d19a66" };
const hex2 = (b) => b.toString(16).padStart(2, "0");
const kindOf = (b) => (b === 0 ? "zero" : b >= 0x20 && b < 0x7f ? "text" : "other");
const charOf = (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");
// 0-based screen column of byte i's two hex digits: 8 offset digits and 2 spaces, 3 columns a byte, a gap after 8.
const hexCol = (i) => 10 + i * 3 + (i >= 8 ? 1 : 0);
const ASCII_COL = hexCol(ROW) + 1;
const HEADER = "Offset    " + Array.from({ length: ROW }, (_, i) => (i === 8 ? " " : "") + hex2(i).toUpperCase() + " ").join("") + " Decoded Text";

// The text of one row (what the screen shows, without colors).
function formatRow(offset, bytes) {
  let hex = "";
  for (let i = 0; i < ROW; i++) hex += (i === 8 ? " " : "") + (i < bytes.length ? hex2(bytes[i]) : "  ") + " ";
  return offset.toString(16).padStart(8, "0") + "  " + hex + " " + Array.from(bytes, charOf).join("");
}

// Data inspector: the values starting at the first byte of `bytes` (as many as fit).
function inspect(bytes) {
  const b = Buffer.from(bytes), out = [];
  const float = (v) => String(Number(v.toPrecision(7)));
  if (b.length >= 1) out.push(["int8", b.readInt8(0)], ["uint8", b.readUInt8(0)]);
  if (b.length >= 2) out.push(["int16 LE", b.readInt16LE(0)], ["int16 BE", b.readInt16BE(0)]);
  if (b.length >= 4) out.push(["int32 LE", b.readInt32LE(0)], ["int32 BE", b.readInt32BE(0)], ["float32 LE", float(b.readFloatLE(0))], ["float32 BE", float(b.readFloatBE(0))]);
  return out.map(([k, v]) => [k, String(v)]);
}

// "0x1f", "1fh" and anything with a-f are hex; plain digits are decimal. Null when it is neither.
function parseOffset(s) {
  s = s.trim().toLowerCase();
  const m = /^0x([0-9a-f]+)$/.exec(s) || /^([0-9a-f]+)h$/.exec(s);
  if (m) return parseInt(m[1], 16);
  if (/^\d+$/.test(s)) return Number(s);
  return /^[0-9a-f]+$/.test(s) ? parseInt(s, 16) : null;
}

// Find text -> bytes: space-separated byte pairs ("de ad be ef", or one pair) are hex, "quoted" or anything else is UTF-8 text.
function parseNeedle(q) {
  const quoted = /^"(.+)"$/s.exec(q), t = q.trim();
  if (quoted) return Buffer.from(quoted[1]);
  if (/^[0-9a-f]{2}(\s+[0-9a-f]{2})*$/i.test(t)) return Buffer.from(t.replace(/\s+/g, ""), "hex");
  return q ? Buffer.from(q) : null;
}

// ---------- lazy file access ----------
// Reads a file through a small LRU of fixed-size chunks; searches stream through it in 1 MB blocks.
class Reader {
  constructor(fd, size, chunk = 64 * 1024, keep = 64) { this.fd = fd; this.size = size; this.chunkSize = chunk; this.keep = keep; this.cache = new Map(); }
  direct(offset, len) {
    const buf = Buffer.alloc(Math.max(0, Math.min(len, this.size - offset)));
    const n = buf.length ? fs.readSync(this.fd, buf, 0, buf.length, offset) : 0;
    return buf.subarray(0, n);
  }
  chunk(i) {
    let c = this.cache.get(i);
    if (c) this.cache.delete(i);
    else c = this.direct(i * this.chunkSize, this.chunkSize);
    this.cache.set(i, c);
    if (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value);
    return c;
  }
  // Bytes [offset, offset + len), cut at the end of the file.
  read(offset, len) {
    const end = Math.min(this.size, offset + len), cs = this.chunkSize, parts = [];
    for (let p = Math.max(0, offset); p < end;) {
      const i = Math.floor(p / cs), c = this.chunk(i), e = Math.min(c.length, end - i * cs);
      if (e <= p - i * cs) break; // the file shrank under us
      parts.push(c.subarray(p - i * cs, e));
      p = i * cs + e;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }
  // First match starting in [start, end), or -1.
  indexOf(needle, start, end) {
    for (let p = start; p < end; p += 1 << 20) {
      const i = this.direct(p, Math.min(1 << 20, end - p) + needle.length - 1).indexOf(needle);
      if (i !== -1) return p + i < end ? p + i : -1;
    }
    return -1;
  }
  // Last match starting in [start, end), or -1.
  lastIndexOf(needle, start, end) {
    for (let q = end; q > start; q -= 1 << 20) {
      const p = Math.max(start, q - (1 << 20)), i = this.direct(p, q - p + needle.length - 1).lastIndexOf(needle, q - p - 1);
      if (i !== -1) return p + i;
    }
    return -1;
  }
  // Next match at or after `from` (or the last one before it, backwards), wrapping around the file; -1 when none.
  find(needle, from, back = false) {
    if (!needle?.length) return -1;
    const size = this.size;
    if (back) { const i = this.lastIndexOf(needle, 0, from); return i !== -1 ? i : this.lastIndexOf(needle, from, size); }
    const i = this.indexOf(needle, from, size);
    return i !== -1 ? i : this.indexOf(needle, 0, Math.min(from, size));
  }
}

// ---------- viewer ----------
class HexView {
  // env: { file, crumbs: [folder, ..., name], colors, clipboard(text) }
  constructor(reader, env) {
    Object.assign(this, env);
    this.reader = reader; this.size = reader.size;
    this.cursor = 0; this.anchor = null; this.top = 0; this.rows = 24; this.cols = 80;
    this.popup = null; this.message = null; this.query = ""; this.needle = null;
  }
  get height() { return Math.max(1, this.rows - 4); } // breadcrumbs, column header, inspector, status bar
  get lastRow() { return Math.max(0, Math.ceil(this.size / ROW) - 1); }
  range() { const a = this.anchor ?? this.cursor; return [Math.min(a, this.cursor), Math.max(a, this.cursor) + 1]; }
  closePopup() { this.popup = null; }
  say(text, color = this.colors.barFg, ms = 3000) { this.message = { text, color, until: Date.now() + ms }; setTimeout(() => this.redraw?.(), ms + 20); }

  moveTo(offset, extend = false) {
    if (extend && this.anchor === null) this.anchor = this.cursor;
    if (!extend) this.anchor = null;
    this.cursor = Math.max(0, Math.min(offset, this.size - 1));
    const row = Math.floor(this.cursor / ROW);
    if (row < this.top) this.top = row;
    else if (row >= this.top + this.height) this.top = row - this.height + 1;
  }
  center() { this.top = Math.max(0, Math.floor(this.cursor / ROW) - (this.height >> 1)); }
  scroll(rows) { this.top = Math.max(0, Math.min(this.top + rows, this.lastRow - this.height + 1)); }

  handle(ev) {
    if (this.popup) { if (ev.type === "mouse" ? this.popup.mouse(ev, this) : this.popup.key(ev, this)) return; }
    if (ev.type === "mouse") return this.mouse(ev);
    if (ev.type !== "key") return;
    const chord = chordOf(ev), page = this.height * ROW;
    switch (chord) {
      case "escape": if (this.anchor !== null) { this.anchor = null; return; } return this.onExit();
      case "ctrl+q": case "cmd+w": return this.onExit();
      case "ctrl+g": return this.openGoto();
      case "ctrl+f": case "cmd+f": return this.openFind();
      case "f3": case "cmd+g": return this.findNext(false);
      case "shift+f3": case "shift+cmd+g": return this.findNext(true);
      case "ctrl+c": case "cmd+c": return this.copy();
    }
    const step = { left: -1, right: 1, up: -ROW, down: ROW, pageup: -page, pagedown: page }[ev.name];
    if (step !== undefined) { if (Math.abs(step) === page) this.scroll(step / ROW); return this.moveTo(this.cursor + step, ev.shift); }
    if (ev.name === "home") return this.moveTo(0, ev.shift);
    if (ev.name === "end") return this.moveTo(this.size - 1, ev.shift);
  }
  // Byte offset under a screen cell (either pane), or null.
  offsetAt(x, y) {
    const r = y - 3, col = x - 1;
    if (r < 0 || r >= this.height) return null;
    let i = col >= ASCII_COL && col < ASCII_COL + ROW ? col - ASCII_COL : -1;
    for (let k = 0; k < ROW && i === -1; k++) if (col >= hexCol(k) && col < hexCol(k) + 3) i = k;
    const o = (this.top + r) * ROW + i;
    return i === -1 || o >= this.size ? null : o;
  }
  mouse(ev) {
    if (ev.button === 64 || ev.button === 65) return this.scroll(ev.button === 64 ? -3 : 3);
    if (ev.button !== 0 || ev.release) return;
    const o = this.offsetAt(ev.x, ev.y);
    if (o !== null) this.moveTo(o, ev.motion || ev.shift);
  }

  openGoto() {
    this.popup = new Input({ label: "Go to offset (0x1F hex or 31 decimal):", onAccept: (t) => {
      const o = parseOffset(t);
      if (o === null || o >= this.size) return this.say(`Offset out of range: ${t}`, this.colors.warn);
      this.moveTo(o); this.center();
    } });
  }
  openFind() {
    this.popup = new Input({ label: "Find (hex bytes de ad be ef, or text):", text: this.query, onAccept: (t) => {
      this.query = t; this.needle = parseNeedle(t);
      this.findNext(false, true);
    } });
  }
  findNext(back, here = false) {
    if (!this.needle) return this.openFind();
    const [s] = this.range(), i = this.reader.find(this.needle, back ? s : here ? this.cursor : s + 1, back);
    if (i === -1) return this.say(`No results for ${this.query}`, this.colors.warn);
    this.anchor = i; this.cursor = i + this.needle.length - 1;
    this.center();
    this.say(`Found at 0x${i.toString(16)} (${i})`);
  }
  copy() {
    const [s, e] = this.range(), n = Math.min(e - s, 1 << 20);
    if (!this.size) return;
    this.clipboard(Array.from(this.reader.read(s, n), hex2).join(" "));
    this.say(n < e - s ? `Copied the first ${n} bytes as hex` : `Copied ${n} byte${n === 1 ? "" : "s"} as hex`);
  }

  render(rows, cols) {
    this.rows = rows; this.cols = cols;
    this.top = Math.max(0, Math.min(this.top, this.lastRow));
    const P = new Painter(), c = this.colors, h = this.height, [s, e] = this.range(), sel = this.anchor !== null;
    const bgOf = (o) => (o === this.cursor ? c.match : sel && o >= s && o < e ? c.selection : c.bg);
    P.move(1, 1); P.text(fit(" " + this.crumbs.join(" › "), cols), c.barFg, c.bg);
    P.move(2, 1); P.text(fit(HEADER, cols), c.lineNumber, c.bg);
    const data = this.reader.read(this.top * ROW, h * ROW);
    for (let r = 0; r < h; r++) {
      const off = (this.top + r) * ROW, bytes = data.subarray(r * ROW, r * ROW + ROW);
      let x = 0;
      const put = (t, fg, bg = c.bg) => { if (x < cols) P.text(t.slice(0, cols - x), fg, bg); x += t.length; };
      P.move(r + 3, 1);
      if (bytes.length || (off === 0 && r === 0)) {
        put(off.toString(16).padStart(8, "0"), Math.floor(this.cursor / ROW) === this.top + r ? c.lineNumberActive : c.lineNumber);
        put("  ", c.fg);
        for (let i = 0; i < ROW; i++) {
          if (i === 8) put(" ", c.fg);
          if (i >= bytes.length) { put("   ", c.fg); continue; }
          const o = off + i, joined = sel && o >= s && o + 1 < e && i !== 7 && i !== ROW - 1;
          put(hex2(bytes[i]), BYTE_COLORS[kindOf(bytes[i])], bgOf(o));
          put(" ", c.fg, joined ? c.selection : c.bg);
        }
        put(" ", c.fg);
        bytes.forEach((b, i) => put(charOf(b), BYTE_COLORS[kindOf(b)], bgOf(off + i)));
      }
      if (x < cols) P.text(" ".repeat(cols - x), c.fg, c.bg);
    }
    this.renderInspector(P, rows - 1);
    this.renderStatus(P);
    if (this.popup) this.popup.render(P, this);
    return P.out + "\x1b[0m\x1b[?25l";
  }
  renderInspector(P, row) {
    const c = this.colors;
    let x = 0;
    P.move(row, 1);
    for (const [k, v] of inspect(this.reader.read(this.cursor, 4))) {
      const t = `  ${k} `;
      if (x + t.length + v.length > this.cols) break;
      P.text(t, c.lineNumber, c.bg); P.text(v, c.fg, c.bg); x += t.length + v.length;
    }
    if (x < this.cols) P.text(" ".repeat(this.cols - x), c.fg, c.bg);
  }
  renderStatus(P) {
    const c = this.colors, o = this.cursor, b = this.reader.read(o, 1)[0], [s, e] = this.range();
    const parts = [`Offset 0x${o.toString(16).toUpperCase()} (${o})`];
    if (b !== undefined) parts.push(`Byte 0x${hex2(b).toUpperCase()} ${b} ${b.toString(2).padStart(8, "0")}`);
    if (this.anchor !== null) parts.push(`${e - s} selected`);
    parts.push(`${sizeText(this.size)}`, "Hex");
    const msg = this.message && this.message.until > Date.now() ? this.message : null;
    let right = parts.join("   ") + "  ";
    if (msg && msg.text.length + right.length + 4 > this.cols) right = ""; // a message wins over the details
    P.move(this.rows, 1);
    P.text(fit("  " + (msg?.text ?? ""), Math.max(0, this.cols - right.length)), msg?.color ?? c.barFg, c.bar);
    if (right.length <= this.cols) P.text(right, c.barFg, c.bar);
  }
}

const sizeText = (n) => (n < 1024 ? `${n} B` : `${(n / 1024 ** (n < 1048576 ? 1 : 2)).toFixed(1)} ${n < 1048576 ? "KB" : "MB"} (${n} bytes)`);

// ---------- "binary file" prompt ----------
class BinaryPrompt {
  constructor(env, onHex, onText, onQuit) {
    Object.assign(this, env);
    this.onQuit = onQuit;
    this.popup = new Dialog({
      title: "The file is not displayed in the text editor because it is binary.",
      detail: "Open it in the Hex Viewer, or open it anyway as text (lossy).",
      buttons: [{ label: "Open in Hex Viewer", key: "h", run: onHex }, { label: "Open Anyway", key: "a", run: onText }],
    });
  }
  closePopup() {}
  handle(ev) {
    const chord = ev.type === "key" ? chordOf(ev) : "";
    if (chord === "escape" || chord === "ctrl+q" || chord === "cmd+w") return this.onQuit();
    if (ev.type === "mouse") this.popup.mouse(ev, this); else this.popup.key(ev, this);
  }
  render(rows, cols) {
    this.rows = rows; this.cols = cols;
    const P = new Painter(), c = this.colors;
    P.move(1, 1); P.text(fit(" " + this.crumbs.join(" › "), cols), c.barFg, c.bg);
    for (let r = 2; r < rows; r++) { P.move(r, 1); P.text(" ".repeat(cols), c.fg, c.bg); }
    P.move(rows, 1); P.text(" ".repeat(cols), c.barFg, c.bar);
    this.popup.render(P, this);
    return P.out + "\x1b[0m\x1b[?25l";
  }
}

// Shows `file` in hex (after the binary prompt when `ask`). Resolves "text" when the user picks Open Anyway (the terminal
// is restored first); quitting exits the process (closing the tab when the Explorer opened it). Rejects, with the
// terminal restored, when the file can't be opened or read.
// opts: { ask, crumbs, clipboard(text) }
function open(file, { ask = false, crumbs, clipboard }) {
  const fd = fs.openSync(file, "r"), reader = new Reader(fd, fs.fstatSync(fd).size);
  const env = { file, crumbs, colors: themePalette(), clipboard };
  return new Promise((resolve, reject) => {
    const viewer = new HexView(reader, env);
    let s = null, app = viewer;
    viewer.onExit = () => { s.end(); T.exit(0); };
    if (ask) app = new BinaryPrompt(env, () => { app = viewer; }, () => { s.end(); fs.closeSync(fd); resolve("text"); }, viewer.onExit);
    // A read error later on (file removed, disk gone) ends the session and goes to the caller like an open error.
    const guard = (fn) => (...a) => { try { return fn(...a); } catch (e) { s.end(); try { fs.closeSync(fd); } catch {} reject(e); return ""; } };
    s = T.session({ render: guard((r, c) => app.render(r, c)), handle: guard((ev) => app.handle(ev)) });
    viewer.redraw = s.draw;
  });
}

module.exports = { binaryName, formatRow, inspect, parseOffset, parseNeedle, Reader, HexView, open, HEADER, hexCol, ASCII_COL };
