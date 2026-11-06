//! Which language intelligence serves a file (lang/index.cjs): tsserver, an LSP server, or the search/formatter
//! fallback. Servers start on first use (from a worker thread, never the editor's), one per (server, git root), and are
//! killed when the editor ends. Every operation here blocks its caller: the editor runs them on threads of their own.
//! Positions are 0-based lines and UTF-16 columns, as the servers count them.

pub mod edits;
pub mod fallback;
pub mod lsp;
pub mod rpc;
pub mod semantic;
pub mod tsserver;

use crate::symbols::Symbol;
use edits::{TextEdit, WorkspaceEdit, P16};
use fallback::Fallback;
use lsp::Lsp;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tsserver::TsServer;

/// What an operation is asked about: the file's text and the cursor, selection and word.
#[derive(Clone)]
pub struct Ctx {
    pub file: PathBuf,
    pub lines: Arc<Vec<String>>,
    pub line: usize,
    pub col: usize,
    pub sel: (P16, P16),
    pub tab_size: usize,
    pub insert_spaces: bool,
    pub word: String,
    pub language: String,
    /// The problems a quick fix is for.
    pub diagnostics: Vec<Diag>,
}

impl Ctx {
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

/// A result location (definition, reference, call, symbol).
#[derive(Clone, Debug, PartialEq)]
pub struct Loc {
    pub file: PathBuf,
    pub line: usize,
    pub col: usize,
    pub end: Option<P16>,
    pub preview: Option<String>,
    pub name: Option<String>,
    pub detail: String,
}

impl Loc {
    pub fn at(file: PathBuf, start: P16, end: Option<P16>) -> Loc {
        Loc { file, line: start.line, col: start.col, end, preview: None, name: None, detail: String::new() }
    }
}

/// A diagnostic: severity 1 error, 2 warning, 3 information, 4 hint; `code` tsserver's error code, `raw` the LSP
/// server's own diagnostic (sent back with code action requests).
#[derive(Clone, Debug, PartialEq)]
pub struct Diag {
    pub start: P16,
    pub end: P16,
    pub severity: u8,
    pub message: String,
    pub source: String,
    pub code: Option<i64>,
    pub raw: Value,
}

/// A code action (quick fix, refactoring, source action) and how to get its edit.
#[derive(Clone, Debug)]
pub struct Action {
    pub title: String,
    pub preferred: bool,
    pub resolve: Resolve,
}

#[derive(Clone, Debug)]
pub enum Resolve {
    Edit(WorkspaceEdit),
    /// An LSP CodeAction or Command, resolved / executed by its server.
    Lsp(Value),
    /// tsserver getEditsForRefactor arguments.
    TsRefactor(Value),
    /// tsserver organizeImports arguments.
    TsRequest(&'static str, Value),
}

/// Workspace symbol: a name and where it is.
#[derive(Clone, Debug)]
pub struct WsSymbol {
    pub name: String,
    pub kind: String,
    pub container: String,
    pub loc: Loc,
}

/// TextMate scope -> server kind.
pub fn kind_of_scope(scope: &str) -> Option<&'static str> {
    Some(match scope {
        "source.ts" | "source.tsx" | "source.js" | "source.js.jsx" => "ts",
        "source.rust" => "rust",
        "source.c" | "source.cpp" | "source.objc" | "source.objcpp" | "source.cuda-cpp" => "clangd",
        "source.swift" => "swift",
        "source.json" | "source.json.comments" => "json",
        "source.css" | "source.css.scss" | "source.css.less" => "css",
        "text.html.basic" | "text.html.derivative" => "html",
        _ => return None,
    })
}

const DEVIN: &str = "/Applications/Devin.app/Contents/Resources/app/extensions";

fn ext(file: &Path) -> String {
    file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// An LSP server's launch: (label, command, args, languageId of a file, initializationOptions).
pub struct Spec {
    pub label: &'static str,
    pub cmd: PathBuf,
    pub args: Vec<String>,
    pub language_id: fn(&Path) -> String,
    pub init: Value,
}

fn spec_of(kind: &str) -> Option<Spec> {
    let bin = |name: &str, dir: PathBuf| {
        let own = dir.join(name);
        if own.is_file() { Some(own) } else { crate::term::which(name) }
    };
    let vscode = |name: &str, main: &str| -> Option<(PathBuf, Vec<String>)> {
        let server = PathBuf::from(DEVIN).join(format!("{name}-language-features/server/dist/node/{main}"));
        server.is_file().then(|| (crate::term::which("node").unwrap_or_else(|| "node".into()), vec![server.to_string_lossy().into_owned(), "--stdio".into()]))
    };
    let spec = |label, (cmd, args): (PathBuf, Vec<String>), language_id, init| Some(Spec { label, cmd, args, language_id, init });
    let fmt = serde_json::json!({ "provideFormatter": true });
    match kind {
        "rust" => spec("rust-analyzer", (bin("rust-analyzer", crate::settings::home_dir().join(".cargo/bin"))?, vec![]), |_| "rust".into(), Value::Null),
        "clangd" => spec(
            "clangd",
            (bin("clangd", "/usr/bin".into())?, vec![]),
            |f| match ext(f).as_str() {
                "c" | "h" => "c",
                "m" => "objective-c",
                "mm" => "objective-cpp",
                "cu" => "cuda-cpp",
                _ => "cpp",
            }
            .into(),
            Value::Null,
        ),
        "swift" => spec("sourcekit-lsp", (bin("sourcekit-lsp", "/usr/bin".into())?, vec![]), |_| "swift".into(), Value::Null),
        "json" => spec("JSON language server", vscode("json", "jsonServerMain.js")?, |f| if ext(f) == "jsonc" { "jsonc".into() } else { "json".into() }, fmt),
        "css" => spec("CSS language server", vscode("css", "cssServerMain.js")?, |f| match ext(f).as_str() { "scss" => "scss".into(), "less" => "less".into(), _ => "css".into() }, fmt),
        "html" => spec("HTML language server", vscode("html", "htmlServerMain.js")?, |_| "html".into(), serde_json::json!({ "provideFormatter": true, "embeddedLanguages": { "css": true, "javascript": true } })),
        _ => None,
    }
}

/// A running server.
#[derive(Clone)]
pub enum Server {
    Ts(Arc<TsServer>),
    Lsp(Arc<Lsp>),
}

impl Server {
    pub fn dead(&self) -> bool {
        match self {
            Server::Ts(s) => s.child.dead().is_some(),
            Server::Lsp(s) => s.child.dead().is_some(),
        }
    }
    pub fn can(&self, op: &str) -> bool {
        match self {
            Server::Ts(_) => TsServer::CAPS.contains(&op),
            Server::Lsp(s) => s.can(op),
        }
    }
    pub fn label(&self) -> String {
        match self {
            Server::Ts(_) => TsServer::LABEL.into(),
            Server::Lsp(s) => s.label.clone(),
        }
    }
    pub fn sync(&self, file: &Path, text: &str) -> Result<(), String> {
        match self {
            Server::Ts(s) => {
                s.sync(file, text);
                Ok(())
            }
            Server::Lsp(s) => s.sync(file, text),
        }
    }
    fn diagnostics(&self, file: &Path) -> Option<Arc<Vec<Diag>>> {
        match self {
            Server::Ts(s) => s.diags.lock().ok()?.get(file).cloned(),
            Server::Lsp(s) => s.diags.lock().ok()?.get(file).cloned(),
        }
    }
    fn kill(&self) {
        match self {
            Server::Ts(s) => s.dispose(),
            Server::Lsp(s) => s.dispose(),
        }
    }
}

enum Slot {
    Up(Server),
    Failed,
}

fn pool() -> &'static Mutex<HashMap<String, Slot>> {
    static POOL: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    POOL.get_or_init(Mutex::default)
}

/// Bumps when a server published diagnostics (the editor redraws when it changed).
static DIAG_GEN: AtomicU64 = AtomicU64::new(0);
type Hook<T> = OnceLock<Box<T>>;
static WAKE: Hook<dyn Fn() + Send + Sync> = OnceLock::new();
static APPLY: Hook<dyn Fn(WorkspaceEdit) -> bool + Send + Sync> = OnceLock::new();

/// `wake` runs when a server publishes diagnostics; `apply` takes a server's workspace/applyEdit (true: applied).
pub fn set_hooks(wake: impl Fn() + Send + Sync + 'static, apply: impl Fn(WorkspaceEdit) -> bool + Send + Sync + 'static) {
    let _ = WAKE.set(Box::new(wake));
    let _ = APPLY.set(Box::new(apply));
}

pub fn diag_generation() -> u64 {
    DIAG_GEN.load(Ordering::Relaxed)
}

fn diagnosed() {
    DIAG_GEN.fetch_add(1, Ordering::Relaxed);
    if let Some(w) = WAKE.get() {
        w();
    }
}

fn apply_edit(ws: WorkspaceEdit) -> bool {
    APPLY.get().is_some_and(|a| a(ws))
}

fn start_server(kind: &str, file: &Path, root: &Path) -> Option<Server> {
    let key = format!("{kind}:{}", root.display());
    let mut pool = pool().lock().ok()?;
    if let Some(Slot::Up(s)) = pool.get(&key) {
        if !s.dead() {
            return Some(s.clone());
        }
    } else if pool.contains_key(&key) {
        return None;
    }
    let started = if kind == "ts" { TsServer::start(file, root).map(Server::Ts) } else { spec_of(kind).and_then(|spec| Lsp::start(spec, root)).map(Server::Lsp) };
    pool.insert(key, started.clone().map_or(Slot::Failed, Slot::Up));
    started
}

fn running(kind: &str, root: &Path) -> Option<Result<Server, ()>> {
    match pool().lock().ok()?.get(&format!("{kind}:{}", root.display()))? {
        Slot::Up(s) => Some(Ok(s.clone())),
        Slot::Failed => Some(Err(())),
    }
}

/// Kills every server (on exit).
pub fn shutdown() {
    let all: Vec<Slot> = pool().lock().map(|mut p| p.drain().map(|(_, s)| s).collect()).unwrap_or_default();
    for s in all {
        if let Slot::Up(s) = s {
            s.kill();
        }
    }
}

/// The folder holding .git above `file`, else the file's folder.
pub fn git_root(file: &Path) -> PathBuf {
    crate::term::git_root(file).unwrap_or_else(|| file.parent().map(Path::to_path_buf).unwrap_or_default())
}

/// Runs a program to completion with a 10 s timeout: (exit code, stdout, stderr); -1 when it couldn't run.
pub fn run(cmd: &str, args: &[&str], cwd: &Path, input: Option<&str>) -> (i32, String, String) {
    let path = std::env::join_paths(crate::term::search_path()).unwrap_or_default();
    let spawned = Command::new(cmd).args(args).current_dir(cwd).env("PATH", path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let mut p = match spawned {
        Ok(p) => p,
        Err(e) => return (-1, String::new(), e.to_string()),
    };
    let input = input.unwrap_or("").to_string();
    let mut stdin = p.stdin.take();
    std::thread::spawn(move || stdin.as_mut().map(|s| s.write_all(input.as_bytes())));
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(mut r) = r {
                let _ = r.read_to_string(&mut s);
            }
            s
        })
    };
    let out = pipe(p.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
    let err = pipe(p.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>));
    let end = Instant::now() + fallback::TIMEOUT;
    let code = loop {
        match p.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(-1),
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = p.kill();
                let _ = p.wait();
                return (-1, out.join().unwrap_or_default(), "timed out".into());
            }
        }
    };
    (code, out.join().unwrap_or_default(), err.join().unwrap_or_default())
}

