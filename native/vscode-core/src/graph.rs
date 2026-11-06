//! Lanes for a topo-ordered log, as vscode-scm's `graph()`: each lane waits for the commit it leads to.
//! Per row: which lanes have a line in the top half (from above) and the bottom half (going on below),
//! and which lanes join the node with a horizontal link (branches ending here, and merge parents).

use crate::git::Commit;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct Line {
    pub lane: usize,
    pub top: bool,
    pub bottom: bool,
}

#[derive(Serialize)]
pub struct Row {
    #[serde(flatten)]
    pub commit: Commit,
    pub col: usize,
    pub lines: Vec<Line>,
    pub links: Vec<usize>,
    pub width: usize,
    pub merge: bool,
}

pub fn graph(commits: Vec<Commit>) -> Vec<Row> {
    let mut lanes: Vec<Option<String>> = vec![];
    let find = |lanes: &[Option<String>], hash: &str| lanes.iter().position(|l| l.as_deref() == Some(hash));
    let free = |lanes: &mut Vec<Option<String>>| lanes.iter().position(Option::is_none).unwrap_or_else(|| {
        lanes.push(None);
        lanes.len() - 1
    });
    commits
        .into_iter()
        .map(|c| {
            let found = find(&lanes, &c.hash);
            let tip = found.is_none();
            let col = found.unwrap_or_else(|| {
                let col = free(&mut lanes);
                lanes[col] = Some(c.hash.clone());
                col
            });
            let before = lanes.clone();
            let mut links = vec![];
            for (i, lane) in lanes.iter_mut().enumerate() {
                if i != col && lane.as_deref() == Some(c.hash.as_str()) {
                    *lane = None;
                    links.push(i);
                }
            }
            lanes[col] = c.parents.first().cloned();
            for p in c.parents.iter().skip(1) {
                let k = find(&lanes, p).unwrap_or_else(|| {
                    let k = free(&mut lanes);
                    lanes[k] = Some(p.clone());
                    k
                });
                if k != col {
                    links.push(k);
                }
            }
            while lanes.last().is_some_and(Option::is_none) {
                lanes.pop();
            }
            let width = before.len().max(lanes.len());
            let lines = (0..width)
                .filter_map(|i| {
                    let top = if i == col { !tip } else { before.get(i).is_some_and(Option::is_some) };
                    let bottom = lanes.get(i).is_some_and(Option::is_some);
                    (top || bottom).then_some(Line { lane: i, top, bottom })
                })
                .collect();
            let merge = c.parents.len() > 1;
            Row { commit: c, col, lines, links, width, merge }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(hash: &str, parents: &[&str]) -> Commit {
        Commit { hash: hash.into(), parents: parents.iter().map(|p| p.to_string()).collect(), refs: vec![], subject: String::new(), author: String::new(), date: String::new() }
    }

    fn shape(rows: &[Row]) -> Vec<(usize, Vec<usize>, usize, bool)> {
        rows.iter().map(|r| (r.col, r.links.clone(), r.width, r.merge)).collect()
    }

    #[test]
    fn a_straight_history_stays_in_lane_zero() {
        let rows = graph(vec![commit("c", &["b"]), commit("b", &["a"]), commit("a", &[])]);
        assert_eq!(shape(&rows), vec![(0, vec![], 1, false), (0, vec![], 1, false), (0, vec![], 1, false)]);
        assert_eq!(rows[0].lines, vec![Line { lane: 0, top: false, bottom: true }]);
        assert_eq!(rows[2].lines, vec![Line { lane: 0, top: true, bottom: false }]);
    }

    #[test]
    fn a_merge_opens_a_lane_for_its_second_parent_and_closes_it_where_they_meet() {
        // m merges x into b; x and b both come from a.
        let rows = graph(vec![commit("m", &["b", "x"]), commit("x", &["a"]), commit("b", &["a"]), commit("a", &[])]);
        assert_eq!(shape(&rows), vec![(0, vec![1], 2, true), (1, vec![], 2, false), (0, vec![], 2, false), (0, vec![1], 2, false)]);
        assert_eq!(rows[1].lines, vec![Line { lane: 0, top: true, bottom: true }, Line { lane: 1, top: true, bottom: true }]);
    }

    #[test]
    fn a_second_branch_tip_takes_the_first_free_lane() {
        let rows = graph(vec![commit("b2", &["a"]), commit("c2", &["a"]), commit("a", &[])]);
        assert_eq!(shape(&rows), vec![(0, vec![], 1, false), (1, vec![], 2, false), (0, vec![1], 2, false)]);
    }
}
