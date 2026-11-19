//! From the compact spec an agent writes to Excalidraw elements, and back (ADR 2026-11-18, point
//! 7; spec `SPECs/excalidraw-spec.md` "Agent commands"). Rust fills what Excalidraw needs and an
//! agent should not have to know: element ids, seeds and versions, box sizes from the text, bound
//! text, arrow bindings (both ends know the arrow), groups and a layered layout for boxes without
//! a position. The id an agent gave a box is kept in the element's `customData.writerId`, so
//! `add`, `update` and `read` address boxes by it later. Existing elements are never rewritten
//! except for the `boundElements` of a box a new arrow connects to (its version moves, so an
//! open editor sees exactly what changed). Tauri-free.

use super::layout::{self, Direction, Item};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

mod update;
pub use update::update_scene;

const FONT_SIZE: f64 = 20.0;
const LINE_HEIGHT: f64 = 1.25;
/// Excalifont's mean advance is about 0.55 em; a little wider is the safe side for fitting.
const CHAR_WIDTH: f64 = 12.0;
const WRAP_AT: usize = 26;
const ARROW_GAP: f64 = 4.0;
const FONT_FAMILY: u32 = 5;
const INK: &str = "#1e1e1e";

// ---------- the spec ----------

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    /// `LR` (default) or `TB`: the way the flow runs.
    pub direction: Option<String>,
    #[serde(default)]
    pub nodes: Vec<NodeSpec>,
    #[serde(default)]
    pub edges: Vec<EdgeSpec>,
    #[serde(default)]
    pub groups: Vec<GroupSpec>,
    /// `update` only: boxes (their arrows go with them) and arrows `[from, to]` to delete.
    pub remove: Option<RemoveSpec>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveSpec {
    #[serde(default)]
    pub nodes: Vec<String>,
    #[serde(default)]
    pub edges: Vec<(String, String)>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeSpec {
    pub id: String,
    /// The label. In `update`, absent keeps the current one and `""` clears it.
    pub text: Option<String>,
    /// `rectangle` (default), `ellipse`, `diamond` or `text` (a label with no box).
    pub shape: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// An explicit size; the text has to fit in it. Absent: sized from the text.
    pub w: Option<f64>,
    pub h: Option<f64>,
    /// A palette name (blue, green, red, yellow, orange, purple, gray) or `#rrggbb`.
    pub color: Option<String>,
}

/// `["from", "to"]`, `["from", "to", "label"]` or `{"from", "to", "label"}`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum EdgeSpec {
    List(Vec<String>),
    Named {
        from: String,
        to: String,
        /// In `update`, absent keeps the current label and `""` clears it.
        #[serde(default)]
        label: Option<String>,
        /// The arrow's colour (and its label's), as for a box.
        #[serde(default)]
        color: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupSpec {
    pub id: Option<String>,
    pub nodes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub color: Option<String>,
}

impl EdgeSpec {
    /// `(from, to, label, color)` as written: an empty label is kept (in `update` it clears).
    pub fn raw(&self) -> Result<(String, String, Option<String>, Option<String>), String> {
        match self {
            EdgeSpec::List(v) if (2..=3).contains(&v.len()) => {
                Ok((v[0].clone(), v[1].clone(), v.get(2).cloned(), None))
            }
            EdgeSpec::List(v) => Err(format!(
                "an edge is [from, to] or [from, to, label], got {} items",
                v.len()
            )),
            EdgeSpec::Named {
                from,
                to,
                label,
                color,
            } => Ok((from.clone(), to.clone(), label.clone(), color.clone())),
        }
    }

    pub fn normalize(&self) -> Result<Edge, String> {
        let (from, to, label, color) = self.raw()?;
        Ok(Edge {
            from,
            to,
            label: label.filter(|l| !l.is_empty()),
            color,
        })
    }
}

pub fn parse_spec(json: &str) -> Result<Spec, String> {
    serde_json::from_str(json).map_err(|e| format!("the spec is not valid: {e}"))
}

fn direction_of(spec: &Spec) -> Result<Direction, String> {
    match spec
        .direction
        .as_deref()
        .map(str::to_ascii_uppercase)
        .as_deref()
    {
        None | Some("LR") => Ok(Direction::LeftRight),
        Some("TB") => Ok(Direction::TopBottom),
        Some(other) => Err(format!("direction is LR or TB, got {other}")),
    }
}

// ---------- ids and clock ----------

/// Where ids, seeds and the update time come from (the clock and randomness are injected so a
/// test can be exact).
pub struct Gen {
    now_ms: u64,
    state: u128,
}

impl Gen {
    pub fn new() -> Gen {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        Gen {
            now_ms,
            state: uuid::Uuid::new_v4().as_u128(),
        }
    }

    fn next(&mut self) -> u64 {
        // xorshift128+ style mix over a 128-bit state: enough for ids, not for secrets.
        let mut x = self.state;
        x ^= x << 23;
        x ^= x >> 18;
        x ^= x << 5;
        self.state = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        (self.state >> 32) as u64
    }

    fn id(&mut self) -> String {
        const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        (0..21)
            .map(|_| ALPHABET[(self.next() % ALPHABET.len() as u64) as usize] as char)
            .collect()
    }

    fn seed(&mut self) -> u64 {
        self.next() % 2_000_000_000
    }
}

impl Default for Gen {
    fn default() -> Self {
        Gen::new()
    }
}

// ---------- palette ----------

fn palette(name: &str) -> Option<(&'static str, &'static str)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "blue" => ("#1971c2", "#a5d8ff"),
        "green" => ("#2f9e44", "#b2f2bb"),
        "red" => ("#e03131", "#ffc9c9"),
        "yellow" => ("#f08c00", "#ffec99"),
        "orange" => ("#e8590c", "#ffd8a8"),
        "purple" | "violet" => ("#6741d9", "#d0bfff"),
        "gray" | "grey" => ("#495057", "#dee2e6"),
        _ => return None,
    })
}

