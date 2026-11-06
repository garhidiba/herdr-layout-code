// File boundary: decode into lines (remembering EOL and trailing newline), detect indentation, save atomically.
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 50 * 1024 * 1024;

// "binary" / "too large" refuse to open; otherwise the document's text facts.
function decode(bytes) {
  if (bytes.length > MAX_BYTES) return { error: `File is larger than 50 MB (${(bytes.length / 1048576).toFixed(1)} MB).` };
  if (bytes.includes(0)) return { error: "File seems to be binary (contains NUL bytes)." };
  let text = bytes.toString("utf8");
  const bom = text.startsWith("﻿");
  if (bom) text = text.slice(1);
  const crlf = text.indexOf("\r\n"), lf = text.indexOf("\n");
  const eol = crlf !== -1 && crlf < lf ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n|\r/);
  const finalNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline, bom };
}

function encode(lines, { eol = "\n", finalNewline = false, bom = false } = {}) {
  return (bom ? "﻿" : "") + lines.join(eol) + (finalNewline ? eol : "");
}

// VS Code-style guess: Tabs when most indented lines start with a tab, else the most common small space step.
function detectIndent(lines) {
  let tabs = 0; const steps = {};
  for (const l of lines.slice(0, 2000)) {
    if (l.startsWith("\t")) tabs++;
    else { const m = l.match(/^( +)\S/); if (m && m[1].length <= 8) steps[m[1].length] = (steps[m[1].length] ?? 0) + 1; }
  }
  const spaceLines = Object.values(steps).reduce((a, b) => a + b, 0);
  const size = Object.keys(steps).map(Number).sort((a, b) => a - b).find(k => steps[k] >= Math.max(Math.min(2, spaceLines), spaceLines * 0.1)) ?? 4;
  return tabs > spaceLines ? { useTabs: true, size: 4 } : { useTabs: false, size };
}

const stamp = (st) => ({ mtimeMs: st.mtimeMs, size: st.size });
const sameStamp = (a, b) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

function load(file) {
  const size = fs.statSync(file).size;
  if (size > MAX_BYTES) return decode({ length: size });
  const bytes = fs.readFileSync(file);
  const doc = decode(bytes);
  if (!doc.error) doc.stamp = stamp(fs.statSync(file));
  return doc;
}

// Null when the file is gone or unchanged since `known`, else its new stamp.
function changedOnDisk(file, known) {
  try { const now = stamp(fs.statSync(file)); return sameStamp(now, known) ? null : now; } catch { return null; }
}

// Write to a temp file next to the target, keep its mode, then rename over it. Returns the new stamp.
function save(file, text) {
  try { file = fs.realpathSync(file); } catch {} // a symlink keeps pointing at the saved file
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o7777; } catch {}
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.vsedit-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return stamp(fs.statSync(file));
}

module.exports = { decode, encode, detectIndent, load, save, changedOnDisk, MAX_BYTES };
