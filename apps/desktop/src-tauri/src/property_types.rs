//! The one source of truth for property types of a vault (spec: `SPECs/properties-types-spec.md`).
//!
//! Like Obsidian, a property name has ONE type across the vault. Two records feed it:
//!
//! - `.obsidian/types.json` (`{"types": {name: type}}`), read-only: an Obsidian vault's types show
//!   up immediately. Writer never writes it.
//! - `.writer/property-types.json`, same format, Writer's own record and the only file this module
//!   writes. It wins over Obsidian's. An `enum` entry is an object carrying its ordered values
//!   (`{"type": "enum", "values": [...]}`); every other entry is a bare type string.
//!
//! With no record, the type is inferred from the observed values (the index's `props.vtype`
//! counts; a property whose every non-empty value is a wikilink or a list of wikilinks is
//! `relationships`, see [`refine_list_shapes`]). Tauri-free: the Tauri commands, the Bases property pickers and the plugin host's
//! `metadataTypeManager` all read [`report`] through one IPC command.

use crate::index::PropertyCount;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Writer's own record, relative to the vault root.
pub const WRITER_FILE: &str = ".writer/property-types.json";
/// Obsidian's record, relative to the vault root. Read-only here.
pub const OBSIDIAN_FILE: &str = ".obsidian/types.json";

/// Obsidian's type names (`types.json` values), which are also the wire names everywhere, plus
/// Writer's own `relationships` (a link or a list of links) and `enum` (one string of a recorded
/// list). Obsidian has neither: they are stored only in `.writer/property-types.json`, an
/// `.obsidian/types.json` entry of that name is skipped, and plugins see them as `multitext` /
/// `text` ([`PropertyType::obsidian_name`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PropertyType {
    Text,
    Multitext,
    Number,
    Checkbox,
    Date,
    Datetime,
    Tags,
    Aliases,
    Relationships,
    Enum,
}

impl PropertyType {
    /// The wire name, also what `.writer/property-types.json` stores.
    pub fn parse(s: &str) -> Option<PropertyType> {
        Some(match s {
            "text" => PropertyType::Text,
            "multitext" => PropertyType::Multitext,
            "number" => PropertyType::Number,
            "checkbox" => PropertyType::Checkbox,
            "date" => PropertyType::Date,
            "datetime" => PropertyType::Datetime,
            "tags" => PropertyType::Tags,
            "aliases" => PropertyType::Aliases,
            "relationships" => PropertyType::Relationships,
            "enum" => PropertyType::Enum,
            _ => return None,
        })
    }

    /// The wire name (`text`, `relationships`, ...), as stored in `.writer/property-types.json`.
    pub fn wire_name(self) -> &'static str {
        match self {
            PropertyType::Text => "text",
            PropertyType::Multitext => "multitext",
            PropertyType::Number => "number",
            PropertyType::Checkbox => "checkbox",
            PropertyType::Date => "date",
            PropertyType::Datetime => "datetime",
            PropertyType::Tags => "tags",
            PropertyType::Aliases => "aliases",
            PropertyType::Relationships => "relationships",
            PropertyType::Enum => "enum",
        }
    }

    /// Types Obsidian does not have: recorded only in Writer's own file.
    pub fn is_writer_only(self) -> bool {
        matches!(self, PropertyType::Relationships | PropertyType::Enum)
    }

    /// Parse a type name from Obsidian's `types.json`: Obsidian has no Writer-only type.
    pub fn parse_obsidian(s: &str) -> Option<PropertyType> {
        PropertyType::parse(s).filter(|t| !t.is_writer_only())
    }

    /// The type name Obsidian (and so a plugin) knows this type by: `relationships` is a
    /// `multitext` (`multi` is whether the property holds lists) or a `text`; `enum` is a `text`.
    pub fn obsidian_name(self, multi: bool) -> &'static str {
        match self {
            PropertyType::Relationships if multi => "multitext",
            PropertyType::Relationships | PropertyType::Enum => "text",
            other => other.wire_name(),
        }
    }

    /// Whether an indexed value type (`props.vtype`, plus the synthetic `links` of
    /// [`refine_list_shapes`]: a list of wikilinks only) is a valid value of this type.
    /// A property without a value (`null`) fits every type.
    pub fn fits(self, vtype: &str) -> bool {
        matches!(
            (self, vtype),
            (_, "null")
                | (PropertyType::Text, "text" | "link")
                | (PropertyType::Enum, "text")
                | (PropertyType::Number, "number")
                | (PropertyType::Checkbox, "bool")
                | (PropertyType::Date, "date")
                | (PropertyType::Datetime, "datetime")
                | (
                    PropertyType::Multitext | PropertyType::Tags | PropertyType::Aliases,
                    "list" | "links"
                )
                | (PropertyType::Relationships, "link" | "links")
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TypeSource {
    Writer,
    Obsidian,
    Inferred,
}

#[derive(Debug, thiserror::Error)]
pub enum PropertyTypeError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(String),
}

/// The vault's property name, normalised the way Obsidian keys `types.json`.
pub fn normalize(name: &str) -> String {
    name.trim().to_lowercase()
}

/// `{"types": {name: entry}}`. Entries stay raw JSON so an entry this build does not know is
/// preserved when the file is rewritten; [`Recorded::from_entry`] reads the known shapes.
#[derive(Debug, Default, Deserialize, Serialize)]
struct TypesFile {
    #[serde(default)]
    types: BTreeMap<String, serde_json::Value>,
}

/// One recorded type: the type and, for an enum, its ordered values.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Recorded {
    ty: PropertyType,
    values: Vec<String>,
}

