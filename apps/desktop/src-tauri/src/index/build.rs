//! Scanning (cold build, warm diff), incremental path updates and the batched
//! writer. Everything here runs on the single writer thread; parsing runs on
//! the walker threads.

use super::edges;
use super::fts::FtsDoc;
use super::kinds::{self, TextSource};
use super::note::{content_hash, parse_note, LinkRow, ParsedNote};
use super::paths::{is_indexable_rel, rel_to_string};
use super::resolve::PathIndex;
use super::{IndexError, Shared};
use ignore::{WalkBuilder, WalkState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

pub const BATCH_SIZE: usize = 200;
/// Above this many changed paths a change notification collapses to `full`.
pub const MAX_NOTIFIED_PATHS: usize = 2000;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub seen: usize,
    pub added: usize,
    pub changed: usize,
    /// mtime changed but content hash did not: no reparse.
    pub touched: usize,
    pub unchanged: usize,
    pub deleted: usize,
    /// Markdown files actually parsed during this scan.
    pub reparsed: usize,
    /// Notes whose body exceeded the full-text cap and was left out of it.
    pub fts_body_skipped: usize,
    pub errors: Vec<String>,
    pub duration_ms: u64,
}

pub(crate) struct ExistingRow {
    mtime: i64,
    size: i64,
    hash: Option<i64>,
    /// The kind the row was indexed as: a policy change that gives the file another kind (or none)
    /// re-indexes it even though its stat did not move.
    kind: String,
    /// The file's text was indexed: a content gate that opens or closes re-indexes it too.
    text_indexed: bool,
}

/// A non-note file with a text extractor (a PDF, a code file): its text columns, and the hash of
/// its bytes when they were read. An extraction that failed is the same with no body: the file
/// stays listed and found by name.
struct DocContent {
    hash: Option<i64>,
    title: Option<String>,
    fts: FtsDoc,
    /// The links the extractor reported (`Extracted::links`), as the note scanner reads them.
    links: Vec<LinkRow>,
}

/// The links an extractor reported as rows, parsed by the body scanner like any `[[link]]`.
fn extracted_links(texts: &[String]) -> Vec<LinkRow> {
    if texts.is_empty() {
        return Vec::new();
    }
    super::markdown::scan_body(&texts.join("\n"), 1)
        .links
        .into_iter()
        .map(|l| LinkRow {
            link: l.link,
            in_fm: false,
            label: None,
            line: None,
            section: None,
        })
        .collect()
}

enum Content {
    Parsed(Box<ParsedNote>, i64),
    Doc(Box<DocContent>),
    /// Row metadata only (non-markdown file, or markdown whose hash is unchanged).
    MetaOnly(Option<i64>),
    ReadError(String),
}

pub(crate) struct FileRecord {
    path: String,
    name: String,
    basename: String,
    ext: String,
    folder: String,
    size: i64,
    ctime: i64,
    mtime: i64,
    existed: bool,
    /// The id of the kind the file is indexed as, `""` when it is not listed (`index::kinds`).
    kind: &'static str,
    /// The file has an FTS row: its kind has text and its content gate is open.
    has_fts: bool,
    content: Content,
}

enum Outcome {
    Unchanged,
    Record(Box<FileRecord>),
}

enum Item {
    Unchanged(String),
    Record(Box<FileRecord>),
    Error(String),
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    let d = t.ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(d.as_millis() as i64)
}

fn split_rel(rel: &str) -> (String, String, String, String) {
    let (folder, name) = match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    };
    let (basename, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], name[i + 1..].to_lowercase()),
        _ => (name, String::new()),
    };
    (
        folder.to_string(),
        name.to_string(),
        basename.to_string(),
        ext,
    )
}

/// The text columns of an extracted body: capped, spaced for CJK, and kept whole for the lines
/// under a hit when the kind shows them from the index.
fn extracted_fts(kind: &kinds::FileKind, body: String) -> FtsDoc {
    let body = super::extract::cap_body(body);
    FtsDoc {
        body: super::fts::space_cjk(&body),
        stored: (kind.text == TextSource::Stored).then_some(body),
        ..FtsDoc::default()
    }
}

