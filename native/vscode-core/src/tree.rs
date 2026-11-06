//! vscode-explorer's data: folder listings (`directory()` + `loadFolder`), git marks (`gitMarks`) and
//! the dirty folders above them (`dirtyOf`).

use crate::git::{git_letter, Status};
use crate::par;
use serde::Serialize;
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

pub const PER_FOLDER: usize = 500;
pub const TOTAL: usize = 5000;

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
}

/// The listing script: `"$1"/* "$1"/.[!.]* "$1"/..?*` (each glob sorted in the caller's locale) without `.git`,
/// 501 at most; links count as folders when they point at one. Errors when `path` is not a folder.
pub fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
    let Ok(rd) = fs::read_dir(path) else {
        return if Path::new(path).is_dir() { Ok(vec![]) } else { Err("Cannot list this folder".into()) };
    };
    let mut names: Vec<(u8, String, bool)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let group = if name.starts_with("..") { 2 } else { u8::from(name.starts_with('.')) };
            let dir = match e.file_type() {
                Ok(t) if t.is_symlink() => e.path().is_dir(),
                Ok(t) => t.is_dir(),
                Err(_) => false,
            };
            (name != ".git").then_some((group, name, dir))
        })
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| crate::collate::compare(&a.1, &b.1)));
    names.truncate(PER_FOLDER + 1);
    Ok(names.into_iter().map(|(_, name, dir)| Entry { name, dir }).collect())
}

/// Folders first, then names as the mods' QuickJS `localeCompare` orders them (NFC, by code point).
pub fn compare(a: &Entry, b: &Entry) -> Ordering {
    b.dir.cmp(&a.dir).then_with(|| a.name.nfc().cmp(b.name.nfc()))
}

/// The root's and each expanded folder's entries, as `loadFolder` keeps them: 500 per folder and
/// 5,000 in all (counted in the order listed), sorted. An expanded folder that cannot be listed is left out.
pub fn listings(root: &str, expanded: &[String]) -> Result<(Map<String, Value>, bool), String> {
    let folders: Vec<&str> = std::iter::once("").chain(expanded.iter().map(String::as_str).filter(|p| !p.is_empty())).collect();
    let lists = par::map(&folders, |p| list_dir(&if p.is_empty() { root.to_string() } else { format!("{root}/{p}") }));
    let (mut out, mut limited, mut used) = (Map::new(), false, 0);
    for (path, list) in folders.into_iter().zip(lists) {
        let list = match list {
            Ok(list) => list,
            Err(e) if path.is_empty() => return Err(e),
            Err(_) => continue,
        };
        if list.len() > PER_FOLDER || used + list.len() > TOTAL {
            limited = true;
        }
        let mut kept: Vec<Entry> = list.into_iter().take(PER_FOLDER.min(TOTAL.saturating_sub(used))).collect();
        kept.sort_by(compare);
        used += kept.len();
        out.insert(path.to_string(), serde_json::to_value(kept).expect("entries serialize"));
    }
    Ok((out, limited))
}

/// path → letter: the folder's own repo (`top`, all untracked files) first, then each nested repo's
/// entries (untracked folders collapsed) where not already marked. 5,000 entries per repo.
pub fn marks(top: &str, own: Option<&Status>, nested: &[(&str, Option<&Status>)]) -> Map<String, Value> {
    let mut marks = Map::new();
    if let Some(s) = own {
        for (xy, path) in s.entries.iter().take(TOTAL) {
            marks.insert(format!("{top}/{path}"), git_letter(xy).into());
        }
    }
    for (repo, s) in nested {
        for (xy, path) in s.iter().flat_map(|s| s.entries.iter().take(TOTAL)) {
            if path.is_empty() {
                continue;
            }
            let key = format!("{repo}/{}", path.strip_suffix('/').unwrap_or(path));
            marks.entry(key).or_insert_with(|| git_letter(xy).into());
        }
    }
    marks
}