/// (stroke, background) of a `color`.
fn colors(color: Option<&str>) -> Result<(String, String), String> {
    let Some(c) = color else {
        return Ok((INK.into(), "transparent".into()));
    };
    if let Some((s, b)) = palette(c) {
        return Ok((s.into(), b.into()));
    }
    let hex = c.strip_prefix('#').unwrap_or("");
    if matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|h| h.is_ascii_hexdigit()) {
        return Ok((c.to_string(), "transparent".into()));
    }
    Err(format!(
        "unknown color {c} (blue, green, red, yellow, orange, purple, gray or #rrggbb)"
    ))
}

fn color_name(stroke: &str, background: &str) -> Option<String> {
    ["blue", "green", "red", "yellow", "orange", "purple", "gray"]
        .into_iter()
        .find(|n| palette(n).is_some_and(|(s, b)| s == stroke && b == background))
        .map(str::to_string)
}

// ---------- measuring ----------

fn wrap(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        for word in raw.split(' ') {
            let fits = line.chars().count() + 1 + word.chars().count() <= WRAP_AT;
            if line.is_empty() {
                line = word.to_string();
            } else if fits {
                line.push(' ');
                line.push_str(word);
            } else {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            }
        }
        lines.push(line);
    }
    lines
}

fn text_size(lines: &[String]) -> (f64, f64) {
    let longest = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
    (
        (longest as f64 * CHAR_WIDTH).max(CHAR_WIDTH),
        lines.len() as f64 * FONT_SIZE * LINE_HEIGHT,
    )
}

