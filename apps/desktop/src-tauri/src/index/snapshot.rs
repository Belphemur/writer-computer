//! The in-memory note graph (SPECs/note-graph-spec.md 5.3): a per-epoch snapshot of the distinct
//! resolved, non-self file pairs of `edges`, as two compressed-sparse-row adjacencies (petgraph
//! `Csr`, one per direction). Pure: it is built from rows, never touches SQLite, so every
//! algorithm here is testable on a handful of tuples.
//!
//! Nodes are the vault's files, numbered in path order, so a neighbour list is already sorted by
//! path. Graph analytics (paths, hubs, components) only walk markdown notes: an image two notes
//! embed must not make them neighbours.

use petgraph::csr::Csr;
use petgraph::unionfind::UnionFind;
use petgraph::Directed;
use std::collections::{HashMap, VecDeque};

type Adjacency = Csr<(), (), Directed, u32>;

/// A file of the vault as the snapshot needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRow {
    pub id: i64,
    pub path: String,
    pub is_note: bool,
}

/// One edge of a shortest path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathStep {
    pub from: u32,
    pub to: u32,
    /// The link points `from` to `to` (otherwise `to` links to `from`).
    pub forward: bool,
}

/// A node and its note-to-note degrees, for the hub ranking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hub {
    pub node: u32,
    pub degree_in: usize,
    pub degree_out: usize,
}

pub struct GraphSnapshot {
    /// The index epoch the rows were read at, for consumers that cache against it.
    pub epoch: u64,
    nodes: Vec<NodeRow>,
    by_path: HashMap<String, u32>,
    by_id: HashMap<i64, u32>,
    out: Adjacency,
    inn: Adjacency,
    pairs: usize,
}

fn adjacency(sorted_unique_pairs: &[(u32, u32)]) -> Adjacency {
    // The graph is sized to the highest node that has an edge; `neighbors` answers an empty
    // slice for the trailing nodes without one.
    Adjacency::from_sorted_edges(sorted_unique_pairs).expect("pairs are sorted")
}

fn neighbors(adj: &Adjacency, node: u32) -> &[u32] {
    if (node as usize) < adj.node_count() {
        adj.neighbors_slice(node)
    } else {
        &[]
    }
}

impl GraphSnapshot {
    /// `files` in any order, `pairs` as `(source file id, target file id)` with duplicates,
    /// self-links and ids not in `files` allowed (they are dropped).
    pub fn build(epoch: u64, mut files: Vec<NodeRow>, pairs: &[(i64, i64)]) -> Self {
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let by_id: HashMap<i64, u32> = files
            .iter()
            .enumerate()
            .map(|(i, f)| (f.id, i as u32))
            .collect();
        let by_path = files
            .iter()
            .enumerate()
            .map(|(i, f)| (f.path.clone(), i as u32))
            .collect();
        let mut fwd: Vec<(u32, u32)> = pairs
            .iter()
            .filter_map(|(s, d)| Some((*by_id.get(s)?, *by_id.get(d)?)))
            .filter(|(s, d)| s != d)
            .collect();
        fwd.sort_unstable();
        fwd.dedup();
        let mut rev: Vec<(u32, u32)> = fwd.iter().map(|&(s, d)| (d, s)).collect();
        rev.sort_unstable();
        Self {
            epoch,
            out: adjacency(&fwd),
            inn: adjacency(&rev),
            pairs: fwd.len(),
            nodes: files,
            by_path,
            by_id,
        }
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn note_count(&self) -> usize {
        self.nodes.iter().filter(|n| n.is_note).count()
    }

    /// Distinct resolved non-self file pairs.
    pub fn pair_count(&self) -> usize {
        self.pairs
    }

    pub fn node_of_path(&self, path: &str) -> Option<u32> {
        self.by_path.get(path).copied()
    }

    pub fn node_of_id(&self, id: i64) -> Option<u32> {
        self.by_id.get(&id).copied()
    }

    pub fn path(&self, node: u32) -> &str {
        &self.nodes[node as usize].path
    }

    pub fn id(&self, node: u32) -> i64 {
        self.nodes[node as usize].id
    }

    pub fn is_note(&self, node: u32) -> bool {
        self.nodes[node as usize].is_note
    }

    /// Files `node` links to (distinct, resolved, not itself), in path order.
    pub fn out_neighbors(&self, node: u32) -> impl Iterator<Item = u32> + '_ {
        neighbors(&self.out, node).iter().copied()
    }

