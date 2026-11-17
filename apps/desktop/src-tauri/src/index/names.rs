//! File-name and path search over the vault index (quick open, link and path
//! autocompletion, recents, sidebar "folder holds notes" checks).
//!
//! The `files` table is the single source of truth. [`NameCache`] mirrors the
//! listed rows (Markdown notes and `.base` files) as a compact, sorted
//! in-memory structure so a keystroke is a substring scan over a few thousand
//! short strings instead of a SQL round trip. The mirror is kept fresh from
//! the index's own `index://changed` feed ([`ChangeBatch`]): a batch of paths
//! is re-read from SQLite by path (never a rescan), and a `full` batch reloads
//! the listed rows once.
//!
//! While the cold build is still running the table already holds the batches
//! committed so far. [`NameCache::search`] serves those partial rows and sets
//! [`NameSearch::building`] so callers never mistake a short list for a
//! complete one. "Complete" is read from the database itself (`meta.built_at`,
//! written in the final transaction of a scan) in the same snapshot as the rows.
//!
//! Tauri-free like the rest of `index/`; the per-window instance lives in
//! `WorkspaceState` and is fed by `commands/index.rs`.

use super::rank::{
    combine, empty_query_key, match_name_or_title, original_indices, prepare_title, recency_boost,
    OpenedMap, Prepared, PreparedQuery, Recency,
};
use super::{schema, ChangeBatch, Index, IndexError};
use parking_lot::Mutex;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The always-listed extensions; the code/text ones come from `code_files` (settings).
pub const LISTED_EXTS: [&str; 2] = ["md", "base"];

/// While the cold build runs, re-read the partial rows at most this often.
const PARTIAL_RELOAD_INTERVAL: Duration = Duration::from_millis(200);
/// SQLite's default variable limit is 32766; stay far below it.
const PATH_CHUNK: usize = 500;
/// Loads discarded because the data moved underneath them before giving up.
const MAX_LOAD_ATTEMPTS: usize = 5;

/// One listed file as stored in SQLite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameRow {
    /// Vault-relative, forward slashes.
    pub path: String,
    pub mtime_ms: i64,
    /// The note's frontmatter `title` (display-title override), never a heading.
    pub title: Option<String>,
}

/// Value half of the map entry; the vault-relative path is the key.
struct NameEntry {
    /// `path.to_lowercase()`, matched against the lowercased query.
    lower: String,
    /// Byte offset of the file name inside `lower`.
    name_start: usize,
    mtime_ms: i64,
    /// Folded form for the fuzzy matcher (see `rank.rs`).
    prepared: Prepared,
    /// The display-title override and its folded form (matched like a file called `<title>.md`,
    /// the same shape `rankGlobalRecents` in `command-palette/index.tsx` uses).
    title: Option<(String, Prepared)>,
}

impl NameEntry {
    fn new(path: &str, mtime_ms: i64, title: Option<String>) -> Self {
        let lower = path.to_lowercase();
        let name_start = lower.rfind('/').map(|i| i + 1).unwrap_or(0);
        NameEntry {
            lower,
            name_start,
            mtime_ms,
            prepared: Prepared::new(path),
            title: title
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .map(|t| {
                    let prepared = prepare_title(&t);
                    (t, prepared)
                }),
        }
    }
}

/// What ranking needs besides the query: the clock and the opened history.
/// The default (no recency) ranks on text alone.
#[derive(Debug, Default, Clone)]
pub struct RankContext {
    /// Unix milliseconds "now".
    pub now_ms: i64,
    /// Vault-relative path to last-opened unix milliseconds.
    pub opened: OpenedMap,
    /// Boost recently opened and modified files (`rank.rs`).
    pub recency: bool,
}