/// Read and extract a non-note file of a kind with an extractor.
fn doc_content(
    kind: &kinds::FileKind,
    extract: &kinds::Extract,
    abs: &Path,
    name: &str,
    size: i64,
) -> Content {
    let doc = match super::extract::run(kind, extract, abs, name, size.max(0) as u64) {
        Ok((out, bytes)) => DocContent {
            hash: Some(content_hash(&bytes)),
            title: out.title,
            fts: extracted_fts(kind, out.body),
            links: extracted_links(&out.links),
        },
        // named only: an FTS row with the file name and no body
        Err(_) => DocContent {
            hash: None,
            title: None,
            fts: FtsDoc::default(),
            links: Vec::new(),
        },
    };
    Content::Doc(Box::new(doc))
}

/// Stat (and for changed markdown, read and parse; for a kind with an extractor, read and
/// extract) one file. `trust_mtime`: skip reading markdown whose mtime and size match the stored
/// row. The watcher path passes `false` because a same-size edit inside one mtime tick must not
/// be missed. `policy` decides the file's kind (`index::kinds`).
fn process_file(
    abs: &Path,
    rel: &str,
    meta: &Metadata,
    existing: Option<&ExistingRow>,
    trust_mtime: bool,
    policy: &crate::code_files::Policy,
) -> Outcome {
    let size = meta.len() as i64;
    let mtime = ms(meta.modified()).unwrap_or(0);
    // Creation time is unavailable on some filesystems; mtime is the only
    // meaningful stand-in there.
    let ctime = ms(meta.created()).unwrap_or(mtime);
    let (folder, name, basename, ext) = split_rel(rel);
    let kind = kinds::kind_of(policy, &name);
    let kind_id = kind.map_or("", |k| k.id);
    let has_text = kind.is_some_and(|k| kinds::indexes_text(policy, k));
    let extract = kind
        .filter(|_| has_text)
        .and_then(|k| k.extract.as_ref().map(|e| (k, e)));
    let same_stat = existing.is_some_and(|e| e.mtime == mtime && e.size == size);
    let same_kind = existing.is_some_and(|e| e.kind == kind_id && e.text_indexed == has_text);
    let is_md = ext == "md";

    let record = |content| {
        Outcome::Record(Box::new(FileRecord {
            path: rel.to_string(),
            name: name.clone(),
            basename: basename.clone(),
            ext: ext.clone(),
            folder: folder.clone(),
            size,
            ctime,
            mtime,
            existed: existing.is_some(),
            kind: kind_id,
            has_fts: has_text,
            content,
        }))
    };

    if !is_md {
        if same_stat && same_kind {
            return Outcome::Unchanged;
        }
        return record(match extract {
            Some((k, e)) => doc_content(k, e, abs, &name, size),
            None => Content::MetaOnly(None),
        });
    }
    if same_stat && same_kind && trust_mtime && existing.is_some_and(|e| e.hash.is_some()) {
        return Outcome::Unchanged;
    }
    let bytes = match std::fs::read(abs) {
        Ok(b) => b,
        Err(e) => return record(Content::ReadError(format!("read error: {e}"))),
    };
    let hash = content_hash(&bytes);
    if let Some(e) = existing {
        if e.hash == Some(hash) && same_kind {
            return if same_stat {
                Outcome::Unchanged
            } else {
                record(Content::MetaOnly(Some(hash)))
            };
        }
    }
    // Invalid UTF-8 is decoded lossily; Obsidian assumes UTF-8 as well.
    let text = String::from_utf8_lossy(&bytes);
    let mut note = parse_note(&text);
    // A markdown file of another kind with an extractor (a drawing note) is parsed as a note for
    // its properties and links; its searchable text is what the extractor reads.
    if let Some((k, e)) = extract.filter(|(k, _)| k.id != "note") {
        if let Ok(out) = super::extract::run_bytes(k, e, abs, &name, &bytes) {
            let text = extracted_fts(k, out.body);
            note.fts.body = text.body;
            note.fts.stored = text.stored;
            note.fts.body_skipped = false;
            // the links the file's own text already shows (a drawing note lists its element
            // links under `## Element Links`) are not counted twice
            let mut shown: Vec<bool> = vec![false; note.links.len()];
            for l in extracted_links(&out.links) {
                let at = note.links.iter().enumerate().position(|(i, x)| {
                    !shown[i] && !x.in_fm && x.link.raw == l.link.raw && x.link.kind == l.link.kind
                });
                match at {
                    Some(i) => shown[i] = true,
                    None => note.links.push(l),
                }
            }
        }
    }
    record(Content::Parsed(Box::new(note), hash))
}

