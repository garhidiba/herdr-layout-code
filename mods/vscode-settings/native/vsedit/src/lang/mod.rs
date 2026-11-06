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
        "source.yaml" => "yaml",
        "source.toml" => "toml",
        "source.python" => "python",
        "source.shell" => "shell",
        "source.go" => "go",
        "source.dockerfile" => "dockerfile",
        "text.html.markdown" => "markdown",
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
    let home = crate::settings::home_dir();
    let bin = |name: &str, dir: PathBuf| {
        let own = dir.join(name);
        if own.is_file() { Some(own) } else { crate::term::which(name) }
    };
    let on_path = |name: &str, args: &[&str]| crate::term::which(name).map(|b| (b, args.iter().map(|a| a.to_string()).collect::<Vec<_>>()));
    // VS Code's own JSON/CSS/HTML servers: Devin.app's copies, else vscode-langservers-extracted's.
    let vscode = |name: &str, main: &str| -> Option<(PathBuf, Vec<String>)> {
        let server = PathBuf::from(DEVIN).join(format!("{name}-language-features/server/dist/node/{main}"));
        if server.is_file() {
            return Some((crate::term::which("node").unwrap_or_else(|| "node".into()), vec![server.to_string_lossy().into_owned(), "--stdio".into()]));
        }
        on_path(&format!("vscode-{name}-language-server"), &["--stdio"])
    };
    let spec = |label, (cmd, args): (PathBuf, Vec<String>), language_id, init| Some(Spec { label, cmd, args, language_id, init });
    let fmt = serde_json::json!({ "provideFormatter": true });
    match kind {
        "rust" => spec("rust-analyzer", (bin("rust-analyzer", home.join(".cargo/bin"))?, vec![]), |_| "rust".into(), Value::Null),
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
        "yaml" => spec("YAML language server", on_path("yaml-language-server", &["--stdio"])?, |_| "yaml".into(), Value::Null),
        "toml" => spec("Taplo", on_path("taplo", &["lsp", "stdio"])?, |_| "toml".into(), Value::Null),
        "python" => spec("Python language server", on_path("basedpyright-langserver", &["--stdio"]).or_else(|| on_path("pyright-langserver", &["--stdio"]))?, |_| "python".into(), Value::Null),
        "shell" => spec("Bash language server", on_path("bash-language-server", &["start"])?, |_| "shellscript".into(), Value::Null),
        "go" => spec("gopls", (bin("gopls", home.join("go/bin"))?, vec![]), |_| "go".into(), Value::Null),
        "dockerfile" => spec("Dockerfile language server", on_path("docker-langserver", &["--stdio"])?, |_| "dockerfile".into(), Value::Null),
        "markdown" => spec("Marksman", on_path("marksman", &["server"])?, |_| "markdown".into(), Value::Null),
        _ => None,
    }
}

const LANGSERVERS: &[(&str, &str)] = &[("npm", "npm i -g vscode-langservers-extracted")];

/// A server kind's name and its installers: (tool, command) pairs, the first whose tool is on PATH is offered when the
/// server is missing (lang/index.cjs's `install`).
fn installers(kind: &str) -> Option<(&'static str, &'static [(&'static str, &'static str)])> {
    Some(match kind {
        "rust" => ("rust-analyzer", &[("rustup", "rustup component add rust-analyzer"), ("brew", "brew install rust-analyzer")]),
        "json" => ("JSON language server", LANGSERVERS),
        "css" => ("CSS language server", LANGSERVERS),
        "html" => ("HTML language server", LANGSERVERS),
        "yaml" => ("YAML language server", &[("npm", "npm i -g yaml-language-server"), ("brew", "brew install yaml-language-server")]),
        "toml" => ("Taplo", &[("brew", "brew install taplo"), ("cargo", "cargo install taplo-cli --locked --features lsp")]),
        "python" => ("Python language server", &[("pipx", "pipx install basedpyright"), ("npm", "npm i -g basedpyright"), ("brew", "brew install basedpyright")]),
        "shell" => ("Bash language server", &[("npm", "npm i -g bash-language-server"), ("brew", "brew install bash-language-server")]),
        "go" => ("gopls", &[("go", "go install golang.org/x/tools/gopls@latest"), ("brew", "brew install gopls")]),
        "dockerfile" => ("Dockerfile language server", &[("npm", "npm i -g dockerfile-language-server-nodejs")]),
        "markdown" => ("Marksman", &[("brew", "brew install marksman")]),
        _ => return None,
    })
}

/// How to install a missing server here.
#[derive(Clone, Debug, PartialEq)]
pub struct InstallHint {
    pub kind: &'static str,
    pub label: &'static str,
    pub command: &'static str,
}

/// The missing server of `kind` and how to install it, when one of its installers' tools is on this machine (`has`; the
/// editor's PATH, so a remote editor names its own machine's tools); None when the server is there or nothing here can
/// install it.
pub fn install_hint(kind: &'static str, has: &dyn Fn(&str) -> bool) -> Option<InstallHint> {
    let (label, list) = installers(kind)?;
    if spec_of(kind).is_some() {
        return None;
    }
    let (_, command) = list.iter().find(|(tool, _)| has(tool))?;
    Some(InstallHint { kind, label, command })
}

/// The status bar's install offer per server kind, decided once a session; None once taken (or nothing to offer).
fn offers() -> &'static Mutex<HashMap<&'static str, Option<InstallHint>>> {
    static OFFERS: OnceLock<Mutex<HashMap<&'static str, Option<InstallHint>>>> = OnceLock::new();
    OFFERS.get_or_init(Mutex::default)
}

