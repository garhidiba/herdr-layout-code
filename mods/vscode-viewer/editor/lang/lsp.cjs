// A Language Server Protocol client over stdio (Content-Length framing), full-text sync.
const { pathToFileURL, fileURLToPath } = require("url");
const { Child, frame } = require("./rpc.cjs");
const { fromLsp } = require("../symbols.cjs");

const uri = (file) => pathToFileURL(file).href;
const fileOf = (u) => { try { return fileURLToPath(u); } catch { return null; } };
const pos = (p) => ({ line: p.line, col: p.character });
const lspPos = (p) => ({ line: p.line, character: p.col });
const edits = (list) => (list ?? []).map(e => ({ start: pos(e.range.start), end: pos(e.range.end), text: e.newText }));

// Location | Location[] | LocationLink[] -> [{ file, line, col, end }]
function locations(result) {
  return [].concat(result ?? []).map(l => {
    const u = l.targetUri ?? l.uri, r = l.targetSelectionRange ?? l.range;
    const file = fileOf(u);
    return file && r ? { file, ...pos(r.start), end: pos(r.end) } : null;
  }).filter(Boolean);
}

// WorkspaceEdit -> { file: edits } (create/rename/delete file operations are not supported and skipped).
function workspaceEdit(we) {
  const ws = {};
  for (const [u, list] of Object.entries(we?.changes ?? {})) { const f = fileOf(u); if (f) (ws[f] ??= []).push(...edits(list)); }
  for (const dc of we?.documentChanges ?? []) {
    if (!dc.textDocument) continue;
    const f = fileOf(dc.textDocument.uri);
    if (f) (ws[f] ??= []).push(...edits(dc.edits));
  }
  return ws;
}

// publishDiagnostics params -> [{ start, end, severity (1 error, 2 warning, 3 information, 4 hint), message, source, raw }]
// (raw: the server's own diagnostic, given back with code action requests)
function diagnosticsOf(params) {
  return (params?.diagnostics ?? []).filter(d => d?.range && d.message).map(d => ({ start: pos(d.range.start), end: pos(d.range.end),
    severity: d.severity >= 1 && d.severity <= 4 ? d.severity : 1, message: String(d.message), source: d.source ? `${d.source}${d.code != null ? `(${d.code})` : ""}` : "", raw: d }));
}

const OPS = { definition: "definitionProvider", typeDefinition: "typeDefinitionProvider", implementation: "implementationProvider",
  references: "referencesProvider", rename: "renameProvider", format: "documentFormattingProvider", refactor: "codeActionProvider",
  source: "codeActionProvider", callHierarchy: "callHierarchyProvider", symbols: "documentSymbolProvider", quickFix: "codeActionProvider",
  selectionRange: "selectionRangeProvider", formatRange: "documentRangeFormattingProvider" };
const METHOD_OP = { "textDocument/definition": "definition", "textDocument/typeDefinition": "typeDefinition", "textDocument/implementation": "implementation",
  "textDocument/references": "references", "textDocument/rename": "rename", "textDocument/formatting": "format", "textDocument/codeAction": "refactor",
  "textDocument/prepareCallHierarchy": "callHierarchy", "textDocument/documentSymbol": "symbols",
  "textDocument/selectionRange": "selectionRange", "textDocument/rangeFormatting": "formatRange" };

const CLIENT_CAPS = {
  general: { positionEncodings: ["utf-16"] },
  workspace: { applyEdit: true, workspaceEdit: { documentChanges: true }, configuration: true, workspaceFolders: true },
  textDocument: {
    synchronization: { didSave: true }, definition: { linkSupport: true }, typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true }, references: {}, rename: { prepareSupport: false }, formatting: {}, rangeFormatting: {}, callHierarchy: {},
    selectionRange: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } },
      resolveSupport: { properties: ["edit"] }, dataSupport: true },
    publishDiagnostics: {},
  },
};

