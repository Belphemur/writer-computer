//! Full-text search over note content (`notes_fts`), ranked with bm25 and
//! enriched with line-level snippets read from the files on disk.
//!
//! No `tauri::` types: the app command, the CLI and tests share this. See
//! `SPECs/search-spec.md` for the design and its limits.

use super::fts::{
    is_cjk, run_maintenance, space_cjk_mapped, FtsMaintenance, BM25_WEIGHTS, FTS_MAX_BODY_BYTES,
    FTS_TOKENIZE,
};
use super::kinds::{self, TextSource, PAGE_BREAK};
use super::note::content_hash;
use super::rank::{
    combine, empty_query_key, match_name_or_title, match_path, prepare_title, recency_boost,
    OpenedMap, Prepared, PreparedQuery, Recency,
};
use super::search_query::{parse_query, Filter, ParsedQuery, Term};
use super::{Index, IndexError, Job};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::mpsc::sync_channel;

type Res<T> = Result<T, IndexError>;

pub const DEFAULT_LIMIT: u32 = 30;
pub const MAX_LIMIT: u32 = 10_000;
const DEFAULT_SNIPPETS: u32 = 3;
const DEFAULT_SNIPPET_LEN: u32 = 160;
/// With `case_sensitive` the ranked list is verified against file text, so at
/// most this many matches are examined (`SearchPage::truncated` says when more
/// existed).
pub const CASE_SCAN_CAP: usize = 5000;
/// Recency re-ranking looks at this many best text matches (at least
/// `offset + limit`), then reorders them by `rank::recency_boost`.
const RERANK_POOL: usize = 200;
/// Which listed files a name pass looks at: the kinds with text (notes, code, PDFs, drawings: the
/// few-hits fallback) or the kinds found by name only (a `.base`, an image: they have no text row,
/// so always). The sets come from the kind registry (`index::kinds`).
#[derive(Clone, Copy)]
enum FuzzyKind {
    Text,
    NameOnly,
}

