// Which language intelligence serves a file: tsserver, an LSP server, or the search/formatter fallback.
// Servers start lazily on first use, one per (server, git root), and are shut down on exit.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { which, gitRoot } = require("./proc.cjs");
const { TsServer } = require("./tsserver.cjs");
const { Lsp } = require("./lsp.cjs");
const { Fallback } = require("./fallback.cjs");

const DEVIN = "/Applications/Devin.app/Contents/Resources/app/extensions";
const bin = (name, args = [], dirs = []) => () => { const b = which(name, dirs); return b && [b, args]; };
const first = (...cmds) => () => cmds.reduce((found, c) => found ?? c(), null);
// VS Code's own JSON/CSS/HTML servers: Devin.app's copies, else vscode-langservers-extracted's.
const vscodeServer = (name, main) => first(() => { const f = path.join(DEVIN, `${name}-language-features/server/dist/node/${main}`); return fs.existsSync(f) ? [process.execPath, [f, "--stdio"]] : null; },
  bin(`vscode-${name}-language-server`, ["--stdio"]));
const byExt = (map, dflt) => (file) => map[path.extname(file).slice(1).toLowerCase()] ?? dflt;
const GO_BIN = path.join(os.homedir(), "go/bin"); // where `go install` puts gopls
const LANGSERVERS = [["npm", "npm i -g vscode-langservers-extracted"]];

// scope -> server kind; kind -> { label, command() => [cmd, args] | null, languageId(file), init?, install? }
// install: [tool, command] pairs, the first whose tool is on this machine's PATH is offered when the server is missing.
const SCOPES = {
  "source.ts": "ts", "source.tsx": "ts", "source.js": "ts", "source.js.jsx": "ts",
  "source.rust": "rust",
  "source.c": "clangd", "source.cpp": "clangd", "source.objc": "clangd", "source.objcpp": "clangd", "source.cuda-cpp": "clangd",
  "source.swift": "swift",
  "source.json": "json", "source.json.comments": "json",
  "source.css": "css", "source.css.scss": "css", "source.css.less": "css",
  "text.html.basic": "html", "text.html.derivative": "html",
  "source.yaml": "yaml", "source.toml": "toml", "source.python": "python", "source.shell": "shell", "source.go": "go",
  "source.dockerfile": "dockerfile", "text.html.markdown": "markdown",
};
const SERVERS = {
  rust: { label: "rust-analyzer", command: bin("rust-analyzer", [], [path.join(os.homedir(), ".cargo/bin")]), languageId: () => "rust",
    install: [["rustup", "rustup component add rust-analyzer"], ["brew", "brew install rust-analyzer"]] },
  clangd: { label: "clangd", command: bin("clangd", [], ["/usr/bin"]), languageId: byExt({ c: "c", h: "c", m: "objective-c", mm: "objective-cpp", cu: "cuda-cpp" }, "cpp") },
  swift: { label: "sourcekit-lsp", command: bin("sourcekit-lsp", [], ["/usr/bin"]), languageId: () => "swift" },
  json: { label: "JSON language server", command: vscodeServer("json", "jsonServerMain.js"), languageId: byExt({ jsonc: "jsonc" }, "json"), init: { provideFormatter: true }, install: LANGSERVERS },
  css: { label: "CSS language server", command: vscodeServer("css", "cssServerMain.js"), languageId: byExt({ scss: "scss", less: "less" }, "css"), init: { provideFormatter: true }, install: LANGSERVERS },
  html: { label: "HTML language server", command: vscodeServer("html", "htmlServerMain.js"), languageId: () => "html", init: { provideFormatter: true, embeddedLanguages: { css: true, javascript: true } }, install: LANGSERVERS },
  yaml: { label: "YAML language server", command: bin("yaml-language-server", ["--stdio"]), languageId: () => "yaml",
    install: [["npm", "npm i -g yaml-language-server"], ["brew", "brew install yaml-language-server"]] },
  toml: { label: "Taplo", command: bin("taplo", ["lsp", "stdio"]), languageId: () => "toml",
    install: [["brew", "brew install taplo"], ["cargo", "cargo install taplo-cli --locked --features lsp"]] },
  python: { label: "Python language server", command: first(bin("basedpyright-langserver", ["--stdio"]), bin("pyright-langserver", ["--stdio"])), languageId: () => "python",
    install: [["pipx", "pipx install basedpyright"], ["npm", "npm i -g basedpyright"], ["brew", "brew install basedpyright"]] },
  shell: { label: "Bash language server", command: bin("bash-language-server", ["start"]), languageId: () => "shellscript",
    install: [["npm", "npm i -g bash-language-server"], ["brew", "brew install bash-language-server"]] },
  go: { label: "gopls", command: bin("gopls", [], [GO_BIN]), languageId: () => "go",
    install: [["go", "go install golang.org/x/tools/gopls@latest"], ["brew", "brew install gopls"]] },
  dockerfile: { label: "Dockerfile language server", command: bin("docker-langserver", ["--stdio"]), languageId: () => "dockerfile",
    install: [["npm", "npm i -g dockerfile-language-server-nodejs"]] },
  markdown: { label: "Marksman", command: bin("marksman", ["server"]), languageId: () => "markdown", install: [["brew", "brew install marksman"]] },
};