    /// Files linking to `node` (distinct, not itself), in path order.
    pub fn in_neighbors(&self, node: u32) -> impl Iterator<Item = u32> + '_ {
        neighbors(&self.inn, node).iter().copied()
    }

    pub fn out_degree(&self, node: u32) -> usize {
        neighbors(&self.out, node).len()
    }

    pub fn in_degree(&self, node: u32) -> usize {
        neighbors(&self.inn, node).len()
    }

    /// `a` links to `b`.
    pub fn has_edge(&self, a: u32, b: u32) -> bool {
        neighbors(&self.out, a).binary_search(&b).is_ok()
    }

    /// Shortest chain of links between two files, ignoring link direction and walking only
    /// through markdown notes (the ends may be any file), at most `max_depth` steps. `Some([])`
    /// when `from == to`; ties are broken by path order so the answer is stable. `None` when no
    /// chain is that short.
    pub fn shortest_path(&self, from: u32, to: u32, max_depth: usize) -> Option<Vec<PathStep>> {
        if from == to {
            return Some(Vec::new());
        }
        let mut prev: HashMap<u32, u32> = HashMap::new();
        let mut queue = VecDeque::from([(from, 0usize)]);
        prev.insert(from, from);
        while let Some((node, depth)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }
            for next in self.out_neighbors(node).chain(self.in_neighbors(node)) {
                if prev.contains_key(&next) || !(self.is_note(next) || next == to) {
                    continue;
                }
                prev.insert(next, node);
                if next == to {
                    let mut steps = Vec::new();
                    let mut at = to;
                    while at != from {
                        let before = prev[&at];
                        steps.push(PathStep {
                            from: before,
                            to: at,
                            forward: self.has_edge(before, at),
                        });
                        at = before;
                    }
                    steps.reverse();
                    return Some(steps);
                }
                queue.push_back((next, depth + 1));
            }
        }
        None
    }

    /// Connected components of the markdown notes (link direction ignored, every note counted,
    /// isolated ones as components of one), each as its members in path order, largest first.
    pub fn components(&self) -> Vec<Vec<u32>> {
        let n = self.nodes.len();
        let mut sets: UnionFind<u32> = UnionFind::new(n);
        for a in (0..n as u32).filter(|&a| self.is_note(a)) {
            for b in self.out_neighbors(a).filter(|&b| self.is_note(b)) {
                sets.union(a, b);
            }
        }
        let labels = sets.into_labeling();
        let mut by_root: HashMap<u32, Vec<u32>> = HashMap::new();
        for a in (0..n as u32).filter(|&a| self.is_note(a)) {
            by_root.entry(labels[a as usize]).or_default().push(a);
        }
        let mut out: Vec<Vec<u32>> = by_root.into_values().collect();
        // Members are already in path order (nodes are numbered by path).
        out.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].cmp(&b[0])));
        out
    }

    /// Notes ranked by their number of distinct linked notes (in plus out), most first, ties by
    /// path; notes without any link are left out.
    pub fn hubs(&self, limit: usize) -> Vec<Hub> {
        let mut hubs: Vec<Hub> = (0..self.nodes.len() as u32)
            .filter(|&n| self.is_note(n))
            .map(|node| Hub {
                node,
                degree_in: self.in_neighbors(node).filter(|&m| self.is_note(m)).count(),
                degree_out: self
                    .out_neighbors(node)
                    .filter(|&m| self.is_note(m))
                    .count(),
            })
            .filter(|h| h.degree_in + h.degree_out > 0)
            .collect();
        hubs.sort_by(|a, b| {
            (b.degree_in + b.degree_out)
                .cmp(&(a.degree_in + a.degree_out))
                .then(a.node.cmp(&b.node))
        });
        hubs.truncate(limit);
        hubs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Files `a`..: `a.md`, `b.md`, ... with ids 10, 11, ...; `img` is a non-note.
    fn graph(names: &[&str], pairs: &[(&str, &str)]) -> GraphSnapshot {
        let id = |n: &str| 10 + names.iter().position(|x| *x == n).unwrap() as i64;
        let files = names
            .iter()
            .rev() // unsorted on purpose
            .map(|n| NodeRow {
                id: id(n),
                path: format!("{n}.md"),
                is_note: *n != "img",
            })
            .collect();
        let pairs: Vec<_> = pairs.iter().map(|(a, b)| (id(a), id(b))).collect();
        GraphSnapshot::build(7, files, &pairs)
    }

    fn paths(g: &GraphSnapshot, nodes: impl Iterator<Item = u32>) -> Vec<String> {
        nodes.map(|n| g.path(n).to_string()).collect()
    }

    #[test]
    fn neighbours_degrees_and_dedup() {
        let g = graph(
            &["a", "b", "c", "d"],
            &[("a", "b"), ("a", "b"), ("c", "b"), ("b", "b"), ("b", "d")],
        );
        let b = g.node_of_path("b.md").unwrap();
        assert_eq!(paths(&g, g.in_neighbors(b)), ["a.md", "c.md"]);
        assert_eq!(paths(&g, g.out_neighbors(b)), ["d.md"]);
        assert_eq!((g.in_degree(b), g.out_degree(b)), (2, 1));
        assert_eq!(g.pair_count(), 3);
        // The last node has no outgoing edge: past the graph's sized range, empty, no panic.
        let d = g.node_of_path("d.md").unwrap();
        assert_eq!(g.out_degree(d), 0);
        assert!(g.has_edge(b, d) && !g.has_edge(d, b));
        assert_eq!(g.node_of_id(11), Some(b));
        assert_eq!(g.epoch, 7);
        // Ids that are no file (a row deleted between the two reads) are dropped.
        let files = vec![NodeRow {
            id: 1,
            path: "x.md".into(),
            is_note: true,
        }];
        let lone = GraphSnapshot::build(0, files, &[(1, 99), (99, 1)]);
        assert_eq!(lone.pair_count(), 0);
    }

    #[test]
    fn shortest_path_ignores_direction_and_avoids_attachments() {
        let g = graph(
            &["a", "b", "c", "d", "e", "img"],
            &[
                ("a", "b"),
                ("c", "b"),
                ("c", "d"),
                ("a", "img"),
                ("e", "img"),
            ],
        );
        let n = |p: &str| g.node_of_path(&format!("{p}.md")).unwrap();
        let steps = g.shortest_path(n("a"), n("d"), 6).unwrap();
        assert_eq!(
            steps
                .iter()
                .map(|s| (g.path(s.from), g.path(s.to), s.forward))
                .collect::<Vec<_>>(),
            [
                ("a.md", "b.md", true),
                ("b.md", "c.md", false),
                ("c.md", "d.md", true)
            ]
        );
        assert_eq!(g.shortest_path(n("a"), n("a"), 6), Some(vec![]));
        // a and e only meet through an embedded image: no path between notes.
        assert_eq!(g.shortest_path(n("a"), n("e"), 6), None);
        // The image itself can be an end.
        assert_eq!(g.shortest_path(n("a"), n("img"), 6).unwrap().len(), 1);
        // Depth cap.
        assert_eq!(g.shortest_path(n("a"), n("d"), 2), None);
        assert!(g.shortest_path(n("a"), n("d"), 3).is_some());
    }

    #[test]
    fn components_count_isolated_notes_and_skip_attachments() {
        let g = graph(
            &["a", "b", "c", "d", "e", "f", "img"],
            &[
                ("a", "b"),
                ("b", "c"),
                ("d", "e"),
                ("a", "img"),
                ("f", "img"),
            ],
        );
        let comps: Vec<Vec<String>> = g
            .components()
            .into_iter()
            .map(|c| paths(&g, c.into_iter()))
            .collect();
        assert_eq!(
            comps,
            vec![
                vec!["a.md", "b.md", "c.md"],
                vec!["d.md", "e.md"],
                vec!["f.md"]
            ]
        );
    }

    #[test]
    fn hubs_rank_by_distinct_note_neighbours() {
        let g = graph(
            &["a", "b", "c", "d", "img"],
            &[
                ("a", "b"),
                ("c", "b"),
                ("d", "b"),
                ("a", "c"),
                ("b", "img"),
                ("a", "img"),
            ],
        );
        let hubs = g.hubs(10);
        let got: Vec<_> = hubs
            .iter()
            .map(|h| (g.path(h.node), h.degree_in, h.degree_out))
            .collect();
        assert_eq!(
            got,
            [
                ("b.md", 3, 0),
                ("a.md", 0, 2),
                ("c.md", 1, 1),
                ("d.md", 0, 1)
            ]
        );
        assert_eq!(g.hubs(2).len(), 2);
    }
}
