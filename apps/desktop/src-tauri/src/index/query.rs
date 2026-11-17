//! Read-only query API. Plain Rust, no `tauri::` types; backs the Tauri
//! commands and the CLI.

use super::{Index, IndexError};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::{BTreeMap, HashMap};

type Res<T> = Result<T, IndexError>;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub path: String,
    pub name: String,
    pub basename: String,
    pub ext: String,
    pub folder: String,
    pub size: i64,
    pub ctime: i64,
    pub mtime: i64,
    pub words: Option<i64>,
    pub chars: Option<i64>,
}

const FILE_COLS: &str =
    "f.path, f.name, f.basename, f.ext, f.folder, f.size, f.ctime, f.mtime, f.words, f.chars";

fn file_row(r: &rusqlite::Row) -> rusqlite::Result<FileRow> {
    Ok(FileRow {
        path: r.get(0)?,
        name: r.get(1)?,
        basename: r.get(2)?,
        ext: r.get(3)?,
        folder: r.get(4)?,
        size: r.get(5)?,
        ctime: r.get(6)?,
        mtime: r.get(7)?,
        words: r.get(8)?,
        chars: r.get(9)?,
    })
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileOrder {
    #[default]
    Path,
    Name,
    Mtime,
    Ctime,
    Size,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileFilter {
    /// Vault-relative folder; matches the folder and everything below it.
    pub folder: Option<String>,
    /// With `folder`: only files directly inside it.
    pub direct_only: bool,
    /// Extension without the dot, case-insensitive (`md`).
    pub ext: Option<String>,
    /// Tag with or without `#`; nested tags match their ancestors.
    pub tag: Option<String>,
    /// Files whose frontmatter defines this property.
    pub has_property: Option<String>,
    /// Case-insensitive substring of the file name.
    pub name_contains: Option<String>,
    pub order: FileOrder,
    pub descending: bool,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePage {
    /// Matches before `limit`/`offset`.
    pub total: i64,
    pub rows: Vec<FileRow>,
}

fn trim_folder(f: &str) -> &str {
    f.trim_matches('/')
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn where_clause(filter: &FileFilter) -> Res<(String, Vec<SqlValue>)> {
    let mut conds: Vec<String> = Vec::new();
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(folder) = &filter.folder {
        let folder = trim_folder(folder);
        if filter.direct_only {
            conds.push("f.folder = ?".into());
            args.push(folder.to_string().into());
        } else if !folder.is_empty() {
            conds.push("f.path >= ? AND f.path < ?".into());
            args.push(format!("{folder}/").into());
            args.push(format!("{folder}0").into());
        }
    }
    if let Some(ext) = &filter.ext {
        conds.push("f.ext = ?".into());
        args.push(ext.trim_start_matches('.').to_lowercase().into());
    }
    if let Some(tag) = &filter.tag {
        let tag = super::markdown::normalize_tag(tag)
            .ok_or_else(|| IndexError::Invalid(format!("invalid tag: {tag}")))?;
        conds.push("EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.tag = ?)".into());
        args.push(tag.into());
    }
    if let Some(key) = &filter.has_property {
        conds.push("EXISTS (SELECT 1 FROM props p WHERE p.file_id = f.id AND p.key = ?)".into());
        args.push(key.clone().into());
    }
    if let Some(q) = &filter.name_contains {
        conds.push("f.name LIKE ? ESCAPE '\\'".into());
        args.push(format!("%{}%", like_escape(q)).into());
    }
    let sql = if conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conds.join(" AND "))
    };
    Ok((sql, args))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    pub tag: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEntry {
    pub raw: String,
    /// Resolved vault-relative target, `None` when unresolved.
    pub target: Option<String>,
    pub kind: String,
    pub in_fm: bool,
    pub display: Option<String>,
    pub subpath: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkEntry {
    pub source: String,
    #[serde(flatten)]
    pub link: LinkEntry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingEntry {
    pub level: i64,
    pub text: String,
    pub line: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadata {
    pub path: String,
    /// Frontmatter as plain JSON (dates as strings; per-key types are in
    /// `properties()`); `None` when absent or unparsable (see `fm_error`).
    pub frontmatter: Option<Json>,
    pub fm_error: Option<String>,
    pub tags: Vec<TagEntry>,
    pub links: Vec<LinkEntry>,
    pub headings: Vec<HeadingEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataResult {
    pub notes: Vec<NoteMetadata>,
    /// Requested paths that are not in the index.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum MetaSelector {
    Paths(Vec<String>),
    All,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedLink {
    pub target: String,
    pub count: i64,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    /// Files carrying the tag (directly or through a nested descendant).
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyCount {
    pub key: String,
    /// Files defining the property.
    pub count: i64,
    /// Occurrences per value type (`text`, `number`, `date`, ...).
    pub types: BTreeMap<String, i64>,
}

/// How many notes hold a list value of one property that is empty, or made only of wikilinks.
/// Read from `prop_items` without any schema change; `property_types::refine_list_shapes` uses it
/// so an empty list is neutral and a list of links infers as relationships.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListShape {
    pub key: String,
    pub empty: i64,
    pub links_only: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskFilter {
    pub path: Option<String>,
    pub folder: Option<String>,
    /// Exact status character (`" "`, `x`, `/`...).
    pub status: Option<String>,
    /// `true`: status `x`/`X`; `false`: anything else.
    pub done: Option<bool>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEntry {
    pub path: String,
    pub line: i64,
    pub status: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasEntry {
    pub path: String,
    pub alias: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub path: String,
    /// Files directly inside.
    pub files: i64,
    /// Files in the folder and all subfolders.
    pub total_files: i64,
    /// Bytes in the folder and all subfolders.
    pub size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub name: String,
    pub path: String,
    pub files: i64,
    pub markdown_files: i64,
    pub folders: i64,
    pub size: i64,
}

fn in_placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn link_entry(r: &rusqlite::Row, o: usize) -> rusqlite::Result<LinkEntry> {
    Ok(LinkEntry {
        raw: r.get(o)?,
        target: r.get(o + 1)?,
        kind: r.get(o + 2)?,
        in_fm: r.get::<_, i64>(o + 3)? != 0,
        display: r.get(o + 4)?,
        subpath: r.get(o + 5)?,
    })
}

fn require_file_id(conn: &Connection, path: &str) -> Res<i64> {
    conn.query_row("SELECT id FROM files WHERE path = ?1", [path], |r| r.get(0))
        .optional()?
        .ok_or_else(|| IndexError::Invalid(format!("not in the index: {path}")))
}

impl Index {
    pub fn get_file(&self, path: &str) -> Res<Option<FileRow>> {
        self.read(|c| {
            Ok(c.query_row(
                &format!("SELECT {FILE_COLS} FROM files f WHERE f.path = ?1"),
                [path],
                file_row,
            )
            .optional()?)
        })
    }

    pub fn query_files(&self, filter: &FileFilter) -> Res<FilePage> {
        let (wh, args) = where_clause(filter)?;
        self.read(|c| {
            let total: i64 = c.query_row(
                &format!("SELECT COUNT(*) FROM files f{wh}"),
                params_from_iter(args.iter()),
                |r| r.get(0),
            )?;
            let col = match filter.order {
                FileOrder::Path => "f.path",
                FileOrder::Name => "f.name COLLATE NOCASE",
                FileOrder::Mtime => "f.mtime",
                FileOrder::Ctime => "f.ctime",
                FileOrder::Size => "f.size",
            };
            let dir = if filter.descending { "DESC" } else { "ASC" };
            let mut sql =
                format!("SELECT {FILE_COLS} FROM files f{wh} ORDER BY {col} {dir}, f.path ASC");
            if filter.limit.is_some() || filter.offset.is_some() {
                sql.push_str(&format!(
                    " LIMIT {} OFFSET {}",
                    filter.limit.map_or(-1, i64::from),
                    filter.offset.unwrap_or(0)
                ));
            }
            let mut st = c.prepare(&sql)?;
            let rows = st
                .query_map(params_from_iter(args.iter()), file_row)?
                .collect::<Result<_, _>>()?;
            Ok(FilePage { total, rows })
        })
    }

    pub fn get_metadata(&self, selector: &MetaSelector) -> Res<MetadataResult> {
        self.read(|c| {
            let mut missing = Vec::new();
            // (id, path, fm_json, fm_error)
            let mut files: Vec<(i64, String, Option<String>, Option<String>)> = Vec::new();
            match selector {
                MetaSelector::All => {
                    let mut st = c.prepare("SELECT id, path, fm_json, fm_error FROM files WHERE ext = 'md' ORDER BY path")?;
                    for r in st.query_map([], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })? {
                        files.push(r?);
                    }
                }
                MetaSelector::Paths(paths) => {
                    for p in paths {
                        let row = c
                            .query_row(
                                "SELECT id, path, fm_json, fm_error FROM files WHERE path = ?1",
                                [p],
                                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                            )
                            .optional()?;
                        match row {
                            Some(r) => files.push(r),
                            None => missing.push(p.clone()),
                        }
                    }
                }
            }
            let mut notes: HashMap<i64, NoteMetadata> = HashMap::new();
            let mut order = Vec::with_capacity(files.len());
            for (id, path, fm, err) in files {
                let frontmatter = match fm {
                    Some(s) => Some(serde_json::from_str(&s).map_err(|e| {
                        IndexError::Internal(format!("corrupt fm_json for {path}: {e}"))
                    })?),
                    None => None,
                };
                order.push(id);
                notes.insert(
                    id,
                    NoteMetadata {
                        path,
                        frontmatter,
                        fm_error: err,
                        tags: Vec::new(),
                        links: Vec::new(),
                        headings: Vec::new(),
                    },
                );
            }
            let all = matches!(selector, MetaSelector::All);
            for chunk in order.chunks(500) {
                let (filter, args): (String, Vec<SqlValue>) = if all {
                    (String::new(), Vec::new())
                } else {
                    (
                        format!("WHERE {{col}} IN ({})", in_placeholders(chunk.len())),
                        chunk.iter().map(|i| SqlValue::Integer(*i)).collect(),
                    )
                };
                let q = |sql: &str, col: &str| sql.replace("{where}", &filter.replace("{col}", col));
                let mut st = c.prepare(&q("SELECT file_id, tag, source FROM tags {where} ORDER BY file_id, tag, source", "file_id"))?;
                let mut rows = st.query(params_from_iter(args.iter()))?;
                while let Some(r) = rows.next()? {
                    if let Some(n) = notes.get_mut(&r.get::<_, i64>(0)?) {
                        n.tags.push(TagEntry { tag: r.get(1)?, source: r.get(2)? });
                    }
                }
                let mut st = c.prepare(&q("SELECT src_id, raw, target_path, kind, in_fm, display, subpath FROM links {where} ORDER BY src_id, rowid", "src_id"))?;
                let mut rows = st.query(params_from_iter(args.iter()))?;
                while let Some(r) = rows.next()? {
                    if let Some(n) = notes.get_mut(&r.get::<_, i64>(0)?) {
                        n.links.push(link_entry(r, 1)?);
                    }
                }
                let mut st = c.prepare(&q("SELECT file_id, level, text, line FROM headings {where} ORDER BY file_id, line", "file_id"))?;
                let mut rows = st.query(params_from_iter(args.iter()))?;
                while let Some(r) = rows.next()? {
                    if let Some(n) = notes.get_mut(&r.get::<_, i64>(0)?) {
                        n.headings.push(HeadingEntry { level: r.get(1)?, text: r.get(2)?, line: r.get(3)? });
                    }
                }
            }
            let notes = order.iter().filter_map(|id| notes.remove(id)).collect();
            Ok(MetadataResult { notes, missing })
        })
    }

    /// Files linking to `path` (self-links excluded), with the link details.
    pub fn backlinks(&self, path: &str) -> Res<Vec<BacklinkEntry>> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT f.path, l.raw, l.target_path, l.kind, l.in_fm, l.display, l.subpath \
                 FROM links l JOIN files f ON f.id = l.src_id \
                 WHERE l.target_path = ?1 AND f.path != ?1 ORDER BY f.path, l.rowid",
            )?;
            let rows = st
                .query_map([path], |r| {
                    Ok(BacklinkEntry {
                        source: r.get(0)?,
                        link: link_entry(r, 1)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Outgoing links of `path`, in document order (frontmatter first).
    pub fn links(&self, path: &str) -> Res<Vec<LinkEntry>> {
        self.read(|c| {
            let id = require_file_id(c, path)?;
            let mut st = c.prepare(
                "SELECT raw, target_path, kind, in_fm, display, subpath FROM links WHERE src_id = ?1 ORDER BY rowid",
            )?;
            let rows = st
                .query_map([id], |r| link_entry(r, 0))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Link targets that match no file, grouped case-insensitively.
    pub fn unresolved(&self) -> Res<Vec<UnresolvedLink>> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT l.raw, f.path FROM links l JOIN files f ON f.id = l.src_id \
                 WHERE l.target_path IS NULL ORDER BY l.raw COLLATE NOCASE, f.path",
            )?;
            let mut out: Vec<UnresolvedLink> = Vec::new();
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let raw: String = r.get(0)?;
                let src: String = r.get(1)?;
                match out.last_mut() {
                    Some(last) if last.target.eq_ignore_ascii_case(&raw) || last.target == raw => {
                        last.count += 1;
                        if !last.sources.contains(&src) {
                            last.sources.push(src);
                        }
                    }
                    _ => out.push(UnresolvedLink {
                        target: raw,
                        count: 1,
                        sources: vec![src],
                    }),
                }
            }
            Ok(out)
        })
    }

    /// Markdown files no other file links to.
    pub fn orphans(&self) -> Res<Vec<String>> {
        self.paths_where(
            "f.ext = 'md' AND NOT EXISTS (SELECT 1 FROM links l WHERE l.target_path = f.path AND l.src_id != f.id)",
        )
    }

    /// Markdown files with no outgoing links to other files (unresolved links
    /// count as outgoing links; self-links do not).
    pub fn deadends(&self) -> Res<Vec<String>> {
        self.paths_where(
            "f.ext = 'md' AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src_id = f.id AND (l.target_path IS NULL OR l.target_path != f.path))",
        )
    }

    fn paths_where(&self, cond: &str) -> Res<Vec<String>> {
        self.read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT f.path FROM files f WHERE {cond} ORDER BY f.path"
            ))?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn tags(&self) -> Res<Vec<TagCount>> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT tag, COUNT(DISTINCT file_id) FROM tags GROUP BY tag ORDER BY tag",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(TagCount {
                        tag: r.get(0)?,
                        count: r.get(1)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Files carrying `tag` (nested descendants included), sorted by path.
    pub fn tag_files(&self, tag: &str) -> Res<Vec<String>> {
        let tag = super::markdown::normalize_tag(tag)
            .ok_or_else(|| IndexError::Invalid(format!("invalid tag: {tag}")))?;
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT DISTINCT f.path FROM tags t JOIN files f ON f.id = t.file_id WHERE t.tag = ?1 ORDER BY f.path",
            )?;
            let rows = st.query_map([tag], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn properties(&self) -> Res<Vec<PropertyCount>> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT key, vtype, COUNT(*) FROM props GROUP BY key, vtype ORDER BY key COLLATE NOCASE, key, vtype",
            )?;
            let mut out: Vec<PropertyCount> = Vec::new();
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let key: String = r.get(0)?;
                let vtype: String = r.get(1)?;
                let n: i64 = r.get(2)?;
                match out.last_mut() {
                    Some(last) if last.key == key => {
                        last.count += n;
                        last.types.insert(vtype, n);
                    }
                    _ => out.push(PropertyCount { key, count: n, types: BTreeMap::from([(vtype, n)]) }),
                }
            }
            Ok(out)
        })
    }

    /// Every distinct scalar value of one property (any note, list items included) with the
    /// number of notes holding it, for seeding an enum type. The name matches case-insensitively,
    /// like the type record; empty and nested values are skipped.
    pub fn property_values(&self, key: &str) -> Res<Vec<(String, i64)>> {
        const SCALAR: &str = "('text','link','number','bool','date','datetime')";
        self.read(|c| {
            let mut st = c.prepare(&format!(
                "SELECT v, COUNT(DISTINCT file_id) FROM ( \
                   SELECT file_id, v_text AS v FROM props WHERE key = ?1 COLLATE NOCASE AND vtype IN {SCALAR} \
                   UNION ALL \
                   SELECT file_id, v_text FROM prop_items WHERE key = ?1 COLLATE NOCASE AND vtype IN {SCALAR}) \
                 WHERE v IS NOT NULL AND TRIM(v) != '' GROUP BY v ORDER BY v"
            ))?;
            let rows = st
                .query_map([key], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Per property name: the list values that are empty and those made only of wikilinks.
    pub fn list_shapes(&self) -> Res<Vec<ListShape>> {
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT key, SUM(total = 0), SUM(total > 0 AND non_link = 0) FROM ( \
                   SELECT p.key AS key, \
                     (SELECT COUNT(*) FROM prop_items i WHERE i.file_id = p.file_id AND i.key = p.key) AS total, \
                     (SELECT COUNT(*) FROM prop_items i WHERE i.file_id = p.file_id AND i.key = p.key AND i.vtype != 'link') AS non_link \
                   FROM props p WHERE p.vtype = 'list') \
                 GROUP BY key ORDER BY key",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(ListShape { key: r.get(0)?, empty: r.get(1)?, links_only: r.get(2)? })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn tasks(&self, filter: &TaskFilter) -> Res<Vec<TaskEntry>> {
        self.read(|c| {
            let mut conds: Vec<String> = Vec::new();
            let mut args: Vec<SqlValue> = Vec::new();
            if let Some(p) = &filter.path {
                conds.push("f.path = ?".into());
                args.push(p.clone().into());
            }
            if let Some(folder) = &filter.folder {
                let folder = trim_folder(folder);
                if !folder.is_empty() {
                    conds.push("f.path >= ? AND f.path < ?".into());
                    args.push(format!("{folder}/").into());
                    args.push(format!("{folder}0").into());
                }
            }
            if let Some(s) = &filter.status {
                conds.push("t.status = ?".into());
                args.push(s.clone().into());
            }
            match filter.done {
                Some(true) => conds.push("t.status IN ('x','X')".into()),
                Some(false) => conds.push("t.status NOT IN ('x','X')".into()),
                None => {}
            }
            let wh = if conds.is_empty() { String::new() } else { format!(" WHERE {}", conds.join(" AND ")) };
            let limit = filter.limit.map_or(String::new(), |l| format!(" LIMIT {l}"));
            let mut st = c.prepare(&format!(
                "SELECT f.path, t.line, t.status, t.text FROM tasks t JOIN files f ON f.id = t.file_id{wh} ORDER BY f.path, t.line{limit}"
            ))?;
            let rows = st
                .query_map(params_from_iter(args.iter()), |r| {
                    Ok(TaskEntry { path: r.get(0)?, line: r.get(1)?, status: r.get(2)?, text: r.get(3)? })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Aliases from the `aliases`/`alias` property (list items, or a
    /// comma-separated string).
    pub fn aliases(&self) -> Res<Vec<AliasEntry>> {
        self.read(|c| {
            let mut out = Vec::new();
            let mut st = c.prepare(
                "SELECT f.path, i.v_text FROM prop_items i JOIN files f ON f.id = i.file_id \
                 WHERE i.key IN ('aliases','alias') AND i.v_text IS NOT NULL AND i.vtype != 'null' \
                 UNION ALL \
                 SELECT f.path, p.v_text FROM props p JOIN files f ON f.id = p.file_id \
                 WHERE p.key IN ('aliases','alias') AND p.vtype = 'text' \
                 ORDER BY 1, 2",
            )?;
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let path: String = r.get(0)?;
                let text: String = r.get(1)?;
                out.push((path, text));
            }
            Ok(out
                .into_iter()
                .flat_map(|(path, text)| {
                    text.split(',')
                        .map(str::trim)
                        .filter(|a| !a.is_empty())
                        .map(|a| AliasEntry {
                            path: path.clone(),
                            alias: a.to_string(),
                        })
                        .collect::<Vec<_>>()
                })
                .collect())
        })
    }

    /// Folders derived from indexed files (folders without files are not
    /// known to the index), optionally under `prefix`, sorted by path.
    pub fn list_folders(&self, prefix: Option<&str>) -> Res<Vec<FolderEntry>> {
        let prefix = prefix.map(trim_folder).filter(|p| !p.is_empty());
        self.read(|c| {
            let mut st = c.prepare(
                "SELECT folder, COUNT(*), COALESCE(SUM(size),0) FROM files GROUP BY folder",
            )?;
            let mut map: BTreeMap<String, FolderEntry> = BTreeMap::new();
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let folder: String = r.get(0)?;
                let (n, size): (i64, i64) = (r.get(1)?, r.get(2)?);
                if folder.is_empty() {
                    continue;
                }
                let mut acc = String::new();
                for (i, seg) in folder.split('/').enumerate() {
                    if i > 0 {
                        acc.push('/');
                    }
                    acc.push_str(seg);
                    let e = map.entry(acc.clone()).or_insert_with(|| FolderEntry {
                        path: acc.clone(),
                        files: 0,
                        total_files: 0,
                        size: 0,
                    });
                    e.total_files += n;
                    e.size += size;
                    if acc == folder {
                        e.files += n;
                    }
                }
            }
            Ok(map
                .into_values()
                .filter(|e| match prefix {
                    None => true,
                    Some(p) => e.path == p || e.path.starts_with(&format!("{p}/")),
                })
                .collect())
        })
    }

    pub fn vault_summary(&self) -> Res<VaultSummary> {
        let folders = self.list_folders(None)?.len() as i64;
        let root = self.root();
        self.read(|c| {
            let (files, md, size): (i64, i64, i64) = c.query_row(
                "SELECT COUNT(*), COALESCE(SUM(ext='md'),0), COALESCE(SUM(size),0) FROM files",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            Ok(VaultSummary {
                name: root
                    .file_name()
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
                path: root.to_string_lossy().into_owned(),
                files,
                markdown_files: md,
                folders,
                size,
            })
        })
    }

    /// Resolve link text as written in `from` (a vault-relative path) with the
    /// index's Obsidian-style rules. Backs the CLI's `file=` parameter (pass
    /// `from = ""` for vault-level resolution).
    pub fn resolve_link(&self, from: &str, text: &str) -> Res<Option<String>> {
        if text.trim().is_empty() {
            return Ok(None);
        }
        let idx = self.cached_paths()?;
        Ok(idx.resolve(from, text, super::markdown::LinkKind::Wikilink))
    }
}