impl FuzzyKind {
    /// `'a','b'` for an SQL `IN (...)`: registry ids, never user input.
    fn kinds_sql(self) -> String {
        let ids = match self {
            FuzzyKind::Text => kinds::text_kind_ids(),
            FuzzyKind::NameOnly => kinds::name_only_kind_ids(),
        };
        ids.iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// The fuzzy fallback runs when fewer notes than this matched exactly.
const FUZZY_FEW: i64 = 5;
/// At most this many fuzzy (similar-name) hits are appended.
const FUZZY_MAX: usize = 10;
/// A fuzzy hit needs at least this much text score per query char.
const FUZZY_MIN_PER_CHAR: f64 = 11.0;
/// A heading or tag match counts this much of a file-name match.
const FUZZY_SECONDARY_FACTOR: f64 = 0.6;
const HL_OPEN: char = '\u{1}';
const HL_CLOSE: char = '\u{2}';

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    /// Vault-relative folder; matches the folder and everything below it.
    pub folder: Option<String>,
    /// Every listed tag must be on the note (nested tags match ancestors).
    pub tags: Vec<String>,
    /// Keep only these file kinds (`index::kinds` ids, any of them): the palette's kind chips.
    /// Combined with the query's own `kind:` filters, both must hold.
    pub kinds: Vec<String>,
    /// Hits per page (default 30, at most [`MAX_LIMIT`]).
    pub limit: Option<u32>,
    pub offset: u32,
    /// Keep only matches whose text equals the query's spelling exactly
    /// (case and diacritics). Verified on the file text, see [`CASE_SCAN_CAP`].
    pub case_sensitive: bool,
    /// Longest snippet in characters (default 160); `0` returns whole lines.
    pub snippet_len: Option<u32>,
    /// Lines per hit (default 3); `0` skips reading files (no snippets and no
    /// stale check). `search:context` asks for every line.
    pub max_snippets: Option<u32>,
    /// Search-as-you-type: a trailing bare word with no space after it also
    /// matches as a prefix (`harb` finds `harbour`).
    pub as_you_type: bool,
    /// Rank recently modified and recently opened notes higher
    /// (`SPECs/search-ranking-spec.md`). Off for the CLI, on for the palette.
    pub recency: bool,
    /// When few notes match exactly, append similar ones: typo-tolerant and
    /// subsequence matches on file names, headings and tags.
    pub fuzzy: bool,
    /// Last-opened unix ms by vault-relative path; filled by the app, not IPC.
    #[serde(skip)]
    pub opened: OpenedMap,
    /// Clock for recency; `0` reads the system clock. Tests pin it.
    #[serde(skip)]
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// 1-based line number in the file as it is on disk (frontmatter counts) when `in_file`;
    /// otherwise the line of the extracted text (a drawing's text element).
    pub line: u32,
    /// `line` is a line of the file itself (a note, a code file), so a hit can open at it.
    pub in_file: bool,
    /// The 1-based page of a paged document (a PDF); the hit opens at `#page=N`.
    pub page: Option<u32>,
    pub text: String,
    /// Highlighted `[start, end)` ranges in UTF-16 code units of `text`.
    pub ranges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    /// File name without extension.
    pub title: String,
    /// The note's display-title override (frontmatter `title`), never a heading. Searchable like
    /// the file name; surfaces show it first (`noteLabel` in `src/lib/note-title.ts`).
    pub title_override: Option<String>,
    pub folder: String,
    /// The id of the file's kind (`index::kinds`): `note`, `pdf`, `code`...
    pub kind: String,
    /// bm25 relevance (times the recency boost when enabled), higher is better.
    /// Fuzzy hits carry a small rank value and always follow the exact ones.
    pub score: f64,
    /// Found by the fuzzy fallback (similar name, heading or tag), not by the
    /// full-text query: it has no snippets.
    pub fuzzy: bool,
    pub snippets: Vec<Snippet>,
    /// The file differs from what was indexed (or vanished): the hit may be
    /// outdated and the watcher will refresh it. Only evaluated when snippets
    /// were requested.
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    /// Matching notes before `limit`/`offset`.
    pub total: i64,
    pub hits: Vec<SearchHit>,
    /// `case_sensitive` examined only the first [`CASE_SCAN_CAP`] matches.
    pub truncated: bool,
}

/// The `title` frontmatter property (text) of a `files` row aliased `f`; headings never count.
const TITLE_OVERRIDE_SQL: &str = "(SELECT p.v_text FROM props p WHERE p.file_id = f.id \
     AND p.key = 'title' AND p.vtype = 'text')";

struct RawHit {
    path: String,
    title: String,
    title_override: Option<String>,
    folder: String,
    kind: String,
    hash: Option<i64>,
    score: f64,
    mtime_ms: i64,
    size: i64,
}

fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// WHERE fragments (all bound) for the options and the query's filters.
fn conditions(q: &ParsedQuery, o: &SearchOptions) -> Res<(String, Vec<SqlValue>)> {
    let mut sql = String::new();
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(folder) = o.folder.as_deref().map(|f| f.trim_matches('/')) {
        if !folder.is_empty() {
            sql.push_str(" AND f.path >= ? AND f.path < ?");
            args.push(format!("{folder}/").into());
            args.push(format!("{folder}0").into());
        }
    }
    let mut tags: Vec<String> = Vec::new();
    for t in &o.tags {
        tags.push(
            super::markdown::normalize_tag(t)
                .ok_or_else(|| IndexError::Invalid(format!("invalid tag: {t}")))?,
        );
    }
    let like = |col: &str, v: &str, sql: &mut String, args: &mut Vec<SqlValue>| {
        sql.push_str(&format!(" AND {col} LIKE ? ESCAPE '\\'"));
        args.push(format!("%{}%", like_escape(v)).into());
    };
    // `kind:` and `ext:` filters repeat as alternatives (OR within one key); the chips' kinds are
    // a second group that must hold as well; the negated ones are all excluded.
    let (mut kinds, mut not_kinds, mut exts, mut not_exts) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for f in &q.filters {
        match f {
            Filter::Path(v) => like("f.path", v, &mut sql, &mut args),
            Filter::File(v) => like("f.basename", v, &mut sql, &mut args),
            Filter::Tag(t) => tags.push(t.clone()),
            Filter::Kind(k) => kinds.push(k.clone()),
            Filter::NotKind(k) => not_kinds.push(k.clone()),
            Filter::Ext(e) => exts.push(e.clone()),
            Filter::NotExt(e) => not_exts.push(e.clone()),
            Filter::Never => sql.push_str(" AND 0"),
        }
    }
    let mut chip_kinds = Vec::new();
    for k in &o.kinds {
        let id = k.to_lowercase();
        if kinds::by_id(&id).is_none() {
            return Err(IndexError::Invalid(format!(
                "unknown kind \"{k}\"; known kinds: {}",
                kinds::ids().join(", ")
            )));
        }
        chip_kinds.push(id);
    }
    for (col, op, values) in [
        ("f.kind", "IN", kinds),
        ("f.kind", "IN", chip_kinds),
        ("f.kind", "NOT IN", not_kinds),
        ("f.ext", "IN", exts),
        ("f.ext", "NOT IN", not_exts),
    ] {
        if !values.is_empty() {
            let marks = vec!["?"; values.len()].join(",");
            sql.push_str(&format!(" AND {col} {op} ({marks})"));
            args.extend(values.into_iter().map(SqlValue::from));
        }
    }
    for t in tags {
        sql.push_str(" AND EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.tag = ?)");
        args.push(t.into());
    }
    Ok((sql, args))
}

impl Index {
    /// Ranked full-text search. Never fails on odd input: the query is
    /// translated by [`parse_query`] (only size limits are `Invalid`).
    pub fn search(&self, query: &str, opts: &SearchOptions) -> Res<SearchPage> {
        let parsed = parse_query(query, opts.as_you_type)?;
        let Some(match_expr) = parsed.match_expr.clone() else {
            if !parsed.filters.is_empty() {
                return self.filter_only(&parsed, opts);
            }
            return Ok(SearchPage {
                total: 0,
                hits: Vec::new(),
                truncated: false,
            });
        };
        let (cond_sql, cond_args) = conditions(&parsed, opts)?;
        let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
        let offset = opts.offset as usize;
        let case = opts.case_sensitive;

        let (raw, total, truncated) = self.read(|c| {
            let from = "FROM notes_fts CROSS JOIN files f ON f.id = notes_fts.rowid \
                        WHERE notes_fts MATCH ?";
            let mut base: Vec<SqlValue> = vec![match_expr.clone().into()];
            base.extend(cond_args.iter().cloned());
            let total: i64 = c.query_row(
                &format!("SELECT COUNT(*) {from}{cond_sql}"),
                params_from_iter(base.iter()),
                |r| r.get(0),
            )?;
            // Case verification needs the text of every candidate, so page
            // after filtering; otherwise page in SQL.
            let (lim, off) = if case {
                (CASE_SCAN_CAP, 0)
            } else if opts.recency {
                ((offset + limit).max(RERANK_POOL), 0)
            } else {
                (limit, offset)
            };
            let sql = format!(
                "SELECT f.path, f.basename, f.folder, f.body_hash, \
                        -bm25(notes_fts, {BM25_WEIGHTS}) AS score, f.mtime, {TITLE_OVERRIDE_SQL}, \
                        f.kind, f.size \
                 {from}{cond_sql} ORDER BY score DESC, f.path LIMIT {lim} OFFSET {off}"
            );
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map(params_from_iter(base.iter()), |r| {
                Ok(RawHit {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    folder: r.get(2)?,
                    hash: r.get(3)?,
                    score: r.get(4)?,
                    mtime_ms: r.get(5)?,
                    title_override: r.get(6)?,
                    kind: r.get(7)?,
                    size: r.get(8)?,
                })
            })?;
            let raw = rows.collect::<Result<Vec<_>, _>>()?;
            Ok((raw, total, case && total as usize > CASE_SCAN_CAP))
        })?;

        let now_ms = if opts.now_ms > 0 {
            opts.now_ms
        } else {
            system_now_ms()
        };
        let raw = if opts.recency && !case {
            let mut raw = raw;
            for r in &mut raw {
                let boost = recency_boost(
                    now_ms,
                    Recency {
                        opened_ms: opts.opened.get(&r.path).copied(),
                        mtime_ms: r.mtime_ms,
                    },
                );
                r.score = combine(r.score, boost);
            }
            raw.sort_by(|a, b| {
                b.score
                    .total_cmp(&a.score)
                    .then_with(|| a.path.cmp(&b.path))
            });
            raw.into_iter().skip(offset).take(limit).collect()
        } else {
            raw
        };

        let snippet_len = opts.snippet_len.unwrap_or(DEFAULT_SNIPPET_LEN) as usize;
        let max_snippets = opts.max_snippets.unwrap_or(DEFAULT_SNIPPETS) as usize;
        let mut hits = Vec::with_capacity(raw.len());
        let matcher = if case || max_snippets > 0 {
            Some(LineMatcher::new()?)
        } else {
            None
        };
        for r in raw {
            let (mut snippets, stale) = match (&matcher, &parsed.line_expr) {
                (Some(m), Some(expr)) => {
                    let max = if case { usize::MAX } else { max_snippets };
                    match kinds::by_id(&r.kind).map_or(TextSource::Disk, |k| k.text) {
                        TextSource::Disk => m.snippets(
                            &self.shared.root.join(&r.path),
                            r.hash,
                            expr,
                            max,
                            snippet_len,
                        )?,
                        TextSource::Stored => {
                            self.stored_snippets(m, &r, expr, max, snippet_len)?
                        }
                        TextSource::None => (Vec::new(), false),
                    }
                }
                _ => (Vec::new(), false),
            };
            if case {
                snippets.retain_mut(|s| keep_case_matches(s, &parsed.positives));
                if snippets.is_empty() {
                    continue;
                }
                snippets.truncate(max_snippets);
            }
            hits.push(SearchHit {
                path: r.path,
                title: r.title,
                title_override: r.title_override,
                folder: r.folder,
                kind: r.kind,
                score: r.score,
                fuzzy: false,
                snippets,
                stale,
            });
        }
        let (hits, total) = if case {
            let total = hits.len() as i64;
            (hits.into_iter().skip(offset).take(limit).collect(), total)
        } else {
            (hits, total)
        };
        let (mut hits, mut total) = (hits, total);
        if opts.fuzzy && !case && offset == 0 {
            // A `.base` or an image has no full-text row, so its name is the only way to it:
            // always list it, ahead of the body matches, however many notes matched the text.
            let bases = self.fuzzy_hits(
                &parsed,
                opts,
                (&cond_sql, &cond_args),
                FuzzyKind::NameOnly,
                &std::collections::HashSet::new(),
                FUZZY_MAX,
                now_ms,
            )?;
            total += bases.len() as i64;
            hits.splice(0..0, bases);
            if total < FUZZY_FEW {
                let room = limit.saturating_sub(hits.len()).min(FUZZY_MAX);
                if room > 0 {
                    let seen: std::collections::HashSet<String> =
                        hits.iter().map(|h| h.path.clone()).collect();
                    let extra = self.fuzzy_hits(
                        &parsed,
                        opts,
                        (&cond_sql, &cond_args),
                        FuzzyKind::Text,
                        &seen,
                        room,
                        now_ms,
                    )?;
                    total += extra.len() as i64;
                    hits.extend(extra);
                }
            }
        }
        Ok(SearchPage {
            total,
            hits,
            truncated,
        })
    }

