//! A Language Server Protocol client over stdio (lang/lsp.cjs): Content-Length framing, full-text sync, its own reader
//! thread answering the server's requests (configuration, applyEdit, registration) and keeping its diagnostics.

use super::edits::{add, p16, TextEdit, WorkspaceEdit, P16};
use super::rpc::{frame, read_frames, Child, Reply};
use super::{apply_edit, diagnosed, semantic, Action, Ctx, Diag, Lens, Loc, Reference, Resolve, Spec, WsSymbol};
use crate::symbols::{from_lsp, kind_name, lsp_pos};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);

/// A file path as a file: URI (percent-encoding what isn't a URI path character).
pub fn uri(file: &Path) -> String {
    let mut out = String::from("file://");
    for b in file.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~!$&'()*+,;=:@".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A file: URI's path, None for other schemes.
pub fn file_of(u: &str) -> Option<PathBuf> {
    let rest = u.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let bytes = rest.as_bytes();
    let (mut out, mut i) = (Vec::with_capacity(bytes.len()), 0);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 {
            if let Some(v) = rest.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(PathBuf::from(String::from_utf8_lossy(&out).into_owned()))
}

fn lsp(p: P16) -> Value {
    json!({ "line": p.line, "character": p.col })
}

fn edits_of(list: &Value) -> Vec<TextEdit> {
    list.as_array().into_iter().flatten().map(|e| TextEdit { start: lsp_pos(&e["range"]["start"]), end: lsp_pos(&e["range"]["end"]), text: e["newText"].as_str().unwrap_or("").into() }).collect()
}

/// Location | Location[] | LocationLink[] -> locations.
pub fn locations(result: &Value) -> Vec<Loc> {
    let list = match result {
        Value::Array(a) => a.clone(),
        Value::Null => vec![],
        v => vec![v.clone()],
    };
    list.iter()
        .filter_map(|l| {
            let u = l["targetUri"].as_str().or(l["uri"].as_str())?;
            let r = if l["targetSelectionRange"].is_object() { &l["targetSelectionRange"] } else { &l["range"] };
            let file = file_of(u).filter(|_| r.is_object())?;
            Some(Loc::at(file, lsp_pos(&r["start"]), Some(lsp_pos(&r["end"]))))
        })
        .collect()
}

/// Hover contents (MarkupContent | MarkedString | MarkedString[]) -> Markdown; a language's MarkedString is a code block.
pub fn hover_text(contents: &Value) -> String {
    let one = |c: &Value| -> String {
        match c {
            Value::String(s) => s.clone(),
            c if c["language"].is_string() => format!("```{}\n{}\n```", c["language"].as_str().unwrap_or(""), c["value"].as_str().unwrap_or("")),
            c => c["value"].as_str().unwrap_or("").into(),
        }
    };
    let list = match contents {
        Value::Array(a) => a.clone(),
        Value::Null => vec![],
        v => vec![v.clone()],
    };
    list.iter().map(one).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// WorkspaceEdit -> per file edits (file create / rename / delete operations are skipped).
pub fn workspace_edit(we: &Value) -> WorkspaceEdit {
    let mut ws = vec![];
    for (u, list) in we["changes"].as_object().into_iter().flatten() {
        if let Some(f) = file_of(u) {
            add(&mut ws, f, edits_of(list));
        }
    }
    for dc in we["documentChanges"].as_array().into_iter().flatten() {
        if let Some(f) = dc["textDocument"]["uri"].as_str().and_then(file_of) {
            add(&mut ws, f, edits_of(&dc["edits"]));
        }
    }
    ws
}

/// publishDiagnostics params -> diagnostics.
pub fn diagnostics_of(params: &Value) -> Vec<Diag> {
    params["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["range"].is_object() && d["message"].as_str().is_some_and(|m| !m.is_empty()))
        .map(|d| {
            let code = match &d["code"] {
                Value::Null => String::new(),
                Value::String(s) => format!("({s})"),
                v => format!("({v})"),
            };
            Diag {
                start: lsp_pos(&d["range"]["start"]),
                end: lsp_pos(&d["range"]["end"]),
                severity: d["severity"].as_u64().filter(|s| (1..=4).contains(s)).unwrap_or(1) as u8,
                message: d["message"].as_str().unwrap_or("").into(),
                source: d["source"].as_str().map_or(String::new(), |s| format!("{s}{code}")),
                code: None,
                raw: d.clone(),
            }
        })
        .collect()
}

/// A count lens's kind from its title ("3 references", "1 implementation"); None for other lenses (Run, Debug).
pub fn lens_kind(title: &str) -> Option<&'static str> {
    let (n, word) = title.split_once(' ')?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match word.to_ascii_lowercase().as_str() {
        "reference" | "references" => Some("references"),
        "implementation" | "implementations" => Some("implementation"),
        _ => None,
    }
}

/// op -> the server capability that provides it.
fn capability(op: &str) -> Option<&'static str> {
    Some(match op {
        "definition" => "definitionProvider",
        "typeDefinition" => "typeDefinitionProvider",
        "implementation" => "implementationProvider",
        "references" => "referencesProvider",
        "rename" => "renameProvider",
        "format" => "documentFormattingProvider",
        "refactor" | "source" | "quickFix" => "codeActionProvider",
        "callHierarchy" => "callHierarchyProvider",
        "symbols" => "documentSymbolProvider",
        "hover" => "hoverProvider",
        "selectionRange" => "selectionRangeProvider",
        "formatRange" => "documentRangeFormattingProvider",
        "workspaceSymbols" => "workspaceSymbolProvider",
        "semanticTokens" => "semanticTokensProvider",
        "documentHighlight" => "documentHighlightProvider",
        "codeLens" => "codeLensProvider",
        _ => return None,
    })
}

/// A dynamically registered method -> its op.
fn op_of_method(m: &str) -> Option<&'static str> {
    Some(match m {
        "textDocument/definition" => "definition",
        "textDocument/typeDefinition" => "typeDefinition",
        "textDocument/implementation" => "implementation",
        "textDocument/references" => "references",
        "textDocument/rename" => "rename",
        "textDocument/formatting" => "format",
        "textDocument/codeAction" => "refactor",
        "textDocument/prepareCallHierarchy" => "callHierarchy",
        "textDocument/documentSymbol" => "symbols",
        "textDocument/hover" => "hover",
        "textDocument/selectionRange" => "selectionRange",
        "textDocument/rangeFormatting" => "formatRange",
        "workspace/symbol" => "workspaceSymbols",
        "textDocument/documentHighlight" => "documentHighlight",
        "textDocument/codeLens" => "codeLens",
        _ => return None,
    })
}

fn client_caps() -> Value {
    json!({
        "general": { "positionEncodings": ["utf-16"] },
        "workspace": { "applyEdit": true, "workspaceEdit": { "documentChanges": true }, "configuration": true, "workspaceFolders": true, "symbol": {} },
        "textDocument": {
            "synchronization": { "didSave": true }, "definition": { "linkSupport": true }, "typeDefinition": { "linkSupport": true },
            "implementation": { "linkSupport": true }, "references": {}, "rename": { "prepareSupport": false }, "formatting": {}, "rangeFormatting": {}, "callHierarchy": {},
            "hover": { "contentFormat": ["markdown", "plaintext"] }, "selectionRange": {}, "documentHighlight": {}, "codeLens": {},
            "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
            "codeAction": { "codeActionLiteralSupport": { "codeActionKind": { "valueSet": ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } },
                "resolveSupport": { "properties": ["edit"] }, "dataSupport": true },
            "publishDiagnostics": {},
            "semanticTokens": { "requests": { "full": { "delta": true } }, "formats": ["relative"], "multilineTokenSupport": false, "overlappingTokenSupport": false,
                "tokenTypes": ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
                "tokenModifiers": ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"] },
        },
    })
}

pub struct Lsp {
    pub child: Arc<Child>,
    pub label: String,
    root: PathBuf,
    language_id: fn(&Path) -> String,
    /// file -> (version, text) the server has
    docs: Mutex<HashMap<PathBuf, (i64, String)>>,
    /// None until initialize answered: every op is assumed available until then.
    caps: Mutex<Option<Value>>,
    ready: (Mutex<bool>, Condvar),
    pub diags: Mutex<HashMap<PathBuf, Arc<Vec<Diag>>>>,
    /// file -> (resultId, data) of the last semantic tokens
    semantic: Mutex<HashMap<PathBuf, (String, Vec<u32>)>>,
}

impl Lsp {
    pub fn start(spec: Spec, root: &Path) -> Option<Arc<Lsp>> {
        let (child, stdout) = Child::spawn(&spec.cmd, &spec.args, root).ok()?;
        let s = Arc::new(Lsp {
            child,
            label: spec.label.into(),
            root: root.to_path_buf(),
            language_id: spec.language_id,
            docs: Mutex::default(),
            caps: Mutex::default(),
            ready: (Mutex::new(false), Condvar::new()),
            diags: Mutex::default(),
            semantic: Mutex::default(),
        });
        let weak: Weak<Lsp> = Arc::downgrade(&s);
        let child = s.child.clone();
        std::thread::spawn(move || {
            read_frames(stdout, |m| {
                if let Some(s) = weak.upgrade() {
                    s.on_message(m);
                }
            });
            child.die(format!("{} exited", child.name));
        });
        let me = s.clone();
        let init = json!({
            "processId": std::process::id(), "rootUri": uri(root), "rootPath": root, "workspaceFolders": [{ "uri": uri(root), "name": root.file_name().map(|n| n.to_string_lossy()).unwrap_or_default() }],
            "capabilities": client_caps(), "initializationOptions": if spec.init.is_null() { json!({}) } else { spec.init },
        });
        std::thread::spawn(move || {
            let r = me.request("initialize", init, Duration::from_secs(60));
            if let Ok(r) = &r {
                *me.caps.lock().unwrap() = Some(if r["capabilities"].is_object() { r["capabilities"].clone() } else { json!({}) });
                me.notify("initialized", json!({}));
            }
            let (m, cv) = &me.ready;
            *m.lock().unwrap() = true;
            cv.notify_all();
        });
        Some(s)
    }

    /// Waits for initialize (its answer or failure).
    fn wait_ready(&self) -> Result<(), String> {
        let (m, cv) = &self.ready;
        let mut ready = m.lock().map_err(|e| e.to_string())?;
        while !*ready {
            if self.child.dead().is_some() {
                break;
            }
            ready = cv.wait_timeout(ready, Duration::from_millis(200)).map_err(|e| e.to_string())?.0;
        }
        match self.child.dead() {
            Some(why) => Err(why),
            None => Ok(()),
        }
    }

    /// Until the server answered initialize, every operation is assumed available.
    pub fn can(&self, op: &str) -> bool {
        let caps = self.caps.lock().unwrap();
        let Some(c) = caps.as_ref() else { return true };
        capability(op).is_some_and(|k| !matches!(c[k], Value::Null | Value::Bool(false)))
    }

    fn notify(&self, method: &str, params: Value) {
        self.child.write(&frame(&json!({ "jsonrpc": "2.0", "method": method, "params": params })));
    }
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Reply {
        let id = self.child.next_id();
        self.child.call(id, &frame(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })), timeout)
    }
    fn call(&self, method: &str, params: Value) -> Reply {
        self.wait_ready()?;
        self.request(method, params, TIMEOUT)
    }
    /// Null once the server says (initialize) it lacks `op`, so the editor can fall back.
    fn optional(&self, op: &str, method: &str, params: Value) -> Reply {
        self.wait_ready()?;
        if self.can(op) { self.request(method, params, TIMEOUT) } else { Ok(Value::Null) }
    }

    fn on_message(&self, m: Value) {
        let id = &m["id"];
        if !id.is_null() && m["method"].is_string() {
            return self.server_request(&m);
        }
        if let Some(id) = id.as_u64() {
            let r = match m["error"]["message"].as_str() {
                Some(e) => Err(e.to_string()),
                None if m["error"].is_object() => Err("The language server failed".into()),
                None => Ok(m["result"].clone()),
            };
            return self.child.settle(id, r);
        }
        if m["method"] == "textDocument/publishDiagnostics" {
            if let Some(f) = m["params"]["uri"].as_str().and_then(file_of) {
                self.diags.lock().unwrap().insert(f, Arc::new(diagnostics_of(&m["params"])));
                diagnosed();
            }
        }
    }

    /// Requests from the server: configuration, applyEdit, workspace folders, dynamic registration.
    fn server_request(&self, m: &Value) {
        let params = &m["params"];
        let result = match m["method"].as_str().unwrap_or("") {
            "workspace/configuration" => Value::Array(params["items"].as_array().into_iter().flatten().map(|_| json!({})).collect()),
            "workspace/applyEdit" => json!({ "applied": apply_edit(workspace_edit(&params["edit"])) }),
            "workspace/workspaceFolders" => json!([{ "uri": uri(&self.root), "name": self.root.file_name().map(|n| n.to_string_lossy()).unwrap_or_default() }]),
            "client/registerCapability" => {
                if let Some(c) = self.caps.lock().unwrap().as_mut() {
                    for r in params["registrations"].as_array().into_iter().flatten() {
                        if let Some(k) = r["method"].as_str().and_then(op_of_method).and_then(capability) {
                            c[k] = json!(true);
                        }
                    }
                }
                Value::Null
            }
            _ => Value::Null,
        };
        self.child.write(&frame(&json!({ "jsonrpc": "2.0", "id": m["id"], "result": result })));
    }

    pub fn sync(&self, file: &Path, text: &str) -> Result<(), String> {
        self.wait_ready()?;
        let mut docs = self.docs.lock().unwrap();
        match docs.get_mut(file) {
            Some((_, t)) if t == text => {}
            Some((v, t)) => {
                *v += 1;
                *t = text.to_string();
                self.notify("textDocument/didChange", json!({ "textDocument": { "uri": uri(file), "version": *v }, "contentChanges": [{ "text": text }] }));
            }
            None => {
                docs.insert(file.to_path_buf(), (1, text.to_string()));
                self.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri(file), "languageId": (self.language_id)(file), "version": 1, "text": text } }));
            }
        }
        Ok(())
    }
    pub fn saved(&self, file: &Path) {
        if self.docs.lock().unwrap().contains_key(file) {
            self.notify("textDocument/didSave", json!({ "textDocument": { "uri": uri(file) } }));
        }
    }

    fn tdp(ctx: &Ctx) -> Value {
        json!({ "textDocument": { "uri": uri(&ctx.file) }, "position": lsp(p16(ctx.line, ctx.col)) })
    }
    fn options(ctx: &Ctx) -> Value {
        json!({ "tabSize": ctx.tab_size, "insertSpaces": ctx.insert_spaces })
    }
    fn range(ctx: &Ctx) -> Value {
        json!({ "start": lsp(ctx.sel.0), "end": lsp(ctx.sel.1) })
    }

    pub fn locate(&self, kind: &str, ctx: &Ctx) -> Result<Vec<Loc>, String> {
        let mut params = Self::tdp(ctx);
        if kind == "references" {
            params["context"] = json!({ "includeDeclaration": true });
        }
        Ok(locations(&self.call(&format!("textDocument/{kind}"), params)?))
    }
    pub fn rename(&self, ctx: &Ctx, name: &str) -> Result<WorkspaceEdit, String> {
        let mut params = Self::tdp(ctx);
        params["newName"] = json!(name);
        let we = self.call("textDocument/rename", params)?;
        if we.is_null() {
            return Err("The element can't be renamed.".into());
        }
        Ok(workspace_edit(&we))
    }
    pub fn format(&self, ctx: &Ctx) -> Result<Vec<TextEdit>, String> {
        Ok(edits_of(&self.call("textDocument/formatting", json!({ "textDocument": { "uri": uri(&ctx.file) }, "options": Self::options(ctx) }))?))
    }
    pub fn format_range(&self, ctx: &Ctx) -> Result<Option<Vec<TextEdit>>, String> {
        let r = self.optional("formatRange", "textDocument/rangeFormatting", json!({ "textDocument": { "uri": uri(&ctx.file) }, "range": Self::range(ctx), "options": Self::options(ctx) }))?;
        Ok((!r.is_null()).then(|| edits_of(&r)))
    }
    /// Code actions of `kind` (refactor | source | quickFix) for the selection, ctx.diagnostics as their context.
    pub fn actions(&self, kind: &str, ctx: &Ctx) -> Result<Vec<Action>, String> {
        let kind = if kind == "quickFix" { "quickfix" } else { kind };
        let diags: Vec<Value> = ctx.diagnostics.iter().map(|d| d.raw.clone()).filter(|r| !r.is_null()).collect();
        let list = self.call("textDocument/codeAction", json!({ "textDocument": { "uri": uri(&ctx.file) }, "range": Self::range(ctx),
            "context": { "diagnostics": diags, "only": [kind], "triggerKind": 1 } }))?;
        Ok(list
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["disabled"].is_null() && (a["kind"].as_str().is_none_or(|k| k.starts_with(kind)) || !a["command"].is_null()))
            .map(|a| Action { title: a["title"].as_str().unwrap_or("").into(), preferred: a["isPreferred"].as_bool().unwrap_or(false), resolve: Resolve::Lsp(a.clone()) })
            .collect())
    }
    /// An action's edit: resolving it, or running its command (the server then sends workspace/applyEdit).
    pub fn resolve_action(&self, a: &Value) -> Result<WorkspaceEdit, String> {
        if let Some(cmd) = a["command"].as_str() {
            self.call("workspace/executeCommand", json!({ "command": cmd, "arguments": a["arguments"] }))?;
            return Ok(vec![]);
        }
        let resolves = self.caps.lock().unwrap().as_ref().is_some_and(|c| c["codeActionProvider"]["resolveProvider"] == json!(true));
        let action = if a["edit"].is_null() && a["command"].is_null() && resolves { self.call("codeAction/resolve", a.clone())? } else { a.clone() };
        let ws = workspace_edit(&action["edit"]);
        if action["command"].is_object() {
            self.call("workspace/executeCommand", json!({ "command": action["command"]["command"], "arguments": action["command"]["arguments"] }))?;
        }
        Ok(ws)
    }
    pub fn hover(&self, ctx: &Ctx) -> Result<Option<String>, String> {
        let h = self.optional("hover", "textDocument/hover", Self::tdp(ctx))?;
        Ok((!h.is_null()).then(|| hover_text(&h["contents"])))
    }
    pub fn selection_ranges(&self, ctx: &Ctx) -> Result<Vec<(P16, P16)>, String> {
        let r = self.optional("selectionRange", "textDocument/selectionRange", json!({ "textDocument": { "uri": uri(&ctx.file) }, "positions": [lsp(p16(ctx.line, ctx.col))] }))?;
        let mut out = vec![];
        let mut cur = &r[0];
        while cur.is_object() {
            out.push((lsp_pos(&cur["range"]["start"]), lsp_pos(&cur["range"]["end"])));
            cur = &cur["parent"];
        }
        Ok(out)
    }
    pub fn workspace_symbols(&self, query: &str) -> Result<Vec<WsSymbol>, String> {
        let r = self.optional("workspaceSymbols", "workspace/symbol", json!({ "query": query }))?;
        Ok(r.as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                let file = file_of(s["location"]["uri"].as_str()?)?;
                let start = if s["location"]["range"].is_object() { lsp_pos(&s["location"]["range"]["start"]) } else { p16(0, 0) };
                Some(WsSymbol { name: s["name"].as_str().unwrap_or("").into(), kind: kind_name(&s["kind"]), container: s["containerName"].as_str().unwrap_or("").into(), loc: Loc::at(file, start, None) })
            })
            .collect())
    }
    /// textDocument/documentHighlight (kind 3: a write).
    pub fn highlights(&self, ctx: &Ctx) -> Result<Vec<Reference>, String> {
        let r = self.optional("documentHighlight", "textDocument/documentHighlight", Self::tdp(ctx))?;
        let list = r.as_array().into_iter().flatten().filter(|h| h["range"].is_object());
        Ok(list.map(|h| Reference { start: lsp_pos(&h["range"]["start"]), end: lsp_pos(&h["range"]["end"]), write: h["kind"] == 3 }).collect())
    }
    /// The server's reference / implementation count lenses (resolved when it resolves them); run / debug lenses are
    /// left out.
    pub fn lenses(&self, ctx: &Ctx) -> Result<Vec<Lens>, String> {
        let list = self.optional("codeLens", "textDocument/codeLens", json!({ "textDocument": { "uri": uri(&ctx.file) } }))?;
        let resolves = self.caps.lock().unwrap().as_ref().is_some_and(|c| c["codeLensProvider"]["resolveProvider"] == true);
        let mut out = vec![];
        for l in list.as_array().into_iter().flatten().filter(|l| l["range"].is_object()).take(200) {
            let l = if l["command"].is_null() && resolves { self.call("codeLens/resolve", l.clone()).unwrap_or_else(|_| l.clone()) } else { l.clone() };
            let title = l["command"]["title"].as_str().unwrap_or("");
            if let Some(kind) = lens_kind(title) {
                out.push(Lens { at: lsp_pos(&l["range"]["start"]), title: title.into(), kind });
            }
        }
        Ok(out)
    }
    pub fn symbols(&self, ctx: &Ctx) -> Result<Vec<crate::symbols::Symbol>, String> {
        Ok(from_lsp(&self.call("textDocument/documentSymbol", json!({ "textDocument": { "uri": uri(&ctx.file) } }))?))
    }
    pub fn calls(&self, ctx: &Ctx, dir: &str) -> Result<Vec<Loc>, String> {
        let items = self.call("textDocument/prepareCallHierarchy", Self::tdp(ctx))?;
        let mut out = vec![];
        for item in items.as_array().into_iter().flatten() {
            let res = self.call(&format!("callHierarchy/{dir}Calls"), json!({ "item": item }))?;
            for c in res.as_array().into_iter().flatten() {
                let other = if dir == "incoming" { &c["from"] } else { &c["to"] };
                let Some(file) = other["uri"].as_str().and_then(file_of) else { continue };
                let ranges: Vec<Value> = if dir == "incoming" { c["fromRanges"].as_array().cloned().unwrap_or_default() } else { vec![other["selectionRange"].clone()] };
                for r in ranges {
                    let mut l = Loc::at(file.clone(), lsp_pos(&r["start"]), Some(lsp_pos(&r["end"])));
                    l.name = other["name"].as_str().map(str::to_string);
                    l.detail = other["detail"].as_str().unwrap_or("").into();
                    out.push(l);
                }
            }
        }
        Ok(out)
    }
    /// semanticTokens/full, or /full/delta from the last result when the server offers it.
    pub fn semantic_tokens(&self, ctx: &Ctx) -> Option<semantic::Tokens> {
        let provider = self.caps.lock().ok()?.as_ref()?["semanticTokensProvider"].clone();
        let legend = &provider["legend"];
        let names = |k: &str| -> Vec<String> { legend[k].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect() };
        if provider["full"].is_null() || provider["full"] == json!(false) {
            return None;
        }
        let doc = json!({ "uri": uri(&ctx.file) });
        let prev = self.semantic.lock().ok()?.get(&ctx.file).cloned();
        let delta = provider["full"]["delta"] == json!(true);
        let data: Vec<u32> = match prev.filter(|_| delta) {
            Some((id, old)) => {
                let r = self.call("textDocument/semanticTokens/full/delta", json!({ "textDocument": doc, "previousResultId": id })).ok()?;
                let r2 = r.clone();
                self.remember(&ctx.file, &r2, if r["edits"].is_array() { semantic::apply_delta(&old, &r["edits"]) } else { numbers(&r["data"]) })
            }
            None => {
                let r = self.call("textDocument/semanticTokens/full", json!({ "textDocument": doc })).ok()?;
                self.remember(&ctx.file, &r, numbers(&r["data"]))
            }
        };
        Some(semantic::decode_lsp(&data, &names("tokenTypes"), &names("tokenModifiers")))
    }
    fn remember(&self, file: &Path, r: &Value, data: Vec<u32>) -> Vec<u32> {
        if let (Some(id), Ok(mut m)) = (r["resultId"].as_str(), self.semantic.lock()) {
            m.insert(file.to_path_buf(), (id.to_string(), data.clone()));
        }
        data
    }

    /// Asks it to shut down and exit, then kills it (on exit; doesn't wait).
    pub fn dispose(&self) {
        if self.child.dead().is_none() {
            let id = self.child.next_id();
            self.child.write(&frame(&json!({ "jsonrpc": "2.0", "id": id, "method": "shutdown", "params": null })));
            self.notify("exit", Value::Null);
        }
        self.child.kill();
    }
}