/// The walker over the vault under one policy snapshot, so a scan sees a single policy even when a
/// setting changes meanwhile (and the walker threads need not ask for it).
pub(crate) fn walk_builder_with(root: &Path, policy: crate::code_files::Policy) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    let walk_root = root.to_path_buf();
    // Hidden entries are filtered by `code_files::rel_is_visible` (not the walker's own
    // dot-file rule) so `.agents/skills` and `.claude/skills` can be walked.
    b.hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .parents(false)
        .filter_entry(move |e| {
            e.path()
                .strip_prefix(&walk_root)
                .map(|rel| {
                    rel.as_os_str().is_empty()
                        || crate::code_files::rel_is_visible_with(&policy, rel)
                })
                .unwrap_or(true)
        });
    b
}

pub(crate) fn load_existing(
    conn: &Connection,
    range: Option<(String, String)>,
) -> Result<HashMap<String, ExistingRow>, IndexError> {
    let mut out = HashMap::new();
    let map = |r: &rusqlite::Row| {
        Ok((
            r.get::<_, String>(0)?,
            ExistingRow {
                mtime: r.get(1)?,
                size: r.get(2)?,
                hash: r.get(3)?,
                kind: r.get(4)?,
                text_indexed: r.get(5)?,
            },
        ))
    };
    match range {
        None => {
            let mut st =
                conn.prepare("SELECT path, mtime, size, body_hash, kind, text_indexed FROM files")?;
            for row in st.query_map([], map)? {
                let (p, e) = row?;
                out.insert(p, e);
            }
        }
        Some((lo, hi)) => {
            let mut st = conn.prepare(
                "SELECT path, mtime, size, body_hash, kind, text_indexed FROM files WHERE path >= ?1 AND path < ?2",
            )?;
            for row in st.query_map([lo, hi], map)? {
                let (p, e) = row?;
                out.insert(p, e);
            }
        }
    }
    Ok(out)
}

/// `[prefix + "/", prefix + "0")` covers exactly the paths under `prefix/`
/// under SQLite's byte-wise TEXT ordering ('0' follows '/').
fn prefix_range(prefix: &str) -> (String, String) {
    (format!("{prefix}/"), format!("{prefix}0"))
}

