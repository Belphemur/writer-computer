//! The one source of truth for property types of a vault (spec: `SPECs/properties-types-spec.md`).
//!
//! Like Obsidian, a property name has ONE type across the vault. Two records feed it:
//!
//! - `.obsidian/types.json` (`{"types": {name: type}}`), read-only: an Obsidian vault's types show
//!   up immediately. Writer never writes it.
//! - `.writer/property-types.json`, same format, Writer's own record and the only file this module
//!   writes. It wins over Obsidian's. An `enum` entry is an object carrying its ordered values
//!   (`{"type": "enum", "values": [...]}`); every other entry is a bare type string. Any entry may
//!   also carry `"pinned": <n>` (the panel shows the property in its collapsed header, `n` is its
//!   place among the pinned ones, 0 first; see [`set_pinned`]); a property pinned before it has a
//!   declared type is `{"pinned": n}` alone and its type stays inferred. Keys this build does not
//!   know are kept as they are.
//!
//! With no record, the type is inferred from the observed values (the index's `props.vtype`
//! counts; a property whose every non-empty value is a wikilink or a list of wikilinks is
//! `relationships`, see [`refine_list_shapes`]; a property whose values are maps is `object`; one
//! whose every value is a URL, see [`refine_url_shapes`], is `url`).
//! Tauri-free: the Tauri commands, the Bases property pickers and the plugin host's
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
/// Writer's own `relationships` (a link or a list of links), `enum` (one string of a recorded
/// list), `object` (a map, edited as indented rows up to two levels) and `url` (a web address
/// or a list of them, shown as link chips). Obsidian has none of them: they are stored only in `.writer/property-types.json`, an `.obsidian/types.json` entry of
/// that name is skipped, and plugins see them as `multitext` / `text`
/// ([`PropertyType::obsidian_name`]).
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
    Object,
    Url,
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
            "object" => PropertyType::Object,
            "url" => PropertyType::Url,
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
            PropertyType::Object => "object",
            PropertyType::Url => "url",
        }
    }

    /// Types Obsidian does not have: recorded only in Writer's own file.
    pub fn is_writer_only(self) -> bool {
        matches!(
            self,
            PropertyType::Relationships
                | PropertyType::Enum
                | PropertyType::Object
                | PropertyType::Url
        )
    }

    /// Parse a type name from Obsidian's `types.json`: Obsidian has no Writer-only type.
    pub fn parse_obsidian(s: &str) -> Option<PropertyType> {
        PropertyType::parse(s).filter(|t| !t.is_writer_only())
    }

    /// The type name Obsidian (and so a plugin) knows this type by: `relationships` is a
    /// `multitext` or a `text` (`multi` is whether the property holds lists, as for `url`); `enum`
    /// and `object` are a `text`.
    pub fn obsidian_name(self, multi: bool) -> &'static str {
        match self {
            PropertyType::Relationships | PropertyType::Url if multi => "multitext",
            PropertyType::Relationships
            | PropertyType::Enum
            | PropertyType::Object
            | PropertyType::Url => "text",
            other => other.wire_name(),
        }
    }

    /// Whether an indexed value type (`props.vtype`, plus the synthetic `links` of
    /// [`refine_list_shapes`] (a list of wikilinks only) and `url` / `urls` of
    /// [`refine_url_shapes`] (a text that is a URL, a list of URLs only)) is a valid value of this
    /// type. A `url` property fits any text or list: a value that is no URL is marked per value,
    /// never refused.
    /// A property without a value (`null`) fits every type.
    pub fn fits(self, vtype: &str) -> bool {
        matches!(
            (self, vtype),
            (_, "null")
                | (PropertyType::Text, "text" | "link" | "url")
                | (PropertyType::Enum, "text" | "url")
                | (PropertyType::Url, "text" | "url" | "list" | "urls")
                | (PropertyType::Object, "object")
                | (PropertyType::Number, "number")
                | (PropertyType::Checkbox, "bool")
                | (PropertyType::Date, "date")
                | (PropertyType::Datetime, "datetime")
                | (
                    PropertyType::Multitext | PropertyType::Tags | PropertyType::Aliases,
                    "list" | "links" | "urls"
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

/// One recorded type: the type and, for an enum, its ordered values and the optional icon of some
/// of them (`emoji:<emoji>` or `icon:<Hugeicons name>`, see [`valid_icon`]).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Recorded {
    ty: PropertyType,
    values: Vec<String>,
    icons: BTreeMap<String, String>,
}

impl Recorded {
    /// A bare type string, or `{"type": ..., "values": [...]}`. Unknown or invalid entries give
    /// `None` (an Obsidian vault may carry types Writer does not know).
    fn from_entry(
        entry: &serde_json::Value,
        parse: fn(&str) -> Option<PropertyType>,
    ) -> Option<Recorded> {
        let (name, values, icons) = match entry {
            serde_json::Value::String(s) => (s.as_str(), None, None),
            serde_json::Value::Object(o) => {
                (o.get("type")?.as_str()?, o.get("values"), o.get("icons"))
            }
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
        // an icon of a value the list lacks, or one that is malformed, is skipped, not an error
        let icons = match icons {
            Some(serde_json::Value::Object(o)) if ty == PropertyType::Enum => o
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                .filter(|(k, v)| values.contains(k) && valid_icon(v))
                .collect(),
            _ => BTreeMap::new(),
        };
        Some(Recorded { ty, values, icons })
    }

    /// The entry as stored: a bare string, except an enum, which carries its values.
    fn to_entry(&self) -> serde_json::Value {
        if self.ty == PropertyType::Enum {
            let mut entry = serde_json::json!({"type": self.ty.wire_name(), "values": self.values});
            if !self.icons.is_empty() {
                entry["icons"] = serde_json::json!(self.icons);
            }
            entry
        } else {
            serde_json::Value::String(self.ty.wire_name().to_owned())
        }
    }
}

/// Whether `value` is an icon Writer stores for an enum value: `emoji:` and exactly one emoji, or
/// `icon:` and a Hugeicons export name (`[A-Z][A-Za-z0-9]*Icon`, at most 64 characters). The twin
/// of `src/lib/icon-picker/icon-value.ts` (`shared/icon-value-vectors.json` pins both). The emoji
/// check is an approximation of "one grapheme holding an emoji" without a segmentation table: one
/// cluster (modifiers, variation selectors, ZWJ joins, keycap, tags and a flag pair stay in it),
/// no whitespace or control character, at least one character from an emoji block.
pub fn valid_icon(value: &str) -> bool {
    if value.len() > 80 {
        return false;
    }
    if let Some(name) = value.strip_prefix("icon:") {
        let mut chars = name.chars();
        return name.len() <= 64
            && name.ends_with("Icon")
            && chars.next().is_some_and(|c| c.is_ascii_uppercase())
            && name.chars().all(|c| c.is_ascii_alphanumeric());
    }
    let Some(emoji) = value.strip_prefix("emoji:") else {
        return false;
    };
    let is_mark = |c: char| {
        matches!(c as u32,
            0xA9 | 0xAE | 0x203C..=0x3299 | 0x1F000..=0x1FAFF)
    };
    emoji.chars().any(is_mark)
        && !emoji.chars().any(|c| c.is_whitespace() || c.is_control())
        && emoji_clusters(emoji) == 1
}

/// How many emoji clusters `text` holds (see [`valid_icon`]).
fn emoji_clusters(text: &str) -> usize {
    let is_ri = |c: char| matches!(c as u32, 0x1F1E6..=0x1F1FF);
    let mut clusters = 0;
    let mut prev: Option<char> = None;
    let mut ri_run = 0;
    for c in text.chars() {
        let joins = matches!(c as u32,
            0x200D | 0xFE0F | 0x20E3 | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F)
            || prev == Some('\u{200D}');
        let flag_pair = is_ri(c) && ri_run == 1;
        if !joins && !flag_pair {
            clusters += 1;
        }
        ri_run = if is_ri(c) { ri_run + 1 } else { 0 };
        prev = Some(c);
    }
    clusters
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

/// The `pinned` place of a raw entry (a non-negative integer), if it has one.
fn pinned_of(entry: &serde_json::Value) -> Option<u32> {
    entry
        .get("pinned")?
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
}

/// The pins of Writer's file, leniently (a broken file has none).
fn read_pins(path: &Path) -> BTreeMap<String, u32> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    let Ok(file) = serde_json::from_slice::<TypesFile>(&bytes) else {
        return BTreeMap::new();
    };
    file.types
        .iter()
        .filter_map(|(k, v)| Some((normalize(k), pinned_of(v)?)))
        .collect()
}

/// Keys of an entry that [`Recorded`] owns; every other key (`pinned`, one a later build adds)
/// is carried over when the type is rewritten.
const OWNED_KEYS: [&str; 3] = ["type", "values", "icons"];

/// `new` (a freshly built entry) plus every key of `old` it does not own. A bare type string
/// becomes an object when there is something to carry.
fn carry_extras(old: Option<&serde_json::Value>, new: serde_json::Value) -> serde_json::Value {
    let extras: Vec<_> = old
        .and_then(|o| o.as_object())
        .into_iter()
        .flatten()
        .filter(|(k, _)| !OWNED_KEYS.contains(&k.as_str()))
        .collect();
    if extras.is_empty() {
        return new;
    }
    let mut object = match new {
        serde_json::Value::String(ty) => serde_json::json!({ "type": ty }),
        other => other,
    };
    for (k, v) in extras {
        object[k] = v.clone();
    }
    object
}

/// An entry left without anything to say collapses: only a `type` back to the bare string,
/// nothing at all to no entry.
fn tidy(entry: serde_json::Value) -> Option<serde_json::Value> {
    match &entry {
        serde_json::Value::Object(o) if o.is_empty() => None,
        serde_json::Value::Object(o) if o.len() == 1 => match o.get("type") {
            Some(t @ serde_json::Value::String(_)) => Some(t.clone()),
            _ => Some(entry),
        },
        _ => Some(entry),
    }
}

/// Both records of a vault, merged with Writer's winning.
#[derive(Debug, Default)]
pub struct TypeTable {
    writer: BTreeMap<String, Recorded>,
    obsidian: BTreeMap<String, Recorded>,
    /// Pinned properties (lower-cased name -> place), from Writer's record only.
    pins: BTreeMap<String, u32>,
}

impl TypeTable {
    pub fn load(root: &Path) -> TypeTable {
        TypeTable {
            writer: read_types(&root.join(WRITER_FILE), PropertyType::parse),
            obsidian: read_types(&root.join(OBSIDIAN_FILE), PropertyType::parse_obsidian),
            pins: read_pins(&root.join(WRITER_FILE)),
        }
    }

    /// The place of `name` among the pinned properties, if it is pinned.
    pub fn pinned(&self, name: &str) -> Option<u32> {
        self.pins.get(&normalize(name)).copied()
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

    /// The recorded icons of an enum property's values (empty for any other type).
    pub fn icons(&self, name: &str) -> BTreeMap<String, String> {
        self.writer
            .get(&normalize(name))
            .map(|r| r.icons.clone())
            .unwrap_or_default()
    }

    /// The enum properties Writer records (lower-cased name) with their current values.
    pub fn enums(&self) -> impl Iterator<Item = (&String, &[String])> {
        self.writer
            .iter()
            .filter(|(_, r)| r.ty == PropertyType::Enum)
            .map(|(k, r)| (k, r.values.as_slice()))
    }

    /// Every recorded name (lower-cased), Writer's and Obsidian's.
    pub fn names(&self) -> impl Iterator<Item = &String> {
        self.writer
            .keys()
            .chain(self.obsidian.keys())
            .chain(self.pins.keys())
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
/// (empty values are neutral, one plain-text note breaks it); likewise `url` for a property whose
/// every non-empty value is a URL or a list of URLs (`url` / `urls`, see [`refine_url_shapes`]);
/// otherwise the most common observed
/// value type (`bool` -> checkbox, `number`, `date`, `datetime`, `list` ->
/// multitext, `object` -> object, everything else text).
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
    let mut non_empty = observed.keys().filter(|t| t.as_str() != "null").peekable();
    if non_empty.peek().is_some() && non_empty.all(|t| t == "url" || t == "urls") {
        return PropertyType::Url;
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
        Some("list" | "urls") => PropertyType::Multitext,
        Some("object") => PropertyType::Object,
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

/// Refine the counts for type inference once more: a text value that is a URL
/// ([`crate::url_value::is_url`]) moves from `text` to the synthetic `url`, a list made only of
/// URLs from `list` to `urls`. Inference then types a property `url` when nothing else is
/// observed. Read-only, like [`refine_list_shapes`] (run it after that one).
pub fn refine_url_shapes(counts: &mut [PropertyCount], shapes: &[crate::index::UrlShape]) {
    for shape in shapes {
        let Some(c) = counts.iter_mut().find(|c| c.key == shape.key) else {
            continue;
        };
        for (from, to, moved) in [
            ("text", "url", shape.urls),
            ("list", "urls", shape.url_lists),
        ] {
            let have = c.types.get(from).copied().unwrap_or(0);
            let n = moved.min(have);
            if n == 0 {
                continue;
            }
            *c.types.entry(to.into()).or_insert(0) += n;
            if have == n {
                c.types.remove(from);
            } else {
                c.types.insert(from.into(), have - n);
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
    /// An enum's optional value icons (`emoji:<emoji>` / `icon:<Hugeicons name>` by value).
    pub icons: BTreeMap<String, String>,
    /// The place among the pinned properties (0 first), `None` when not pinned.
    pub pinned: Option<u32>,
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
            let multi = ["links", "list", "urls"]
                .iter()
                .any(|t| types.contains_key(*t));
            PropertyTypeInfo {
                key,
                count,
                types,
                ty,
                source,
                mismatched,
                obsidian_type: ty.obsidian_name(multi),
                values: table.values(&norm).to_vec(),
                icons: table.icons(&norm),
                pinned: table.pinned(&norm),
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
    set_type_with_icons(root, name, ty, values, None, observed)
}

/// [`set_type`] with an enum's icons: `Some(map)` (value -> `emoji:..` / `icon:..`) replaces the
/// recorded icons, `None` keeps them. Either way an icon whose value is not in the final list is
/// dropped (a removed value loses its icon; a renamed one keeps it because the caller sends the
/// map under the new name); a malformed icon is refused. Any other type drops them. The one write
/// of the type record.
pub fn set_type_with_icons(
    root: &Path,
    name: &str,
    ty: PropertyType,
    values: Option<Vec<String>>,
    icons: Option<BTreeMap<String, String>>,
    observed: Vec<(String, i64)>,
) -> Result<(), PropertyTypeError> {
    if let Some(bad) = icons
        .iter()
        .flatten()
        .find(|(_, v)| !valid_icon(v))
        .map(|(k, _)| k)
    {
        return Err(PropertyTypeError::Invalid(format!(
            "the icon of \"{bad}\" is not an emoji or an icon name"
        )));
    }
    let key = normalize(name);
    if key.is_empty() || key.contains(['\n', '\r']) {
        return Err(PropertyTypeError::Invalid(
            "a property name must be one non-empty line".into(),
        ));
    }
    let dir = writer_dir(root)?;
    let mut file = read_file(&dir)?;
    let recorded = file
        .types
        .get(&key)
        .and_then(|e| Recorded::from_entry(e, PropertyType::parse))
        .filter(|r| r.ty == PropertyType::Enum);
    let (values, icons) = if ty == PropertyType::Enum {
        let values = match (values, &recorded) {
            (Some(v), _) => clean_values(v),
            (None, Some(r)) => r.values.clone(),
            (None, None) => seed_values(observed),
        };
        let icons = icons
            .or_else(|| recorded.map(|r| r.icons))
            .unwrap_or_default()
            .into_iter()
            .filter(|(k, _)| values.contains(k))
            .collect();
        (values, icons)
    } else {
        (Vec::new(), BTreeMap::new())
    };
    let entry = carry_extras(
        file.types.get(&key),
        Recorded { ty, values, icons }.to_entry(),
    );
    file.types.insert(key, entry);
    write_file(&dir, &file)
}

/// Writer's record as stored; a missing file is an empty one, an invalid one is refused.
fn read_file(dir: &Path) -> Result<TypesFile, PropertyTypeError> {
    match std::fs::read(dir.join("property-types.json")) {
        Ok(bytes) => serde_json::from_slice::<TypesFile>(&bytes).map_err(|e| {
            PropertyTypeError::Invalid(format!("{WRITER_FILE} is not valid JSON: {e}"))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(TypesFile::default()),
        Err(e) => Err(PropertyTypeError::Io(e.to_string())),
    }
}

/// Atomic replace of Writer's record: the one place the file is written.
fn write_file(dir: &Path, file: &TypesFile) -> Result<(), PropertyTypeError> {
    let mut body =
        serde_json::to_string_pretty(file).map_err(|e| PropertyTypeError::Io(e.to_string()))?;
    body.push('\n');
    crate::plugins::write_atomic(dir, "property-types.json", body.as_bytes())
        .map_err(PropertyTypeError::Io)
}

/// Pin (`true`) or unpin `name` vault-wide in Writer's own file: a pin takes the next place after
/// the existing ones, an unpin closes the gap so the places stay 0, 1, 2... A pin on a name with
/// no entry writes `{"pinned": n}` alone (its type stays inferred, or Obsidian's); pinning a
/// pinned name or unpinning a free one writes nothing. The rest of the entry (type, values, icons,
/// keys this build does not know) is untouched, and so is `.obsidian`.
pub fn set_pinned(root: &Path, name: &str, pinned: bool) -> Result<(), PropertyTypeError> {
    let key = normalize(name);
    if key.is_empty() || key.contains(['\n', '\r']) {
        return Err(PropertyTypeError::Invalid(
            "a property name must be one non-empty line".into(),
        ));
    }
    let dir = writer_dir(root)?;
    let mut file = read_file(&dir)?;
    // the file's keys are matched as the table reads them: lower-cased
    let stored = file.types.keys().find(|k| normalize(k) == key).cloned();
    let current = stored.as_ref().and_then(|k| pinned_of(&file.types[k]));
    if current.is_some() == pinned {
        return Ok(());
    }
    if pinned {
        let next = file
            .types
            .values()
            .filter_map(pinned_of)
            .max()
            .map_or(0, |n| n + 1);
        let k = stored.unwrap_or(key);
        let entry = file.types.remove(&k).unwrap_or(serde_json::json!({}));
        let mut object = match entry {
            serde_json::Value::String(ty) => serde_json::json!({ "type": ty }),
            other => other,
        };
        object["pinned"] = serde_json::json!(next);
        file.types.insert(k, object);
    } else if let Some(k) = stored {
        let mut object = file.types.remove(&k).unwrap_or_default();
        if let Some(o) = object.as_object_mut() {
            o.remove("pinned");
        }
        if let Some(entry) = tidy(object) {
            file.types.insert(k, entry);
        }
        // close the gap
        let mut order: Vec<(u32, String)> = file
            .types
            .iter()
            .filter_map(|(k, v)| Some((pinned_of(v)?, k.clone())))
            .collect();
        order.sort();
        for (place, (_, k)) in order.into_iter().enumerate() {
            file.types.get_mut(&k).unwrap()["pinned"] = serde_json::json!(place);
        }
    }
    write_file(&dir, &file)
}

/// Append to every enum property's list the text values the notes hold that the list lacks (the
/// one place an unlisted value is detected; run after an index update, see
/// `commands/index.rs`). `observed(name)` gives a property's distinct text values with their note
/// counts (the index's `text_values`): scalars only, so lists and non-text values are never
/// added. New values go after the existing ones (most used first, then by name), trimmed, one
/// line each. Idempotent: nothing to add writes nothing, so Writer's own write of the file never
/// starts another round. Returns the names that gained values. Notes are never touched.
pub fn sync_enum_values<E>(
    root: &Path,
    observed: impl Fn(&str) -> Result<Vec<(String, i64)>, E>,
) -> Result<Vec<String>, PropertyTypeError>
where
    E: std::fmt::Display,
{
    let table = TypeTable::load(root);
    let mut grown = Vec::new();
    for (name, current) in table.enums() {
        let seen = observed(name).map_err(|e| PropertyTypeError::Io(e.to_string()))?;
        let have: std::collections::HashSet<&str> = current.iter().map(String::as_str).collect();
        let fresh: Vec<String> = seed_values(seen)
            .into_iter()
            .filter(|v| !have.contains(v.as_str()))
            .collect();
        if fresh.is_empty() {
            continue;
        }
        let values = current.iter().cloned().chain(fresh).collect();
        set_type(root, name, PropertyType::Enum, Some(values), vec![])?;
        grown.push(name.clone());
    }
    Ok(grown)
}

/// `<root>/.writer`, created, and proven to resolve inside the vault (a symlinked `.writer`
/// pointing elsewhere is refused).
pub(crate) fn writer_dir(root: &Path) -> Result<PathBuf, PropertyTypeError> {
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

    #[test]
    fn object_is_inferred_from_maps_and_reads_as_text_for_plugins() {
        assert_eq!(
            infer("metadata", &obs(&[("object", 3)])),
            PropertyType::Object
        );
        assert_eq!(
            infer("metadata", &obs(&[("object", 2), ("null", 4)])),
            PropertyType::Object
        );
        let o = PropertyType::Object;
        assert!(o.fits("object") && o.fits("null") && !o.fits("text") && !o.fits("list"));
        assert!(!PropertyType::Text.fits("object"));
        assert_eq!(o.wire_name(), "object");
        assert_eq!(PropertyType::parse("object"), Some(o));
        assert!(o.is_writer_only());
        assert_eq!(o.obsidian_name(false), "text");
        assert_eq!(o.obsidian_name(true), "text");
        // Obsidian has no such type: its own file never yields it, and it is never written there
        let v = tempfile::tempdir().unwrap();
        write(
            v.path(),
            ".obsidian/types.json",
            r#"{"types":{"metadata":"object"}}"#,
        );
        assert_eq!(TypeTable::load(v.path()).recorded("metadata"), None);
        set_type(v.path(), "metadata", o, None, vec![]).unwrap();
        assert_eq!(
            TypeTable::load(v.path()).recorded("metadata"),
            Some((o, TypeSource::Writer))
        );
        assert_eq!(
            std::fs::read_to_string(v.path().join(OBSIDIAN_FILE)).unwrap(),
            r#"{"types":{"metadata":"object"}}"#
        );
        let r = report(v.path(), vec![count("metadata", &[("object", 2)])]);
        assert_eq!(
            (r[0].ty, r[0].obsidian_type, r[0].mismatched),
            (o, "text", 0)
        );
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

    #[test]
    fn url_is_inferred_only_when_every_value_is_a_url() {
        let u = PropertyType::Url;
        assert_eq!(infer("website", &obs(&[("url", 3)])), u);
        assert_eq!(infer("sources", &obs(&[("urls", 2), ("url", 1)])), u);
        assert_eq!(infer("website", &obs(&[("url", 2), ("null", 4)])), u);
        // one non-URL value (or any other kind) keeps the usual answer
        assert_eq!(
            infer("website", &obs(&[("url", 3), ("text", 1)])),
            PropertyType::Text
        );
        assert_eq!(
            infer("sources", &obs(&[("urls", 3), ("list", 1)])),
            PropertyType::Multitext
        );
        assert_eq!(
            infer("x", &obs(&[("url", 2), ("link", 2)])),
            PropertyType::Text
        );
        assert_eq!(infer("x", &obs(&[("null", 2)])), PropertyType::Text);
        // tags / aliases are never url
        assert_eq!(infer("tags", &obs(&[("urls", 3)])), PropertyType::Tags);
        assert_eq!(infer("Aliases", &obs(&[("url", 3)])), PropertyType::Aliases);
    }

    #[test]
    fn url_fits_text_and_lists_and_reads_as_text_for_plugins() {
        let u = PropertyType::Url;
        for t in ["text", "url", "list", "urls", "null"] {
            assert!(u.fits(t), "{t}");
        }
        for t in ["number", "bool", "date", "link", "links", "object"] {
            assert!(!u.fits(t), "{t}");
        }
        // the synthetic kinds still fit the types they were carved out of
        assert!(PropertyType::Text.fits("url") && PropertyType::Enum.fits("url"));
        assert!(PropertyType::Multitext.fits("urls") && PropertyType::Tags.fits("urls"));
        assert!(!PropertyType::Number.fits("url"));
        assert_eq!(u.wire_name(), "url");
        assert_eq!(PropertyType::parse("url"), Some(u));
        assert!(u.is_writer_only());
        assert_eq!(PropertyType::parse_obsidian("url"), None);
        assert_eq!(u.obsidian_name(false), "text");
        assert_eq!(u.obsidian_name(true), "multitext");
    }

    #[test]
    fn refine_url_shapes_moves_urls_out_of_text_and_list() {
        let mut counts = vec![
            count("website", &[("text", 4)]),
            count("sources", &[("list", 3), ("text", 1)]),
            count("other", &[("text", 2)]),
        ];
        let shape = |key: &str, urls, url_lists| crate::index::UrlShape {
            key: key.into(),
            urls,
            url_lists,
        };
        refine_url_shapes(
            &mut counts,
            &[
                shape("website", 4, 0),
                shape("sources", 1, 2),
                shape("gone", 1, 1),
            ],
        );
        assert_eq!(counts[0].types, obs(&[("url", 4)]));
        assert_eq!(
            counts[1].types,
            obs(&[("list", 1), ("urls", 2), ("url", 1)])
        );
        assert_eq!(counts[2].types, obs(&[("text", 2)]));
    }

    #[test]
    fn report_over_a_real_index_infers_url_and_never_overrides_a_record() {
        let v = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(v.path(), "A.md", "---\nwebsite: https://a.example\nsources:\n  - b.example/x\n  - mailto:me@c.example\nmixed: https://a.example\ncopy: https://a.example\ntags:\n  - https://t.example\nempty: []\n---\n");
        write(
            v.path(),
            "B.md",
            "---\nwebsite: www.b.example\nsources: https://one.example\nmixed: just words\ncopy: https://b.example\nempty:\n---\n",
        );
        write(
            v.path(),
            ".obsidian/types.json",
            r#"{"types":{"copy":"text"}}"#,
        );
        let index = crate::index::Index::open_for_cli(v.path(), Some(data.path())).unwrap();
        index.refresh_blocking().unwrap();
        let run = || report(v.path(), index.properties_for_types().unwrap());
        let get = |r: &[PropertyTypeInfo], k: &str| r.iter().find(|p| p.key == k).cloned().unwrap();
        let r = run();
        let website = get(&r, "website");
        assert_eq!(
            (website.ty, website.source, website.obsidian_type),
            (PropertyType::Url, TypeSource::Inferred, "text")
        );
        let sources = get(&r, "sources");
        assert_eq!(
            (sources.ty, sources.obsidian_type, sources.mismatched),
            (PropertyType::Url, "multitext", 0),
            "a list and a single value"
        );
        assert_ne!(
            get(&r, "mixed").ty,
            PropertyType::Url,
            "one non-URL breaks it"
        );
        assert_eq!(get(&r, "copy").ty, PropertyType::Text, "a stored type wins");
        assert_eq!(get(&r, "copy").source, TypeSource::Obsidian);
        assert_eq!(get(&r, "copy").mismatched, 0);
        assert_eq!(get(&r, "tags").ty, PropertyType::Tags);
        assert_eq!(get(&r, "empty").ty, PropertyType::Text, "empty is neutral");
        // inference never writes a record
        assert!(!v.path().join(WRITER_FILE).exists());
        assert_eq!(
            std::fs::read_to_string(v.path().join(OBSIDIAN_FILE)).unwrap(),
            r#"{"types":{"copy":"text"}}"#
        );
    }

    #[test]
    fn enum_values_are_appended_once_when_a_note_gains_a_new_text_value() {
        let v = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(v.path(), "A.md", "---\nstatus: todo\nother: x\n---\n");
        write(v.path(), "B.md", "---\nstatus: done\n---\n");
        let index = crate::index::Index::open_for_cli(v.path(), Some(data.path())).unwrap();
        index.refresh_blocking().unwrap();
        set_type(
            v.path(),
            "Status",
            PropertyType::Enum,
            Some(strings(&["todo", "doing"])),
            vec![],
        )
        .unwrap();
        set_type(v.path(), "other", PropertyType::Text, None, vec![]).unwrap();
        let sync = || sync_enum_values(v.path(), |name| index.text_values(name)).unwrap();
        let listed = || TypeTable::load(v.path()).values("status").to_vec();
        // "done" is held by a note and not listed: it goes after the existing values
        assert_eq!(sync(), ["status"]);
        assert_eq!(listed(), ["todo", "doing", "done"]);
        let written = std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap();
        // nothing new: no pass writes (the file Writer wrote does not start another round)
        assert!(sync().is_empty());
        assert_eq!(
            std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap(),
            written
        );
        // an external edit brings new values: most used first, then by name, after the old ones
        write(v.path(), "A.md", "---\nstatus: blocked\n---\n");
        write(v.path(), "C.md", "---\nstatus: \"  waiting  \"\n---\n");
        write(v.path(), "D.md", "---\nstatus: waiting\n---\n");
        write(v.path(), "E.md", "---\nstatus: todo\n---\n");
        index.refresh_blocking().unwrap();
        assert_eq!(sync(), ["status"]);
        assert_eq!(listed(), ["todo", "doing", "done", "waiting", "blocked"]);
        assert!(sync().is_empty());
        // the note is never rewritten and `.obsidian` never appears
        assert_eq!(
            std::fs::read_to_string(v.path().join("A.md")).unwrap(),
            "---\nstatus: blocked\n---\n"
        );
        assert!(!v.path().join(".obsidian").exists());
        // only an enum's list grows
        assert_eq!(
            TypeTable::load(v.path()).recorded("other").unwrap().0,
            PropertyType::Text
        );
    }

    #[test]
    fn enum_sync_skips_lists_numbers_links_and_blank_or_multiline_values() {
        let v = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(v.path(), "A.md", "---\nstatus: 3\n---\n");
        write(v.path(), "B.md", "---\nstatus: [a, b]\n---\n");
        write(v.path(), "C.md", "---\nstatus: \"[[Note]]\"\n---\n");
        write(v.path(), "D.md", "---\nstatus: \" \"\n---\n");
        write(v.path(), "E.md", "---\nstatus: |\n  one\n  two\n---\n");
        write(v.path(), "F.md", "---\nstatus: true\n---\n");
        write(v.path(), "G.md", "---\nstatus:\n---\n");
        let index = crate::index::Index::open_for_cli(v.path(), Some(data.path())).unwrap();
        index.refresh_blocking().unwrap();
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["todo"])),
            vec![],
        )
        .unwrap();
        let before = std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap();
        assert!(sync_enum_values(v.path(), |n| index.text_values(n))
            .unwrap()
            .is_empty());
        assert_eq!(
            std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap(),
            before
        );
        assert_eq!(TypeTable::load(v.path()).values("status"), ["todo"]);
    }

    fn icons(pairs: &[(&str, &str)]) -> Option<BTreeMap<String, String>> {
        Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    #[test]
    fn icon_values_match_the_shared_vectors() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/icon-value-vectors.json")).unwrap();
        for c in v["valid"].as_array().unwrap() {
            let c = c.as_str().unwrap();
            assert!(valid_icon(c), "{c:?} should be valid");
        }
        for c in v["invalid"].as_array().unwrap() {
            let c = c.as_str().unwrap();
            assert!(!valid_icon(c), "{c:?} should be invalid");
        }
    }

    #[test]
    fn enum_icons_are_stored_optional_and_old_files_load_unchanged() {
        let v = tempfile::tempdir().unwrap();
        // an old file: no icons key anywhere
        write(
            v.path(),
            WRITER_FILE,
            r#"{"types":{"status":{"type":"enum","values":["todo","done"]},"n":"number"}}"#,
        );
        let t = TypeTable::load(v.path());
        assert!(t.icons("status").is_empty());
        assert_eq!(t.values("status"), ["todo", "done"]);
        // set one: the entry gains `icons`, every other entry is untouched
        set_type_with_icons(
            v.path(),
            "status",
            PropertyType::Enum,
            None,
            icons(&[("done", "emoji:✅"), ("todo", "icon:Home01Icon")]),
            vec![],
        )
        .unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap())
                .unwrap();
        assert_eq!(
            raw["types"]["status"],
            serde_json::json!({"type":"enum","values":["todo","done"],
                "icons":{"done":"emoji:✅","todo":"icon:Home01Icon"}})
        );
        assert_eq!(raw["types"]["n"], "number");
        // `None` keeps the icons (set_type, auto-add); the report carries them
        set_type(v.path(), "status", PropertyType::Enum, None, vec![]).unwrap();
        let r = report(v.path(), vec![count("status", &[("text", 2)])]);
        let status = r.iter().find(|p| p.key == "status").unwrap();
        assert_eq!(status.icons["done"], "emoji:✅");
        assert!(!v.path().join(".obsidian").exists());
    }

    #[test]
    fn a_renamed_value_keeps_its_icon_a_removed_one_drops_it_and_new_ones_have_none() {
        let v = tempfile::tempdir().unwrap();
        set_type_with_icons(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["todo", "done"])),
            icons(&[("done", "emoji:✅"), ("todo", "emoji:📝")]),
            vec![],
        )
        .unwrap();
        // rename done -> finished (the caller sends the map under the new name), drop todo
        set_type_with_icons(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["finished"])),
            icons(&[("finished", "emoji:✅"), ("todo", "emoji:📝")]),
            vec![],
        )
        .unwrap();
        let t = TypeTable::load(v.path());
        assert_eq!(t.values("status"), ["finished"]);
        assert_eq!(
            t.icons("status"),
            icons(&[("finished", "emoji:✅")]).unwrap()
        );
        // removing a value without sending icons drops its icon too
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["other"])),
            vec![],
        )
        .unwrap();
        assert!(TypeTable::load(v.path()).icons("status").is_empty());
        // an auto-added value has no icon, the others keep theirs
        set_type_with_icons(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["a"])),
            icons(&[("a", "icon:Home01Icon")]),
            vec![],
        )
        .unwrap();
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(strings(&["a", "b"])),
            vec![],
        )
        .unwrap();
        assert_eq!(
            TypeTable::load(v.path()).icons("status"),
            icons(&[("a", "icon:Home01Icon")]).unwrap()
        );
        // another type has no icons
        set_type(v.path(), "status", PropertyType::Text, None, vec![]).unwrap();
        assert!(TypeTable::load(v.path()).icons("status").is_empty());
    }

    #[test]
    fn bad_icons_are_refused_and_bad_stored_ones_skipped() {
        let v = tempfile::tempdir().unwrap();
        for (k, bad) in [
            ("a", "smile:x"),
            ("a", "emoji:ab"),
            ("a", "emoji:✅✅"),
            ("a", "icon:lowercase"),
        ] {
            let r = set_type_with_icons(
                v.path(),
                "s",
                PropertyType::Enum,
                Some(strings(&["a"])),
                icons(&[(k, bad)]),
                vec![],
            );
            assert!(r.is_err(), "{bad}");
        }
        assert!(!v.path().join(WRITER_FILE).exists(), "nothing written");
        // a key the list lacks is dropped on write; a malformed stored icon is skipped on read
        write(
            v.path(),
            WRITER_FILE,
            r#"{"types":{"s":{"type":"enum","values":["a","b"],"icons":{"a":"emoji:✅","b":"junk","zz":"emoji:✅"}}}}"#,
        );
        assert_eq!(
            TypeTable::load(v.path()).icons("s"),
            icons(&[("a", "emoji:✅")]).unwrap()
        );
        set_type_with_icons(
            v.path(),
            "s",
            PropertyType::Enum,
            None,
            icons(&[("zz", "emoji:✅")]),
            vec![],
        )
        .unwrap();
        assert!(TypeTable::load(v.path()).icons("s").is_empty());
    }

    #[test]
    fn a_property_of_file_names_stays_text_not_url() {
        let v = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(v.path(), "A.md", "---\nattachment: Paper.pdf\nrefs:\n  - notes.md\n  - photo.png\nsite: example.com\n---\n");
        write(
            v.path(),
            "B.md",
            "---\nattachment: diagram.svg\nrefs:\n  - board.canvas\n  - x.base\nsite: example.com/docs\n---\n",
        );
        let index = crate::index::Index::open_for_cli(v.path(), Some(data.path())).unwrap();
        index.refresh_blocking().unwrap();
        let r = report(v.path(), index.properties_for_types().unwrap());
        let ty = |k: &str| r.iter().find(|p| p.key == k).unwrap().ty;
        assert_eq!(ty("attachment"), PropertyType::Text);
        assert_eq!(ty("refs"), PropertyType::Multitext);
        assert_eq!(
            ty("site"),
            PropertyType::Url,
            "real domains still infer url"
        );
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

    fn record(root: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(root.join(WRITER_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn pins_take_the_next_place_and_unpinning_closes_the_gap() {
        let v = tempfile::tempdir().unwrap();
        for n in ["Status", "priority", "due"] {
            set_pinned(v.path(), n, true).unwrap();
        }
        let t = TypeTable::load(v.path());
        assert_eq!(
            [t.pinned("status"), t.pinned("PRIORITY"), t.pinned("due")],
            [Some(0), Some(1), Some(2)]
        );
        set_pinned(v.path(), "status", false).unwrap();
        let t = TypeTable::load(v.path());
        assert_eq!(
            [t.pinned("status"), t.pinned("priority"), t.pinned("due")],
            [None, Some(0), Some(1)]
        );
        assert!(record(v.path())["types"].get("status").is_none());
    }

    #[test]
    fn pinning_is_idempotent_and_unpinning_a_free_name_writes_nothing() {
        let v = tempfile::tempdir().unwrap();
        set_pinned(v.path(), "due", false).unwrap();
        assert!(!v.path().join(WRITER_FILE).exists());
        set_pinned(v.path(), "due", true).unwrap();
        set_pinned(v.path(), "due", true).unwrap();
        assert_eq!(TypeTable::load(v.path()).pinned("due"), Some(0));
        assert_eq!(
            record(v.path())["types"]["due"],
            serde_json::json!({"pinned": 0})
        );
    }

    #[test]
    fn a_pin_on_an_untyped_property_leaves_its_type_inferred() {
        let v = tempfile::tempdir().unwrap();
        set_pinned(v.path(), "due", true).unwrap();
        let t = TypeTable::load(v.path());
        assert_eq!(t.recorded("due"), None);
        let counts = vec![PropertyCount {
            key: "due".into(),
            count: 2,
            types: [("date".to_string(), 2)].into(),
        }];
        let r = report(v.path(), counts);
        assert_eq!(
            (r[0].ty, r[0].source, r[0].pinned),
            (PropertyType::Date, TypeSource::Inferred, Some(0))
        );
        // a pin on a name no note uses is still reported
        set_pinned(v.path(), "ghost", true).unwrap();
        let r = report(v.path(), vec![]);
        assert!(r.iter().any(|i| i.key == "ghost" && i.pinned == Some(1)));
    }

    #[test]
    fn pinning_keeps_the_type_values_icons_and_unknown_keys() {
        let v = tempfile::tempdir().unwrap();
        write(
            v.path(),
            WRITER_FILE,
            r#"{"types":{"status":{"type":"enum","values":["todo","done"],"icons":{"done":"emoji:✅"},"future":[1]},"n":"number"}}"#,
        );
        set_pinned(v.path(), "status", true).unwrap();
        set_pinned(v.path(), "n", true).unwrap();
        let r = record(v.path());
        assert_eq!(r["types"]["status"]["future"], serde_json::json!([1]));
        assert_eq!(r["types"]["status"]["pinned"], 0);
        assert_eq!(
            r["types"]["n"],
            serde_json::json!({"type": "number", "pinned": 1})
        );
        // the type is still read, and a type change keeps the pin and the unknown key
        set_type(v.path(), "n", PropertyType::Text, None, vec![]).unwrap();
        set_type(
            v.path(),
            "status",
            PropertyType::Enum,
            Some(vec!["a".into()]),
            vec![],
        )
        .unwrap();
        let r = record(v.path());
        assert_eq!(
            r["types"]["n"],
            serde_json::json!({"type": "text", "pinned": 1})
        );
        assert_eq!(r["types"]["status"]["pinned"], 0);
        assert_eq!(r["types"]["status"]["future"], serde_json::json!([1]));
        // unpin collapses the entry back to a bare string
        set_pinned(v.path(), "n", false).unwrap();
        assert_eq!(record(v.path())["types"]["n"], "text");
    }

    #[test]
    fn typing_a_pinned_untyped_property_keeps_the_pin() {
        let v = tempfile::tempdir().unwrap();
        set_pinned(v.path(), "due", true).unwrap();
        set_type(v.path(), "due", PropertyType::Date, None, vec![]).unwrap();
        assert_eq!(
            record(v.path())["types"]["due"],
            serde_json::json!({"type": "date", "pinned": 0})
        );
        assert_eq!(
            TypeTable::load(v.path()).recorded("due"),
            Some((PropertyType::Date, TypeSource::Writer))
        );
    }

    #[test]
    fn pinning_never_writes_obsidian_and_refuses_bad_names() {
        let v = tempfile::tempdir().unwrap();
        let obsidian = r#"{"types":{"due":"date"}}"#;
        write(v.path(), OBSIDIAN_FILE, obsidian);
        set_pinned(v.path(), "due", true).unwrap();
        assert_eq!(
            std::fs::read_to_string(v.path().join(OBSIDIAN_FILE)).unwrap(),
            obsidian
        );
        let t = TypeTable::load(v.path());
        assert_eq!(
            t.recorded("due"),
            Some((PropertyType::Date, TypeSource::Obsidian))
        );
        assert_eq!(t.pinned("due"), Some(0));
        assert!(set_pinned(v.path(), "  ", true).is_err());
        assert!(set_pinned(v.path(), "a\nb", true).is_err());
    }

    #[test]
    fn a_broken_record_refuses_a_pin_and_is_left_alone() {
        let v = tempfile::tempdir().unwrap();
        write(v.path(), WRITER_FILE, "{not json");
        assert!(set_pinned(v.path(), "due", true).is_err());
        assert_eq!(
            std::fs::read_to_string(v.path().join(WRITER_FILE)).unwrap(),
            "{not json"
        );
    }
}
