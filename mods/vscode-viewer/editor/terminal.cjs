// Terminal session shared by the editor, the hex viewer and the error page: the alternate screen and input modes, Herdr
// right-click routing, and a raw-input loop that turns keys/mouse into events for a full-screen app.
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { parse } = require("./keys.cjs");
const { which } = require("./lang/proc.cjs");

// Alternate screen, bracketed paste, SGR mouse, alternate scroll off (1007: the terminal would turn the wheel into ↑/↓ on
// the alternate screen; saved first with XTSAVE), focus reports (1004), Kitty keyboard "disambiguate" (CSI > 1 u: ⌘ keys
// arrive as CSI-u with the super bit), bar cursor; LEAVE undoes each (1007 back as saved, XTRESTORE).
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007s\x1b[?1007l\x1b[?1004h\x1b[>1u\x1b[5 q";
const LEAVE = "\x1b[0m\x1b[<u\x1b[?1004l\x1b[?1007r\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0 q\x1b]112\x07\x1b[?25h\x1b[?1049l";

// VSEDIT_LOG_INPUT=<file>: each raw input chunk is appended to the file as `<ms> <JSON string>` (to see what a real
// terminal sends for keys and the wheel); a no-op otherwise.
function inputLog(file = process.env.VSEDIT_LOG_INPUT) {
  if (!file) return () => {};
  return (chunk) => { try { fs.appendFileSync(file, `${Date.now()} ${JSON.stringify(chunk)}\n`); } catch {} };
}

// `herdr-app <args>` (PATH plus the usual tool folders); `wait` blocks until it ends (at most 1.5 s).
function herdr(args, wait) {
  const bin = which("herdr-app");
  if (!bin) return;
  try {
    if (wait) spawnSync(bin, args, { stdio: "ignore", timeout: 1500 });
    else spawn(bin, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

// herdr-app's JSON answer: {"ok": ...} is true; {"error": ...} or no answer is false.
function answeredOk(out) {
  try { return !!JSON.parse(out).ok; } catch { return false; }
}

// Inside a Herdr terminal, right-clicks go to the program (Shift+right-click stays Herdr's menu) while it runs.
// A tab started with `hc run` is adopted a moment after the program starts, and until then Herdr answers
// {"error": "no such running terminal"}: "program" is asked again every `every` ms in the background until it is ok
// or `until` ms passed (and again on focus-in); "menu" stops that first.
let routing = null; // { child, timer } while asking
function rightClicksTo(to, wait, { every = 150, until = 10000 } = {}) {
  const id = process.env.HC_TERMINAL_ID;
  if (!id) return;
  if (routing) { clearTimeout(routing.timer); routing.child?.kill("SIGKILL"); routing = null; }
  const args = ["do", "terminal.right_click", "--to", to, "--terminal", id];
  if (to !== "program") return herdr(args, wait);
  const bin = which("herdr-app");
  if (!bin) return;
  const state = routing = {}, end = Date.now() + until;
  const ask = () => {
    let out = "", done = false;
    const answered = () => {
      if (done) return;
      done = true;
      state.child = null;
      if (routing !== state) return;
      if (answeredOk(out) || Date.now() + every > end) routing = null;
      else state.timer = setTimeout(ask, every).unref();
    };
    try { state.child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }); } catch { return answered(); }
    state.child.stdout.on("data", (d) => { out += d; });
    state.child.on("error", answered).on("close", answered);
  };
  ask();
}

// Runs a full-screen app: { render(rows, cols) -> ANSI text, handle(ev), hover?(ev) -> text to write | null }. Each input
// batch is parsed (keys.cjs) and handed over (to hover first: non-null means it took the event), then a frame is drawn; a split escape sequence that never completes is a plain Esc. Returns
// { draw, end }: draw() schedules a frame; end() restores the terminal and stops listening (idempotent; it also runs
// on exit, and signals or a closed input end the session and exit).
function session(app) {
  let scheduled = false, pending = "", ended = false;
  const log = inputLog();
  const frame = () => { scheduled = false; if (!ended) process.stdout.write("\x1b[?25l" + app.render(process.stdout.rows || 24, process.stdout.columns || 80)); };
  const draw = () => { if (!scheduled) { scheduled = true; setImmediate(frame); } };
  const onData = (chunk) => {
    log(chunk);
    const { events, rest } = parse(pending + chunk);
    pending = rest;
    let changed = false;
    for (const ev of events) {
      if (ev.type === "focus" && ev.focused) rightClicksTo("program"); // again, in case Herdr hadn't adopted it yet
      const out = app.hover?.(ev) ?? null; // hover motion repaints only what changed, without a frame
      if (out === null) { app.handle(ev); changed = true; } else if (out) process.stdout.write(out);
    }
    if (pending) setTimeout(() => { if (pending === rest) { pending = ""; app.handle({ type: "key", name: "escape" }); draw(); } }, 50);
    if (changed || !events.length) draw();
  };
  const quit = (code) => () => { end(); process.exit(code); };
  const handlers = [[process, "exit", () => end()], [process.stdin, "data", onData], [process.stdout, "resize", draw],
    [process.stdin, "end", quit(129)], [process.stdin, "error", quit(129)], [process.stdout, "error", quit(129)],
    ...["SIGTERM", "SIGHUP", "SIGINT"].map(sig => [process, sig, quit(128 + (os.constants.signals[sig] ?? 1))])];
  function end() {
    if (ended) return;
    ended = true;
    for (const [target, name, fn] of handlers) target.off(name, fn);
    try { process.stdout.write(LEAVE); } catch {}
    try { process.stdin.setRawMode(false); } catch {}
    rightClicksTo("menu", true);
  }
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  for (const [target, name, fn] of handlers) target.on(name, fn);
  process.stdout.write(ENTER);
  rightClicksTo("program", false);
  draw();
  return { draw, end };
}

// Started by the Explorer as `exec node vsedit.cjs <file> --close-on-exit`: the program replaced the tab's shell, so the
// tab closes when it exits, and a file that isn't there is an error rather than a new file.
const closeOnExit = () => process.argv.includes("--close-on-exit");

module.exports = { ENTER, LEAVE, inputLog, herdr, answeredOk, rightClicksTo, session, closeOnExit };
