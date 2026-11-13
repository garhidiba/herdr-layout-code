"use strict";
// Shift+click in Herdr. Herdr keeps a Shift+press in a terminal for its own text selection, so the editor's pane header
// (vscode-pane's click.js) writes each left press in the editor's pane to $HERDR_APP_HOME/data/vsedit-click/
// <HC_TERMINAL_ID>.json: { x, y, count, at, kind: "shift" | "plain", area } in window px, `area` the text box
// ({ x, y, width, height | null }). A Shift press becomes a ⌥+click at its cell (the same extend path). Px to cells:
// at first from `area` and the terminal's size; then from plain presses, which also reach the editor as SGR at a cell:
// each one paired with its record calibrates the cell size and origin (a line through two or more cells). The same
// rules are vsedit's clicks.rs.
const os = require("os");
const path = require("path");

const STALE = 1000; // ms: an older record is ignored
const PAIR = 300; // ms between a plain record and the SGR press it is paired with
const KEEP = 8; // pairs kept

// The signal file of this editor's terminal, or null outside a Herdr terminal.
function signalFile(env = process.env) {
  if (!env.HC_TERMINAL_ID) return null;
  const home = env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
  return path.join(home, "data", "vsedit-click", `${env.HC_TERMINAL_ID}.json`);
}

// One axis, as px = a + b × cell at the cell's center (cells 1-based): a line through the pairs ([px, cell]) when they
// span two cells or more, else `est`'s cell size through their mean offset, else `est`.
function fitAxis(pairs, est) {
  if (!pairs.length) return est;
  const n = pairs.length, mc = pairs.reduce((s, p) => s + p[1], 0) / n, mp = pairs.reduce((s, p) => s + p[0], 0) / n;
  const vc = pairs.reduce((s, p) => s + (p[1] - mc) ** 2, 0);
  const b = vc ? pairs.reduce((s, p) => s + (p[1] - mc) * (p[0] - mp), 0) / vc : 0;
  return b > 0 ? { a: mp - b * mc, b } : { a: mp - est.b * mc, b: est.b };
}

// The guess before calibration: `area` split evenly into cols × rows; with no height, cells twice as tall as wide.
function estimate(area, cols, rows) {
  const w = area.width / cols, h = area.height ? area.height / rows : w * 2;
  return { x: { a: area.x - w / 2, b: w }, y: { a: area.y - h / 2, b: h } };
}

// The cell under px (x, y), or null outside the cols × rows screen.
function toCell(x, y, model, cols, rows) {
  const c = Math.round((x - model.x.a) / model.x.b), r = Math.round((y - model.y.a) / model.y.b);
  return c >= 1 && c <= cols && r >= 1 && r <= rows ? { x: c, y: r } : null;
}

const num = Number.isFinite;
const valid = (r) => r && num(r.x) && num(r.y) && num(r.at) && r.area && num(r.area.x) && num(r.area.y) && r.area.width > 0
  && (r.area.height == null || r.area.height > 0);

class Clicks {
  constructor() { this.pairs = []; this.press = null; this.plain = null; this.key = null; this.seen = -Infinity; }

  // A plain left press the editor got as SGR at cell (x, y).
  pressed(x, y, at = Date.now()) { this.press = { x, y, at }; this.pair(); }

  // A record read from the signal file: { x, y, count } (count 1 or 2) for a fresh Shift press on the screen, else null.
  // A record is used once; a new pane box or terminal size starts the calibration over.
  record(rec, cols, rows, now = Date.now()) {
    if (!valid(rec) || !(cols > 0 && rows > 0) || rec.at <= this.seen || now - rec.at > STALE) return null;
    this.seen = rec.at;
    const key = JSON.stringify([rec.area, cols, rows]);
    if (key !== this.key) { this.key = key; this.pairs = []; }
    this.est = estimate(rec.area, cols, rows);
    if (rec.kind === "plain") { this.plain = rec; this.pair(); return null; }
    if (rec.kind !== "shift") return null;
    const cell = toCell(rec.x, rec.y, this.model(), cols, rows);
    return cell && { ...cell, count: rec.count >= 2 ? 2 : 1 };
  }

  pair() {
    const { press, plain } = this;
    if (!press || !plain || Math.abs(press.at - plain.at) > PAIR) return;
    this.pairs = [...this.pairs, { px: plain.x, py: plain.y, x: press.x, y: press.y }].slice(-KEEP);
    this.press = this.plain = null;
  }

  model() {
    return { x: fitAxis(this.pairs.map(p => [p.px, p.x]), this.est.x), y: fitAxis(this.pairs.map(p => [p.py, p.y]), this.est.y) };
  }
}

// A plain left press (no modifier): the ones paired for calibration.
const plainPress = (ev) => ev.type === "mouse" && ev.button === 0 && !ev.motion && !ev.release && !ev.shift && !ev.alt && !ev.ctrl;

module.exports = { Clicks, signalFile, fitAxis, estimate, toCell, plainPress, STALE };
