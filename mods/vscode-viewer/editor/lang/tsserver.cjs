// TypeScript/JavaScript through tsserver's own protocol, as VS Code does: requests are JSON lines on stdin,
// replies come back Content-Length framed. tsserver positions are 1-based line/offset (UTF-16).
const fs = require("fs");
const path = require("path");
const { Child } = require("./rpc.cjs");
const { which } = require("./proc.cjs");

// The project's typescript first (walking up to the root), then the one behind `tsserver` on PATH.
function findTsserver(file, root) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    const f = path.join(d, "node_modules/typescript/lib/tsserver.js");
    if (fs.existsSync(f)) return f;
    if (d === root || path.dirname(d) === d) break;
  }
  const bin = which("tsserver");
  if (!bin) return null;
  try {
    const real = fs.realpathSync(bin), lib = path.join(path.dirname(real), "..", "lib", "tsserver.js");
    return fs.existsSync(lib) ? lib : real;
  } catch { return null; }
}

const toPos = (p) => ({ line: p.line - 1, col: p.offset - 1 });
const loc = (file, span) => ({ file, ...toPos(span.start), end: toPos(span.end) });
const at = (ctx) => ({ file: ctx.file, line: ctx.line + 1, offset: ctx.col + 1 });
const range = (ctx) => ({ file: ctx.file, startLine: ctx.sel.start.line + 1, startOffset: ctx.sel.start.col + 1, endLine: ctx.sel.end.line + 1, endOffset: ctx.sel.end.col + 1 });
// FileCodeEdits[] -> workspace edit
function wsEdit(fileEdits) {
  const ws = {};
  for (const fe of fileEdits ?? []) (ws[fe.fileName] ??= []).push(...fe.textChanges.map(c => ({ start: toPos(c.start), end: toPos(c.end), text: c.newText })));
  return ws;
}
const EMPTY = /no content|could not find|cannot|not found/i;

class TsServer {
  static CAPS = ["definition", "typeDefinition", "implementation", "references", "rename", "format", "refactor", "source", "callHierarchy"];

  constructor(file, root) {
    const server = findTsserver(file, root);
    if (!server) throw new Error("tsserver not found");
    this.root = root; this.seq = 0; this.sent = new Map(); // file -> text tsserver has
    this.child = new Child(process.execPath, [server, "--disableAutomaticTypingAcquisition", "--locale", "en"], root, (m) => {
      if (m.type === "response") this.child.settle(m.request_seq, m.success ? null : new Error(m.message || m.command), m.body);
    });
  }
  can(op) { return TsServer.CAPS.includes(op); }
  get dead() { return this.child.dead; }
  send(command, args) { const seq = ++this.seq; this.child.write(JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n"); return seq; }
  request(command, args, timeout = 30000) { const seq = this.send(command, args); return this.child.wait(seq, timeout); }
  // An empty answer ("No content available") reads as no results.
  async list(command, args) {
    try { return (await this.request(command, args)) ?? []; } catch (e) { if (EMPTY.test(e.message)) return []; throw e; }
  }

  // Opens the file or replaces its whole text when it changed.
  sync(file, text) {
    const old = this.sent.get(file);
    if (old === text) return;
    if (old == null) this.send("open", { file, fileContent: text, projectRootPath: this.root });
    else {
      const lines = old.split("\n");
      this.send("change", { file, line: 1, offset: 1, endLine: lines.length, endOffset: lines[lines.length - 1].length + 1, insertString: text });
    }
    this.sent.set(file, text);
  }
  saved() {}

  async definition(ctx) { return (await this.list("definition", at(ctx))).map(d => loc(d.file, d)); }
  async typeDefinition(ctx) { return (await this.list("typeDefinition", at(ctx))).map(d => loc(d.file, d)); }
  async implementation(ctx) { return (await this.list("implementation", at(ctx))).map(d => loc(d.file, d)); }
  async references(ctx) {
    const body = await this.list("references", at(ctx));
    return (body.refs ?? []).map(r => ({ ...loc(r.file, r), preview: r.lineText }));
  }
  async rename(ctx, newName) {
    const body = await this.request("rename", { ...at(ctx), findInComments: false, findInStrings: false });
    if (!body?.info?.canRename) throw new Error(body?.info?.localizedErrorMessage ?? "You cannot rename this element.");
    const ws = {};
    for (const group of body.locs) (ws[group.file] ??= []).push(...group.locs.map(l => ({ start: toPos(l.start), end: toPos(l.end), text: (l.prefixText ?? "") + newName + (l.suffixText ?? "") })));
    return ws;
  }
  async format(ctx) {
    await this.request("configure", { file: ctx.file, formatOptions: { tabSize: ctx.tabSize, indentSize: ctx.tabSize, convertTabsToSpaces: ctx.insertSpaces } });
    const last = ctx.lines.length;
    const body = await this.list("format", { file: ctx.file, line: 1, offset: 1, endLine: last, endOffset: ctx.lines[last - 1].length + 1 });
    return body.map(c => ({ start: toPos(c.start), end: toPos(c.end), text: c.newText }));
  }
  async refactors(ctx) {
    const args = range(ctx), out = [];
    for (const r of await this.list("getApplicableRefactors", args)) {
      for (const a of r.actions ?? []) {
        if (a.notApplicableReason) continue;
        out.push({ title: a.description, resolve: async () => wsEdit((await this.request("getEditsForRefactor", { ...args, refactor: r.name, action: a.name }))?.edits) });
      }
    }
    return out;
  }
  async sourceActions(ctx) {
    const out = [{ title: "Organize Imports", resolve: async () => wsEdit(await this.request("organizeImports", { scope: { type: "file", args: { file: ctx.file } } })) }];
    const diags = [...await this.list("syntacticDiagnosticsSync", { file: ctx.file }), ...await this.list("semanticDiagnosticsSync", { file: ctx.file })];
    const seen = new Set();
    for (const d of diags.slice(0, 20)) {
      const fixes = await this.list("getCodeFixes", { file: ctx.file, startLine: d.start.line, startOffset: d.start.offset, endLine: d.end.line, endOffset: d.end.offset, errorCodes: [d.code] });
      for (const f of fixes) if (!seen.has(f.description)) { seen.add(f.description); out.push({ title: f.description, resolve: async () => wsEdit(f.changes) }); }
    }
    return out;
  }
  // dir "incoming" | "outgoing": [{ name, detail, file, line, col }]
  async calls(ctx, dir) {
    let items = await this.list("prepareCallHierarchy", at(ctx));
    items = Array.isArray(items) ? items : [items];
    const out = [];
    for (const it of items) {
      const args = { file: it.file, line: it.selectionSpan.start.line, offset: it.selectionSpan.start.offset };
      if (dir === "incoming") {
        for (const c of await this.list("provideCallHierarchyIncomingCalls", args))
          for (const s of c.fromSpans) out.push({ ...loc(c.from.file, s), name: c.from.name, detail: c.from.containerName ?? "" });
      } else {
        for (const c of await this.list("provideCallHierarchyOutgoingCalls", args))
          out.push({ ...loc(c.to.file, c.to.selectionSpan), name: c.to.name, detail: c.to.containerName ?? "" });
      }
    }
    return out;
  }
  dispose() { this.send("exit", {}); this.child.kill(); }
  kill() { this.child.kill(); }
}

module.exports = { TsServer, findTsserver };
