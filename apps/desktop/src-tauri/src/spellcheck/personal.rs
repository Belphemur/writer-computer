//! The personal dictionary: `.writer/dictionary.txt` in the vault, one word per line, shared by
//! every provider (a word listed here is never reported as misspelled, in any language) and by
//! every device the vault syncs to (ADR 2026-11-18, point 7).
//!
//! One write path: [`add`] and [`remove`] read the file, change the set and replace the file
//! atomically (`plugins::write_atomic`), confined to the vault by `property_types::writer_dir`
//! (a symlinked `.writer` is refused). Reading creates nothing. The file is plain text a person
//! may edit by hand; blank lines are ignored and order is sorted on write.

use crate::property_types::{writer_dir, PropertyTypeError};
use parking_lot::Mutex;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

pub const FILE: &str = "dictionary.txt";
/// A personal dictionary larger than this is a mistake, not a dictionary.
pub const MAX_BYTES: u64 = 1024 * 1024;
const MAX_WORD_CHARS: usize = 64;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum PersonalError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(String),
}

impl From<PropertyTypeError> for PersonalError {
    fn from(e: PropertyTypeError) -> Self {
        match e {
            PropertyTypeError::Invalid(m) => PersonalError::Invalid(m),
            PropertyTypeError::Io(m) => PersonalError::Io(m),
        }
    }
}

/// The words, as written, and a lowercase set for the case-insensitive lookup.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Personal {
    words: BTreeSet<String>,
    lower: BTreeSet<String>,
}

impl Personal {
    pub fn from_words(words: impl IntoIterator<Item = String>) -> Self {
        let words: BTreeSet<String> = words.into_iter().collect();
        let lower = words.iter().map(|w| w.to_lowercase()).collect();
        Self { words, lower }
    }

    /// Is `word` in the dictionary, whatever its case?
    pub fn contains(&self, word: &str) -> bool {
        self.lower.contains(&word.to_lowercase())
    }

    /// The words, sorted.
    pub fn words(&self) -> Vec<String> {
        self.words.iter().cloned().collect()
    }

    fn parse(text: &str) -> Self {
        Self::from_words(
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string),
        )
    }
}

fn path(root: &Path) -> PathBuf {
    root.join(".writer").join(FILE)
}

/// The vault's personal dictionary; empty when there is no file. Reads nothing outside the vault.
pub fn load(root: &Path) -> Result<Personal, PersonalError> {
    let file = path(root);
    match std::fs::metadata(&file) {
        Ok(m) if m.len() > MAX_BYTES => Err(PersonalError::Invalid(format!(
            ".writer/{FILE} is larger than {} KB",
            MAX_BYTES / 1024
        ))),
        Ok(_) => std::fs::read_to_string(&file)
            .map(|t| Personal::parse(&t))
            .map_err(|e| PersonalError::Io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Personal::default()),
        Err(e) => Err(PersonalError::Io(e.to_string())),
    }
}

/// A word is one token: no whitespace, no control characters, not empty, not absurdly long.
pub fn validate(word: &str) -> Result<String, PersonalError> {
    let word = word.trim();
    if word.is_empty() {
        return Err(PersonalError::Invalid("the word is empty".into()));
    }
    if word.chars().count() > MAX_WORD_CHARS {
        return Err(PersonalError::Invalid(format!(
            "a word is at most {MAX_WORD_CHARS} characters"
        )));
    }
    if word.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(PersonalError::Invalid("a word has no spaces".into()));
    }
    Ok(word.to_string())
}

fn write(root: &Path, words: &BTreeSet<String>) -> Result<(), PersonalError> {
    let dir = writer_dir(root)?;
    let mut body = words.iter().cloned().collect::<Vec<_>>().join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    crate::plugins::write_atomic(&dir, FILE, body.as_bytes()).map_err(PersonalError::Io)
}

/// Adds `word` (a word already there in another case stays as it was). Returns the dictionary.
pub fn add(root: &Path, word: &str) -> Result<Personal, PersonalError> {
    let word = validate(word)?;
    let current = load(root)?;
    if current.contains(&word) {
        return Ok(current);
    }
    let mut words: BTreeSet<String> = current.words.clone();
    words.insert(word);
    write(root, &words)?;
    Ok(Personal::from_words(words))
}

/// Removes `word` in any case. Returns the dictionary.
pub fn remove(root: &Path, word: &str) -> Result<Personal, PersonalError> {
    let current = load(root)?;
    let needle = word.trim().to_lowercase();
    let words: BTreeSet<String> = current
        .words
        .iter()
        .filter(|w| w.to_lowercase() != needle)
        .cloned()
        .collect();
    if words.len() == current.words.len() {
        return Ok(current);
    }
    write(root, &words)?;
    Ok(Personal::from_words(words))
}

