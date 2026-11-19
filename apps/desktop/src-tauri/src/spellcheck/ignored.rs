//! "Ignore in this note": the words a person told the checker to stop flagging in one note
//! (ADR 2026-11-18, amendment under More Information; spec `SPECs/spellcheck-spec.md`).
//!
//! Device-local by design, unlike the vault's personal dictionary: the file lives in the app data
//! directory, `spellcheck/ignored-<vault key>.json` (the key is the one that names the vault's
//! index, `index::vault_key`), never in the vault and never near `.obsidian`.
//! `{ "version": 1, "notes": { "<vault-relative path>": ["word", ...] } }`, words case-folded
//! (curly apostrophes straight, like `keep`'s personal-dictionary lookup).
//!
//! One write path ([`modify`]: read, change, atomic replace, under a lock); a size cap
//! ([`MAX_BYTES`]) refuses to grow past a sane file. Reading creates nothing. Words and paths are
//! never logged. The checker applies the store after its cache (`spellcheck::keep`), so ignoring a
//! word never re-runs a provider. Paths follow a move and are dropped with a delete through
//! `vault_events` ([`on_move`], [`on_delete`]).

use crate::index::{cli_app_data_dir, vault_key};
use crate::plugins::write_atomic;
use crate::spellcheck::personal::validate;
use crate::vault_events::moved_key;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

/// An ignored-words file larger than this is a mistake, not a list.
pub const MAX_BYTES: u64 = 1024 * 1024;
const VERSION: u32 = 1;
const MAX_NOTE_PATH_CHARS: usize = 4096;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum IgnoredError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(String),
}

/// The ignored words of every note of one vault, folded.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Ignored {
    notes: BTreeMap<String, BTreeSet<String>>,
}

/// Case folded, curly apostrophes straight: "Don’t" and "don't" are one word.
pub fn fold(word: &str) -> String {
    word.replace(['‘', '’', 'ʼ'], "'").to_lowercase()
}

impl Ignored {
    /// Nothing ignored anywhere (the CLI's `lang=` check, tests).
    pub const fn empty() -> Self {
        Self {
            notes: BTreeMap::new(),
        }
    }

    /// Is `word` ignored in the note at `path`, whatever its case?
    pub fn contains(&self, path: &str, word: &str) -> bool {
        self.notes
            .get(path)
            .is_some_and(|words| words.contains(&fold(word)))
    }