/// The ops tsserver has (TsServer.CAPS) — what `can` assumes before it started.
pub use tsserver::TsServer as Ts;

/// Per file: picks the provider of each operation, falling back when there is no server or it lacks the operation.
#[derive(Clone)]
pub struct Session {
    pub file: PathBuf,
    kind: Option<&'static str>,
    root: PathBuf,
    fallback: Arc<Fallback>,
}

pub enum Provider {
    Server(Server),
    Fallback(Arc<Fallback>),
}

impl Session {
    pub fn new(file: &Path, scope: Option<&str>) -> Session {
        let root = git_root(file);
        Session { file: file.to_path_buf(), kind: scope.and_then(kind_of_scope), fallback: Arc::new(Fallback::new(file, scope, &root)), root }
    }
    /// Without starting anything: does some provider offer `op`?
    pub fn can(&self, op: &str) -> bool {
        let Some(kind) = self.kind else { return self.fallback.can(op) };
        match running(kind, &self.root) {
            Some(Err(())) => self.fallback.can(op),
            Some(Ok(s)) if !s.dead() => s.can(op) || self.fallback.can(op),
            _ if kind == "ts" => Ts::CAPS.contains(&op) || self.fallback.can(op),
            _ => true,
        }
    }
    /// The server, starting it on first use.
    pub fn server(&self) -> Option<Server> {
        start_server(self.kind?, &self.file, &self.root)
    }
    /// The provider for `op`, starting the server on first use.
    pub fn provider(&self, op: &str) -> Option<Provider> {
        if let Some(s) = self.server().filter(|s| s.can(op)) {
            return Some(Provider::Server(s));
        }
        self.fallback.can(op).then(|| Provider::Fallback(self.fallback.clone()))
    }
    /// The running server, if any (without starting one).
    fn live(&self) -> Option<Server> {
        running(self.kind?, &self.root)?.ok().filter(|s| !s.dead())
    }
    /// The server for `op` with the text synced, or an error naming what is missing.
    fn synced(&self, op: &str, ctx: &Ctx) -> Result<Provider, String> {
        let p = self.provider(op).ok_or_else(|| format!("No {op} provider for {}.", ctx.language))?;
        if let Provider::Server(s) = &p {
            s.sync(&ctx.file, &ctx.text())?;
        }
        Ok(p)
    }
    fn server_for(&self, op: &str, ctx: &Ctx) -> Result<Server, String> {
        match self.synced(op, ctx)? {
            Provider::Server(s) => Ok(s),
            Provider::Fallback(_) => Err(format!("No {op} provider for {}.", ctx.language)),
        }
    }

