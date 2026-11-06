//! TypeScript/JavaScript through tsserver's own protocol, as VS Code does (lang/tsserver.cjs): requests are JSON lines on
//! stdin, replies come back Content-Length framed; positions are 1-based line/offset (UTF-16).

use super::edits::{add, p16, TextEdit, WorkspaceEdit, P16};
use super::rpc::{read_frames, Child, Reply};
use super::{diagnosed, semantic, Action, Ctx, Diag, Loc, Resolve, WsSymbol};
use crate::symbols::{from_navtree, ts_pos};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);

/// The project's typescript first (walking up to the root), then the one behind `tsserver` on PATH.
pub fn find_tsserver(file: &Path, root: &Path) -> Option<PathBuf> {
    let mut d = file.parent();
    while let Some(dir) = d {
        let f = dir.join("node_modules/typescript/lib/tsserver.js");
        if f.is_file() {
            return Some(f);
        }
        if dir == root {
            break;
        }
        d = dir.parent();
    }
    let real = std::fs::canonicalize(crate::term::which("tsserver")?).ok()?;
    let lib = real.parent()?.join("../lib/tsserver.js");
    Some(if lib.is_file() { lib } else { real })
}

fn at(ctx: &Ctx) -> Value {
    json!({ "file": ctx.file, "line": ctx.line + 1, "offset": ctx.col + 1 })
}
fn span_args(ctx: &Ctx, (s, e): (P16, P16)) -> Value {
    json!({ "file": ctx.file, "startLine": s.line + 1, "startOffset": s.col + 1, "endLine": e.line + 1, "endOffset": e.col + 1 })
}
fn loc(file: &str, span: &Value) -> Loc {
    Loc::at(PathBuf::from(file), ts_pos(&span["start"]), Some(ts_pos(&span["end"])))
}
fn changes(list: &Value) -> Vec<TextEdit> {
    list.as_array().into_iter().flatten().map(|c| TextEdit { start: ts_pos(&c["start"]), end: ts_pos(&c["end"]), text: c["newText"].as_str().unwrap_or("").into() }).collect()
}
/// FileCodeEdits[] -> a workspace edit.
fn ws_edit(file_edits: &Value) -> WorkspaceEdit {
    let mut ws = vec![];
    for fe in file_edits.as_array().into_iter().flatten() {
        add(&mut ws, PathBuf::from(fe["fileName"].as_str().unwrap_or("")), changes(&fe["textChanges"]));
    }
    ws
}

/// syntaxDiag / semanticDiag bodies -> diagnostics (suggestions count as hints).
pub fn ts_diagnostics(list: &Value) -> Vec<Diag> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["start"].is_object() && d["text"].as_str().is_some_and(|t| !t.is_empty()))
        .map(|d| {
            let code = d["code"].as_i64();
            Diag {
                start: ts_pos(&d["start"]),
                end: ts_pos(if d["end"].is_object() { &d["end"] } else { &d["start"] }),
                severity: match d["category"].as_str() {
                    Some("warning") => 2,
                    Some("message") => 3,
                    Some("suggestion") => 4,
                    _ => 1,
                },
                message: d["text"].as_str().unwrap_or("").into(),
                source: code.map_or("ts".into(), |c| format!("ts({c})")),
                code,
                raw: Value::Null,
            }
        })
        .collect()
}

fn empty_answer(e: &str) -> bool {
    let e = e.to_lowercase();
    ["no content", "could not find", "cannot", "not found"].iter().any(|p| e.contains(p))
}

pub struct TsServer {
    pub child: Arc<Child>,
    root: PathBuf,
    /// file -> the text tsserver has
    sent: Mutex<HashMap<PathBuf, String>>,
    pub diags: Mutex<HashMap<PathBuf, Arc<Vec<Diag>>>>,
    /// file -> (syntactic, semantic) diagnostics
    parts: Mutex<HashMap<PathBuf, [Vec<Diag>; 2]>>,
}

impl TsServer {
    pub const CAPS: [&'static str; 15] = [
        "definition", "typeDefinition", "implementation", "references", "rename", "format", "refactor", "source", "callHierarchy", "symbols", "quickFix", "hover", "selectionRange",
        "formatRange", "workspaceSymbols",
    ];
    pub const LABEL: &'static str = "TypeScript server";