    /// The note's ignored words, sorted.
    pub fn words(&self, path: &str) -> Vec<String> {
        self.notes
            .get(path)
            .map(|w| w.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn parse(text: &str) -> Result<Self, IgnoredError> {
        let doc: File = serde_json::from_str(text)
            .map_err(|e| IgnoredError::Invalid(format!("ignored words are not readable: {e}")))?;
        if doc.version != VERSION {
            return Err(IgnoredError::Invalid(format!(
                "ignored words have version {}, expected {VERSION}",
                doc.version
            )));
        }
        Ok(Self {
            notes: doc
                .notes
                .into_iter()
                .map(|(path, words)| (path, words.iter().map(|w| fold(w)).collect()))
                .filter(|(_, words): &(String, BTreeSet<String>)| !words.is_empty())
                .collect(),
        })
    }

    fn render(&self) -> Result<String, IgnoredError> {
        let doc = File {
            version: VERSION,
            notes: self
                .notes
                .iter()
                .map(|(p, w)| (p.clone(), w.iter().cloned().collect()))
                .collect(),
        };
        serde_json::to_string_pretty(&doc)
            .map(|mut s| {
                s.push('\n');
                s
            })
            .map_err(|e| IgnoredError::Io(e.to_string()))
    }
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    #[serde(default)]
    notes: BTreeMap<String, Vec<String>>,
}

// ---------- Where it lives ----------

static DATA_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Serializes read-modify-write inside this process (the CLI is a second process and still wins
/// or loses on the atomic rename, like any two writers of a file).
static WRITE: Mutex<()> = Mutex::new(());

/// The app's data directory, set by the feature's setup, so the move and delete hooks (which have
/// no Tauri handle) find the store the app writes. Without it (the `writer` CLI) the hooks use
/// the CLI's own resolution of the same directory.
pub fn set_data_dir(dir: PathBuf) {
    *DATA_DIR.lock() = Some(dir);
}

fn data_dir() -> Option<PathBuf> {
    DATA_DIR.lock().clone().or_else(|| cli_app_data_dir().ok())
}

fn dir_of(data_dir: &Path) -> PathBuf {
    data_dir.join("spellcheck")
}

fn file_name(root: &Path) -> String {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    format!("ignored-{}.json", vault_key(&canonical))
}

fn path_of(data_dir: &Path, root: &Path) -> PathBuf {
    dir_of(data_dir).join(file_name(root))
}

/// The vault's ignored words; empty when there is no file. Reads nothing outside the data dir.
pub fn load(data_dir: &Path, root: &Path) -> Result<Ignored, IgnoredError> {
    let file = path_of(data_dir, root);
    match std::fs::metadata(&file) {
        Ok(m) if m.len() > MAX_BYTES => Err(IgnoredError::Invalid(format!(
            "ignored words are larger than {} KB",
            MAX_BYTES / 1024
        ))),
        Ok(_) => Ignored::parse(
            &std::fs::read_to_string(&file).map_err(|e| IgnoredError::Io(e.to_string()))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ignored::default()),
        Err(e) => Err(IgnoredError::Io(e.to_string())),
    }
}

/// The one write path: change the store, replace the file atomically when something changed.
fn modify<T>(
    data_dir: &Path,
    root: &Path,
    edit: impl FnOnce(&mut Ignored) -> Result<(bool, T), IgnoredError>,
) -> Result<T, IgnoredError> {
    let _guard = WRITE.lock();
    let mut store = load(data_dir, root)?;
    let (changed, out) = edit(&mut store)?;
    if changed {
        let body = store.render()?;
        if body.len() as u64 > MAX_BYTES {
            return Err(IgnoredError::Invalid(format!(
                "too many ignored words (the list is at most {} KB)",
                MAX_BYTES / 1024
            )));
        }
        let dir = dir_of(data_dir);
        std::fs::create_dir_all(&dir).map_err(|e| IgnoredError::Io(e.to_string()))?;
        write_atomic(&dir, &file_name(root), body.as_bytes()).map_err(IgnoredError::Io)?;
    }
    Ok(out)
}

fn validate_path(path: &str) -> Result<(), IgnoredError> {
    if path.is_empty() || path.contains('\0') || path.chars().count() > MAX_NOTE_PATH_CHARS {
        return Err(IgnoredError::Invalid("the note path is not valid".into()));
    }
    Ok(())
}

/// Ignores `word` in the note at `path` (vault-relative). Returns the note's words.
pub fn add(
    data_dir: &Path,
    root: &Path,
    path: &str,
    word: &str,
) -> Result<Vec<String>, IgnoredError> {
    validate_path(path)?;
    let word = fold(&validate(word).map_err(|e| IgnoredError::Invalid(e.to_string()))?);
    modify(data_dir, root, |store| {
        let inserted = store
            .notes
            .entry(path.to_string())
            .or_default()
            .insert(word);
        Ok((inserted, store.words(path)))
    })
}

/// Stops ignoring `word` in the note (any case). Returns the note's words.
pub fn remove(
    data_dir: &Path,
    root: &Path,
    path: &str,
    word: &str,
) -> Result<Vec<String>, IgnoredError> {
    let word = fold(word.trim());
    modify(data_dir, root, |store| {
        let Some(words) = store.notes.get_mut(path) else {
            return Ok((false, Vec::new()));
        };
        let removed = words.remove(&word);
        if words.is_empty() {
            store.notes.remove(path);
        }
        Ok((removed, store.words(path)))
    })
}

/// Re-keys the entries at and under `from` to `to` (a moved file or folder).
pub fn move_in(data_dir: &Path, root: &Path, from: &str, to: &str) -> Result<(), IgnoredError> {
    if from == to || !path_of(data_dir, root).exists() {
        return Ok(());
    }
    modify(data_dir, root, |store| {
        let moving: Vec<(String, String)> = store
            .notes
            .keys()
            .filter_map(|k| moved_key(k, from, to).map(|n| (k.clone(), n)))
            .collect();
        let changed = !moving.is_empty();
        for (old, new) in moving {
            if let Some(words) = store.notes.remove(&old) {
                store.notes.entry(new).or_default().extend(words);
            }
        }
        Ok((changed, ()))
    })
}

/// Drops the entries at and under `path` (a deleted file or folder).
pub fn delete_in(data_dir: &Path, root: &Path, path: &str) -> Result<(), IgnoredError> {
    if !path_of(data_dir, root).exists() {
        return Ok(());
    }
    modify(data_dir, root, |store| {
        let before = store.notes.len();
        store
            .notes
            .retain(|k, _| moved_key(k, path, path).is_none());
        Ok((store.notes.len() != before, ()))
    })
}

/// [`move_in`] for the hook (`vault_events`): the store of the app's data directory. Nothing is
/// read or written when the vault has no ignored words.
pub fn on_move(root: &Path, from: &str, to: &str) -> Result<(), IgnoredError> {
    match data_dir() {
        Some(dir) => move_in(&dir, root, from, to),
        None => Ok(()),
    }
}

/// [`delete_in`] for the hook (`vault_events`).
pub fn on_delete(root: &Path, path: &str) -> Result<(), IgnoredError> {
    match data_dir() {
        Some(dir) => delete_in(&dir, root, path),
        None => Ok(()),
    }
}

/// Re-reads the file only when it changed: the check runs after every pause in typing. Keyed by
/// the vault root and the file's modified time and size.
type Stamp = Option<(SystemTime, u64)>;

#[derive(Default)]
pub struct Loader {
    cached: Mutex<Option<(PathBuf, Stamp, Arc<Ignored>)>>,
}

impl Loader {
    pub fn get(&self, data_dir: &Path, root: &Path) -> Result<Arc<Ignored>, IgnoredError> {
        let stamp = std::fs::metadata(path_of(data_dir, root))
            .ok()
            .and_then(|m| Some((m.modified().ok()?, m.len())));
        let mut cached = self.cached.lock();
        if let Some((r, s, p)) = cached.as_ref() {
            if r == root && *s == stamp {
                return Ok(p.clone());
            }
        }
        let fresh = Arc::new(load(data_dir, root)?);
        *cached = Some((root.to_path_buf(), stamp, fresh.clone()));
        Ok(fresh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs() -> (tempfile::TempDir, tempfile::TempDir) {
        (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
    }

    #[test]
    fn reading_creates_nothing_and_a_missing_file_is_empty() {
        let (data, vault) = dirs();
        assert_eq!(load(data.path(), vault.path()).unwrap(), Ignored::default());
        assert!(!data.path().join("spellcheck").exists());
    }

    #[test]
    fn add_and_remove_fold_case_and_apostrophes() {
        let (data, vault) = dirs();
        let w = add(data.path(), vault.path(), "a.md", "  Zettel ").unwrap();
        assert_eq!(w, vec!["zettel"]);
        add(data.path(), vault.path(), "a.md", "Don’t").unwrap();
        let store = load(data.path(), vault.path()).unwrap();
        assert!(store.contains("a.md", "ZETTEL") && store.contains("a.md", "don't"));
        assert_eq!(
            add(data.path(), vault.path(), "a.md", "zettel").unwrap(),
            vec!["don't", "zettel"],
            "a repeat changes nothing"
        );
        let w = remove(data.path(), vault.path(), "a.md", "ZETTEL").unwrap();
        assert_eq!(w, vec!["don't"]);
        remove(data.path(), vault.path(), "a.md", "don’t").unwrap();
        assert_eq!(load(data.path(), vault.path()).unwrap(), Ignored::default());
        assert!(remove(data.path(), vault.path(), "nope.md", "x")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn notes_are_isolated_and_stay_out_of_the_vault() {
        let (data, vault) = dirs();
        add(data.path(), vault.path(), "a.md", "zettel").unwrap();
        let store = load(data.path(), vault.path()).unwrap();
        assert!(store.contains("a.md", "zettel"));
        assert!(!store.contains("b.md", "zettel"));
        assert_eq!(std::fs::read_dir(vault.path()).unwrap().count(), 0);
        let other = tempfile::tempdir().unwrap();
        assert!(!load(data.path(), other.path())
            .unwrap()
            .contains("a.md", "zettel"));
        let names: Vec<_> = std::fs::read_dir(data.path().join("spellcheck"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "no temp file is left behind: {names:?}");
    }

    #[test]
    fn a_moved_file_or_folder_keeps_its_words_and_a_delete_drops_them() {
        let (data, vault) = dirs();
        add(data.path(), vault.path(), "a/x.md", "one").unwrap();
        add(data.path(), vault.path(), "a/sub/y.md", "two").unwrap();
        add(data.path(), vault.path(), "ab.md", "three").unwrap();
        move_in(data.path(), vault.path(), "a", "z").unwrap();
        let s = load(data.path(), vault.path()).unwrap();
        assert!(s.contains("z/x.md", "one") && s.contains("z/sub/y.md", "two"));
        assert!(!s.contains("a/x.md", "one") && s.contains("ab.md", "three"));
        move_in(data.path(), vault.path(), "z/x.md", "q.md").unwrap();
        assert!(load(data.path(), vault.path())
            .unwrap()
            .contains("q.md", "one"));
        delete_in(data.path(), vault.path(), "z").unwrap();
        let s = load(data.path(), vault.path()).unwrap();
        assert!(!s.contains("z/sub/y.md", "two") && s.contains("q.md", "one"));
        delete_in(data.path(), vault.path(), "q.md").unwrap();
        assert!(!load(data.path(), vault.path())
            .unwrap()
            .contains("q.md", "one"));
    }

    #[test]
    fn a_move_or_delete_with_no_store_writes_nothing() {
        let (data, vault) = dirs();
        move_in(data.path(), vault.path(), "a.md", "b.md").unwrap();
        delete_in(data.path(), vault.path(), "a.md").unwrap();
        assert!(!data.path().join("spellcheck").exists());
    }

    #[test]
    fn bad_input_and_a_bad_file_are_refused_and_change_nothing() {
        let (data, vault) = dirs();
        for word in ["", "two words", &"x".repeat(65)] {
            assert!(matches!(
                add(data.path(), vault.path(), "a.md", word),
                Err(IgnoredError::Invalid(_))
            ));
        }
        assert!(add(data.path(), vault.path(), "", "word").is_err());
        assert!(!data.path().join("spellcheck").exists());
        std::fs::create_dir_all(data.path().join("spellcheck")).unwrap();
        let file = path_of(data.path(), vault.path());
        std::fs::write(&file, "not json").unwrap();
        assert!(add(data.path(), vault.path(), "a.md", "word").is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "not json");
        std::fs::write(&file, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert!(matches!(
            load(data.path(), vault.path()),
            Err(IgnoredError::Invalid(_))
        ));
    }

    #[test]
    fn the_loader_follows_the_file() {
        let (data, vault) = dirs();
        let loader = Loader::default();
        assert!(!loader
            .get(data.path(), vault.path())
            .unwrap()
            .contains("a.md", "w"));
        add(data.path(), vault.path(), "a.md", "w").unwrap();
        assert!(loader
            .get(data.path(), vault.path())
            .unwrap()
            .contains("a.md", "w"));
    }
}