fn paths_in(conn: &Connection) -> Result<Vec<String>, IndexError> {
    let mut st = conn.prepare("SELECT path FROM files")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(crate) fn load_path_index(conn: &Connection) -> Result<PathIndex, IndexError> {
    Ok(PathIndex::from_paths(paths_in(conn)?))
}

fn delete_children(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    for sql in [
        "DELETE FROM props WHERE file_id = ?1",
        "DELETE FROM prop_items WHERE file_id = ?1",
        "DELETE FROM tags WHERE file_id = ?1",
        "DELETE FROM edges WHERE src_id = ?1",
        "DELETE FROM tasks WHERE file_id = ?1",
        "DELETE FROM list_items WHERE file_id = ?1",
        "DELETE FROM headings WHERE file_id = ?1",
        "DELETE FROM inline_fields WHERE file_id = ?1",
    ] {
        conn.prepare_cached(sql)?.execute([id])?;
    }
    Ok(())
}

/// Outcome of [`write_records`].
pub(crate) struct WriteReport {
    /// File ids written (a note that failed and was marked still has one).
    pub ids: Vec<i64>,
    /// `(vault-relative path, message)` for every record that could not be written. The
    /// rest of the batch is unaffected.
    pub failed: Vec<(String, String)>,
}

/// Upsert records inside the caller's transaction. When `resolver` is given,
/// new edges are resolved immediately; otherwise they are left unresolved for a
/// later [`edges::resolve_edges`] pass.
///
/// Each record runs in its own savepoint: one note whose rows the database rejects must never
/// roll back the batch. Its savepoint is undone, the note is logged once, and its `files` row
/// is stored with an `index error` in `fm_error`, no child rows and its content hash, so a
/// later scan or watcher event leaves it alone until its mtime, size or content changes.
pub(crate) fn write_records(
    conn: &Connection,
    records: &[Box<FileRecord>],
    resolver: Option<&PathIndex>,
) -> Result<WriteReport, IndexError> {
    let mut report = WriteReport {
        ids: Vec::with_capacity(records.len()),
        failed: Vec::new(),
    };
    // A path can reach one batch twice (a directory event plus a file event inside it): the second
    // write finds the row the first created, so it must replace its children, not insert them again
    // (`UNIQUE constraint failed: props.file_id, props.key` aborted the whole update).
    let mut written: HashSet<&str> = HashSet::with_capacity(records.len());
    for rec in records {
        let existed = rec.existed || !written.insert(rec.path.as_str());
        conn.execute_batch("SAVEPOINT index_record")?;
        let id = match write_record(conn, rec, existed, resolver) {
            Ok(id) => id,
            Err(e) => {
                conn.execute_batch("ROLLBACK TO index_record")?;
                let msg = e.to_string();
                log::warn!("vault index skipped a note: {}: {msg}", rec.path);
                report.failed.push((rec.path.clone(), msg.clone()));
                match mark_failed(conn, rec, &msg) {
                    Ok(id) => id,
                    Err(e2) => {
                        conn.execute_batch("ROLLBACK TO index_record")?;
                        conn.execute_batch("RELEASE index_record")?;
                        log::warn!("vault index could not mark a note: {}: {e2}", rec.path);
                        continue;
                    }
                }
            }
        };
        conn.execute_batch("RELEASE index_record")?;
        report.ids.push(id);
    }
    Ok(report)
}

fn write_record(
    conn: &Connection,
    rec: &FileRecord,
    existed: bool,
    resolver: Option<&PathIndex>,
) -> Result<i64, IndexError> {
    Ok(match &rec.content {
        Content::MetaOnly(hash) if existed => {
            let id: i64 = conn
                .prepare_cached(
                    "UPDATE files SET size=?2, ctime=?3, mtime=?4, body_hash=COALESCE(?5, body_hash), \
                     kind=?6, text_indexed=?7 WHERE path=?1 RETURNING id",
                )?
                .query_row(
                    params![rec.path, rec.size, rec.ctime, rec.mtime, hash, rec.kind, rec.has_fts],
                    |r| r.get(0),
                )?;
            if !rec.has_fts {
                // the file lost its kind (a feature or a setting went off): its text and the links
                // it carried as a drawing go with it
                super::fts::delete_doc(conn, id)?;
                conn.prepare_cached("DELETE FROM edges WHERE src_id = ?1")?
                    .execute([id])?;
            }
            id
        }
        Content::MetaOnly(_) => insert_file(conn, rec, None, None, None, None, None)?,
        Content::Doc(doc) => {
            let id = insert_file(conn, rec, None, None, doc.hash, None, None)?;
            let title_text = match doc
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                Some(t) => format!("{} {t}", rec.basename),
                None => rec.basename.clone(),
            };
            super::fts::write_doc(conn, id, &title_text, &doc.fts, existed)?;
            conn.prepare_cached("DELETE FROM edges WHERE src_id = ?1")?
                .execute([id])?;
            edges::write_edges(conn, id, &rec.path, &doc.links, resolver)?;
            id
        }
        Content::ReadError(msg) => {
            let id = insert_file(conn, rec, None, Some(msg), None, None, None)?;
            delete_children(conn, id)?;
            super::fts::delete_doc(conn, id)?;
            id
        }
        Content::Parsed(note, hash) => {
            let id = insert_file(
                conn,
                rec,
                note.fm_json.as_deref(),
                note.fm_error.as_deref(),
                Some(*hash),
                Some(note.words),
                Some(note.chars),
            )?;
            if existed {
                delete_children(conn, id)?;
            }
            write_children(conn, id, &rec.path, note, resolver)?;
            // The display-title override is indexed with the file name in the `title` column, so
            // it ranks like a name hit.
            let title_text = match note
                .props
                .iter()
                .find(|p| p.key == "title" && p.vtype == "text")
                .and_then(|p| p.v_text.as_deref())
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                Some(t) => format!("{} {t}", rec.basename),
                None => rec.basename.clone(),
            };
            super::fts::write_doc(conn, id, &title_text, &note.fts, existed)?;
            id
        }
    })
}

