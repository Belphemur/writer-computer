//! Scanning (cold build, warm diff), incremental path updates and the batched
//! writer. Everything here runs on the single writer thread; parsing runs on
//! the walker threads.

use super::note::{content_hash, parse_note, ParsedNote};
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
}

enum Content {
    Parsed(Box<ParsedNote>, i64),
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

/// Stat (and for changed markdown, read and parse) one file. `trust_mtime`:
/// skip reading markdown whose mtime and size match the stored row. The
/// watcher path passes `false` because a same-size edit inside one mtime tick
/// must not be missed.
fn process_file(
    abs: &Path,
    rel: &str,
    meta: &Metadata,
    existing: Option<&ExistingRow>,
    trust_mtime: bool,
) -> Outcome {
    let size = meta.len() as i64;
    let mtime = ms(meta.modified()).unwrap_or(0);
    // Creation time is unavailable on some filesystems; mtime is the only
    // meaningful stand-in there.
    let ctime = ms(meta.created()).unwrap_or(mtime);
    let (folder, name, basename, ext) = split_rel(rel);
    let same_stat = existing.is_some_and(|e| e.mtime == mtime && e.size == size);
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
            content,
        }))
    };

    if !is_md {
        return if same_stat {
            Outcome::Unchanged
        } else {
            record(Content::MetaOnly(None))
        };
    }
    if same_stat && trust_mtime && existing.is_some_and(|e| e.hash.is_some()) {
        return Outcome::Unchanged;
    }
    let bytes = match std::fs::read(abs) {
        Ok(b) => b,
        Err(e) => return record(Content::ReadError(format!("read error: {e}"))),
    };
    let hash = content_hash(&bytes);
    if let Some(e) = existing {
        if e.hash == Some(hash) {
            return if same_stat {
                Outcome::Unchanged
            } else {
                record(Content::MetaOnly(Some(hash)))
            };
        }
    }
    // Invalid UTF-8 is decoded lossily; Obsidian assumes UTF-8 as well.
    let text = String::from_utf8_lossy(&bytes);
    record(Content::Parsed(Box::new(parse_note(&text)), hash))
}