// The missing server of `kind` and how to install it here: { kind, label, command } when it has an installer whose
// tool this machine has (`has`, on the editor's PATH: a remote editor names its own machine's tools), else null.
function installHint(kind, has = (tool) => which(tool)) {
  const spec = SERVERS[kind];
  if (!spec?.install || spec.command()) return null;
  const found = spec.install.find(([tool]) => has(tool));
  return found ? { kind, label: spec.label, command: found[1] } : null;
}
// True when `kind`'s server can be started (its program is found).
const found = (kind) => !!SERVERS[kind]?.command();
// Forgets that `kind`'s server was missing, so the next use looks for it again (after an install).
function retry(kind) { for (const [k, s] of pool) if (s instanceof Error && k.startsWith(`${kind}:`)) pool.delete(k); }

const pool = new Map(); // "kind:root" -> server | Error
let applyEdit = () => false; // where workspace/applyEdit from a server goes (set by the editor)
const setApplyEdit = (fn) => { applyEdit = fn; };
let onDiagnostics = () => {}; // told the file whose diagnostics a server changed (set by the editor)
const setOnDiagnostics = (fn) => { onDiagnostics = fn; };

function startServer(kind, file, root) {
  const key = `${kind}:${root}`;
  let s = pool.get(key);
  if (s && !(s instanceof Error) && s.dead) s = null; // crashed: start again
  if (!s) {
    try {
      if (kind === "ts") s = new TsServer(file, root);
      else {
        const spec = SERVERS[kind], cmd = spec.command();
        if (!cmd) throw new Error(`${kind} language server not found`);
        s = new Lsp({ cmd: cmd[0], args: cmd[1], languageId: spec.languageId, init: spec.init, label: spec.label }, root);
        s.applyEdit = (ws) => applyEdit(ws);
      }
    } catch (e) { s = e; }
    if (!(s instanceof Error)) s.onDiagnostics = (f) => onDiagnostics(f);
    pool.set(key, s);
  }
  return s instanceof Error ? null : s;
}

// Per file: picks the server for each operation, falling back when there is none or it lacks the operation.
class Session {
  constructor(file, scope) {
    this.file = file; this.scope = scope; this.kind = SCOPES[scope] ?? null; this.root = gitRoot(file);
    this.fallback = new Fallback(file, scope, this.root);
    this.server = null;
  }
  // Without starting anything: does some provider offer `op`?
  can(op) {
    const s = this.kind && pool.get(`${this.kind}:${this.root}`);
    if (s instanceof Error || !this.kind) return this.fallback.can(op);
    if (s && !s.dead) return s.can(op) || this.fallback.can(op);
    return this.kind === "ts" ? TsServer.CAPS.includes(op) || this.fallback.can(op) : true;
  }
  // The provider for `op`, starting the server on first use.
  provider(op) {
    const s = this.kind ? startServer(this.kind, this.file, this.root) : null;
    if (s && s.can(op)) return s;
    if (this.fallback.can(op)) return this.fallback;
    return null;
  }
  // Runs provider[method](ctx, ...rest) after syncing the text.
  async run(op, method, ctx, ...rest) {
    const p = this.provider(op);
    if (!p) throw new Error(`No ${op} provider for ${ctx.language}.`);
    await p.sync(ctx.file, ctx.lines.join("\n"));
    return p[method](ctx, ...rest);
  }
  // Tells a running server about a file's new text (after edits written outside it); text null = read it from disk.
  touch(file, text) {
    const s = this.kind && pool.get(`${this.kind}:${this.root}`);
    if (!s || s instanceof Error || s.dead) return;
    try { s.sync(file, text ?? fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\n$/, ""))?.catch?.(() => {}); } catch {}
  }
  // Go to Symbol / breadcrumbs: { source (the provider's label), items } from the server when it has them, else (or when
  // it fails) the regex outline.
  // The server (started here) also gets the current text, which keeps its diagnostics current.
  async symbols(ctx) {
    const s = this.kind ? startServer(this.kind, this.file, this.root) : null;
    if (s) {
      try { await s.sync(ctx.file, ctx.lines.join("\n")); if (s.can("symbols")) return { source: s.label, items: await s.symbols(ctx) }; } catch {}
    }
    return { source: this.fallback.label, items: await this.fallback.symbols(ctx) };
  }
  // What the running server last reported for this file (nothing without one).
  diagnostics() {
    const s = this.kind && pool.get(`${this.kind}:${this.root}`);
    return (s && !(s instanceof Error) && s.diags?.get(this.file)) || [];
  }
  // How to install this file's missing server (installHint), else null.
  installHint() { return this.kind ? installHint(this.kind) : null; }
  saved(file) { const s = this.kind && pool.get(`${this.kind}:${this.root}`); if (s && !(s instanceof Error)) s.saved(file); }
}

// Kills every server (called on exit; must be synchronous).
function shutdown() { for (const s of pool.values()) if (s && !(s instanceof Error)) { try { s.dispose(); s.kill(); } catch {} } pool.clear(); }

module.exports = { Session, shutdown, setApplyEdit, setOnDiagnostics, SCOPES, SERVERS, installHint, retry, found };
