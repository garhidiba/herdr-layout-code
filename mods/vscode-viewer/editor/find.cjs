// Find rules of VS Code's find widget: the matches of a query on each line with Match Case, Match Whole Word and Use
// Regular Expression, and a match's replacement (with a regex: $1, $&, $<name>, \n and \t, as VS Code).
// opts: { caseSensitive, wholeWord, regex } (all false by default). Matches never span lines; empty matches are skipped.
// Also how the widget opens: the search the selection seeds and Find in Selection's scope.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// The search as a global RegExp, null for an empty query, or { error } when the regular expression is invalid.
function searchRegex(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (!query) return null;
  const src = regex ? query : escape(query), flags = "g" + (caseSensitive ? "" : "i");
  // Unicode mode first (so whole word knows letters beyond ASCII); a regex only valid without it gets ASCII words.
  const attempt = (u) => {
    const w = u ? "[\\p{L}\\p{N}_$]" : "[A-Za-z0-9_$]";
    return new RegExp(wholeWord ? `(?<!${w})(?:${src})(?!${w})` : src, flags + (u ? "u" : ""));
  };
  try { return attempt(true); } catch (e) {
    if (!regex) return { error: e.message };
    try { return attempt(false); } catch (e2) { return { error: e2.message }; }
  }
}

// { matches: [{ line, col, len }] (at most `limit`), error: null | message }.
function findMatches(lines, query, opts = {}, limit = 20000) {
  const re = searchRegex(query, opts), matches = [];
  if (!re || re.error) return { matches, error: re?.error ?? null };
  for (let line = 0; line < lines.length && matches.length < limit; line++) {
    const t = lines[line];
    re.lastIndex = 0;
    for (let m; matches.length < limit && (m = re.exec(t));) {
      if (!m[0].length) { re.lastIndex = m.index + (t.codePointAt(m.index) > 0xffff ? 2 : 1); if (re.lastIndex > t.length) break; continue; }
      matches.push({ line, col: m.index, len: m[0].length });
    }
  }
  return { matches, error: null };
}

// The text that replaces match m on `line`: the replace string as is, or with a regex its groups substituted
// (evaluated in place on the line, so anchors and lookarounds see the same context as the search).
function replacementOf(line, m, query, opts, replace) {
  if (!opts?.regex) return replace;
  const re = searchRegex(query, opts);
  if (!re || re.error) return replace;
  const sticky = new RegExp(re.source, re.flags.replace("g", "") + "y");
  sticky.lastIndex = m.col;
  const template = replace.replace(/\\([nt\\])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"));
  const out = line.replace(sticky, template);
  return out.slice(m.col, out.length - (line.length - m.col - m.len));
}

// Find in Selection: the matches lying wholly inside scope ({ start, end }; null keeps them all).
function inScope(matches, scope) {
  if (!scope) return matches;
  const { start: s, end: e } = scope;
  return matches.filter(m => (m.line > s.line || (m.line === s.line && m.col >= s.col)) && (m.line < e.line || (m.line === e.line && m.col + m.len <= e.col)));
}

// The search a selection seeds the find widget with (VS Code's getSelectionSearchString): a one-line selection, else
// (empty, with mode "always") the word at the cursor; a multi-line selection seeds nothing. mode: the
// editor.find.seedSearchStringFromSelection setting; word() gives the word at the cursor.
function seedOf(mode, { empty, oneLine, text, word }) {
  if (mode === "never" || !oneLine) return null;
  if (!empty) return text;
  return mode === "always" ? word() : null;
}

module.exports = { searchRegex, findMatches, replacementOf, inScope, seedOf, escape };
