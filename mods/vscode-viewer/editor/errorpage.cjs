// The tab's page for a file the editor can't open, like VS Code's editor error page: the reason, then Try Again,
// Open in VS Code, Reveal in Finder and Close (Esc/⌘W/Ctrl+Q). Keyboard and mouse.
const path = require("path");
const { spawn } = require("child_process");
const { Painter, fit, themePalette } = require("./paint.cjs");
const { chordOf } = require("./commands.cjs");
const { env, which } = require("./lang/proc.cjs");
const T = require("./terminal.cjs");

const WHITE = "#ffffff";
const REASONS = { ENOENT: "File not found", EACCES: "Permission denied", EPERM: "Permission denied", EISDIR: "The path is a folder, not a file",
  ELOOP: "Too many symbolic links", ENAMETOOLONG: "The file name is too long", EIO: "The disk could not be read" };
// A short reason for an fs error (its message when there is no better name).
const reasonOf = (e) => REASONS[e?.code] ?? String(e?.message ?? e).split("\n")[0];

// Starts a program without waiting; false when it isn't installed.
function launch(cmd, args) {
  const bin = which(cmd);
  if (!bin) return false;
  try { spawn(bin, args, { stdio: "ignore", detached: true, env: env() }).on("error", () => {}).unref(); return true; } catch { return false; }
}

class ErrorPage {
  constructor(file, reason, crumbs, done) {
    this.file = file; this.reason = reason; this.crumbs = crumbs; this.done = done;
    this.colors = themePalette(); this.focus = 0; this.rects = []; this.note = "";
    this.buttons = [
      { label: "Try Again", key: "t", run: () => done("retry") },
      { label: "Open in VS Code", key: "o", run: () => { this.note = launch("code", [file]) ? "Opened in VS Code" : "VS Code's `code` command was not found"; } },
      ...(process.platform === "darwin" ? [{ label: "Reveal in Finder", key: "r", run: () => { launch("open", ["-R", file]); } }] : []),
      { label: "Close", key: "c", run: () => done("close") },
    ];
  }
  handle(ev) {
    const n = this.buttons.length;
    if (ev.type === "mouse") {
      const r = !ev.release && !ev.motion && ev.button === 0 && this.rects.find(r => ev.y === r.y && ev.x >= r.x && ev.x < r.x + r.w);
      if (r) this.buttons[r.i].run();
      return;
    }
    if (ev.type === "text") { const b = this.buttons.find(b => b.key === ev.text.toLowerCase()); return b?.run(); }
    if (ev.type !== "key") return;
    const chord = chordOf(ev);
    if (chord === "escape" || chord === "ctrl+q" || chord === "cmd+w") return this.done("close");
    if (ev.name === "enter" || ev.name === "space") return this.buttons[this.focus].run();
    if (ev.name === "right" || chord === "tab") this.focus = (this.focus + 1) % n;
    if (ev.name === "left" || chord === "shift+tab") this.focus = (this.focus - 1 + n) % n;
  }
  render(rows, cols) {
    const P = new Painter(), c = this.colors;
    const lines = [["⚠", c.warn, 0], ["", c.fg, 0], ["The editor could not be opened", c.fg, 2], [path.basename(this.file), c.barFg, 0],
      [this.reason, c.error, 0], ["", c.fg, 0]];
    const top = Math.max(2, Math.floor((rows - lines.length - 3) / 2));
    P.move(1, 1); P.text(fit(" " + this.crumbs.join(" › "), cols), c.barFg, c.bg);
    for (let r = 2; r < rows; r++) {
      P.move(r, 1);
      const line = lines[r - top];
      if (line) { const pad = Math.max(0, Math.floor((cols - line[0].length) / 2)); P.text(fit(" ".repeat(pad) + line[0], cols), line[1], c.bg, line[2]); }
      else P.text(" ".repeat(cols), c.fg, c.bg);
    }
    // buttons, centered under the text
    const y = top + lines.length, labels = this.buttons.map(b => ` ${b.label} `);
    let x = Math.max(1, Math.floor((cols - labels.reduce((n, l) => n + l.length + 2, -2)) / 2) + 1);
    this.rects = [];
    labels.forEach((l, i) => {
      if (x + l.length - 1 > cols) return;
      P.move(y, x); P.text(l, i === this.focus ? WHITE : c.fg, i === this.focus ? c.button : c.input);
      this.rects.push({ x, y, w: l.length, i }); x += l.length + 2;
    });
    if (this.note) { P.move(y + 2, 1); P.text(fit(" ".repeat(Math.max(0, Math.floor((cols - this.note.length) / 2))) + this.note, cols), c.barFg, c.bg); }
    P.move(rows, 1); P.text(fit("  " + this.reason, cols), c.barFg, c.bar);
    return P.out + "\x1b[0m\x1b[?25l";
  }
}

// Shows the page until the user picks Try Again (resolves "retry", the terminal restored) or Close (the terminal is
// restored, then the tab closes when the Explorer opened it; otherwise one line on stderr and exit 1).
function show(file, reason, crumbs) {
  return new Promise((resolve) => {
    const page = new ErrorPage(file, reason, crumbs, (choice) => {
      s.end();
      if (choice === "retry") return resolve("retry");
      if (!T.closesTab()) process.stderr.write(`vsedit: ${path.basename(file)}: ${reason}\n`);
      T.exit(1);
    });
    const s = T.session({ render: (r, c) => page.render(r, c), handle: (ev) => page.handle(ev) });
    page.redraw = s.draw;
  });
}

module.exports = { reasonOf, show, ErrorPage };
