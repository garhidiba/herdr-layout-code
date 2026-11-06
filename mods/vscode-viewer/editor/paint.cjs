// Terminal painting: theme palette, 24-bit SGR, a Painter that emits attributes only when they change, fitting text to columns.
const W = require("./width.cjs");

const hex = (c) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const opaque = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
// Alpha color (#rrggbbaa) composited over an opaque one.
function blend(c, under) {
  if (opaque(c)) return opaque(c);
  if (!/^#[0-9a-f]{8}$/i.test(c ?? "")) return under;
  const a = parseInt(c.slice(7, 9), 16) / 255, top = hex(c), bot = hex(under);
  return "#" + top.map((v, i) => Math.round(v * a + bot[i] * (1 - a)).toString(16).padStart(2, "0")).join("");
}
function paletteOf(colors = {}) {
  const bg = opaque(colors["editor.background"]) ?? "#282c34";
  const selection = opaque(colors["editor.selectionBackground"]) ?? "#3e4451";
  const matchOther = blend(colors["editor.findMatchHighlightBackground"] ?? "#528bff3d", bg);
  return {
    bg, fg: opaque(colors["editor.foreground"]) ?? "#abb2bf", selection,
    lineNumber: opaque(colors["editorLineNumber.foreground"]) ?? "#636d83",
    lineNumberActive: opaque(colors["editorLineNumber.activeForeground"]) ?? "#abb2bf",
    currentLine: opaque(colors["editor.lineHighlightBackground"]) ?? "#2c313c",
    match: opaque(colors["editor.findMatchBackground"]) ?? "#42557b", matchOther,
    warn: "#e5c07b", error: "#e06c75", ok: "#98c379",
    bar: opaque(colors["statusBar.background"]) ?? "#21252b", barFg: opaque(colors["statusBar.foreground"]) ?? "#9da5b4",
    widget: opaque(colors["editorWidget.background"]) ?? "#21252b", input: opaque(colors["input.background"]) ?? "#1b1d23",
    cursor: opaque(colors["editorCursor.foreground"]) ?? "#528bff",
    accent: opaque(colors["focusBorder"]) ?? "#528bff", button: opaque(colors["button.background"]) ?? "#4d78cc",
    border: opaque(colors["editorWidget.border"]) ?? "#3a3f4b", highlight: opaque(colors["list.highlightForeground"]) ?? "#d7dae0",
    peek: opaque(colors["peekViewEditor.background"]) ?? "#1b1d23", peekLine: opaque(colors["list.activeSelectionBackground"]) ?? "#2c313a",
    // scrollbars (One Dark's values as fallbacks) and the overview-ruler marks on the vertical one
    slider: blend(colors["scrollbarSlider.background"] ?? "#4e566680", bg),
    sliderHover: blend(colors["scrollbarSlider.hoverBackground"] ?? "#5a637580", bg),
    sliderActive: blend(colors["scrollbarSlider.activeBackground"] ?? "#747d9180", bg),
    rulerFind: blend(colors["editorOverviewRuler.findMatchForeground"] ?? "#d18616", bg),
    rulerSelection: blend(colors["editorOverviewRuler.selectionHighlightForeground"] ?? "#a0a0a0cc", bg),
    rulerCursor: opaque(colors["editorCursor.foreground"]) ?? "#528bff",
    // decorations (the theme's, else One Dark's), alpha blended over the background
    guide: blend(colors["editorIndentGuide.background"] ?? "#abb2bf26", bg),
    guideActive: blend(colors["editorIndentGuide.activeBackground"] ?? "#626772", bg),
    bracketMatch: blend(colors["editorBracketMatch.background"] ?? colors["editorBracketMatch.border"] ?? "#515a6b", bg),
  };
}
// The palette of the installed theme.json (the defaults when it can't be read).
function themePalette() { try { return paletteOf(require("./highlight.cjs").loadTheme().colors); } catch { return paletteOf(); } }
const fgSGR = (c) => { const [r, g, b] = hex(c); return `\x1b[38;2;${r};${g};${b}m`; };
const bgSGR = (c) => { const [r, g, b] = hex(c); return `\x1b[48;2;${r};${g};${b}m`; };
const styleSGR = (s) => "\x1b[22;23;24;29m" + (s & 1 ? "\x1b[3m" : "") + (s & 2 ? "\x1b[1m" : "") + (s & 4 ? "\x1b[4m" : "") + (s & 8 ? "\x1b[9m" : "");

// Paints cells, emitting SGR only when an attribute changes.
class Painter {
  constructor() { this.out = ""; this.fg = this.bg = null; this.style = -1; }
  set(fg, bg, style = 0) {
    if (style !== this.style) { this.out += styleSGR(style); this.style = style; }
    if (fg !== this.fg) { this.out += fgSGR(fg); this.fg = fg; }
    if (bg !== this.bg) { this.out += bgSGR(bg); this.bg = bg; }
  }
  text(s, fg, bg, style = 0) { this.set(fg, bg, style); this.out += s; }
  move(row, col) { this.out += `\x1b[${row};${col}H`; }
}

// Fits text into `width` display columns (cut with …, or padded).
function fit(s, width) {
  if (width <= 0) return "";
  let out = "", w = 0;
  for (const ch of s) {
    const cw = W.charWidth(ch.codePointAt(0));
    if (w + cw > width) { while (w > width - 1) { const last = [...out].pop(); out = out.slice(0, -last.length); w -= W.charWidth(last.codePointAt(0)); } return out + "…" + " ".repeat(width - 1 - w); }
    out += ch; w += cw;
  }
  return out + " ".repeat(width - w);
}

module.exports = { hex, opaque, blend, paletteOf, themePalette, fgSGR, bgSGR, styleSGR, Painter, fit };
