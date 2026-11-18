//! `.writer/graph.json`: the graph view's per-vault settings (color groups, filters, forces). The
//! web half owns the shape; here it is opaque JSON under a size cap. Tauri-free: confined to the
//! vault by `property_types::writer_dir` (a symlinked `.writer` is refused), written atomically
//! by `plugins::write_atomic`, and never anywhere near `.obsidian/graph.json`.

use crate::property_types::{writer_dir, PropertyTypeError};
use std::path::Path;

pub const FILE: &str = "graph.json";
/// Larger than any real view config (a few KB); a bigger payload is a bug or an abuse.
pub const MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(String),
}

impl From<PropertyTypeError> for ConfigError {
    fn from(e: PropertyTypeError) -> Self {
        match e {
            PropertyTypeError::Invalid(m) => ConfigError::Invalid(m),
            other => ConfigError::Io(other.to_string()),
        }
    }
}

/// The file's text, or `None` when the vault has none yet. Reads nothing outside the vault.
pub fn read(root: &Path) -> Result<Option<String>, ConfigError> {
    if !root.join(".writer").exists() {
        return Ok(None);
    }
    let dir = writer_dir(root)?;
    let path = dir.join(FILE);
    match std::fs::metadata(&path) {
        Ok(m) if m.len() as usize > MAX_BYTES => Err(ConfigError::Invalid(format!(
            ".writer/{FILE} is larger than {} KB",
            MAX_BYTES / 1024
        ))),
        Ok(_) => std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| ConfigError::Io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ConfigError::Io(e.to_string())),
    }
}

/// The `display` options of a surface and the values the web half accepts for them
/// (`web/config.ts` normalizes whatever a file holds; a write refuses a value it would not keep).
const LABELS: [&str; 3] = ["hover", "zoom", "always"];
const CLUSTER_BY: [&str; 2] = ["communities", "folder"];
const DEPTH: std::ops::RangeInclusive<i64> = 1..=5;
/// Hide the links of notes with more links than this (0 = off) and keep each note's strongest k
/// links (0 = all); `HUB_THRESHOLD_MAX` and `LINKS_PER_NOTE_MAX` mirror `web/config.ts`.
const HUB_THRESHOLD: std::ops::RangeInclusive<i64> = 0..=1000;
const LINKS_PER_NOTE: std::ops::RangeInclusive<i64> = 0..=10;
/// Entries of the Exclude list (folders and name patterns).
const MAX_EXCLUDE: usize = 1000;

fn validate_display(surface: &str, display: &serde_json::Value) -> Result<(), ConfigError> {
    let bad = |what: &str| ConfigError::Invalid(format!("{surface}.display.{what} is not valid"));
    let Some(map) = display.as_object() else {
        return Err(bad("(an object is expected)"));
    };
    let one_of = |key: &str, allowed: &[&str]| match map.get(key) {
        None => Ok(()),
        Some(v) if v.as_str().is_some_and(|s| allowed.contains(&s)) => Ok(()),
        Some(_) => Err(bad(key)),
    };
    one_of("labels", &LABELS)?;
    one_of("clusterBy", &CLUSTER_BY)?;
    let int_in = |key: &str, range: &std::ops::RangeInclusive<i64>| match map.get(key) {
        None => Ok(()),
        Some(v) if v.as_i64().is_some_and(|d| range.contains(&d)) => Ok(()),
        Some(_) => Err(bad(key)),
    };
    int_in("depth", &DEPTH)?;
    int_in("hubThreshold", &HUB_THRESHOLD)?;
    int_in("linksPerNote", &LINKS_PER_NOTE)
}

fn validate_filters(surface: &str, filters: &serde_json::Value) -> Result<(), ConfigError> {
    let bad = || ConfigError::Invalid(format!("{surface}.filters.exclude is not valid"));
    // `excludeFolders` is the name the list had before name patterns joined it.
    for key in ["exclude", "excludeFolders"] {
        match filters.get(key) {
            None => {}
            Some(serde_json::Value::Array(items))
                if items.len() <= MAX_EXCLUDE && items.iter().all(|i| i.is_string()) => {}
            Some(_) => return Err(bad()),
        }
    }
    Ok(())
}

