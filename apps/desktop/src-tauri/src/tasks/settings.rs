//! What the task writers and readers need to know about a vault: the format to write, the custom
//! statuses, and Writer's own settings. The layers are the property types' (`property_types.rs`):
//! Writer's settings and `.writer/task-statuses.json` first, then the Tasks plugin's own
//! `.obsidian/plugins/obsidian-tasks-plugin/data.json`, read-only (nothing here ever writes
//! `.obsidian`), then the defaults.

use super::grammar::Format;
use super::status::{Status, StatusTable, StatusType};
use serde_json::Value as Json;
use std::path::Path;

pub const SETTING_FORMAT: &str = "tasks.format";
pub const SETTING_SET_DONE_DATE: &str = "tasks.set-done-date";
pub const SETTING_RECURRENCE_POSITION: &str = "tasks.recurrence-position";
pub const SETTING_INBOX: &str = "tasks.inbox";

pub const DEFAULT_INBOX: &str = "Tasks.md";
const OBSIDIAN_DATA: &str = ".obsidian/plugins/obsidian-tasks-plugin/data.json";
const WRITER_STATUSES: &str = ".writer/task-statuses.json";
/// Larger than any real settings file; a bigger one is ignored, not read.
const MAX_FILE_BYTES: u64 = 1_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Overrides {
    /// `vault` (follow the Tasks plugin's setting), `emoji` or `dataview`.
    pub format: String,
    pub set_done_date: bool,
    /// The next occurrence of a recurring task goes `above` or `below` the completed one.
    pub recurrence_below: bool,
    /// The note quick add writes to, vault-relative.
    pub inbox: String,
}

impl Default for Overrides {
    fn default() -> Self {
        Overrides {
            format: "vault".into(),
            set_done_date: true,
            recurrence_below: false,
            inbox: DEFAULT_INBOX.into(),
        }
    }
}

impl Overrides {
    /// From any settings source (the app's `Settings`, the CLI's global `config` file).
    pub fn from_lookup(
        string: impl Fn(&str) -> Option<String>,
        flag: impl Fn(&str) -> Option<bool>,
    ) -> Overrides {
        let d = Overrides::default();
        Overrides {
            format: string(SETTING_FORMAT).unwrap_or(d.format),
            set_done_date: flag(SETTING_SET_DONE_DATE).unwrap_or(d.set_done_date),
            recurrence_below: string(SETTING_RECURRENCE_POSITION).is_some_and(|p| p == "below"),
            inbox: string(SETTING_INBOX)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(d.inbox),
        }
    }

    /// The `writer` CLI has no settings layer: the global `config` file in the app data dir.
    pub fn from_global_dir(dir: &Path) -> Overrides {
        Overrides::from_lookup(
            |k| crate::config::read_global_string(dir, k),
            |k| crate::config::read_global_bool(dir, k),
        )
    }
}

#[derive(Clone, Debug)]
pub struct TaskSettings {
    pub format: Format,
    pub statuses: StatusTable,
    pub set_done_date: bool,
    pub recurrence_below: bool,
    pub inbox: String,
}

impl Default for TaskSettings {
    fn default() -> Self {
        TaskSettings {
            format: Format::Emoji,
            statuses: StatusTable::default(),
            set_done_date: true,
            recurrence_below: false,
            inbox: DEFAULT_INBOX.into(),
        }
    }
}

fn read_json(root: &Path, rel: &str) -> Option<Json> {
    let path = root.join(rel);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    match serde_json::from_slice(&std::fs::read(&path).ok()?) {
        Ok(j) => Some(j),
        Err(_) => {
            log::warn!("a task settings file is not valid JSON and is ignored");
            None
        }
    }
}

fn symbol(v: &Json, key: &str) -> Option<char> {
    let mut it = v.get(key)?.as_str()?.chars();
    let c = it.next()?;
    it.next().is_none().then_some(c)
}

/// One `{symbol, name, next…, type}` object of either file.
fn status_from(v: &Json, next_key: &str) -> Option<Status> {
    let sym = symbol(v, "symbol")?;
    let kind = v
        .get("type")
        .and_then(Json::as_str)
        .and_then(StatusType::parse)
        .unwrap_or(StatusType::Todo);
    Some(Status::new(
        sym,
        v.get("name").and_then(Json::as_str).unwrap_or(""),
        symbol(v, next_key).unwrap_or('x'),
        kind,
    ))
}

fn statuses_in(list: Option<&Json>, next_key: &str) -> Vec<Status> {
    list.and_then(Json::as_array)
        .map(|a| a.iter().filter_map(|v| status_from(v, next_key)).collect())
        .unwrap_or_default()
}