    pub fn start(file: &Path, root: &Path) -> Option<Arc<TsServer>> {
        let server = find_tsserver(file, root)?;
        let node = crate::term::which("node")?;
        let args = vec![server.to_string_lossy().into_owned(), "--disableAutomaticTypingAcquisition".into(), "--locale".into(), "en".into()];
        let (child, stdout) = Child::spawn(&node, &args, root).ok()?;
        let s = Arc::new(TsServer { child, root: root.to_path_buf(), sent: Mutex::default(), diags: Mutex::default(), parts: Mutex::default() });
        let weak: Weak<TsServer> = Arc::downgrade(&s);
        let child = s.child.clone();
        std::thread::spawn(move || {
            read_frames(stdout, |m| {
                let Some(s) = weak.upgrade() else { return };
                if m["type"] == "response" {
                    let r = if m["success"] == json!(true) { Ok(m["body"].clone()) } else { Err(m["message"].as_str().or(m["command"].as_str()).unwrap_or("tsserver failed").to_string()) };
                    s.child.settle(m["request_seq"].as_u64().unwrap_or(0), r);
                } else if m["type"] == "event" && (m["event"] == "syntaxDiag" || m["event"] == "semanticDiag") {
                    s.diagnosed(m["event"] == "syntaxDiag", &m["body"]);
                }
            });
            child.die("tsserver exited".into());
        });
        Some(s)
    }

    fn diagnosed(&self, syntax: bool, body: &Value) {
        let Some(file) = body["file"].as_str().map(PathBuf::from) else { return };
        let list = ts_diagnostics(&body["diagnostics"]);
        let mut parts = self.parts.lock().unwrap();
        let p = parts.entry(file.clone()).or_default();
        p[if syntax { 0 } else { 1 }] = list;
        let all: Vec<Diag> = p.concat();
        self.diags.lock().unwrap().insert(file, Arc::new(all));
        diagnosed();
    }

    fn send(&self, command: &str, args: Value) -> u64 {
        let seq = self.child.next_id();
        self.child.write(&(json!({ "seq": seq, "type": "request", "command": command, "arguments": args }).to_string() + "\n"));
        seq
    }
    fn request(&self, command: &str, args: Value) -> Reply {
        let seq = self.child.next_id();
        self.child.call(seq, &(json!({ "seq": seq, "type": "request", "command": command, "arguments": args }).to_string() + "\n"), TIMEOUT)
    }
    /// An empty answer ("No content available") reads as no results.
    fn list(&self, command: &str, args: Value) -> Result<Value, String> {
        match self.request(command, args) {
            Ok(Value::Null) => Ok(json!([])),
            Ok(v) => Ok(v),
            Err(e) if empty_answer(&e) => Ok(json!([])),
            Err(e) => Err(e),
        }
    }

    /// Opens the file or replaces its whole text when it changed, then asks for its diagnostics.
    pub fn sync(&self, file: &Path, text: &str) {
        let mut sent = self.sent.lock().unwrap();
        match sent.get(file) {
            Some(old) if old == text => return,
            Some(old) => {
                let lines: Vec<&str> = old.split('\n').collect();
                let last = lines.last().map_or(0, |l| l.encode_utf16().count());
                self.send("change", json!({ "file": file, "line": 1, "offset": 1, "endLine": lines.len(), "endOffset": last + 1, "insertString": text }));
            }
            None => {
                self.send("open", json!({ "file": file, "fileContent": text, "projectRootPath": self.root }));
            }
        }
        sent.insert(file.to_path_buf(), text.to_string());
        self.send("geterr", json!({ "files": [file], "delay": 0 }));
    }

