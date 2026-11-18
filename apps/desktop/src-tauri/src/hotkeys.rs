//! `hotkeys.json`: the user's keyboard shortcuts, one file in the app data dir, shared by every
//! vault and window (ADR `2026-11-18-let-users-rebind-every-command-...`, spec
//! `SPECs/hotkeys-spec.md`). The web half owns what the entries mean (`src/lib/keybindings/`);
//! here the shape is checked and the file is written atomically, so a bad file never reaches the
//! registry and a half-written one never exists.
//!
//! ```json
//! { "version": 1, "mac": { "<command id>": ["Mod+Shift+K"] }, "windows": {}, "linux": {} }
//! ```
//!
//! Also read-only: the vault's `.obsidian/hotkeys.json`, for "Import from Obsidian". Nothing is
//! ever written under `.obsidian`. Tauri-free (the commands are in `commands/hotkeys.rs`).

use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub const FILE: &str = "hotkeys.json";
pub const VERSION: u32 = 1;
/// The file is a few KB for a heavy user; a bigger one is a bug or an abuse.
pub const MAX_BYTES: u64 = 256 * 1024;
/// Commands with an entry per platform, chords per command, and the lengths of an id and a chord.
pub const MAX_COMMANDS: usize = 2000;
pub const MAX_CHORDS: usize = 8;
const MAX_ID: usize = 256;
const MAX_CHORD: usize = 64;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum HotkeysError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    version: u32,
    #[serde(default)]
    mac: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    windows: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    linux: BTreeMap<String, Vec<String>>,
}

const MODIFIERS: [&str; 5] = ["Mod", "Meta", "Ctrl", "Alt", "Shift"];

/// The chord grammar of `src/lib/keybindings/chord.ts` (`parseChord`), pinned by
/// `shared/chord-vectors.json` on both sides: modifiers each followed by `+`, then one key (a
/// single character, or a name such as `ArrowLeft` or `F5`).
pub fn is_valid_chord(chord: &str) -> bool {
    if chord.len() > MAX_CHORD {
        return false;
    }
    let mut rest = chord;
    'strip: loop {
        for m in MODIFIERS {
            if let Some(after) = rest
                .strip_prefix(m)
                .and_then(|r| r.strip_prefix('+'))
                .filter(|r| !r.is_empty())
            {
                rest = after;
                continue 'strip;
            }
        }
        break;
    }
    let mut chars = rest.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => !c.is_control(),
        (Some(first), Some(_)) => {
            first.is_ascii_alphabetic() && rest.chars().all(|c| c.is_ascii_alphanumeric())
        }
        _ => false,
    }
}

fn check_section(os: &str, map: &BTreeMap<String, Vec<String>>) -> Result<(), HotkeysError> {
    let bad = |m: String| HotkeysError::Invalid(format!("{os}: {m}"));
    if map.len() > MAX_COMMANDS {
        return Err(bad(format!("more than {MAX_COMMANDS} commands")));
    }
    for (id, chords) in map {
        if id.is_empty() || id.len() > MAX_ID || id.chars().any(char::is_control) {
            return Err(bad("a command id is not valid".into()));
        }
        if chords.len() > MAX_CHORDS {
            return Err(bad(format!("{id} has more than {MAX_CHORDS} keys")));
        }
        if let Some(c) = chords.iter().find(|c| !is_valid_chord(c)) {
            return Err(bad(format!("{id}: \"{c}\" is not a valid key")));
        }
    }
    Ok(())
}

/// Checks the shape (known keys, version, platform sections, chord syntax, caps).
pub fn validate(text: &str) -> Result<(), HotkeysError> {
    if text.len() as u64 > MAX_BYTES {
        return Err(HotkeysError::Invalid(format!(
            "{FILE} is larger than {} KB",
            MAX_BYTES / 1024
        )));
    }
    let file: File = serde_json::from_str(text)
        .map_err(|e| HotkeysError::Invalid(format!("{FILE} is not valid: {e}")))?;
    if file.version != VERSION {
        return Err(HotkeysError::Invalid(format!(
            "{FILE} has version {}, expected {VERSION}",
            file.version
        )));
    }
    check_section("mac", &file.mac)?;
    check_section("windows", &file.windows)?;
    check_section("linux", &file.linux)
}