/// The status table of a vault: Writer's file, then the Tasks plugin's settings, then defaults.
pub fn load_statuses(root: &Path) -> StatusTable {
    let writer = read_json(root, WRITER_STATUSES)
        .map(|j| statuses_in(j.get("statuses"), "next"))
        .unwrap_or_default();
    let plugin = read_json(root, OBSIDIAN_DATA)
        .map(|j| {
            let s = j.get("statusSettings");
            let mut all = statuses_in(s.and_then(|s| s.get("coreStatuses")), "nextStatusSymbol");
            all.extend(statuses_in(
                s.and_then(|s| s.get("customStatuses")),
                "nextStatusSymbol",
            ));
            all
        })
        .unwrap_or_default();
    StatusTable::default().with_first(writer.into_iter().chain(plugin).collect())
}

/// The format the Tasks plugin is set to write, if the vault has its settings.
fn vault_format(root: &Path) -> Option<Format> {
    let j = read_json(root, OBSIDIAN_DATA)?;
    Format::parse(j.get("taskFormat")?.as_str()?)
}

impl TaskSettings {
    pub fn load(root: &Path, o: &Overrides) -> TaskSettings {
        let format = match o.format.as_str() {
            "vault" => vault_format(root),
            other => Format::parse(other),
        }
        .unwrap_or(Format::Emoji);
        TaskSettings {
            format,
            statuses: load_statuses(root),
            set_done_date: o.set_done_date,
            recurrence_below: o.recurrence_below,
            inbox: o.inbox.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault(files: &[(&str, &str)]) -> TempDir {
        let d = TempDir::new().unwrap();
        for (rel, text) in files {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        d
    }

    const PLUGIN: &str = r#"{"taskFormat":"dataview","statusSettings":{
        "coreStatuses":[{"symbol":" ","name":"Todo","nextStatusSymbol":"x","availableAsCommand":true,"type":"TODO"}],
        "customStatuses":[{"symbol":"!","name":"Important","nextStatusSymbol":"x","availableAsCommand":true,"type":"TODO"},
                          {"symbol":"h","name":"Hold","nextStatusSymbol":" ","availableAsCommand":true,"type":"ON_HOLD"}]}}"#;

    #[test]
    fn the_vault_format_and_statuses_come_from_the_plugin_settings() {
        let v = vault(&[(OBSIDIAN_DATA, PLUGIN)]);
        let s = TaskSettings::load(v.path(), &Overrides::default());
        assert_eq!(s.format, Format::Dataview);
        assert_eq!(s.statuses.kind_of('h'), StatusType::OnHold);
        assert_eq!(s.statuses.next_symbol('h'), ' ');
        assert_eq!(s.statuses.next_symbol('x'), ' ');
    }

    #[test]
    fn writer_overrides_beat_the_plugin() {
        let v = vault(&[
            (OBSIDIAN_DATA, PLUGIN),
            (
                WRITER_STATUSES,
                r#"{"statuses":[{"symbol":"h","name":"Waiting","next":"x","type":"IN_PROGRESS"}]}"#,
            ),
        ]);
        let o = Overrides {
            format: "emoji".into(),
            ..Overrides::default()
        };
        let s = TaskSettings::load(v.path(), &o);
        assert_eq!(s.format, Format::Emoji);
        assert_eq!(s.statuses.kind_of('h'), StatusType::InProgress);
        assert_eq!(s.statuses.kind_of('!'), StatusType::Todo);
    }

    #[test]
    fn no_settings_means_emoji_and_the_defaults() {
        let v = vault(&[]);
        let s = TaskSettings::load(v.path(), &Overrides::default());
        assert_eq!(s.format, Format::Emoji);
        assert_eq!(s.statuses, StatusTable::default());
        // a broken file is ignored, not fatal
        let v = vault(&[(OBSIDIAN_DATA, "{not json")]);
        assert_eq!(
            TaskSettings::load(v.path(), &Overrides::default()).format,
            Format::Emoji
        );
    }

    #[test]
    fn overrides_read_from_a_lookup() {
        let o = Overrides::from_lookup(
            |k| match k {
                SETTING_RECURRENCE_POSITION => Some("below".into()),
                SETTING_INBOX => Some(" Inbox/Tasks.md ".into()),
                _ => None,
            },
            |k| (k == SETTING_SET_DONE_DATE).then_some(false),
        );
        assert!(o.recurrence_below && !o.set_done_date);
        assert_eq!(o.inbox, "Inbox/Tasks.md");
        assert_eq!(o.format, "vault");
    }
}
