// Expand / Shrink Selection (VS Code's smart select): ranges { start, end } around a position from the word, the string,
// the brackets, the line and the whole text (VS Code's word and bracket providers, used with or without a language
// server), and the chain of ranges a selection walks through, each containing the one before.
const { cmp } = require("./buffer.cjs");
const D = require("./decorations.cjs");

const contains = (o, i) => cmp(o.start, i.start) <= 0 && cmp(i.end, o.end) <= 0;
const same = (a, b) => cmp(a.start, b.start) === 0 && cmp(a.end, b.end) === 0;
// Grows with nesting: a range containing another is never smaller.
const size = (r) => (r.end.line - r.start.line) * 1e9 + r.end.col - r.start.col;
const range = (sl, sc, el, ec) => ({ start: { line: sl, col: sc }, end: { line: el, col: ec } });

// `sel`, then each of `ranges` that contains the previous one and is larger, smallest first.
function chain(sel, ranges) {
  const out = [sel];
  for (const r of [...ranges].sort((a, b) => size(a) - size(b))) if (contains(r, out.at(-1)) && !same(r, out.at(-1))) out.push(r);
  return out;
}

const WORD = /[\p{L}\p{N}_$]/u;
// Candidate ranges around p without a language server. code(line, col): false inside strings and comments (their
// brackets don't count); string(line, col): the [from, to) columns of the string token at col, quotes included, or null.
function fallbackRanges(lines, p, code, string = () => null) {
  const out = [], t = lines[p.line];
  let s = p.col, e = p.col;
  while (s > 0 && WORD.test(t[s - 1])) s--;
  while (e < t.length && WORD.test(t[e])) e++;
  if (s < e) out.push(range(p.line, s, p.line, e));
  const str = string(p.line, p.col) ?? (p.col > 0 ? string(p.line, p.col - 1) : null);
  if (str && str[1] - str[0] >= 2) out.push(range(p.line, str[0] + 1, p.line, str[1] - 1), range(p.line, str[0], p.line, str[1]));
  let at = p;
  for (let depth = 0; depth < 100; depth++) { // each pair around the cursor: its contents, then with the brackets
    const pair = D.enclosingBrackets(lines, at, code);
    if (!pair) break;
    const [open, close] = pair;
    out.push(range(open.line, open.col + 1, close.line, close.col), range(open.line, open.col, close.line, close.col + 1));
    const lead = lines[open.line].search(/\S/);
    if (open.line !== close.line && lead < open.col) out.push(range(open.line, lead, close.line, close.col + 1)); // `if (x) {` … `}`
    at = open;
  }
  const lead = t.search(/\S|$/), trail = t.trimEnd().length;
  if (lead < trail) out.push(range(p.line, lead, p.line, trail));
  out.push(range(p.line, 0, p.line, t.length));
  const last = lines.length - 1;
  out.push(range(0, 0, last, lines[last].length));
  return out;
}

module.exports = { chain, fallbackRanges, contains, same };
