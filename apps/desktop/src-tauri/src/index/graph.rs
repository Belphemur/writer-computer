//! The note graph's traversals and listings over `edges` (SPECs/note-graph-spec.md sections 5.3,
//! 7 and 8): the one place with graph SQL. The `Index` methods here back the `writer graph:*`
//! commands and the graph view's commands; whole-graph questions run on the per-epoch
//! [`GraphSnapshot`], neighbourhoods and listings run as SQL.

pub use super::edges::EdgeKind;
use super::snapshot::{GraphSnapshot, NodeRow};
use super::{Index, IndexError};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

type Res<T> = Result<T, IndexError>;

/// Read every file and every distinct resolved non-self pair into a snapshot. The two reads
/// share the connection's WAL snapshot only per statement, which is enough: a pair whose file
/// vanished in between is dropped by [`GraphSnapshot::build`], and the epoch moved anyway.
pub(crate) fn load_snapshot(conn: &Connection, epoch: u64) -> Res<GraphSnapshot> {
    let mut st = conn.prepare("SELECT id, path, ext = 'md' FROM files")?;
    let files = st
        .query_map([], |r| {
            Ok(NodeRow {
                id: r.get(0)?,
                path: r.get(1)?,
                is_note: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut st = conn.prepare(
        "SELECT src_id, dst_id FROM edges WHERE dst_id IS NOT NULL AND src_id <> dst_id",
    )?;
    let pairs = st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(GraphSnapshot::build(epoch, files, &pairs))
}

// ---------------------------------------------------------------------------------------------
// Shapes. `GraphNode`, `GraphEdge`, `GraphSlice`, `GraphStats` and `GraphSliceRequest` are the
// graph view's contract (spec 8.5): camelCase on the wire, TypeScript generated from them.

/// Default size of a whole-vault slice (the targets are GPU Macs; spec 8.5).
pub const DEFAULT_SLICE_LIMIT: usize = 10_000;
/// Default and largest neighbourhood a command returns.
pub const DEFAULT_NEIGHBOR_LIMIT: usize = 50;
pub const MAX_NEIGHBOR_LIMIT: usize = 5_000;
/// Deepest neighbourhood any command walks.
pub const MAX_DEPTH: u32 = 4;
/// Deepest local graph the graph view asks for (its depth slider goes 1 to 5); commands keep
/// [`MAX_DEPTH`].
pub const MAX_SLICE_DEPTH: u32 = 5;
/// A note with more distinct neighbours than this is shown but not expanded (spec 7).
pub const HUB_GUARD: usize = 300;
const ID_CHUNK: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// `files.id`; negative for an unresolved target (a ghost node).
    pub id: i64,
    /// Vault-relative path; the link text for a ghost node.
    pub path: String,
    pub name: String,
    pub folder: String,
    pub ext: String,
    pub degree_in: u32,
    pub degree_out: u32,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub unresolved: Option<bool>,
    /// The first set value among the request's `cardProperties` (a `type` or `status`; a list as
    /// its first items, comma separated; at most 60 characters), for the view's close-up card.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub card_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: i64,
    pub src: i64,
    /// `None`: unresolved and not shown as a ghost node.
    pub dst: Option<i64>,
    pub kind: EdgeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub label: Option<String>,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub ambiguous: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphSlice {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// More nodes matched than `limit` allowed.
    pub truncated: bool,
    /// The node cap that applied (the request's `limit`, clamped): the one place the number
    /// lives, so the view never repeats it.
    pub limit: u32,
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphStats {
    /// Markdown notes.
    pub notes: u32,
    /// Distinct resolved pairs of linked files (what the graph draws as lines).
    pub edges: u32,
    /// Distinct unresolved targets (the ghost nodes `includeUnresolved` adds).
    pub unresolved: u32,
    /// Connected groups of notes, an isolated note counting as one.
    pub components: u32,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphSliceRequest {
    /// Vault-relative path; none means the whole vault.
    pub center: Option<String>,
    /// With a center: 1 to 3 hops (default 1).
    pub depth: Option<u32>,
    /// `link`, `embed`, `property`; none means all.
    pub kinds: Option<Vec<EdgeKind>>,
    /// Property names; none means all.
    pub labels: Option<Vec<String>>,
    /// Keep notes in these folders (and below).
    pub folders: Option<Vec<String>>,
    /// Keep notes with one of these tags (a nested tag matches its ancestors).
    pub tags: Option<Vec<String>>,
    pub include_unresolved: Option<bool>,
    /// Property names in priority order for `GraphNode.cardValue` (the first one a note sets wins).
    pub card_properties: Option<Vec<String>>,
    /// Reserved: tag nodes are built by the view from `GraphNode.tags`, so this changes nothing.
    pub include_tags: Option<bool>,
    /// Also nodes that are not markdown (images, PDFs...); off by default.
    pub include_attachments: Option<bool>,
    pub limit: Option<u32>,
}

/// Which edges a traversal or listing may use.
#[derive(Debug, Clone, Default)]
pub struct EdgeFilter {
    pub kinds: Vec<String>,
    pub labels: Vec<String>,
}

impl EdgeFilter {
    /// `AND e.kind IN (?n, ..) AND e.label IN (..)` for the edge alias `e`, numbering its
    /// parameters from `start` (so a query can repeat the fragment), with their values.
    fn sql(&self, start: usize) -> (String, Vec<SqlValue>) {
        let mut out = String::new();
        let mut vals: Vec<SqlValue> = Vec::new();
        for (col, list) in [("kind", &self.kinds), ("label", &self.labels)] {
            if list.is_empty() {
                continue;
            }
            let marks: Vec<String> = (0..list.len())
                .map(|i| format!("?{}", start + vals.len() + i))
                .collect();
            out.push_str(&format!(" AND e.{col} IN ({})", marks.join(",")));
            vals.extend(list.iter().cloned().map(SqlValue::Text));
        }
        (out, vals)
    }
}

/// Which way a walk follows links.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Out,
    In,
    Both,
}

impl Direction {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "out" => Some(Self::Out),
            "in" => Some(Self::In),
            "both" => Some(Self::Both),
            _ => None,
        }
    }
    fn out(self) -> bool {
        self != Self::In
    }
    fn inward(self) -> bool {
        self != Self::Out
    }
}

#[derive(Debug, Clone)]
pub struct NeighborQuery {
    pub depth: u32,
    pub direction: Direction,
    pub filter: EdgeFilter,
    pub limit: usize,
    /// Do not expand notes with more than [`HUB_GUARD`] neighbours (the center always expands).
    pub hub_guard: bool,
    /// Walk through and return non-markdown files too.
    pub attachments: bool,
}

impl Default for NeighborQuery {
    fn default() -> Self {
        Self {
            depth: 2,
            direction: Direction::Both,
            filter: EdgeFilter::default(),
            limit: DEFAULT_NEIGHBOR_LIMIT,
            hub_guard: true,
            attachments: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NeighborNode {
    pub node: GraphNode,
    pub depth: u32,
    /// Kind and label of the first link of the way from the center (none for the center).
    pub via: Option<(EdgeKind, Option<String>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Neighborhood {
    /// The center first, then by depth and path.
    pub nodes: Vec<NeighborNode>,
    /// Edges among the returned nodes.
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PathEdge {
    pub from: String,
    pub to: String,
    /// `out`: `from` links to `to`; `in`: `to` links to `from`.
    pub direction: &'static str,
    pub kind: EdgeKind,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LabelCount {
    pub label: String,
    pub edges: i64,
    pub notes: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Relationship {
    pub source: String,
    pub label: String,
    /// Resolved path, or the link text when unresolved.
    pub target: String,
    pub resolved: bool,
    pub line: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BacklinkDetail {
    pub source: String,
    pub kind: EdgeKind,
    pub label: Option<String>,
    pub line: Option<i64>,
    pub section: Option<String>,
    pub display: Option<String>,
    pub subpath: Option<String>,
    pub ambiguous: bool,
    /// The link text as written, to find it again on its line.
    pub target: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RelatedNote {
    pub path: String,
    pub score: f64,
    pub shared: i64,
    /// Up to a few of the shared neighbours' paths, by path.
    pub via: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HubInfo {
    pub path: String,
    pub degree_in: usize,
    pub degree_out: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentInfo {
    pub size: usize,
    /// First note of the component by path.
    pub example: String,
}

const VIA_NAMES: usize = 5;

/// The line of a note that holds a link, for the LLM to see why two notes are linked
/// (spec 4.4): the line at `line` (1-based) with its markup, trimmed and capped at `max`
/// characters on a character boundary. `None` when the file changed since indexing and that
/// line no longer contains the link text (the edge is still reported, without a snippet).
pub fn line_snippet(text: &str, line: i64, target: &str, max: usize) -> Option<String> {
    let l = text
        .lines()
        .nth(usize::try_from(line).ok()?.checked_sub(1)?)?;
    if !target.is_empty() && !l.contains(target) {
        return None;
    }
    let l = l.trim();
    Some(match l.char_indices().nth(max) {
        Some((i, _)) => format!("{}...", &l[..i]),
        None => l.to_string(),
    })
}

fn marks(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn leaf_filter(tags: Vec<String>) -> Vec<String> {
    super::query::leaf_tags(tags)
}

struct FileInfo {
    id: i64,
    path: String,
    name: String,
    folder: String,
    ext: String,
}

fn file_infos(conn: &Connection, ids: &[i64]) -> Res<HashMap<i64, FileInfo>> {
    let mut out = HashMap::with_capacity(ids.len());
    for chunk in ids.chunks(ID_CHUNK) {
        let mut st = conn.prepare(&format!(
            "SELECT id, path, name, folder, ext FROM files WHERE id IN ({})",
            marks(chunk.len())
        ))?;
        let rows = st.query_map(params_from_iter(chunk.iter()), |r| {
            Ok(FileInfo {
                id: r.get(0)?,
                path: r.get(1)?,
                name: r.get(2)?,
                folder: r.get(3)?,
                ext: r.get(4)?,
            })
        })?;
        for f in rows {
            let f = f?;
            out.insert(f.id, f);
        }
    }
    Ok(out)
}

/// Tags (all stored, ancestors included) per file id.
fn tags_of(conn: &Connection, ids: &[i64]) -> Res<HashMap<i64, Vec<String>>> {
    let mut out: HashMap<i64, Vec<String>> = HashMap::new();
    for chunk in ids.chunks(ID_CHUNK) {
        let mut st = conn.prepare(&format!(
            "SELECT DISTINCT file_id, tag FROM tags WHERE file_id IN ({}) ORDER BY file_id, tag",
            marks(chunk.len())
        ))?;
        let mut rows = st.query(params_from_iter(chunk.iter()))?;
        while let Some(r) = rows.next()? {
            out.entry(r.get(0)?).or_default().push(r.get(1)?);
        }
    }
    Ok(out)
}

fn graph_node(
    f: &FileInfo,
    snap: &GraphSnapshot,
    tags: &mut HashMap<i64, Vec<String>>,
) -> GraphNode {
    let (degree_in, degree_out) = snap.node_of_id(f.id).map_or((0, 0), |n| {
        (snap.in_degree(n) as u32, snap.out_degree(n) as u32)
    });
    GraphNode {
        id: f.id,
        path: f.path.clone(),
        name: f.name.clone(),
        folder: f.folder.clone(),
        ext: f.ext.clone(),
        degree_in,
        degree_out,
        tags: leaf_filter(tags.remove(&f.id).unwrap_or_default()),
        unresolved: None,
        card_value: None,
    }
}

/// Longest card value, in characters.
const CARD_VALUE_MAX: usize = 60;

/// For each file, the first set value among the properties `keys` (matched case-insensitively,
/// in priority order), as text: a scalar as written, a list as its first items joined with
/// commas, all cut at [`CARD_VALUE_MAX`] characters. Read from `props` and `prop_items`.
fn card_values(conn: &Connection, ids: &[i64], keys: &[String]) -> Res<HashMap<i64, String>> {
    let keys: Vec<String> = keys.iter().map(|k| k.trim().to_lowercase()).collect();
    let mut best: HashMap<i64, (usize, String)> = HashMap::new();
    let mut offer = |id: i64, key: &str, text: String| {
        let text = text.trim();
        let Some(rank) = keys.iter().position(|k| k.as_str() == key.to_lowercase()) else {
            return;
        };
        if text.is_empty() || best.get(&id).is_some_and(|(have, _)| *have <= rank) {
            return;
        }
        let cut = match text.char_indices().nth(CARD_VALUE_MAX) {
            Some((i, _)) => &text[..i],
            None => text,
        };
        best.insert(id, (rank, cut.to_string()));
    };
    for chunk in ids.chunks(ID_CHUNK) {
        let id_marks = (1..=chunk.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let key_marks = (0..keys.len())
            .map(|i| format!("?{}", chunk.len() + 1 + i))
            .collect::<Vec<_>>()
            .join(",");
        let args: Vec<SqlValue> = chunk
            .iter()
            .map(|i| SqlValue::Integer(*i))
            .chain(keys.iter().cloned().map(SqlValue::Text))
            .collect();
        let mut st = conn.prepare(&format!(
            "SELECT file_id, key, v_text FROM props WHERE vtype <> 'list' AND v_text IS NOT NULL \
             AND file_id IN ({id_marks}) AND lower(key) IN ({key_marks})"
        ))?;
        let mut rows = st.query(params_from_iter(args.iter()))?;
        while let Some(r) = rows.next()? {
            offer(r.get(0)?, &r.get::<_, String>(1)?, r.get(2)?);
        }
        // Lists: the items in order, joined while they fit.
        let mut st = conn.prepare(&format!(
            "SELECT file_id, key, v_text FROM prop_items WHERE v_text IS NOT NULL AND v_text <> '' \
             AND file_id IN ({id_marks}) AND lower(key) IN ({key_marks}) ORDER BY file_id, key, idx"
        ))?;
        let mut lists: BTreeMap<(i64, String), Vec<String>> = BTreeMap::new();
        let mut rows = st.query(params_from_iter(args.iter()))?;
        while let Some(r) = rows.next()? {
            lists
                .entry((r.get(0)?, r.get(1)?))
                .or_default()
                .push(r.get(2)?);
        }
        for ((id, key), items) in lists {
            offer(id, &key, items.join(", "));
        }
    }
    Ok(best.into_iter().map(|(id, (_, t))| (id, t)).collect())
}

/// Edges whose source is in `ids` and whose target is also in `ids` (resolved), plus, when
/// `ghosts` is set, those whose target is unresolved. Ghost nodes get negative ids by sorted
/// target key; the returned map names them (`id -> link text`). Self-links are left out.
fn edges_among(
    conn: &Connection,
    ids: &[i64],
    filter: &EdgeFilter,
    ghosts: bool,
) -> Res<(Vec<GraphEdge>, Vec<(i64, String)>)> {
    let set: HashSet<i64> = ids.iter().copied().collect();
    struct Raw {
        e: GraphEdge,
        key: Option<(String, String)>,
    }
    let mut raw: Vec<Raw> = Vec::new();
    for chunk in ids.chunks(ID_CHUNK) {
        let (fsql, fvals) = filter.sql(chunk.len() + 1);
        let mut st =
            conn.prepare(&format!(
            "SELECT e.id, e.src_id, e.dst_id, e.kind, e.label, e.target, e.ambiguous, e.dst_key \
             FROM edges e WHERE e.src_id IN ({}){fsql} ORDER BY e.src_id, e.ord",
            (1..=chunk.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",")
        ))?;
        let args: Vec<SqlValue> = chunk
            .iter()
            .map(|i| SqlValue::Integer(*i))
            .chain(fvals)
            .collect();
        let mut rows = st.query(params_from_iter(args.iter()))?;
        while let Some(r) = rows.next()? {
            let dst: Option<i64> = r.get(2)?;
            let src: i64 = r.get(1)?;
            let (target, key): (String, String) = (r.get(5)?, r.get(7)?);
            let ghost = match dst {
                Some(d) if d == src || !set.contains(&d) => continue,
                Some(_) => None,
                None if ghosts && !key.is_empty() => Some((key, target.clone())),
                None => continue,
            };
            raw.push(Raw {
                e: GraphEdge {
                    id: r.get(0)?,
                    src,
                    dst,
                    kind: EdgeKind::from_column(&r.get::<_, String>(3)?),
                    label: r.get(4)?,
                    target,
                    ambiguous: r.get::<_, bool>(6)?.then_some(true),
                },
                key: ghost,
            });
        }
    }
    // Ghost ids: -1, -2, ... by sorted bucket key, the first spelling met names the node.
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for g in raw.iter().filter_map(|r| r.key.as_ref()) {
        names.entry(g.0.clone()).or_insert_with(|| g.1.clone());
    }
    let ghost_id: HashMap<&String, i64> = names
        .keys()
        .enumerate()
        .map(|(i, k)| (k, -(i as i64) - 1))
        .collect();
    let edges = raw
        .iter()
        .map(|r| {
            let mut e = r.e.clone();
            if let Some((key, _)) = &r.key {
                e.dst = Some(ghost_id[key]);
            }
            e
        })
        .collect();
    let ghosts = names
        .iter()
        .map(|(k, text)| (ghost_id[k], text.clone()))
        .collect();
    Ok((edges, ghosts))
}

fn kind_rank(k: EdgeKind) -> u8 {
    match k {
        EdgeKind::Property => 0,
        EdgeKind::Link => 1,
        EdgeKind::Embed => 2,
    }
}

impl Index {
    fn file_id(&self, conn: &Connection, path: &str) -> Res<i64> {
        let _ = self;
        conn.query_row("SELECT id FROM files WHERE path = ?1", [path], |r| r.get(0))
            .optional()?
            .ok_or_else(|| IndexError::Invalid(format!("not in the index: {path}")))
    }

    /// Notes (and files, with `attachments`) within `depth` links of `center`, nearest first,
    /// with the edges among them. The walk is SQL (spec 7: `UNION` over `(id, depth)` bounds it);
    /// the hub guard and each node's first-hop edge are settled on the small result.
    pub fn neighbors(&self, center: &str, q: &NeighborQuery) -> Res<Neighborhood> {
        let depth = q.depth.clamp(1, MAX_SLICE_DEPTH);
        let limit = q.limit.clamp(1, MAX_NEIGHBOR_LIMIT);
        let snap = self.graph_snapshot()?;
        self.read(|c| {
            let center_id = self.file_id(c, center)?;
            let (fsql, fvals) = q.filter.sql(4);
            let notes_only = if q.attachments {
                ""
            } else {
                " JOIN files t ON t.id = e.dst_id AND t.ext = 'md'"
            };
            let mut terms = String::from("SELECT ?1, 0");
            if q.direction.out() {
                terms.push_str(&format!(
                    " UNION SELECT e.dst_id, w.d + 1 FROM walk w JOIN edges e ON e.src_id = w.id{notes_only} \
                     WHERE w.d < ?2 AND e.dst_id IS NOT NULL{fsql}"
                ));
            }
            if q.direction.inward() {
                terms.push_str(&format!(
                    " UNION SELECT e.src_id, w.d + 1 FROM walk w JOIN edges e ON e.dst_id = w.id \
                     WHERE w.d < ?2{fsql}"
                ));
            }
            let sql = format!(
                "WITH RECURSIVE walk(id, d) AS ({terms} LIMIT 200000) \
                 SELECT w.id, MIN(w.d) AS depth FROM walk w JOIN files f ON f.id = w.id \
                 WHERE w.id <> ?1 GROUP BY w.id ORDER BY depth, f.path LIMIT ?3"
            );
            let mut args: Vec<SqlValue> = vec![
                SqlValue::Integer(center_id),
                SqlValue::Integer(depth as i64),
                SqlValue::Integer(limit as i64 + 1),
            ];
            args.extend(fvals);
            let mut st = c.prepare_cached(&sql)?;
            let walked: Vec<(i64, u32)> = st
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            let mut truncated = walked.len() > limit;
            let mut ids: Vec<i64> = vec![center_id];
            ids.extend(walked.iter().take(limit).map(|(i, _)| *i));
            let (edge_list, _) = edges_among(c, &ids, &q.filter, false)?;

            // First hops and the hub guard: walk the returned subgraph from the center.
            let mut adj: HashMap<i64, Vec<usize>> = HashMap::new();
            for (i, e) in edge_list.iter().enumerate() {
                let Some(dst) = e.dst else { continue };
                if q.direction.out() {
                    adj.entry(e.src).or_default().push(i);
                }
                if q.direction.inward() {
                    adj.entry(dst).or_default().push(i);
                }
            }
            let mut reached: HashMap<i64, (u32, Option<usize>)> = HashMap::from([(center_id, (0, None))]);
            let mut queue = VecDeque::from([center_id]);
            while let Some(at) = queue.pop_front() {
                let (d, via) = reached[&at];
                let hub = q.hub_guard
                    && at != center_id
                    && snap
                        .node_of_id(at)
                        .is_some_and(|n| snap.in_degree(n) + snap.out_degree(n) > HUB_GUARD);
                if d >= depth || hub {
                    continue;
                }
                for &ei in adj.get(&at).into_iter().flatten() {
                    let e = &edge_list[ei];
                    let next = if e.src == at { e.dst.unwrap_or(at) } else { e.src };
                    if reached.contains_key(&next) {
                        continue;
                    }
                    // Of the links joining two notes the first hop is the most telling one.
                    let best = adj[&at]
                        .iter()
                        .filter(|&&j| {
                            let f = &edge_list[j];
                            (f.src == at && f.dst == Some(next)) || (f.dst == Some(at) && f.src == next)
                        })
                        .min_by_key(|&&j| {
                            let f = &edge_list[j];
                            (kind_rank(f.kind), f.label.clone(), f.id)
                        })
                        .copied();
                    reached.insert(next, (d + 1, if at == center_id { best } else { via }));
                    queue.push_back(next);
                }
            }
            if reached.len() < ids.len() {
                truncated = true;
            }
            let keep: Vec<i64> = ids.iter().copied().filter(|i| reached.contains_key(i)).collect();
            let infos = file_infos(c, &keep)?;
            let mut tags = tags_of(c, &keep)?;
            let mut nodes: Vec<NeighborNode> = keep
                .iter()
                .filter_map(|id| {
                    let f = infos.get(id)?;
                    let (d, via) = reached[id];
                    Some(NeighborNode {
                        node: graph_node(f, &snap, &mut tags),
                        depth: d,
                        via: via.map(|i| (edge_list[i].kind, edge_list[i].label.clone())),
                    })
                })
                .collect();
            nodes[1..].sort_by(|a, b| a.depth.cmp(&b.depth).then(a.node.path.cmp(&b.node.path)));
            let kept: HashSet<i64> = keep.iter().copied().collect();
            let edges = edge_list
                .into_iter()
                .filter(|e| kept.contains(&e.src) && e.dst.is_some_and(|d| kept.contains(&d)))
                .collect();
            Ok(Neighborhood { nodes, edges, truncated })
        })
    }

    /// The shortest chain of links between two files (direction ignored, through notes only),
    /// at most `max_depth` steps, from the snapshot; `None` when there is none.
    pub fn shortest_path(
        &self,
        from: &str,
        to: &str,
        max_depth: usize,
    ) -> Res<Option<Vec<PathEdge>>> {
        let snap = self.graph_snapshot()?;
        let node = |p: &str| {
            snap.node_of_path(p)
                .ok_or_else(|| IndexError::Invalid(format!("not in the index: {p}")))
        };
        let (a, b) = (node(from)?, node(to)?);
        let Some(steps) = snap.shortest_path(a, b, max_depth.clamp(1, 12)) else {
            return Ok(None);
        };
        self.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT kind, label FROM edges WHERE src_id = ?1 AND dst_id = ?2",
            )?;
            let mut out = Vec::with_capacity(steps.len());
            for s in steps {
                let (src, dst) = if s.forward {
                    (s.from, s.to)
                } else {
                    (s.to, s.from)
                };
                let mut found: Vec<(EdgeKind, Option<String>)> = st
                    .query_map([snap.id(src), snap.id(dst)], |r| {
                        Ok((EdgeKind::from_column(&r.get::<_, String>(0)?), r.get(1)?))
                    })?
                    .collect::<Result<_, _>>()?;
                found.sort_by_key(|(k, _)| kind_rank(*k));
                let (kind, label) = found
                    .into_iter()
                    .next()
                    .ok_or_else(|| IndexError::Internal("a path step without an edge".into()))?;
                out.push(PathEdge {
                    from: snap.path(s.from).to_string(),
                    to: snap.path(s.to).to_string(),
                    direction: if s.forward { "out" } else { "in" },
                    kind,
                    label,
                });
            }
            Ok(Some(out))
        })
    }

    /// Property names used as relationships, with how many edges and notes use each.
    pub fn relationship_labels(&self) -> Res<Vec<LabelCount>> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT label, COUNT(*), COUNT(DISTINCT src_id) FROM edges \
                 WHERE kind = 'property' GROUP BY label ORDER BY COUNT(*) DESC, label",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(LabelCount {
                        label: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        edges: r.get(1)?,
                        notes: r.get(2)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Property edges, optionally only those of one property name and/or touching one note
    /// (as source or as target).
    pub fn relationships(&self, file: Option<&str>, label: Option<&str>) -> Res<Vec<Relationship>> {
        self.read(|c| {
            let file_id = file.map(|f| self.file_id(c, f)).transpose()?;
            let mut st = c.prepare(
                "SELECT s.path, COALESCE(e.label, ''), d.path, e.target, e.line FROM edges e \
                 JOIN files s ON s.id = e.src_id LEFT JOIN files d ON d.id = e.dst_id \
                 WHERE e.kind = 'property' AND (?1 IS NULL OR e.label = ?1) \
                   AND (?2 IS NULL OR e.src_id = ?2 OR e.dst_id = ?2) \
                 ORDER BY e.label, s.path, e.ord",
            )?;
            let rows = st
                .query_map(params![label, file_id], |r| {
                    let resolved: Option<String> = r.get(2)?;
                    Ok(Relationship {
                        source: r.get(0)?,
                        label: r.get(1)?,
                        resolved: resolved.is_some(),
                        target: resolved.map_or_else(|| r.get(3), Ok)?,
                        line: r.get(4)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Links to `path` with their kind, property, line and section, in source and document
    /// order, at most `limit`.
    pub fn backlink_details(&self, path: &str, limit: usize) -> Res<Vec<BacklinkDetail>> {
        self.read(|c| {
            let id = self.file_id(c, path)?;
            let mut st = c.prepare_cached(
                "SELECT s.path, e.kind, e.label, e.line, e.section, e.display, e.subpath, e.ambiguous, e.target \
                 FROM edges e JOIN files s ON s.id = e.src_id \
                 WHERE e.dst_id = ?1 AND e.src_id <> ?1 ORDER BY s.path, e.ord LIMIT ?2",
            )?;
            let rows = st
                .query_map(params![id, limit as i64], |r| {
                    Ok(BacklinkDetail {
                        source: r.get(0)?,
                        kind: EdgeKind::from_column(&r.get::<_, String>(1)?),
                        label: r.get(2)?,
                        line: r.get(3)?,
                        section: r.get(4)?,
                        display: r.get(5)?,
                        subpath: r.get(6)?,
                        ambiguous: r.get(7)?,
                        target: r.get(8)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Notes not linked to `path` that share neighbours with it, ranked by the shared
    /// neighbours' rarity (`1 / (1 + degree)`, spec 7: the bundled SQLite has no `ln`).
    pub fn related(&self, path: &str, limit: usize) -> Res<Vec<RelatedNote>> {
        const WITH: &str = "WITH nb(id, w) AS ( \
              SELECT n.id, 1.0 / (1 + (SELECT COUNT(*) FROM edges x WHERE x.src_id = n.id) \
                                    + (SELECT COUNT(*) FROM edges x WHERE x.dst_id = n.id)) \
              FROM (SELECT dst_id AS id FROM edges WHERE src_id = ?1 AND dst_id IS NOT NULL AND dst_id <> ?1 \
                    UNION SELECT src_id FROM edges WHERE dst_id = ?1 AND src_id <> ?1) n \
            ), two(y, via, w) AS ( \
              SELECT e.dst_id, nb.id, nb.w FROM nb JOIN edges e ON e.src_id = nb.id WHERE e.dst_id IS NOT NULL \
              UNION SELECT e.src_id, nb.id, nb.w FROM nb JOIN edges e ON e.dst_id = nb.id \
            ) ";
        self.read(|c| {
            let id = self.file_id(c, path)?;
            let mut st = c.prepare(&format!(
                "{WITH} SELECT t.y, COUNT(*), SUM(t.w) AS score FROM two t JOIN files f ON f.id = t.y \
                 WHERE t.y <> ?1 AND f.ext = 'md' AND t.y NOT IN (SELECT id FROM nb) \
                 GROUP BY t.y ORDER BY score DESC, f.path LIMIT ?2"
            ))?;
            let top: Vec<(i64, i64, f64)> = st
                .query_map(params![id, limit as i64], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?
                .collect::<Result<_, _>>()?;
            if top.is_empty() {
                return Ok(Vec::new());
            }
            let ids: Vec<i64> = top.iter().map(|t| t.0).collect();
            let mut st = c.prepare(&format!(
                "{WITH} SELECT t.y, f.path FROM two t JOIN files f ON f.id = t.via \
                 WHERE t.y IN ({}) ORDER BY t.y, f.path",
                (2..2 + ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",")
            ))?;
            let args: Vec<SqlValue> = std::iter::once(id).chain(ids.iter().copied()).map(SqlValue::Integer).collect();
            let mut vias: HashMap<i64, Vec<String>> = HashMap::new();
            let mut rows = st.query(params_from_iter(args.iter()))?;
            while let Some(r) = rows.next()? {
                let v = vias.entry(r.get(0)?).or_default();
                if v.len() < VIA_NAMES {
                    v.push(r.get(1)?);
                }
            }
            let infos = file_infos(c, &ids)?;
            Ok(top
                .into_iter()
                .filter_map(|(y, shared, score)| {
                    Some(RelatedNote {
                        path: infos.get(&y)?.path.clone(),
                        score,
                        shared,
                        via: vias.remove(&y).unwrap_or_default(),
                    })
                })
                .collect())
        })
    }

    /// Markdown notes with no link in or out (other than to themselves).
    pub fn isolated_notes(&self) -> Res<Vec<String>> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT f.path FROM files f WHERE f.ext = 'md' \
                 AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_id = f.id AND e.src_id <> f.id) \
                 AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src_id = f.id AND (e.dst_id IS NULL OR e.dst_id <> f.id)) \
                 ORDER BY f.path",
            )?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// The most linked notes (distinct linked notes in plus out).
    pub fn hubs(&self, limit: usize) -> Res<Vec<HubInfo>> {
        let snap = self.graph_snapshot()?;
        Ok(snap
            .hubs(limit)
            .into_iter()
            .map(|h| HubInfo {
                path: snap.path(h.node).to_string(),
                degree_in: h.degree_in,
                degree_out: h.degree_out,
            })
            .collect())
    }

    /// Connected groups of notes, largest first, at most `limit`.
    pub fn components(&self, limit: usize) -> Res<Vec<ComponentInfo>> {
        let snap = self.graph_snapshot()?;
        Ok(snap
            .components()
            .into_iter()
            .take(limit)
            .map(|c| ComponentInfo {
                size: c.len(),
                example: snap.path(c[0]).to_string(),
            })
            .collect())
    }

    pub fn graph_stats(&self) -> Res<GraphStats> {
        let snap = self.graph_snapshot()?;
        let unresolved: i64 = self.read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(DISTINCT dst_key) FROM edges WHERE dst_id IS NULL AND dst_key <> ''",
                [],
                |r| r.get(0),
            )?)
        })?;
        Ok(GraphStats {
            notes: snap.note_count() as u32,
            edges: snap.pair_count() as u32,
            unresolved: unresolved as u32,
            components: snap.components().len() as u32,
        })
    }

    /// The graph view's data (spec 8.5): the neighbourhood of `center`, or the whole vault's
    /// highest-degree nodes, narrowed by the request's filters, with the edges among them.
    pub fn graph_slice(&self, req: &GraphSliceRequest) -> Res<GraphSlice> {
        let snap = self.graph_snapshot()?;
        let limit = (req.limit.map_or(DEFAULT_SLICE_LIMIT, |l| l as usize))
            .clamp(1, DEFAULT_SLICE_LIMIT * 2);
        let filter = EdgeFilter {
            kinds: req
                .kinds
                .iter()
                .flatten()
                .map(|k| k.as_str().to_string())
                .collect(),
            labels: req.labels.clone().unwrap_or_default(),
        };
        let ghosts = req.include_unresolved.unwrap_or(false);
        let attachments = req.include_attachments.unwrap_or(false);
        let folder_ok = |folder: &str| {
            req.folders.as_ref().is_none_or(|fs| {
                fs.iter().any(|f| {
                    let f = f.trim_matches('/');
                    f.is_empty() || folder == f || folder.starts_with(&format!("{f}/"))
                })
            })
        };
        let wanted_tags: Option<Vec<String>> = req.tags.as_ref().map(|ts| {
            ts.iter()
                .filter_map(|t| super::markdown::normalize_tag(t))
                .collect()
        });

        // 1. The node set, as ids, in the order the limit keeps them.
        let (mut ids, mut truncated) = match &req.center {
            Some(center) => {
                let hood = self.neighbors(
                    center,
                    &NeighborQuery {
                        depth: req.depth.unwrap_or(1).clamp(1, MAX_SLICE_DEPTH),
                        direction: Direction::Both,
                        filter: filter.clone(),
                        limit: limit.saturating_sub(1).max(1),
                        hub_guard: false,
                        attachments,
                    },
                )?;
                (
                    hood.nodes.iter().map(|n| n.node.id).collect::<Vec<_>>(),
                    hood.truncated,
                )
            }
            None => {
                let mut cands: Vec<u32> = (0..snap.node_count() as u32)
                    .filter(|&n| attachments || snap.is_note(n))
                    .collect();
                cands.sort_by(|&a, &b| {
                    (snap.in_degree(b) + snap.out_degree(b))
                        .cmp(&(snap.in_degree(a) + snap.out_degree(a)))
                        .then(a.cmp(&b))
                });
                (cands.into_iter().map(|n| snap.id(n)).collect(), false)
            }
        };
        let center_id = req
            .center
            .as_deref()
            .and_then(|c| snap.node_of_path(c))
            .map(|n| snap.id(n));

        self.read(|c| {
            // 2. Folder and tag narrowing (the center always stays); then the limit.
            if req.folders.is_none() && wanted_tags.is_none() && ids.len() > limit {
                // Nothing to narrow by: cut first so a huge vault is not read row by row.
                ids.truncate(limit);
                truncated = true;
            }
            let infos = file_infos(c, &ids)?;
            let mut tags = tags_of(c, &ids)?;
            ids.retain(|id| {
                Some(*id) == center_id
                    || infos.get(id).is_some_and(|f| {
                        folder_ok(&f.folder)
                            && wanted_tags.as_ref().is_none_or(|w| {
                                tags.get(id)
                                    .is_some_and(|t| t.iter().any(|x| w.contains(x)))
                            })
                    })
            });
            if ids.len() > limit {
                ids.truncate(limit);
                truncated = true;
            }
            let (edge_list, ghost_nodes) = edges_among(c, &ids, &filter, ghosts)?;
            let mut nodes: Vec<GraphNode> = ids
                .iter()
                .filter_map(|id| infos.get(id).map(|f| graph_node(f, &snap, &mut tags)))
                .collect();
            if let Some(keys) = req.card_properties.as_ref().filter(|k| !k.is_empty()) {
                let mut cards = card_values(c, &ids, keys)?;
                for n in &mut nodes {
                    n.card_value = cards.remove(&n.id);
                }
            }
            nodes.extend(ghost_nodes.into_iter().map(|(id, text)| GraphNode {
                id,
                name: text.rsplit('/').next().unwrap_or(&text).to_string(),
                path: text,
                folder: String::new(),
                ext: String::new(),
                degree_in: edge_list.iter().filter(|e| e.dst == Some(id)).count() as u32,
                degree_out: 0,
                tags: Vec::new(),
                unresolved: Some(true),
                card_value: None,
            }));
            Ok(GraphSlice {
                nodes,
                edges: edge_list,
                truncated,
                limit: limit as u32,
                epoch: snap.epoch,
            })
        })
    }
}
