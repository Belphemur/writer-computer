//! Icons for files and folders (spec `SPECs/icons-spec.md`, decision
//! `docs/decisions/2026-11-18-show-file-and-folder-icons-natively-over-iconize-data-read-only.md`).
//!
//! Tauri-free, so the `writer icon:*` commands, the sidebar's IPC and `relocate` share one store
//! and one resolver:
//!
//! - **Store**: `.writer/icons.json`, `{ "version": 1, "icons": { "<vault path>": { "icon", "color"? } } }`,
//!   the icon in the core icon-value format (`property_types::valid_icon`). Written atomically,
//!   only here, never anywhere near `.obsidian`. Unknown keys (top level and per entry) survive a
//!   round trip. The entry `{ "icon": "none" }` hides an Iconize icon (a removed icon must not
//!   reappear from the layer below).
//! - **Iconize layer**: the `data.json` of the Iconize community plugin, read live and never
//!   written (the same read-only-layer pattern as `property_types` over `.obsidian/types.json`).
//!   An emoji maps to `emoji:`, a Hugeicons-shaped name to `icon:`; icons of other packs are
//!   counted ([`Resolved::iconize_unsupported`]) and not shown. Custom rules, frontmatter mode and
//!   colours per rule are not used.
//! - **Resolution**: Writer's entry, then Iconize's, then none; a folder passes nothing to its
//!   contents ([`resolve`]).
//! - **Moves and deletes**: [`on_move`] re-keys the entries of a file, or of a folder and every
//!   descendant, in the same operation as the move (`vault_events` calls it, from
//!   `relocate::apply`, the app's rename and delete and the CLI's delete); an Iconize-only icon is
//!   copied to the new path and hidden at the old one. [`on_delete`] drops them. Both write nothing while the feature is off ([`set_enabled`]).

use crate::plugins::write_atomic;
use crate::property_types::{valid_icon, writer_dir, PropertyTypeError};
use crate::vault_events::moved_key;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const FILE: &str = "icons.json";
/// Where the Iconize plugin keeps its data, relative to the vault. Only ever read.
pub const ICONIZE_FILE: &str = ".obsidian/plugins/obsidian-icon-folder/data.json";
/// Larger than any real file (a few hundred bytes per iconized note); a bigger one is a bug.
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// The icon string of a Writer entry that hides an Iconize icon.
const HIDDEN: &str = "none";

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum IconError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(String),
}

impl From<PropertyTypeError> for IconError {
    fn from(e: PropertyTypeError) -> Self {
        match e {
            PropertyTypeError::Invalid(m) => IconError::Invalid(m),
            other => IconError::Io(other.to_string()),
        }
    }
}

static ENABLED: AtomicBool = AtomicBool::new(true);
/// The tests that flip the kill switch, and the ones that need it on, take this lock.
#[cfg(test)]
pub(crate) static TEST_SWITCH: Mutex<()> = Mutex::new(());
/// Serializes read-modify-write of the store inside this process (a second process, the CLI,
/// still wins or loses on the atomic rename, like any two writers of a file).
static WRITE: Mutex<()> = Mutex::new(());

/// The feature's kill switch as the core paths (`relocate`, the folder rename, delete) see it:
/// off, they neither read nor write the store. Set by `features::icons::apply`.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// One icon of a path: `icon` is `emoji:<emoji>` or `icon:<Hugeicons name>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Entry {
    fn new(icon: String, color: Option<String>) -> Self {
        Entry {
            icon,
            color,
            extra: Map::new(),
        }
    }

    fn hidden() -> Self {
        Entry::new(HIDDEN.into(), None)
    }

    pub fn is_hidden(&self) -> bool {
        self.icon == HIDDEN
    }
}

/// `.writer/icons.json` in memory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Store {
    pub icons: BTreeMap<String, Entry>,
    /// Top-level keys other than `version` and `icons`, written back as found.
    extra: Map<String, Value>,
}

/// `#rrggbb` (the one colour shape the store keeps).
pub fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// What a user or an agent typed for an icon, as the stored value: the stored format as is, or a
/// bare emoji or a bare Hugeicons name (`Rocket01Icon`).
pub fn normalize_icon(input: &str) -> Option<String> {
    let input = input.trim();
    [
        input.to_string(),
        format!("emoji:{input}"),
        format!("icon:{input}"),
    ]
    .into_iter()
    .find(|v| valid_icon(v))
}

impl Store {
    fn parse(text: &str) -> Result<Store, IconError> {
        let mut doc: Map<String, Value> = serde_json::from_str(text)
            .map_err(|e| IconError::Invalid(format!(".writer/{FILE} is not valid JSON: {e}")))?;
        let mut icons = BTreeMap::new();
        if let Some(Value::Object(raw)) = doc.remove("icons") {
            for (path, entry) in raw {
                // A bad entry is dropped on the next write, never an error: the file is the
                // user's and the rest of it is fine.
                let Ok(entry) = serde_json::from_value::<Entry>(entry) else {
                    continue;
                };
                let good = entry.is_hidden() || valid_icon(&entry.icon);
                let color_ok = entry.color.as_deref().is_none_or(valid_color);
                if good && color_ok {
                    icons.insert(path, entry);
                }
            }
        }
        doc.remove("version");
        Ok(Store { icons, extra: doc })
    }