    /// definition | typeDefinition | implementation | references
    pub fn locate(&self, kind: &str, ctx: &Ctx) -> Result<Vec<Loc>, String> {
        match self.synced(kind, ctx)? {
            Provider::Fallback(f) => Ok(if kind == "definition" { f.definition(ctx) } else { f.references(ctx) }),
            Provider::Server(Server::Ts(s)) => s.locate(kind, ctx),
            Provider::Server(Server::Lsp(s)) => s.locate(kind, ctx),
        }
    }
    /// True when Rename goes to a server (else it is Change All Occurrences in this file).
    pub fn renames(&self) -> bool {
        matches!(self.provider("rename"), Some(Provider::Server(_)))
    }
    pub fn rename(&self, ctx: &Ctx, name: &str) -> Result<WorkspaceEdit, String> {
        match self.server_for("rename", ctx)? {
            Server::Ts(s) => s.rename(ctx, name),
            Server::Lsp(s) => s.rename(ctx, name),
        }
    }
    pub fn format(&self, ctx: &Ctx) -> Result<Vec<TextEdit>, String> {
        match self.synced("format", ctx)? {
            Provider::Fallback(f) => f.format(ctx),
            Provider::Server(Server::Ts(s)) => s.format(ctx, None),
            Provider::Server(Server::Lsp(s)) => s.format(ctx),
        }
    }
    /// The range formatter's edits for ctx.sel; None when there is none.
    pub fn format_range(&self, ctx: &Ctx) -> Result<Option<Vec<TextEdit>>, String> {
        if self.provider("formatRange").is_none() {
            return Ok(None);
        }
        match self.server_for("formatRange", ctx)? {
            Server::Ts(s) => s.format(ctx, Some(ctx.sel)).map(Some),
            Server::Lsp(s) => s.format_range(ctx),
        }
    }
    /// refactor | source | quickFix
    pub fn actions(&self, kind: &str, ctx: &Ctx) -> Result<Vec<Action>, String> {
        match self.server_for(kind, ctx)? {
            Server::Ts(s) => s.actions(kind, ctx),
            Server::Lsp(s) => s.actions(kind, ctx),
        }
    }
    pub fn resolve(&self, a: &Action) -> Result<WorkspaceEdit, String> {
        match (&a.resolve, self.server()) {
            (Resolve::Edit(ws), _) => Ok(ws.clone()),
            (Resolve::Lsp(v), Some(Server::Lsp(s))) => s.resolve_action(v),
            (Resolve::TsRefactor(v), Some(Server::Ts(s))) => s.refactor_edits(v),
            (Resolve::TsRequest(cmd, v), Some(Server::Ts(s))) => s.request_edits(cmd, v),
            _ => Err("The language server is gone".into()),
        }
    }
    /// Hover Markdown, None when the server has nothing.
    pub fn hover(&self, ctx: &Ctx) -> Result<Option<String>, String> {
        match self.server_for("hover", ctx)? {
            Server::Ts(s) => s.hover(ctx),
            Server::Lsp(s) => s.hover(ctx),
        }
    }
    /// Selection ranges at the cursor, innermost first.
    pub fn selection_ranges(&self, ctx: &Ctx) -> Result<Vec<(P16, P16)>, String> {
        match self.server_for("selectionRange", ctx)? {
            Server::Ts(s) => s.selection_ranges(ctx),
            Server::Lsp(s) => s.selection_ranges(ctx),
        }
    }
    pub fn workspace_symbols(&self, ctx: &Ctx, query: &str) -> Result<Vec<WsSymbol>, String> {
        match self.server_for("workspaceSymbols", ctx)? {
            Server::Ts(s) => s.workspace_symbols(ctx, query),
            Server::Lsp(s) => s.workspace_symbols(query),
        }
    }
    /// dir "incoming" | "outgoing"
    pub fn calls(&self, ctx: &Ctx, dir: &str) -> Result<Vec<Loc>, String> {
        match self.server_for("callHierarchy", ctx)? {
            Server::Ts(s) => s.calls(ctx, dir),
            Server::Lsp(s) => s.calls(ctx, dir),
        }
    }
    /// Go to Symbol / breadcrumbs: (source label, symbols) from the server (started here, which also gives it the
    /// current text and so keeps its diagnostics current), else the regex outline.
    pub fn symbols(&self, ctx: &Ctx) -> (String, Vec<Symbol>) {
        if let Some(s) = self.server() {
            if s.sync(&ctx.file, &ctx.text()).is_ok() && s.can("symbols") {
                let r = match &s {
                    Server::Ts(t) => t.symbols(ctx),
                    Server::Lsp(l) => l.symbols(ctx),
                };
                if let Ok(items) = r {
                    return (s.label(), items);
                }
            }
        }
        (Fallback::LABEL.into(), crate::symbols::outline(&ctx.lines))
    }
    /// Semantic tokens of the synced text: (line, UTF-16 start, length, token type, modifiers) per token, with the
    /// server's legend. None when the server has none.
    pub fn semantic_tokens(&self, ctx: &Ctx) -> Option<semantic::Tokens> {
        let s = self.live()?;
        s.sync(&ctx.file, &ctx.text()).ok()?;
        match s {
            Server::Ts(t) => t.semantic_tokens(ctx),
            Server::Lsp(l) => l.semantic_tokens(ctx),
        }
    }
    /// What the running server last reported for this file.
    pub fn diagnostics(&self) -> Option<Arc<Vec<Diag>>> {
        self.live()?.diagnostics(&self.file)
    }
    /// Tells a running server about a file's new text (edits written outside it); None: read it from disk.
    pub fn touch(&self, file: &Path, text: Option<String>) {
        let Some(s) = self.live() else { return };
        let text = text.or_else(|| {
            let t = std::fs::read_to_string(file).ok()?.replace("\r\n", "\n").replace('\r', "\n");
            Some(t.strip_suffix('\n').map(str::to_string).unwrap_or(t))
        });
        if let Some(t) = text {
            let _ = s.sync(file, &t);
        }
    }
    pub fn saved(&self, file: &Path) {
        if let Some(Server::Lsp(s)) = self.live() {
            s.saved(file);
        }
    }
}