/// Store a note the index could not write as a bare row carrying the error.
fn mark_failed(conn: &Connection, rec: &FileRecord, msg: &str) -> Result<i64, IndexError> {
    let hash = match &rec.content {
        Content::Parsed(_, h) => Some(*h),
        Content::Doc(d) => d.hash,
        _ => None,
    };
    let id = insert_file(
        conn,
        rec,
        None,
        Some(&format!("index error: {msg}")),
        hash,
        None,
        None,
    )?;
    delete_children(conn, id)?;
    super::fts::delete_doc(conn, id)?;
    Ok(id)
}

fn insert_file(
    conn: &Connection,
    rec: &FileRecord,
    fm_json: Option<&str>,
    fm_error: Option<&str>,
    hash: Option<i64>,
    words: Option<u32>,
    chars: Option<u32>,
) -> Result<i64, IndexError> {
    Ok(conn
        .prepare_cached(
            "INSERT INTO files(path,name,basename,ext,folder,size,ctime,mtime,fm_json,fm_error,body_hash,words,chars,kind,text_indexed) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) \
             ON CONFLICT(path) DO UPDATE SET name=excluded.name, basename=excluded.basename, ext=excluded.ext, \
               folder=excluded.folder, size=excluded.size, ctime=excluded.ctime, mtime=excluded.mtime, \
               fm_json=excluded.fm_json, fm_error=excluded.fm_error, body_hash=excluded.body_hash, \
               words=excluded.words, chars=excluded.chars, kind=excluded.kind, \
               text_indexed=excluded.text_indexed \
             RETURNING id",
        )?
        .query_row(
            params![
                rec.path, rec.name, rec.basename, rec.ext, rec.folder, rec.size, rec.ctime,
                rec.mtime, fm_json, fm_error, hash, words, chars, rec.kind, rec.has_fts
            ],
            |r| r.get(0),
        )?)
}

fn write_children(
    conn: &Connection,
    id: i64,
    path: &str,
    note: &ParsedNote,
    resolver: Option<&PathIndex>,
) -> Result<(), IndexError> {
    let mut st = conn.prepare_cached(
        "INSERT INTO props(file_id,key,vtype,v_text,v_num,v_date) VALUES(?1,?2,?3,?4,?5,?6)",
    )?;
    for p in &note.props {
        st.execute(params![id, p.key, p.vtype, p.v_text, p.v_num, p.v_date])?;
    }
    let mut st = conn.prepare_cached(
        "INSERT INTO prop_items(file_id,key,idx,vtype,v_text,link_target) VALUES(?1,?2,?3,?4,?5,?6)",
    )?;
    for i in &note.items {
        st.execute(params![id, i.key, i.idx, i.vtype, i.v_text, i.link_target])?;
    }
    let mut st =
        conn.prepare_cached("INSERT OR IGNORE INTO tags(file_id,tag,source) VALUES(?1,?2,?3)")?;
    for t in &note.tags {
        st.execute(params![id, t.tag, t.source])?;
    }
    edges::write_edges(conn, id, path, &note.links, resolver)?;
    let mut st = conn.prepare_cached(
        "INSERT INTO list_items(file_id,line,parent_line,indent,marker,task_status,text,section_heading) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
    )?;
    for i in &note.list_items {
        st.execute(params![
            id,
            i.line,
            i.parent_line,
            i.indent,
            i.marker,
            i.task_status,
            i.text,
            i.section
        ])?;
    }
    let mut st = conn.prepare_cached(
        "INSERT INTO tasks(file_id,line,status_symbol,text,description,due,scheduled,start,created,done,\
         cancelled,priority,recurrence,on_completion,task_id,depends_on,tags,block_id,parent_line) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
    )?;
    for t in &note.tasks {
        let f = &t.fields;
        let day = |d: Option<crate::tasks::date::Day>| d.map(|d| d.to_string());
        let joined = |v: &[String]| Some(v.join(",")).filter(|s| !s.is_empty());
        st.execute(params![
            id,
            t.line,
            t.status,
            t.text,
            f.description,
            day(f.due),
            day(f.scheduled),
            day(f.start),
            day(f.created),
            day(f.done),
            day(f.cancelled),
            f.priority.map(|p| p.name()),
            f.recurrence,
            f.on_completion,
            f.id,
            joined(&f.depends_on),
            joined(&f.tags),
            f.block_id,
            t.parent_line
        ])?;
    }
    let mut st =
        conn.prepare_cached("INSERT INTO headings(file_id,level,text,line) VALUES(?1,?2,?3,?4)")?;
    for h in &note.headings {
        st.execute(params![id, h.level, h.text, h.line])?;
    }
    let mut st = conn.prepare_cached(
        "INSERT INTO inline_fields(file_id,line,key,canonical_key,raw,wrapping) VALUES(?1,?2,?3,?4,?5,?6)",
    )?;
    for f in &note.inline_fields {
        let canonical = super::inline_fields::canonical_key(&f.field.key);
        let wrapping = f.field.wrapping.map(String::from);
        st.execute(params![
            id,
            f.line,
            f.field.key,
            canonical,
            f.field.value,
            wrapping
        ])?;
    }
    Ok(())
}