fn rank(letter: &str) -> u8 {
    match letter {
        "U" | "A" => 1,
        "M" => 2,
        "D" => 3,
        "!" => 4,
        _ => 0,
    }
}

/// Every folder above a changed file takes the worst state below it; deletions color only themselves.
pub fn dirty(marks: &Map<String, Value>) -> Map<String, Value> {
    let mut dirty = Map::new();
    for (file, letter) in marks {
        let letter = letter.as_str().unwrap_or_default();
        if letter == "D" {
            continue;
        }
        let mut end = file.len();
        while let Some(i) = file[..end].rfind('/').filter(|&i| i > 0) {
            let folder = &file[..i];
            if dirty.get(folder).and_then(Value::as_str).map_or(0, rank) < rank(letter) {
                dirty.insert(folder.to_string(), letter.into());
            }
            end = i;
        }
    }
    dirty
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(name: &str, dir: bool) -> Entry {
        Entry { name: name.into(), dir }
    }

    #[test]
    fn folders_come_first_then_names_by_code_point_after_nfc() {
        let mut list = [e("b.txt", false), e("Zeta", false), e("src", true), e(".env", false), e("A", true), e("\u{1100}\u{1161}", false), e("\u{ac00}b", false)];
        list.sort_by(compare);
        let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
        // NFD "가" (U+1100 U+1161) composes to U+AC00, so it sorts with the precomposed name.
        assert_eq!(names, ["A", "src", ".env", "Zeta", "b.txt", "\u{1100}\u{1161}", "\u{ac00}b"]);
    }

    #[test]
    fn a_listing_skips_git_and_keeps_hidden_files_and_folder_links() {
        let dir = std::env::temp_dir().join(format!("vscode-core-list-{}", std::process::id()));
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join(".hidden"), "").unwrap();
        fs::write(dir.join("..odd"), "").unwrap();
        fs::write(dir.join("a.rs"), "").unwrap();
        std::os::unix::fs::symlink(dir.join("sub"), dir.join("link")).unwrap();
        std::os::unix::fs::symlink(dir.join("gone"), dir.join("dangling")).unwrap();
        let list = list_dir(dir.to_str().unwrap()).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(list, vec![e("a.rs", false), e("dangling", false), e("link", true), e("sub", true), e(".hidden", false), e("..odd", false)]);
        assert!(list_dir("/no/such/folder").is_err());
    }

    #[test]
    fn listings_cap_each_folder_at_500_and_report_the_limit() {
        let dir = std::env::temp_dir().join(format!("vscode-core-cap-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for i in 0..502 {
            fs::write(dir.join(format!("f{i:03}")), "").unwrap();
        }
        let (entries, limited) = listings(dir.to_str().unwrap(), &["missing".into()]).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert!(limited);
        assert_eq!(entries[""].as_array().unwrap().len(), 500);
        assert!(!entries.contains_key("missing"));
    }

    #[test]
    fn own_marks_win_and_nested_untracked_folders_lose_their_slash() {
        let own = Status { entries: vec![(" M".into(), "a/x.rs".into())], ..Default::default() };
        let sub = Status { entries: vec![("??".into(), "a/x.rs".into()), ("??".into(), "new/".into())], ..Default::default() };
        let m = marks("/r", Some(&own), &[("/r", Some(&sub))]);
        assert_eq!(serde_json::to_string(&m).unwrap(), r#"{"/r/a/x.rs":"M","/r/new":"U"}"#);
    }

    #[test]
    fn folders_take_the_worst_state_below_and_deletions_do_not_bubble() {
        let mut m = Map::new();
        m.insert("/r/a/new.rs".into(), "U".into());
        m.insert("/r/a/b/mod.rs".into(), "M".into());
        m.insert("/r/gone/old.rs".into(), "D".into());
        let d = dirty(&m);
        assert_eq!(serde_json::to_string(&d).unwrap(), r#"{"/r/a":"M","/r":"M","/r/a/b":"M"}"#);
    }
}
