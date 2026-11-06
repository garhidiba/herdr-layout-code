//! The git commands the mods run, and their parsers. Every call is a read: no index refresh or lock,
//! no fsmonitor cookie (the mods' folder watches would see a write and refresh again).

use serde::Serialize;
use std::process::{Command, Stdio};

const READ: [&str; 5] = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
pub const LOG_FORMAT: &str = "--format=%H%x00%P%x00%D%x00%s%x00%an%x00%ar%x1e";

pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `git` in `cwd`; None when it cannot start (no git, no such folder).
pub fn git(cwd: &str, args: &[&str]) -> Option<Output> {
    let out = Command::new("git").args(READ).args(args).current_dir(cwd).stdin(Stdio::null()).output().ok()?;
    Some(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// The repo holding `dir` (`git rev-parse --show-toplevel`), or "".
pub fn toplevel(dir: &str) -> String {
    match git(dir, &["rev-parse", "--show-toplevel"]) {
        Some(o) if o.ok => o.stdout.trim_end_matches('\n').to_string(),
        _ => String::new(),
    }
}

/// VS Code's decoration letter for a porcelain v1 `XY`.
pub fn git_letter(xy: &str) -> &'static str {
    if xy == "??" {
        "U"
    } else if xy.contains('U') || xy.contains("AA") || xy.contains("DD") {
        "!"
    } else if xy.contains('D') {
        "D"
    } else if xy.contains('A') {
        "A"
    } else {
        "M"
    }
}

/// `git status --porcelain=v2 -z --branch --no-renames`: the branch headers and the entries as v1 `XY` + path.
#[derive(Default)]
pub struct Status {
    pub oid: String,
    pub head: String,
    pub upstream: Option<String>,
    pub ab: Option<(u64, u64)>,
    pub entries: Vec<(String, String)>,
}

pub fn status(repo: &str, untracked: &str, ahead_behind: bool) -> Result<Status, String> {
    let untracked = format!("--untracked-files={untracked}");
    let mut args = vec!["status", "--porcelain=v2", "-z", "--branch", "--no-renames", untracked.as_str()];
    if !ahead_behind {
        args.push("--no-ahead-behind");
    }
    let out = git(repo, &args).ok_or_else(|| format!("Cannot run git in {repo}"))?;
    if !out.ok {
        return Err(out.stderr.trim().to_string());
    }
    Ok(parse_status(&out.stdout))
}

pub fn parse_status(text: &str) -> Status {
    let mut s = Status::default();
    for record in text.split('\0') {
        if let Some(v) = record.strip_prefix("# branch.oid ") {
            s.oid = v.to_string();
        } else if let Some(v) = record.strip_prefix("# branch.head ") {
            s.head = v.to_string();
        } else if let Some(v) = record.strip_prefix("# branch.upstream ") {
            s.upstream = Some(v.to_string());
        } else if let Some(v) = record.strip_prefix("# branch.ab ") {
            // As the mod's `Math.abs(Number(a)) || 0`.
            let n = |f: Option<&str>| f.and_then(|f| f.trim_start_matches(['+', '-']).parse().ok()).unwrap_or(0);
            let mut f = v.split(' ');
            s.ab = Some((n(f.next()), n(f.next())));
        } else if let Some(path) = record.strip_prefix("? ") {
            s.entries.push(("??".into(), path.to_string()));
        } else {
            // "1 XY sub mH mI mW hH hI path", "u XY sub m1 m2 m3 mW h1 h2 h3 path".
            let fields = match record.as_bytes().first() {
                Some(b'1') => 9,
                Some(b'u') => 11,
                _ => continue,
            };
            let parts: Vec<&str> = record.splitn(fields, ' ').collect();
            if let (Some(xy), Some(path)) = (parts.get(1), parts.get(fields - 1)) {
                s.entries.push((xy.replace('.', " "), path.to_string()));
            }
        }
    }
    s
}

#[derive(Serialize, Debug, PartialEq)]
pub struct File {
    pub status: &'static str,
    #[serde(rename = "oldPath", skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub path: String,
}

/// `git show --name-status -z`: renames and copies carry the old path first.
pub fn parse_name_status(text: &str) -> Vec<File> {
    let fields: Vec<&str> = text.split('\0').collect();
    let at = |i: usize| fields.get(i).map(|f| f.to_string());
    let mut files = vec![];
    let mut i = 0;
    while i < fields.len() {
        let code = fields[i].trim();
        if let Some(c) = code.chars().next() {
            if c == 'R' || c == 'C' {
                files.push(File { status: if c == 'R' { "R" } else { "A" }, old_path: at(i + 1), path: at(i + 2).unwrap_or_default() });
                i += 2;
            } else {
                let status = match c { 'A' => "A", 'D' => "D", 'U' => "!", _ => "M" };
                files.push(File { status, old_path: None, path: at(i + 1).unwrap_or_default() });
                i += 1;
            }
        }
        i += 1;
    }
    files.retain(|f| !f.path.is_empty());
    files
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Ref {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<bool>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub refs: Vec<Ref>,
    pub subject: String,
    pub author: String,
    pub date: String,
}

pub fn parse_log(text: &str) -> Vec<Commit> {
    text.split('\x1e')
        .map(|r| r.strip_prefix('\n').unwrap_or(r))
        .filter(|r| !r.is_empty())
        .map(|r| {
            let mut f = r.split('\0').map(str::to_string);
            let mut next = || f.next().unwrap_or_default();
            let hash = next();
            let parents = next();
            let refs = next();
            Commit {
                hash,
                parents: if parents.is_empty() { vec![] } else { parents.split(' ').map(str::to_string).collect() },
                refs: parse_refs(&refs),
                subject: next(),
                author: next(),
                date: next(),
            }
        })
        .collect()
}

fn parse_refs(d: &str) -> Vec<Ref> {
    if d.is_empty() {
        return vec![];
    }
    d.split(", ")
        .filter(|r| !r.ends_with("/HEAD"))
        .map(|r| {
            if let Some(name) = r.strip_prefix("HEAD -> ") {
                Ref { name: name.into(), head: Some(true), tag: None }
            } else if let Some(name) = r.strip_prefix("tag: ") {
                Ref { name: name.into(), head: None, tag: Some(true) }
            } else {
                Ref { name: r.into(), head: Some(r == "HEAD"), tag: None }
            }
        })
        .collect()
}

/// `git log --topo-order --date-order -n <n>` of HEAD (and `upstream`), parsed.
pub fn log(repo: &str, upstream: Option<&str>, n: usize) -> Result<Vec<Commit>, String> {
    let n = n.to_string();
    let mut args = vec!["log", "--topo-order", "--date-order", "-n", n.as_str(), LOG_FORMAT, "HEAD"];
    args.extend(upstream);
    args.push("--");
    let out = git(repo, &args).ok_or_else(|| format!("Cannot run git in {repo}"))?;
    if !out.ok {
        return Err(out.stderr.trim().to_string());
    }
    Ok(parse_log(&out.stdout))
}

/// A commit's changed files against its first parent.
pub fn commit_files(repo: &str, hash: &str) -> Result<Vec<File>, String> {
    let out = git(repo, &["show", "--name-status", "-z", "--format=", "-M", "-m", "--first-parent", hash]).ok_or_else(|| format!("Cannot run git in {repo}"))?;
    if !out.ok {
        return Err(out.stderr.trim().to_string());
    }
    Ok(parse_name_status(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_follow_vs_code_decorations() {
        assert_eq!(git_letter("??"), "U");
        assert_eq!(git_letter("UU"), "!");
        assert_eq!(git_letter("AA"), "!");
        assert_eq!(git_letter("DD"), "!");
        assert_eq!(git_letter(" D"), "D");
        assert_eq!(git_letter("AD"), "D");
        assert_eq!(git_letter("A "), "A");
        assert_eq!(git_letter(" M"), "M");
        assert_eq!(git_letter(" T"), "M");
    }

    #[test]
    fn porcelain_v2_reads_headers_and_entries_as_v1() {
        let text = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0\
            1 .M N... 100644 100644 100644 a b src/a b.rs\0u UU N... 1 2 3 4 h1 h2 h3 conflict.txt\0? new dir/\0! ignored\0";
        let s = parse_status(text);
        assert_eq!((s.oid.as_str(), s.head.as_str(), s.upstream.as_deref(), s.ab), ("abc", "main", Some("origin/main"), Some((2, 3))));
        assert_eq!(s.entries, vec![(" M".into(), "src/a b.rs".into()), ("UU".into(), "conflict.txt".into()), ("??".into(), "new dir/".into())]);
    }

    #[test]
    fn a_new_repo_has_no_upstream_and_no_head() {
        let s = parse_status("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!((s.oid.as_str(), s.upstream, s.ab, s.entries.len()), ("(initial)", None, None, 0));
    }

    #[test]
    fn name_status_keeps_old_paths_of_renames_and_copies() {
        let files = parse_name_status("\nM\0a.txt\0R100\0old.rs\0new.rs\0C075\0src.rs\0copy.rs\0T\0link\0U\0c\0");
        let shape: Vec<_> = files.iter().map(|f| (f.status, f.old_path.as_deref(), f.path.as_str())).collect();
        assert_eq!(shape, vec![("M", None, "a.txt"), ("R", Some("old.rs"), "new.rs"), ("A", Some("src.rs"), "copy.rs"), ("M", None, "link"), ("!", None, "c")]);
    }

    #[test]
    fn log_records_split_refs_and_drop_remote_heads() {
        let text = "h1\0p1 p2\0HEAD -> main, origin/main, origin/HEAD, tag: v1\0Merge\0Ann\x003 days ago\x1e\nh2\0\0\0Init\0Bob\x001 year ago\x1e\n";
        let log = parse_log(text);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].parents, ["p1", "p2"]);
        assert_eq!(log[0].refs, vec![
            Ref { name: "main".into(), head: Some(true), tag: None },
            Ref { name: "origin/main".into(), head: Some(false), tag: None },
            Ref { name: "v1".into(), head: None, tag: Some(true) },
        ]);
        assert!(log[1].parents.is_empty() && log[1].refs.is_empty());
        assert_eq!(log[1].date, "1 year ago");
    }
}
