//! The compact spec an agent writes (spec `SPECs/excalidraw-spec.md` "Agent commands"): the
//! grammar of `create`, `add`, `update` and what `read` prints. Parsing reports every bad item in
//! one run (`nodes[2]: unknown field ...`), not only the first, so an agent fixes its spec once.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Default)]
pub struct Spec {
    /// `LR` (default) or `TB`: the way the flow runs.
    pub direction: Option<String>,
    pub nodes: Vec<NodeSpec>,
    pub edges: Vec<EdgeSpec>,
    pub groups: Vec<GroupSpec>,
    pub zones: Vec<ZoneSpec>,
    /// Text blocks laid out under the drawing, one per entry.
    pub legend: Vec<String>,
    /// `update` only: boxes (their arrows go with them), arrows `[from, to]` and zones to delete.
    pub remove: Option<RemoveSpec>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveSpec {
    #[serde(default)]
    pub nodes: Vec<String>,
    #[serde(default)]
    pub edges: Vec<(String, String)>,
    /// The zone's frame goes; its boxes stay.
    #[serde(default)]
    pub zones: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeSpec {
    pub id: String,
    /// The label. In `update`, absent keeps the current one and `""` clears it.
    pub text: Option<String>,
    /// `rectangle` (default), `ellipse`, `diamond` or `text` (a label with no box).
    pub shape: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// An explicit size. The text wraps at `w`; absent: the box grows to fit the text.
    pub w: Option<f64>,
    pub h: Option<f64>,
    /// A palette name (blue, green, red, yellow, orange, purple, gray) for outline and fill, or
    /// `#rrggbb` for the outline.
    pub color: Option<String>,
    /// The fill alone (a palette name's light tone, `#rrggbb` or `transparent`).
    pub fill: Option<String>,
    /// The outline alone, and the text colour.
    pub stroke: Option<String>,
    pub font_size: Option<f64>,
    /// `solid`, `dashed` or `dotted` outline.
    pub stroke_style: Option<String>,
    /// `[[Note]]`: stored as the element's link, and a link of the drawing in the index.
    pub link: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EdgeObject {
    from: String,
    to: String,
    label: Option<String>,
    color: Option<String>,
    style: Option<String>,
    bidirectional: Option<bool>,
    label_at: Option<f64>,
    from_side: Option<String>,
    to_side: Option<String>,
    route: Option<String>,
}

/// `["from", "to"]`, `["from", "to", "label"]` or an object (`from`, `to`, `label`, `style`,
/// `color`, `bidirectional`, `labelAt`, `fromSide`, `toSide`, `route`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EdgeSpec {
    pub from: String,
    pub to: String,
    /// In `update`, absent keeps the current label and `""` clears it.
    pub label: Option<String>,
    /// The arrow's colour (and its label's), as for a box.
    pub color: Option<String>,
    /// `solid` (default), `dashed` or `dotted`.
    pub style: Option<String>,
    /// An arrowhead at both ends.
    pub bidirectional: Option<bool>,
    /// Where the label sits along the arrow, 0 (start) to 1 (end); default the middle.
    pub label_at: Option<f64>,
    /// Which side of the box the arrow leaves and enters: `top`, `right`, `bottom`, `left`.
    pub from_side: Option<String>,
    pub to_side: Option<String>,
    /// `straight` (default) or `elbow` (right angles).
    pub route: Option<String>,
}

impl EdgeSpec {
    /// The label as text; `None` for no label or an empty one.
    pub fn label_text(&self) -> Option<&str> {
        self.label.as_deref().filter(|l| !l.is_empty())
    }

    /// Everything the `update` of an arrow may change, as fields rather than a tuple.
    pub fn changes_something(&self) -> bool {
        self.label.is_some()
            || self.color.is_some()
            || self.style.is_some()
            || self.bidirectional.is_some()
            || self.label_at.is_some()
            || self.route.is_some()
            || self.from_side.is_some()
            || self.to_side.is_some()
    }

    fn from_value(v: &Value) -> Result<EdgeSpec, String> {
        if let Value::Array(items) = v {
            let strings: Option<Vec<String>> = items
                .iter()
                .map(|i| i.as_str().map(str::to_string))
                .collect();
            return match strings {
                Some(s) if (2..=3).contains(&s.len()) => Ok(EdgeSpec {
                    from: s[0].clone(),
                    to: s[1].clone(),
                    label: s.get(2).cloned(),
                    ..EdgeSpec::default()
                }),
                Some(s) => Err(format!(
                    "an edge is [from, to] or [from, to, label], got {} items",
                    s.len()
                )),
                None => Err("an edge list holds strings".into()),
            };
        }
        let o: EdgeObject = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
        Ok(EdgeSpec {
            from: o.from,
            to: o.to,
            label: o.label,
            color: o.color,
            style: o.style,
            bidirectional: o.bidirectional,
            label_at: o.label_at,
            from_side: o.from_side,
            to_side: o.to_side,
            route: o.route,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupSpec {
    pub id: Option<String>,
    pub nodes: Vec<String>,
}

/// A titled area that holds boxes, drawn as an Excalidraw frame around them.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ZoneSpec {
    pub id: String,
    /// The frame's name, shown top-left. In `update`, absent keeps it.
    pub label: Option<String>,
    /// The boxes inside. In `update`, absent keeps the members and a list replaces them.
    pub nodes: Option<Vec<String>>,
    pub color: Option<String>,
    /// Space between the boxes and the frame, default 40.
    pub padding: Option<f64>,
}

const TOP_LEVEL: &[&str] = &[
    "direction",
    "nodes",
    "edges",
    "groups",
    "zones",
    "legend",
    "remove",
    // what `read` prints for the parts it cannot express; ignored
    "other",
];

fn items<T>(
    root: &serde_json::Map<String, Value>,
    key: &str,
    errors: &mut Vec<String>,
    one: impl Fn(&Value) -> Result<T, String>,
) -> Vec<T> {
    let Some(v) = root.get(key) else {
        return Vec::new();
    };
    let Some(list) = v.as_array() else {
        errors.push(format!("{key} is a list"));
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, item) in list.iter().enumerate() {
        match one(item) {
            Ok(t) => out.push(t),
            Err(e) => {
                let who = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| format!(" ({id})"))
                    .unwrap_or_default();
                errors.push(format!("{key}[{i}]{who}: {e}"));
            }
        }
    }
    out
}

fn of<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}

/// Parse a spec. `Err(Usage)` is text that is not JSON or not an object; `Err(Invalid)` lists
/// every item that is wrong (unknown field, wrong type), one line each.
pub enum SpecError {
    Usage(String),
    Invalid(Vec<String>),
}

pub fn parse_spec(json: &str) -> Result<Spec, SpecError> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| SpecError::Usage(format!("the spec is not valid JSON: {e}")))?;
    let root = value
        .as_object()
        .ok_or_else(|| SpecError::Usage("the spec is a JSON object".into()))?;
    let mut errors = Vec::new();
    for k in root.keys().filter(|k| !TOP_LEVEL.contains(&k.as_str())) {
        errors.push(format!(
            "unknown field {k} (direction, nodes, edges, groups, zones, legend, remove)"
        ));
    }
    let direction = match root.get("direction") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            errors.push("direction is LR or TB".into());
            None
        }
    };
    let nodes = items(root, "nodes", &mut errors, of::<NodeSpec>);
    let edges = items(root, "edges", &mut errors, EdgeSpec::from_value);
    let groups = items(root, "groups", &mut errors, of::<GroupSpec>);
    let zones = items(root, "zones", &mut errors, of::<ZoneSpec>);
    let legend = match root.get("legend") {
        None => Vec::new(),
        Some(v) => match serde_json::from_value::<Vec<String>>(v.clone()) {
            Ok(l) => l,
            Err(_) => {
                errors.push("legend is a list of strings".into());
                Vec::new()
            }
        },
    };
    let remove = match root.get("remove") {
        None | Some(Value::Null) => None,
        Some(v) => match of::<RemoveSpec>(v) {
            Ok(r) => Some(r),
            Err(e) => {
                errors.push(format!("remove: {e}"));
                None
            }
        },
    };
    if !errors.is_empty() {
        return Err(SpecError::Invalid(errors));
    }
    Ok(Spec {
        direction,
        nodes,
        edges,
        groups,
        zones,
        legend,
        remove,
    })
}

/// The one message for a list of problems (a single one stays a plain line).
pub fn problems_message(problems: &[String]) -> String {
    match problems {
        [one] => one.clone(),
        many => format!(
            "{} problems:\n{}",
            many.len(),
            many.iter()
                .map(|p| format!("  {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    }
}