impl Recorded {
    /// A bare type string, or `{"type": ..., "values": [...]}`. Unknown or invalid entries give
    /// `None` (an Obsidian vault may carry types Writer does not know).
    fn from_entry(
        entry: &serde_json::Value,
        parse: fn(&str) -> Option<PropertyType>,
    ) -> Option<Recorded> {
        let (name, values) = match entry {
            serde_json::Value::String(s) => (s.as_str(), None),
            serde_json::Value::Object(o) => (o.get("type")?.as_str()?, o.get("values")),
            _ => return None,
        };
        let ty = parse(name)?;
        let values = match (ty, values) {
            (PropertyType::Enum, Some(serde_json::Value::Array(items))) => clean_values(
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
            ),
            _ => Vec::new(),
        };
        Some(Recorded { ty, values })
    }

    /// The entry as stored: a bare string, except an enum, which carries its values.
    fn to_entry(&self) -> serde_json::Value {
        if self.ty == PropertyType::Enum {
            serde_json::json!({"type": self.ty.wire_name(), "values": self.values})
        } else {
            serde_json::Value::String(self.ty.wire_name().to_owned())
        }
    }
}

/// An enum's values as stored: trimmed, non-empty, one line, first occurrence wins, order kept.
pub fn clean_values(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .into_iter()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty() && !v.contains(['\n', '\r']) && seen.insert(v.clone()))
        .collect()
}

/// The initial values of a property turned into an enum: every distinct observed value
/// (`(value, notes)` pairs), most used first, then by name.
pub fn seed_values(mut observed: Vec<(String, i64)>) -> Vec<String> {
    observed.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    clean_values(observed.into_iter().map(|(v, _)| v).collect())
}

/// Parse a types file leniently: an unreadable or invalid file, or an unknown entry, is skipped (a
/// broken file must not break the panel).
fn read_types(path: &Path, parse: fn(&str) -> Option<PropertyType>) -> BTreeMap<String, Recorded> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    let Ok(file) = serde_json::from_slice::<TypesFile>(&bytes) else {
        return BTreeMap::new();
    };
    file.types
        .iter()
        .filter_map(|(k, v)| Recorded::from_entry(v, parse).map(|r| (normalize(k), r)))
        .collect()
}

/// Both records of a vault, merged with Writer's winning.
#[derive(Debug, Default)]
pub struct TypeTable {
    writer: BTreeMap<String, Recorded>,
    obsidian: BTreeMap<String, Recorded>,
}

impl TypeTable {
    pub fn load(root: &Path) -> TypeTable {
        TypeTable {
            writer: read_types(&root.join(WRITER_FILE), PropertyType::parse),
            obsidian: read_types(&root.join(OBSIDIAN_FILE), PropertyType::parse_obsidian),
        }
    }

    /// The recorded type of `name`, if any, and whose record it is.
    pub fn recorded(&self, name: &str) -> Option<(PropertyType, TypeSource)> {
        let key = normalize(name);
        self.writer
            .get(&key)
            .map(|r| (r.ty, TypeSource::Writer))
            .or_else(|| {
                self.obsidian
                    .get(&key)
                    .map(|r| (r.ty, TypeSource::Obsidian))
            })
    }