class Lsp {
  // spec: { cmd, args, languageId(file), init? (initializationOptions), label? (its name for messages) }
  constructor(spec, root) {
    this.spec = spec; this.label = spec.label ?? spec.cmd.split("/").pop(); this.root = root; this.id = 0; this.docs = new Map(); // file -> { version, text }
    this.caps = null; this.applyEdit = () => false;
    this.diags = new Map(); this.onDiagnostics = () => {}; // file -> diagnostics, as the server last published them
    this.child = new Child(spec.cmd, spec.args, root, (m) => this.onMessage(m));
    this.ready = this.request("initialize", {
      processId: process.pid, rootUri: uri(root), rootPath: root, workspaceFolders: [{ uri: uri(root), name: root.split("/").pop() }],
      capabilities: CLIENT_CAPS, initializationOptions: spec.init ?? {},
    }, 60000).then(r => { this.caps = r?.capabilities ?? {}; this.notify("initialized", {}); });
    this.ready.catch(() => {});
  }
  get dead() { return this.child.dead; }
  // Until the server answers initialize, every operation is assumed available.
  can(op) {
    if (!this.caps) return true;
    const c = this.caps[OPS[op]];
    return !!c;
  }
  notify(method, params) { this.child.write(frame({ jsonrpc: "2.0", method, params })); }
  request(method, params, timeout = 30000) { const id = ++this.id; this.child.write(frame({ jsonrpc: "2.0", id, method, params })); return this.child.wait(id, timeout); }
  async call(method, params) { await this.ready; return this.request(method, params); }

  onMessage(m) {
    if (m.id != null && m.method) return this.serverRequest(m);
    if (m.id != null) return this.child.settle(m.id, m.error ? new Error(m.error.message) : null, m.result);
    if (m.method === "textDocument/publishDiagnostics") {
      const file = fileOf(m.params?.uri);
      if (file) { this.diags.set(file, diagnosticsOf(m.params)); this.onDiagnostics(file); }
    }
  }
  // Requests from the server: configuration, dynamic registration, progress, applyEdit.
  serverRequest(m) {
    let result = null;
    if (m.method === "workspace/configuration") result = (m.params?.items ?? []).map(() => ({}));
    else if (m.method === "workspace/applyEdit") result = { applied: !!this.applyEdit(workspaceEdit(m.params?.edit)) };
    else if (m.method === "workspace/workspaceFolders") result = [{ uri: uri(this.root), name: this.root.split("/").pop() }];
    else if (m.method === "client/registerCapability" && this.caps) for (const r of m.params?.registrations ?? []) { const op = METHOD_OP[r.method]; if (op) this.caps[OPS[op]] = true; }
    this.child.write(frame({ jsonrpc: "2.0", id: m.id, result }));
  }