fn round_up(v: f64, to: f64) -> f64 {
    (v / to).ceil() * to
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Shape {
    Rectangle,
    Ellipse,
    Diamond,
    Text,
}

impl Shape {
    fn parse(s: Option<&str>) -> Result<Shape, String> {
        match s {
            None | Some("rectangle") | Some("box") => Ok(Shape::Rectangle),
            Some("ellipse") => Ok(Shape::Ellipse),
            Some("diamond") => Ok(Shape::Diamond),
            Some("text") => Ok(Shape::Text),
            Some(other) => Err(format!(
                "unknown shape {other} (rectangle, ellipse, diamond or text)"
            )),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Shape::Rectangle => "rectangle",
            Shape::Ellipse => "ellipse",
            Shape::Diamond => "diamond",
            Shape::Text => "text",
        }
    }

    /// The box around `lines` of text.
    fn size(self, lines: &[String]) -> (f64, f64) {
        let (tw, th) = text_size(lines);
        match self {
            Shape::Text => (tw, th),
            Shape::Rectangle => (
                round_up((tw + 40.0).max(120.0), 10.0),
                round_up((th + 30.0).max(60.0), 10.0),
            ),
            Shape::Ellipse => (
                round_up((tw * 1.3 + 40.0).max(130.0), 10.0),
                round_up((th * 1.3 + 30.0).max(70.0), 10.0),
            ),
            Shape::Diamond => (
                round_up((tw * 1.7 + 40.0).max(160.0), 10.0),
                round_up((th * 1.7 + 30.0).max(90.0), 10.0),
            ),
        }
    }
}

// ---------- elements ----------

fn base(kind: &str, id: &str, rect: (f64, f64, f64, f64), g: &mut Gen) -> Map<String, Value> {
    let mut m = Map::new();
    let mut put = |k: &str, v: Value| {
        m.insert(k.to_string(), v);
    };
    put("id", json!(id));
    put("type", json!(kind));
    put("x", json!(rect.0));
    put("y", json!(rect.1));
    put("width", json!(rect.2));
    put("height", json!(rect.3));
    put("angle", json!(0));
    put("strokeColor", json!(INK));
    put("backgroundColor", json!("transparent"));
    put("fillStyle", json!("solid"));
    put("strokeWidth", json!(2));
    put("strokeStyle", json!("solid"));
    put("roughness", json!(1));
    put("opacity", json!(100));
    put("groupIds", json!([]));
    put("frameId", Value::Null);
    put("index", Value::Null);
    put("roundness", Value::Null);
    put("seed", json!(g.seed()));
    put("version", json!(1));
    put("versionNonce", json!(g.seed()));
    put("isDeleted", json!(false));
    put("boundElements", Value::Null);
    put("updated", json!(g.now_ms));
    put("link", Value::Null);
    put("locked", json!(false));
    m
}

fn text_element(
    id: &str,
    lines: &[String],
    original: &str,
    center: (f64, f64),
    container: Option<&str>,
    stroke: &str,
    g: &mut Gen,
) -> Value {
    let (w, h) = text_size(lines);
    let mut m = base(
        "text",
        id,
        (center.0 - w / 2.0, center.1 - h / 2.0, w, h),
        g,
    );
    m.insert("strokeColor".into(), json!(stroke));
    m.insert("fontSize".into(), json!(FONT_SIZE));
    m.insert("fontFamily".into(), json!(FONT_FAMILY));
    m.insert("text".into(), json!(lines.join("\n")));
    m.insert(
        "textAlign".into(),
        json!(if container.is_some() {
            "center"
        } else {
            "left"
        }),
    );
    m.insert(
        "verticalAlign".into(),
        json!(if container.is_some() { "middle" } else { "top" }),
    );
    m.insert("containerId".into(), json!(container));
    m.insert("originalText".into(), json!(original));
    m.insert("autoResize".into(), json!(true));
    m.insert("lineHeight".into(), json!(LINE_HEIGHT));
    Value::Object(m)
}

fn bump(el: &mut Value, g: &mut Gen) {
    let v = el["version"].as_u64().unwrap_or(1);
    el["version"] = json!(v + 1);
    el["versionNonce"] = json!(g.seed());
    el["updated"] = json!(g.now_ms);
}

fn push_bound(el: &mut Value, id: &str, kind: &str) {
    let entry = json!({"id": id, "type": kind});
    match el["boundElements"].as_array_mut() {
        Some(list) => list.push(entry),
        None => el["boundElements"] = json!([entry]),
    }
}

/// The size of a box: `natural` (from its text) unless `w`/`h` say otherwise, and the text has
/// to fit in what they say.
fn fit_size(
    id: &str,
    natural: (f64, f64),
    text: &str,
    lines: &[String],
    w: Option<f64>,
    h: Option<f64>,
) -> Result<(f64, f64), String> {
    if w.is_some_and(|v| v <= 0.0) || h.is_some_and(|v| v <= 0.0) {
        return Err(format!("node {id}: w and h are positive"));
    }
    let size = (w.unwrap_or(natural.0), h.unwrap_or(natural.1));
    let need = text_size(lines);
    if !text.is_empty() && ((w.is_some() && size.0 < need.0) || (h.is_some() && size.1 < need.1)) {
        return Err(format!(
            "node {id}: the text needs at least {} x {}",
            need.0.ceil(),
            need.1.ceil()
        ));
    }
    Ok(size)
}

type Rect = (f64, f64, f64, f64);

/// One end of an arrow: a box it is bound to, or a free point.
#[derive(Clone, Copy)]
enum End {
    Box(Rect),
    Point((f64, f64)),
}

/// Where an arrow between two ends starts and stops: on each box's outline towards the other
/// end, with a small gap.
fn route(a: End, b: End) -> ((f64, f64), (f64, f64)) {
    let anchor = |e: End| match e {
        End::Box(r) => center(r),
        End::Point(p) => p,
    };
    let (ca, cb) = (anchor(a), anchor(b));
    let mut s = match a {
        End::Box(r) => boundary(r, cb),
        End::Point(p) => p,
    };
    let mut t = match b {
        End::Box(r) => boundary(r, ca),
        End::Point(p) => p,
    };
    let len = ((t.0 - s.0).powi(2) + (t.1 - s.1).powi(2)).sqrt();
    if len > 3.0 * ARROW_GAP {
        let (ux, uy) = ((t.0 - s.0) / len, (t.1 - s.1) / len);
        if matches!(a, End::Box(_)) {
            s = (s.0 + ux * ARROW_GAP, s.1 + uy * ARROW_GAP);
        }
        if matches!(b, End::Box(_)) {
            t = (t.0 - ux * ARROW_GAP, t.1 - uy * ARROW_GAP);
        }
    }
    (s, t)
}

// ---------- the nodes already in a drawing ----------

fn is_box(el: &Value) -> bool {
    !super::excalidraw_md::is_deleted(el)
        && matches!(
            el["type"].as_str(),
            Some("rectangle" | "ellipse" | "diamond")
        )
}

fn is_free_text(el: &Value) -> bool {
    !super::excalidraw_md::is_deleted(el) && el["type"] == "text" && el["containerId"].is_null()
}

fn node_key(el: &Value) -> String {
    el["customData"]["writerId"]
        .as_str()
        .or_else(|| el["id"].as_str())
        .unwrap_or("")
        .to_string()
}

fn rect_of(el: &Value) -> Rect {
    let n = |k: &str| el[k].as_f64().unwrap_or(0.0);
    (n("x"), n("y"), n("width"), n("height"))
}

/// The boxes (and free texts) of a scene by the key an agent addresses them with.
fn nodes_by_key(scene: &Value) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for (i, el) in super::excalidraw_md::elements(scene).iter().enumerate() {
        if is_box(el) || is_free_text(el) {
            out.entry(node_key(el)).or_insert(i);
            if let Some(id) = el["id"].as_str() {
                out.entry(id.to_string()).or_insert(i);
            }
        }
    }
    out
}