    /// A query made only of filters (`tag:x`, `kind:pdf`, `path:dir`): every matching file, the
    /// way an empty query lists files (`rank::empty_query_key`: opened first, then newest
    /// modified), in the shape of a normal page (no snippets, score 0).
    fn filter_only(&self, parsed: &ParsedQuery, opts: &SearchOptions) -> Res<SearchPage> {
        let (cond_sql, cond_args) = conditions(parsed, opts)?;
        let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
        let offset = opts.offset as usize;
        let (raw, total) = self.read(|c| {
            let total: i64 = c.query_row(
                &format!("SELECT COUNT(*) FROM files f WHERE 1 = 1{cond_sql}"),
                params_from_iter(cond_args.iter()),
                |r| r.get(0),
            )?;
            // Newest modified first bounds the pool; the opened files are then ranked first.
            let pool = (offset + limit).max(RERANK_POOL);
            let sql = format!(
                "SELECT f.path, f.basename, f.folder, f.mtime, {TITLE_OVERRIDE_SQL}, f.kind \
                 FROM files f WHERE 1 = 1{cond_sql} ORDER BY f.mtime DESC, f.path LIMIT {pool}"
            );
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map(params_from_iter(cond_args.iter()), |r| {
                let hit = SearchHit {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    folder: r.get(2)?,
                    title_override: r.get(4)?,
                    kind: r.get(5)?,
                    score: 0.0,
                    fuzzy: false,
                    snippets: Vec::new(),
                    stale: false,
                };
                Ok((hit, r.get::<_, i64>(3)?))
            })?;
            Ok((rows.collect::<Result<Vec<_>, _>>()?, total))
        })?;
        let key = |(h, mtime_ms): &(SearchHit, i64)| {
            empty_query_key(Recency {
                opened_ms: opts.opened.get(&h.path).copied(),
                mtime_ms: *mtime_ms,
            })
        };
        let mut ranked = raw;
        ranked.sort_by(|a, b| key(b).cmp(&key(a)).then_with(|| a.0.path.cmp(&b.0.path)));
        let hits = ranked
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(h, _)| h)
            .collect();
        Ok(SearchPage {
            total,
            hits,
            truncated: false,
        })
    }

