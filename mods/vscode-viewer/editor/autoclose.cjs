// VS Code's auto-closing pairs as pure rules over a line and the cursor: editor.autoClosingBrackets/Quotes
// "languageDefined", autoClosingOvertype and autoClosingDelete "auto" (only closers the editor inserted), autoSurround.
const { tokenIndex, tokenTypeOf } = require("./highlight.cjs");

const BRACKETS = { "(": ")", "[": "]", "{": "}" };
// Quotes from the languages' configurations, simplified: " and ' everywhere but Rust (lifetimes), ` where it quotes.
const BACKTICK = ["source.js", "source.js.jsx", "source.ts", "source.tsx", "source.go", "source.shell", "source.kotlin", "text.html.markdown"];
const NO_SINGLE = ["source.rust"];
// A pair is inserted only before one of these or at the line end (VS Code's autoCloseBefore for language-defined pairs).
const CLOSE_BEFORE = ";:.,=}])> \t";
const WORD = /[\p{L}\p{N}_$]/u;
const isQuote = (ch) => ch === '"' || ch === "'" || ch === "`";

// { open: close } for a TextMate scope.
function pairsOf(scope) {
  const p = { ...BRACKETS, '"': '"' };
  if (!NO_SINGLE.includes(scope)) p["'"] = "'";
  if (BACKTICK.includes(scope)) p["`"] = "`";
  return p;
}

// True when the cursor at `col` is inside a string or comment by the line's tokens (null tokens: plain code). Right after a
// string's closing quote is outside it, right after a lone opening quote (the string's first token) inside.
function inStringOrComment(tokens, text, col) {
  if (!tokens || col === 0) return false;
  const k = tokenIndex(tokens, col - 1), type = tokenTypeOf(tokens[k + 1]), end = tokens[k + 2] ?? text.length;
  if (type === 1) return true;
  if (type !== 2) return false;
  const opening = end - tokens[k] === 1 && (k === 0 || tokenTypeOf(tokens[k - 1]) !== 2);
  return col < end || !isQuote(text[end - 1]) || opening;
}

// What typing `ch` does: "over" (steps over the auto-inserted closer at the cursor), "wrap" (surrounds the selection),
// "pair" (inserts ch and its closer, the cursor between), or null (a plain insert).
// ctx: { pairs, text: the cursor's line, col, selected: a selection exists, inText: in a string/comment, closer: the char
// at the cursor was auto-inserted }.
function onType(ch, { pairs, text, col, selected, inText, closer }) {
  if (selected) return pairs[ch] ? "wrap" : null;
  if (closer && text[col] === ch) return "over";
  if (!pairs[ch]) return null;
  const next = text[col];
  if (next !== undefined && !CLOSE_BEFORE.includes(next)) return null;
  if (isQuote(ch) && (inText || (col > 0 && WORD.test(text[col - 1])))) return null;
  return "pair";
}

// Backspace between an empty pair whose closer was auto-inserted deletes both.
const deletesPair = ({ pairs, text, col, closer }) => !!closer && col > 0 && pairs[text[col - 1]] === text[col];

module.exports = { pairsOf, inStringOrComment, onType, deletesPair };
