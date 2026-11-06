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
    // find widget toggles (Match Case...) when on: VS Code's inputOption.activeBackground is focusBorder at 40%
    toggleOn: blend(colors["inputOption.activeBackground"] ?? (opaque(colors["focusBorder"]) ?? "#528bff") + "66", opaque(colors["editorWidget.background"]) ?? "#21252b"),
    toggleFg: opaque(colors["inputOption.activeForeground"]) ?? "#ffffff",
    border: opaque(colors["editorWidget.border"]) ?? "#3a3f4b", highlight: opaque(colors["list.highlightForeground"]) ?? "#d7dae0",
    hoverBg: opaque(colors["editorHoverWidget.background"]) ?? "#21252b", hoverBorder: opaque(colors["editorHoverWidget.border"]) ?? "#454545",
    lightBulb: opaque(colors["editorLightBulb.foreground"]) ?? "#ffcc00",
    peek: opaque(colors["peekViewEditor.background"]) ?? "#1b1d23", peekLine: opaque(colors["list.activeSelectionBackground"]) ?? "#2c313a",
    // scrollbars (One Dark's values as fallbacks) and the overview-ruler marks on the vertical one
    slider: blend(colors["scrollbarSlider.background"] ?? "#4e566680", bg),
    sliderHover: blend(colors["scrollbarSlider.hoverBackground"] ?? "#5a637580", bg),
    sliderActive: blend(colors["scrollbarSlider.activeBackground"] ?? "#747d9180", bg),
    rulerFind: blend(colors["editorOverviewRuler.findMatchForeground"] ?? "#d18616", bg),
    rulerSelection: blend(colors["editorOverviewRuler.selectionHighlightForeground"] ?? "#a0a0a0cc", bg),
    rulerCursor: opaque(colors["editorCursor.foreground"]) ?? "#528bff",
    rulerWord: blend(colors["editorOverviewRuler.wordHighlightForeground"] ?? "#a0a0a0cc", bg),
    // decorations (the theme's, else One Dark Pro's / VS Code's dark defaults), alpha blended over the background
    guide: blend(colors["editorIndentGuide.background"] ?? "#abb2bf26", bg),
    guideActive: blend(colors["editorIndentGuide.activeBackground"] ?? "#626772", bg),
    bracketMatch: blend(colors["editorBracketMatch.background"] ?? colors["editorBracketMatch.border"] ?? "#515a6b", bg),
    wordHighlight: blend(colors["editor.wordHighlightBackground"] ?? "#d2e0ff2f", bg),
    selectionHighlight: blend(colors["editor.selectionHighlightBackground"] ?? "#add6ff26", bg),
    // diagnostics by severity (1 error, 2 warning, 3 information): squiggles, gutter marks, overview ruler (VS Code's
    // dark defaults; One Dark doesn't set them)
    diag: [null, opaque(colors["editorError.foreground"]) ?? "#f14c4c", opaque(colors["editorWarning.foreground"]) ?? "#cca700",
      opaque(colors["editorInfo.foreground"]) ?? "#3794ff"],
    rulerDiag: [null, blend(colors["editorOverviewRuler.errorForeground"] ?? "#ff1212b3", bg),
      blend(colors["editorOverviewRuler.warningForeground"] ?? "#cca700", bg), blend(colors["editorOverviewRuler.infoForeground"] ?? "#3794ff", bg)],
    // git change bars (One Dark Pro's; the akamud theme has none) and their ruler marks (VS Code: the bar color at 60%)
    ...gitColors(colors, bg),
    // folding (VS Code's dark defaults: the icon color, the selection at 30%, gray)
    foldControl: blend(colors["editorGutter.foldingControlForeground"] ?? "#c5c5c5", bg),
    foldBackground: blend(colors["editor.foldBackground"] ?? selection + "4d", bg),
    foldPlaceholder: blend(colors["editor.foldPlaceholderForeground"] ?? "#808080", bg),
    // inline suggestions' ghost text (VS Code's dark default)
    ghost: blend(colors["editorGhostText.foreground"] ?? "#ffffff56", bg),
  };
}
const GIT_DEFAULTS = { added: "#109868", modified: "#948b60", deleted: "#9a353d" };
function gitColors(colors, bg) {
  const out = {};
  for (const [kind, fallback] of Object.entries(GIT_DEFAULTS)) {
    const Kind = kind[0].toUpperCase() + kind.slice(1), bar = blend(colors[`editorGutter.${kind}Background`] ?? fallback, bg);
    out[`git${Kind}`] = bar;
    out[`ruler${Kind}`] = blend(colors[`editorOverviewRuler.${kind}Foreground`] ?? bar + "99", bg);
  }
  return out;
}
// The palette of the installed theme.json (the defaults when it can't be read).
function themePalette() { try { return paletteOf(require("./highlight.cjs").loadTheme().colors); } catch { return paletteOf(); } }
const fgSGR = (c) => { const [r, g, b] = hex(c); return `\x1b[38;2;${r};${g};${b}m`; };
const bgSGR = (c) => { const [r, g, b] = hex(c); return `\x1b[48;2;${r};${g};${b}m`; };
const styleSGR = (s) => "\x1b[22;23;24;29m" + (s & 1 ? "\x1b[3m" : "") + (s & 2 ? "\x1b[1m" : "") + (s & 4 ? "\x1b[4m" : "") + (s & 8 ? "\x1b[9m" : "");

// A problem's underline in a color (diagnostics): a plain underline (a curly SGR 4:3 one showed nothing in Herdr's terminal) colored
// with SGR 58; 59 puts the underline color back.
const curlySGR = (c) => { const [r, g, b] = hex(c); return `\x1b[4m\x1b[58:2::${r}:${g}:${b}m`; };

// Paints cells, emitting SGR only when an attribute changes. curly: a squiggle color for these cells, or null.
class Painter {
  constructor() { this.out = ""; this.fg = this.bg = null; this.style = -1; this.curly = null; }
  set(fg, bg, style = 0, curly = null) {
    if (style !== this.style || curly !== this.curly) {
      this.out += styleSGR(style) + (curly ? curlySGR(curly) : this.curly ? "\x1b[59m" : "");
      this.style = style; this.curly = curly;
    }
    if (fg !== this.fg) { this.out += fgSGR(fg); this.fg = fg; }
    if (bg !== this.bg) { this.out += bgSGR(bg); this.bg = bg; }
  }
  text(s, fg, bg, style = 0, curly = null) { this.set(fg, bg, style, curly); this.out += s; }
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
