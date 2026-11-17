//! The note graph's one table, `edges` (spec `SPECs/note-graph-spec.md` sections 4 and 5): one
//! row per link occurrence, written with its note and re-resolved when the set of vault files
//! changes. Everything that knows how a link becomes a row lives here; readers are
//! `query.rs` (listings) and `graph.rs` (traversals).

use super::markdown::LinkKind;
use super::note::LinkRow;
use super::resolve::{bucket_key, PathIndex};
use super::IndexError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// `edges.kind`: where the edge comes from. The one vocabulary: the column text, the graph's
/// `kind` filters (view and `writer graph:*`) and the wire type all come from here. (The
/// parser's `LinkKind` is a different fact: how a link was written, four syntaxes; it is mapped
/// to this and `SYNTAX_*` once, in [`kind_and_syntax`].)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    Link,
    Embed,
    Property,
}

impl EdgeKind {
    pub const ALL: [EdgeKind; 3] = [Self::Link, Self::Embed, Self::Property];

    /// The `edges.kind` column text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Link => "link",
            Self::Embed => "embed",
            Self::Property => "property",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// A value read back from the column (written only through [`Self::as_str`]).
    pub(crate) fn from_column(s: &str) -> Self {
        Self::parse(s).unwrap_or(Self::Link)
    }
}

/// `edges.syntax`: how it was written.
pub const SYNTAX_WIKILINK: &str = "wikilink";
pub const SYNTAX_MARKDOWN: &str = "markdown";

/// Longest `section` and `display` kept per edge, in characters.
const SECTION_MAX: usize = 120;
const DISPLAY_MAX: usize = 200;

/// A batch with more distinct file-name buckets or written notes than this re-resolves every
/// edge instead: past it the per-bucket lookups cost more than one scan (spec 5.2: 2,000).
pub const MAX_BUCKETS: usize = 2000;

/// `(kind, syntax)` columns of a link. A frontmatter link is a `property` edge whatever its
/// syntax (so an embed written in a property value is a plain property edge).
pub fn kind_and_syntax(row: &LinkRow) -> (EdgeKind, &'static str) {
    let syntax = if row.link.kind.is_markdown() {
        SYNTAX_MARKDOWN
    } else {
        SYNTAX_WIKILINK
    };
    let kind = if row.in_fm {
        EdgeKind::Property
    } else if row.link.kind.is_embed() {
        EdgeKind::Embed
    } else {
        EdgeKind::Link
    };
    (kind, syntax)
}

/// The listing APIs' historical `kind` text (`wikilink`, `embed`, `markdown`, `markdown_embed`)
/// from the `(kind, syntax)` columns: the one place the two vocabularies meet.
pub fn legacy_link_kind(kind: EdgeKind, syntax: &str) -> &'static str {
    match (kind == EdgeKind::Embed, syntax == SYNTAX_MARKDOWN) {
        (false, false) => "wikilink",
        (true, false) => "embed",
        (false, true) => "markdown",
        (true, true) => "markdown_embed",
    }
}

/// How the resolver should read an edge row (it only distinguishes markdown from wikilinks).
fn resolver_kind(kind: EdgeKind, syntax: &str) -> LinkKind {
    LinkKind::from_parts(kind == EdgeKind::Embed, syntax == SYNTAX_MARKDOWN)
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// `files.id` by path, remembered for the length of one pass.
struct IdLookup<'c> {
    conn: &'c Connection,
    cache: HashMap<String, Option<i64>>,
}

impl<'c> IdLookup<'c> {
    fn new(conn: &'c Connection) -> Self {
        Self {
            conn,
            cache: HashMap::new(),
        }
    }

    fn get(&mut self, path: &str) -> Result<Option<i64>, IndexError> {
        if let Some(id) = self.cache.get(path) {
            return Ok(*id);
        }
        let id = self
            .conn
            .prepare_cached("SELECT id FROM files WHERE path = ?1")?
            .query_row([path], |r| r.get(0))
            .optional()?;
        self.cache.insert(path.to_string(), id);
        Ok(id)
    }
}

/// Insert the edges of one note (`links` in document order, frontmatter first). With a
/// `resolver` they are resolved at once; otherwise `dst_id` stays NULL for a later
/// [`resolve_edges`] pass.
pub(crate) fn write_edges(
    conn: &Connection,
    src_id: i64,
    src_path: &str,
    links: &[LinkRow],
    resolver: Option<&PathIndex>,
) -> Result<(), IndexError> {
    let mut ids = IdLookup::new(conn);
    let mut st = conn.prepare_cached(
        "INSERT INTO edges(src_id,dst_id,dst_key,target,kind,syntax,label,ambiguous,ord,line,section,display,subpath) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
    )?;
    for (ord, l) in links.iter().enumerate() {
        let (kind, syntax) = kind_and_syntax(l);
        let resolved =
            resolver.and_then(|r| r.resolve_detailed(src_path, &l.link.raw, l.link.kind));
        let (dst_id, ambiguous) = match &resolved {
            Some(r) => (ids.get(&r.path)?, r.ambiguous),
            None => (None, false),
        };
        st.execute(params![
            src_id,
            dst_id,
            bucket_key(&l.link.raw),
            l.link.raw,
            kind.as_str(),
            syntax,
            l.label,
            ambiguous,
            ord as i64,
            l.line,
            l.section.as_deref().map(|s| truncate(s, SECTION_MAX)),
            l.link.display.as_deref().map(|s| truncate(s, DISPLAY_MAX)),
            l.link.subpath,
        ])?;
    }
    Ok(())
}