fn center(r: (f64, f64, f64, f64)) -> (f64, f64) {
    (r.0 + r.2 / 2.0, r.1 + r.3 / 2.0)
}

/// Where the line from the centre of `r` towards `to` leaves `r`.
fn boundary(r: (f64, f64, f64, f64), to: (f64, f64)) -> (f64, f64) {
    let c = center(r);
    let (dx, dy) = (to.0 - c.0, to.1 - c.1);
    if dx == 0.0 && dy == 0.0 {
        return c;
    }
    let tx = if dx == 0.0 {
        f64::MAX
    } else {
        (r.2 / 2.0) / dx.abs()
    };
    let ty = if dy == 0.0 {
        f64::MAX
    } else {
        (r.3 / 2.0) / dy.abs()
    };
    let t = tx.min(ty);
    (c.0 + dx * t, c.1 + dy * t)
}

// ---------- adding ----------

#[derive(Debug, PartialEq, Eq)]
pub struct Added {
    pub nodes: usize,
    pub edges: usize,
}

struct NewNode {
    key: String,
    el_id: String,
    shape: Shape,
    lines: Vec<String>,
    original: String,
    stroke: String,
    background: String,
    size: (f64, f64),
    at: Option<(f64, f64)>,
}

fn push_elements(scene: &mut Value, els: Vec<Value>) {
    let list = scene["elements"]
        .as_array_mut()
        .expect("a scene has elements");
    list.extend(els);
}