    /// Similar notes for a query that found (almost) nothing: the query's
    /// words fuzzy-match (`rank.rs`: subsequence and typos) a note's file name,
    /// or, at lower weight, one of its headings or tags.
    #[allow(clippy::too_many_arguments)]
    fn fuzzy_hits(
        &self,
        parsed: &ParsedQuery,
        opts: &SearchOptions,
        (cond_sql, cond_args): (&str, &[SqlValue]),
        kind: FuzzyKind,
        seen: &std::collections::HashSet<String>,
        room: usize,
        now_ms: i64,
    ) -> Res<Vec<SearchHit>> {
        let words: Vec<&str> = parsed
            .positives
            .iter()
            .flat_map(|t| t.words.iter().map(String::as_str))
            .collect();
        let q = PreparedQuery::new(&words.join(" "));
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let min_score = FUZZY_MIN_PER_CHAR * q.char_count() as f64;
        let (names, secondary) = self.read(|c| {
            let sql = format!(
                "SELECT f.id, f.path, f.basename, f.folder, f.mtime, {TITLE_OVERRIDE_SQL}, f.name, f.kind \
                 FROM files f WHERE f.kind IN ({}){cond_sql}",
                kind.kinds_sql()
            );
            let mut st = c.prepare(&sql)?;
            let names = st
                .query_map(params_from_iter(cond_args.iter()), |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut secondary: HashMap<i64, Vec<String>> = HashMap::new();
            for (sql, _) in [
                ("SELECT file_id, text FROM headings", ()),
                ("SELECT file_id, tag FROM tags", ()),
            ] {
                let mut st = c.prepare(sql)?;
                let rows =
                    st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
                for row in rows {
                    let (id, text) = row?;
                    secondary.entry(id).or_default().push(text);
                }
            }
            Ok((names, secondary))
        })?;
        let mut scored: Vec<(f64, SearchHit)> = Vec::new();
        for (id, path, basename, folder, mtime_ms, title_override, file_name, kind_id) in names {
            if seen.contains(&path) {
                continue;
            }
            // File name and display-title override: the better of the two (`rank.rs`).
            let title_prepared = title_override
                .as_deref()
                .filter(|t| !t.trim().is_empty())
                .map(prepare_title);
            let mut best =
                match_name_or_title(&q, &Prepared::new(&file_name), title_prepared.as_ref())
                    .map(|m| m.score);
            if let Some(texts) = secondary.get(&id) {
                for t in texts {
                    if let Some(m) = match_path(&q, &Prepared::new(t)) {
                        let s = m.score * FUZZY_SECONDARY_FACTOR;
                        if best.is_none_or(|b| s > b) {
                            best = Some(s);
                        }
                    }
                }
            }
            let Some(text) = best.filter(|s| *s >= min_score) else {
                continue;
            };
            let boost = if opts.recency {
                recency_boost(
                    now_ms,
                    Recency {
                        opened_ms: opts.opened.get(&path).copied(),
                        mtime_ms,
                    },
                )
            } else {
                0.0
            };
            let rank_value = combine(text, boost);
            scored.push((
                rank_value,
                SearchHit {
                    path,
                    title: basename,
                    title_override,
                    folder,
                    kind: kind_id,
                    score: rank_value / 1000.0,
                    fuzzy: true,
                    snippets: Vec::new(),
                    stale: false,
                },
            ));
        }
        scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
        Ok(scored.into_iter().take(room).map(|(_, h)| h).collect())
    }

    /// The lines under a hit of a kind whose text the index keeps (`file_text`): a PDF's pages, a
    /// drawing's labels. Stale when the file moved on (or vanished) since it was indexed.
    fn stored_snippets(
        &self,
        matcher: &LineMatcher,
        hit: &RawHit,
        line_expr: &str,
        max: usize,
        snippet_len: usize,
    ) -> Res<(Vec<Snippet>, bool)> {
        let stored: Option<String> = self.read(|c| {
            use rusqlite::OptionalExtension;
            Ok(c.query_row(
                "SELECT t.body FROM file_text t JOIN files f ON f.id = t.file_id WHERE f.path = ?1",
                [&hit.path],
                |r| r.get(0),
            )
            .optional()?)
        })?;
        let stale = std::fs::metadata(self.shared.root.join(&hit.path)).map_or(true, |m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            mtime != Some(hit.mtime_ms) || m.len() as i64 != hit.size
        });
        let Some(text) = stored else {
            return Ok((Vec::new(), stale));
        };
        Ok((
            matcher.snippets_in(&text, line_expr, max, snippet_len, StoredText)?,
            stale,
        ))
    }