    /// The recorded values of an enum property (empty for any other type).
    pub fn values(&self, name: &str) -> &[String] {
        self.writer
            .get(&normalize(name))
            .map_or(&[], |r| r.values.as_slice())
    }

    /// Every recorded name (lower-cased), Writer's and Obsidian's.
    pub fn names(&self) -> impl Iterator<Item = &String> {
        self.writer.keys().chain(self.obsidian.keys())
    }

    /// The type of `name`: the recorded one, else inferred from `observed` (value type -> notes).
    pub fn resolve(
        &self,
        name: &str,
        observed: &BTreeMap<String, i64>,
    ) -> (PropertyType, TypeSource) {
        self.recorded(name)
            .unwrap_or_else(|| (infer(name, observed), TypeSource::Inferred))
    }
}

/// Type of a property with no record: `tags`/`aliases` are special names; a property whose every
/// non-empty value is a wikilink or a list of wikilinks (`link` / `links`) is `relationships`
/// (empty values are neutral, one plain-text note breaks it); otherwise the most common observed
/// value type (`bool` -> checkbox, `number`, `date`, `datetime`, `list` ->
/// multitext, everything else text).
pub fn infer(name: &str, observed: &BTreeMap<String, i64>) -> PropertyType {
    match normalize(name).as_str() {
        "tags" | "tag" => return PropertyType::Tags,
        "aliases" | "alias" => return PropertyType::Aliases,
        _ => {}
    }
    let mut non_empty = observed.keys().filter(|t| t.as_str() != "null").peekable();
    if non_empty.peek().is_some() && non_empty.all(|t| t == "link" || t == "links") {
        return PropertyType::Relationships;
    }
    // Ties resolve to the first type in name order, so the answer is deterministic.
    let best = observed.iter().filter(|(t, _)| t.as_str() != "null").fold(
        None::<(&String, i64)>,
        |acc, (t, n)| match acc {
            Some((_, m)) if m >= *n => acc,
            _ => Some((t, *n)),
        },
    );
    match best.map(|(t, _)| t.as_str()) {
        Some("number") => PropertyType::Number,
        Some("bool") => PropertyType::Checkbox,
        Some("date") => PropertyType::Date,
        Some("datetime") => PropertyType::Datetime,
        Some("list") => PropertyType::Multitext,
        _ => PropertyType::Text,
    }
}

/// Refine the index's value-type counts for type inference: a list value made only of wikilinks
/// moves from `list` to the synthetic `links`, an empty list from `list` to `null` (neutral).
/// Read-only: the index schema and `index_properties` stay as they are.
pub fn refine_list_shapes(counts: &mut [PropertyCount], shapes: &[crate::index::ListShape]) {
    for shape in shapes {
        let Some(c) = counts.iter_mut().find(|c| c.key == shape.key) else {
            continue;
        };
        let list = c.types.get("list").copied().unwrap_or(0);
        let moved_links = shape.links_only.min(list);
        let moved_empty = shape.empty.min(list - moved_links);
        for (name, n) in [("links", moved_links), ("null", moved_empty)] {
            if n > 0 {
                *c.types.entry(name.into()).or_insert(0) += n;
            }
        }
        match list - moved_links - moved_empty {
            0 => {
                c.types.remove("list");
            }
            rest => {
                c.types.insert("list".into(), rest);
            }
        }
    }
}

/// One vault property with its effective type and how well the notes' values fit it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyTypeInfo {
    /// The name as first seen in the vault (or the recorded, lower-cased one).
    pub key: String,
    /// Notes defining the property.
    pub count: i64,
    /// Observed value types (`text`, `number`, `bool`, ...) with their note counts.
    pub types: BTreeMap<String, i64>,
    #[serde(rename = "type")]
    pub ty: PropertyType,
    pub source: TypeSource,
    /// Notes whose value does not fit `ty` (they show the unknown/mixed state; never rewritten).
    pub mismatched: i64,
    /// The type name Obsidian and its plugins know `ty` by (`relationships` is `multitext` when
    /// the vault holds lists of links under this name, else `text`).
    pub obsidian_type: &'static str,
    /// An enum's allowed values, in order (empty for any other type).
    pub values: Vec<String>,
}

