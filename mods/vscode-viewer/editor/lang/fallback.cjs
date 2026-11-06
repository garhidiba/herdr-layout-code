// Without a language server: definitions and references by searching the project for the word, formatting with
// the language's own formatter (gofmt, rustfmt, prettier).
const fs = require("fs");
const path = require("path");
const { which, runAsync } = require("./proc.cjs");
const { outline } = require("../symbols.cjs");

const KEYWORDS = "func|def|class|fn|const|let|var|type|interface|struct|enum|trait|impl|fun|val|object|typealias|protocol|extension|module|function|static|macro_rules!";
const MAX = 500;

// grep -E pattern for a definition of `word` (`func (r *T) word`, `def word`, `class word`...); -w adds the word boundaries.
const definitionPattern = (word) => `(${KEYWORDS})[[:space:]]+(\\([^)]*\\)[[:space:]]*)?\\*?${word}`;

// `file:line:text` lines -> [{ file, line, col, preview }] (col: the word's first whole-word match).
function parseGrep(out, root, word) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${word.replace(/[$]/g, "\\$")}(?![\\p{L}\\p{N}_$])`, "u");
  const found = [];
  for (const line of out.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const col = m[3].search(re);
    found.push({ file: path.resolve(root, m[1]), line: Number(m[2]) - 1, col: Math.max(0, col), preview: m[3] });
    if (found.length >= MAX) break;
  }
  return found;
}

// Whole-word search under the root (git grep in a repo, else grep -r), `extended` for a regex.
async function search(root, pattern, extended) {
  const git = fs.existsSync(path.join(root, ".git"));
  const r = git
    ? await runAsync("git", ["grep", "-nIw", extended ? "-E" : "-F", "-e", pattern, "--", "."], { cwd: root })
    : await runAsync("grep", ["-rnIw", extended ? "-E" : "-F", "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", pattern, "."], { cwd: root });
  return r.stdout.replace(/^\.\//gm, "");
}

// Whole-word occurrences of `word` in lines, as edits replacing it with `text`.
function wordOccurrences(lines, word, text = word) {
  if (!word) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${word.replace(/[$]/g, "\\$")}(?![\\p{L}\\p{N}_$])`, "gu"), out = [];
  lines.forEach((l, line) => { for (const m of l.matchAll(re)) out.push({ start: { line, col: m.index }, end: { line, col: m.index + word.length }, text }); });
  return out;
}

const PRETTIER = /\.(m?[jt]sx?|c[jt]s|css|scss|less|json|jsonc|html?|vue|ya?ml|md|markdown|graphql)$/i;

// The formatter command for a file: [cmd, args] reading stdin and writing stdout, or null.
function formatterFor(file, scope, root) {
  if (scope === "source.go") { const g = which("gofmt"); return g && [g, []]; }
  if (scope === "source.rust") { const r = which("rustfmt"); return r && [r, ["--emit", "stdout", "--edition", "2021"]]; }
  if (PRETTIER.test(file)) {
    const p = which("prettier", [path.join(root, "node_modules/.bin"), path.join(path.dirname(file), "node_modules/.bin")]);
    return p && [p, ["--stdin-filepath", file]];
  }
  return null;
}

class Fallback {
  label = "regex outline";
  constructor(file, scope, root) { this.root = root; this.scope = scope; this.formatter = formatterFor(file, scope, root); }
  can(op) { return op === "definition" || op === "references" || op === "rename" || op === "symbols" || (op === "format" && !!this.formatter); }
  sync() {} saved() {}
  async definition(ctx) {
    if (!ctx.word) return [];
    const all = parseGrep(await search(this.root, definitionPattern(ctx.word), true), this.root, ctx.word);
    return all.sort((a, b) => (b.file === ctx.file) - (a.file === ctx.file));
  }
  async symbols(ctx) { return outline(ctx.lines); }
  async references(ctx) { return ctx.word ? parseGrep(await search(this.root, ctx.word, false), this.root, ctx.word) : []; }
  async format(ctx) {
    if (!this.formatter) throw new Error(`There is no formatter for '${ctx.language}' files installed.`);
    const [cmd, args] = this.formatter, text = ctx.lines.join("\n") + "\n";
    const r = await runAsync(cmd, args, { cwd: path.dirname(ctx.file), input: text });
    if (r.code !== 0) throw new Error(`${path.basename(cmd)}: ${(r.stderr.trim().split("\n")[0] || "failed")}`);
    const lines = r.stdout.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
    return [{ start: { line: 0, col: 0 }, end: { line: ctx.lines.length - 1, col: ctx.lines[ctx.lines.length - 1].length }, text: lines.join("\n") }];
  }
  dispose() {} kill() {}
}

module.exports = { Fallback, definitionPattern, parseGrep, wordOccurrences, formatterFor };