fn validate(config: &serde_json::Value) -> Result<(), ConfigError> {
    let Some(surface) = config.get("global") else {
        return Ok(());
    };
    if let Some(display) = surface.get("display") {
        validate_display("global", display)?;
    }
    match surface.get("filters") {
        Some(filters) => validate_filters("global", filters),
        None => Ok(()),
    }
}

/// Replace the file with `content` (valid JSON, at most [`MAX_BYTES`]).
pub fn write(root: &Path, content: &str) -> Result<(), ConfigError> {
    if content.len() > MAX_BYTES {
        return Err(ConfigError::Invalid(format!(
            "the graph config is larger than {} KB",
            MAX_BYTES / 1024
        )));
    }
    let parsed = serde_json::from_str::<serde_json::Value>(content)
        .map_err(|e| ConfigError::Invalid(format!("the graph config is not valid JSON: {e}")))?;
    validate(&parsed)?;
    let dir = writer_dir(root)?;
    crate::plugins::write_atomic(&dir, FILE, content.as_bytes()).map_err(ConfigError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_reads_as_none_and_a_write_round_trips() {
        let vault = tempfile::tempdir().unwrap();
        assert_eq!(read(vault.path()).unwrap(), None);
        assert!(
            !vault.path().join(".writer").exists(),
            "a read creates nothing"
        );
        write(vault.path(), "{\"groups\":[]}").unwrap();
        assert_eq!(
            read(vault.path()).unwrap().as_deref(),
            Some("{\"groups\":[]}")
        );
        write(vault.path(), "{}").unwrap();
        assert_eq!(read(vault.path()).unwrap().as_deref(), Some("{}"));
        assert!(!vault.path().join(".obsidian").exists());
        let names: Vec<_> = std::fs::read_dir(vault.path().join(".writer"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [FILE], "no temp file is left behind");
    }

    #[test]
    fn bad_payloads_are_refused_and_leave_the_file_alone() {
        let vault = tempfile::tempdir().unwrap();
        write(vault.path(), "{\"a\":1}").unwrap();
        assert!(matches!(
            write(vault.path(), "{nope"),
            Err(ConfigError::Invalid(_))
        ));
        let big = format!("\"{}\"", "x".repeat(MAX_BYTES));
        assert!(matches!(
            write(vault.path(), &big),
            Err(ConfigError::Invalid(_))
        ));
        assert_eq!(read(vault.path()).unwrap().as_deref(), Some("{\"a\":1}"));
        std::fs::write(vault.path().join(".writer").join(FILE), big).unwrap();
        assert!(matches!(read(vault.path()), Err(ConfigError::Invalid(_))));
    }

    #[test]
    fn display_options_are_validated_on_write() {
        let vault = tempfile::tempdir().unwrap();
        let ok = r#"{"global":{"display":{"labels":"hover","clusterBy":"folder","depth":5,"hubThreshold":50,"linksPerNote":3},"filters":{"exclude":["agent__*","Archive"]}}}"#;
        write(vault.path(), ok).unwrap();
        for bad in [
            r#"{"global":{"display":{"labels":"loud"}}}"#,
            r#"{"global":{"display":{"depth":6}}}"#,
            r#"{"global":{"display":{"depth":0}}}"#,
            r#"{"global":{"display":{"depth":"2"}}}"#,
            r#"{"global":{"display":"hover"}}"#,
            r#"{"global":{"display":{"hubThreshold":1001}}}"#,
            r#"{"global":{"display":{"hubThreshold":-1}}}"#,
            r#"{"global":{"display":{"linksPerNote":11}}}"#,
            r#"{"global":{"display":{"linksPerNote":"3"}}}"#,
            r#"{"global":{"filters":{"exclude":"agent__*"}}}"#,
            r#"{"global":{"filters":{"exclude":["a",1]}}}"#,
        ] {
            assert!(
                matches!(write(vault.path(), bad), Err(ConfigError::Invalid(_))),
                "{bad}"
            );
        }
        assert_eq!(read(vault.path()).unwrap().as_deref(), Some(ok));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_writer_folder_is_refused_for_reads_and_writes() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join(FILE), "{\"secret\":true}").unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join(".writer")).unwrap();
        assert!(read(vault.path()).is_err());
        assert!(write(vault.path(), "{}").is_err());
        assert_eq!(
            std::fs::read_to_string(outside.path().join(FILE)).unwrap(),
            "{\"secret\":true}"
        );
    }
}
