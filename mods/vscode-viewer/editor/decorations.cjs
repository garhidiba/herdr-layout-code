// Editor decorations from the text, computed for the visible lines only: indent guides (editor.guides.indentation, with
// the active one), the matching bracket (and the pair around a position or the next bracket, for Go to Bracket), and
// word / selection occurrences. Pure functions over lines.
const { wordOccurrences } = require("./lang/fallback.cjs");

const SCAN = 1000;     // lines walked from a line to find its block or the content around a blank line
const BRACKETS = { "(": ")", "[": "]", "{": "}" };
const OPENS = { ")": "(", "]": "[", "}": "{" };

// Display columns of a line's leading whitespace, or -1 for a blank (whitespace-only) line.
function leadCols(text, tab) {
  let c = 0;
  for (const ch of text) {
    if (ch === " ") c++;
    else if (ch === "\t") c += tab - (c % tab);
    else return c;
  }
  return -1;
}

// level(l): how many guides line l has (one per started indent of `size` columns). A blank line takes VS Code's rule from
// the content lines around it: one more than the shallower when they differ, their level when equal, 0 at the file's ends.
function guideLevels(lines, size, tab) {
  const memo = new Map();
  const content = (l) => {
    let v = memo.get(l);
    if (v === undefined) { const c = leadCols(lines[l], tab); memo.set(l, (v = c < 0 ? -1 : Math.ceil(c / size))); }
    return v;
  };
  const near = (l, d) => {
    for (let k = l + d, n = 0; k >= 0 && k < lines.length && n < SCAN; k += d, n++) { const v = content(k); if (v >= 0) return v; }
    return -1;
  };
  return (l) => {
    const v = content(l);
    if (v >= 0) return v;
    const up = near(l, -1), down = near(l, 1);
    if (up < 0 || down < 0) return 0;
    return up < down ? up + 1 : up === down ? down : down + 1;
  };
}

// The active guide for the cursor on line c, VS Code's: the block below a header line (the next line one level deeper),
// the block above a footer line, else the block the line is in. { index, from, to }: guide `index` on lines [from, to].
function activeGuide(level, c, n) {
  const at = level(c), down = c + 1 < n ? level(c + 1) : -1, up = c > 0 ? level(c - 1) : -1;
  let indent = at, from = c, to = c, goUp = true, goDown = true;
  if (down === at + 1) { indent = down; from = to = c + 1; goUp = false; }
  else if (up === at + 1) { indent = up; from = to = c - 1; goDown = false; }
  else if (!at) return null;
  for (let k = 0; goUp && from > 0 && k < SCAN && level(from - 1) >= indent; k++) from--;
  for (let k = 0; goDown && to < n - 1 && k < SCAN && level(to + 1) >= indent; k++) to++;
  return { index: indent - 1, from, to };
}

// Guides of lines [first, last]: per line { count, active } — guides at display columns i*size for i < count, `active` the
// index drawn in the active color (-1 for none).
function indentGuides(lines, first, last, size, tab, cursorLine) {
  const level = guideLevels(lines, size, tab), act = activeGuide(level, cursorLine, lines.length), out = [];
  for (let l = first; l <= Math.min(last, lines.length - 1); l++) {
    const count = level(l);
    out.push({ count, active: act && l >= act.from && l <= act.to && act.index < count ? act.index : -1 });
  }
  return out;
}

// The bracket touching p (the one before it first; after it first with `afterFirst`, as VS Code's Go to Bracket) and its
// partner: [at, partner], or null. code(line, col) is false inside strings and comments, whose brackets don't count.
// At most `limit` characters are scanned.
function matchBracket(lines, p, code, limit = 20000, afterFirst = false) {
  const text = lines[p.line] ?? "";
  for (const col of afterFirst ? [p.col, p.col - 1] : [p.col - 1, p.col]) {
    const ch = text[col];
    if (!(BRACKETS[ch] || OPENS[ch]) || !code(p.line, col)) continue;
    const other = partner(lines, { line: p.line, col }, ch, code, limit);
    if (other) return [{ line: p.line, col }, other];
  }
  return null;
}
function partner(lines, at, ch, code, limit) {
  const dir = BRACKETS[ch] ? 1 : -1, other = BRACKETS[ch] ?? OPENS[ch];
  let depth = 0, { line, col } = at;
  for (let budget = limit; budget > 0;) {
    const t = lines[line];
    for (; col >= 0 && col < t.length && budget > 0; col += dir, budget--) {
      const c = t[col];
      if ((c === ch || c === other) && code(line, col) && !(depth += c === ch ? 1 : -1)) return { line, col };
    }
    line += dir; budget--;
    if (line < 0 || line >= lines.length) return null;
    col = dir > 0 ? 0 : lines[line].length - 1;
  }
  return null;
}
// The innermost pair around p: the nearest opener before p that is still open there, and its partner ([open, close]), or null.
function enclosingBrackets(lines, p, code, limit = 20000) {
  const depth = { "(": 0, "[": 0, "{": 0 };
  let line = p.line, col = p.col - 1;
  for (let budget = limit; budget > 0;) {
    const t = lines[line] ?? "";
    for (; col >= 0 && budget > 0; col--, budget--) {
      const c = t[col];
      if (!(BRACKETS[c] || OPENS[c]) || !code(line, col)) continue;
      if (OPENS[c]) depth[OPENS[c]]++;
      else if (depth[c]) depth[c]--;
      else { const close = partner(lines, { line, col }, c, code, limit); if (close) return [{ line, col }, close]; }
    }
    if (--line < 0) return null;
    col = lines[line].length - 1; budget--;
  }
  return null;
}
// The first bracket at or after p ({ line, col }), or null.
function nextBracket(lines, p, code, limit = 20000) {
  let line = p.line, col = p.col;
  for (let budget = limit; budget > 0 && line < lines.length; line++, col = 0, budget--) {
    const t = lines[line];
    for (; col < t.length && budget > 0; col++, budget--) if ((BRACKETS[t[col]] || OPENS[t[col]]) && code(line, col)) return { line, col };
  }
  return null;
}

// Whole-word matches of `word` on lines [first, last]: [{ line, col, len }].
function wordMatches(lines, first, last, word) {
  return wordOccurrences(lines.slice(first, last + 1), word).map(o => ({ line: o.start.line + first, col: o.start.col, len: word.length }));
}
// Exact (case-sensitive) matches of `text` on lines [first, last], not overlapping: [{ line, col, len }].
function textMatches(lines, first, last, text) {
  const out = [];
  if (!text) return out;
  for (let l = first; l <= Math.min(last, lines.length - 1); l++) {
    for (let i = lines[l].indexOf(text); i !== -1; i = lines[l].indexOf(text, i + text.length)) out.push({ line: l, col: i, len: text.length });
  }
  return out;
}

module.exports = { leadCols, guideLevels, activeGuide, indentGuides, matchBracket, enclosingBrackets, nextBracket, wordMatches, textMatches };