/// Re-reads the file only when it changed: the check runs after every pause in typing and the
/// dictionary rarely changes. Keyed by the vault root and the file's modified time and size.
type Stamp = Option<(SystemTime, u64)>;

#[derive(Default)]
pub struct Loader {
    cached: Mutex<Option<(PathBuf, Stamp, Arc<Personal>)>>,
}

impl Loader {
    pub fn get(&self, root: &Path) -> Result<Arc<Personal>, PersonalError> {
        let stamp = std::fs::metadata(path(root))
            .ok()
            .and_then(|m| Some((m.modified().ok()?, m.len())));
        let mut cached = self.cached.lock();
        if let Some((r, s, p)) = cached.as_ref() {
            if r == root && *s == stamp {
                return Ok(p.clone());
            }
        }
        let fresh = Arc::new(load(root)?);
        *cached = Some((root.to_path_buf(), stamp, fresh.clone()));
        Ok(fresh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_empty_and_reading_creates_nothing() {
        let vault = tempfile::tempdir().unwrap();
        assert_eq!(load(vault.path()).unwrap(), Personal::default());
        assert!(!vault.path().join(".writer").exists());
    }

    #[test]
    fn add_writes_one_sorted_word_per_line_and_never_touches_obsidian() {
        let vault = tempfile::tempdir().unwrap();
        add(vault.path(), "Zettelkasten").unwrap();
        let p = add(vault.path(), "  Writer ").unwrap();
        assert_eq!(p.words(), vec!["Writer", "Zettelkasten"]);
        let text = std::fs::read_to_string(vault.path().join(".writer/dictionary.txt")).unwrap();
        assert_eq!(text, "Writer\nZettelkasten\n");
        assert!(!vault.path().join(".obsidian").exists());
        let names: Vec<_> = std::fs::read_dir(vault.path().join(".writer"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [FILE], "no temp file is left behind");
    }

    #[test]
    fn lookup_ignores_case_and_a_repeat_changes_nothing() {
        let vault = tempfile::tempdir().unwrap();
        add(vault.path(), "Obsidian").unwrap();
        let p = add(vault.path(), "OBSIDIAN").unwrap();
        assert_eq!(p.words(), vec!["Obsidian"]);
        assert!(p.contains("obsidian") && p.contains("OBSIDIAN") && !p.contains("obsidians"));
    }

    #[test]
    fn remove_drops_a_word_in_any_case() {
        let vault = tempfile::tempdir().unwrap();
        add(vault.path(), "Alpha").unwrap();
        add(vault.path(), "beta").unwrap();
        let p = remove(vault.path(), "ALPHA").unwrap();
        assert_eq!(p.words(), vec!["beta"]);
        assert_eq!(load(vault.path()).unwrap().words(), vec!["beta"]);
        assert_eq!(
            remove(vault.path(), "nothing").unwrap().words(),
            vec!["beta"]
        );
    }

    #[test]
    fn hand_edits_are_read_blank_lines_and_spaces_around_words_are_ignored() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join(".writer")).unwrap();
        std::fs::write(
            vault.path().join(".writer/dictionary.txt"),
            "\n  one \n\ntwo\r\n",
        )
        .unwrap();
        assert_eq!(load(vault.path()).unwrap().words(), vec!["one", "two"]);
    }

    #[test]
    fn bad_words_are_refused_and_change_nothing() {
        let vault = tempfile::tempdir().unwrap();
        for bad in [
            "",
            "   ",
            "two words",
            "tab\tbed",
            "line\nbreak",
            &"x".repeat(65),
        ] {
            assert!(
                matches!(add(vault.path(), bad), Err(PersonalError::Invalid(_))),
                "{bad:?}"
            );
        }
        assert!(!vault.path().join(".writer").exists());
    }

    #[test]
    fn an_oversized_file_is_refused() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join(".writer")).unwrap();
        std::fs::write(
            vault.path().join(".writer/dictionary.txt"),
            "x".repeat(MAX_BYTES as usize + 1),
        )
        .unwrap();
        assert!(matches!(load(vault.path()), Err(PersonalError::Invalid(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_writer_folder_is_refused() {
        let vault = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), vault.path().join(".writer")).unwrap();
        assert!(matches!(
            add(vault.path(), "word"),
            Err(PersonalError::Invalid(_))
        ));
        assert!(
            std::fs::read_dir(elsewhere.path())
                .unwrap()
                .next()
                .is_none(),
            "nothing written outside"
        );
    }

    #[test]
    fn the_loader_rereads_only_when_the_file_changed() {
        let vault = tempfile::tempdir().unwrap();
        let loader = Loader::default();
        let a = loader.get(vault.path()).unwrap();
        assert!(a.words().is_empty());
        let b = loader.get(vault.path()).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "unchanged: the same copy");
        add(vault.path(), "fresh").unwrap();
        let c = loader.get(vault.path()).unwrap();
        assert_eq!(c.words(), vec!["fresh"]);
    }
}