/// Optional narrowing applied before matching.
#[derive(Debug, Default, Clone)]
pub struct NameFilter {
    /// Vault-relative folder; only files below it (any depth) match.
    pub folder: Option<String>,
    /// Lowercase extensions without the dot; `None` means every listed one.
    pub exts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameMatch {
    /// Vault-relative path.
    pub path: String,
    pub name: String,
    pub score: u32,
    /// Char indices of the match inside `path` (empty when only the title matched).
    pub match_indices: Vec<u32>,
    /// The display-title override in effect for the file, if any.
    pub title: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NameSearch {
    pub root: PathBuf,
    pub matches: Vec<NameMatch>,
    /// The cold build has not finished: `matches` may be missing files.
    pub building: bool,
}

#[derive(Default)]
struct Inner {
    /// Bumped by [`NameCache::reset`]; callbacks from an older binding are dropped.
    generation: u64,
    bound: Option<Binding>,
    loaded: bool,
    complete: bool,
    /// Bumped on every mutation; a load that started under an older value is
    /// discarded instead of overwriting newer data.
    version: u64,
    last_partial: Option<Instant>,
    entries: BTreeMap<String, NameEntry>,
    /// Folder (vault-relative, `""` is the root) to the number of listed files below it.
    folders: HashMap<String, u32>,
}

struct Binding {
    root: PathBuf,
    db_path: PathBuf,
}

/// Per-window mirror of the listed rows. See the module docs.
#[derive(Default)]
pub struct NameCache {
    inner: Mutex<Inner>,
}

impl NameCache {
    /// Drop everything and invalidate the current binding. Returns the new
    /// generation; hand it to [`Self::bind`] and to every [`Self::apply`].
    pub fn reset(&self) -> u64 {
        let mut g = self.inner.lock();
        let generation = g.generation + 1;
        *g = Inner {
            generation,
            ..Inner::default()
        };
        generation
    }

    /// Attach the cache to a vault database. A no-op when `generation` is stale.
    pub fn bind(&self, generation: u64, root: PathBuf, db_path: PathBuf) {
        let mut g = self.inner.lock();
        if g.generation == generation {
            g.bound = Some(Binding { root, db_path });
        }
    }

    /// Force the next search to reload the listed rows (a feed update failed).
    pub fn mark_stale(&self, generation: u64) {
        let mut g = self.inner.lock();
        if g.generation == generation {
            g.loaded = false;
            g.version += 1;
        }
    }

    pub fn is_bound(&self) -> bool {
        self.inner.lock().bound.is_some()
    }

    /// The vault is fully indexed and mirrored. Cheap; never touches SQLite.
    pub fn is_ready(&self) -> bool {
        let g = self.inner.lock();
        g.loaded && g.complete
    }

    pub fn len(&self) -> usize {
        self.inner.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Does `abs_dir` (inside the vault) hold a listed file at any depth?
    /// `None` until the mirror is ready.
    pub fn dir_has_listed(&self, abs_dir: &Path) -> Option<bool> {
        let g = self.inner.lock();
        if !(g.loaded && g.complete) {
            return None;
        }
        let root = &g.bound.as_ref()?.root;
        let rel = crate::index::paths::rel_to_string(abs_dir.strip_prefix(root).ok()?)?;
        Some(g.folders.contains_key(&rel))
    }

    /// Feed one `index://changed` batch. Called on the index writer thread
    /// after the batch committed.
    pub fn apply(&self, generation: u64, batch: &ChangeBatch) -> Result<(), IndexError> {
        let (db_path, version) = {
            let g = self.inner.lock();
            let Some(b) = g.bound.as_ref() else {
                return Ok(());
            };
            if g.generation != generation {
                return Ok(());
            }
            // Not mirrored yet: the first search loads the committed state,
            // which already includes this batch.
            if !g.loaded && !batch.full {
                return Ok(());
            }
            (b.db_path.clone(), g.version)
        };
        if batch.full {
            let (rows, complete) = read_all(&db_path)?;
            let mut g = self.inner.lock();
            if g.generation == generation && g.bound.is_some() {
                install_all(&mut g, rows, complete);
            }
            return Ok(());
        }
        let found = read_paths(&db_path, &batch.paths)?;
        let mut g = self.inner.lock();
        if g.generation != generation || g.bound.is_none() {
            return Ok(());
        }
        if g.version != version {
            // Something else changed the mirror while we read; reload on the
            // next search rather than guess the merge.
            g.loaded = false;
            return Ok(());
        }
        let mut found: HashMap<String, (i64, Option<String>)> = found
            .into_iter()
            .map(|r| (r.path, (r.mtime_ms, r.title)))
            .collect();
        for path in &batch.paths {
            match found.remove(path) {
                Some((mtime_ms, title)) => upsert(
                    &mut g,
                    NameRow {
                        path: path.clone(),
                        mtime_ms,
                        title,
                    },
                ),
                None => remove(&mut g, path),
            }
        }
        g.version += 1;
        Ok(())
    }

    /// Load or refresh the mirror if it is missing or (during the cold build)
    /// older than [`PARTIAL_RELOAD_INTERVAL`]. Returns whether the build is
    /// still running.
    pub fn sync(&self) -> Result<bool, IndexError> {
        for _ in 0..MAX_LOAD_ATTEMPTS {
            let (generation, db_path, version) = {
                let mut g = self.inner.lock();
                let Some(b) = g.bound.as_ref() else {
                    return Err(IndexError::Invalid("workspace index is not open".into()));
                };
                let stale_partial = !g.complete
                    && g.last_partial
                        .is_none_or(|t| t.elapsed() >= PARTIAL_RELOAD_INTERVAL);
                if g.loaded && !stale_partial {
                    return Ok(!g.complete);
                }
                let args = (g.generation, b.db_path.clone(), g.version);
                g.last_partial = Some(Instant::now());
                args
            };
            let (rows, complete) = read_all(&db_path)?;
            let mut g = self.inner.lock();
            if g.generation == generation && g.version == version && g.bound.is_some() {
                install_all(&mut g, rows, complete);
                return Ok(!g.complete);
            }
        }
        Err(IndexError::Internal(
            "file list kept changing while loading; retry".into(),
        ))
    }

    /// Fuzzy name/path search. See [`rank`] for the ordering.
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        filter: &NameFilter,
    ) -> Result<NameSearch, IndexError> {
        self.search_with(query, limit, filter, &RankContext::default())
    }

    /// [`Self::search`] with recency. An empty query lists files by recency
    /// (recently opened first, then recently modified) instead of nothing.
    pub fn search_with(
        &self,
        query: &str,
        limit: usize,
        filter: &NameFilter,
        ctx: &RankContext,
    ) -> Result<NameSearch, IndexError> {
        let building = self.sync()?;
        let g = self.inner.lock();
        let root = g
            .bound
            .as_ref()
            .map(|b| b.root.clone())
            .ok_or_else(|| IndexError::Invalid("workspace index is not open".into()))?;
        let matches = rank(g.entries.iter(), query, limit, filter, ctx);
        Ok(NameSearch {
            root,
            matches,
            building,
        })
    }

    /// Absolute paths of listed files, newest modification first, ties by path.
    pub fn recent(&self, offset: usize, limit: usize) -> Result<Vec<PathBuf>, IndexError> {
        self.sync()?;
        let g = self.inner.lock();
        let root = g
            .bound
            .as_ref()
            .map(|b| b.root.clone())
            .ok_or_else(|| IndexError::Invalid("workspace index is not open".into()))?;
        let mut all: Vec<(&String, &NameEntry)> = g.entries.iter().collect();
        all.sort_by(|(pa, a), (pb, b)| b.mtime_ms.cmp(&a.mtime_ms).then_with(|| pa.cmp(pb)));
        Ok(all
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(path, _)| root.join(path))
            .collect())
    }

    /// Bring one file's modification time forward right after Writer saved it,
    /// so recents order is right before the watcher feed re-reads the row
    /// (which then overwrites this with the stored value). Unknown paths are
    /// left to the feed.
    pub fn touch(&self, abs_path: &Path, mtime_secs: u64) {
        let mut g = self.inner.lock();
        let Some(b) = g.bound.as_ref() else {
            return;
        };
        let Some(rel) = abs_path
            .strip_prefix(&b.root)
            .ok()
            .and_then(crate::index::paths::rel_to_string)
        else {
            return;
        };
        let mtime_ms = (mtime_secs as i64).saturating_mul(1000);
        if let Some(e) = g.entries.get_mut(&rel) {
            if e.mtime_ms != mtime_ms {
                e.mtime_ms = mtime_ms;
                g.version += 1;
            }
        }
    }
}

fn ancestors(path: &str) -> impl Iterator<Item = &str> {
    // "a/b/c.md" -> "a/b", "a", ""
    let mut next = path.rfind('/').map(|i| &path[..i]);
    let mut done = false;
    std::iter::from_fn(move || {
        if done {
            return None;
        }
        match next {
            Some(dir) => {
                next = dir.rfind('/').map(|i| &dir[..i]);
                if next.is_none() {
                    // After `dir` comes the root.
                    next = Some("");
                    if dir.is_empty() {
                        done = true;
                    }
                }
                Some(dir)
            }
            None => {
                done = true;
                Some("")
            }
        }
    })
}

fn upsert(g: &mut Inner, row: NameRow) {
    let is_new = !g.entries.contains_key(&row.path);
    if is_new {
        for dir in ancestors(&row.path) {
            *g.folders.entry(dir.to_string()).or_insert(0) += 1;
        }
    }
    g.entries.insert(
        row.path.clone(),
        NameEntry::new(&row.path, row.mtime_ms, row.title),
    );
}

fn remove(g: &mut Inner, path: &str) {
    if g.entries.remove(path).is_none() {
        return;
    }
    for dir in ancestors(path) {
        if let Some(n) = g.folders.get_mut(dir) {
            *n -= 1;
            if *n == 0 {
                g.folders.remove(dir);
            }
        }
    }
}

fn install_all(g: &mut Inner, rows: Vec<NameRow>, complete: bool) {
    g.entries.clear();
    g.folders.clear();
    for row in rows {
        upsert(g, row);
    }
    g.loaded = true;
    g.complete = complete;
    g.version += 1;
}

/// Rank `entries` for `query` with the fuzzy matcher and recency boost of
/// `rank.rs` (formula: `SPECs/search-ranking-spec.md`). Higher scores first;
/// equal scores keep path order, which makes results deterministic. An empty
/// query lists by recency: opened files newest first, then newest modified.
fn rank<'a>(
    entries: impl Iterator<Item = (&'a String, &'a NameEntry)>,
    query: &str,
    limit: usize,
    filter: &NameFilter,
    ctx: &RankContext,
) -> Vec<NameMatch> {
    if limit == 0 {
        return Vec::new();
    }
    let folder_prefix = filter
        .folder
        .as_deref()
        .map(|f| f.trim_matches('/'))
        .filter(|f| !f.is_empty())
        .map(|f| format!("{}/", f.to_lowercase()));
    let q = PreparedQuery::new(query);
    let recency_of = |path: &str, entry: &NameEntry| Recency {
        opened_ms: ctx.opened.get(path).copied(),
        mtime_ms: entry.mtime_ms,
    };

    struct Hit<'a> {
        score: f64,
        /// Empty-query sort key: (opened, modified).
        key: (i64, i64),
        path: &'a str,
        folded: Vec<usize>,
        title: Option<&'a str>,
    }
    let mut hits: Vec<Hit> = Vec::new();
    for (path, entry) in entries {
        if let Some(prefix) = &folder_prefix {
            if !entry.lower.starts_with(prefix.as_str()) {
                continue;
            }
        }
        if let Some(exts) = &filter.exts {
            let ext = entry.lower[entry.name_start..]
                .rsplit_once('.')
                .map(|(_, e)| e)
                .unwrap_or("");
            if !exts.iter().any(|e| e == ext) {
                continue;
            }
        }
        if q.is_empty() {
            hits.push(Hit {
                score: 0.0,
                key: empty_query_key(recency_of(path, entry)),
                path,
                folded: Vec::new(),
                title: entry.title.as_ref().map(|(t, _)| t.as_str()),
            });
            continue;
        }
        // The file name/path and the title override both match; the better one scores.
        let Some(m) =
            match_name_or_title(&q, &entry.prepared, entry.title.as_ref().map(|(_, p)| p))
        else {
            continue;
        };
        let boost = if ctx.recency {
            recency_boost(ctx.now_ms, recency_of(path, entry))
        } else {
            0.0
        };
        hits.push(Hit {
            score: combine(m.score, boost),
            key: (0, 0),
            path,
            folded: m.folded,
            title: entry.title.as_ref().map(|(t, _)| t.as_str()),
        });
    }
    // Entries arrive in path order and the sort is stable: ties stay in path order.
    if q.is_empty() {
        hits.sort_by_key(|h| std::cmp::Reverse(h.key));
    } else {
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    }
    hits.truncate(limit);
    hits.into_iter()
        .map(|h| NameMatch {
            path: h.path.to_string(),
            name: h.path[h.path.rfind('/').map(|i| i + 1).unwrap_or(0)..].to_string(),
            score: if q.is_empty() {
                0
            } else {
                (h.score * 10.0).round().clamp(0.0, u32::MAX as f64) as u32
            },
            match_indices: original_indices(h.path, &h.folded),
            title: h.title.map(str::to_string),
        })
        .collect()
}

