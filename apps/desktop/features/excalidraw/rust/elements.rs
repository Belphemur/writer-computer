//! From the compact spec an agent writes to Excalidraw elements, and back (ADR 2026-11-18, point
//! 7; spec `SPECs/excalidraw-spec.md` "Agent commands"). Rust fills what Excalidraw needs and an
//! agent should not have to know: element ids, seeds and versions, box sizes from the text (a
//! text wraps at the box's `w`, or the box grows), bound text, arrow bindings (both ends know the
//! arrow), straight and elbow routes between chosen sides, groups, zones (frames around their
//! boxes), a legend under the drawing and a layered layout for boxes without a position. The id an
//! agent gave a box is kept in the element's `customData.writerId`, so `add`, `update` and `read`
//! address boxes by it later. Existing elements are never rewritten except for the
//! `boundElements` of a box a new arrow connects to (its version moves, so an open editor sees
//! exactly what changed). A bad spec reports every problem at once and writes nothing. Tauri-free.
//!
//! Submodules: `spec` (the grammar and its parse), `zones`, `read` (a scene back to a spec) and
//! `update` (change what is there).

use super::layout::{self, Direction, Item};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

mod read;
mod spec;
mod update;
mod zones;
pub use read::{link_targets, read_spec};
pub use spec::{parse_spec, problems_message, EdgeSpec, NodeSpec, Spec, SpecError};
pub use update::update_scene;

const FONT_SIZE: f64 = 20.0;
const LINE_HEIGHT: f64 = 1.25;
/// Excalifont's mean advance is about 0.6 em; a little wider is the safe side for fitting.
const CHAR_EM: f64 = 0.6;
/// A box without a width grows to fit its text up to this many em of text, then wraps.
const MAX_TEXT_EM: f64 = 15.6;
const ARROW_GAP: f64 = 4.0;
const FONT_FAMILY: u32 = 5;
const INK: &str = "#1e1e1e";
const LEGEND_FONT: f64 = 16.0;
const LEGEND_WIDTH: f64 = 700.0;

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

fn is_hex(c: &str) -> bool {
    let hex = c.strip_prefix('#').unwrap_or("");
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|h| h.is_ascii_hexdigit())
}

const COLOR_HELP: &str = "blue, green, red, yellow, orange, purple, gray or #rrggbb";

/// (stroke, background) of a `color`.
fn colors(color: Option<&str>) -> Result<(String, String), String> {
    let Some(c) = color else {
        return Ok((INK.into(), "transparent".into()));
    };
    if let Some((s, b)) = palette(c) {
        return Ok((s.into(), b.into()));
    }
    if is_hex(c) {
        return Ok((c.to_string(), "transparent".into()));
    }
    Err(format!("unknown color {c} ({COLOR_HELP})"))
}

/// One colour as a stroke (a palette name's strong tone) or a fill (its light tone).
fn tone(c: &str, fill: bool) -> Result<String, String> {
    if let Some((s, b)) = palette(c) {
        return Ok((if fill { b } else { s }).into());
    }
    if is_hex(c) || (fill && c == "transparent") {
        return Ok(c.to_string());
    }
    Err(format!(
        "unknown {} {c} ({COLOR_HELP}{})",
        if fill { "fill" } else { "stroke" },
        if fill { " or transparent" } else { "" }
    ))
}

/// (stroke, background) from the `color` shorthand with `stroke` and `fill` overriding a half.
fn tints(
    color: Option<&str>,
    fill: Option<&str>,
    stroke: Option<&str>,
) -> Result<(String, String), String> {
    let (s, b) = colors(color)?;
    Ok((
        stroke.map(|c| tone(c, false)).transpose()?.unwrap_or(s),
        fill.map(|c| tone(c, true)).transpose()?.unwrap_or(b),
    ))
}