pub(crate) struct ScanOutcome {
    pub stats: ScanStats,
    pub changed: Vec<String>,
    pub full: bool,
}

/// Cold build or warm diff of the whole vault.
pub(crate) fn scan(
    conn: &mut Connection,
    shared: &Arc<Shared>,
    paths: &mut PathIndex,
) -> Result<ScanOutcome, IndexError> {
    let started = Instant::now();
    let existing = Arc::new(load_existing(conn, None)?);
    let was_empty = existing.is_empty();
    shared
        .scanned
        .store(0, std::sync::atomic::Ordering::Relaxed);
    // A cold build loads every edge into an index-less table and builds the indexes once at the
    // end; any other scan makes sure a cold build that was cut short left none missing.
    conn.execute_batch(if was_empty {
        super::schema::DROP_EDGE_INDEXES
    } else {
        super::schema::EDGE_INDEXES
    })?;

    let (tx, rx) = sync_channel::<Item>(512);
    let root = shared.root.clone();
    let walker_shared = Arc::clone(shared);
    let walker_existing = Arc::clone(&existing);
    let policy = shared.policy();
    let walker = std::thread::spawn(move || {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(4);
        walk_builder_with(&root, policy.clone())
            .threads(threads)
            .build_parallel()
            .run(|| {
                let tx = tx.clone();
                let root = root.clone();
                let shared = Arc::clone(&walker_shared);
                let existing = Arc::clone(&walker_existing);
                let policy = policy.clone();
                Box::new(move |entry| {
                    if shared.cancelled() {
                        return WalkState::Quit;
                    }
                    let entry = match entry {
                        Ok(e) => e,
                        Err(e) => {
                            let _ = tx.send(Item::Error(format!("walk error: {e}")));
                            return WalkState::Continue;
                        }
                    };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        return WalkState::Continue;
                    }
                    let Ok(rel) = entry.path().strip_prefix(&root) else {
                        return WalkState::Continue;
                    };
                    if !crate::code_files::rel_is_visible_with(&policy, rel) {
                        return WalkState::Continue;
                    }
                    let Some(rel_str) = rel_to_string(rel) else {
                        let _ = tx.send(Item::Error(format!(
                            "skipped non-UTF-8 path {}",
                            rel.display()
                        )));
                        return WalkState::Continue;
                    };
                    let meta = match entry.metadata() {
                        Ok(m) => m,
                        Err(e) => {
                            let _ = tx.send(Item::Error(format!("stat {rel_str}: {e}")));
                            return WalkState::Continue;
                        }
                    };
                    let item = match process_file(
                        entry.path(),
                        &rel_str,
                        &meta,
                        existing.get(&rel_str),
                        true,
                        &policy,
                    ) {
                        Outcome::Unchanged => Item::Unchanged(rel_str),
                        Outcome::Record(r) => Item::Record(r),
                    };
                    if tx.send(item).is_err() {
                        return WalkState::Quit;
                    }
                    WalkState::Continue
                })
            });
    });

    let mut stats = ScanStats::default();
    let mut seen: HashSet<String> = HashSet::with_capacity(existing.len());
    let mut changed: Vec<String> = Vec::new();
    let mut batch: Vec<Box<FileRecord>> = Vec::with_capacity(BATCH_SIZE);
    let mut write_error: Option<IndexError> = None;

    let flush = |conn: &mut Connection,
                 batch: &mut Vec<Box<FileRecord>>|
     -> Result<WriteReport, IndexError> {
        let tx = conn.transaction()?;
        let report = write_records(&tx, batch, None)?;
        tx.commit()?;
        batch.clear();
        Ok(report)
    };
    // Files written and files that did not exist before: what the edge resolution below needs.
    let mut written_ids: Vec<i64> = Vec::new();
    let mut added: Vec<String> = Vec::new();

    for item in rx.iter() {
        if write_error.is_some() {
            continue; // drain so walker threads can finish
        }
        shared
            .scanned
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        match item {
            Item::Error(e) => stats.errors.push(e),
            Item::Unchanged(p) => {
                stats.seen += 1;
                stats.unchanged += 1;
                seen.insert(p);
            }
            #[allow(unused_mut)]
            Item::Record(mut rec) => {
                #[cfg(test)]
                if shared
                    .fts_disabled
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    if let Content::Parsed(note, _) = &mut rec.content {
                        note.fts.skip = true;
                    }
                }
                stats.seen += 1;
                seen.insert(rec.path.clone());
                match &rec.content {
                    Content::Parsed(note, _) => {
                        stats.reparsed += 1;
                        if note.fts.body_skipped {
                            stats.fts_body_skipped += 1;
                        }
                        if rec.existed {
                            stats.changed += 1
                        } else {
                            stats.added += 1
                        }
                    }
                    Content::MetaOnly(Some(_)) => stats.touched += 1,
                    Content::MetaOnly(None) | Content::Doc(_) => {
                        if rec.existed {
                            stats.changed += 1
                        } else {
                            stats.added += 1
                        }
                    }
                    Content::ReadError(e) => {
                        stats.errors.push(format!("{}: {e}", rec.path));
                        stats.changed += 1;
                    }
                }
                changed.push(rec.path.clone());
                if !rec.existed {
                    added.push(rec.path.clone());
                }
                batch.push(rec);
                if batch.len() >= BATCH_SIZE {
                    match flush(conn, &mut batch) {
                        Ok(report) => {
                            written_ids.extend(report.ids);
                            push_failures(&mut stats, report.failed);
                        }
                        Err(e) => write_error = Some(e),
                    }
                }
            }
        }
    }
    walker
        .join()
        .map_err(|_| IndexError::Internal("walker thread panicked".into()))?;
    if let Some(e) = write_error {
        return Err(e);
    }
    if shared.cancelled() {
        return Err(IndexError::Cancelled);
    }
    if !batch.is_empty() {
        let report = flush(conn, &mut batch)?;
        written_ids.extend(report.ids);
        push_failures(&mut stats, report.failed);
    }

    // Deletions: only valid because the walk completed.
    let gone: Vec<&String> = existing.keys().filter(|p| !seen.contains(*p)).collect();
    stats.deleted = gone.len();
    let tx = conn.transaction()?;
    super::fts::delete_files(&tx, &gone)?;
    tx.commit()?;
    let removed: Vec<String> = gone.into_iter().cloned().collect();
    changed.extend(removed.iter().cloned());

    *paths = load_path_index(conn)?;
    let tx = conn.transaction()?;
    if was_empty {
        edges::resolve_edges(&tx, paths, edges::Scope::All)?;
        tx.execute_batch(super::schema::EDGE_INDEXES)?;
    } else {
        // The edges of the notes just written were left unresolved; the others only move when a
        // file of their target name appeared or vanished.
        edges::resolve_after_changes(
            &tx,
            paths,
            &written_ids,
            added.iter().chain(&removed).map(String::as_str),
        )?;
    }
    super::schema::set_meta(&tx, "built_at", &now_ms().to_string())?;
    tx.commit()?;

    stats.duration_ms = started.elapsed().as_millis() as u64;
    let full = was_empty || changed.len() > MAX_NOTIFIED_PATHS;
    if full {
        changed.clear();
    }
    Ok(ScanOutcome {
        stats,
        changed,
        full,
    })
}

