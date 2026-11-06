// Document symbols (Go to Symbol in Editor, breadcrumbs) as one flat list in document order:
// [{ name, kind, detail, depth, container, range: { start, end }, at: { line, col } }] (range: the whole declaration,
// at: where its name is). From LSP textDocument/documentSymbol, tsserver's navtree, or a regex outline of the text.

// LSP SymbolKind (1-based) -> VS Code's name for it.
const KINDS = [null, "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum",
  "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null",
  "enum member", "struct", "event", "operator", "type parameter"];

const byPosition = (a, b) => a.at.line - b.at.line || a.at.col - b.at.col;
const p = (x) => ({ line: x.line, col: x.character });

// DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat, with containerName) -> the list.
function fromLsp(result) {
  const out = [];
  const walk = (list, depth, container) => {
    for (const s of list ?? []) {
      if (!s?.name) continue;
      const range = s.range ?? s.location?.range, sel = s.selectionRange ?? range;
      if (!range) continue;
      out.push({ name: s.name, kind: KINDS[s.kind] ?? "symbol", detail: s.detail ?? "", depth, container: container ?? s.containerName ?? "",
        range: { start: p(range.start), end: p(range.end) }, at: p(sel.start) });
      walk(s.children, depth + 1, s.name);
    }
  };
  walk(Array.isArray(result) ? result : [], 0, null);
  return out.sort(byPosition);
}

// tsserver navtree -> the list, as VS Code's TypeScript extension shows it: the file's root item left out, as are
// aliases (imports) and unnamed <function>/<class> items; tsserver positions are 1-based line/offset.
function fromNavtree(tree) {
  const out = [];
  const pos = (x) => ({ line: x.line - 1, col: x.offset - 1 });
  const walk = (items, depth, container) => {
    for (const it of items ?? []) {
      const keep = it.kind !== "alias" && it.text && !/^<.*>$/.test(it.text) && it.spans?.length;
      if (keep) {
        const span = it.spans[0], name = it.nameSpan ?? span;
        out.push({ name: it.text, kind: it.kind, detail: "", depth, container: container ?? "",
          range: { start: pos(span.start), end: pos(span.end) }, at: pos(name.start) });
      }
      walk(it.childItems, keep ? depth + 1 : depth, keep ? it.text : container);
    }
  };
  walk(tree?.childItems, 0, null);
  return out.sort(byPosition);
}

// Declarations a regex can see in most languages: optional modifiers, a keyword, then the name.
const DECL = new RegExp(String.raw`^(\s*)(?:(?:export|default|public|private|protected|internal|static|async|abstract|final|override|open|pub(?:\([^)]*\))?|unsafe|extern|inline|virtual|sealed|partial|data|suspend)\s+)*` +
  String.raw`(class|struct|interface|trait|enum|impl|module|namespace|protocol|extension|object|type|function|func|fn|def|fun|sub|proc|macro_rules!)\s*\*?\s+` +
  String.raw`(?:\([^)]*\)\s*)?([\p{L}_$][\p{L}\p{N}_$]*(?:(?:\.|::)[\p{L}_$][\p{L}\p{N}_$]*)*)`, "u");
// `const name = (...) =>` / `const name = function` / `name: function`
const ARROW = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\p{L}_$][\p{L}\p{N}_$]*\s*=>)/u;
const KIND_OF = { class: "class", struct: "struct", interface: "interface", trait: "interface", enum: "enum", impl: "class", module: "module",
  namespace: "namespace", protocol: "interface", extension: "class", object: "object", type: "type" };

// A regex outline of functions, classes and the like. A declaration's range runs to the line before the next
// non-blank line indented no deeper than it (its closing brace there, if any, included); nesting follows the ranges.
function outline(lines) {
  const found = [];
  const indentOf = (t) => t.match(/^[\t ]*/)[0].replace(/\t/g, "    ").length;
  for (let line = 0; line < lines.length && found.length < 5000; line++) {
    const t = lines[line];
    if (t.length > 1000) continue;
    let m = DECL.exec(t), name, kind;
    if (m) { name = m[3]; kind = KIND_OF[m[2]] ?? "function"; }
    else if ((m = ARROW.exec(t))) { name = m[2]; kind = "function"; }
    else continue;
    const col = t.indexOf(name, m[1].length), indent = indentOf(t);
    let end = line;
    for (let l = line + 1; l < lines.length; l++) {
      if (!lines[l].trim()) continue;
      if (indentOf(lines[l]) <= indent) { if (/^\s*[}\])]/.test(lines[l]) || /^\s*end\b/.test(lines[l])) end = l; break; }
      end = l;
    }
    found.push({ name, kind, detail: "", depth: 0, container: "", range: { start: { line, col: 0 }, end: { line: end, col: lines[end].length } }, at: { line, col } });
  }
  const open = [];
  for (const s of found) {
    while (open.length && open.at(-1).range.end.line < s.at.line) open.pop();
    s.depth = open.length; s.container = open.at(-1)?.name ?? "";
    open.push(s);
  }
  return found;
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.col <= b.col);
// The symbols whose range holds pos, outermost first (the breadcrumbs' symbol part).
function symbolPath(items, pos) {
  const chain = [];
  for (const s of items) if (before(s.range.start, pos) && before(pos, s.range.end) && (!chain.length || s.depth > chain.at(-1).depth)) chain.push(s);
  return chain;
}

// Where VS Code's TypeScript reference CodeLens go (typescript.referencesCodeLens with showOnAllFunctions): named
// functions, classes, interfaces, types and enums, enum members, members of classes / interfaces / types (not one
// starting where its parent does), exported variables. [{ line, col }] at the names (0-based, UTF-16), from the navtree.
const LENS_MEMBERS = new Set(["method", "getter", "setter", "constructor", "property"]);
function lensesFromNavtree(tree) {
  const out = [], seen = new Set();
  const pos = (x) => ({ line: x.line - 1, col: x.offset - 1 });
  const same = (a, b) => a && b && a.line === b.line && a.offset === b.offset;
  const want = (it, parent) => {
    if (parent?.kind === "enum") return true;
    switch (it.kind) {
      case "function": return !!it.nameSpan;
      case "const": case "let": case "var": return /\bexport\b/.test(it.kindModifiers ?? "");
      case "class": return it.text !== "<class>";
      case "interface": case "type": case "enum": return true;
      default: return LENS_MEMBERS.has(it.kind) && ["class", "interface", "type"].includes(parent?.kind) && !same(parent.spans?.[0]?.start, it.spans?.[0]?.start);
    }
  };
  const walk = (it, parent) => {
    const start = it.nameSpan?.start ?? it.spans?.[0]?.start;
    if (start && want(it, parent)) {
      const p = pos(start), key = `${p.line}:${p.col}`;
      if (!seen.has(key)) { seen.add(key); out.push(p); }
    }
    for (const child of it.childItems ?? []) walk(child, it);
  };
  for (const it of tree?.childItems ?? []) walk(it, undefined);
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

module.exports = { KINDS, fromLsp, fromNavtree, outline, symbolPath, lensesFromNavtree };