/// `WHERE` predicate for the listed rows: notes, bases and the code/text files of
/// `code_files` (by extension, plus `Dockerfile`/`Makefile` by name).
fn listed_sql() -> String {
    crate::code_files::listed_sql_predicate()
}

/// The `title` frontmatter property (text) of a `files` row; headings never count.
const TITLE_SQL: &str = "(SELECT p.v_text FROM props p WHERE p.file_id = files.id \
     AND p.key = 'title' AND p.vtype = 'text')";

/// Every listed row plus whether the build that produced them finished, read in
/// one snapshot.
fn read_all(db_path: &Path) -> Result<(Vec<NameRow>, bool), IndexError> {
    let conn = schema::open_reader(db_path)?;
    let tx = conn.unchecked_transaction()?;
    let complete = built(&tx)?;
    let mut st = tx.prepare(&format!(
        "SELECT path, mtime, {TITLE_SQL} FROM files WHERE {}",
        listed_sql()
    ))?;
    let rows = st
        .query_map([], |r| {
            Ok(NameRow {
                path: r.get(0)?,
                mtime_ms: r.get(1)?,
                title: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(st);
    drop(tx);
    Ok((keep_listed(rows), complete))
}

fn built(conn: &Connection) -> Result<bool, IndexError> {
    Ok(conn
        .query_row("SELECT 1 FROM meta WHERE key = 'built_at'", [], |_| Ok(()))
        .optional()?
        .is_some())
}

/// The listed rows among `paths` (unlisted and missing paths yield nothing).
fn read_paths(db_path: &Path, paths: &[String]) -> Result<Vec<NameRow>, IndexError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let conn = schema::open_reader(db_path)?;
    let mut out = Vec::new();
    for chunk in paths.chunks(PATH_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut st = conn.prepare(&format!(
            "SELECT path, mtime, {TITLE_SQL} FROM files WHERE {} AND path IN ({marks})",
            listed_sql()
        ))?;
        let rows = st.query_map(params_from_iter(chunk.iter()), |r| {
            Ok(NameRow {
                path: r.get(0)?,
                mtime_ms: r.get(1)?,
                title: r.get(2)?,
            })
        })?;
        for r in rows {
            out.push(r?);
        }
    }
    Ok(keep_listed(out))
}

/// The SQL predicate selects by extension; secret-looking names (`.env`, `secrets.yaml`) are
/// dropped here, where the full name rule lives.
fn keep_listed(rows: Vec<NameRow>) -> Vec<NameRow> {
    rows.into_iter()
        .filter(|r| crate::code_files::is_listed_name(r.path.rsplit('/').next().unwrap_or(&r.path)))
        .collect()
}

impl Index {
    /// The cold build finished (or a previous run's finished build is on disk).
    pub fn is_ready(&self) -> bool {
        self.shared.status.lock().ready
    }

    /// The error that failed the last scan or update, if any.
    pub fn last_error(&self) -> Option<String> {
        self.shared.status.lock().last_error.clone()
    }

    /// Vault-relative paths of every file (any type) whose name equals `name`
    /// case-insensitively, shallowest first, ties by path ("shortest path",
    /// like Obsidian). Optionally restricted to the folder `under`.
    pub fn find_files_by_name(
        &self,
        name: &str,
        under: Option<&str>,
    ) -> Result<Vec<String>, IndexError> {
        let under = under.map(|u| u.trim_matches('/')).filter(|u| !u.is_empty());
        let mut rows: Vec<String> = self.read(|c| {
            let mut st = c.prepare("SELECT path FROM files WHERE name = ?1 COLLATE NOCASE")?;
            let rows = st
                .query_map([name], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        if let Some(under) = under {
            let prefix = format!("{under}/");
            rows.retain(|p| p.starts_with(&prefix));
        }
        rows.sort_by(|a, b| {
            a.matches('/')
                .count()
                .cmp(&b.matches('/').count())
                .then_with(|| a.cmp(b))
        });
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::OpenParams;
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn entries(paths: &[&str]) -> BTreeMap<String, NameEntry> {
        paths
            .iter()
            .map(|p| (p.to_string(), NameEntry::new(p, 0, None)))
            .collect()
    }

    fn top(paths: &[&str], query: &str) -> Vec<String> {
        let map = entries(paths);
        rank(
            map.iter(),
            query,
            50,
            &NameFilter::default(),
            &RankContext::default(),
        )
        .into_iter()
        .map(|m| m.path)
        .collect()
    }

    #[test]
    fn filename_match_beats_folder_match() {
        let got = top(
            &["notes/alpha/readme.md", "alpha.md", "z/alpha-beta/x.md"],
            "alpha",
        );
        // Both folder matches rank below the file-name match; the earlier one wins.
        assert_eq!(
            got,
            ["alpha.md", "z/alpha-beta/x.md", "notes/alpha/readme.md"]
        );
    }

    #[test]
    fn name_prefix_beats_inner_word_and_exact_name_wins() {
        let got = top(&["my-plan.md", "plan.md", "deep/plan-b.md"], "plan");
        assert_eq!(got, ["plan.md", "deep/plan-b.md", "my-plan.md"]);
    }

    #[test]
    fn fuzzy_boundary_camel_case_and_typos() {
        // Short words are substrings, longer ones subsequences and typos.
        assert!(top(&["WikiLink.md"], "wl").is_empty());
        assert_eq!(
            top(&["WikiLink.md", "unrelated.md"], "wlnk"),
            ["WikiLink.md"]
        );
        assert_eq!(
            top(&["People/François Lamarre.md", "x.md"], "Francios Lamare"),
            ["People/François Lamarre.md"]
        );
        assert_eq!(top(&["Wiki Link.md"], "wiki-link"), ["Wiki Link.md"]);
        assert_eq!(top(&["wiki-link.md"], "wiki link"), ["wiki-link.md"]);
    }

    #[test]
    fn recency_reorders_equal_matches_and_empty_query_lists_by_recency() {
        const NOW: i64 = 1_800_000_000_000;
        const DAY: i64 = 86_400_000;
        let mut map = entries(&["a/budget.md", "b/budget.md", "c/other.md"]);
        map.get_mut("a/budget.md").unwrap().mtime_ms = NOW - 300 * DAY;
        map.get_mut("b/budget.md").unwrap().mtime_ms = NOW - 300 * DAY;
        map.get_mut("c/other.md").unwrap().mtime_ms = NOW - DAY;
        let mut ctx = RankContext {
            now_ms: NOW,
            opened: OpenedMap::new(),
            recency: true,
        };
        ctx.opened.insert("b/budget.md".into(), NOW - 1000);
        let paths = |q: &str, ctx: &RankContext| -> Vec<String> {
            rank(map.iter(), q, 9, &NameFilter::default(), ctx)
                .into_iter()
                .map(|m| m.path)
                .collect()
        };
        assert_eq!(paths("budget", &ctx), ["b/budget.md", "a/budget.md"]);
        // Opened files first, then newest modified.
        assert_eq!(
            paths("", &ctx),
            ["b/budget.md", "c/other.md", "a/budget.md"]
        );
        // Off: path order.
        ctx.recency = false;
        assert_eq!(paths("budget", &ctx), ["a/budget.md", "b/budget.md"]);
    }

    #[test]
    fn path_segments_match_across_the_separator() {
        let got = top(&["projects/alpha/notes.md", "alpha.md"], "projects/alpha");
        assert_eq!(got, ["projects/alpha/notes.md"]);
    }

    #[test]
    fn query_is_case_insensitive_and_reports_char_indices() {
        let map = entries(&["Notes/Résumé.md"]);
        let m = rank(
            map.iter(),
            "RÉSUMÉ",
            50,
            &NameFilter::default(),
            &RankContext::default(),
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "Résumé.md");
        // "Notes/" is 6 chars.
        assert_eq!(m[0].match_indices, [6, 7, 8, 9, 10, 11]);
    }

    #[test]
    fn ties_keep_path_order_and_limit_applies() {
        let got = top(&["b/x.md", "a/x.md", "c/x.md"], "x.md");
        assert_eq!(got, ["a/x.md", "b/x.md", "c/x.md"]);
        let map = entries(&["b/x.md", "a/x.md", "c/x.md"]);
        assert_eq!(
            rank(
                map.iter(),
                "x",
                2,
                &NameFilter::default(),
                &RankContext::default()
            )
            .len(),
            2
        );
        assert!(
            rank(
                map.iter(),
                "",
                5,
                &NameFilter::default(),
                &RankContext::default()
            )
            .len()
                == 3
        );
    }

    #[test]
    fn folder_and_extension_filters() {
        let map = entries(&[
            "a/one.md",
            "a/b/two.md",
            "a/tasks.base",
            "ab/three.md",
            "one.md",
        ]);
        let folder = NameFilter {
            folder: Some("a".into()),
            exts: None,
        };
        let got: Vec<_> = rank(map.iter(), ".", 50, &folder, &RankContext::default())
            .into_iter()
            .map(|m| m.path)
            .collect();
        assert_eq!(got.len(), 3, "{got:?}");
        assert!(!got.iter().any(|p| p.starts_with("ab/") || p == "one.md"));

        let base_only = NameFilter {
            folder: None,
            exts: Some(vec!["base".into()]),
        };
        let got: Vec<_> = rank(map.iter(), "tasks", 50, &base_only, &RankContext::default())
            .into_iter()
            .map(|m| m.path)
            .collect();
        assert_eq!(got, ["a/tasks.base"]);
        let none = NameFilter {
            folder: None,
            exts: Some(vec!["base".into()]),
        };
        assert!(rank(map.iter(), "one", 50, &none, &RankContext::default()).is_empty());
    }

    #[test]
    fn ancestors_list_every_folder_up_to_the_root() {
        assert_eq!(ancestors("a/b/c.md").collect::<Vec<_>>(), ["a/b", "a", ""]);
        assert_eq!(ancestors("a/c.md").collect::<Vec<_>>(), ["a", ""]);
        assert_eq!(ancestors("c.md").collect::<Vec<_>>(), [""]);
    }

    struct Harness {
        vault: TempDir,
        _data: TempDir,
        index: Index,
        cache: Arc<NameCache>,
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// An index over a temp vault whose change feed drives a `NameCache`
    /// exactly the way `commands/index.rs` wires it.
    fn harness(seed: impl FnOnce(&Path)) -> Harness {
        let vault = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        seed(vault.path());
        let cache = Arc::new(NameCache::default());
        let generation = cache.reset();
        let feed = Arc::clone(&cache);
        let index = Index::open(OpenParams {
            root: vault.path().to_path_buf(),
            app_data_dir: data.path().to_path_buf(),
            cancel: Arc::new(AtomicBool::new(false)),
            on_change: Some(Arc::new(move |b| feed.apply(generation, &b).unwrap())),
        })
        .unwrap();
        cache.bind(
            generation,
            index.root().to_path_buf(),
            index.db_path().to_path_buf(),
        );
        Harness {
            vault,
            _data: data,
            index,
            cache,
        }
    }

    fn names(h: &Harness, q: &str) -> Vec<String> {
        h.cache
            .search(q, 50, &NameFilter::default())
            .unwrap()
            .matches
            .into_iter()
            .map(|m| m.path)
            .collect()
    }

    #[test]
    fn serves_only_listed_kinds_from_the_database() {
        let h = harness(|r| {
            write(r, "readme.md", "# Readme");
            write(r, "tasks.base", "views: []\n");
            write(r, "data.json", "{}");
            write(r, "run.py", "print(1)");
            write(r, "Dockerfile", "FROM x");
            write(r, "blob.bin", "x");
            write(r, "pic.png", "x");
            write(r, ".env", "TOKEN=1");
            write(r, "secrets.yaml", "a: 1");
            write(r, ".hidden/secret.md", "x");
            write(r, "node_modules/dep/readme.md", "x");
        });
        h.index.refresh_blocking().unwrap();
        assert_eq!(names(&h, "readme"), ["readme.md"]);
        assert_eq!(names(&h, "tasks"), ["tasks.base"]);
        // code files are listed with their extension; unknown kinds, dotfiles and secrets are not
        assert_eq!(names(&h, "data"), ["data.json"]);
        assert_eq!(names(&h, "run.py"), ["run.py"]);
        assert_eq!(names(&h, "Dockerfile"), ["Dockerfile"]);
        assert!(names(&h, "blob").is_empty());
        assert!(names(&h, "pic").is_empty());
        assert!(names(&h, "env").is_empty());
        assert!(names(&h, "secret").is_empty());
        let s = h.cache.search("readme", 5, &NameFilter::default()).unwrap();
        assert!(!s.building);
        assert!(h.cache.is_ready());
        assert_eq!(h.cache.len(), 5);
    }

    #[test]
    fn quick_open_matches_the_title_override_and_the_file_name_never_the_heading() {
        let h = harness(|r| {
            write(
                r,
                "Spec.md",
                "---\ntitle: Quarterly Plan\n---\n# Roadmap Heading\n",
            );
            write(r, "Plain.md", "# Other Heading\n");
        });
        h.index.refresh_blocking().unwrap();
        // file name and title both find the note; a heading does not
        assert_eq!(names(&h, "spec"), ["Spec.md"]);
        assert_eq!(names(&h, "quarterly"), ["Spec.md"]);
        assert!(names(&h, "roadmap").is_empty());
        assert!(names(&h, "other heading").is_empty());
        let m = h
            .cache
            .search("quarterly", 5, &NameFilter::default())
            .unwrap();
        assert_eq!(m.matches[0].title.as_deref(), Some("Quarterly Plan"));
        assert!(m.matches[0].match_indices.is_empty());
        let m = h.cache.search("spec", 5, &NameFilter::default()).unwrap();
        assert_eq!(m.matches[0].title.as_deref(), Some("Quarterly Plan"));
        assert!(!m.matches[0].match_indices.is_empty());
        // plain notes carry no title
        let m = h.cache.search("plain", 5, &NameFilter::default()).unwrap();
        assert_eq!(m.matches[0].title, None);

        // editing the property flows through the change feed
        write(
            h.index.root(),
            "Spec.md",
            "---\ntitle: Annual Review\n---\nx\n",
        );
        h.index
            .index_paths_blocking(vec![h.index.root().join("Spec.md")])
            .unwrap();
        assert!(names(&h, "quarterly").is_empty());
        assert_eq!(names(&h, "annual"), ["Spec.md"]);
        write(h.index.root(), "Spec.md", "x\n");
        h.index
            .index_paths_blocking(vec![h.index.root().join("Spec.md")])
            .unwrap();
        assert!(names(&h, "annual").is_empty());
    }

    #[test]
    fn create_rename_and_delete_show_up_through_the_change_feed() {
        let h = harness(|r| write(r, "old.md", "# Old"));
        h.index.refresh_blocking().unwrap();
        assert_eq!(names(&h, "old"), ["old.md"]);

        // Create.
        write(h.index.root(), "docs/fresh.md", "# Fresh");
        let abs = h.index.root().join("docs/fresh.md");
        h.index.index_paths_blocking(vec![abs.clone()]).unwrap();
        assert_eq!(names(&h, "fresh"), ["docs/fresh.md"]);
        assert_eq!(
            h.cache
                .dir_has_listed(&h.index.root().canonicalize().unwrap().join("docs")),
            Some(true)
        );

        // Rename: both sides arrive in one batch.
        let renamed = h.index.root().join("docs/renamed.md");
        fs::rename(&abs, &renamed).unwrap();
        h.index
            .index_paths_blocking(vec![abs.clone(), renamed])
            .unwrap();
        assert!(names(&h, "fresh").is_empty());
        assert_eq!(names(&h, "renamed"), ["docs/renamed.md"]);

        // Delete, including the folder bookkeeping.
        fs::remove_dir_all(h.index.root().join("docs")).unwrap();
        h.index
            .index_paths_blocking(vec![h.index.root().join("docs")])
            .unwrap();
        assert!(names(&h, "renamed").is_empty());
        assert_eq!(
            h.cache
                .dir_has_listed(&h.index.root().canonicalize().unwrap().join("docs")),
            Some(false)
        );
        assert_eq!(names(&h, "old"), ["old.md"]);
    }

    #[test]
    fn a_folder_moved_into_place_is_discovered_by_its_directory_path() {
        let h = harness(|r| write(r, "a.md", "# a"));
        h.index.refresh_blocking().unwrap();
        write(h.index.root(), "moved/deep/b.md", "# b");
        write(h.index.root(), "moved/c.md", "# c");
        h.index
            .index_paths_blocking(vec![h.index.root().join("moved")])
            .unwrap();
        assert_eq!(names(&h, "b.md"), ["moved/deep/b.md"]);
        assert_eq!(names(&h, "c.md"), ["moved/c.md"]);
    }

    #[test]
    fn partial_rows_are_served_with_the_building_flag_until_the_scan_finishes() {
        let h = harness(|r| write(r, "a.md", "# a"));
        // Cold database, scan not run: nothing built yet.
        let s = h.cache.search("a", 5, &NameFilter::default()).unwrap();
        assert!(s.building);
        assert!(s.matches.is_empty());
        assert!(!h.cache.is_ready());
        assert_eq!(h.cache.dir_has_listed(h.index.root()), None);

        h.index.refresh_blocking().unwrap();
        let s = h.cache.search("a", 5, &NameFilter::default()).unwrap();
        assert!(!s.building);
        assert_eq!(s.matches.len(), 1);
    }

    #[test]
    fn warm_database_is_ready_without_a_new_scan() {
        let vault = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        write(vault.path(), "n.md", "# n");
        let params = |cb| OpenParams {
            root: vault.path().to_path_buf(),
            app_data_dir: data.path().to_path_buf(),
            cancel: Arc::new(AtomicBool::new(false)),
            on_change: cb,
        };
        let first = Index::open(params(None)).unwrap();
        first.refresh_blocking().unwrap();
        first.close();

        let second = Index::open(params(None)).unwrap();
        let cache = NameCache::default();
        let generation = cache.reset();
        cache.bind(
            generation,
            second.root().to_path_buf(),
            second.db_path().to_path_buf(),
        );
        let s = cache.search("n", 5, &NameFilter::default()).unwrap();
        assert!(!s.building, "a finished build on disk is complete");
        assert_eq!(s.matches.len(), 1);
    }

    #[test]
    fn stale_generations_and_resets_are_ignored() {
        let h = harness(|r| write(r, "a.md", "# a"));
        h.index.refresh_blocking().unwrap();
        assert_eq!(names(&h, "a"), ["a.md"]);
        let old = h.cache.reset();
        assert!(h.cache.search("a", 5, &NameFilter::default()).is_err());
        write(h.index.root(), "late.md", "x");
        h.cache
            .apply(
                old,
                &ChangeBatch {
                    paths: vec!["late.md".into()],
                    full: false,
                },
            )
            .unwrap();
        assert!(h.cache.is_empty());
    }

    #[test]
    fn recent_orders_by_mtime_then_path_and_touch_reorders() {
        let h = harness(|r| {
            write(r, "old.md", "o");
            write(r, "new.md", "n");
            write(r, "mid.md", "m");
        });
        h.index.refresh_blocking().unwrap();
        let t = |name: &str, secs: u64| {
            filetime_set(&h.index.root().join(name), secs);
        };
        t("old.md", 1_000_000);
        t("mid.md", 2_000_000);
        t("new.md", 3_000_000);
        h.index.refresh_blocking().unwrap();
        // The scan's full-vs-paths notification only re-reads changed rows, so
        // push the rows through the feed explicitly.
        let generation = h.cache.inner.lock().generation;
        h.cache
            .apply(
                generation,
                &ChangeBatch {
                    paths: vec![],
                    full: true,
                },
            )
            .unwrap();
        let root = h.index.root().to_path_buf();
        let order = |off, lim| -> Vec<String> {
            h.cache
                .recent(off, lim)
                .unwrap()
                .into_iter()
                .map(|p| {
                    p.strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect()
        };
        assert_eq!(order(0, 2), ["new.md", "mid.md"]);
        assert_eq!(order(2, 5), ["old.md"]);
        h.cache.touch(&root.join("old.md"), 9_000_000);
        assert_eq!(order(0, 1), ["old.md"]);
        // Unknown paths are ignored.
        h.cache.touch(&root.join("ghost.md"), 99_999);
        assert_eq!(h.cache.len(), 3);
    }

    #[test]
    fn find_files_by_name_is_case_insensitive_shallowest_first() {
        let h = harness(|r| {
            write(r, "a/b/Pic.PNG", "x");
            write(r, "pic.png", "x");
            write(r, "z/pic.png", "x");
            write(r, "other.md", "x");
        });
        h.index.refresh_blocking().unwrap();
        assert!(h.index.is_ready());
        assert_eq!(
            h.index.find_files_by_name("PIC.png", None).unwrap(),
            ["pic.png", "z/pic.png", "a/b/Pic.PNG"]
        );
        assert_eq!(
            h.index.find_files_by_name("pic.png", Some("a")).unwrap(),
            ["a/b/Pic.PNG"]
        );
        assert!(h
            .index
            .find_files_by_name("nope.png", None)
            .unwrap()
            .is_empty());
    }

    /// Synthetic 10k-note vault timings. Run with
    /// `cargo test --release names::tests::perf_10k -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_10k() {
        use std::time::Instant;
        let vault = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        for i in 0..10_000 {
            let rel = format!(
                "area-{}/project-{}/note {} planning meeting.md",
                i % 20,
                i % 200,
                i
            );
            write(vault.path(), &rel, &format!("# Note {i}\nbody text {i}\n"));
        }
        let cache = Arc::new(NameCache::default());
        let generation = cache.reset();
        let feed = Arc::clone(&cache);
        let t = Instant::now();
        let index = Index::open(OpenParams {
            root: vault.path().to_path_buf(),
            app_data_dir: data.path().to_path_buf(),
            cancel: Arc::new(AtomicBool::new(false)),
            on_change: Some(Arc::new(move |b| feed.apply(generation, &b).unwrap())),
        })
        .unwrap();
        cache.bind(
            generation,
            index.root().to_path_buf(),
            index.db_path().to_path_buf(),
        );
        index.refresh_blocking().unwrap();
        let t_cold = t.elapsed();
        let t = Instant::now();
        let first = cache
            .search("planning", 20, &NameFilter::default())
            .unwrap();
        let t_first = t.elapsed();
        assert_eq!(first.matches.len(), 20);

        // Per keystroke: every prefix of a typed query.
        let typed = "project-17 note 1234";
        let mut worst = Duration::ZERO;
        let mut total = Duration::ZERO;
        let mut n = 0u32;
        for _ in 0..50 {
            for end in 1..=typed.len() {
                let t = Instant::now();
                let _ = cache
                    .search(&typed[..end], 20, &NameFilter::default())
                    .unwrap();
                let d = t.elapsed();
                worst = worst.max(d);
                total += d;
                n += 1;
            }
        }
        index.close();

        // Warm start: database already built.
        let t = Instant::now();
        let index2 = Index::open(OpenParams {
            root: vault.path().to_path_buf(),
            app_data_dir: data.path().to_path_buf(),
            cancel: Arc::new(AtomicBool::new(false)),
            on_change: None,
        })
        .unwrap();
        let c2 = NameCache::default();
        let g2 = c2.reset();
        c2.bind(
            g2,
            index2.root().to_path_buf(),
            index2.db_path().to_path_buf(),
        );
        let r = c2.search("planning", 20, &NameFilter::default()).unwrap();
        let t_warm = t.elapsed();
        assert!(!r.building);

        // Incremental update: one created note reaches search.
        let g = cache.inner.lock();
        let bytes: usize = g
            .entries
            .iter()
            .map(|(k, e)| {
                k.capacity() + e.lower.capacity() + std::mem::size_of::<(String, NameEntry)>()
            })
            .sum::<usize>()
            + g.folders
                .iter()
                .map(|(k, _)| k.capacity() + 32)
                .sum::<usize>();
        drop(g);
        println!(
            "PERF cold build+feed {:?}; first search after build {:?}; warm open->first result {:?}; per keystroke avg {:?} worst {:?} over {} searches; mirror ~{} KiB",
            t_cold,
            t_first,
            t_warm,
            total / n,
            worst,
            n,
            bytes / 1024
        );
    }

    fn filetime_set(path: &Path, secs: u64) {
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }
}
