//! Git change decorations (gitgutter.cjs, VS Code's quick diff): the buffer against the file's HEAD version as added /
//! modified / deleted hunks. `diff_hunks`, `marks_for` and `next_change` are pure; `GitGutter` reads HEAD on a thread,
//! diffs 300 ms after the last edit and reads HEAD again on save or when .git/HEAD, the index or the reflog change.

use crate::file::disk_stamp;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

pub const DELAY: Duration = Duration::from_millis(300);
const POLL: Duration = Duration::from_secs(3);
const MAX_LINES: usize = 200_000;
pub const MAX_EDITS: usize = 1000;
const GIT: &[&str] = &["--no-optional-locks", "-c", "core.fsmonitor=false"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Added,
    Modified,
    Deleted,
}

/// Buffer lines [start, end); a deletion is empty: lines were removed before `start`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hunk {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mark {
    Added,
    Modified,
    DeletedBelow,
    DeletedAbove,
}

/// Hunks of `lines` against `base`: common ends trimmed, past `limit` edits the rest of the middle is one change.
pub fn diff_hunks(base: &[String], lines: &[String], limit: usize) -> Vec<Hunk> {
    line_hunks(base, lines, limit)
        .into_iter()
        .map(|(a0, a1, b0, b1)| {
            let kind = if a0 == a1 { Kind::Added } else if b0 == b1 { Kind::Deleted } else { Kind::Modified };
            Hunk { kind, start: b0, end: b1 }
        })
        .collect()
}

/// The changed runs (a0, a1, b0, b1): base lines [a0, a1) became lines [b0, b1) (gitgutter.cjs lineHunks).
pub fn line_hunks<'a>(base: &'a [String], lines: &'a [String], limit: usize) -> Vec<(usize, usize, usize, usize)> {
    let (mut s, mut ea, mut eb) = (0, base.len(), lines.len());
    while s < ea && s < eb && base[s] == lines[s] {
        s += 1;
    }
    while ea > s && eb > s && base[ea - 1] == lines[eb - 1] {
        ea -= 1;
        eb -= 1;
    }
    if s == ea && s == eb {
        return vec![];
    }
    let mut ids: HashMap<&str, usize> = HashMap::new();
    let mut id = |t: &'a String| {
        let n = ids.len();
        *ids.entry(t.as_str()).or_insert(n)
    };
    let a: Vec<usize> = base[s..ea].iter().map(&mut id).collect();
    let b: Vec<usize> = lines[s..eb].iter().map(&mut id).collect();
    let ops = (!a.is_empty() && !b.is_empty()).then(|| myers(&a, &b, limit)).flatten().unwrap_or_else(|| {
        let mut o = vec![b'-'; a.len()];
        o.extend(vec![b'+'; b.len()]);
        o
    });
    let mut out = vec![];
    let (mut i, mut ia, mut j) = (0, s, s);
    while i < ops.len() {
        if ops[i] == b' ' {
            i += 1;
            ia += 1;
            j += 1;
            continue;
        }
        let (mut removed, mut added) = (0, 0);
        while i < ops.len() && ops[i] != b' ' {
            if ops[i] == b'-' {
                removed += 1;
            } else {
                added += 1;
            }
            i += 1;
        }
        out.push((ia, ia + removed, j, j + added));
        ia += removed;
        j += added;
    }
    out
}

/// Myers' O((N+M)D) diff as ops b' ', b'-', b'+'; None past `limit` steps.
fn myers(a: &[usize], b: &[usize], limit: usize) -> Option<Vec<u8>> {
    let (n, m) = (a.len() as i64, b.len() as i64);
    let max = n + m;
    let off = max + 1;
    let mut v = vec![0i64; (2 * max + 3) as usize];
    let mut trace: Vec<Vec<i64>> = vec![];
    for d in 0..=max.min(limit as i64) {
        trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let mut i = if k == -d || (k != d && v[(off + k - 1) as usize] < v[(off + k + 1) as usize]) { v[(off + k + 1) as usize] } else { v[(off + k - 1) as usize] + 1 };
            let mut j = i - k;
            while i < n && j < m && a[i as usize] == b[j as usize] {
                i += 1;
                j += 1;
            }
            v[(off + k) as usize] = i;
            if i >= n && j >= m {
                return Some(backtrack(&trace, n, m));
            }
            k += 2;
        }
    }
    None
}