/// Add the nodes, edges and groups of `spec` to `scene` (which may be empty). Everything is
/// checked first: a bad spec leaves the scene as it was.
pub fn add_to_scene(scene: &mut Value, spec: &Spec, g: &mut Gen) -> Result<Added, String> {
    if spec.remove.is_some() {
        return Err("remove is only for update".into());
    }
    let direction = direction_of(spec)?;
    let existing = nodes_by_key(scene);

    let mut nodes: Vec<NewNode> = Vec::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for n in &spec.nodes {
        if n.id.trim().is_empty() {
            return Err("every node needs an id".into());
        }
        if !seen.insert(&n.id) {
            return Err(format!("node id {} is used twice", n.id));
        }
        if existing.contains_key(&n.id) {
            return Err(format!("node id {} already exists in the drawing", n.id));
        }
        let shape = Shape::parse(n.shape.as_deref())?;
        let at = match (n.x, n.y) {
            (Some(x), Some(y)) => Some((x, y)),
            (None, None) => None,
            _ => return Err(format!("node {}: give both x and y, or neither", n.id)),
        };
        let (stroke, background) = colors(n.color.as_deref())?;
        let text = n.text.clone().unwrap_or_default();
        let lines = wrap(&text);
        nodes.push(NewNode {
            key: n.id.clone(),
            el_id: g.id(),
            shape,
            size: fit_size(&n.id, shape.size(&lines), &text, &lines, n.w, n.h)?,
            lines,
            original: text,
            stroke,
            background,
            at,
        });
    }
    let new_keys: BTreeSet<&str> = nodes.iter().map(|n| n.key.as_str()).collect();
    let known = |k: &str| new_keys.contains(k) || existing.contains_key(k);
    let edges: Vec<Edge> = spec
        .edges
        .iter()
        .map(EdgeSpec::normalize)
        .collect::<Result<_, _>>()?;
    for e in &edges {
        for end in [&e.from, &e.to] {
            if !known(end) {
                return Err(format!("edge {} -> {}: no node {end}", e.from, e.to));
            }
        }
        if e.from == e.to {
            return Err(format!(
                "edge {} -> {}: a node cannot point at itself",
                e.from, e.to
            ));
        }
        if let Some(c) = &e.color {
            colors(Some(c)).map_err(|m| format!("edge {} -> {}: {m}", e.from, e.to))?;
        }
    }
    for grp in &spec.groups {
        for k in &grp.nodes {
            if !new_keys.contains(k.as_str()) {
                return Err(format!(
                    "group member {k} is not one of the nodes being added"
                ));
            }
        }
    }

    // layout: existing boxes are fixed obstacles, new boxes without a place are laid out
    let mut items: Vec<Item> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let els = super::excalidraw_md::elements(scene);
    let mut item_of_element: HashMap<usize, usize> = HashMap::new();
    let mut existing_el_id: HashMap<String, String> = HashMap::new();
    for (key, &i) in &existing {
        let item = *item_of_element.entry(i).or_insert_with(|| {
            let r = rect_of(&els[i]);
            items.push(Item {
                w: r.2,
                h: r.3,
                at: Some((r.0, r.1)),
            });
            items.len() - 1
        });
        index.insert(key.clone(), item);
        existing_el_id.insert(key.clone(), els[i]["id"].as_str().unwrap_or("").to_string());
    }
    for n in &nodes {
        index.insert(n.key.clone(), items.len());
        items.push(Item {
            w: n.size.0,
            h: n.size.1,
            at: n.at,
        });
    }
    let pairs: Vec<(usize, usize)> = edges
        .iter()
        .map(|e| (index[&e.from], index[&e.to]))
        .collect();
    let at = layout::place(&items, &pairs, direction);

    // build
    let mut built: Vec<Value> = Vec::new();
    let mut rects: HashMap<String, (f64, f64, f64, f64)> = HashMap::new();
    for (key, &i) in &existing {
        rects.insert(key.clone(), rect_of(&els[i]));
    }
    let mut group_of: HashMap<&str, String> = HashMap::new();
    for grp in &spec.groups {
        let gid = grp.id.clone().unwrap_or_else(|| g.id());
        for k in &grp.nodes {
            group_of.insert(k.as_str(), gid.clone());
        }
    }
    for n in &nodes {
        let (x, y) = at[index[&n.key]];
        let rect = (x, y, n.size.0, n.size.1);
        rects.insert(n.key.clone(), rect);
        let groups = group_of
            .get(n.key.as_str())
            .map(|id| json!([id]))
            .unwrap_or(json!([]));
        let custom = json!({"writerId": n.key});
        if n.shape == Shape::Text {
            let mut t = text_element(
                &n.el_id,
                &n.lines,
                &n.original,
                center(rect),
                None,
                &n.stroke,
                g,
            );
            t["groupIds"] = groups;
            t["customData"] = custom;
            built.push(t);
            continue;
        }
        let mut m = base(n.shape.name(), &n.el_id, rect, g);
        m.insert("strokeColor".into(), json!(n.stroke));
        m.insert("backgroundColor".into(), json!(n.background));
        m.insert(
            "roundness".into(),
            match n.shape {
                Shape::Rectangle => json!({"type": 3}),
                Shape::Diamond => json!({"type": 2}),
                _ => Value::Null,
            },
        );
        m.insert("groupIds".into(), groups.clone());
        m.insert("customData".into(), custom);
        let mut container = Value::Object(m);
        if !n.original.is_empty() {
            let text_id = g.id();
            push_bound(&mut container, &text_id, "text");
            let mut t = text_element(
                &text_id,
                &n.lines,
                &n.original,
                center(rect),
                Some(&n.el_id),
                &n.stroke,
                g,
            );
            t["groupIds"] = groups;
            built.push(container);
            built.push(t);
        } else {
            built.push(container);
        }
    }
    let mut arrows: Vec<Value> = Vec::new();
    let mut attach: Vec<(String, String)> = Vec::new(); // (node key, arrow id)
    let el_id_of = |key: &str, built: &[Value]| -> String {
        if let Some(id) = existing_el_id.get(key) {
            return id.clone();
        }
        built
            .iter()
            .find(|e| e["customData"]["writerId"] == key)
            .and_then(|e| e["id"].as_str())
            .unwrap_or("")
            .to_string()
    };
    for e in &edges {
        let (s, t) = route(End::Box(rects[&e.from]), End::Box(rects[&e.to]));
        let (dx, dy) = (t.0 - s.0, t.1 - s.1);
        let arrow_id = g.id();
        let mut m = base("arrow", &arrow_id, (s.0, s.1, dx.abs(), dy.abs()), g);
        m.insert("roundness".into(), json!({"type": 2}));
        m.insert("points".into(), json!([[0, 0], [dx, dy]]));
        m.insert("lastCommittedPoint".into(), Value::Null);
        m.insert(
            "startBinding".into(),
            json!({"elementId": el_id_of(&e.from, &built), "focus": 0, "gap": ARROW_GAP}),
        );
        m.insert(
            "endBinding".into(),
            json!({"elementId": el_id_of(&e.to, &built), "focus": 0, "gap": ARROW_GAP}),
        );
        m.insert("startArrowhead".into(), Value::Null);
        m.insert("endArrowhead".into(), json!("arrow"));
        m.insert("elbowed".into(), json!(false));
        let ink = e.color.as_deref().map_or(INK.to_string(), |c| {
            colors(Some(c)).expect("checked above").0
        });
        m.insert("strokeColor".into(), json!(ink));
        let mut arrow = Value::Object(m);
        let mut label_el = None;
        if let Some(label) = &e.label {
            let text_id = g.id();
            let lines = wrap(label);
            push_bound(&mut arrow, &text_id, "text");
            let mid = (s.0 + dx / 2.0, s.1 + dy / 2.0);
            label_el = Some(text_element(
                &text_id,
                &lines,
                label,
                mid,
                Some(&arrow_id),
                &ink,
                g,
            ));
        }
        arrows.push(arrow);
        arrows.extend(label_el);
        attach.push((e.from.clone(), arrow_id.clone()));
        attach.push((e.to.clone(), arrow_id));
    }

    // commit: the new elements, then the arrows; the boxes an arrow ends on learn about it
    let new_count = nodes.len();
    let edge_count = edges.len();
    built.extend(arrows);
    for (key, arrow_id) in attach {
        if let Some(&i) = existing.get(&key) {
            let list = scene["elements"]
                .as_array_mut()
                .expect("a scene has elements");
            push_bound(&mut list[i], &arrow_id, "arrow");
            bump(&mut list[i], g);
        } else {
            let id = el_id_of(&key, &built);
            if let Some(el) = built.iter_mut().find(|e| e["id"] == id.as_str()) {
                push_bound(el, &arrow_id, "arrow");
            }
        }
    }
    push_elements(scene, built);
    Ok(Added {
        nodes: new_count,
        edges: edge_count,
    })
}

