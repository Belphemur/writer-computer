//! The `.base` file model: YAML -> typed document, lenient but explicit.
//!
//! * YAML syntax errors and a non-mapping top level are errors
//!   ([`DocumentError`]).
//! * A malformed `filters` value is an error too: dropping it would silently
//!   show more rows than the author asked for.
//! * Anything else that does not fit the model (a non-integer `limit`, a
//!   formula that is not a scalar, ...) becomes a warning in
//!   [`Document::warnings`] and the original value is kept in `extra` so it
//!   survives a round trip.
//! * Unknown keys at every level (`name`, `columnSize`-like view options,
//!   plugin keys, kanban/map/cards/list settings) are preserved verbatim in
//!   `extra` (U1, U6).
//!
//! `to_yaml` re-emits the model with the original key order. Comments are not
//! part of the model; callers that must keep them (the editor) patch text and
//! only re-serialize on an explicit config change.

use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::Value as Json;
use std::fmt;
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

/// A YAML-ish tree that keeps mapping order (serde_json's map does not unless
/// its `preserve_order` feature is on, and we must not change features of
/// shared dependencies). Used for unknown keys so they round-trip verbatim.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Str(String),
    Seq(Vec<Node>),
    Map(Vec<(String, Node)>),
}

impl Node {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Node::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Json {
        match self {
            Node::Null => Json::Null,
            Node::Bool(b) => Json::Bool(*b),
            Node::Int(i) => Json::from(*i),
            Node::Real(f) => serde_json::Number::from_f64(*f)
                .map(Json::Number)
                .unwrap_or(Json::Null),
            Node::Str(s) => Json::String(s.clone()),
            Node::Seq(v) => Json::Array(v.iter().map(Node::to_json).collect()),
            Node::Map(m) => Json::Object(m.iter().map(|(k, v)| (k.clone(), v.to_json())).collect()),
        }
    }

    fn to_yaml(&self) -> Yaml {
        match self {
            Node::Null => Yaml::Null,
            Node::Bool(b) => Yaml::Boolean(*b),
            Node::Int(i) => Yaml::Integer(*i),
            Node::Real(f) => Yaml::Real(format!("{f}")),
            Node::Str(s) => Yaml::String(s.clone()),
            Node::Seq(v) => Yaml::Array(v.iter().map(Node::to_yaml).collect()),
            Node::Map(m) => {
                let mut h = yaml_rust2::yaml::Hash::new();
                for (k, v) in m {
                    h.insert(Yaml::String(k.clone()), v.to_yaml());
                }
                Yaml::Hash(h)
            }
        }
    }

    fn from_yaml(y: &Yaml, warnings: &mut Vec<String>, path: &str) -> Node {
        match y {
            Yaml::Null | Yaml::BadValue => Node::Null,
            Yaml::Boolean(b) => Node::Bool(*b),
            Yaml::Integer(i) => Node::Int(*i),
            Yaml::Real(s) => match s.parse::<f64>() {
                Ok(f) if f.is_finite() => Node::Real(f),
                _ => Node::Str(s.clone()),
            },
            Yaml::String(s) => Node::Str(s.clone()),
            Yaml::Array(a) => Node::Seq(
                a.iter()
                    .enumerate()
                    .map(|(i, x)| Node::from_yaml(x, warnings, &format!("{path}[{i}]")))
                    .collect(),
            ),
            Yaml::Hash(h) => Node::Map(
                h.iter()
                    .map(|(k, v)| {
                        let key = scalar_key(k);
                        let child = Node::from_yaml(v, warnings, &format!("{path}.{key}"));
                        (key, child)
                    })
                    .collect(),
            ),
            Yaml::Alias(_) => {
                warnings.push(format!(
                    "{path}: YAML aliases are not supported, read as null"
                ));
                Node::Null
            }
        }
    }
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Node::Null => s.serialize_none(),
            Node::Bool(b) => s.serialize_bool(*b),
            Node::Int(i) => s.serialize_i64(*i),
            Node::Real(f) => s.serialize_f64(*f),
            Node::Str(v) => s.serialize_str(v),
            Node::Seq(v) => {
                let mut q = s.serialize_seq(Some(v.len()))?;
                for x in v {
                    q.serialize_element(x)?;
                }
                q.end()
            }
            Node::Map(m) => ser_entries(m, s),
        }
    }
}

