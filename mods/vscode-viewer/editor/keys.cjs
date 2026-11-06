// Terminal input -> events: { type: "key", name, ctrl, shift, alt, cmd } | { type: "text", text } | { type: "paste", text }
// | { type: "mouse", button, x, y, release, motion, shift, alt, ctrl } | { type: "focus", focused }. Handles xterm CSI/SS3,
// SGR mouse, bracketed paste, focus reports, Kitty CSI-u (with the super/⌘ bit) and modifyOtherKeys.
// Incomplete sequences at the end are returned as `rest`.

const CSI_NAMES = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab", P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE_NAMES = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12", 29: "menu" };
const KITTY_NAMES = { 57363: "menu" }; // Kitty's functional-key code points we use (the context-menu key)
const CTRL_LETTERS = "@abcdefghijklmnopqrstuvwxyz[\\]^_";

// Modifier parameter: 1 + (shift 1, alt 2, ctrl 4, super/⌘ 8, hyper 16, meta 32; caps 64 and num lock 128 ignored).
const mods = (m) => { m = (Number(m) || 1) - 1; return { shift: !!(m & 1), alt: !!(m & 2 || m & 32), ctrl: !!(m & 4), cmd: !!(m & 8) }; };
const key = (name, m = {}) => ({ type: "key", name, ctrl: !!m.ctrl, shift: !!m.shift, alt: !!m.alt, cmd: !!m.cmd });

// A single byte/char outside escape sequences.
function plain(ch, alt = false) {
  const c = ch.charCodeAt(0);
  if (ch === "\r" || ch === "\n") return key("enter", { alt });
  if (ch === "\t") return key("tab", { alt });
  if (ch === "\x7f") return key("backspace", { alt }); // 0x08 stays Ctrl+H (macOS terminals send 0x7f)
  if (c === 0x1b) return key("escape");
  if (c < 0x20) return key(CTRL_LETTERS[c] === "_" ? "/" : CTRL_LETTERS[c], { ctrl: true, alt });
  if (alt) return key(ch.toLowerCase(), { alt: true, shift: ch !== ch.toLowerCase() });
  return null;
}

// CSI-u / modifyOtherKeys code point -> key.
function codeKey(code, m) {
  const k = mods(m);
  if (code === 13) return key("enter", k);
  if (code === 9) return key("tab", k);
  if (code === 27) return key("escape", k);
  if (code === 127 || code === 8) return key("backspace", k);
  if (KITTY_NAMES[code]) return key(KITTY_NAMES[code], k);
  if (code >= 57344 && code <= 63743) return null; // other Kitty functional keys (lone modifiers, keypad...)
  const ch = String.fromCodePoint(code);
  if (!k.ctrl && !k.alt && !k.cmd) return { type: "text", text: k.shift ? ch.toUpperCase() : ch };
  return key(ch.toLowerCase(), k);
}

function parse(input) {
  const events = [];
  let i = 0, text = "";
  const flush = () => { if (text) { events.push({ type: "text", text }); text = ""; } };
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "\x1b") {
      const ev = plain(ch);
      if (ev) { flush(); events.push(ev); } else text += ch;
      i++; continue;
    }
    flush();
    const rest = input.slice(i);
    if (rest.startsWith("\x1b[200~")) {
      const end = rest.indexOf("\x1b[201~");
      if (end === -1) return { events, rest };
      events.push({ type: "paste", text: rest.slice(6, end) });
      i += end + 6; continue;
    }
    let m = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (m) {
      const b = Number(m[1]);
      events.push({ type: "mouse", button: b & 0x43, x: Number(m[2]), y: Number(m[3]), release: m[4] === "m", motion: !!(b & 32),
        shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16) });
      i += m[0].length; continue;
    }
    if (rest.startsWith("\x1b[I") || rest.startsWith("\x1b[O")) { events.push({ type: "focus", focused: rest[2] === "I" }); i += 3; continue; }
    m = rest.match(/^\x1b\[27;(\d+);(\d+)~/);
    if (m) { const ev = codeKey(Number(m[2]), m[1]); if (ev) events.push(ev); i += m[0].length; continue; }
    // Kitty: CSI code[:alternates] ; mods[:event] [; text] u
    m = rest.match(/^\x1b\[(\d+)(?::[\d:]*)?(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u/);
    if (m) {
      const ev = m[3] === "3" ? null : codeKey(Number(m[1]), m[2]); // key releases are dropped
      if (ev) events.push(ev);
      i += m[0].length; continue;
    }
    m = rest.match(/^\x1b\[(\d+)(?:;(\d+)(?::\d+)?)?~/);
    if (m) { if (TILDE_NAMES[m[1]]) events.push(key(TILDE_NAMES[m[1]], mods(m[2]))); i += m[0].length; continue; }
    m = rest.match(/^\x1b\[(?:1;)?(\d+)?(?::\d+)?([A-HPQRSZ])/);
    if (m) {
      const k = mods(m[1]);
      if (m[2] === "Z") k.shift = true;
      if (CSI_NAMES[m[2]]) events.push(key(CSI_NAMES[m[2]], k));
      i += m[0].length; continue;
    }
    m = rest.match(/^\x1bO([A-HPQRS])/);
    if (m) { events.push(key(CSI_NAMES[m[1]])); i += 3; continue; }
    if (/^\x1b(\[[\d;:<]*|O)?$/.test(rest) && rest.length > 1) return { events, rest }; // split sequence
    m = rest.match(/^\x1b\[[\d;?<>]*[\x40-\x7e]/);
    if (m) { i += m[0].length; continue; } // unknown CSI: ignore
    if (rest.length === 1) { events.push(key("escape")); i++; continue; }
    const next = rest[1];
    if (next === "b" || next === "f") events.push(key(next === "b" ? "left" : "right", { alt: true })); // option+arrow
    else if (next === "\x1b") { events.push(key("escape")); i++; continue; }
    else events.push(plain(next, true) ?? key(next, { alt: true }));
    i += 2;
  }
  flush();
  return { events, rest: "" };
}

module.exports = { parse };