// ---------- reading back ----------

/// The compact spec of a scene: its boxes, the arrows between them and its groups, plus a count of
/// what else it holds. What `excalidraw:read` prints, in the grammar `create` and `add` take.
pub fn read_spec(scene: &Value) -> Value {
    let els = super::excalidraw_md::elements(scene);
    let keys: HashMap<&str, String> = els
        .iter()
        .filter(|e| is_box(e) || is_free_text(e))
        .filter_map(|e| Some((e["id"].as_str()?, node_key(e))))
        .collect();
    let text_of = |container_id: &str| -> Option<String> {
        els.iter()
            .find(|t| {
                t["type"] == "text"
                    && t["containerId"] == container_id
                    && !super::excalidraw_md::is_deleted(t)
            })
            .map(|t| {
                t["originalText"]
                    .as_str()
                    .or_else(|| t["text"].as_str())
                    .unwrap_or("")
                    .to_string()
            })
    };
    let mut nodes = Vec::new();
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for el in els.iter().filter(|e| is_box(e) || is_free_text(e)) {
        let id = el["id"].as_str().unwrap_or("");
        let text = if el["type"] == "text" {
            el["originalText"]
                .as_str()
                .or_else(|| el["text"].as_str())
                .unwrap_or("")
                .to_string()
        } else {
            text_of(id).unwrap_or_default()
        };
        let r = rect_of(el);
        let mut n = json!({
            "id": node_key(el),
            "text": text,
            "shape": el["type"],
            "x": r.0.round(), "y": r.1.round(), "w": r.2.round(), "h": r.3.round(),
        });
        if let (Some(s), Some(b)) = (el["strokeColor"].as_str(), el["backgroundColor"].as_str()) {
            if let Some(name) = color_name(s, b) {
                n["color"] = json!(name);
            } else if el["type"] != "text" && s != INK {
                n["color"] = json!(s);
            }
        }
        for gid in el["groupIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            groups
                .entry(gid.to_string())
                .or_default()
                .push(node_key(el));
        }
        nodes.push(n);
    }
    let mut edges = Vec::new();
    let mut other: BTreeMap<String, usize> = BTreeMap::new();
    for el in els.iter().filter(|e| !super::excalidraw_md::is_deleted(e)) {
        match el["type"].as_str().unwrap_or("") {
            "arrow" => {
                let end = |k: &str| el[k]["elementId"].as_str().and_then(|id| keys.get(id));
                match (end("startBinding"), end("endBinding")) {
                    (Some(a), Some(b)) => {
                        let label = el["id"].as_str().and_then(text_of);
                        edges.push(match label {
                            Some(l) => json!([a, b, l]),
                            None => json!([a, b]),
                        });
                    }
                    _ => *other.entry("arrow".into()).or_default() += 1,
                }
            }
            "rectangle" | "ellipse" | "diamond" => {}
            "text" => {
                if !el["containerId"].is_null() {
                    continue;
                }
            }
            t => *other.entry(t.to_string()).or_default() += 1,
        }
    }
    let groups: Vec<Value> = groups
        .into_iter()
        .filter(|(_, m)| m.len() > 1)
        .map(|(id, m)| json!({"id": id, "nodes": m}))
        .collect();
    let mut out = json!({"nodes": nodes, "edges": edges});
    if !groups.is_empty() {
        out["groups"] = json!(groups);
    }
    if !other.is_empty() {
        out["other"] = json!(other);
    }
    out
}