fn color_name(stroke: &str, background: &str) -> Option<String> {
    ["blue", "green", "red", "yellow", "orange", "purple", "gray"]
        .into_iter()
        .find(|n| palette(n).is_some_and(|(s, b)| s == stroke && b == background))
        .map(str::to_string)
}

const STROKE_STYLES: &[&str] = &["solid", "dashed", "dotted"];

fn stroke_style(s: Option<&str>) -> Result<Option<&'static str>, String> {
    match s {
        None => Ok(None),
        Some(v) => STROKE_STYLES
            .iter()
            .find(|k| **k == v)
            .map(|k| Some(*k))
            .ok_or_else(|| format!("unknown style {v} (solid, dashed or dotted)")),
    }
}

/// `[[Note]]` (alias and heading allowed) or a URL.
fn check_link(link: &str) -> Result<(), String> {
    let wiki = link.starts_with("[[") && link.ends_with("]]") && link.len() > 4;
    if wiki || link.contains("://") {
        Ok(())
    } else {
        Err(format!("link {link} is [[Note]] or a URL"))
    }
}

// ---------- measuring ----------

fn char_width(font: f64) -> f64 {
    font * CHAR_EM
}

fn line_height(font: f64) -> f64 {
    font * LINE_HEIGHT
}

/// `text` wrapped to `width` pixels of text (absent: [`MAX_TEXT_EM`]); a word wider than the
/// width stays whole on its line.
fn wrap(text: &str, font: f64, width: Option<f64>) -> Vec<String> {
    let per_line =
        ((width.unwrap_or(MAX_TEXT_EM * font) / char_width(font)).floor() as usize).max(1);
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        for word in raw.split(' ') {
            let fits = line.chars().count() + 1 + word.chars().count() <= per_line;
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

fn text_size(lines: &[String], font: f64) -> (f64, f64) {
    let longest = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
    (
        (longest as f64 * char_width(font)).max(char_width(font)),
        lines.len() as f64 * line_height(font),
    )
}

fn round_up(v: f64, to: f64) -> f64 {
    (v / to).ceil() * to
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Shape {
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

    /// How much bigger than its text the shape has to be: (width factor, height factor, padding
    /// w, padding h). The text of an ellipse or a diamond sits in a smaller area than the shape.
    fn room(self) -> (f64, f64, f64, f64) {
        match self {
            Shape::Text => (1.0, 1.0, 0.0, 0.0),
            Shape::Rectangle => (1.0, 1.0, 40.0, 30.0),
            Shape::Ellipse => (1.3, 1.3, 40.0, 30.0),
            Shape::Diamond => (1.7, 1.7, 40.0, 30.0),
        }
    }

    /// The width available to text in a shape `w` wide.
    fn text_width(self, w: f64) -> f64 {
        let (f, _, pad, _) = self.room();
        ((w - pad) / f).max(char_width(FONT_SIZE))
    }

    /// The least box that holds `lines`.
    pub(crate) fn min_size(self, lines: &[String], font: f64) -> (f64, f64) {
        let (tw, th) = text_size(lines, font);
        let (fw, fh, pw, ph) = self.room();
        (tw * fw + pw, th * fh + ph)
    }

    /// The box around `lines` of text, rounded up to a grid, never smaller than a default box.
    fn size(self, lines: &[String], font: f64) -> (f64, f64) {
        let (w, h) = self.min_size(lines, font);
        let floor = match self {
            Shape::Text => return (w, h),
            Shape::Rectangle => (120.0, 60.0),
            Shape::Ellipse => (130.0, 70.0),
            Shape::Diamond => (160.0, 90.0),
        };
        (
            round_up(w.max(floor.0), 10.0),
            round_up(h.max(floor.1), 10.0),
        )
    }
}

/// The text of a node laid out: wrapped at the box's `w` when given.
fn lay_text(shape: Shape, text: &str, font: f64, w: Option<f64>) -> Vec<String> {
    wrap(text, font, w.map(|w| shape.text_width(w)))
}

/// The size of a box: the one that fits its text unless `w`/`h` say otherwise, and the text has
/// to fit in what they say.
fn fit_size(
    id: &str,
    shape: Shape,
    lines: &[String],
    font: f64,
    w: Option<f64>,
    h: Option<f64>,
    least: (f64, f64),
) -> Result<(f64, f64), String> {
    if w.is_some_and(|v| v <= 0.0) || h.is_some_and(|v| v <= 0.0) {
        return Err(format!("node {id}: w and h are positive"));
    }
    let natural = shape.size(lines, font);
    let size = (
        w.unwrap_or(natural.0.max(least.0)),
        h.unwrap_or(natural.1.max(least.1)),
    );
    let need = shape.min_size(lines, font);
    let has_text = lines.iter().any(|l| !l.is_empty());
    if has_text
        && ((w.is_some() && size.0 + 0.5 < need.0) || (h.is_some() && size.1 + 0.5 < need.1))
    {
        return Err(format!(
            "node {id}: the text overflows its {} x {} box, it needs at least {} x {}",
            size.0,
            size.1,
            need.0.ceil(),
            need.1.ceil()
        ));
    }
    Ok(size)
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
    (stroke, font): (&str, f64),
    g: &mut Gen,
) -> Value {
    let (w, h) = text_size(lines, font);
    let mut m = base(
        "text",
        id,
        (center.0 - w / 2.0, center.1 - h / 2.0, w, h),
        g,
    );
    m.insert("strokeColor".into(), json!(stroke));
    m.insert("fontSize".into(), json!(font));
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

type Rect = (f64, f64, f64, f64);

fn center(r: Rect) -> (f64, f64) {
    (r.0 + r.2 / 2.0, r.1 + r.3 / 2.0)
}

// ---------- arrows: ends, sides, routes ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

impl Side {
    pub(crate) fn parse(s: &str) -> Result<Side, String> {
        match s {
            "top" => Ok(Side::Top),
            "right" => Ok(Side::Right),
            "bottom" => Ok(Side::Bottom),
            "left" => Ok(Side::Left),
            other => Err(format!("unknown side {other} (top, right, bottom or left)")),
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Side::Top => "top",
            Side::Right => "right",
            Side::Bottom => "bottom",
            Side::Left => "left",
        }
    }

    pub(crate) fn horizontal(self) -> bool {
        matches!(self, Side::Left | Side::Right)
    }

    /// The unit vector pointing out of the box.
    fn out(self) -> (f64, f64) {
        match self {
            Side::Top => (0.0, -1.0),
            Side::Right => (1.0, 0.0),
            Side::Bottom => (0.0, 1.0),
            Side::Left => (-1.0, 0.0),
        }
    }

    /// The middle of the side of `r`, as a fraction of the box (Excalidraw's `fixedPoint`).
    fn fraction(self) -> (f64, f64) {
        match self {
            Side::Top => (0.5, 0.0),
            Side::Right => (1.0, 0.5),
            Side::Bottom => (0.5, 1.0),
            Side::Left => (0.0, 0.5),
        }
    }

    fn point(self, r: Rect) -> (f64, f64) {
        let f = self.fraction();
        (r.0 + r.2 * f.0, r.1 + r.3 * f.1)
    }

    /// The sides that face each other for boxes whose centres differ by `(dx, dy)`.
    fn facing(dx: f64, dy: f64) -> (Side, Side) {
        if dx.abs() >= dy.abs() {
            if dx >= 0.0 {
                (Side::Right, Side::Left)
            } else {
                (Side::Left, Side::Right)
            }
        } else if dy >= 0.0 {
            (Side::Bottom, Side::Top)
        } else {
            (Side::Top, Side::Bottom)
        }
    }
}

/// A validated arrow: what the spec says with every enumerated value parsed.
#[derive(Debug, Clone)]
pub(crate) struct EdgePlan {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub ink: String,
    pub style: Option<&'static str>,
    pub bidirectional: bool,
    pub label_at: Option<f64>,
    pub sides: (Option<Side>, Option<Side>),
    pub elbow: bool,
}

impl EdgePlan {
    /// Parse an edge's own fields; endpoints are checked by the caller (it knows the nodes).
    pub(crate) fn from_spec(e: &EdgeSpec) -> Result<EdgePlan, String> {
        let at = |m: String| format!("edge {} -> {}: {m}", e.from, e.to);
        let ink = match &e.color {
            Some(c) => colors(Some(c)).map_err(at)?.0,
            None => INK.to_string(),
        };
        let style = stroke_style(e.style.as_deref()).map_err(at)?;
        if let Some(l) = e.label_at {
            if !(0.0..=1.0).contains(&l) {
                return Err(at(format!("labelAt is from 0 to 1, got {l}")));
            }
        }
        let side = |s: &Option<String>| s.as_deref().map(Side::parse).transpose().map_err(at);
        let elbow = match e.route.as_deref() {
            None | Some("straight") => false,
            Some("elbow") => true,
            Some(other) => return Err(at(format!("route is straight or elbow, got {other}"))),
        };
        Ok(EdgePlan {
            from: e.from.clone(),
            to: e.to.clone(),
            label: e.label_text().map(str::to_string),
            ink,
            style,
            bidirectional: e.bidirectional.unwrap_or(false),
            label_at: e.label_at.filter(|l| (l - 0.5).abs() > 1e-9),
            sides: (side(&e.from_side)?, side(&e.to_side)?),
            elbow,
        })
    }

    /// What re-drawing an arrow that exists needs: its route and sides.
    pub(crate) fn for_route(elbow: bool, sides: (Option<Side>, Option<Side>)) -> EdgePlan {
        EdgePlan {
            from: String::new(),
            to: String::new(),
            label: None,
            ink: INK.into(),
            style: None,
            bidirectional: false,
            label_at: None,
            sides,
            elbow,
        }
    }

    pub(crate) fn explicit_sides(&self) -> Option<[&'static str; 2]> {
        match self.sides {
            (None, None) => None,
            (a, b) => Some([a.map_or("", Side::name), b.map_or("", Side::name)]),
        }
    }
}

/// The drawn path of an arrow: absolute points, and the sides it was bound on when they are
/// known (an elbow needs them for its bindings).
pub(crate) struct Path {
    pub points: Vec<(f64, f64)>,
    pub sides: Option<(Side, Side)>,
}

/// A path with no point on the line between its neighbours.
fn tidy(points: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    for p in points {
        if out.last() == Some(&p) {
            continue;
        }
        while out.len() >= 2 {
            let (a, b) = (out[out.len() - 2], out[out.len() - 1]);
            let flat = (a.0 == b.0 && b.0 == p.0) || (a.1 == b.1 && b.1 == p.1);
            if flat {
                out.pop();
            } else {
                break;
            }
        }
        out.push(p);
    }
    out
}

/// Where an arrow between two boxes runs: straight between their outlines, or, when sides are
/// chosen or the route is an elbow, between the middles of those sides (the sides facing each
/// other when only one is given), with right angles for an elbow.
pub(crate) fn arrow_path(a: Rect, b: Rect, plan: &EdgePlan) -> Path {
    if !plan.elbow && plan.sides == (None, None) {
        let (s, t) = route(End::Box(a), End::Box(b));
        return Path {
            points: vec![s, t],
            sides: None,
        };
    }
    let (ca, cb) = (center(a), center(b));
    let (fa, fb) = Side::facing(cb.0 - ca.0, cb.1 - ca.1);
    let sa = plan.sides.0.unwrap_or(fa);
    let sb = plan.sides.1.unwrap_or(fb);
    let off = |p: (f64, f64), s: Side| (p.0 + s.out().0 * ARROW_GAP, p.1 + s.out().1 * ARROW_GAP);
    let (s, t) = (off(sa.point(a), sa), off(sb.point(b), sb));
    if !plan.elbow {
        return Path {
            points: vec![s, t],
            sides: Some((sa, sb)),
        };
    }
    const STUB: f64 = 30.0;
    let points = match (sa.horizontal(), sb.horizontal()) {
        (true, true) => {
            let facing = sa.out().0 * (t.0 - s.0) > 0.0 && sb.out().0 * (s.0 - t.0) > 0.0;
            let mid = if facing {
                (s.0 + t.0) / 2.0
            } else if sa.out().0 > 0.0 {
                s.0.max(t.0) + STUB
            } else {
                s.0.min(t.0) - STUB
            };
            vec![s, (mid, s.1), (mid, t.1), t]
        }
        (false, false) => {
            let facing = sa.out().1 * (t.1 - s.1) > 0.0 && sb.out().1 * (s.1 - t.1) > 0.0;
            let mid = if facing {
                (s.1 + t.1) / 2.0
            } else if sa.out().1 > 0.0 {
                s.1.max(t.1) + STUB
            } else {
                s.1.min(t.1) - STUB
            };
            vec![s, (s.0, mid), (t.0, mid), t]
        }
        (true, false) => vec![s, (t.0, s.1), t],
        (false, true) => vec![s, (s.0, t.1), t],
    };
    Path {
        points: tidy(points),
        sides: Some((sa, sb)),
    }
}

/// The point at `fraction` of the way along a polyline, by length.
pub(crate) fn along(points: &[(f64, f64)], fraction: f64) -> (f64, f64) {
    let lens: Vec<f64> = points
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .collect();
    let total: f64 = lens.iter().sum();
    let mut left = total * fraction.clamp(0.0, 1.0);
    for (w, len) in points.windows(2).zip(&lens) {
        if left <= *len || *len == 0.0 {
            let t = if *len == 0.0 { 0.0 } else { left / len };
            return (
                w[0].0 + (w[1].0 - w[0].0) * t,
                w[0].1 + (w[1].1 - w[0].1) * t,
            );
        }
        left -= len;
    }
    *points.last().unwrap_or(&(0.0, 0.0))
}

/// Where Excalidraw puts the bound text of an arrow: the middle of the middle segment, or the
/// middle point of an odd path.
pub(crate) fn label_anchor(points: &[(f64, f64)]) -> (f64, f64) {
    let n = points.len();
    if n % 2 == 1 {
        points[n / 2]
    } else {
        let (a, b) = (points[n / 2 - 1], points[n / 2]);
        ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0)
    }
}

/// One end of an arrow: a box it is bound to, or a free point.
#[derive(Clone, Copy)]
pub(crate) enum End {
    Box(Rect),
    Point((f64, f64)),
}

/// Where an arrow between two ends starts and stops: on each box's outline towards the other
/// end, with a small gap.
pub(crate) fn route(a: End, b: End) -> ((f64, f64), (f64, f64)) {
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

/// Where the line from the centre of `r` towards `to` leaves `r`.
fn boundary(r: Rect, to: (f64, f64)) -> (f64, f64) {
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

/// Write `path` into an arrow element: position, relative points, size and, for an elbow, what
/// Excalidraw wants to route it.
pub(crate) fn set_path(arrow: &mut Value, path: &Path, elbow: bool) {
    let first = path.points[0];
    let rel: Vec<Value> = path
        .points
        .iter()
        .map(|p| json!([p.0 - first.0, p.1 - first.1]))
        .collect();
    let xs = path.points.iter().map(|p| p.0);
    let ys = path.points.iter().map(|p| p.1);
    let span = |it: &mut dyn Iterator<Item = f64>| {
        let v: Vec<f64> = it.collect();
        v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
    };
    arrow["x"] = json!(first.0);
    arrow["y"] = json!(first.1);
    arrow["width"] = json!(span(&mut xs.clone()));
    arrow["height"] = json!(span(&mut ys.clone()));
    arrow["points"] = Value::Array(rel);
    arrow["elbowed"] = json!(elbow);
    arrow["roundness"] = if elbow {
        Value::Null
    } else {
        json!({"type": 2})
    };
    if elbow {
        arrow["fixedSegments"] = Value::Null;
        arrow["startIsSpecial"] = json!(false);
        arrow["endIsSpecial"] = json!(false);
        if let Some((a, b)) = path.sides {
            for (key, side) in [("startBinding", a), ("endBinding", b)] {
                if arrow[key].is_object() {
                    let f = side.fraction();
                    arrow[key]["fixedPoint"] = json!([f.0, f.1]);
                }
            }
        }
    }
}

/// The absolute points of an arrow element.
pub(crate) fn path_of(arrow: &Value) -> Vec<(f64, f64)> {
    let (x, y) = (
        arrow["x"].as_f64().unwrap_or(0.0),
        arrow["y"].as_f64().unwrap_or(0.0),
    );
    arrow["points"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            (
                x + p[0].as_f64().unwrap_or(0.0),
                y + p[1].as_f64().unwrap_or(0.0),
            )
        })
        .collect()
}

// ---------- the nodes already in a drawing ----------

fn is_box(el: &Value) -> bool {
    !super::excalidraw_md::is_deleted(el)
        && matches!(
            el["type"].as_str(),
            Some("rectangle" | "ellipse" | "diamond")
        )
}

/// A text element that is a node of its own: not a box's or an arrow's label, not a legend line,
/// not the label of an arrow placed away from its middle.
fn is_free_text(el: &Value) -> bool {
    !super::excalidraw_md::is_deleted(el)
        && el["type"] == "text"
        && el["containerId"].is_null()
        && el["customData"]["writerLegend"].is_null()
        && el["customData"]["writerLabelOf"].is_null()
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

/// The text of a text element as written (before wrapping).
fn text_of(el: &Value) -> String {
    el["originalText"]
        .as_str()
        .or_else(|| el["text"].as_str())
        .unwrap_or("")
        .to_string()
}

/// The ids of the texts that label arrow `list[arrow]`: its bound text, or a free text that says
/// it is its label (placed away from the middle with `labelAt`).
fn arrow_labels(list: &[Value], arrow: usize) -> Vec<String> {
    let id = list[arrow]["id"].as_str().unwrap_or("");
    list.iter()
        .filter(|t| {
            t["type"] == "text"
                && (t["containerId"] == id || t["customData"]["writerLabelOf"] == id)
        })
        .filter_map(|t| t["id"].as_str().map(str::to_string))
        .collect()
}

// ---------- adding ----------

#[derive(Debug, PartialEq, Eq)]
pub struct Added {
    pub nodes: usize,
    pub edges: usize,
    pub zones: usize,
}

struct NewNode {
    key: String,
    el_id: String,
    shape: Shape,
    lines: Vec<String>,
    original: String,
    font: f64,
    stroke: String,
    background: String,
    stroke_style: Option<&'static str>,
    link: Option<String>,
    size: (f64, f64),
    at: Option<(f64, f64)>,
}

/// The validated nodes of a spec: the checks of `add` and `create` for each, every problem kept.
fn plan_nodes(
    spec: &Spec,
    existing: &BTreeMap<String, usize>,
    g: &mut Gen,
    problems: &mut Vec<String>,
) -> Vec<NewNode> {
    let mut nodes = Vec::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for n in &spec.nodes {
        let one = (|| -> Result<NewNode, String> {
            if n.id.trim().is_empty() {
                return Err("every node needs an id".into());
            }
            if !seen.insert(&n.id) {
                return Err(format!("node id {} is used twice", n.id));
            }
            if existing.contains_key(&n.id) {
                return Err(format!("node id {} already exists in the drawing", n.id));
            }
            let at = |m: String| format!("node {}: {m}", n.id);
            let shape = Shape::parse(n.shape.as_deref()).map_err(at)?;
            let place = match (n.x, n.y) {
                (Some(x), Some(y)) => Some((x, y)),
                (None, None) => None,
                _ => return Err(at("give both x and y, or neither".into())),
            };
            let (stroke, background) =
                tints(n.color.as_deref(), n.fill.as_deref(), n.stroke.as_deref()).map_err(at)?;
            let style = stroke_style(n.stroke_style.as_deref()).map_err(at)?;
            if let Some(l) = &n.link {
                check_link(l).map_err(at)?;
            }
            let font = n.font_size.unwrap_or(FONT_SIZE);
            if !(6.0..=200.0).contains(&font) {
                return Err(at(format!("fontSize is from 6 to 200, got {font}")));
            }
            let text = n.text.clone().unwrap_or_default();
            let lines = lay_text(shape, &text, font, n.w);
            let size = fit_size(&n.id, shape, &lines, font, n.w, n.h, (0.0, 0.0))?;
            Ok(NewNode {
                key: n.id.clone(),
                el_id: g.id(),
                shape,
                size,
                lines,
                original: text,
                font,
                stroke,
                background,
                stroke_style: style,
                link: n.link.clone(),
                at: place,
            })
        })();
        match one {
            Ok(node) => nodes.push(node),
            Err(e) => problems.push(e),
        }
    }
    nodes
}

/// The text element that labels `arrow` (drawn along `points`): bound to it, so Excalidraw keeps
/// it on the middle, or, when `label_at` puts it elsewhere, a free text that says whose label it
/// is (`customData.writerLabelOf`) and where (`labelAt`).
pub(crate) fn make_label(
    arrow: &mut Value,
    points: &[(f64, f64)],
    label: &str,
    label_at: Option<f64>,
    ink: &str,
    g: &mut Gen,
) -> Value {
    let arrow_id = arrow["id"].as_str().unwrap_or("").to_string();
    let text_id = g.id();
    let lines = wrap(label, FONT_SIZE, None);
    match label_at.filter(|l| (l - 0.5).abs() > 1e-9) {
        None => {
            push_bound(arrow, &text_id, "text");
            text_element(
                &text_id,
                &lines,
                label,
                label_anchor(points),
                Some(&arrow_id),
                (ink, FONT_SIZE),
                g,
            )
        }
        Some(at) => {
            let mut t = text_element(
                &text_id,
                &lines,
                label,
                along(points, at),
                None,
                (ink, FONT_SIZE),
                g,
            );
            t["textAlign"] = json!("center");
            t["verticalAlign"] = json!("middle");
            t["customData"] = json!({"writerLabelOf": arrow_id, "labelAt": at});
            t
        }
    }
}

fn push_elements(scene: &mut Value, els: Vec<Value>) {
    let list = scene["elements"]
        .as_array_mut()
        .expect("a scene has elements");
    list.extend(els);
}

/// Add the nodes, edges, groups, zones and legend of `spec` to `scene` (which may be empty).
/// Everything is checked first and every problem is returned together: a bad spec leaves the
/// scene as it was.
pub fn add_to_scene(scene: &mut Value, spec: &Spec, g: &mut Gen) -> Result<Added, Vec<String>> {
    let mut problems: Vec<String> = Vec::new();
    if spec.remove.is_some() {
        problems.push("remove is only for update".into());
    }
    let direction = direction_of(spec).unwrap_or_else(|e| {
        problems.push(e);
        Direction::LeftRight
    });
    let existing = nodes_by_key(scene);
    let nodes = plan_nodes(spec, &existing, g, &mut problems);

    let new_keys: BTreeSet<&str> = nodes.iter().map(|n| n.key.as_str()).collect();
    // a node that failed its own checks is still a node: its arrows are not "unknown" noise
    let named: BTreeSet<&str> = spec.nodes.iter().map(|n| n.id.as_str()).collect();
    let known = |k: &str| named.contains(k) || existing.contains_key(k);
    let mut edges: Vec<EdgePlan> = Vec::new();
    for e in &spec.edges {
        match EdgePlan::from_spec(e) {
            Ok(plan) => {
                let mut ok = true;
                for end in [&e.from, &e.to] {
                    if !known(end) {
                        problems.push(format!("edge {} -> {}: no node {end}", e.from, e.to));
                        ok = false;
                    }
                }
                if e.from == e.to {
                    problems.push(format!(
                        "edge {} -> {}: a node cannot point at itself",
                        e.from, e.to
                    ));
                    ok = false;
                }
                if ok {
                    edges.push(plan);
                }
            }
            Err(m) => problems.push(m),
        }
    }
    for grp in &spec.groups {
        for k in &grp.nodes {
            if !new_keys.contains(k.as_str()) {
                problems.push(format!(
                    "group member {k} is not one of the nodes being added"
                ));
            }
        }
    }
    let zone_plans = zones::plan(scene, spec, &existing, &named, g, &mut problems);
    for (i, line) in spec.legend.iter().enumerate() {
        if line.trim().is_empty() {
            problems.push(format!("legend[{i}] is empty"));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
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
    let mut rects: HashMap<String, Rect> = HashMap::new();
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
                (&n.stroke, n.font),
                g,
            );
            t["groupIds"] = groups;
            t["customData"] = custom;
            t["link"] = json!(n.link);
            if let Some(s) = n.stroke_style {
                t["strokeStyle"] = json!(s);
            }
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
        m.insert("link".into(), json!(n.link));
        if let Some(s) = n.stroke_style {
            m.insert("strokeStyle".into(), json!(s));
        }
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
                (&n.stroke, n.font),
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
        let path = arrow_path(rects[&e.from], rects[&e.to], e);
        let arrow_id = g.id();
        let mut m = base("arrow", &arrow_id, (0.0, 0.0, 0.0, 0.0), g);
        m.insert("lastCommittedPoint".into(), Value::Null);
        m.insert(
            "startBinding".into(),
            json!({"elementId": el_id_of(&e.from, &built), "focus": 0, "gap": ARROW_GAP}),
        );
        m.insert(
            "endBinding".into(),
            json!({"elementId": el_id_of(&e.to, &built), "focus": 0, "gap": ARROW_GAP}),
        );
        m.insert(
            "startArrowhead".into(),
            if e.bidirectional {
                json!("arrow")
            } else {
                Value::Null
            },
        );
        m.insert("endArrowhead".into(), json!("arrow"));
        m.insert("strokeColor".into(), json!(e.ink));
        if let Some(s) = e.style {
            m.insert("strokeStyle".into(), json!(s));
        }
        if let Some(sides) = e.explicit_sides() {
            m.insert("customData".into(), json!({"writerSides": sides}));
        }
        let mut arrow = Value::Object(m);
        set_path(&mut arrow, &path, e.elbow);
        let label_el = e
            .label
            .as_deref()
            .map(|label| make_label(&mut arrow, &path.points, label, e.label_at, &e.ink, g));
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
    zones::commit(scene, &zone_plans, &rects, g);
    zones::add_legend(scene, &spec.legend, g);
    Ok(Added {
        nodes: new_count,
        edges: edge_count,
        zones: zone_plans.len(),
    })
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
        if let Some(f) = el["frameId"].as_str() {
            let frame = by_id
                .get(f)
                .ok_or(format!("{id}: frame {f} does not exist"))?;
            if !matches!(frame["type"].as_str(), Some("frame" | "magicframe")) {
                return Err(format!("{id}: frameId {f} is not a frame"));
            }
        }
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
