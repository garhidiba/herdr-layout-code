// Workspace edits: { [absolute file]: [{ start: {line, col}, end: {line, col}, text }] } (0-based lines, UTF-16 cols).
// Files open in the editor get the edits through `openBuffer`; the rest are rewritten on disk keeping EOL, BOM and mode.
const F = require("../file.cjs");
const { cmp } = require("../buffer.cjs");
const { lineHunks } = require("../gitgutter.cjs");

// Edits sorted last-first, so applying them in order never shifts a later one.
const lastFirst = (edits) => [...edits].sort((a, b) => cmp(b.start, a.start) || cmp(b.end, a.end));

// Pure: lines with the edits applied.
function applyToLines(lines, edits) {
  const out = [...lines];
  for (const e of lastFirst(edits)) {
    const s = clampTo(out, e.start), t = clampTo(out, e.end);
    const parts = e.text.replace(/\r\n?/g, "\n").split("\n");
    parts[0] = out[s.line].slice(0, s.col) + parts[0];
    parts[parts.length - 1] += out[t.line].slice(t.col);
    out.splice(s.line, t.line - s.line + 1, ...parts);
  }
  return out;
}
function clampTo(lines, p) {
  const line = Math.max(0, Math.min(lines.length - 1, p.line));
  return { line, col: Math.max(0, Math.min(lines[line].length, p.col)) };
}

// Format Selection with a document formatter: its `edits` restricted to lines [a, b], as one edit replacing those lines
// ([] when it changes none of them); null when a changed run of lines crosses a or b (it can't be split safely).
function editsWithin(lines, edits, a, b) {
  const after = applyToLines(lines, edits), block = [];
  let i = a, changed = false;
  for (const h of lineHunks(lines, after)) {
    if (h.a0 === h.a1 ? h.a0 <= a || h.a0 > b : h.a1 <= a || h.a0 > b) continue; // outside (an insertion at an edge too)
    if (h.a0 < a || h.a1 > b + 1) return null;
    block.push(...lines.slice(i, h.a0), ...after.slice(h.b0, h.b1));
    i = h.a1; changed = true;
  }
  if (!changed) return [];
  block.push(...lines.slice(i, b + 1));
  return [{ start: { line: a, col: 0 }, end: { line: b, col: lines[b].length }, text: block.join("\n") }];
}

// Merges two workspace edits (same file: concatenated).
function merge(a, b) {
  const out = { ...a };
  for (const [f, es] of Object.entries(b ?? {})) out[f] = [...(out[f] ?? []), ...es];
  return out;
}

const count = (ws) => Object.values(ws ?? {}).reduce((n, es) => n + es.length, 0);

// Applies a workspace edit. openBuffer(file, edits) returns true when it took the edits (the file is open).
// Returns { files, edits, failed: [{ file, error }] }.
function applyWorkspaceEdit(ws, openBuffer = () => false) {
  const result = { files: 0, edits: 0, failed: [] };
  for (const [file, edits] of Object.entries(ws ?? {})) {
    if (!edits.length) continue;
    try {
      if (!openBuffer(file, edits)) {
        const doc = F.load(file);
        if (doc.error) throw new Error(doc.error);
        F.save(file, F.encode(applyToLines(doc.lines, edits), doc));
      }
      result.files++; result.edits += edits.length;
    } catch (e) { result.failed.push({ file, error: e.message }); }
  }
  return result;
}

module.exports = { applyToLines, applyWorkspaceEdit, editsWithin, lastFirst, merge, count };
