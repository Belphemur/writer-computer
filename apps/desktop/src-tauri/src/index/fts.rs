//! Full-text index storage: the FTS5 table, its text preparation and the one
//! write path used by the indexer's transactions. The query side lives in
//! `search.rs` / `search_query.rs`; the decisions are in `SPECs/search-spec.md`.
//!
//! `notes_fts` is a *contentless-delete* FTS5 table keyed by `files.id`: it
//! keeps only the inverted index (no second copy of every note), because the
//! note text for snippets is always read from disk. It is written in the same
//! transaction as the `files` row by [`write_doc`] and emptied by
//! [`delete_docs`]; there are no triggers.

use super::IndexError;
use rusqlite::Connection;

/// Tokenizer shared by the index table and the per-file line matcher so both
/// agree on what a token is. `remove_diacritics 2` folds all Latin diacritics
/// (the default 1 misses some multi-diacritic letters).
pub(crate) const FTS_TOKENIZE: &str = "unicode61 remove_diacritics 2";

/// bm25 column weights, in column order: title, headings, tags, props, body.
pub(crate) const BM25_WEIGHTS: &str = "10.0, 5.0, 4.0, 2.0, 1.0";

/// Bodies larger than this many bytes are not indexed (title, headings, tags
/// and properties still are), and no line snippets are produced for them.
pub const FTS_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

pub(crate) const FTS_DDL: &str = "
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, headings, tags, props, body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2',
  content = '', contentless_delete = 1
);
";

/// Text columns of one note, already CJK-spaced (see [`space_cjk`]).
#[derive(Debug, Default, Clone)]
pub struct FtsDoc {
    pub headings: String,
    pub tags: String,
    /// Frontmatter text values (scalar values and list items), one per line.
    pub props: String,
    /// Note text without the frontmatter block; empty when skipped.
    pub body: String,
    /// The body exceeded [`FTS_MAX_BODY_BYTES`] and was not indexed.
    pub body_skipped: bool,
    /// The extracted text of a kind whose hits show lines from the index (`TextSource::Stored`:
    /// a PDF, a drawing), kept in `file_text` next to the FTS row. `None` for every other file.
    pub stored: Option<String>,
    /// Test-only switch (perf A/B): leave this note out of the index.
    #[cfg(test)]
    pub skip: bool,
}

/// Ideographs, kana and Hangul syllables. `unicode61` treats an unbroken run
/// of these as one long token, which would make 2-character CJK words
/// unsearchable inside a sentence.
pub(crate) fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF | 0x31F0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F | 0x20000..=0x2FA1F)
}

/// Put a space around every CJK character so each becomes its own token; a
/// CJK query is spaced the same way, which turns it into a phrase and gives
/// substring matching for those scripts without a trigram table.
pub(crate) fn space_cjk(text: &str) -> String {
    if !text.chars().any(is_cjk) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if is_cjk(c) {
            out.push(' ');
            out.push(c);
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// Like [`space_cjk`], plus for every char of the result the index of the
/// original char it came from (inserted spaces map to the following char).
pub(crate) fn space_cjk_mapped(text: &str) -> (String, Vec<usize>) {
    let mut out = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len());
    for (i, c) in text.chars().enumerate() {
        if is_cjk(c) {
            out.push(' ');
            map.push(i);
            out.push(c);
            map.push(i);
            out.push(' ');
            map.push(i + 1);
        } else {
            out.push(c);
            map.push(i);
        }
    }
    (out, map)
}

/// Insert or replace the FTS row of file `id`. `replace`: a row may exist.
pub(crate) fn write_doc(
    conn: &Connection,
    id: i64,
    title: &str,
    doc: &FtsDoc,
    replace: bool,
) -> Result<(), IndexError> {
    if replace {
        conn.prepare_cached("DELETE FROM notes_fts WHERE rowid = ?1")?
            .execute([id])?;
    }
    #[cfg(test)]
    if doc.skip {
        return Ok(());
    }
    conn.prepare_cached(
        "INSERT INTO notes_fts(rowid, title, headings, tags, props, body) VALUES(?1,?2,?3,?4,?5,?6)",
    )?
    .execute(rusqlite::params![
        id,
        space_cjk(title),
        doc.headings,
        doc.tags,
        doc.props,
        doc.body
    ])?;
    match &doc.stored {
        Some(text) => conn
            .prepare_cached("INSERT OR REPLACE INTO file_text(file_id, body) VALUES(?1, ?2)")?
            .execute(rusqlite::params![id, text])?,
        None if replace => conn
            .prepare_cached("DELETE FROM file_text WHERE file_id = ?1")?
            .execute([id])?,
        None => 0,
    };
    Ok(())
}

/// Drop the FTS row and the stored text of file `id`.
pub(crate) fn delete_doc(conn: &Connection, id: i64) -> Result<(), IndexError> {
    conn.prepare_cached("DELETE FROM notes_fts WHERE rowid = ?1")?
        .execute([id])?;
    conn.prepare_cached("DELETE FROM file_text WHERE file_id = ?1")?
        .execute([id])?;
    Ok(())
}

/// Remove files (and their FTS rows, which have no foreign key to cascade
/// from) by vault-relative path. The one deletion path for scans and watcher
/// updates.
pub(crate) fn delete_files(conn: &Connection, paths: &[impl AsRef<str>]) -> Result<(), IndexError> {
    let mut fts = conn.prepare_cached(
        "DELETE FROM notes_fts WHERE rowid IN (SELECT id FROM files WHERE path = ?1)",
    )?;
    let mut files = conn.prepare_cached("DELETE FROM files WHERE path = ?1")?;
    for p in paths {
        fts.execute([p.as_ref()])?;
        files.execute([p.as_ref()])?;
    }
    Ok(())
}

/// Maintenance commands run on the writer connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FtsMaintenance {
    /// Merge all index b-trees into one (slow on big vaults, shrinks the file).
    Optimize,
    /// Verify the inverted index; fails with `SQLITE_CORRUPT_VTAB` otherwise.
    IntegrityCheck,
}

pub(crate) fn run_maintenance(conn: &Connection, op: FtsMaintenance) -> Result<(), IndexError> {
    let cmd = match op {
        FtsMaintenance::Optimize => "optimize",
        FtsMaintenance::IntegrityCheck => "integrity-check",
    };
    conn.execute("INSERT INTO notes_fts(notes_fts) VALUES(?1)", [cmd])?;
    Ok(())
}

/// Bytes the FTS tables occupy (`dbstat`, compiled into the bundled SQLite).
pub fn fts_size_bytes(conn: &Connection) -> Result<i64, IndexError> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name LIKE 'notes\\_fts%' ESCAPE '\\'",
        [],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_spacing_and_mapping() {
        assert_eq!(space_cjk("abc"), "abc");
        assert_eq!(space_cjk("a東京b"), "a 東  京 b");
        let (s, map) = space_cjk_mapped("a東b");
        assert_eq!(s, "a 東 b");
        assert_eq!(map, vec![0, 1, 1, 2, 2]);
    }
}