/// The install offer for a session's missing server, looked up the first time its kind is seen (VS Code's extension
/// recommendations: once per language a session). Blocks on PATH lookups: call it off the editor's thread.
pub fn offer(s: &Session) -> Option<InstallHint> {
    let kind = s.kind?;
    if let Some(o) = offers().lock().ok()?.get(kind) {
        return o.clone();
    }
    let hint = s.install_hint();
    offers().lock().ok()?.insert(kind, hint.clone());
    hint
}

/// The offer decided for `kind`, without looking anything up.
pub fn offered(kind: &str) -> Option<InstallHint> {
    offers().lock().ok()?.get(kind).cloned().flatten()
}

/// The offer for `kind` was taken: it isn't shown again this session.
pub fn take_offer(kind: &'static str) {
    if let Ok(mut o) = offers().lock() {
        o.insert(kind, None);
    }
}

/// What an install tab runs: `command` in `sh` with the launcher's tool folders on PATH, then how it ended, waiting for
/// Enter so the tab stays readable. The command is an argument, never spliced into the script.
pub fn install_argv(command: &str) -> Vec<String> {
    const SCRIPT: &str = r#"PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/go/bin"; export PATH; printf '$ %s\n' "$1"; sh -c "$1"; s=$?; echo; if [ "$s" -eq 0 ]; then echo "Installed. The editor starts it in a few seconds."; else echo "The install failed (exit $s)."; fi; printf 'Press Enter to close. '; read -r _"#;
    ["sh", "-c", SCRIPT, "sh", command].iter().map(|s| s.to_string()).collect()
}

/// Forgets that `kind`'s server was missing, so the next use looks for it again (after an install).
pub fn retry(kind: &str) {
    if let Ok(mut pool) = pool().lock() {
        pool.retain(|k, s| !(matches!(s, Slot::Failed) && k.starts_with(&format!("{kind}:"))));
    }
}

/// True when `kind`'s server can be started (its program is found).
pub fn found(kind: &str) -> bool {
    spec_of(kind).is_some()
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
        let kind = scope.and_then(kind_of_scope);
        // A server that isn't installed counts as failed from the start, so `can` answers with the fallback at once.
        if let Some(k) = kind.filter(|k| *k != "ts") {
            if let Ok(mut pool) = pool().lock() {
                let key = format!("{k}:{}", root.display());
                if !pool.contains_key(&key) && !found(k) {
                    pool.insert(key, Slot::Failed);
                }
            }
        }
        Session { file: file.to_path_buf(), kind, fallback: Arc::new(Fallback::new(file, scope, &root)), root }
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
    /// The server kind serving this file, if any.
    pub fn kind(&self) -> Option<&'static str> {
        self.kind
    }
    /// How to install this file's missing server, if it has one.
    pub fn install_hint(&self) -> Option<InstallHint> {
        install_hint(self.kind?, &|tool| crate::term::which(tool).is_some())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of fake servers named like the real ones (test/fake-lsp.cjs behind each name), put first on PATH.
    fn fake_servers(names: &[&str]) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("vsedit-fake-lsp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vscode-viewer/editor/test/fake-lsp.cjs");
        let node = crate::term::which("node").expect("node");
        for n in names {
            let f = dir.join(n);
            std::fs::write(&f, format!("#!/bin/sh\nexec \"{}\" \"{}\" \"{n}\" \"$@\"\n", node.display(), fake.display())).unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = std::env::var("PATH").unwrap_or_default();
        if !path.starts_with(&dir.to_string_lossy().into_owned()) {
            std::env::set_var("PATH", format!("{}:{path}", dir.display()));
        }
        dir
    }

    #[test]
    fn new_languages_start_their_servers_with_the_usual_commands_and_get_their_problems() {
        let cases = [
            ("a.yaml", "source.yaml", "yaml-language-server --stdio"),
            ("a.toml", "source.toml", "taplo lsp stdio"),
            ("a.py", "source.python", "basedpyright-langserver --stdio"),
            ("a.sh", "source.shell", "bash-language-server start"),
            ("a.go", "source.go", "gopls"),
            ("Dockerfile", "source.dockerfile", "docker-langserver --stdio"),
            ("a.md", "text.html.markdown", "marksman server"),
        ];
        let names: Vec<&str> = cases.iter().map(|c| c.2.split(' ').next().unwrap()).collect();
        let dir = fake_servers(&names);
        for (name, scope, command) in cases {
            let file = dir.join(name);
            std::fs::write(&file, "x\n").unwrap();
            let s = Session::new(&file, Some(scope));
            assert_eq!(s.install_hint(), None, "{name}: an install offered for a server that is there");
            s.server().expect(name).sync(&file, "x").unwrap();
            let end = Instant::now() + Duration::from_secs(5);
            while s.diagnostics().is_none_or(|d| d.is_empty()) && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(s.diagnostics().map(|d| d[0].message.clone()), Some(format!("fake {command}")), "{name}");
        }
        shutdown();
    }

    #[test]
    fn a_missing_servers_install_hint_takes_the_first_installer_whose_tool_is_here() {
        if ["yaml", "markdown", "dockerfile"].iter().any(|k| found(k)) {
            return; // a real server is installed
        }
        let brew_only = |tool: &str| tool == "brew";
        let hint = |kind, label, command| Some(InstallHint { kind, label, command });
        assert_eq!(install_hint("yaml", &brew_only), hint("yaml", "YAML language server", "brew install yaml-language-server"));
        assert_eq!(install_hint("yaml", &|_| true), hint("yaml", "YAML language server", "npm i -g yaml-language-server"), "npm comes first");
        assert_eq!(install_hint("markdown", &brew_only), hint("markdown", "Marksman", "brew install marksman"));
        assert_eq!(install_hint("dockerfile", &brew_only), None, "npm alone installs it");
        assert_eq!(install_hint("clangd", &|_| true), None, "no installer for a system server");
    }
}
