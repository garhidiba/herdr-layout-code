//! vscode-core: the vscode-explorer and vscode-scm mods' git and folder reads in one process, as JSON
//! in the shapes the mods build. Prints one JSON document; on failure `{"error": …}` and exit code 1.
//! Never writes to a repo (see git.rs).

mod collate;
mod git;
mod graph;
mod par;
mod repos;
mod tree;

use git::Status;
use serde::Serialize;
use serde_json::{json, Value};
use std::thread;

const COMMITS: usize = 300;
const FILES: usize = 1000;

const USAGE: &str = "usage: vscode-core <command>
  repos <root>
  status <repo>
  log <repo> [--upstream <ref>] [-n 300] [--graph]
  repo <repo> [--upstream <ref>]
  commit-files <repo> <hash>
  tree <dir> [--expanded p1,p2,...]
  all <root> [--expanded p1,p2,...] [--repo <current>]
  --version";

struct Args {
    positional: Vec<String>,
    upstream: Option<String>,
    n: usize,
    graph: bool,
    expanded: Vec<String>,
    repo: Option<String>,
}

fn parse_args(raw: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut a = Args { positional: vec![], upstream: None, n: COMMITS, graph: false, expanded: vec![], repo: None };
    let mut raw = raw.peekable();
    while let Some(arg) = raw.next() {
        let mut value = || raw.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--upstream" => a.upstream = Some(value()?),
            "-n" => a.n = value()?.parse().map_err(|_| "-n needs a number")?,
            "--graph" => a.graph = true,
            "--expanded" => a.expanded.extend(value()?.split(',').filter(|p| !p.is_empty()).map(str::to_string)),
            "--repo" => a.repo = Some(value()?),
            _ if arg.starts_with('-') && arg != "--version" => return Err(format!("unknown option {arg}\n{USAGE}")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

#[derive(Serialize)]
struct Change {
    path: String,
    status: &'static str,
}

/// vscode-scm's changes list: the first 1,000 entries of `status --untracked-files=all`.
fn changes(s: &Status) -> Value {
    let files: Vec<Change> = s.entries.iter().take(FILES).map(|(xy, path)| Change { path: path.clone(), status: git::git_letter(xy) }).collect();
    json!({ "files": files, "limited": s.entries.len() > FILES })
}

/// vscode-scm's `readRepo()`: `changes` with `hasHead` and the graph (none without a HEAD).
fn repo_data(mut changes: Value, has_head: bool, commits: Vec<graph::Row>) -> Value {
    changes["hasHead"] = has_head.into();
    changes["commits"] = json!(if has_head { commits } else { vec![] });
    changes
}

/// One repo's changes and graph, status and log read in parallel. A failed status fails the read; a
/// failed log (no HEAD yet) is an empty graph, as in the mod.
fn repo_cmd(root: &str, upstream: Option<&str>) -> Result<Value, String> {
    let (status, commits) = thread::scope(|s| {
        let commits = s.spawn(|| git::log(root, upstream, COMMITS).map(graph::graph).unwrap_or_default());
        (git::status(root, "all", false), commits.join().unwrap_or_default())
    });
    let status = status?;
    Ok(repo_data(changes(&status), status.oid != "(initial)", commits))
}

fn log_value(repo: &str, upstream: Option<&str>, n: usize, with_graph: bool) -> Result<Value, String> {
    let commits = git::log(repo, upstream, n)?;
    Ok(if with_graph { json!(graph::graph(commits)) } else { json!(commits) })
}

/// The folder's own repo and the repos found below it, read in parallel.
fn discover(root: &str) -> (String, Vec<String>) {
    thread::scope(|s| {
        let top = s.spawn(|| git::toplevel(root));
        let found = repos::find(root);
        (top.join().unwrap_or_default(), found)
    })
}

fn repos_value(root: &str) -> Value {
    let (top, found) = discover(root);
    let list = repos::ordered(&top, &found);
    let statuses = par::map(&list, |r| git::status(r, "normal", true).ok());
    let rows: Vec<_> = list.iter().zip(&statuses).filter_map(|(p, s)| repos::repo(p, s.as_ref())).collect();
    json!(repos::Repos { top, repos: rows })
}

fn tree_value(top: &str, own: Option<&Status>, nested: &[(&str, Option<&Status>)], listed: (serde_json::Map<String, Value>, bool)) -> Value {
    let marks = tree::marks(top, own, nested);
    let dirty = tree::dirty(&marks);
    json!({ "entries": listed.0, "limited": listed.1, "marks": marks, "dirty": dirty })
}

fn tree_cmd(root: &str, expanded: &[String]) -> Result<Value, String> {
    let (listed, (top, found)) = thread::scope(|s| {
        let listed = s.spawn(|| tree::listings(root, expanded));
        let found = discover(root);
        (listed.join().unwrap_or_else(|_| Err("listing failed".into())), found)
    });
    let listed = listed?;
    let mut jobs: Vec<(&str, &str)> = found.iter().map(|r| (r.as_str(), "normal")).collect();
    if !top.is_empty() {
        jobs.push((root, "all"));
    }
    let mut statuses = par::map(&jobs, |(r, untracked)| git::status(r, untracked, false).ok());
    let own = if top.is_empty() { None } else { statuses.pop().flatten() };
    let nested: Vec<_> = found.iter().map(String::as_str).zip(statuses.iter().map(Option::as_ref)).collect();
    Ok(tree_value(&top, own.as_ref(), &nested, listed))
}

/// Everything a space shows at once: the tree with its git marks, the repos, and the picked repo's
/// changes and graph. Each repo's status is read once and serves both the repo list and the marks.
fn all_cmd(root: &str, expanded: &[String], current: Option<&str>) -> Result<Value, String> {
    let (listed, (top, found)) = thread::scope(|s| {
        let listed = s.spawn(|| tree::listings(root, expanded));
        let found = discover(root);
        (listed.join().unwrap_or_else(|_| Err("listing failed".into())), found)
    });
    let listed = listed?;
    let list = repos::ordered(&top, &found);
    let mut jobs: Vec<(&str, &str)> = list.iter().chain(found.iter().filter(|f| !list.contains(f))).map(|r| (r.as_str(), "normal")).collect();
    if !top.is_empty() {
        jobs.push((root, "all"));
    }
    let mut statuses = par::map(&jobs, |(r, untracked)| git::status(r, untracked, *untracked == "normal").ok());
    let own = if top.is_empty() { None } else { statuses.pop().flatten() };
    let by_path = |p: &str| jobs.iter().position(|(r, _)| *r == p).and_then(|i| statuses[i].as_ref());

    let rows: Vec<_> = list.iter().filter_map(|p| repos::repo(p, by_path(p))).collect();
    let nested: Vec<_> = found.iter().map(|r| (r.as_str(), by_path(r))).collect();
    let tree = tree_value(&top, own.as_ref(), &nested, listed);

    let picked = repos::pick(&rows, &top, current).cloned();
    let repo = picked.as_ref().map(|r| {
        let upstream = r.upstream.as_deref().filter(|_| r.ahead.is_some());
        let has_head = r.oid != "(initial)";
        let (status, commits) = thread::scope(|s| {
            let commits = s.spawn(|| if has_head { git::log(&r.path, upstream, COMMITS).map(graph::graph).unwrap_or_default() } else { vec![] });
            let status = if r.path == top { own.as_ref().map(|s| Ok(changes(s))).unwrap_or_else(|| Err("no status".into())) } else { git::status(&r.path, "all", false).map(|s| changes(&s)) };
            (status, commits.join().unwrap_or_default())
        });
        status.map(|v| repo_data(v, has_head, commits))
    });
    let mut out = json!({ "tree": tree, "repos": repos::Repos { top, repos: rows }, "selected": picked.map(|r| r.path), "repo": Value::Null });
    match repo {
        Some(Ok(v)) => out["repo"] = v,
        Some(Err(e)) => out["repoError"] = e.into(),
        None => {}
    }
    Ok(out)
}

fn version() -> Value {
    let git = git::git(".", &["--version"]).filter(|o| o.ok).map(|o| o.stdout.trim().trim_start_matches("git version ").to_string());
    json!({ "version": env!("CARGO_PKG_VERSION"), "backend": "git", "git": git })
}

fn run(a: Args) -> Result<Value, String> {
    let p = |i: usize| a.positional.get(i).map(String::as_str).ok_or_else(|| USAGE.to_string());
    match p(0)? {
        "--version" => Ok(version()),
        "repos" => Ok(repos_value(p(1)?)),
        "status" => {
            let s = git::status(p(1)?, "all", false)?;
            let mut v = changes(&s);
            v["hasHead"] = (s.oid != "(initial)").into();
            Ok(v)
        }
        "log" => log_value(p(1)?, a.upstream.as_deref(), a.n, a.graph),
        "repo" => repo_cmd(p(1)?, a.upstream.as_deref()),
        "commit-files" => Ok(json!(git::commit_files(p(1)?, p(2)?)?.into_iter().take(FILES).collect::<Vec<_>>())),
        "tree" => tree_cmd(p(1)?, &a.expanded),
        "all" => all_cmd(p(1)?, &a.expanded, a.repo.as_deref()),
        other => Err(format!("unknown command {other}\n{USAGE}")),
    }
}

fn main() {
    match parse_args(std::env::args().skip(1)).and_then(run) {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", json!({ "error": e }));
            std::process::exit(1);
        }
    }
}