    /// Run an FTS maintenance command on the writer thread and wait.
    pub fn fts_maintenance(&self, op: FtsMaintenance) -> Res<()> {
        let (tx, rx) = sync_channel(1);
        self.send(Job::Fts(op, Some(tx)))?;
        rx.recv().map_err(|_| IndexError::Closed)?
    }
}

pub(crate) fn run_fts_job(conn: &Connection, op: FtsMaintenance) -> Res<()> {
    run_maintenance(conn, op)
}

/// Case-sensitive post-filter: keep only highlighted ranges whose text is the
/// query's own spelling (prefix terms: starting with it). Returns whether any
/// range survived.
fn keep_case_matches(s: &mut Snippet, positives: &[Term]) -> bool {
    let utf16: Vec<u16> = s.text.encode_utf16().collect();
    let ok = |range: &[u32; 2]| {
        let text = String::from_utf16_lossy(&utf16[range[0] as usize..range[1] as usize]);
        positives.iter().any(|t| {
            t.words.iter().any(|w| {
                if t.prefix {
                    text.starts_with(w.as_str())
                } else {
                    text == *w
                }
            })
        })
    };
    s.ranges.retain(|r| ok(r));
    !s.ranges.is_empty()
}

/// The text the lines come from is extracted text kept in the index, not the file: its line
/// numbers are not the file's, and a page-break line (`kinds::PAGE_BREAK`) starts a new page.
struct StoredText;