  async sync(file, text) {
    await this.ready;
    const d = this.docs.get(file);
    if (d?.text === text) return;
    if (!d) {
      this.docs.set(file, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri: uri(file), languageId: this.spec.languageId(file), version: 1, text } });
    } else {
      d.version++; d.text = text;
      this.notify("textDocument/didChange", { textDocument: { uri: uri(file), version: d.version }, contentChanges: [{ text }] });
    }
  }
  saved(file) { if (this.docs.has(file)) this.notify("textDocument/didSave", { textDocument: { uri: uri(file) } }); }

  tdp(ctx) { return { textDocument: { uri: uri(ctx.file) }, position: lspPos(ctx) }; }
  async definition(ctx) { return locations(await this.call("textDocument/definition", this.tdp(ctx))); }
  async typeDefinition(ctx) { return locations(await this.call("textDocument/typeDefinition", this.tdp(ctx))); }
  async implementation(ctx) { return locations(await this.call("textDocument/implementation", this.tdp(ctx))); }
  async references(ctx) { return locations(await this.call("textDocument/references", { ...this.tdp(ctx), context: { includeDeclaration: true } })); }
  async rename(ctx, newName) {
    const we = await this.call("textDocument/rename", { ...this.tdp(ctx), newName });
    if (!we) throw new Error("The element can't be renamed.");
    return workspaceEdit(we);
  }
  async format(ctx) {
    return edits(await this.call("textDocument/formatting", { textDocument: { uri: uri(ctx.file) }, options: { tabSize: ctx.tabSize, insertSpaces: ctx.insertSpaces } }));
  }
  // Operations a server may lack: null once it says (initialize) it doesn't have `op`, so the editor can fall back.
  async optional(op, method, params) { await this.ready; return this.can(op) ? this.call(method, params) : null; }
  async formatRange(ctx) {
    const r = await this.optional("formatRange", "textDocument/rangeFormatting", { textDocument: { uri: uri(ctx.file) },
      range: { start: lspPos(ctx.sel.start), end: lspPos(ctx.sel.end) }, options: { tabSize: ctx.tabSize, insertSpaces: ctx.insertSpaces } });
    return r && edits(r);
  }
  // Code actions of `kind` for the selection, ctx.diagnostics (the server's own) as their context: [{ title, kind, preferred, resolve }].
  async actions(ctx, kind) {
    const list = await this.call("textDocument/codeAction", {
      textDocument: { uri: uri(ctx.file) }, range: { start: lspPos(ctx.sel.start), end: lspPos(ctx.sel.end) },
      context: { diagnostics: (ctx.diagnostics ?? []).map(d => d.raw).filter(Boolean), only: [kind], triggerKind: 1 },
    }) ?? [];
    return list.filter(a => !a.disabled && (!a.kind || a.kind.startsWith(kind) || a.command))
      .map(a => ({ title: a.title, kind: a.kind ?? kind, preferred: !!a.isPreferred, resolve: () => this.resolveAction(a) }));
  }
  // An action's edit, resolving it or running its command (the server then sends workspace/applyEdit).
  async resolveAction(a) {
    if (typeof a.command === "string") { await this.call("workspace/executeCommand", { command: a.command, arguments: a.arguments }); return {}; }
    let action = a;
    if (!action.edit && !action.command && this.caps?.codeActionProvider?.resolveProvider) action = await this.call("codeAction/resolve", a);
    const ws = workspaceEdit(action.edit);
    if (action.command) { await this.call("workspace/executeCommand", { command: action.command.command, arguments: action.command.arguments }); }
    return ws;
  }
  refactors(ctx) { return this.actions(ctx, "refactor"); }
  sourceActions(ctx) { return this.actions(ctx, "source"); }
  quickFixes(ctx) { return this.actions(ctx, "quickfix"); }
  // Innermost first.
  async selectionRanges(ctx) {
    const out = [];
    for (let r = (await this.optional("selectionRange", "textDocument/selectionRange", { textDocument: { uri: uri(ctx.file) }, positions: [lspPos(ctx)] }))?.[0]; r; r = r.parent)
      out.push({ start: pos(r.range.start), end: pos(r.range.end) });
    return out;
  }
  async symbols(ctx) { return fromLsp(await this.call("textDocument/documentSymbol", { textDocument: { uri: uri(ctx.file) } })); }
  async calls(ctx, dir) {
    const items = await this.call("textDocument/prepareCallHierarchy", this.tdp(ctx)) ?? [];
    const out = [];
    for (const item of items) {
      const res = await this.call(`callHierarchy/${dir}Calls`, { item }) ?? [];
      for (const c of res) {
        const other = dir === "incoming" ? c.from : c.to, file = fileOf(dir === "incoming" ? c.from.uri : c.to.uri);
        if (!file) continue;
        const ranges = dir === "incoming" ? c.fromRanges : [other.selectionRange];
        for (const r of ranges) out.push({ file, ...pos(r.start), end: pos(r.end), name: other.name, detail: other.detail ?? "" });
      }
    }
    return out;
  }
  dispose() {
    if (this.child.dead) return;
    this.request("shutdown", null, 500).catch(() => {}).finally(() => { this.notify("exit", null); this.child.kill(); });
  }
  kill() { this.child.kill(); }
}

module.exports = { Lsp, locations, workspaceEdit, diagnosticsOf, uri, fileOf };
