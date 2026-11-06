// Text model: lines plus edits with undo/redo. Positions are { line, col } with col a UTF-16 index.

const cmp = (a, b) => a.line - b.line || a.col - b.col;
const ordered = (a, b) => (cmp(a, b) <= 0 ? [a, b] : [b, a]);

// A selection { anchor, head }; collapsed when both are the same position.
const caret = (p) => ({ anchor: { ...p }, head: { ...p } });

// Where `text` ends when inserted at `start`.
function endOf(start, text) {
  const parts = text.split("\n");
  return parts.length === 1
    ? { line: start.line, col: start.col + text.length }
    : { line: start.line + parts.length - 1, col: parts[parts.length - 1].length };
}

class Buffer {
  constructor(lines = [""]) {
    this.lines = lines.length ? lines : [""];
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;        // bumps on every change
    this.savedVersion = 0;   // version that matches the file on disk
    this.listeners = [];     // (startLine, removedLines, insertedLines) after each primitive edit
  }

  get dirty() { return this.version !== this.savedVersion; }
  markSaved() { this.savedVersion = this.version; }

  clamp(p) {
    const line = Math.max(0, Math.min(this.lines.length - 1, p.line));
    return { line, col: Math.max(0, Math.min(this.lines[line].length, p.col)) };
  }

  getText(a, b) {
    const [s, e] = ordered(this.clamp(a), this.clamp(b));
    if (s.line === e.line) return this.lines[s.line].slice(s.col, e.col);
    const out = [this.lines[s.line].slice(s.col)];
    for (let l = s.line + 1; l < e.line; l++) out.push(this.lines[l]);
    out.push(this.lines[e.line].slice(0, e.col));
    return out.join("\n");
  }

  // Replaces [a, b) with text (\n line breaks). Returns the record needed to undo it.
  replace(a, b, text) {
    const [s, e] = ordered(this.clamp(a), this.clamp(b));
    const oldText = this.getText(s, e);
    const head = this.lines[s.line].slice(0, s.col), tail = this.lines[e.line].slice(e.col);
    const parts = text.split("\n");
    parts[0] = head + parts[0];
    parts[parts.length - 1] += tail;
    this.lines.splice(s.line, e.line - s.line + 1, ...parts);
    this.version++;
    for (const fn of this.listeners) fn(s.line, e.line - s.line + 1, parts.length);
    return { start: s, oldText, newText: text };
  }

  // Applies edits [{ start, end, text }] in order as one undo step; before/after are the selections to restore.
  // kind "type" merges with the previous typing step when it continues where that one ended.
  edit(edits, { before, after, kind = null } = {}) {
    const records = edits.map(({ start, end, text }) => this.replace(start, end ?? start, text));
    const last = this.undoStack[this.undoStack.length - 1];
    const r = records[0];
    if (kind === "type" && records.length === 1 && last && last.kind === "type" && !last.sealed && last.records.length === 1
      && !r.oldText && !r.newText.includes("\n") && cmp(endOf(last.records[0].start, last.records[0].newText), r.start) === 0) {
      last.records[0].newText += r.newText;
      last.after = after;
    } else {
      this.undoStack.push({ records, before, after, kind });
    }
    this.redoStack = [];
    return records;
  }

  // Ends the current typing group (cursor moved, focus changed...).
  seal() { const last = this.undoStack[this.undoStack.length - 1]; if (last) last.sealed = true; }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    for (let i = step.records.length - 1; i >= 0; i--) {
      const r = step.records[i];
      this.replace(r.start, endOf(r.start, r.newText), r.oldText);
    }
    step.sealed = true;
    this.redoStack.push(step);
    return step.before ?? caret(step.records[0].start);
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    for (const r of step.records) this.replace(r.start, endOf(r.start, r.oldText), r.newText);
    this.undoStack.push(step);
    const r = step.records[step.records.length - 1];
    return step.after ?? caret(endOf(r.start, r.newText));
  }
}

module.exports = { Buffer, cmp, ordered, endOf, caret };