/// The vault's properties (from the index counts, merged case-insensitively) plus every recorded
/// name no note uses yet, each with its effective type.
pub fn report(root: &Path, counts: Vec<PropertyCount>) -> Vec<PropertyTypeInfo> {
    let table = TypeTable::load(root);
    let mut merged: BTreeMap<String, (String, i64, BTreeMap<String, i64>)> = BTreeMap::new();
    for c in counts {
        let e = merged
            .entry(normalize(&c.key))
            .or_insert_with(|| (c.key.clone(), 0, BTreeMap::new()));
        e.1 += c.count;
        for (t, n) in c.types {
            *e.2.entry(t).or_insert(0) += n;
        }
    }
    for name in table.names() {
        merged
            .entry(name.clone())
            .or_insert_with(|| (name.clone(), 0, BTreeMap::new()));
    }
    merged
        .into_iter()
        .map(|(norm, (key, count, types))| {
            let (ty, source) = table.resolve(&norm, &types);
            let mismatched = types
                .iter()
                .filter(|(t, _)| !ty.fits(t))
                .map(|(_, n)| n)
                .sum();
            let multi = types.contains_key("links") || types.contains_key("list");
            PropertyTypeInfo {
                key,
                count,
                types,
                ty,
                source,
                mismatched,
                obsidian_type: ty.obsidian_name(multi),
                values: table.values(&norm).to_vec(),
            }
        })
        .collect()
}

