//! The git repos of a folder, as vscode-scm's REPOS script and `parseRepos` find them.

use crate::git::Status;
use crate::par;
use serde::Serialize;
use std::fs;

pub const MAX: usize = 200;
const DEPTH: usize = 3;

/// `find <root> -maxdepth 3 -name .git -prune | head -200 | sed s#/.git$##`: the repos below `root`
/// in find's order (each folder's entries in directory order, depth first; symlinks not followed).
pub fn find(root: &str) -> Vec<String> {
    let entries = read(root);
    let mut found: Vec<String> = par::map(&entries, |(name, dir)| {
        let mut out = vec![];
        visit(root, name, *dir, 1, &mut out);
        out
    })
    .concat();
    found.truncate(MAX);
    found
}

fn read(dir: &str) -> Vec<(String, bool)> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    rd.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().is_ok_and(|t| t.is_dir()))).collect()
}

fn visit(parent: &str, name: &str, dir: bool, depth: usize, out: &mut Vec<String>) {
    if name == ".git" {
        out.push(parent.to_string());
    } else if dir && depth < DEPTH {
        let path = format!("{parent}/{name}");
        for (n, d) in read(&path) {
            visit(&path, &n, d, depth + 1, out);
        }
    }
}

/// The folder's own repo first, then the found ones sorted (as `sort` in the caller's locale), 200 at most.
pub fn ordered(top: &str, found: &[String]) -> Vec<String> {
    let mut sorted = found.to_vec();
    sorted.sort_by(|a, b| crate::collate::compare(a, b));
    let mut list: Vec<String> = vec![];
    for r in (!top.is_empty()).then_some(top.to_string()).into_iter().chain(sorted) {
        if !list.contains(&r) {
            list.push(r);
        }
    }
    list.truncate(MAX);
    list
}

#[derive(Serialize, Clone)]
pub struct Repo {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub oid: String,
    pub dirty: bool,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub upstream: Option<String>,
}

#[derive(Serialize)]
pub struct Repos {
    pub top: String,
    pub repos: Vec<Repo>,
}

/// A repo row from its status; None when git could not read it (as `parseRepos` drops rows with no branch).
pub fn repo(path: &str, status: Option<&Status>) -> Option<Repo> {
    let s = status.filter(|s| !s.head.is_empty())?;
    Some(Repo {
        path: path.to_string(),
        name: path.rsplit('/').next().unwrap_or_default().to_string(),
        branch: s.head.clone(),
        oid: s.oid.clone(),
        dirty: !s.entries.is_empty(),
        ahead: s.ab.map(|ab| ab.0),
        behind: s.ab.map(|ab| ab.1),
        upstream: s.upstream.clone(),
    })
}

/// Keeps the current choice while it exists; else the folder's own repo, the first dirty one, the first.
pub fn pick<'a>(repos: &'a [Repo], top: &str, current: Option<&str>) -> Option<&'a Repo> {
    current
        .and_then(|c| repos.iter().find(|r| r.path == c))
        .or_else(|| repos.iter().find(|r| r.path == top))
        .or_else(|| repos.iter().find(|r| r.dirty))
        .or_else(|| repos.first())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(path: &str, dirty: bool) -> Repo {
        Repo { path: path.into(), name: String::new(), branch: "main".into(), oid: String::new(), dirty, ahead: None, behind: None, upstream: None }
    }

    #[test]
    fn the_own_repo_comes_first_then_the_rest_sorted_without_repeats() {
        let found = ["/p/b".to_string(), "/p".to_string(), "/p/a".to_string()];
        assert_eq!(ordered("/p", &found), ["/p", "/p/a", "/p/b"]);
        assert_eq!(ordered("", &found), ["/p", "/p/a", "/p/b"]);
    }

    #[test]
    fn at_most_200_repos_are_listed() {
        let found: Vec<String> = (0..300).map(|i| format!("/p/{i:03}")).collect();
        let list = ordered("/top", &found);
        assert_eq!((list.len(), list[0].as_str(), list[199].as_str()), (200, "/top", "/p/198"));
    }

    #[test]
    fn picking_prefers_the_current_then_own_then_dirty_then_first() {
        let repos = [row("/a", false), row("/b", true), row("/c", false)];
        assert_eq!(pick(&repos, "/c", Some("/a")).unwrap().path, "/a");
        assert_eq!(pick(&repos, "/c", Some("/gone")).unwrap().path, "/c");
        assert_eq!(pick(&repos, "", None).unwrap().path, "/b");
        assert_eq!(pick(&repos[..1], "", None).unwrap().path, "/a");
        assert!(pick(&[], "", None).is_none());
    }

    #[test]
    fn a_repo_git_cannot_read_is_dropped() {
        assert!(repo("/x", None).is_none());
        let s = Status { oid: "abc".into(), head: "main".into(), upstream: Some("origin/main".into()), ab: Some((1, 2)), entries: vec![("??".into(), "f".into())] };
        let r = repo("/p/x", Some(&s)).unwrap();
        assert_eq!((r.name.as_str(), r.dirty, r.ahead, r.behind), ("x", true, Some(1), Some(2)));
    }
}