    pub fn locate(&self, kind: &str, ctx: &Ctx) -> Result<Vec<Loc>, String> {
        let body = self.list(kind, at(ctx))?;
        if kind == "references" {
            return Ok(body["refs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| {
                    let mut l = loc(r["file"].as_str().unwrap_or(""), r);
                    l.preview = r["lineText"].as_str().map(str::to_string);
                    l
                })
                .collect());
        }
        Ok(body.as_array().into_iter().flatten().map(|d| loc(d["file"].as_str().unwrap_or(""), d)).collect())
    }
    pub fn rename(&self, ctx: &Ctx, name: &str) -> Result<WorkspaceEdit, String> {
        let mut args = at(ctx);
        args["findInComments"] = json!(false);
        args["findInStrings"] = json!(false);
        let body = self.request("rename", args)?;
        if body["info"]["canRename"] != json!(true) {
            return Err(body["info"]["localizedErrorMessage"].as_str().unwrap_or("You cannot rename this element.").into());
        }
        let mut ws = vec![];
        for g in body["locs"].as_array().into_iter().flatten() {
            let edits = g["locs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|l| TextEdit { start: ts_pos(&l["start"]), end: ts_pos(&l["end"]), text: format!("{}{name}{}", l["prefixText"].as_str().unwrap_or(""), l["suffixText"].as_str().unwrap_or("")) })
                .collect();
            add(&mut ws, PathBuf::from(g["file"].as_str().unwrap_or("")), edits);
        }
        Ok(ws)
    }
    /// The whole file, or `r` for Format Selection.
    pub fn format(&self, ctx: &Ctx, r: Option<(P16, P16)>) -> Result<Vec<TextEdit>, String> {
        self.request("configure", json!({ "file": ctx.file, "formatOptions": { "tabSize": ctx.tab_size, "indentSize": ctx.tab_size, "convertTabsToSpaces": ctx.insert_spaces } }))?;
        let last = ctx.lines.len();
        let (s, e) = r.unwrap_or((p16(0, 0), p16(last - 1, ctx.lines[last - 1].encode_utf16().count())));
        let body = self.list("format", json!({ "file": ctx.file, "line": s.line + 1, "offset": s.col + 1, "endLine": e.line + 1, "endOffset": e.col + 1 }))?;
        Ok(changes(&body))
    }
    /// refactor | source | quickFix
    pub fn actions(&self, kind: &str, ctx: &Ctx) -> Result<Vec<Action>, String> {
        match kind {
            "refactor" => self.refactors(ctx),
            "source" => self.source_actions(ctx),
            _ => self.quick_fixes(ctx),
        }
    }
    fn refactors(&self, ctx: &Ctx) -> Result<Vec<Action>, String> {
        let args = span_args(ctx, ctx.sel);
        let mut out = vec![];
        for r in self.list("getApplicableRefactors", args.clone())?.as_array().into_iter().flatten() {
            for a in r["actions"].as_array().into_iter().flatten() {
                if !a["notApplicableReason"].is_null() {
                    continue;
                }
                let mut req = args.clone();
                req["refactor"] = r["name"].clone();
                req["action"] = a["name"].clone();
                out.push(Action { title: a["description"].as_str().unwrap_or("").into(), preferred: false, resolve: Resolve::TsRefactor(req) });
            }
        }
        Ok(out)
    }
    pub fn refactor_edits(&self, req: &Value) -> Result<WorkspaceEdit, String> {
        Ok(ws_edit(&self.request("getEditsForRefactor", req.clone())?["edits"]))
    }
    pub fn request_edits(&self, cmd: &str, args: &Value) -> Result<WorkspaceEdit, String> {
        Ok(ws_edit(&self.request(cmd, args.clone())?))
    }
    /// Fixes for `diags` ((range, code)), each title once.
    fn fixes(&self, ctx: &Ctx, diags: &[((P16, P16), i64)], out: &mut Vec<Action>) -> Result<(), String> {
        let mut seen: Vec<String> = out.iter().map(|a| a.title.clone()).collect();
        for (r, code) in diags.iter().take(20) {
            let mut args = span_args(ctx, *r);
            args["errorCodes"] = json!([code]);
            for f in self.list("getCodeFixes", args)?.as_array().into_iter().flatten() {
                let title = f["description"].as_str().unwrap_or("").to_string();
                if !seen.contains(&title) {
                    seen.push(title.clone());
                    out.push(Action { title, preferred: false, resolve: Resolve::Edit(ws_edit(&f["changes"])) });
                }
            }
        }
        Ok(())
    }
    /// Quick fixes for ctx.diagnostics (those with a TypeScript error code).
    fn quick_fixes(&self, ctx: &Ctx) -> Result<Vec<Action>, String> {
        let diags: Vec<_> = ctx.diagnostics.iter().filter_map(|d| d.code.map(|c| ((d.start, d.end), c))).collect();
        let mut out = vec![];
        self.fixes(ctx, &diags, &mut out)?;
        Ok(out)
    }
    fn source_actions(&self, ctx: &Ctx) -> Result<Vec<Action>, String> {
        let mut out = vec![Action { title: "Organize Imports".into(), preferred: false, resolve: Resolve::TsRequest("organizeImports", json!({ "scope": { "type": "file", "args": { "file": ctx.file } } })) }];
        let mut diags = vec![];
        for cmd in ["syntacticDiagnosticsSync", "semanticDiagnosticsSync"] {
            for d in self.list(cmd, json!({ "file": ctx.file }))?.as_array().into_iter().flatten() {
                if let Some(code) = d["code"].as_i64() {
                    diags.push(((ts_pos(&d["start"]), ts_pos(&d["end"])), code));
                }
            }
        }
        self.fixes(ctx, &diags, &mut out)?;
        Ok(out)
    }
    /// quickinfo as VS Code's TypeScript hover shows it: the signature as a code block, then the documentation and tags.
    pub fn hover(&self, ctx: &Ctx) -> Result<Option<String>, String> {
        let b = self.list("quickinfo", at(ctx))?;
        let Some(sig) = b["displayString"].as_str().filter(|s| !s.is_empty()) else { return Ok(None) };
        let text = |v: &Value| -> String {
            match v {
                Value::String(s) => s.clone(),
                v => v.as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect(),
            }
        };
        let tags: Vec<String> = b["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| {
                let body = text(&t["text"]);
                format!("*@{}*{}", t["name"].as_str().unwrap_or(""), if body.is_empty() { String::new() } else { format!(" — {body}") })
            })
            .collect();
        let parts = [format!("```typescript\n{sig}\n```"), text(&b["documentation"]), tags.join("\n\n")];
        Ok(Some(parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")))
    }
    pub fn selection_ranges(&self, ctx: &Ctx) -> Result<Vec<(P16, P16)>, String> {
        let r = self.list("selectionRange", json!({ "file": ctx.file, "locations": [{ "line": ctx.line + 1, "offset": ctx.col + 1 }] }))?;
        let mut out = vec![];
        let mut cur = &r[0];
        while cur.is_object() {
            out.push((ts_pos(&cur["textSpan"]["start"]), ts_pos(&cur["textSpan"]["end"])));
            cur = &cur["parent"];
        }
        Ok(out)
    }
    pub fn workspace_symbols(&self, ctx: &Ctx, query: &str) -> Result<Vec<WsSymbol>, String> {
        if query.is_empty() {
            return Ok(vec![]);
        }
        let r = self.list("navto", json!({ "searchValue": query, "file": ctx.file, "maxResultCount": 256 }))?;
        Ok(r.as_array()
            .into_iter()
            .flatten()
            .map(|n| WsSymbol {
                name: n["name"].as_str().unwrap_or("").into(),
                kind: n["kind"].as_str().unwrap_or("").into(),
                container: n["containerName"].as_str().unwrap_or("").into(),
                loc: Loc::at(PathBuf::from(n["file"].as_str().unwrap_or("")), ts_pos(&n["start"]), None),
            })
            .collect())
    }
    pub fn symbols(&self, ctx: &Ctx) -> Result<Vec<crate::symbols::Symbol>, String> {
        Ok(from_navtree(&self.request("navtree", json!({ "file": ctx.file }))?))
    }
    pub fn calls(&self, ctx: &Ctx, dir: &str) -> Result<Vec<Loc>, String> {
        let items = self.list("prepareCallHierarchy", at(ctx))?;
        let items = if items.is_array() { items.as_array().cloned().unwrap_or_default() } else { vec![items] };
        let mut out = vec![];
        for it in items {
            let args = json!({ "file": it["file"], "line": it["selectionSpan"]["start"]["line"], "offset": it["selectionSpan"]["start"]["offset"] });
            if dir == "incoming" {
                for c in self.list("provideCallHierarchyIncomingCalls", args)?.as_array().into_iter().flatten() {
                    for s in c["fromSpans"].as_array().into_iter().flatten() {
                        let mut l = loc(c["from"]["file"].as_str().unwrap_or(""), s);
                        l.name = c["from"]["name"].as_str().map(str::to_string);
                        l.detail = c["from"]["containerName"].as_str().unwrap_or("").into();
                        out.push(l);
                    }
                }
            } else {
                for c in self.list("provideCallHierarchyOutgoingCalls", args)?.as_array().into_iter().flatten() {
                    let mut l = loc(c["to"]["file"].as_str().unwrap_or(""), &c["to"]["selectionSpan"]);
                    l.name = c["to"]["name"].as_str().map(str::to_string);
                    l.detail = c["to"]["containerName"].as_str().unwrap_or("").into();
                    out.push(l);
                }
            }
        }
        Ok(out)
    }
    /// encodedSemanticClassifications-full (format 2020) over the whole text.
    pub fn semantic_tokens(&self, ctx: &Ctx) -> Option<semantic::Tokens> {
        let len: usize = ctx.lines.iter().map(|l| l.encode_utf16().count() + 1).sum::<usize>().saturating_sub(1);
        let body = self.request("encodedSemanticClassifications-full", json!({ "file": ctx.file, "start": 0, "length": len, "format": "2020" })).ok()?;
        let spans: Vec<u64> = body["spans"].as_array()?.iter().filter_map(Value::as_u64).collect();
        Some(semantic::decode_ts(&spans, &ctx.lines))
    }

    pub fn dispose(&self) {
        self.send("exit", json!({}));
        self.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsserver_diagnostics_keep_their_code_and_category() {
        let d = ts_diagnostics(&json!([{ "start": { "line": 6, "offset": 7 }, "end": { "line": 6, "offset": 8 }, "text": "bad", "code": 2322, "category": "error" },
            { "start": { "line": 1, "offset": 1 }, "text": "hint", "category": "suggestion" }]));
        assert_eq!((d[0].start, d[0].code, d[0].source.as_str(), d[1].severity), (p16(5, 6), Some(2322), "ts(2322)", 4));
        assert!(empty_answer("No content available."));
    }
}