// ---------- validity ----------

const KNOWN_TYPES: &[&str] = &[
    "rectangle",
    "diamond",
    "ellipse",
    "arrow",
    "line",
    "freedraw",
    "text",
    "image",
    "frame",
    "magicframe",
    "embeddable",
    "iframe",
    "selection",
];

/// Is the scene one Excalidraw opens as drawn: unique ids, the fields every element has, text
/// bound to a container that knows it, arrows bound to elements that know them? The first
/// problem is the error.
pub fn validate_scene(scene: &Value) -> Result<(), String> {
    let els = scene["elements"].as_array().ok_or("no elements list")?;
    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for el in els {
        let id = el["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("an element has no id")?;
        if by_id.insert(id, el).is_some() {
            return Err(format!("element id {id} appears twice"));
        }
        let kind = el["type"].as_str().ok_or(format!("{id}: no type"))?;
        if !KNOWN_TYPES.contains(&kind) {
            return Err(format!("{id}: unknown type {kind}"));
        }
        for k in [
            "x",
            "y",
            "width",
            "height",
            "seed",
            "version",
            "versionNonce",
        ] {
            if !el[k].is_number() {
                return Err(format!("{id}: {k} is not a number"));
            }
        }
        if el["version"].as_u64().unwrap_or(0) < 1 {
            return Err(format!("{id}: version starts at 1"));
        }
        if !el["isDeleted"].is_boolean() {
            return Err(format!("{id}: isDeleted is not a boolean"));
        }
        if !el["groupIds"].is_array() {
            return Err(format!("{id}: groupIds is not a list"));
        }
    }
    let bound_to = |container: &Value, id: &str, kind: &str| {
        container["boundElements"]
            .as_array()
            .is_some_and(|l| l.iter().any(|b| b["id"] == id && b["type"] == kind))
    };
    for el in els {
        let id = el["id"].as_str().unwrap_or("");
        match el["type"].as_str().unwrap_or("") {
            "text" => {
                if !el["text"].is_string() || !el["fontSize"].is_number() {
                    return Err(format!("{id}: a text needs text and fontSize"));
                }
                if let Some(c) = el["containerId"].as_str() {
                    let container = by_id
                        .get(c)
                        .ok_or(format!("{id}: container {c} does not exist"))?;
                    if !bound_to(container, id, "text") {
                        return Err(format!(
                            "{id}: container {c} does not list it in boundElements"
                        ));
                    }
                }
            }
            "arrow" | "line" => {
                let pts = el["points"].as_array().ok_or(format!("{id}: no points"))?;
                if pts.len() < 2
                    || !pts.iter().all(|p| {
                        p.as_array()
                            .is_some_and(|a| a.len() == 2 && a.iter().all(Value::is_number))
                    })
                {
                    return Err(format!("{id}: points are not a list of [x, y] pairs"));
                }
                for end in ["startBinding", "endBinding"] {
                    if el[end].is_null() {
                        continue;
                    }
                    let target = el[end]["elementId"]
                        .as_str()
                        .ok_or(format!("{id}: {end} has no elementId"))?;
                    let t = by_id
                        .get(target)
                        .ok_or(format!("{id}: {end} points at missing {target}"))?;
                    if !bound_to(t, id, "arrow") {
                        return Err(format!(
                            "{id}: {target} does not list the arrow in boundElements"
                        ));
                    }
                }
            }
            _ => {}
        }
        for b in el["boundElements"].as_array().into_iter().flatten() {
            let bid = b["id"]
                .as_str()
                .ok_or(format!("{id}: a boundElements entry has no id"))?;
            let target = by_id
                .get(bid)
                .ok_or(format!("{id}: boundElements names missing {bid}"))?;
            match b["type"].as_str() {
                Some("text") if target["containerId"] != id => {
                    return Err(format!("{id}: bound text {bid} names another container"));
                }
                Some("text") | Some("arrow") => {}
                other => return Err(format!("{id}: boundElements type {other:?}")),
            }
        }
    }
    Ok(())
}
