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
const vscodeServer = (name, main) => () => [process.execPath, [path.join(DEVIN, `${name}-language-features/server/dist/node/${main}`), "--stdio"]];
const bin = (name, dirs = []) => () => { const b = which(name, dirs); return b && [b, []]; };
const byExt = (map, dflt) => (file) => map[path.extname(file).slice(1).toLowerCase()] ?? dflt;

// scope -> server kind; kind -> { command() => [cmd, args] | null, languageId(file), init }
const SCOPES = {
  "source.ts": "ts", "source.tsx": "ts", "source.js": "ts", "source.js.jsx": "ts",
  "source.rust": "rust",
  "source.c": "clangd", "source.cpp": "clangd", "source.objc": "clangd", "source.objcpp": "clangd", "source.cuda-cpp": "clangd",
  "source.swift": "swift",
  "source.json": "json", "source.json.comments": "json",
  "source.css": "css", "source.css.scss": "css", "source.css.less": "css",
  "text.html.basic": "html", "text.html.derivative": "html",
};
const SERVERS = {
  rust: { command: bin("rust-analyzer", [path.join(os.homedir(), ".cargo/bin")]), languageId: () => "rust" },
  clangd: { command: bin("clangd", ["/usr/bin"]), languageId: byExt({ c: "c", h: "c", m: "objective-c", mm: "objective-cpp", cu: "cuda-cpp" }, "cpp") },
  swift: { command: bin("sourcekit-lsp", ["/usr/bin"]), languageId: () => "swift" },
  json: { command: vscodeServer("json", "jsonServerMain.js"), languageId: byExt({ jsonc: "jsonc" }, "json"), init: { provideFormatter: true } },
  css: { command: vscodeServer("css", "cssServerMain.js"), languageId: byExt({ scss: "scss", less: "less" }, "css"), init: { provideFormatter: true } },
  html: { command: vscodeServer("html", "htmlServerMain.js"), languageId: () => "html", init: { provideFormatter: true, embeddedLanguages: { css: true, javascript: true } } },
};

const pool = new Map(); // "kind:root" -> server | Error
let applyEdit = () => false; // where workspace/applyEdit from a server goes (set by the editor)
const setApplyEdit = (fn) => { applyEdit = fn; };

function startServer(kind, file, root) {
  const key = `${kind}:${root}`;
  let s = pool.get(key);
  if (s && !(s instanceof Error) && s.dead) s = null; // crashed: start again
  if (!s) {
    try {
      if (kind === "ts") s = new TsServer(file, root);
      else {
        const spec = SERVERS[kind], cmd = spec.command();
        if (!cmd || !fs.existsSync(cmd[1][0] ?? cmd[0])) throw new Error(`${kind} language server not found`);
        s = new Lsp({ cmd: cmd[0], args: cmd[1], languageId: spec.languageId, init: spec.init }, root);
        s.applyEdit = (ws) => applyEdit(ws);
      }
    } catch (e) { s = e; }
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
  saved(file) { const s = this.kind && pool.get(`${this.kind}:${this.root}`); if (s && !(s instanceof Error)) s.saved(file); }
}

// Kills every server (called on exit; must be synchronous).
function shutdown() { for (const s of pool.values()) if (s && !(s instanceof Error)) { try { s.dispose(); s.kill(); } catch {} } pool.clear(); }

module.exports = { Session, shutdown, setApplyEdit, SCOPES };