fn push_failures(stats: &mut ScanStats, failed: Vec<(String, String)>) {
    stats
        .errors
        .extend(failed.into_iter().map(|(p, e)| format!("{p}: {e}")));
}

pub(crate) fn now_ms() -> i64 {
    ms(Ok(std::time::SystemTime::now())).unwrap_or(0)
}

/// Re-index specific absolute paths (watcher feed, tests). Files are re-read
/// regardless of mtime; directories are re-synced recursively; vanished paths
/// are removed together with everything below them.
pub(crate) fn index_paths(
    conn: &mut Connection,
    shared: &Arc<Shared>,
    paths: &mut PathIndex,
    abs_paths: &[PathBuf],
) -> Result<Vec<String>, IndexError> {
    let mut records: Vec<Box<FileRecord>> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    let mut handled: HashSet<&PathBuf> = HashSet::new();
    let policy = shared.policy();

    for abs in abs_paths {
        if !handled.insert(abs) {
            continue;
        }
        let Ok(rel) = abs.strip_prefix(&shared.root) else {
            log::warn!("index: ignoring path outside the vault: {}", abs.display());
            continue;
        };
        if rel.as_os_str().is_empty() || !is_indexable_rel(rel) {
            continue;
        }
        let Some(rel_str) = rel_to_string(rel) else {
            log::warn!("index: skipping non-UTF-8 path {}", rel.display());
            continue;
        };
        match std::fs::symlink_metadata(abs) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let (lo, hi) = prefix_range(&rel_str);
                let mut st = conn.prepare(
                    "SELECT path FROM files WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
                )?;
                let rows = st.query_map(params![rel_str, lo, hi], |r| r.get::<_, String>(0))?;
                for r in rows {
                    removed.push(r?);
                }
            }
            Err(e) => return Err(e.into()),
            Ok(meta) if meta.is_file() => {
                let existing =
                    load_existing(conn, Some((rel_str.clone(), format!("{rel_str}\0"))))?;
                if let Outcome::Record(r) =
                    process_file(abs, &rel_str, &meta, existing.get(&rel_str), false, &policy)
                {
                    records.push(r);
                }
            }
            Ok(meta) if meta.is_dir() => {
                let existing = load_existing(conn, Some(prefix_range(&rel_str)))?;
                let mut seen = HashSet::new();
                for entry in walk_builder_with(abs, policy.clone()).build() {
                    let entry = match entry {
                        Ok(e) => e,
                        Err(e) => return Err(IndexError::Internal(format!("walk: {e}"))),
                    };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        continue;
                    }
                    let Ok(r) = entry.path().strip_prefix(&shared.root) else {
                        continue;
                    };
                    let (true, Some(p)) = (is_indexable_rel(r), rel_to_string(r)) else {
                        continue;
                    };
                    let m = entry
                        .metadata()
                        .map_err(|e| IndexError::Internal(e.to_string()))?;
                    seen.insert(p.clone());
                    if let Outcome::Record(rec) =
                        process_file(entry.path(), &p, &m, existing.get(&p), false, &policy)
                    {
                        records.push(rec);
                    }
                }
                for p in existing.keys() {
                    if !seen.contains(p) {
                        removed.push(p.clone());
                    }
                }
            }
            Ok(_) => {} // symlinks and special files are not indexed
        }
    }

    // A directory event plus an event for a file inside it read the same file twice: keep the
    // last read per path.
    let last: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .map(|(i, r)| (r.path.clone(), i))
        .collect();
    let mut i = 0;
    records.retain(|r| {
        i += 1;
        last[r.path.as_str()] == i - 1
    });

    let set_changed = !removed.is_empty() || records.iter().any(|r| !r.existed);
    for p in &removed {
        paths.remove(p);
    }
    for r in records.iter().filter(|r| !r.existed) {
        paths.insert(r.path.clone());
    }
    let tx = conn.transaction()?;
    super::fts::delete_files(&tx, &removed)?;
    // Per-note failures are isolated, logged and marked inside `write_records`.
    write_records(&tx, &records, Some(paths))?;
    if set_changed {
        // Edges of the notes written above were resolved against the new file set already.
        edges::resolve_after_changes(
            &tx,
            paths,
            &[],
            removed.iter().map(String::as_str).chain(
                records
                    .iter()
                    .filter(|r| !r.existed)
                    .map(|r| r.path.as_str()),
            ),
        )?;
    }
    tx.commit()?;

    let mut changed: Vec<String> = records.iter().map(|r| r.path.clone()).collect();
    changed.extend(removed);
    Ok(changed)
}

pub(crate) fn count_files(conn: &Connection) -> Result<(i64, i64), IndexError> {
    Ok(conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(ext = 'md'), 0) FROM files",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, 0)))
}