/// Insertion-ordered unknown keys.
pub type Entries = Vec<(String, Node)>;

#[derive(Clone, Debug, PartialEq)]
pub enum DocumentError {
    Yaml {
        message: String,
        line: usize,
        col: usize,
    },
    Shape {
        /// Dotted path such as `views[2].filters`.
        path: String,
        message: String,
    },
}

impl fmt::Display for DocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DocumentError::Yaml { message, line, col } => {
                write!(f, "invalid YAML at line {line}, column {col}: {message}")
            }
            DocumentError::Shape { path, message } => {
                if path.is_empty() {
                    write!(f, "{message}")
                } else {
                    write!(f, "{path}: {message}")
                }
            }
        }
    }
}

impl std::error::Error for DocumentError {}

fn shape<T>(path: &str, message: impl Into<String>) -> Result<T, DocumentError> {
    Err(DocumentError::Shape {
        path: path.to_string(),
        message: message.into(),
    })
}

fn ser_entries<S: Serializer>(e: &Entries, s: S) -> Result<S::Ok, S::Error> {
    let mut m = s.serialize_map(Some(e.len()))?;
    for (k, v) in e {
        m.serialize_entry(k, v)?;
    }
    m.end()
}

fn ser_pairs<S: Serializer>(e: &[(String, String)], s: S) -> Result<S::Ok, S::Error> {
    let mut m = s.serialize_map(Some(e.len()))?;
    for (k, v) in e {
        m.serialize_entry(k, v)?;
    }
    m.end()
}

fn ser_props<S: Serializer>(e: &[(String, PropertyConfig)], s: S) -> Result<S::Ok, S::Error> {
    let mut m = s.serialize_map(Some(e.len()))?;
    for (k, v) in e {
        m.serialize_entry(k, v)?;
    }
    m.end()
}

/// A filter tree whose leaves are expression strings.
#[derive(Clone, Debug, PartialEq)]
pub enum Filter {
    Expr(String),
    And(Vec<Filter>),
    Or(Vec<Filter>),
    /// "None of the following".
    Not(Vec<Filter>),
}

impl Filter {
    pub fn to_node(&self) -> Node {
        let group = |k: &str, v: &[Filter]| {
            Node::Map(vec![(
                k.to_string(),
                Node::Seq(v.iter().map(Filter::to_node).collect()),
            )])
        };
        match self {
            Filter::Expr(s) => Node::Str(s.clone()),
            Filter::And(v) => group("and", v),
            Filter::Or(v) => group("or", v),
            Filter::Not(v) => group("not", v),
        }
    }

    fn from_node(n: &Node, path: &str) -> Result<Filter, DocumentError> {
        match n {
            Node::Str(s) => Ok(Filter::Expr(s.clone())),
            Node::Bool(b) => Ok(Filter::Expr(b.to_string())),
            Node::Int(i) => Ok(Filter::Expr(i.to_string())),
            Node::Map(m) => {
                if m.len() != 1 {
                    return shape(
                        path,
                        "a filter group needs exactly one of `and`, `or`, `not`",
                    );
                }
                let (k, v) = &m[0];
                let items = match v {
                    Node::Seq(a) => a
                        .iter()
                        .enumerate()
                        .map(|(i, x)| Filter::from_node(x, &format!("{path}.{k}[{i}]")))
                        .collect::<Result<Vec<_>, _>>()?,
                    Node::Str(_) | Node::Map(_) => {
                        vec![Filter::from_node(v, &format!("{path}.{k}"))?]
                    }
                    Node::Null => Vec::new(),
                    _ => return shape(path, format!("`{k}` must be a list of filters")),
                };
                match k.as_str() {
                    "and" => Ok(Filter::And(items)),
                    "or" => Ok(Filter::Or(items)),
                    "not" => Ok(Filter::Not(items)),
                    other => shape(path, format!("unknown filter group `{other}`")),
                }
            }
            _ => shape(path, "a filter must be a string or an and/or/not group"),
        }
    }
}

