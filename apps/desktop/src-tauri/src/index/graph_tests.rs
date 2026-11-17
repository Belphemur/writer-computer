//! Tests of the note graph's data layer: the `edges` table, its incremental maintenance and (as
//! the layers land) the traversals over it. Fixture vaults only.

use super::graph::{
    Direction, EdgeFilter, EdgeKind, EdgeKindFilter, GraphSliceRequest, NeighborQuery,
};
use super::markdown::LinkKind;
use super::resolve::{bucket_key, PathIndex};
use super::tests::{build_fixture, open, write, Fixture};
use super::*;
use super::{build, graph, schema};
use std::collections::BTreeMap;
use std::fs;

/// One `edges` row with the source and target paths joined in.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct EdgeRow {
    src: String,
    target: String,
    dst: Option<String>,
    kind: String,
    syntax: String,
    label: Option<String>,
    ambiguous: bool,
    ord: i64,
    line: Option<i64>,
    section: Option<String>,
    dst_key: String,
}

fn edge_rows(index: &Index) -> Vec<EdgeRow> {
    index
        .read(|c| {
            let mut st = c.prepare(
                "SELECT s.path, e.target, d.path, e.kind, e.syntax, e.label, e.ambiguous, e.ord, \
                        e.line, e.section, e.dst_key \
                 FROM edges e JOIN files s ON s.id = e.src_id LEFT JOIN files d ON d.id = e.dst_id \
                 ORDER BY s.path, e.ord",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(EdgeRow {
                        src: r.get(0)?,
                        target: r.get(1)?,
                        dst: r.get(2)?,
                        kind: r.get(3)?,
                        syntax: r.get(4)?,
                        label: r.get(5)?,
                        ambiguous: r.get(6)?,
                        ord: r.get(7)?,
                        line: r.get(8)?,
                        section: r.get(9)?,
                        dst_key: r.get(10)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap()
}

fn all_paths(index: &Index) -> Vec<String> {
    index
        .read(|c| {
            let mut st = c.prepare("SELECT path FROM files ORDER BY path")?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap()
}

/// Every stored `dst_id` and `ambiguous` equals what a resolver built from scratch over the
/// current files says: the bucketed passes never drift from a full pass.
fn assert_matches_full_resolution(index: &Index, when: &str) {
    let paths = PathIndex::from_paths(all_paths(index));
    for e in edge_rows(index) {
        let kind = LinkKind::from_parts(e.kind == "embed", e.syntax == "markdown");
        let want = paths.resolve_detailed(&e.src, &e.target, kind);
        assert_eq!(
            (e.dst.as_deref(), e.ambiguous),
            (
                want.as_ref().map(|r| r.path.as_str()),
                want.as_ref().is_some_and(|r| r.ambiguous)
            ),
            "{when}: {} -> [[{}]]",
            e.src,
            e.target
        );
        assert_eq!(e.dst_key, bucket_key(&e.target), "{when}");
    }
}

fn index_changes(index: &Index, rels: &[&str]) {
    let root = index.root().to_path_buf();
    index
        .index_paths_blocking(rels.iter().map(|r| root.join(r)).collect())
        .unwrap();
}

fn fixture() -> (Fixture, Index) {
    let fx = build_fixture();
    let index = open(&fx);
    (fx, index)
}

#[test]
fn bucketed_resolution_equals_a_full_pass_after_every_kind_of_change() {
    let (_fx, index) = fixture();
    let root = index.root().to_path_buf();
    let check = assert_matches_full_resolution;
    check(&index, "cold build");
    assert!(!edge_rows(&index).is_empty());

    // Create: an unresolved link attaches, a nearer duplicate takes over a resolved one.
    write(&root, "missing note.md", "# here\n");
    index_changes(&index, &["missing note.md"]);
    check(&index, "create");
    write(&root, "Notes/Beta.md", "closer duplicate\n");
    index_changes(&index, &["Notes/Beta.md"]);
    check(&index, "duplicate created");

    // Rename (delete + create of another name) and delete.
    fs::rename(
        root.join("missing note.md"),
        root.join("Notes/missing note.md"),
    )
    .unwrap();
    index_changes(&index, &["missing note.md", "Notes/missing note.md"]);
    check(&index, "rename");
    fs::remove_file(root.join("Notes/missing note.md")).unwrap();
    fs::remove_file(root.join("Projects/Beta.md")).unwrap();
    index_changes(&index, &["Notes/missing note.md", "Projects/Beta.md"]);
    check(&index, "delete");

    // A folder moved in and out.
    write(&root, "Staging/a.md", "# a\n[[Home]] [[Beta]]\n");
    write(&root, "Staging/Beta.md", "x\n");
    index_changes(&index, &["Staging"]);
    check(&index, "folder in");
    fs::remove_dir_all(root.join("Staging")).unwrap();
    index_changes(&index, &["Staging"]);
    check(&index, "folder out");

    // An edit replaces the note's edges only.
    write(&root, "Home.md", "# Home\n[[Alpha]]\n");
    index_changes(&index, &["Home.md"]);
    check(&index, "edit");
}

#[test]
fn edges_carry_kind_syntax_label_line_section_and_ambiguity() {
    let (_fx, index) = fixture();
    let rows: Vec<_> = edge_rows(&index)
        .into_iter()
        .filter(|e| e.src == "Projects/Alpha.md")
        .collect();
    fn describe(
        e: &EdgeRow,
    ) -> (
        &str,
        &str,
        &str,
        Option<&str>,
        Option<i64>,
        Option<&str>,
        Option<&str>,
    ) {
        (
            e.target.as_str(),
            e.kind.as_str(),
            e.syntax.as_str(),
            e.label.as_deref(),
            e.line,
            e.section.as_deref(),
            e.dst.as_deref(),
        )
    }
    let got: Vec<_> = rows.iter().map(describe).collect();
    assert_eq!(
        got,
        vec![
            (
                "Beta",
                "property",
                "wikilink",
                Some("related"),
                Some(7),
                None,
                Some("Projects/Beta.md")
            ),
            (
                "People/Ann Lee",
                "property",
                "wikilink",
                Some("related"),
                Some(7),
                None,
                Some("People/Ann Lee.md")
            ),
            (
                "People/Ann Lee",
                "property",
                "wikilink",
                Some("owner"),
                Some(10),
                None,
                Some("People/Ann Lee.md")
            ),
            (
                "Beta",
                "link",
                "wikilink",
                None,
                Some(13),
                Some("Alpha"),
                Some("Projects/Beta.md")
            ),
            (
                "img/pic.png",
                "embed",
                "wikilink",
                None,
                Some(13),
                Some("Alpha"),
                Some("img/pic.png")
            ),
            (
                "../docs/spec.pdf",
                "link",
                "markdown",
                None,
                Some(13),
                Some("Alpha"),
                Some("docs/spec.pdf")
            ),
        ]
    );
    assert_eq!(
        rows.iter().map(|e| e.ord).collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4, 5]
    );
    // `[[Beta]]` from outside Projects/ has two candidates: Projects/Beta.md and Archive/Beta.md.
    let home_beta = edge_rows(&index)
        .into_iter()
        .find(|e| e.src == "Home.md" && e.target == "Beta")
        .unwrap();
    assert!(home_beta.ambiguous);
    assert!(rows.iter().all(|e| e.ambiguous == (e.target == "Beta")));
    // The broken block's body link is still an edge; its section is the heading above it.
    let broken: Vec<_> = edge_rows(&index)
        .into_iter()
        .filter(|e| e.src == "Meta/broken.md")
        .collect();
    assert_eq!(broken.len(), 1);
    assert_eq!(broken[0].section.as_deref(), Some("Broken Title"));
}

#[test]
fn section_and_display_are_truncated() {
    let (_fx, index) = fixture();
    let root = index.root().to_path_buf();
    let long_heading = "h".repeat(300);
    let long_alias = "é".repeat(500);
    write(
        &root,
        "Long.md",
        &format!("# {long_heading}\n[[Home|{long_alias}]]\n"),
    );
    index_changes(&index, &["Long.md"]);
    let (section, display): (String, String) = index
        .read(|c| {
            Ok(c.query_row(
                "SELECT e.section, e.display FROM edges e JOIN files f ON f.id = e.src_id \
                 WHERE f.path = 'Long.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(section.chars().count(), 120);
    assert_eq!(display.chars().count(), 200);
}

#[test]
fn deleting_a_target_unresolves_inbound_edges_and_a_same_named_file_takes_over() {
    let (_fx, index) = fixture();
    let root = index.root().to_path_buf();
    // Home -> Beta resolves to one of the two Beta notes; delete it, the other one takes over.
    let beta_target = |index: &Index| {
        edge_rows(index)
            .into_iter()
            .find(|e| e.src == "Home.md" && e.target == "Beta")
            .unwrap()
    };
    let first = beta_target(&index).dst.unwrap();
    fs::remove_file(root.join(&first)).unwrap();
    index_changes(&index, &[&first]);
    let after = beta_target(&index);
    assert!(after.dst.is_some() && after.dst.as_deref() != Some(first.as_str()));
    assert!(!after.ambiguous, "only one Beta is left");
    let other = after.dst.unwrap();
    fs::remove_file(root.join(&other)).unwrap();
    index_changes(&index, &[&other]);
    let gone = beta_target(&index);
    assert_eq!((gone.dst, gone.ambiguous), (None, false));
    assert_eq!(
        gone.dst_key, "beta",
        "the unresolved edge keeps what was written"
    );
}

#[test]
fn a_warm_scan_resolves_what_changed_while_the_app_was_closed() {
    let fx = build_fixture();
    let root = {
        let index = open(&fx);
        index.root().to_path_buf()
    };
    // Offline: a note appears for an unresolved link, an edited note gains links (one to the
    // new note), a duplicate disappears.
    write(&root, "missing note.md", "# here\n");
    write(
        &root,
        "Home.md",
        "# Home\n[[Alpha]] [[missing note]] [[ghost]]\n",
    );
    fs::remove_file(root.join("Projects/Beta.md")).unwrap();
    let index = open(&fx);
    assert_matches_full_resolution(&index, "warm scan");
    let home: Vec<_> = edge_rows(&index)
        .into_iter()
        .filter(|e| e.src == "Home.md")
        .map(|e| (e.target, e.dst))
        .collect();
    assert_eq!(
        home,
        vec![
            ("Alpha".to_string(), Some("Projects/Alpha.md".to_string())),
            (
                "missing note".to_string(),
                Some("missing note.md".to_string())
            ),
            ("ghost".to_string(), None),
        ]
    );
    // Links elsewhere to the removed duplicate now point at the surviving Beta.
    let beta: Vec<_> = edge_rows(&index)
        .into_iter()
        .filter(|e| e.target == "Beta")
        .map(|e| e.dst)
        .collect();
    assert!(!beta.is_empty());
    assert!(beta.iter().all(|d| d.as_deref() == Some("Archive/Beta.md")));
}

#[test]
fn a_batch_wider_than_the_bucket_limit_falls_back_to_a_full_pass() {
    let (_fx, index) = fixture();
    let root = index.root().to_path_buf();
    let n = edges::MAX_BUCKETS + 100;
    let mut rels = Vec::new();
    for i in 0..n {
        let rel = format!("Wide/w{i}.md");
        write(
            &root,
            &rel,
            &format!("# w{i}\n[[w{}]] [[missing note]]\n", (i + 1) % n),
        );
        rels.push(rel);
    }
    write(&root, "missing note.md", "# here\n");
    rels.push("missing note.md".into());
    let rels: Vec<&str> = rels.iter().map(String::as_str).collect();
    index_changes(&index, &rels);
    assert_matches_full_resolution(&index, "wide batch");
    assert!(edge_rows(&index)
        .iter()
        .filter(|e| e.src.starts_with("Wide/") && e.target == "missing note")
        .all(|e| e.dst.as_deref() == Some("missing note.md")));
}

// ---- traversals and listings ----------------------------------------------------------------

fn graph_vault() -> (Fixture, Index) {
    let fx = Fixture {
        vault: tempfile::TempDir::new().unwrap(),
        data: tempfile::TempDir::new().unwrap(),
    };
    let r = fx.vault.path();
    write(r, "People/Daniel.md", "---\nmanager: \"[[Priya]]\"\nteam:\n  - \"[[Ana]]\"\n  - \"[[Ben]]\"\ntags: [person/eng]\n---\n# Daniel\nWorks on [[Project X]]. Missing: [[ghost note]].\n");
    write(r, "People/Priya.md", "Priya manages [[Daniel]].\n");
    write(r, "People/Ana.md", "---\nmanager: \"[[Daniel]]\"\n---\n# Ana\n## Work\nOn [[Project X]] and [[Project X|again]].\n");
    write(r, "People/Ben.md", "[[Project X]] ![[logo.png]]\n");
    write(r, "Projects/Project X.md", "# P\n[[Ana]]\n");
    write(r, "Far.md", "[[Ben]]\n");
    write(r, "lone.md", "nothing here\n");
    write(r, "Island1.md", "[[Island2]]\n");
    write(r, "Island2.md", "x\n");
    std::fs::write(r.join("logo.png"), [0x89, 0x50]).unwrap();
    let index = open(&fx);
    (fx, index)
}

fn hood(index: &Index, center: &str, q: &NeighborQuery) -> Vec<(String, u32, Option<String>)> {
    index
        .neighbors(center, q)
        .unwrap()
        .nodes
        .into_iter()
        .map(|n| {
            (
                n.node.path,
                n.depth,
                n.via.map(|(k, l)| {
                    format!(
                        "{}{}",
                        k.as_str(),
                        l.map(|l| format!(":{l}")).unwrap_or_default()
                    )
                }),
            )
        })
        .collect()
}

#[test]
fn neighbors_walk_both_ways_by_depth_with_the_first_hop() {
    let (_fx, index) = graph_vault();
    let q = NeighborQuery {
        depth: 1,
        ..Default::default()
    };
    let d1 = hood(&index, "People/Daniel.md", &q);
    assert_eq!(
        d1,
        vec![
            ("People/Daniel.md".into(), 0, None),
            ("People/Ana.md".into(), 1, Some("property:manager".into())),
            ("People/Ben.md".into(), 1, Some("property:team".into())),
            ("People/Priya.md".into(), 1, Some("property:manager".into())),
            ("Projects/Project X.md".into(), 1, Some("link".into())),
        ]
    );
    let d2 = hood(
        &index,
        "People/Daniel.md",
        &NeighborQuery {
            depth: 2,
            ..Default::default()
        },
    );
    // Far is two hops away through Ben; the attachment is not walked into.
    assert!(d2.contains(&("Far.md".into(), 2, Some("property:team".into()))));
    assert!(!d2.iter().any(|n| n.0 == "logo.png"));
    let with = hood(
        &index,
        "People/Daniel.md",
        &NeighborQuery {
            depth: 2,
            attachments: true,
            ..Default::default()
        },
    );
    assert!(with.iter().any(|n| n.0 == "logo.png" && n.1 == 2));
    // Direction and label filter.
    let out = hood(
        &index,
        "People/Daniel.md",
        &NeighborQuery {
            depth: 1,
            direction: Direction::Out,
            ..Default::default()
        },
    );
    assert!(out.iter().all(|n| n.0 != "People/Priya.md" || n.1 == 1));
    let inbound = hood(
        &index,
        "People/Ana.md",
        &NeighborQuery {
            depth: 1,
            direction: Direction::In,
            ..Default::default()
        },
    );
    assert_eq!(
        inbound.iter().map(|n| n.0.as_str()).collect::<Vec<_>>(),
        ["People/Ana.md", "People/Daniel.md", "Projects/Project X.md"]
    );
    let by_label = hood(
        &index,
        "People/Daniel.md",
        &NeighborQuery {
            depth: 1,
            filter: EdgeFilter {
                kinds: vec![],
                labels: vec!["manager".into()],
            },
            ..Default::default()
        },
    );
    assert_eq!(
        by_label.iter().map(|n| n.0.as_str()).collect::<Vec<_>>(),
        ["People/Daniel.md", "People/Ana.md", "People/Priya.md"]
    );
}

#[test]
fn hubs_are_expanded_only_when_named_and_results_are_capped() {
    let (_fx, index) = graph_vault();
    let q = NeighborQuery {
        depth: 1,
        limit: 2,
        ..Default::default()
    };
    let hood = index.neighbors("People/Daniel.md", &q).unwrap();
    assert_eq!(hood.nodes.len(), 3, "center plus the limit");
    assert!(hood.truncated);
    // Edges only among the returned nodes.
    let ids: std::collections::HashSet<_> = hood.nodes.iter().map(|n| n.node.id).collect();
    assert!(hood
        .edges
        .iter()
        .all(|e| ids.contains(&e.src) && ids.contains(&e.dst.unwrap())));
    assert!(index.neighbors("nope.md", &q).is_err());
}

#[test]
fn shortest_path_names_each_step_edge() {
    let (_fx, index) = graph_vault();
    let steps = index
        .shortest_path("Far.md", "People/Priya.md", 6)
        .unwrap()
        .unwrap();
    let got: Vec<_> = steps
        .iter()
        .map(|s| {
            (
                s.from.as_str(),
                s.to.as_str(),
                s.direction,
                s.kind.as_str(),
                s.label.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("Far.md", "People/Ben.md", "out", "link", None),
            (
                "People/Ben.md",
                "People/Daniel.md",
                "in",
                "property",
                Some("team")
            ),
            (
                "People/Daniel.md",
                "People/Priya.md",
                "out",
                "property",
                Some("manager")
            ),
        ]
    );
    assert!(index
        .shortest_path("Far.md", "Island1.md", 6)
        .unwrap()
        .is_none());
    assert!(index
        .shortest_path("Far.md", "People/Priya.md", 2)
        .unwrap()
        .is_none());
}

#[test]
fn relationships_labels_backlinks_related_and_isolated() {
    let (_fx, index) = graph_vault();
    let labels: Vec<_> = index
        .relationship_labels()
        .unwrap()
        .into_iter()
        .map(|l| (l.label, l.edges, l.notes))
        .collect();
    assert_eq!(
        labels,
        vec![("manager".into(), 2, 2), ("team".into(), 2, 1)]
    );
    let rels = index.relationships(Some("People/Daniel.md"), None).unwrap();
    let got: Vec<_> = rels
        .iter()
        .map(|r| {
            (
                r.source.as_str(),
                r.label.as_str(),
                r.target.as_str(),
                r.resolved,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("People/Ana.md", "manager", "People/Daniel.md", true),
            ("People/Daniel.md", "manager", "People/Priya.md", true),
            ("People/Daniel.md", "team", "People/Ana.md", true),
            ("People/Daniel.md", "team", "People/Ben.md", true),
        ]
    );
    assert_eq!(index.relationships(None, Some("team")).unwrap().len(), 2);

    let back = index.backlink_details("Projects/Project X.md", 10).unwrap();
    let got: Vec<_> = back
        .iter()
        .map(|b| {
            (
                b.source.as_str(),
                b.kind.as_str(),
                b.line,
                b.section.as_deref(),
                b.display.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("People/Ana.md", "link", Some(6), Some("Work"), None),
            (
                "People/Ana.md",
                "link",
                Some(6),
                Some("Work"),
                Some("again")
            ),
            ("People/Ben.md", "link", Some(1), None, None),
            ("People/Daniel.md", "link", Some(9), Some("Daniel"), None),
        ]
    );
    assert_eq!(
        index
            .backlink_details("Projects/Project X.md", 1)
            .unwrap()
            .len(),
        1
    );

    // Priya shares Daniel with Ana/Ben/Project X: she is linked to Daniel, they are not to her.
    let related = index.related("People/Priya.md", 10).unwrap();
    let names: Vec<_> = related.iter().map(|r| r.path.as_str()).collect();
    assert!(names.contains(&"People/Ana.md") && names.contains(&"People/Ben.md"));
    assert!(!names.contains(&"People/Daniel.md"));
    assert!(related
        .iter()
        .all(|r| r.via == vec!["People/Daniel.md".to_string()] && r.shared == 1));
    assert!(related.windows(2).all(|w| w[0].score >= w[1].score));

    assert_eq!(index.isolated_notes().unwrap(), vec!["lone.md"]);
}

#[test]
fn hubs_components_and_stats_come_from_the_snapshot() {
    let (_fx, index) = graph_vault();
    let hubs = index.hubs(3).unwrap();
    assert_eq!(hubs[0].path, "People/Daniel.md");
    assert_eq!(hubs.len(), 3);
    let comps = index.components(10).unwrap();
    assert_eq!(
        comps
            .iter()
            .map(|c| (c.size, c.example.as_str()))
            .collect::<Vec<_>>(),
        vec![(6, "Far.md"), (2, "Island1.md"), (1, "lone.md")]
    );
    let st = index.graph_stats().unwrap();
    assert_eq!((st.notes, st.unresolved, st.components), (9, 1, 3));
    assert!(st.edges >= 8);
}

#[test]
fn graph_slice_center_whole_ghosts_filters_and_wire_shape() {
    let (_fx, index) = graph_vault();
    let whole = index.graph_slice(&GraphSliceRequest::default()).unwrap();
    assert!(!whole.truncated);
    assert_eq!(whole.nodes.len(), 9, "notes only by default");
    assert_eq!(
        whole.nodes[0].path, "People/Daniel.md",
        "highest degree first"
    );
    assert!(whole.nodes.iter().all(|n| n.unresolved.is_none()));
    assert!(whole.edges.iter().all(|e| e.dst.is_some_and(|d| d > 0)));

    let ghosts = index
        .graph_slice(&GraphSliceRequest {
            include_unresolved: Some(true),
            include_attachments: Some(true),
            ..Default::default()
        })
        .unwrap();
    let ghost = ghosts
        .nodes
        .iter()
        .find(|n| n.unresolved == Some(true))
        .unwrap();
    assert!(ghost.id < 0 && ghost.path == "ghost note");
    assert!(ghosts.nodes.iter().any(|n| n.path == "logo.png"));
    assert!(ghosts.edges.iter().any(|e| e.dst == Some(ghost.id)));

    let local = index
        .graph_slice(&GraphSliceRequest {
            center: Some("People/Daniel.md".into()),
            depth: Some(1),
            ..Default::default()
        })
        .unwrap();
    let paths: Vec<_> = local.nodes.iter().map(|n| n.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "People/Daniel.md",
            "People/Ana.md",
            "People/Ben.md",
            "People/Priya.md",
            "Projects/Project X.md"
        ]
    );
    assert_eq!(
        (local.nodes[0].degree_in, local.nodes[0].degree_out),
        (2, 4)
    );
    assert_eq!(local.nodes[0].tags, vec!["person/eng"]);

    let narrow = index
        .graph_slice(&GraphSliceRequest {
            folders: Some(vec!["People".into()]),
            kinds: Some(vec![EdgeKindFilter::Property]),
            ..Default::default()
        })
        .unwrap();
    assert!(narrow.nodes.iter().all(|n| n.folder == "People"));
    assert!(narrow
        .edges
        .iter()
        .all(|e| e.kind == EdgeKind::Property && e.label.is_some()));
    let tagged = index
        .graph_slice(&GraphSliceRequest {
            tags: Some(vec!["person".into()]),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(tagged.nodes.len(), 1, "a nested tag matches its ancestor");

    let capped = index
        .graph_slice(&GraphSliceRequest {
            limit: Some(3),
            ..Default::default()
        })
        .unwrap();
    assert!(capped.truncated && capped.nodes.len() == 3);

    // Wire shape: camelCase, optional fields absent, kinds lowercase.
    let json = serde_json::to_value(&local).unwrap();
    let n0 = &json["nodes"][0];
    assert!(n0.get("degreeIn").is_some() && n0.get("unresolved").is_none());
    let e0 = json["edges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["label"] == "manager")
        .unwrap();
    assert_eq!(e0["kind"], "property");
    assert!(json["epoch"].is_u64() && json["truncated"] == false);
}

// ---- benchmark (spec 6.3) -------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, per_mille: u64) -> bool {
        self.next() % 1000 < per_mille
    }
}

/// A synthetic vault of `notes` notes with `10 * notes` links: 60 folders, 2% duplicate names,
/// preferential attachment (a few hubs), 10% property edges over five labels, 7% embeds, 3%
/// unresolved. Synthetic names only; returns the vault, the data dir and the busiest note name.
fn synthetic_vault(notes: usize) -> (Fixture, String) {
    let fx = Fixture {
        vault: tempfile::TempDir::new().unwrap(),
        data: tempfile::TempDir::new().unwrap(),
    };
    let mut rng = Rng(42);
    let mut name_of: Vec<String> = Vec::with_capacity(notes);
    for i in 0..notes {
        let dup = i > 100 && rng.chance(20);
        name_of.push(if dup {
            name_of[rng.below(i)].clone()
        } else {
            format!("n{i}")
        });
    }
    let mut cited: Vec<usize> = (0..notes.min(50)).collect();
    let mut cites = vec![0usize; notes];
    const LABELS: [&str; 5] = ["manager", "reports-to", "project", "related", "author"];
    for (i, name) in name_of.iter().enumerate() {
        let mut props: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        let mut body = String::new();
        if i % 4 != 3 {
            // 25% of notes link to nothing; 13 links for the rest make 10 per note on average
            for _ in 0..13 {
                let target = if rng.chance(500) {
                    rng.below(notes)
                } else {
                    cited[rng.below(cited.len())]
                };
                let text = if rng.chance(30) {
                    format!("missing{}", rng.below(notes))
                } else {
                    cites[target] += 1;
                    cited.push(target);
                    name_of[target].clone()
                };
                if rng.chance(100) {
                    props
                        .entry(LABELS[rng.below(5)])
                        .or_default()
                        .push(format!("\"[[{text}]]\""));
                } else if rng.chance(78) {
                    body.push_str(&format!("![[{text}]]\n"));
                } else {
                    body.push_str(&format!("see [[{text}]] here\n"));
                }
            }
        }
        let mut fm = String::new();
        for (k, v) in &props {
            fm.push_str(&format!("{k}: [{}]\n", v.join(", ")));
        }
        let text = format!("---\ntitle: {name}\n{fm}---\n# {name}\n{body}");
        write(
            fx.vault.path(),
            &format!("f{:02}/{name}-{i}.md", i % 60),
            &text,
        );
    }
    // Files are named `<name>-<i>`: a link is by name, so strip nothing here, rename to the bare
    // name when unique so links resolve (a duplicate keeps its suffix-free twin in another folder).
    let mut seen = std::collections::HashSet::new();
    for (i, name) in name_of.iter().enumerate() {
        let from = fx
            .vault
            .path()
            .join(format!("f{:02}/{name}-{i}.md", i % 60));
        let to_dir = format!("f{:02}", i % 60);
        let key = (to_dir.clone(), name.clone());
        if seen.insert(key) {
            fs::rename(from, fx.vault.path().join(format!("{to_dir}/{name}.md"))).unwrap();
        }
    }
    let busiest = cites
        .iter()
        .enumerate()
        .max_by_key(|(_, c)| **c)
        .map(|(i, _)| name_of[i].clone())
        .unwrap();
    (fx, busiest)
}

fn best_of<T>(runs: usize, mut f: impl FnMut() -> T) -> std::time::Duration {
    (0..runs)
        .map(|_| {
            let t = std::time::Instant::now();
            std::hint::black_box(f());
            t.elapsed()
        })
        .min()
        .unwrap()
}

fn bench_graph(notes: usize, scale: f64, assert_budgets: bool) {
    use std::time::Duration;
    let t = std::time::Instant::now();
    let (fx, hub_name) = synthetic_vault(notes);
    println!(
        "GRAPH_BENCH {notes} notes: vault written in {:?}",
        t.elapsed()
    );
    let t = std::time::Instant::now();
    let index = open(&fx);
    let cold = t.elapsed();
    let edge_count: i64 = index
        .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))?))
        .unwrap();
    let db_kb = fs::metadata(index.db_path()).unwrap().len() / 1024;
    println!("GRAPH_BENCH {notes} notes, {edge_count} edges: cold build {cold:?}, db {db_kb} KB");

    let hub = format!("{}.md", hub_name);
    let hub_path = all_paths(&index)
        .into_iter()
        .find(|p| p.ends_with(&format!("/{hub}")))
        .unwrap();
    let mid_path = all_paths(&index).into_iter().nth(notes / 2).unwrap();
    let far_path = all_paths(&index).into_iter().nth(notes / 3).unwrap();
    let mut failures: Vec<String> = Vec::new();
    let mut check = |name: &str, budget_ms: f64, took: Duration| {
        let budget = Duration::from_secs_f64(budget_ms * scale / 1000.0);
        println!(
            "GRAPH_BENCH   {name:<44} {:>9.3} ms (budget {:>7.1} ms)",
            took.as_secs_f64() * 1e3,
            budget.as_secs_f64() * 1e3
        );
        if took > budget {
            failures.push(format!("{name}: {took:?} > {budget:?}"));
        }
    };

    // First whole-graph call builds the snapshot.
    let first = best_of(1, || index.shortest_path(&mid_path, &far_path, 6).unwrap());
    check("shortest path, first call (builds snapshot)", 100.0, first);
    check(
        "shortest path, snapshot",
        10.0,
        best_of(5, || index.shortest_path(&mid_path, &far_path, 6).unwrap()),
    );
    check(
        "snapshot build",
        30.0,
        best_of(3, || index.read(|c| graph::load_snapshot(c, 0)).unwrap()),
    );
    check(
        "backlinks of the hub",
        5.0,
        best_of(5, || index.backlinks(&hub_path).unwrap()),
    );
    check(
        "backlink details of the hub",
        5.0,
        best_of(5, || index.backlink_details(&hub_path, 50).unwrap()),
    );
    check(
        "backlinks of a mid note",
        5.0,
        best_of(5, || index.backlinks(&mid_path).unwrap()),
    );
    check(
        "outlinks of a mid note",
        5.0,
        best_of(5, || index.links(&mid_path).unwrap()),
    );
    let q = |depth, limit| NeighborQuery {
        depth,
        limit,
        hub_guard: false,
        ..Default::default()
    };
    check(
        "neighbors depth 1 (hub)",
        5.0,
        best_of(5, || index.neighbors(&hub_path, &q(1, 2000)).unwrap()),
    );
    check(
        "neighbors depth 2 (hub)",
        25.0,
        best_of(5, || index.neighbors(&hub_path, &q(2, 2000)).unwrap()),
    );
    check(
        "neighbors depth 3 (hub, capped 2k)",
        80.0,
        best_of(3, || index.neighbors(&hub_path, &q(3, 2000)).unwrap()),
    );
    check(
        "neighbors depth 2 (mid)",
        25.0,
        best_of(5, || index.neighbors(&mid_path, &q(2, 2000)).unwrap()),
    );
    check(
        "orphans (no incoming)",
        15.0,
        best_of(3, || index.orphans().unwrap()),
    );
    check(
        "isolated notes (no edges)",
        15.0,
        best_of(3, || index.isolated_notes().unwrap()),
    );
    check(
        "unresolved",
        15.0,
        best_of(3, || index.unresolved().unwrap()),
    );
    check(
        "degree top 20 (hubs)",
        15.0,
        best_of(3, || index.hubs(20).unwrap()),
    );
    check(
        "edges by label",
        5.0,
        best_of(5, || index.relationships(None, Some("manager")).unwrap()),
    );
    check(
        "related notes (hub)",
        100.0,
        best_of(3, || index.related(&hub_path, 10).unwrap()),
    );
    check(
        "related notes (mid)",
        100.0,
        best_of(3, || index.related(&mid_path, 10).unwrap()),
    );
    check(
        "components",
        15.0,
        best_of(3, || index.components(20).unwrap()),
    );

    // Re-resolution of one created note named like the hub (the largest bucket), against a
    // second write connection to the same database.
    {
        let mut conn = rusqlite::Connection::open(index.db_path()).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let paths = build::load_path_index(&conn).unwrap();
        let took = best_of(5, || {
            let tx = conn.transaction().unwrap();
            let n = edges::resolve_after_changes(&tx, &paths, &[], [format!("zz/{hub}").as_str()])
                .unwrap();
            drop(tx);
            n
        });
        check("re-resolve for one created note (hub name)", 5.0, took);
    }
    // Incremental write of one edited note.
    let root = index.root().to_path_buf();
    let mut n = 0;
    let took = best_of(5, || {
        n += 1;
        write(&root, &mid_path, &format!("---\nmanager: \"[[{hub_name}]]\"\n---\n# edit {n}\n[[{hub_name}]] [[n1]] [[n2]] [[n3]]\n"));
        index
            .index_paths_blocking(vec![root.join(&mid_path)])
            .unwrap()
    });
    check("incremental write of one edited note", 20.0, took);

    // The view's whole-vault slice at its default cap (spec 8.5): query and JSON.
    let req = GraphSliceRequest::default();
    let slice_took = best_of(3, || index.graph_slice(&req).unwrap());
    let slice = index.graph_slice(&req).unwrap();
    let ser_took = best_of(3, || serde_json::to_vec(&slice).unwrap());
    let json_len = serde_json::to_vec(&slice).unwrap().len();
    println!(
        "GRAPH_BENCH   slice: {} nodes, {} edges, truncated {}, {} KB of JSON",
        slice.nodes.len(),
        slice.edges.len(),
        slice.truncated,
        json_len / 1024
    );
    let cap = if slice.nodes.len() >= 5000 { 1.0 } else { 0.5 };
    check(
        "graph_slice whole vault (<= 10k nodes)",
        400.0 * cap,
        slice_took,
    );
    check("graph_slice JSON serialisation", 150.0 * cap, ser_took);
    check(
        "graph_slice around the hub, depth 2",
        100.0,
        best_of(3, || {
            index
                .graph_slice(&GraphSliceRequest {
                    center: Some(hub_path.clone()),
                    depth: Some(2),
                    limit: Some(10_000),
                    ..Default::default()
                })
                .unwrap()
        }),
    );
    check(
        "graph_stats",
        40.0,
        best_of(3, || index.graph_stats().unwrap()),
    );

    assert_matches_full_resolution_sample(&index);
    if assert_budgets {
        assert!(failures.is_empty(), "over budget:\n{}", failures.join("\n"));
    } else if !failures.is_empty() {
        println!(
            "GRAPH_BENCH over the (informational) budget:\n{}",
            failures.join("\n")
        );
    }
}

/// A cheap drift check for big vaults: every 97th edge equals a fresh resolution.
fn assert_matches_full_resolution_sample(index: &Index) {
    let paths = PathIndex::from_paths(all_paths(index));
    for e in edge_rows(index).into_iter().step_by(97) {
        let kind = LinkKind::from_parts(e.kind == "embed", e.syntax == "markdown");
        let want = paths
            .resolve_detailed(&e.src, &e.target, kind)
            .map(|r| r.path);
        assert_eq!(e.dst, want, "{} -> {}", e.src, e.target);
    }
}

/// `cargo test --release graph_bench -- --ignored --nocapture`
#[test]
#[ignore]
fn graph_bench_5k_notes_50k_edges_with_budgets() {
    bench_graph(5_000, 1.0, true);
}

#[test]
#[ignore]
fn graph_bench_20k_notes_200k_edges() {
    bench_graph(20_000, 8.0, true);
}

#[test]
#[ignore]
fn graph_bench_100k_notes_1m_edges() {
    bench_graph(100_000, 40.0, false);
}

fn edge_index_names(index: &Index) -> Vec<String> {
    index
        .read(|c| {
            let mut st = c.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'edges' \
                 AND name LIKE 'edges_%' ORDER BY name",
            )?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap()
}

#[test]
fn the_edge_indexes_exist_after_a_cold_build_and_are_restored_by_the_next_scan() {
    let (fx, index) = fixture();
    let all = ["edges_dst", "edges_key", "edges_label", "edges_src"];
    assert_eq!(edge_index_names(&index), all);
    drop(index);
    // A cold build cut short leaves its indexes dropped; the next scan puts them back.
    let conn = rusqlite::Connection::open(index_db_path(
        fx.data.path(),
        &fx.vault.path().canonicalize().unwrap(),
    ))
    .unwrap();
    conn.execute_batch(schema::DROP_EDGE_INDEXES).unwrap();
    drop(conn);
    let index = open(&fx);
    assert_eq!(edge_index_names(&index), all);
    assert_matches_full_resolution(&index, "after restore");
}

#[test]
fn query_plans_use_the_edge_indexes() {
    let (_fx, index) = fixture();
    let plan = |sql: &str| -> String {
        index
            .read(|c| {
                let mut st = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let rows: Vec<String> = st
                    .query_map([], |r| r.get::<_, String>(3))?
                    .collect::<Result<_, _>>()?;
                Ok(rows.join(" | "))
            })
            .unwrap()
    };
    let backlinks = plan("SELECT e.src_id FROM edges e WHERE e.dst_id = 1 AND e.src_id <> 1 ORDER BY e.src_id, e.ord");
    assert!(backlinks.contains("edges_dst"), "{backlinks}");
    let outlinks = plan("SELECT e.id FROM edges e WHERE e.src_id = 1 ORDER BY e.ord");
    assert!(outlinks.contains("edges_src"), "{outlinks}");
    let label = plan("SELECT e.src_id FROM edges e WHERE e.label = 'manager'");
    assert!(label.contains("edges_label"), "{label}");
    let key = plan("SELECT e.id FROM edges e WHERE e.dst_key = 'beta'");
    assert!(key.contains("edges_key"), "{key}");
    for p in [&backlinks, &outlinks, &label, &key] {
        assert!(!p.contains("SCAN e") && !p.contains("SCAN edges"), "{p}");
    }
}

#[test]
fn line_snippet_checks_the_line_and_caps_it() {
    let text = "first\n  see [[Target]] here  \nlast";
    assert_eq!(
        graph::line_snippet(text, 2, "Target", 240).as_deref(),
        Some("see [[Target]] here")
    );
    assert_eq!(
        graph::line_snippet(text, 1, "Target", 240),
        None,
        "the file changed"
    );
    assert_eq!(graph::line_snippet(text, 9, "Target", 240), None);
    assert_eq!(graph::line_snippet(text, 0, "Target", 240), None);
    let long = format!("[[T]] {}", "é".repeat(500));
    let s = graph::line_snippet(&long, 1, "T", 240).unwrap();
    assert_eq!(s.chars().count(), 243);
}

#[test]
fn card_values_come_from_the_property_tables_in_priority_order() {
    let (_fx, index) = graph_vault();
    let root = index.root().to_path_buf();
    write(
        &root,
        "Cards/A.md",
        "---\nStatus: done\ntype: \"\"\n---\n[[Daniel]]\n",
    );
    write(
        &root,
        "Cards/B.md",
        "---\nTYPE: person\nstatus: done\n---\n[[Daniel]]\n",
    );
    write(
        &root,
        "Cards/C.md",
        &format!(
            "---\ntype:\n  - alpha\n  - beta\n  - {}\n---\n[[Daniel]]\n",
            "x".repeat(80)
        ),
    );
    write(&root, "Cards/D.md", "---\nnothing: here\n---\n[[Daniel]]\n");
    index_changes(&index, &["Cards"]);
    let card = |cards: Option<Vec<&str>>| {
        let slice = index
            .graph_slice(&GraphSliceRequest {
                center: Some("People/Daniel.md".into()),
                depth: Some(1),
                card_properties: cards.map(|c| c.into_iter().map(String::from).collect()),
                ..Default::default()
            })
            .unwrap();
        slice
            .nodes
            .into_iter()
            .filter(|n| n.path.starts_with("Cards/"))
            .map(|n| (n.name, n.card_value))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let got = card(Some(vec!["type", "status"]));
    assert_eq!(
        got["A.md"].as_deref(),
        Some("done"),
        "an empty type falls through to status"
    );
    assert_eq!(
        got["B.md"].as_deref(),
        Some("person"),
        "keys match case-insensitively, first wins"
    );
    let list = got["C.md"].as_deref().unwrap();
    assert!(
        list.starts_with("alpha, beta, xxx") && list.chars().count() == 60,
        "{list}"
    );
    assert_eq!(got["D.md"], None);
    // Without cardProperties (or empty) no value is computed, and the field is not serialised.
    assert!(card(None).values().all(|v| v.is_none()));
    assert!(card(Some(vec![])).values().all(|v| v.is_none()));
    let json =
        serde_json::to_value(index.graph_slice(&GraphSliceRequest::default()).unwrap()).unwrap();
    assert!(json["nodes"][0].get("cardValue").is_none());
}
