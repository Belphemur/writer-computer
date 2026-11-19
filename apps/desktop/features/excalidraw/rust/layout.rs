//! A small layered layout for the boxes of a drawing the agent describes without positions
//! (own code, no dependency): edges give each box a layer (longest path, a cycle's back edge
//! ignored), boxes inside a layer are ordered by the mean position of their neighbours
//! (barycenter sweeps), layers are laid along the flow axis with a gap, boxes inside a layer
//! across it, centred. Boxes that came with a position stay where they are; the laid-out block
//! is placed below them, so nothing overlaps. Tauri-free.

pub const LAYER_GAP: f64 = 90.0;
pub const NODE_GAP: f64 = 50.0;
/// Space between an existing drawing and what is added to it.
pub const BLOCK_GAP: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Layers run left to right.
    LeftRight,
    /// Layers run top to bottom.
    TopBottom,
}

#[derive(Debug, Clone, Copy)]
pub struct Item {
    pub w: f64,
    pub h: f64,
    /// Top-left corner when the box already has a place.
    pub at: Option<(f64, f64)>,
}

/// The top-left corner of every item: the given ones unchanged, the others laid out. `edges` are
/// pairs of indices into `items`; only those between two unplaced items shape the layers.
pub fn place(items: &[Item], edges: &[(usize, usize)], direction: Direction) -> Vec<(f64, f64)> {
    let free: Vec<usize> = (0..items.len())
        .filter(|&i| items[i].at.is_none())
        .collect();
    let mut out: Vec<(f64, f64)> = items.iter().map(|i| i.at.unwrap_or((0.0, 0.0))).collect();
    if free.is_empty() {
        return out;
    }
    let local: std::collections::HashMap<usize, usize> =
        free.iter().enumerate().map(|(l, &g)| (g, l)).collect();
    let local_edges: Vec<(usize, usize)> = edges
        .iter()
        .filter_map(|(a, b)| Some((*local.get(a)?, *local.get(b)?)))
        .filter(|(a, b)| a != b)
        .collect();
    let layers = layering(free.len(), &local_edges);
    let ordered = order(&layers, &local_edges);
    let sizes: Vec<(f64, f64)> = free.iter().map(|&g| (items[g].w, items[g].h)).collect();
    let rel = coordinates(&ordered, &sizes, direction);

    // The block goes below the placed items (or at the origin when there are none).
    let placed: Vec<&Item> = items.iter().filter(|i| i.at.is_some()).collect();
    let (ox, oy) = if placed.is_empty() {
        (0.0, 0.0)
    } else {
        let min_x = placed
            .iter()
            .map(|i| i.at.unwrap().0)
            .fold(f64::MAX, f64::min);
        let max_y = placed
            .iter()
            .map(|i| i.at.unwrap().1 + i.h)
            .fold(f64::MIN, f64::max);
        (min_x, max_y + BLOCK_GAP)
    };
    for (l, &g) in free.iter().enumerate() {
        out[g] = (ox + rel[l].0, oy + rel[l].1);
    }
    out
}