fn numbers(v: &Value) -> Vec<u32> {
    v.as_array().into_iter().flatten().filter_map(Value::as_u64).map(|n| n as u32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_count_lenses_are_kept() {
        assert_eq!(lens_kind("3 references"), Some("references"));
        assert_eq!(lens_kind("1 implementation"), Some("implementation"));
        assert_eq!(lens_kind("▶︎ Run"), None);
        assert_eq!(lens_kind("references"), None);
    }

    #[test]
    fn uris_round_trip_with_escapes() {
        let f = Path::new("/tmp/a b/한.ts");
        assert_eq!(uri(f), "file:///tmp/a%20b/%ED%95%9C.ts");
        assert_eq!(file_of(&uri(f)).as_deref(), Some(f));
        assert_eq!(file_of("untitled:x"), None);
    }

    #[test]
    fn locations_links_and_workspace_edits_convert() {
        let r = |l: u64, c: u64| json!({ "start": { "line": l, "character": c }, "end": { "line": l, "character": c + 1 } });
        let got = locations(&json!([{ "targetUri": "file:///a.rs", "targetSelectionRange": r(3, 4), "targetRange": r(0, 0) }, { "uri": "file:///b.rs", "range": r(1, 2) }]));
        assert_eq!(got.iter().map(|l| (l.file.to_string_lossy().into_owned(), l.line, l.col)).collect::<Vec<_>>(), [("/a.rs".into(), 3, 4), ("/b.rs".into(), 1, 2)]);
        let ws = workspace_edit(&json!({ "documentChanges": [{ "textDocument": { "uri": "file:///a.rs" }, "edits": [{ "range": r(0, 0), "newText": "x" }] }, { "kind": "create", "uri": "file:///c" }] }));
        assert_eq!(ws.len(), 1);
        assert_eq!(hover_text(&json!([{ "language": "rust", "value": "fn f()" }, "doc"])), "```rust\nfn f()\n```\n\ndoc");
        let d = diagnostics_of(&json!({ "diagnostics": [{ "range": r(0, 1), "message": "bad", "severity": 2, "source": "rustc", "code": "E1" }, { "range": r(0, 1), "message": "" }] }));
        assert_eq!((d.len(), d[0].severity, d[0].source.as_str()), (1, 2, "rustc(E1)"));
    }
}