pub(crate) fn walk_builder(root: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .parents(false)
        .filter_entry(|e| e.file_name() != "node_modules");
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
            },
        ))
    };
    match range {
        None => {
            let mut st = conn.prepare("SELECT path, mtime, size, body_hash FROM files")?;
            for row in st.query_map([], map)? {
                let (p, e) = row?;
                out.insert(p, e);
            }
        }
        Some((lo, hi)) => {
            let mut st = conn.prepare(
                "SELECT path, mtime, size, body_hash FROM files WHERE path >= ?1 AND path < ?2",
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
        "DELETE FROM links WHERE src_id = ?1",
        "DELETE FROM tasks WHERE file_id = ?1",
        "DELETE FROM headings WHERE file_id = ?1",
    ] {
        conn.prepare_cached(sql)?.execute([id])?;
    }
    Ok(())
}

/// Upsert records inside the caller's transaction. When `resolver` is given,
/// new links are resolved immediately; otherwise they are left NULL for a
/// later [`resolve_links`] pass. Returns the file ids written.
pub(crate) fn write_records(
    conn: &Connection,
    records: &[Box<FileRecord>],
    resolver: Option<&PathIndex>,
) -> Result<Vec<i64>, IndexError> {
    let mut ids = Vec::with_capacity(records.len());
    for rec in records {
        let id: i64 = match &rec.content {
            Content::MetaOnly(hash) if rec.existed => {
                conn.prepare_cached(
                    "UPDATE files SET size=?2, ctime=?3, mtime=?4, body_hash=COALESCE(?5, body_hash) \
                     WHERE path=?1 RETURNING id",
                )?
                .query_row(
                    params![rec.path, rec.size, rec.ctime, rec.mtime, hash],
                    |r| r.get(0),
                )?
            }
            Content::MetaOnly(_) => insert_file(conn, rec, None, None, None, None, None)?,
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
                if rec.existed {
                    delete_children(conn, id)?;
                }
                write_children(conn, id, &rec.path, note, resolver)?;
                super::fts::write_doc(conn, id, &rec.basename, &note.fts, rec.existed)?;
                id
            }
        };
        ids.push(id);
    }
    Ok(ids)
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
            "INSERT INTO files(path,name,basename,ext,folder,size,ctime,mtime,fm_json,fm_error,body_hash,words,chars) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) \
             ON CONFLICT(path) DO UPDATE SET name=excluded.name, basename=excluded.basename, ext=excluded.ext, \
               folder=excluded.folder, size=excluded.size, ctime=excluded.ctime, mtime=excluded.mtime, \
               fm_json=excluded.fm_json, fm_error=excluded.fm_error, body_hash=excluded.body_hash, \
               words=excluded.words, chars=excluded.chars \
             RETURNING id",
        )?
        .query_row(
            params![
                rec.path, rec.name, rec.basename, rec.ext, rec.folder, rec.size, rec.ctime,
                rec.mtime, fm_json, fm_error, hash, words, chars
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
    let mut st = conn.prepare_cached(
        "INSERT INTO links(src_id,raw,target_path,kind,in_fm,display,subpath) VALUES(?1,?2,?3,?4,?5,?6,?7)",
    )?;
    for l in &note.links {
        let target = resolver.and_then(|r| r.resolve(path, &l.link.raw, l.link.kind));
        st.execute(params![
            id,
            l.link.raw,
            target,
            l.link.kind.as_str(),
            l.in_fm,
            l.link.display,
            l.link.subpath
        ])?;
    }
    let mut st =
        conn.prepare_cached("INSERT INTO tasks(file_id,line,status,text) VALUES(?1,?2,?3,?4)")?;
    for t in &note.tasks {
        st.execute(params![id, t.line, t.status, t.text])?;
    }
    let mut st =
        conn.prepare_cached("INSERT INTO headings(file_id,level,text,line) VALUES(?1,?2,?3,?4)")?;
    for h in &note.headings {
        st.execute(params![id, h.level, h.text, h.line])?;
    }
    Ok(())
}

/// Recompute `links.target_path`, optionally only for links sourced from
/// `only_src`. Writes only rows whose target changed. Returns rows updated.
pub(crate) fn resolve_links(
    conn: &Connection,
    paths: &PathIndex,
    only_src: Option<&[i64]>,
) -> Result<usize, IndexError> {
    use super::markdown::LinkKind;
    let kind_of = |k: &str| match k {
        "embed" => LinkKind::Embed,
        "markdown" => LinkKind::Markdown,
        "markdown_embed" => LinkKind::MarkdownEmbed,
        _ => LinkKind::Wikilink,
    };
    let mut updates: Vec<(i64, Option<String>)> = Vec::new();
    let mut collect = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> Result<(), IndexError> {
        let mut st = conn.prepare_cached(sql)?;
        let mut rows = st.query(args)?;
        while let Some(r) = rows.next()? {
            let rowid: i64 = r.get(0)?;
            let src: String = r.get(1)?;
            let raw: String = r.get(2)?;
            let kind: String = r.get(3)?;
            let old: Option<String> = r.get(4)?;
            let new = paths.resolve(&src, &raw, kind_of(&kind));
            if new != old {
                updates.push((rowid, new));
            }
        }
        Ok(())
    };
    const BASE: &str = "SELECT l.rowid, f.path, l.raw, l.kind, l.target_path FROM links l JOIN files f ON f.id = l.src_id";
    match only_src {
        None => collect(BASE, &[])?,
        Some(ids) => {
            for id in ids {
                collect(&format!("{BASE} WHERE l.src_id = ?1"), &[id])?;
            }
        }
    }
    let mut st = conn.prepare_cached("UPDATE links SET target_path = ?2 WHERE rowid = ?1")?;
    for (rowid, target) in &updates {
        st.execute(params![rowid, target])?;
    }
    Ok(updates.len())
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

    let (tx, rx) = sync_channel::<Item>(512);
    let root = shared.root.clone();
    let walker_shared = Arc::clone(shared);
    let walker_existing = Arc::clone(&existing);
    let walker = std::thread::spawn(move || {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(4);
        walk_builder(&root)
            .threads(threads)
            .build_parallel()
            .run(|| {
                let tx = tx.clone();
                let root = root.clone();
                let shared = Arc::clone(&walker_shared);
                let existing = Arc::clone(&walker_existing);
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
                    if !is_indexable_rel(rel) {
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

    let flush =
        |conn: &mut Connection, batch: &mut Vec<Box<FileRecord>>| -> Result<(), IndexError> {
            if batch.is_empty() {
                return Ok(());
            }
            let tx = conn.transaction()?;
            write_records(&tx, batch, None)?;
            tx.commit()?;
            batch.clear();
            Ok(())
        };

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
                    Content::MetaOnly(None) => {
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
                batch.push(rec);
                if batch.len() >= BATCH_SIZE {
                    if let Err(e) = flush(conn, &mut batch) {
                        write_error = Some(e);
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
    flush(conn, &mut batch)?;

    // Deletions: only valid because the walk completed.
    let gone: Vec<&String> = existing.keys().filter(|p| !seen.contains(*p)).collect();
    stats.deleted = gone.len();
    let tx = conn.transaction()?;
    super::fts::delete_files(&tx, &gone)?;
    tx.commit()?;
    changed.extend(gone.into_iter().cloned());

    *paths = load_path_index(conn)?;
    let tx = conn.transaction()?;
    resolve_links(&tx, paths, None)?;
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
                    process_file(abs, &rel_str, &meta, existing.get(&rel_str), false)
                {
                    records.push(r);
                }
            }
            Ok(meta) if meta.is_dir() => {
                let existing = load_existing(conn, Some(prefix_range(&rel_str)))?;
                let mut seen = HashSet::new();
                for entry in walk_builder(abs).build() {
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
                        process_file(entry.path(), &p, &m, existing.get(&p), false)
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

    let set_changed = !removed.is_empty() || records.iter().any(|r| !r.existed);
    for p in &removed {
        paths.remove(p);
    }
    for r in records.iter().filter(|r| !r.existed) {
        paths.insert(r.path.clone());
    }
    let tx = conn.transaction()?;
    super::fts::delete_files(&tx, &removed)?;
    write_records(&tx, &records, Some(paths))?;
    if set_changed {
        resolve_links(&tx, paths, None)?;
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
