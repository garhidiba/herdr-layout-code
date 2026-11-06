// File name -> TextMate scope (same lookup as vscode/tokenize.cjs), plus VS Code's language name and comment tokens.

// Exact file name, then name prefix (Dockerfile.dev), then the longest extension (a.d.ts before ts).
function scopeOf(index, name) {
  const n = name.toLowerCase();
  if (index.files[n]) return index.files[n];
  for (const [prefix, scope] of Object.entries(index.prefixes)) if (n.startsWith(prefix)) return scope;
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) { const s = index.ext[parts.slice(i).join(".")]; if (s) return s; }
  return null;
}

// Status-bar names as VS Code shows them.
const NAMES = {
  "source.asp.vb.net": "Visual Basic", "source.batchfile": "Batch", "source.c": "C", "source.clojure": "Clojure",
  "source.coffee": "CoffeeScript", "source.cpp": "C++", "source.cs": "C#", "source.css": "CSS", "source.css.less": "Less",
  "source.css.scss": "SCSS", "source.cuda-cpp": "CUDA C++", "source.dart": "Dart", "source.diff": "Diff",
  "source.dockerfile": "Dockerfile", "source.dotenv": "Dotenv", "source.fsharp": "F#", "source.go": "Go",
  "source.groovy": "Groovy", "source.hlsl": "HLSL", "source.ignore": "Ignore", "source.ini": "Ini", "source.java": "Java",
  "source.js": "JavaScript", "source.js.jsx": "JavaScript JSX", "source.json": "JSON", "source.json.comments": "JSON with Comments",
  "source.json.lines": "JSON Lines", "source.julia": "Julia", "source.kotlin": "Kotlin", "source.lua": "Lua",
  "source.makefile": "Makefile", "source.objc": "Objective-C", "source.objcpp": "Objective-C++", "source.perl": "Perl",
  "source.perl.6": "Raku", "source.php": "PHP", "source.powershell": "PowerShell", "source.python": "Python", "source.r": "R",
  "source.rst": "reStructuredText", "source.ruby": "Ruby", "source.rust": "Rust", "source.shaderlab": "ShaderLab",
  "source.shell": "Shell Script", "source.sql": "SQL", "source.swift": "Swift", "source.toml": "TOML", "source.ts": "TypeScript",
  "source.tsx": "TypeScript JSX", "source.yaml": "YAML", "text.bibtex": "BibTeX", "text.csv": "CSV", "text.git-commit": "Git Commit Message",
  "text.git-rebase": "Git Rebase Message", "text.gitignore": "Ignore", "text.html.cshtml": "Razor", "text.html.derivative": "HTML",
  "text.html.basic": "HTML", "text.html.handlebars": "Handlebars", "text.html.markdown": "Markdown", "text.log": "Log",
  "text.pug": "Pug", "text.tex": "TeX", "text.tex.latex": "LaTeX", "text.tsv": "TSV", "text.wat": "WebAssembly Text",
  "text.xml": "XML", "text.xml.xsl": "XSL",
};

// "source.foo-bar" -> "Foo Bar" for scopes without a table entry.
function languageName(scope) {
  if (!scope) return "Plain Text";
  if (NAMES[scope]) return NAMES[scope];
  const last = scope.replace(/^(source|text)\./, "").split(".")[0];
  return last.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const LINE = {
  "//": ["source.js", "source.js.jsx", "source.ts", "source.tsx", "source.go", "source.c", "source.cpp", "source.cuda-cpp", "source.cs",
    "source.java", "source.rust", "source.swift", "source.dart", "source.kotlin", "source.css.scss", "source.css.less", "source.php",
    "source.groovy", "source.fsharp", "source.json.comments", "source.objc", "source.objcpp", "source.hlsl", "source.shaderlab"],
  "#": ["source.python", "source.shell", "source.ruby", "source.perl", "source.perl.6", "source.r", "source.yaml", "source.toml",
    "source.dockerfile", "source.makefile", "source.powershell", "source.coffee", "source.julia", "source.dotenv", "source.ignore",
    "text.gitignore", "text.git-commit", "text.git-rebase"],
  "--": ["source.lua", "source.sql"],
  ";": ["source.clojure", "source.ini"],
  "%": ["text.tex", "text.tex.latex", "text.bibtex"],
  "@REM": ["source.batchfile"],
  "'": ["source.asp.vb.net"],
};
const BLOCK = {
  "source.css": ["/*", "*/"], "text.html.basic": ["<!--", "-->"], "text.html.derivative": ["<!--", "-->"], "text.xml": ["<!--", "-->"],
  "text.xml.xsl": ["<!--", "-->"], "text.html.markdown": ["<!--", "-->"], "text.html.handlebars": ["{{!--", "--}}"], "text.pug": ["//-", null],
};

// { line: "//" } or { block: ["/*", "*/"] }, or null when the language has no comments we know.
function commentOf(scope) {
  for (const [token, scopes] of Object.entries(LINE)) if (scopes.includes(scope)) return { line: token };
  const b = BLOCK[scope];
  if (b) return b[1] ? { block: b } : { line: b[0] };
  return null;
}

// Block comment pairs of the languages that have both line and block comments (VS Code's language-configuration.json
// blockComment); the BLOCK languages use their own pair.
const BLOCK_PAIRS = [
  [["/*", "*/"], ["source.js", "source.js.jsx", "source.ts", "source.tsx", "source.go", "source.c", "source.cpp", "source.cuda-cpp", "source.cs",
    "source.java", "source.rust", "source.swift", "source.dart", "source.kotlin", "source.css.scss", "source.css.less", "source.php",
    "source.groovy", "source.json", "source.json.comments", "source.objc", "source.objcpp", "source.hlsl", "source.shaderlab", "source.sql"]],
  [["(*", "*)"], ["source.fsharp"]],
  [['"""', '"""'], ["source.python"]],
  [["=begin", "=end"], ["source.ruby"]],
  [["--[[", "]]"], ["source.lua"]],
  [["###", "###"], ["source.coffee"]],
  [["<#", "#>"], ["source.powershell"]],
  [["#=", "=#"], ["source.julia"]],
];

// [open, close] for Toggle Block Comment, or null when the language has none.
function blockCommentOf(scope) {
  if (BLOCK[scope]) return BLOCK[scope][1] ? BLOCK[scope] : null;
  return BLOCK_PAIRS.find(([, scopes]) => scopes.includes(scope))?.[0] ?? null;
}

module.exports = { scopeOf, languageName, commentOf, blockCommentOf };