    fn render(&self) -> Result<String, IconError> {
        let mut doc = Map::new();
        doc.insert("version".into(), Value::from(1));
        doc.insert(
            "icons".into(),
            serde_json::to_value(&self.icons).map_err(|e| IconError::Io(e.to_string()))?,
        );
        for (k, v) in &self.extra {
            doc.entry(k.clone()).or_insert_with(|| v.clone());
        }
        let mut text = serde_json::to_string_pretty(&Value::Object(doc))
            .map_err(|e| IconError::Io(e.to_string()))?;
        text.push('\n');
        Ok(text)
    }

    pub fn get(&self, path: &str) -> Option<&Entry> {
        self.icons.get(path)
    }
}

/// The store of a vault (empty when it has none). Reads nothing outside the vault.
pub fn load(root: &Path) -> Result<Store, IconError> {
    if !root.join(".writer").exists() {
        return Ok(Store::default());
    }
    let path = writer_dir(root)?.join(FILE);
    match std::fs::metadata(&path) {
        Ok(m) if m.len() > MAX_BYTES => Err(IconError::Invalid(format!(
            ".writer/{FILE} is larger than {} MB",
            MAX_BYTES / (1024 * 1024)
        ))),
        Ok(_) => {
            Store::parse(&std::fs::read_to_string(&path).map_err(|e| IconError::Io(e.to_string()))?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(IconError::Io(e.to_string())),
    }
}

/// Replace the file with `store` (atomic). Never called with the feature off.
fn save(root: &Path, store: &Store) -> Result<(), IconError> {
    let dir = writer_dir(root)?;
    write_atomic(&dir, FILE, store.render()?.as_bytes()).map_err(IconError::Io)
}

/// Run `edit` over the store and write it back when it reports a change. The one write path.
fn modify<T>(root: &Path, edit: impl FnOnce(&mut Store) -> (bool, T)) -> Result<T, IconError> {
    let _guard = WRITE.lock();
    let mut store = load(root)?;
    let (changed, out) = edit(&mut store);
    if changed {
        save(root, &store)?;
    }
    Ok(out)
}

// ---------- The Iconize layer ----------

/// Iconize's entries of a vault (supported ones, as stored icon values) and how many it holds
/// that Writer cannot show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Iconize {
    pub icons: BTreeMap<String, Entry>,
    pub unsupported: usize,
}

/// What an Iconize value (`"IbBell"`, `"🚀"`) is as a stored icon value: an emoji, or a name
/// shaped like a Hugeicons export (`Rocket01Icon`); a pack icon (`IbBell`, `LiHome`) is none.
fn iconize_icon(raw: &str) -> Option<String> {
    let emoji = format!("emoji:{raw}");
    if valid_icon(&emoji) {
        return Some(emoji);
    }
    let icon = format!("icon:{raw}");
    valid_icon(&icon).then_some(icon)
}

fn iconize_entry(value: &Value) -> Option<(&str, Option<&str>)> {
    match value {
        Value::String(s) => Some((s.as_str(), None)),
        Value::Object(o) => Some((
            o.get("iconName")?.as_str()?,
            o.get("iconColor").and_then(Value::as_str),
        )),
        _ => None,
    }
}

/// Parse the text of Iconize's `data.json`: path entries are strings or `{iconName, iconColor}`;
/// the `settings` key holds its settings (rules and packs, not used).
pub fn parse_iconize(text: &str) -> Iconize {
    let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(text) else {
        return Iconize::default();
    };
    let mut out = Iconize::default();
    for (path, value) in &doc {
        if path == "settings" {
            continue;
        }
        let Some((raw, color)) = iconize_entry(value) else {
            continue;
        };
        match iconize_icon(raw) {
            Some(icon) => {
                let color = color.filter(|c| valid_color(c)).map(str::to_string);
                out.icons.insert(path.clone(), Entry::new(icon, color));
            }
            None => out.unsupported += 1,
        }
    }
    out
}

/// Iconize's data for a vault; empty when the plugin is not there. Read-only: nothing under
/// `.obsidian` is ever written. A link that leaves the vault is not followed.
pub fn load_iconize(root: &Path) -> Iconize {
    let path = root.join(ICONIZE_FILE);
    let Ok(meta) = std::fs::metadata(&path) else {
        return Iconize::default();
    };
    let inside = match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(r),
        _ => false,
    };
    if !inside || meta.len() > MAX_BYTES {
        return Iconize::default();
    }
    std::fs::read_to_string(&path)
        .map(|t| parse_iconize(&t))
        .unwrap_or_default()
}

// ---------- Resolution ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Writer,
    Iconize,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Writer => "writer",
            Source::Iconize => "iconize",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Vault path to its icon (never a hidden one).
    pub icons: BTreeMap<String, (Entry, Source)>,
    /// Iconize icons from packs Writer does not show.
    pub iconize_unsupported: usize,
}