/// The file's text, or `None` when there is none yet. A file that does not validate is an error
/// (the caller runs with defaults and says why), never silently ignored.
pub fn read(dir: &Path) -> Result<Option<String>, HotkeysError> {
    let path = dir.join(FILE);
    match fs::metadata(&path) {
        Ok(m) if m.len() > MAX_BYTES => Err(HotkeysError::Invalid(format!(
            "{FILE} is larger than {} KB",
            MAX_BYTES / 1024
        ))),
        Ok(_) => {
            let text = fs::read_to_string(&path).map_err(|e| HotkeysError::Io(e.to_string()))?;
            validate(&text)?;
            Ok(Some(text))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(HotkeysError::Io(e.to_string())),
    }
}

/// Validates, then replaces the file atomically (`plugins::write_atomic`). An existing file that
/// does not validate (hand-edited) is kept as `hotkeys.json.bak` first, so a save never destroys it.
pub fn write(dir: &Path, text: &str) -> Result<(), HotkeysError> {
    validate(text)?;
    fs::create_dir_all(dir).map_err(|e| HotkeysError::Io(e.to_string()))?;
    let path = dir.join(FILE);
    if let Ok(old) = fs::read_to_string(&path) {
        if validate(&old).is_err() {
            fs::rename(&path, dir.join(format!("{FILE}.bak")))
                .map_err(|e| HotkeysError::Io(e.to_string()))?;
        }
    }
    crate::plugins::write_atomic(dir, FILE, text.as_bytes()).map_err(HotkeysError::Io)
}

/// The text of the vault's `.obsidian/hotkeys.json`, or `None` when there is none. Read-only: a
/// symlink or a non-file is treated as absent, a file over the cap or not a JSON object is an
/// error. `root` is the canonical vault root, confined by the caller.
pub fn read_obsidian(root: &Path) -> Result<Option<String>, HotkeysError> {
    let path = root.join(".obsidian").join(FILE);
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(HotkeysError::Io(e.to_string())),
    };
    if meta.len() > MAX_BYTES {
        return Err(HotkeysError::Invalid(format!(
            ".obsidian/{FILE} is larger than {} KB",
            MAX_BYTES / 1024
        )));
    }
    let text = fs::read_to_string(&path).map_err(|e| HotkeysError::Io(e.to_string()))?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if v.is_object() => Ok(Some(text)),
        _ => Err(HotkeysError::Invalid(format!(
            ".obsidian/{FILE} is not a JSON object"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(v: serde_json::Value) -> String {
        v.to_string()
    }

    #[test]
    fn chord_syntax_matches_the_shared_vectors() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/chord-vectors.json")).unwrap();
        for c in v["valid"].as_array().unwrap() {
            assert!(is_valid_chord(c.as_str().unwrap()), "{c} should be valid");
        }
        for c in v["invalid"].as_array().unwrap() {
            assert!(
                !is_valid_chord(c.as_str().unwrap()),
                "{c} should be invalid"
            );
        }
    }

    #[test]
    fn a_well_formed_file_validates_and_empty_sections_may_be_left_out() {
        assert!(validate(&text(json!({"version": 1}))).is_ok());
        let ok = json!({"version": 1, "mac": {"reopen-closed-tab": ["Mod+Shift+K"], "x": []},
            "windows": {"x": ["Ctrl+Alt+Delete"]}});
        assert!(validate(&text(ok)).is_ok());
    }

    #[test]
    fn a_bad_shape_is_refused_with_a_reason() {
        let cases = [
            ("not json", "not valid"),
            ("[]", "not valid"),
            (r#"{"version":2}"#, "version 2"),
            (r#"{"mac":{}}"#, "not valid"),
            (r#"{"version":1,"macos":{}}"#, "not valid"),
            (r#"{"version":1,"mac":{"a":"Mod+T"}}"#, "not valid"),
            (
                r#"{"version":1,"mac":{"a":["Cmd+T"]}}"#,
                "mac: a: \"Cmd+T\"",
            ),
            (
                r#"{"version":1,"linux":{"":["Mod+T"]}}"#,
                "linux: a command id",
            ),
        ];
        for (input, reason) in cases {
            let err = validate(input).unwrap_err().to_string();
            assert!(err.contains(reason), "{input}: {err}");
        }
    }

    #[test]
    fn the_caps_are_enforced() {
        let many: Vec<String> = (0..=MAX_CHORDS).map(|i| format!("Mod+{i}")).collect();
        let too_many_keys = text(json!({"version": 1, "mac": {"a": many}}));
        assert!(validate(&too_many_keys)
            .unwrap_err()
            .to_string()
            .contains("more than 8 keys"));

        let cmds: serde_json::Map<String, serde_json::Value> = (0..=MAX_COMMANDS)
            .map(|i| (format!("c{i}"), json!(["Mod+T"])))
            .collect();
        let too_many = text(json!({"version": 1, "mac": cmds}));
        assert!(validate(&too_many)
            .unwrap_err()
            .to_string()
            .contains("commands"));

        let big = format!(
            r#"{{"version":1,"mac":{{"a":["Mod+T"]}},"pad":"{}"}}"#,
            "x".repeat(300_000)
        );
        assert!(validate(&big)
            .unwrap_err()
            .to_string()
            .contains("larger than"));
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path()), Ok(None));
        let body = text(json!({"version": 1, "mac": {"a": ["Mod+K"]}}));
        write(dir.path(), &body).unwrap();
        assert_eq!(read(dir.path()).unwrap().as_deref(), Some(body.as_str()));
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![FILE.to_string()]);
    }

    #[test]
    fn an_invalid_write_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let good = text(json!({"version": 1, "mac": {"a": ["Mod+K"]}}));
        write(dir.path(), &good).unwrap();
        assert!(write(dir.path(), r#"{"version":1,"mac":{"a":["nope+"]}}"#).is_err());
        assert_eq!(read(dir.path()).unwrap().as_deref(), Some(good.as_str()));
    }

    #[test]
    fn a_hand_edited_invalid_file_errors_on_read_and_is_kept_as_bak_by_the_next_write() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), "{ broken").unwrap();
        assert!(matches!(read(dir.path()), Err(HotkeysError::Invalid(_))));
        write(dir.path(), &text(json!({"version": 1}))).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("hotkeys.json.bak")).unwrap(),
            "{ broken"
        );
        assert!(read(dir.path()).unwrap().is_some());
    }

    #[test]
    fn obsidian_hotkeys_are_read_only_and_confined_to_a_plain_file() {
        let vault = tempfile::tempdir().unwrap();
        assert_eq!(read_obsidian(vault.path()), Ok(None));
        let obs = vault.path().join(".obsidian");
        fs::create_dir(&obs).unwrap();
        let body = r#"{"app:go-back":[{"modifiers":["Mod"],"key":"["}]}"#;
        fs::write(obs.join(FILE), body).unwrap();
        assert_eq!(read_obsidian(vault.path()).unwrap().as_deref(), Some(body));
        // Nothing was written or created next to it.
        assert_eq!(fs::read_dir(&obs).unwrap().count(), 1);

        fs::write(obs.join(FILE), "[1]").unwrap();
        assert!(matches!(
            read_obsidian(vault.path()),
            Err(HotkeysError::Invalid(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn an_obsidian_hotkeys_symlink_is_not_followed() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.json"), "{}").unwrap();
        let obs = vault.path().join(".obsidian");
        fs::create_dir(&obs).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.json"), obs.join(FILE)).unwrap();
        assert_eq!(read_obsidian(vault.path()), Ok(None));
    }
}