/// Which edges a [`resolve_edges`] pass looks at.
pub(crate) enum Scope<'a> {
    /// Every edge of the vault.
    All,
    /// Edges written by these source files.
    Sources(&'a [i64]),
    /// Edges whose target bucket is one of these [`bucket_key`]s: the only ones a change to the
    /// set of vault files can affect.
    Buckets(&'a [String]),
}

/// Recompute `dst_id` and `ambiguous` of the edges in `scope` against `paths` (the vault's
/// current file set). Writes only the rows that change; returns how many did.
pub(crate) fn resolve_edges(
    conn: &Connection,
    paths: &PathIndex,
    scope: Scope,
) -> Result<usize, IndexError> {
    struct Update {
        id: i64,
        dst: Option<i64>,
        ambiguous: bool,
    }
    const BASE: &str = "SELECT e.id, f.path, e.target, e.kind, e.syntax, e.dst_id, e.ambiguous \
                        FROM edges e JOIN files f ON f.id = e.src_id";
    let mut ids = IdLookup::new(conn);
    let mut updates: Vec<Update> = Vec::new();
    let mut collect = |sql: &str, arg: Option<&dyn rusqlite::ToSql>| -> Result<(), IndexError> {
        let mut st = conn.prepare_cached(sql)?;
        let mut rows = match arg {
            Some(a) => st.query([a])?,
            None => st.query([])?,
        };
        while let Some(r) = rows.next()? {
            let (src, target): (String, String) = (r.get(1)?, r.get(2)?);
            let (kind, syntax): (String, String) = (r.get(3)?, r.get(4)?);
            let (old_dst, old_amb): (Option<i64>, bool) = (r.get(5)?, r.get(6)?);
            let found = paths.resolve_detailed(
                &src,
                &target,
                resolver_kind(EdgeKind::from_column(&kind), &syntax),
            );
            let (dst, ambiguous) = match &found {
                Some(f) => (ids.get(&f.path)?, f.ambiguous),
                None => (None, false),
            };
            if (dst, ambiguous) != (old_dst, old_amb) {
                updates.push(Update {
                    id: r.get(0)?,
                    dst,
                    ambiguous,
                });
            }
        }
        Ok(())
    };
    match scope {
        Scope::All => collect(BASE, None)?,
        Scope::Sources(srcs) => {
            let sql = format!("{BASE} WHERE e.src_id = ?1");
            for id in srcs {
                collect(&sql, Some(id))?;
            }
        }
        Scope::Buckets(keys) => {
            let sql = format!("{BASE} WHERE e.dst_key = ?1");
            for key in keys {
                collect(&sql, Some(key))?;
            }
        }
    }
    let mut st =
        conn.prepare_cached("UPDATE edges SET dst_id = ?2, ambiguous = ?3 WHERE id = ?1")?;
    for u in &updates {
        st.execute(params![u.id, u.dst, u.ambiguous])?;
    }
    Ok(updates.len())
}

/// Re-resolve after a batch: the edges of `unresolved_sources` (notes written without a
/// resolver), then the edges whose target name matches a file in `changed_files` (added or
/// removed paths). Falls back to one pass over every edge when either list is too long for the
/// per-source and per-bucket lookups to pay (a folder rename, a git checkout).
pub(crate) fn resolve_after_changes<'a>(
    conn: &Connection,
    paths: &PathIndex,
    unresolved_sources: &[i64],
    changed_files: impl IntoIterator<Item = &'a str>,
) -> Result<usize, IndexError> {
    let mut keys: Vec<String> = changed_files
        .into_iter()
        .map(|p| bucket_key(p.rsplit('/').next().unwrap_or(p)))
        .collect();
    keys.sort_unstable();
    keys.dedup();
    if keys.len() > MAX_BUCKETS || unresolved_sources.len() > MAX_BUCKETS {
        return resolve_edges(conn, paths, Scope::All);
    }
    Ok(
        resolve_edges(conn, paths, Scope::Sources(unresolved_sources))?
            + resolve_edges(conn, paths, Scope::Buckets(&keys))?,
    )
}