/// Layer index per node: longest path from a source over the edges that are not back edges.
fn layering(n: usize, edges: &[(usize, usize)]) -> Vec<usize> {
    let mut adj = vec![Vec::new(); n];
    for &(a, b) in edges {
        adj[a].push(b);
    }
    // DFS: an edge into a node still on the stack closes a cycle and is dropped.
    let mut state = vec![0u8; n]; // 0 new, 1 on stack, 2 done
    let mut dag: Vec<(usize, usize)> = Vec::new();
    for start in 0..n {
        if state[start] != 0 {
            continue;
        }
        let mut stack = vec![(start, 0usize)];
        state[start] = 1;
        while let Some(top) = stack.len().checked_sub(1) {
            let (v, next) = stack[top];
            if next < adj[v].len() {
                stack[top].1 += 1;
                let w = adj[v][next];
                if state[w] != 1 {
                    dag.push((v, w));
                    if state[w] == 0 {
                        state[w] = 1;
                        stack.push((w, 0));
                    }
                }
            } else {
                state[v] = 2;
                stack.pop();
            }
        }
    }
    let mut layer = vec![0usize; n];
    // Relax along the DAG until stable (at most n rounds on a DAG).
    for _ in 0..n {
        let mut changed = false;
        for &(a, b) in &dag {
            if layer[b] < layer[a] + 1 {
                layer[b] = layer[a] + 1;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    layer
}

/// Nodes of each layer in display order, refined by barycenter sweeps.
fn order(layers: &[usize], edges: &[(usize, usize)]) -> Vec<Vec<usize>> {
    let depth = layers.iter().copied().max().unwrap_or(0) + 1;
    let mut cols: Vec<Vec<usize>> = vec![Vec::new(); depth];
    for (v, &l) in layers.iter().enumerate() {
        cols[l].push(v);
    }
    let pos_in = |cols: &Vec<Vec<usize>>| -> Vec<f64> {
        let mut pos = vec![0.0; layers.len()];
        for col in cols {
            for (i, &v) in col.iter().enumerate() {
                pos[v] = i as f64;
            }
        }
        pos
    };
    for sweep in 0..6 {
        let down = sweep % 2 == 0;
        let range: Vec<usize> = if down {
            (1..depth).collect()
        } else {
            (0..depth.saturating_sub(1)).rev().collect()
        };
        for l in range {
            let pos = pos_in(&cols);
            let neighbour_layer = if down { l - 1 } else { l + 1 };
            let mut keyed: Vec<(f64, usize)> = cols[l]
                .iter()
                .map(|&v| {
                    let ns: Vec<f64> = edges
                        .iter()
                        .filter_map(|&(a, b)| {
                            let other = if a == v {
                                b
                            } else if b == v {
                                a
                            } else {
                                return None;
                            };
                            (layers[other] == neighbour_layer).then_some(pos[other])
                        })
                        .collect();
                    let bary = if ns.is_empty() {
                        pos[v]
                    } else {
                        ns.iter().sum::<f64>() / ns.len() as f64
                    };
                    (bary, v)
                })
                .collect();
            keyed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
            cols[l] = keyed.into_iter().map(|(_, v)| v).collect();
        }
    }
    cols
}

/// Top-left corners relative to the block's own top-left corner.
fn coordinates(cols: &[Vec<usize>], sizes: &[(f64, f64)], dir: Direction) -> Vec<(f64, f64)> {
    // `flow` is the size along the layers, `cross` the size across them.
    let flow = |v: usize| {
        if dir == Direction::LeftRight {
            sizes[v].0
        } else {
            sizes[v].1
        }
    };
    let cross = |v: usize| {
        if dir == Direction::LeftRight {
            sizes[v].1
        } else {
            sizes[v].0
        }
    };
    let extent = |col: &Vec<usize>| -> f64 {
        col.iter().map(|&v| cross(v)).sum::<f64>() + NODE_GAP * col.len().saturating_sub(1) as f64
    };
    let widest = cols.iter().map(extent).fold(0.0, f64::max);
    let mut out = vec![(0.0, 0.0); sizes.len()];
    let mut flow_at = 0.0;
    for col in cols {
        if col.is_empty() {
            continue;
        }
        let thick = col.iter().map(|&v| flow(v)).fold(0.0, f64::max);
        let mut cross_at = (widest - extent(col)) / 2.0;
        for &v in col {
            // a box is centred on its layer's axis
            let f = flow_at + (thick - flow(v)) / 2.0;
            out[v] = if dir == Direction::LeftRight {
                (f, cross_at)
            } else {
                (cross_at, f)
            };
            cross_at += cross(v) + NODE_GAP;
        }
        flow_at += thick + LAYER_GAP;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(w: f64, h: f64) -> Item {
        Item { w, h, at: None }
    }
    fn overlaps(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
        a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
    }
    fn no_overlap(items: &[Item], at: &[(f64, f64)]) {
        for i in 0..items.len() {
            for j in i + 1..items.len() {
                let a = (at[i].0, at[i].1, items[i].w, items[i].h);
                let b = (at[j].0, at[j].1, items[j].w, items[j].h);
                assert!(!overlaps(a, b), "{i} overlaps {j}: {a:?} {b:?}");
            }
        }
    }

    #[test]
    fn a_chain_runs_left_to_right_in_order() {
        let items = [item(100.0, 60.0), item(120.0, 60.0), item(100.0, 80.0)];
        let at = place(&items, &[(0, 1), (1, 2)], Direction::LeftRight);
        assert!(at[0].0 < at[1].0 && at[1].0 < at[2].0);
        no_overlap(&items, &at);
        let down = place(&items, &[(0, 1), (1, 2)], Direction::TopBottom);
        assert!(down[0].1 < down[1].1 && down[1].1 < down[2].1);
    }

    #[test]
    fn a_wide_graph_with_a_cycle_and_loose_boxes_never_overlaps() {
        let items: Vec<Item> = (0..14)
            .map(|i| item(100.0 + (i % 3) as f64 * 40.0, 60.0 + (i % 2) as f64 * 30.0))
            .collect();
        let edges = [
            (0, 1),
            (0, 2),
            (0, 3),
            (1, 4),
            (2, 4),
            (3, 5),
            (4, 6),
            (5, 6),
            (6, 0),
            (7, 8),
        ];
        for dir in [Direction::LeftRight, Direction::TopBottom] {
            let at = place(&items, &edges, dir);
            no_overlap(&items, &at);
        }
    }

    #[test]
    fn placed_boxes_stay_and_the_new_block_goes_below_them() {
        let mut items = vec![
            Item {
                w: 100.0,
                h: 60.0,
                at: Some((50.0, 40.0)),
            },
            Item {
                w: 100.0,
                h: 60.0,
                at: Some((300.0, 40.0)),
            },
            item(100.0, 60.0),
            item(100.0, 60.0),
        ];
        let at = place(&items, &[(2, 3), (0, 2)], Direction::LeftRight);
        assert_eq!(at[0], (50.0, 40.0));
        assert_eq!(at[1], (300.0, 40.0));
        assert!(at[2].1 >= 40.0 + 60.0 + BLOCK_GAP);
        items[0].at = Some(at[0]);
        no_overlap(&items, &at);
    }

    #[test]
    fn nothing_to_place_and_a_single_box_work() {
        assert!(place(&[], &[], Direction::LeftRight).is_empty());
        assert_eq!(
            place(&[item(10.0, 10.0)], &[], Direction::TopBottom),
            vec![(0.0, 0.0)]
        );
    }
}