/// Per-search in-memory FTS5 table used to find the matching lines of a file
/// with exactly the same tokenizer as the index.
struct LineMatcher {
    conn: Connection,
}

impl LineMatcher {
    fn new() -> Res<LineMatcher> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE l USING fts5(t, tokenize = '{FTS_TOKENIZE}');"
        ))?;
        Ok(LineMatcher { conn })
    }

    /// Matching lines of the file at `abs` plus whether it is stale against
    /// `indexed_hash`. A vanished or unreadable file is stale with no lines.
    fn snippets(
        &self,
        abs: &std::path::Path,
        indexed_hash: Option<i64>,
        line_expr: &str,
        max: usize,
        snippet_len: usize,
    ) -> Res<(Vec<Snippet>, bool)> {
        let bytes = match std::fs::read(abs) {
            Ok(b) => b,
            Err(_) => return Ok((Vec::new(), true)),
        };
        // a file indexed by name only has no hash and nothing to be stale against
        let stale = indexed_hash.is_some_and(|h| h != content_hash(&bytes));
        if bytes.len() > FTS_MAX_BODY_BYTES {
            return Ok((Vec::new(), stale));
        }
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        Ok((
            self.snippets_in(text, line_expr, max, snippet_len, FileLines)?,
            stale,
        ))
    }

    /// The matching lines of `text`, best first by line order (see [`LineSource`]).
    fn snippets_in(
        &self,
        text: &str,
        line_expr: &str,
        max: usize,
        snippet_len: usize,
        source: impl LineSource,
    ) -> Res<Vec<Snippet>> {
        let lines: Vec<&str> = text
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .collect();

        let tx = self.conn.unchecked_transaction()?;
        let mut maps: std::collections::HashMap<i64, Vec<usize>> = Default::default();
        {
            let mut ins = tx.prepare_cached("INSERT INTO l(rowid, t) VALUES(?1, ?2)")?;
            for (i, line) in lines.iter().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                let (mut spaced, map) = space_cjk_mapped(line);
                // The highlight markers must not occur in the text itself.
                spaced = spaced.replace([HL_OPEN, HL_CLOSE], " ");
                let rowid = i as i64 + 1;
                ins.execute(rusqlite::params![rowid, spaced])?;
                if line.chars().any(is_cjk) {
                    maps.insert(rowid, map);
                }
            }
        }
        let mut found: Vec<(i64, String)> = Vec::new();
        {
            let mut st = tx.prepare_cached(
                "SELECT rowid, highlight(l, 0, char(1), char(2)) FROM l WHERE l MATCH ?1 \
                 ORDER BY rank LIMIT ?2",
            )?;
            let limit = i64::try_from(max).unwrap_or(i64::MAX);
            let rows = st.query_map(rusqlite::params![line_expr, limit], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for r in rows {
                found.push(r?);
            }
        }
        drop(tx); // rolls back: the table is empty again for the next file
        found.sort_by_key(|(rowid, _)| *rowid);
        let mut out = Vec::with_capacity(found.len());
        for (rowid, marked) in found {
            let line = lines[(rowid - 1) as usize];
            let ranges = parse_marks(&marked, maps.get(&rowid));
            let mut snippet = window_snippet(rowid as u32, line, &ranges, snippet_len);
            source.place(&lines, rowid as usize - 1, &mut snippet);
            out.push(snippet);
        }
        Ok(out)
    }
}