/// Record `ty` for `name` vault-wide in Writer's own file (atomic replace; creates `.writer`).
/// The only write of this module: the path is built from `root` alone and checked to stay inside
/// it, never `.obsidian`.
///
/// `values` only matters for [`PropertyType::Enum`] (any other type drops them): the given list
/// replaces the recorded one; without it a recorded enum keeps its values, else `observed` (the
/// property's distinct values with their note counts) seeds them ([`seed_values`]). Notes are
/// never touched.
pub fn set_type(
    root: &Path,
    name: &str,
    ty: PropertyType,
    values: Option<Vec<String>>,
    observed: Vec<(String, i64)>,
) -> Result<(), PropertyTypeError> {
    let key = normalize(name);
    if key.is_empty() || key.contains(['\n', '\r']) {
        return Err(PropertyTypeError::Invalid(
            "a property name must be one non-empty line".into(),
        ));
    }
    let dir = writer_dir(root)?;
    let mut file = match std::fs::read(dir.join("property-types.json")) {
        Ok(bytes) => serde_json::from_slice::<TypesFile>(&bytes).map_err(|e| {
            PropertyTypeError::Invalid(format!("{WRITER_FILE} is not valid JSON: {e}"))
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => TypesFile::default(),
        Err(e) => return Err(PropertyTypeError::Io(e.to_string())),
    };
    let values = if ty == PropertyType::Enum {
        match values {
            Some(v) => clean_values(v),
            None => match file
                .types
                .get(&key)
                .and_then(|e| Recorded::from_entry(e, PropertyType::parse))
            {
                Some(r) if r.ty == PropertyType::Enum => r.values,
                _ => seed_values(observed),
            },
        }
    } else {
        Vec::new()
    };
    file.types.insert(key, Recorded { ty, values }.to_entry());
    let mut body =
        serde_json::to_string_pretty(&file).map_err(|e| PropertyTypeError::Io(e.to_string()))?;
    body.push('\n');
    crate::plugins::write_atomic(&dir, "property-types.json", body.as_bytes())
        .map_err(PropertyTypeError::Io)
}

/// `<root>/.writer`, created, and proven to resolve inside the vault (a symlinked `.writer`
/// pointing elsewhere is refused).
fn writer_dir(root: &Path) -> Result<PathBuf, PropertyTypeError> {
    let io = |e: std::io::Error| PropertyTypeError::Io(e.to_string());
    let dir = root.join(".writer");
    std::fs::create_dir_all(&dir).map_err(io)?;
    let canonical = dir.canonicalize().map_err(io)?;
    let root = root.canonicalize().map_err(io)?;
    if canonical != root.join(".writer") {
        return Err(PropertyTypeError::Invalid(
            ".writer must be a folder inside the vault".into(),
        ));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn files(root: &Path) -> Vec<String> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, root, out);
                } else {
                    out.push(
                        p.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }

    fn obs(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn obsidian_types_are_read_and_writers_record_wins() {
        let v = tempfile::tempdir().unwrap();
        write(
            v.path(),
            ".obsidian/types.json",
            r#"{"types":{"Status":"text","due":"date","weird":"fancy","n":"number"}}"#,
        );
        let t = TypeTable::load(v.path());
        assert_eq!(
            t.recorded("status"),
            Some((PropertyType::Text, TypeSource::Obsidian))
        );
        assert_eq!(
            t.recorded("DUE"),
            Some((PropertyType::Date, TypeSource::Obsidian))
        );
        assert_eq!(
            t.recorded("weird"),
            None,
            "unknown Obsidian types are skipped"
        );
        set_type(v.path(), "due", PropertyType::Datetime, None, vec![]).unwrap();
        let t = TypeTable::load(v.path());
        assert_eq!(
            t.recorded("due"),
            Some((PropertyType::Datetime, TypeSource::Writer))
        );
        assert_eq!(
            t.recorded("n"),
            Some((PropertyType::Number, TypeSource::Obsidian))
        );
    }

    #[test]
    fn set_type_writes_only_the_writer_file_and_never_touches_obsidian() {
        let v = tempfile::tempdir().unwrap();
        let obsidian = r#"{"types":{"due":"date"}}"#;
        write(v.path(), ".obsidian/types.json", obsidian);
        write(v.path(), "note.md", "---\ndue: 2026-01-01\n---\n");
        let before = files(v.path());
        set_type(v.path(), "Due", PropertyType::Text, None, vec![]).unwrap();
        set_type(v.path(), "other", PropertyType::Number, None, vec![]).unwrap();
        let after = files(v.path());
        let added: Vec<_> = after.iter().filter(|f| !before.contains(f)).collect();
        assert_eq!(added, vec![WRITER_FILE]);
        assert_eq!(after.len(), before.len() + 1, "no temp file is left behind");
        assert!(after.iter().filter(|f| f.starts_with(".obsidian")).count() == 1);
        assert_eq!(
            std::fs::read_to_string(v.path().join(OBSIDIAN_FILE)).unwrap(),
            obsidian
        );
        let written = std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap();
        assert!(written.contains("\"due\": \"text\"") && written.contains("\"other\": \"number\""));
    }

    #[test]
    fn set_type_refuses_bad_names_and_a_broken_record() {
        let v = tempfile::tempdir().unwrap();
        assert!(set_type(v.path(), "  ", PropertyType::Text, None, vec![]).is_err());
        assert!(set_type(v.path(), "a\nb", PropertyType::Text, None, vec![]).is_err());
        assert!(
            !v.path().join(".writer").exists(),
            "nothing written for a refused name"
        );
        write(v.path(), WRITER_FILE, "{ not json");
        assert!(set_type(v.path(), "a", PropertyType::Text, None, vec![]).is_err());
        assert_eq!(
            std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap(),
            "{ not json"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_writer_folder_is_refused() {
        let v = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(out.path(), v.path().join(".writer")).unwrap();
        assert!(set_type(v.path(), "a", PropertyType::Text, None, vec![]).is_err());
        assert!(files(out.path()).is_empty());
    }

    #[test]
    fn inference_from_values_and_special_names() {
        assert_eq!(infer("x", &obs(&[("bool", 3)])), PropertyType::Checkbox);
        assert_eq!(
            infer("x", &obs(&[("number", 3), ("text", 1)])),
            PropertyType::Number
        );
        assert_eq!(infer("x", &obs(&[("date", 2)])), PropertyType::Date);
        assert_eq!(infer("x", &obs(&[("datetime", 2)])), PropertyType::Datetime);
        assert_eq!(infer("x", &obs(&[("list", 2)])), PropertyType::Multitext);
        assert_eq!(
            infer("x", &obs(&[("link", 2)])),
            PropertyType::Relationships,
            "a wikilink-only property is relationships"
        );
        assert_eq!(infer("x", &obs(&[("null", 5)])), PropertyType::Text);
        assert_eq!(infer("x", &obs(&[])), PropertyType::Text);
        assert_eq!(infer("Tags", &obs(&[("text", 9)])), PropertyType::Tags);
        assert_eq!(infer("aliases", &obs(&[])), PropertyType::Aliases);
    }

    #[test]
    fn fits_marks_values_that_do_not_match_the_type() {
        assert!(PropertyType::Number.fits("number") && PropertyType::Number.fits("null"));
        assert!(!PropertyType::Number.fits("text"));
        assert!(PropertyType::Text.fits("link") && !PropertyType::Text.fits("list"));
        assert!(PropertyType::Tags.fits("list") && !PropertyType::Checkbox.fits("number"));
    }

    fn count(key: &str, types: &[(&str, i64)]) -> PropertyCount {
        PropertyCount {
            key: key.into(),
            count: types.iter().map(|(_, n)| n).sum(),
            types: obs(types),
        }
    }

    #[test]
    fn report_merges_case_counts_mismatches_and_lists_unused_recorded_names() {
        let v = tempfile::tempdir().unwrap();
        write(
            v.path(),
            ".obsidian/types.json",
            r#"{"types":{"rating":"number","unused":"checkbox"}}"#,
        );
        let r = report(
            v.path(),
            vec![
                count("Rating", &[("number", 3), ("text", 2)]),
                count("rating", &[("number", 1)]),
                count("done", &[("bool", 2)]),
            ],
        );
        let rating = r.iter().find(|p| p.key == "Rating").unwrap();
        assert_eq!(
            (rating.count, rating.mismatched, rating.ty),
            (6, 2, PropertyType::Number)
        );
        assert_eq!(rating.source, TypeSource::Obsidian);
        let done = r.iter().find(|p| p.key == "done").unwrap();
        assert_eq!(
            (done.ty, done.source, done.mismatched),
            (PropertyType::Checkbox, TypeSource::Inferred, 0)
        );
        let unused = r.iter().find(|p| p.key == "unused").unwrap();
        assert_eq!((unused.count, unused.ty), (0, PropertyType::Checkbox));
        set_type(v.path(), "rating", PropertyType::Text, None, vec![]).unwrap();
        let r = report(
            v.path(),
            vec![count("Rating", &[("number", 3), ("text", 2)])],
        );
        let rating = r.iter().find(|p| p.key == "Rating").unwrap();
        assert_eq!(
            (rating.ty, rating.source, rating.mismatched),
            (PropertyType::Text, TypeSource::Writer, 3)
        );
    }

    #[test]
    fn relationships_round_trips_and_is_writers_own_name() {
        assert_eq!(
            PropertyType::parse("relationships"),
            Some(PropertyType::Relationships)
        );
        assert_eq!(
            serde_json::to_string(&PropertyType::Relationships).unwrap(),
            "\"relationships\""
        );
        assert_eq!(
            serde_json::from_str::<PropertyType>("\"relationships\"").unwrap(),
            PropertyType::Relationships
        );
        // Obsidian's own file never yields it; plugins see multitext / text.
        assert_eq!(PropertyType::parse_obsidian("relationships"), None);
        assert_eq!(
            PropertyType::parse_obsidian("multitext"),
            Some(PropertyType::Multitext)
        );
        assert_eq!(PropertyType::Relationships.obsidian_name(true), "multitext");
        assert_eq!(PropertyType::Relationships.obsidian_name(false), "text");
        assert_eq!(PropertyType::Number.obsidian_name(true), "number");
    }

    #[test]
    fn relationships_in_obsidian_types_json_is_skipped_and_never_written_there() {
        let v = tempfile::tempdir().unwrap();
        let obsidian = r#"{"types":{"team":"relationships","tags2":"multitext"}}"#;
        write(v.path(), ".obsidian/types.json", obsidian);
        let t = TypeTable::load(v.path());
        assert_eq!(t.recorded("team"), None);
        assert_eq!(
            t.recorded("tags2"),
            Some((PropertyType::Multitext, TypeSource::Obsidian))
        );
        set_type(v.path(), "team", PropertyType::Relationships, None, vec![]).unwrap();
        let t = TypeTable::load(v.path());
        assert_eq!(
            t.recorded("team"),
            Some((PropertyType::Relationships, TypeSource::Writer))
        );
        let written = std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap();
        assert!(written.contains("\"team\": \"relationships\""));
        assert_eq!(
            std::fs::read_to_string(v.path().join(OBSIDIAN_FILE)).unwrap(),
            obsidian
        );
        assert_eq!(files(v.path()), vec![OBSIDIAN_FILE, WRITER_FILE]);
    }

    #[test]
    fn relationships_fits_single_list_empty_and_not_mixed() {
        let r = PropertyType::Relationships;
        assert!(r.fits("link") && r.fits("links") && r.fits("null"));
        assert!(!r.fits("text") && !r.fits("list") && !r.fits("number"));
        // a list of links is a valid List, a single link a valid Text
        assert!(PropertyType::Multitext.fits("links") && PropertyType::Multitext.fits("list"));
        assert!(PropertyType::Text.fits("link") && !PropertyType::Text.fits("links"));
    }

    #[test]
    fn wikilink_only_properties_infer_relationships_and_one_text_note_flips_it() {
        let rel = PropertyType::Relationships;
        // single values, lists, and a mix of both across notes
        assert_eq!(infer("manager", &obs(&[("link", 3)])), rel);
        assert_eq!(infer("team", &obs(&[("links", 2)])), rel);
        assert_eq!(infer("people", &obs(&[("link", 2), ("links", 1)])), rel);
        // empty values are neutral
        assert_eq!(infer("team", &obs(&[("links", 1), ("null", 4)])), rel);
        assert_eq!(infer("team", &obs(&[("null", 4)])), PropertyType::Text);
        // one plain-text note (or a mixed list) breaks it
        assert_ne!(infer("manager", &obs(&[("link", 3), ("text", 1)])), rel);
        assert_ne!(infer("team", &obs(&[("links", 3), ("list", 1)])), rel);
        // tags / aliases keep their special names
        assert_eq!(infer("tags", &obs(&[("links", 3)])), PropertyType::Tags);
    }

    #[test]
    fn refine_moves_link_lists_and_empty_lists_out_of_list() {
        let mut counts = vec![
            count("team", &[("list", 5), ("link", 1)]),
            count("other", &[("list", 2)]),
        ];
        let shapes = vec![
            crate::index::ListShape {
                key: "team".into(),
                empty: 2,
                links_only: 3,
            },
            crate::index::ListShape {
                key: "gone".into(),
                empty: 1,
                links_only: 0,
            },
        ];
        refine_list_shapes(&mut counts, &shapes);
        assert_eq!(
            counts[0].types,
            obs(&[("link", 1), ("links", 3), ("null", 2)])
        );
        assert_eq!(counts[1].types, obs(&[("list", 2)]));
    }

    #[test]
    fn report_over_a_real_index_infers_relationships_and_a_record_overrides_it() {
        let v = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(v.path(), "A.md", "---\nmanager: \"[[B]]\"\nteam:\n  - \"[[B|Bee]]\"\n  - \"[[f/B#Top]]\"\nmixed:\n  - \"[[B]]\"\n  - plain\nempty: []\n---\n");
        write(
            v.path(),
            "B.md",
            "---\nmanager: [[A]]\nteam: \"[[A]]\"\nempty: []\n---\n",
        );
        write(v.path(), "C.md", "---\nmixed: \"[[A]]\"\nteam: []\n---\n");
        let index = crate::index::Index::open_for_cli(v.path(), Some(data.path())).unwrap();
        index.refresh_blocking().unwrap();
        let run = || {
            let mut counts = index.properties().unwrap();
            let shapes = index.list_shapes().unwrap();
            refine_list_shapes(&mut counts, &shapes);
            report(v.path(), counts)
        };
        let get = |r: &[PropertyTypeInfo], k: &str| r.iter().find(|p| p.key == k).cloned().unwrap();
        let r = run();
        assert_eq!(get(&r, "manager").ty, PropertyType::Relationships);
        assert_eq!(get(&r, "manager").source, TypeSource::Inferred);
        assert_eq!(
            get(&r, "team").ty,
            PropertyType::Relationships,
            "single + list + empty"
        );
        assert_eq!(
            get(&r, "manager").obsidian_type,
            "text",
            "single links: text"
        );
        assert_eq!(
            get(&r, "team").obsidian_type,
            "multitext",
            "lists of links: multitext"
        );
        let mixed = get(&r, "mixed");
        assert_ne!(
            mixed.ty,
            PropertyType::Relationships,
            "a plain item breaks it"
        );
        assert!(mixed.mismatched > 0, "the mixed state is reported");
        assert_eq!(
            get(&r, "empty").ty,
            PropertyType::Text,
            "empty is neutral, not relationships"
        );
        // a recorded type wins; inference never writes the record
        assert!(!v.path().join(WRITER_FILE).exists());
        set_type(v.path(), "manager", PropertyType::Text, None, vec![]).unwrap();
        let r = run();
        assert_eq!(get(&r, "manager").ty, PropertyType::Text);
        assert_eq!(get(&r, "manager").source, TypeSource::Writer);
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn enum_values_round_trip_in_writers_file_and_other_entries_stay_bare() {
        let v = tempfile::tempdir().unwrap();
        set_type(
            v.path(),
            "Status",
            PropertyType::Enum,
            Some(strings(&["todo", " doing ", "", "done", "todo"])),
            vec![],
        )
        .unwrap();
        set_type(v.path(), "n", PropertyType::Number, None, vec![]).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap())
                .unwrap();
        assert_eq!(
            raw["types"]["status"],
            serde_json::json!({"type": "enum", "values": ["todo", "doing", "done"]})
        );
        assert_eq!(raw["types"]["n"], "number");
        let t = TypeTable::load(v.path());
        assert_eq!(
            t.recorded("STATUS"),
            Some((PropertyType::Enum, TypeSource::Writer))
        );
        assert_eq!(t.values("status"), ["todo", "doing", "done"]);
        assert!(t.values("n").is_empty());
    }

    #[test]
    fn old_entries_without_values_and_unknown_entries_survive_a_rewrite() {
        let v = tempfile::tempdir().unwrap();
        write(
            v.path(),
            WRITER_FILE,
            r#"{"types":{"a":"text","b":{"type":"enum"},"c":{"type":"fancy","x":1}}}"#,
        );
        let t = TypeTable::load(v.path());
        assert_eq!(t.recorded("a").unwrap().0, PropertyType::Text);
        assert_eq!(t.recorded("b").unwrap().0, PropertyType::Enum);
        assert!(t.values("b").is_empty());
        assert_eq!(t.recorded("c"), None);
        set_type(v.path(), "d", PropertyType::Text, None, vec![]).unwrap();
        let raw = std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap();
        assert!(raw.contains("\"fancy\""), "unknown entry preserved: {raw}");
    }

    #[test]
    fn an_obsidian_enum_entry_is_skipped_and_enum_reads_as_text_for_plugins() {
        let v = tempfile::tempdir().unwrap();
        write(
            v.path(),
            ".obsidian/types.json",
            r#"{"types":{"status":"enum"}}"#,
        );
        assert_eq!(TypeTable::load(v.path()).recorded("status"), None);
        assert_eq!(PropertyType::Enum.obsidian_name(false), "text");
        assert_eq!(PropertyType::Enum.obsidian_name(true), "text");
        assert!(PropertyType::Enum.is_writer_only());
        assert!(!PropertyType::Text.is_writer_only());
        // never inferred
        assert_eq!(infer("status", &obs(&[("text", 5)])), PropertyType::Text);
    }

    #[test]
    fn converting_to_enum_seeds_by_frequency_then_name_and_keeps_existing_values() {
        let v = tempfile::tempdir().unwrap();
        let observed = vec![
            ("done".to_string(), 5),
            ("blocked".to_string(), 1),
            ("todo".to_string(), 5),
            ("doing".to_string(), 2),
            ("  ".to_string(), 9),
        ];
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            None,
            observed.clone(),
        )
        .unwrap();
        let t = TypeTable::load(v.path());
        assert_eq!(t.values("status"), ["done", "todo", "doing", "blocked"]);
        // choosing Enum again does not reseed a curated list
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["a", "b"])),
            vec![],
        )
        .unwrap();
        set_type(v.path(), "status", PropertyType::Enum, None, observed).unwrap();
        assert_eq!(TypeTable::load(v.path()).values("status"), ["a", "b"]);
        // converting away drops the list; converting back seeds again
        set_type(v.path(), "status", PropertyType::Text, None, vec![]).unwrap();
        let raw = std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap();
        assert!(raw.contains("\"status\": \"text\"") && !raw.contains("values"));
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            None,
            vec![("x".into(), 1)],
        )
        .unwrap();
        assert_eq!(TypeTable::load(v.path()).values("status"), ["x"]);
    }

    #[test]
    fn report_carries_enum_values_and_counts_only_non_text_values_as_mismatched() {
        let v = tempfile::tempdir().unwrap();
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["todo", "done"])),
            vec![],
        )
        .unwrap();
        let counts = vec![PropertyCount {
            key: "Status".into(),
            count: 3,
            types: obs(&[("text", 2), ("number", 1)]),
        }];
        let r = report(v.path(), counts);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].ty, PropertyType::Enum);
        assert_eq!(r[0].values, ["todo", "done"]);
        assert_eq!(r[0].mismatched, 1);
        assert_eq!(r[0].obsidian_type, "text");
        let json = serde_json::to_value(&r[0]).unwrap();
        assert_eq!(json["type"], "enum");
        assert_eq!(json["values"], serde_json::json!(["todo", "done"]));
    }
}