fn backtrack(trace: &[Vec<i64>], n: i64, m: i64) -> Vec<u8> {
    let mut ops = vec![];
    let (mut i, mut j) = (n, m);
    for d in (1..trace.len() as i64).rev() {
        let prev = &trace[d as usize];
        let at = |kk: i64| prev[(kk + d) as usize];
        let k = i - j;
        let down = k == -d || (k != d && at(k - 1) < at(k + 1));
        let pk = if down { k + 1 } else { k - 1 };
        let pi = at(pk);
        let pj = pi - pk;
        while i > pi && j > pj {
            ops.push(b' ');
            i -= 1;
            j -= 1;
        }
        ops.push(if down { b'+' } else { b'-' });
        if down {
            j -= 1;
        } else {
            i -= 1;
        }
    }
    while i > 0 && j > 0 {
        ops.push(b' ');
        i -= 1;
        j -= 1;
    }
    ops.reverse();
    ops
}

/// The line a hunk shows on: a deletion sits below the line before it.
pub fn line_of(h: &Hunk) -> usize {
    if h.kind == Kind::Deleted {
        h.start.saturating_sub(1)
    } else {
        h.start
    }
}

/// Gutter marks of lines [first, last] (bars win over deletion markers).
pub fn marks_for(hunks: &[Hunk], first: usize, last: usize) -> HashMap<usize, Mark> {
    let mut out = HashMap::new();
    for h in hunks {
        if h.kind == Kind::Deleted {
            let l = line_of(h);
            if l >= first && l <= last {
                out.entry(l).or_insert(if h.start == 0 { Mark::DeletedAbove } else { Mark::DeletedBelow });
            }
            continue;
        }
        for l in h.start.max(first)..h.end.min(last + 1) {
            out.insert(l, if h.kind == Kind::Added { Mark::Added } else { Mark::Modified });
        }
    }
    out
}

/// The change below (dir 1) or above (-1) `line`, wrapping.
pub fn next_change(hunks: &[Hunk], line: usize, dir: i32) -> Option<Hunk> {
    if dir > 0 {
        hunks.iter().find(|h| line_of(h) > line).or(hunks.first()).copied()
    } else {
        hunks.iter().rev().find(|h| line_of(h) < line).or(hunks.last()).copied()
    }
}