impl Serialize for Filter {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_node().serialize(s)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub enum Direction {
    #[default]
    #[serde(rename = "ASC")]
    Asc,
    #[serde(rename = "DESC")]
    Desc,
}

impl Direction {
    fn parse(s: &str) -> Option<Direction> {
        match s.trim().to_ascii_uppercase().as_str() {
            "ASC" | "ASCENDING" => Some(Direction::Asc),
            "DESC" | "DESCENDING" => Some(Direction::Desc),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Direction::Asc => "ASC",
            Direction::Desc => "DESC",
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct SortKey {
    pub property: String,
    pub direction: Direction,
    #[serde(serialize_with = "ser_entries")]
    pub extra: Entries,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct GroupBy {
    pub property: String,
    pub direction: Direction,
    #[serde(serialize_with = "ser_entries")]
    pub extra: Entries,
}

/// An entry of the top-level `properties` map.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyConfig {
    pub display_name: Option<String>,
    #[serde(serialize_with = "ser_entries")]
    pub extra: Entries,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// `table`, `cards`, `list`, `kanban`, `map` or a plugin type; kept opaque.
    #[serde(rename = "type")]
    pub view_type: String,
    pub name: String,
    pub filters: Option<Filter>,
    pub group_by: Option<GroupBy>,
    /// Manual group order (`groupOrder`), entries kept as written.
    pub group_order: Option<Vec<Node>>,
    pub sort: Vec<SortKey>,
    /// Column order; `None` when the key is absent.
    pub order: Option<Vec<String>>,
    pub limit: Option<u64>,
    #[serde(serialize_with = "ser_entries")]
    pub column_size: Entries,
    /// Property id -> summary name.
    #[serde(serialize_with = "ser_pairs")]
    pub summaries: Vec<(String, String)>,
    /// Unknown keys (cards/list/kanban/map options, plugin keys, ...).
    #[serde(serialize_with = "ser_entries")]
    pub extra: Entries,
    #[serde(skip)]
    key_order: Vec<String>,
}

impl View {
    /// The implicit view of a base without `views`.
    pub fn default_table() -> View {
        View {
            view_type: "table".into(),
            name: "Table".into(),
            filters: None,
            group_by: None,
            group_order: None,
            sort: Vec::new(),
            order: None,
            limit: None,
            column_size: Vec::new(),
            summaries: Vec::new(),
            extra: Vec::new(),
            key_order: Vec::new(),
        }
    }
}

/// What the rows of a base are: the vault's files (Obsidian's, the default) or its tasks (a Writer
/// extension, top-level `rows: tasks`; SPECs/tasks-spec.md 5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    #[default]
    Files,
    Tasks,
}

impl RowKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RowKind::Files => "files",
            RowKind::Tasks => "tasks",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// Top-level `name:`; meaning unknown (U1), preserved only.
    pub name: Option<String>,
    /// Top-level `rows:` (Writer extension); `files` when absent.
    pub rows: RowKind,
    pub filters: Option<Filter>,
    /// Formula name -> expression source.
    #[serde(serialize_with = "ser_pairs")]
    pub formulas: Vec<(String, String)>,
    /// Property id -> settings.
    #[serde(serialize_with = "ser_props")]
    pub properties: Vec<(String, PropertyConfig)>,
    /// Custom summary name -> expression over `values`.
    #[serde(serialize_with = "ser_pairs")]
    pub summaries: Vec<(String, String)>,
    pub views: Vec<View>,
    #[serde(serialize_with = "ser_entries")]
    pub extra: Entries,
    /// Non-fatal problems found while reading (lenient parsing).
    pub warnings: Vec<String>,
    #[serde(skip)]
    key_order: Vec<String>,
}

fn scalar_key(k: &Yaml) -> String {
    match k {
        Yaml::String(s) | Yaml::Real(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Null => "null".to_string(),
        _ => "?".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Takes keys out of a mapping one by one; what is left is the unknown part.
struct Reader {
    entries: Vec<(String, Node)>,
    order: Vec<String>,
}

impl Reader {
    fn new(m: &[(String, Node)]) -> Reader {
        Reader {
            order: m.iter().map(|(k, _)| k.clone()).collect(),
            entries: m.to_vec(),
        }
    }

    fn take(&mut self, key: &str) -> Option<Node> {
        let i = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(i).1)
    }

    fn rest(self) -> (Entries, Vec<String>) {
        (self.entries, self.order)
    }
}

fn as_scalar_string(j: &Node) -> Option<String> {
    match j {
        Node::Str(s) => Some(s.clone()),
        Node::Bool(b) => Some(b.to_string()),
        Node::Int(n) => Some(n.to_string()),
        Node::Real(n) => Some(n.to_string()),
        _ => None,
    }
}

fn string_map(
    j: Node,
    path: &str,
    warnings: &mut Vec<String>,
    extra: &mut Entries,
    key: &str,
) -> Vec<(String, String)> {
    match j {
        Node::Map(o) => {
            let mut out = Vec::new();
            for (k, v) in o {
                match as_scalar_string(&v) {
                    Some(s) => out.push((k, s)),
                    None => warnings.push(format!("{path}.{k}: expected text, entry ignored")),
                }
            }
            out
        }
        Node::Null => Vec::new(),
        other => {
            warnings.push(format!(
                "{path}: expected a mapping, kept as an unknown key"
            ));
            extra.push((key.to_string(), other));
            Vec::new()
        }
    }
}

fn parse_direction(j: Option<&Node>, path: &str, warnings: &mut Vec<String>) -> Direction {
    match j {
        None | Some(Node::Null) => Direction::Asc,
        Some(Node::Str(s)) => Direction::parse(s).unwrap_or_else(|| {
            warnings.push(format!(
                "{path}.direction: unknown direction \"{s}\", using ASC"
            ));
            Direction::Asc
        }),
        Some(_) => {
            warnings.push(format!("{path}.direction: expected ASC or DESC, using ASC"));
            Direction::Asc
        }
    }
}

fn parse_sort(j: Node, path: &str, warnings: &mut Vec<String>) -> Vec<SortKey> {
    let items = match j {
        Node::Seq(a) => a,
        Node::Null => return Vec::new(),
        other => vec![other],
    };
    let mut out = Vec::new();
    for (i, it) in items.into_iter().enumerate() {
        let p = format!("{path}[{i}]");
        match it {
            Node::Str(s) => out.push(SortKey {
                property: s,
                direction: Direction::Asc,
                extra: Vec::new(),
            }),
            Node::Map(o) => {
                let mut r = Reader::new(&o);
                let Some(prop) = r.take("property").and_then(|v| as_scalar_string(&v)) else {
                    warnings.push(format!("{p}: sort entry without a property, ignored"));
                    continue;
                };
                let dir = r.take("direction");
                out.push(SortKey {
                    property: prop,
                    direction: parse_direction(dir.as_ref(), &p, warnings),
                    extra: r.rest().0,
                });
            }
            _ => warnings.push(format!("{p}: unexpected sort entry, ignored")),
        }
    }
    out
}

fn parse_group_by(j: Node, path: &str, warnings: &mut Vec<String>) -> Option<GroupBy> {
    match j {
        Node::Null => None,
        Node::Str(s) => Some(GroupBy {
            property: s,
            direction: Direction::Asc,
            extra: Vec::new(),
        }),
        Node::Map(o) => {
            let mut r = Reader::new(&o);
            let Some(prop) = r.take("property").and_then(|v| as_scalar_string(&v)) else {
                warnings.push(format!("{path}: groupBy without a property, ignored"));
                return None;
            };
            let dir = r.take("direction");
            Some(GroupBy {
                property: prop,
                direction: parse_direction(dir.as_ref(), path, warnings),
                extra: r.rest().0,
            })
        }
        _ => {
            warnings.push(format!("{path}: unexpected groupBy, ignored"));
            None
        }
    }
}

fn parse_view(j: &Node, path: &str, warnings: &mut Vec<String>) -> Result<View, DocumentError> {
    let Node::Map(o) = j else {
        return shape(path, "a view must be a mapping");
    };
    let mut r = Reader::new(o);
    let mut extra_back: Entries = Vec::new();

    let view_type = match r.take("type") {
        Some(Node::Str(s)) => s,
        Some(other) => {
            warnings.push(format!("{path}.type: expected text, using \"table\""));
            extra_back.push(("type".into(), other));
            "table".into()
        }
        None => {
            warnings.push(format!("{path}: view without a type, using \"table\""));
            "table".into()
        }
    };
    let name = match r.take("name") {
        Some(Node::Str(s)) => s,
        Some(Node::Null) | None => String::new(),
        Some(other) => as_scalar_string(&other).unwrap_or_default(),
    };
    let filters = match r.take("filters") {
        None | Some(Node::Null) => None,
        Some(f) => Some(Filter::from_node(&f, &format!("{path}.filters"))?),
    };
    let group_by = r
        .take("groupBy")
        .and_then(|g| parse_group_by(g, &format!("{path}.groupBy"), warnings));
    let group_order = match r.take("groupOrder") {
        Some(Node::Seq(a)) => Some(a),
        Some(Node::Null) | None => None,
        Some(other) => {
            warnings.push(format!(
                "{path}.groupOrder: expected a list, kept as unknown"
            ));
            extra_back.push(("groupOrder".into(), other));
            None
        }
    };
    let sort = r
        .take("sort")
        .map(|s| parse_sort(s, &format!("{path}.sort"), warnings))
        .unwrap_or_default();
    let order = match r.take("order") {
        Some(Node::Seq(a)) => {
            let mut v = Vec::new();
            for (i, x) in a.iter().enumerate() {
                match as_scalar_string(x) {
                    Some(s) => v.push(s),
                    None => warnings.push(format!("{path}.order[{i}]: expected text, ignored")),
                }
            }
            Some(v)
        }
        Some(Node::Null) | None => None,
        Some(other) => {
            warnings.push(format!("{path}.order: expected a list, kept as unknown"));
            extra_back.push(("order".into(), other));
            None
        }
    };
    let limit = match r.take("limit") {
        Some(Node::Int(n)) if n >= 0 => Some(n as u64),
        Some(Node::Real(f)) if f >= 0.0 && f.fract() == 0.0 => Some(f as u64),
        Some(Node::Null) | None => None,
        Some(other) => {
            warnings.push(format!(
                "{path}.limit: expected a non-negative integer, ignored"
            ));
            extra_back.push(("limit".into(), other));
            None
        }
    };
    let column_size = match r.take("columnSize") {
        Some(Node::Map(m)) => m,
        Some(Node::Null) | None => Vec::new(),
        Some(other) => {
            warnings.push(format!(
                "{path}.columnSize: expected a mapping, kept as unknown"
            ));
            extra_back.push(("columnSize".into(), other));
            Vec::new()
        }
    };
    let summaries = match r.take("summaries") {
        Some(s) => string_map(
            s,
            &format!("{path}.summaries"),
            warnings,
            &mut extra_back,
            "summaries",
        ),
        None => Vec::new(),
    };
    let (mut extra, key_order) = r.rest();
    extra.extend(extra_back);
    Ok(View {
        view_type,
        name,
        filters,
        group_by,
        group_order,
        sort,
        order,
        limit,
        column_size,
        summaries,
        extra,
        key_order,
    })
}

impl Document {
    /// An empty document of `rows` kind, for code that builds a base (the `tasks` block
    /// conversion, the Tasks page).
    pub fn empty(rows: RowKind) -> Document {
        Document {
            rows,
            ..Document::default()
        }
    }

    pub fn parse(src: &str) -> Result<Document, DocumentError> {
        let docs = YamlLoader::load_from_str(src).map_err(|e| DocumentError::Yaml {
            message: e.info().to_string(),
            line: e.marker().line(),
            col: e.marker().col(),
        })?;
        let mut warnings = Vec::new();
        let Some(first) = docs.first() else {
            return Ok(Document::default());
        };
        if docs.len() > 1 {
            warnings.push("file contains several YAML documents, only the first is used".into());
        }
        let root = Node::from_yaml(first, &mut warnings, "");
        let o = match root {
            Node::Map(o) => o,
            Node::Null => {
                return Ok(Document {
                    warnings,
                    ..Document::default()
                })
            }
            _ => return shape("", "a .base file must be a YAML mapping"),
        };
        let mut r = Reader::new(&o);
        let mut extra_back: Entries = Vec::new();

        let name = match r.take("name") {
            Some(Node::Str(s)) => Some(s),
            Some(Node::Null) | None => None,
            Some(other) => {
                warnings.push("name: expected text, kept as unknown".into());
                extra_back.push(("name".into(), other));
                None
            }
        };
        let rows = match r.take("rows") {
            None | Some(Node::Null) => RowKind::Files,
            Some(Node::Str(s)) if s == "files" => RowKind::Files,
            Some(Node::Str(s)) if s == "tasks" => RowKind::Tasks,
            Some(other) => {
                warnings.push("rows: expected `files` or `tasks`, kept as unknown".into());
                extra_back.push(("rows".into(), other));
                RowKind::Files
            }
        };
        let filters = match r.take("filters") {
            None | Some(Node::Null) => None,
            Some(f) => Some(Filter::from_node(&f, "filters")?),
        };
        let formulas = match r.take("formulas") {
            Some(f) => string_map(f, "formulas", &mut warnings, &mut extra_back, "formulas"),
            None => Vec::new(),
        };
        let mut properties = Vec::new();
        match r.take("properties") {
            Some(Node::Map(m)) => {
                for (k, v) in m {
                    match v {
                        Node::Map(po) => {
                            let mut pr = Reader::new(&po);
                            let display_name = match pr.take("displayName") {
                                Some(Node::Str(s)) => Some(s),
                                Some(Node::Null) | None => None,
                                Some(other) => as_scalar_string(&other),
                            };
                            properties.push((
                                k,
                                PropertyConfig {
                                    display_name,
                                    extra: pr.rest().0,
                                },
                            ));
                        }
                        Node::Null => properties.push((k, PropertyConfig::default())),
                        _ => warnings.push(format!("properties.{k}: expected a mapping, ignored")),
                    }
                }
            }
            Some(Node::Null) | None => {}
            Some(other) => {
                warnings.push("properties: expected a mapping, kept as unknown".into());
                extra_back.push(("properties".into(), other));
            }
        }
        let summaries = match r.take("summaries") {
            Some(s) => string_map(s, "summaries", &mut warnings, &mut extra_back, "summaries"),
            None => Vec::new(),
        };
        let mut views = Vec::new();
        match r.take("views") {
            Some(Node::Seq(a)) => {
                for (i, v) in a.iter().enumerate() {
                    views.push(parse_view(v, &format!("views[{i}]"), &mut warnings)?);
                }
            }
            Some(Node::Null) | None => {}
            Some(_) => return shape("views", "`views` must be a list"),
        }
        let (mut extra, key_order) = r.rest();
        extra.extend(extra_back);
        Ok(Document {
            name,
            rows,
            filters,
            formulas,
            properties,
            summaries,
            views,
            extra,
            warnings,
            key_order,
        })
    }

    /// The view named `name` (exact, then case-insensitive), or the first view
    /// when `name` is `None`.
    pub fn view(&self, name: Option<&str>) -> Option<&View> {
        match name {
            None => self.views.first(),
            Some(n) => self
                .views
                .iter()
                .find(|v| v.name == n)
                .or_else(|| self.views.iter().find(|v| v.name.eq_ignore_ascii_case(n))),
        }
    }

    /// Settings of a property by canonical key (see `PropertyId::key`).
    pub fn property_config(&self, id_key: &str) -> Option<&PropertyConfig> {
        use super::ast::PropertyId;
        self.properties
            .iter()
            .find(|(k, _)| PropertyId::parse(k).key() == id_key)
            .map(|(_, c)| c)
    }

    /// The model in `.base` layout, key order as read.
    pub fn to_node(&self) -> Node {
        let mut pairs: Vec<(String, Node)> = Vec::new();
        if let Some(n) = &self.name {
            pairs.push(("name".into(), Node::Str(n.clone())));
        }
        if self.rows != RowKind::Files {
            pairs.push(("rows".into(), Node::Str(self.rows.as_str().into())));
        }
        if let Some(f) = &self.filters {
            pairs.push(("filters".into(), f.to_node()));
        }
        if !self.formulas.is_empty() {
            pairs.push(("formulas".into(), pairs_node(&self.formulas)));
        }
        if !self.properties.is_empty() {
            pairs.push((
                "properties".into(),
                Node::Map(
                    self.properties
                        .iter()
                        .map(|(k, c)| {
                            let mut pm = Vec::new();
                            if let Some(d) = &c.display_name {
                                pm.push(("displayName".to_string(), Node::Str(d.clone())));
                            }
                            pm.extend(c.extra.iter().cloned());
                            (k.clone(), Node::Map(pm))
                        })
                        .collect(),
                ),
            ));
        }
        if !self.summaries.is_empty() {
            pairs.push(("summaries".into(), pairs_node(&self.summaries)));
        }
        if !self.views.is_empty() || self.key_order.iter().any(|k| k == "views") {
            pairs.push((
                "views".into(),
                Node::Seq(self.views.iter().map(View::to_node).collect()),
            ));
        }
        pairs.extend(self.extra.iter().cloned());
        ordered(pairs, &self.key_order)
    }

    pub fn to_json(&self) -> Json {
        self.to_node().to_json()
    }

    /// Serialize back to YAML text (comments are not preserved).
    pub fn to_yaml(&self) -> String {
        let y = self.to_node().to_yaml();
        let mut out = String::new();
        {
            let mut e = YamlEmitter::new(&mut out);
            // writing to a String cannot fail
            let _ = e.dump(&y);
        }
        match out.strip_prefix("---\n") {
            Some(s) => format!("{s}\n"),
            None => format!("{out}\n"),
        }
    }
}

fn pairs_node(p: &[(String, String)]) -> Node {
    Node::Map(
        p.iter()
            .map(|(k, v)| (k.clone(), Node::Str(v.clone())))
            .collect(),
    )
}

/// A mapping with keys in `order` first (as they were read), then the rest.
fn ordered(mut pairs: Vec<(String, Node)>, order: &[String]) -> Node {
    let mut out = Vec::with_capacity(pairs.len());
    for k in order {
        if let Some(i) = pairs.iter().position(|(pk, _)| pk == k) {
            out.push(pairs.remove(i));
        }
    }
    out.extend(pairs);
    Node::Map(out)
}

impl View {
    fn to_node(&self) -> Node {
        let mut pairs: Vec<(String, Node)> =
            vec![("type".into(), Node::Str(self.view_type.clone()))];
        if !self.name.is_empty() {
            pairs.push(("name".into(), Node::Str(self.name.clone())));
        }
        if let Some(f) = &self.filters {
            pairs.push(("filters".into(), f.to_node()));
        }
        if let Some(g) = &self.group_by {
            let mut m = vec![
                ("property".to_string(), Node::Str(g.property.clone())),
                (
                    "direction".to_string(),
                    Node::Str(g.direction.as_str().into()),
                ),
            ];
            m.extend(g.extra.iter().cloned());
            pairs.push(("groupBy".into(), Node::Map(m)));
        }
        if let Some(g) = &self.group_order {
            pairs.push(("groupOrder".into(), Node::Seq(g.clone())));
        }
        if !self.sort.is_empty() {
            pairs.push((
                "sort".into(),
                Node::Seq(
                    self.sort
                        .iter()
                        .map(|s| {
                            let mut m = vec![
                                ("property".to_string(), Node::Str(s.property.clone())),
                                (
                                    "direction".to_string(),
                                    Node::Str(s.direction.as_str().into()),
                                ),
                            ];
                            m.extend(s.extra.iter().cloned());
                            Node::Map(m)
                        })
                        .collect(),
                ),
            ));
        }
        if let Some(o) = &self.order {
            pairs.push((
                "order".into(),
                Node::Seq(o.iter().map(|s| Node::Str(s.clone())).collect()),
            ));
        }
        if let Some(l) = self.limit {
            pairs.push(("limit".into(), Node::Int(l as i64)));
        }
        if !self.column_size.is_empty() {
            pairs.push(("columnSize".into(), Node::Map(self.column_size.clone())));
        }
        if !self.summaries.is_empty() {
            pairs.push(("summaries".into(), pairs_node(&self.summaries)));
        }
        pairs.extend(self.extra.iter().cloned());
        ordered(pairs, &self.key_order)
    }
}