/// Where a snippet's lines come from, which decides what its position means.
trait LineSource {
    /// Fill in the snippet's position (`in_file`, `page`) for line index `at` of `lines`.
    fn place(&self, lines: &[&str], at: usize, snippet: &mut Snippet);
}

/// The file's own lines: the number is the file's.
struct FileLines;

impl LineSource for FileLines {
    fn place(&self, _lines: &[&str], _at: usize, snippet: &mut Snippet) {
        snippet.in_file = true;
    }
}

impl LineSource for StoredText {
    fn place(&self, lines: &[&str], at: usize, snippet: &mut Snippet) {
        // every page starts with a page-break line, so the breaks above a line are its page
        // number; a document without any (a drawing) has no pages
        let page = lines[..at].iter().filter(|l| **l == PAGE_BREAK).count();
        snippet.page = (page > 0).then_some(page as u32);
    }
}

/// Highlight markers in `marked` -> `[start, end)` char ranges of the original
/// line (`map`: spaced char index -> original char index, for CJK lines).
fn parse_marks(marked: &str, map: Option<&Vec<usize>>) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut idx = 0usize; // index into the spaced text
    let mut start: Option<usize> = None;
    let orig = |i: usize| map.map_or(i, |m| m.get(i).copied().unwrap_or(i));
    for c in marked.chars() {
        match c {
            HL_OPEN => start = Some(idx),
            HL_CLOSE => {
                if let Some(s) = start.take() {
                    let (a, b) = (orig(s), orig(idx.saturating_sub(1)) + 1);
                    match ranges.last_mut() {
                        // adjacent ideographs highlighted one by one
                        Some(last) if last.1 >= a && map.is_some() => last.1 = last.1.max(b),
                        _ => ranges.push((a, b)),
                    }
                }
            }
            _ => idx += 1,
        }
    }
    ranges
}

/// Build the snippet text (windowed around the first match when longer than
/// `max_len` chars; `0` keeps the whole line) with UTF-16 ranges.
fn window_snippet(line_no: u32, line: &str, ranges: &[(usize, usize)], max_len: usize) -> Snippet {
    let chars: Vec<char> = line.chars().collect();
    let (mut from, mut to) = (0usize, chars.len());
    let (mut pre, mut post) = (false, false);
    if max_len > 0 && chars.len() > max_len {
        let first = ranges.first().map_or(0, |r| r.0);
        from = first.saturating_sub(max_len / 4).min(chars.len() - max_len);
        to = from + max_len;
        pre = from > 0;
        post = to < chars.len();
    }
    let mut text = String::new();
    if pre {
        text.push('…');
    }
    let shift = usize::from(pre);
    text.extend(&chars[from..to]);
    if post {
        text.push('…');
    }
    // char index in `text` -> UTF-16 offset
    let mut offsets = Vec::with_capacity(chars.len() + 2);
    let mut acc = 0u32;
    for c in text.chars() {
        offsets.push(acc);
        acc += c.len_utf16() as u32;
    }
    offsets.push(acc);
    let ranges = ranges
        .iter()
        .filter_map(|&(a, b)| {
            let (a, b) = (a.max(from), b.min(to));
            (a < b).then(|| [offsets[a - from + shift], offsets[b - from + shift]])
        })
        .collect();
    Snippet {
        line: line_no,
        in_file: false,
        page: None,
        text: text.trim_end().to_string(),
        ranges,
    }
}