fn git(args: &[&str], cwd: &Path) -> Option<String> {
    let out = Command::new("git").args(GIT).args(args).current_dir(cwd).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The HEAD version's lines (empty for a file new in the index; None: no repo or untracked) and the git dir.
fn read_head(file: &Path) -> (Option<Vec<String>>, Option<PathBuf>) {
    let dir = file.parent().unwrap_or(Path::new("/"));
    let Some(top) = git(&["rev-parse", "--show-toplevel", "--absolute-git-dir"], dir) else { return (None, None) };
    let mut it = top.lines();
    let (Some(root), Some(git_dir)) = (it.next(), it.next()) else { return (None, None) };
    let real = std::fs::canonicalize(file).unwrap_or_else(|_| std::fs::canonicalize(dir).unwrap_or(dir.to_path_buf()).join(file.file_name().unwrap_or_default()));
    let rel = real.strip_prefix(root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let root = Path::new(root);
    let base = match git(&["cat-file", "blob", &format!("HEAD:{rel}")], root) {
        Some(text) => {
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            let mut lines = crate::file::split_lines(text);
            if lines.len() > 1 && lines.last().is_some_and(String::is_empty) {
                lines.pop();
            }
            Some(lines)
        }
        None => git(&["ls-files", "--cached", "--", &rel], root).filter(|s| !s.trim().is_empty()).map(|_| vec![]),
    };
    (base, Some(PathBuf::from(git_dir)))
}

/// One file's decorations; the editor calls `tick` from its loop.
pub struct GitGutter {
    file: PathBuf,
    base: Option<Vec<String>>,
    pub hunks: Vec<Hunk>,
    started: bool,
    reads: u64,
    tx: Sender<(u64, Option<Vec<String>>, Option<PathBuf>)>,
    rx: Receiver<(u64, Option<Vec<String>>, Option<PathBuf>)>,
    git_dir: Option<PathBuf>,
    stamp: String,
    next_poll: Option<Instant>,
    pub diff_at: Option<Instant>,
}

impl GitGutter {
    pub fn new(file: &Path) -> GitGutter {
        let (tx, rx) = mpsc::channel();
        GitGutter { file: file.to_path_buf(), base: None, hunks: vec![], started: false, reads: 0, tx, rx, git_dir: None, stamp: String::new(), next_poll: None, diff_at: None }
    }

    /// Starts reading HEAD (once: the first frame that shows the file calls it).
    pub fn start(&mut self) {
        if !self.started {
            self.started = true;
            self.refresh();
        }
    }

    fn refresh(&mut self) {
        self.reads += 1;
        let (token, file, tx) = (self.reads, self.file.clone(), self.tx.clone());
        std::thread::spawn(move || {
            let (base, dir) = read_head(&file);
            if tx.send((token, base, dir)).is_ok() {
                crate::term::wake();
            }
        });
    }

    /// The buffer changed: diff again once edits pause.
    pub fn changed(&mut self) {
        if self.started {
            self.diff_at = Some(Instant::now() + DELAY);
        }
    }

    /// Recomputes the hunks; true when they changed.
    pub fn diff(&mut self, lines: &[String]) -> bool {
        self.diff_at = None;
        let hunks = match &self.base {
            Some(base) if lines.len() <= MAX_LINES && base.len() <= MAX_LINES => diff_hunks(base, lines, MAX_EDITS),
            _ => vec![],
        };
        let same = hunks == self.hunks;
        self.hunks = hunks;
        !same
    }

    pub fn saved(&mut self) {
        if self.started {
            self.refresh();
        }
    }

    fn stamp_of(&self) -> String {
        let Some(dir) = &self.git_dir else { return String::new() };
        ["HEAD", "index", "logs/HEAD"].iter().map(|f| disk_stamp(&dir.join(f)).map_or("-".into(), |s| format!("{}:{}", s.mtime_ms, s.size))).collect::<Vec<_>>().join(" ")
    }

    /// The earliest time `tick` has work.
    pub fn deadline(&self) -> Option<Instant> {
        [self.diff_at, self.next_poll].into_iter().flatten().min()
    }

    /// Takes HEAD reads, runs a due diff and the 3 s poll; true when the hunks changed.
    pub fn tick(&mut self, lines: &[String]) -> bool {
        let mut changed = false;
        while let Ok((token, base, dir)) = self.rx.try_recv() {
            if token != self.reads {
                continue;
            }
            self.base = base;
            changed |= self.diff(lines);
            if let Some(dir) = dir {
                self.git_dir = Some(dir);
                self.stamp = self.stamp_of();
                self.next_poll = Some(Instant::now() + POLL);
            }
        }
        let now = Instant::now();
        if self.diff_at.is_some_and(|t| t <= now) {
            changed |= self.diff(lines);
        }
        if self.next_poll.is_some_and(|t| t <= now) {
            self.next_poll = Some(now + POLL);
            let st = self.stamp_of();
            if st != self.stamp {
                self.stamp = st;
                self.refresh();
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn h(kind: Kind, start: usize, end: usize) -> Hunk {
        Hunk { kind, start, end }
    }

    #[test]
    fn added_modified_and_deleted_lines_become_hunks() {
        let base = lines(&["a", "b", "c", "d"]);
        assert_eq!(diff_hunks(&base, &lines(&["a", "X", "c", "d", "e"]), MAX_EDITS), vec![h(Kind::Modified, 1, 2), h(Kind::Added, 4, 5)]);
        assert_eq!(diff_hunks(&base, &lines(&["a", "d"]), MAX_EDITS), vec![h(Kind::Deleted, 1, 1)]);
        assert_eq!(diff_hunks(&base, &base, MAX_EDITS), vec![]);
        assert_eq!(diff_hunks(&[], &lines(&["x"]), MAX_EDITS), vec![h(Kind::Added, 0, 1)]);
    }

    #[test]
    fn past_the_limit_the_middle_is_one_change() {
        let base = lines(&["a", "1", "2", "z"]);
        assert_eq!(diff_hunks(&base, &lines(&["a", "3", "4", "z"]), 0), vec![h(Kind::Modified, 1, 3)]);
    }

    #[test]
    fn marks_and_navigation() {
        let hunks = [h(Kind::Deleted, 0, 0), h(Kind::Modified, 3, 5), h(Kind::Deleted, 8, 8)];
        let m = marks_for(&hunks, 0, 9);
        assert_eq!((m[&0], m[&3], m[&4], m[&7]), (Mark::DeletedAbove, Mark::Modified, Mark::Modified, Mark::DeletedBelow));
        assert_eq!(next_change(&hunks, 7, 1), Some(hunks[0]));
        assert_eq!(next_change(&hunks, 0, -1), Some(hunks[2]));
    }
}