/// The one resolver: for every path, Writer's entry wins, then Iconize's; a hidden entry blocks
/// the Iconize icon and shows none.
pub fn resolve_with(store: &Store, iconize: Iconize) -> Resolved {
    let mut icons: BTreeMap<String, (Entry, Source)> = BTreeMap::new();
    for (path, entry) in iconize.icons {
        if !store.icons.contains_key(&path) {
            icons.insert(path, (entry, Source::Iconize));
        }
    }
    for (path, entry) in &store.icons {
        if !entry.is_hidden() {
            icons.insert(path.clone(), (entry.clone(), Source::Writer));
        }
    }
    Resolved {
        icons,
        iconize_unsupported: iconize.unsupported,
    }
}

/// [`resolve_with`] over the vault's files.
pub fn resolve(root: &Path) -> Result<Resolved, IconError> {
    Ok(resolve_with(&load(root)?, load_iconize(root)))
}

/// The icon of one path, or `None`.
pub fn icon_of(root: &Path, path: &str) -> Result<Option<(Entry, Source)>, IconError> {
    Ok(resolve(root)?.icons.remove(path))
}

// ---------- Writing ----------

/// Give every path (vault-relative, forward slashes) `icon` (`emoji:` or `icon:`, see
/// [`normalize_icon`]) and optionally a `#rrggbb` colour.
pub fn set(
    root: &Path,
    paths: &[String],
    icon: &str,
    color: Option<&str>,
) -> Result<(), IconError> {
    if !valid_icon(icon) {
        return Err(IconError::Invalid(format!("not an icon: {icon}")));
    }
    if let Some(c) = color.filter(|c| !valid_color(c)) {
        return Err(IconError::Invalid(format!("not a #rrggbb colour: {c}")));
    }
    modify(root, |store| {
        for p in paths {
            let mut entry = Entry::new(icon.to_string(), color.map(str::to_string));
            if let Some(old) = store.icons.get(p) {
                entry.extra = old.extra.clone();
            }
            store.icons.insert(p.clone(), entry);
        }
        (!paths.is_empty(), ())
    })
}

/// Remove the icon of every path. An icon that comes from Iconize is hidden, because deleting
/// Writer's entry alone would show it again.
pub fn remove(root: &Path, paths: &[String]) -> Result<(), IconError> {
    let iconize = load_iconize(root);
    modify(root, |store| {
        let mut changed = false;
        for p in paths {
            changed |= if iconize.icons.contains_key(p) {
                store.icons.insert(p.clone(), Entry::hidden()) != Some(Entry::hidden())
            } else {
                store.icons.remove(p).is_some()
            };
        }
        (changed, ())
    })
}

/// Re-key every icon at or under `from` to the same place under `to` (vault-relative). Writer's
/// entries move; an Iconize-only icon is copied to the new path and hidden at the old one (its
/// file is never touched). Nothing happens, and nothing is written, with the feature off or when
/// no icon is involved.
pub fn on_move(root: &Path, from: &str, to: &str) -> Result<(), IconError> {
    if !enabled() {
        return Ok(());
    }
    rekey(root, from, to)
}

/// [`on_move`] without the kill switch (the switch is a process-wide flag; tests call this).
fn rekey(root: &Path, from: &str, to: &str) -> Result<(), IconError> {
    if from == to {
        return Ok(());
    }
    let iconize = load_iconize(root);
    modify(root, |store| {
        // Iconize icons that only Iconize holds: decided before Writer's entries move.
        let copies: Vec<(String, String, Entry)> = iconize
            .icons
            .iter()
            .filter(|(key, _)| !store.icons.contains_key(*key))
            .filter_map(|(key, e)| Some((key.clone(), moved_key(key, from, to)?, e.clone())))
            .collect();
        let moving: Vec<(String, String)> = store
            .icons
            .keys()
            .filter_map(|k| moved_key(k, from, to).map(|n| (k.clone(), n)))
            .collect();
        let changed = !moving.is_empty() || !copies.is_empty();
        for (old, new) in moving {
            if let Some(entry) = store.icons.remove(&old) {
                store.icons.insert(new, entry);
                // Iconize's icon at the old path must not come back for a new file there.
                if iconize.icons.contains_key(&old) {
                    store.icons.insert(old, Entry::hidden());
                }
            }
        }
        for (old, new, entry) in copies {
            store.icons.entry(new).or_insert(entry);
            store.icons.insert(old, Entry::hidden());
        }
        (changed, ())
    })
}

/// Drop the icons at and under `path` (a deleted file or folder). Nothing is written with the
/// feature off or when there is none.
pub fn on_delete(root: &Path, path: &str) -> Result<(), IconError> {
    if !enabled() {
        return Ok(());
    }
    drop_under(root, path)
}

fn drop_under(root: &Path, path: &str) -> Result<(), IconError> {
    modify(root, |store| {
        let before = store.icons.len();
        store
            .icons
            .retain(|k, _| moved_key(k, path, path).is_none());
        (store.icons.len() != before, ())
    })
}

#[cfg(test)]
mod tests;
