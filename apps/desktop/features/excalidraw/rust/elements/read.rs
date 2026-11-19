//! A scene back to a spec: what `excalidraw:read` prints, in exactly the grammar `create` and
//! `add` take (boxes with position, size, colours, style and link; arrows with label, style,
//! sides and route; zones; groups; the legend). Reading a drawing and creating a new one from the
//! output gives the same spec again. What the grammar cannot say (hand-drawn lines, images,
//! arrows with a free end) is only counted under `other`, which `create` ignores.

use super::super::excalidraw_md;
use super::zones;
use super::*;

/// A palette name for a strong tone, else the hex itself.
fn stroke_name(stroke: &str) -> String {
    ["blue", "green", "red", "yellow", "orange", "purple", "gray"]
        .into_iter()
        .find(|n| palette(n).is_some_and(|(s, _)| s == stroke))
        .map_or_else(|| stroke.to_string(), str::to_string)
}

fn fill_name(fill: &str) -> String {
    ["blue", "green", "red", "yellow", "orange", "purple", "gray"]
        .into_iter()
        .find(|n| palette(n).is_some_and(|(_, b)| b == fill))
        .map_or_else(|| fill.to_string(), str::to_string)
}

fn node_json(el: &Value, els: &[Value]) -> Value {
    let is_text = el["type"] == "text";
    let label = if is_text {
        None
    } else {
        el["id"].as_str().and_then(|id| {
            els.iter().find(|t| {
                t["type"] == "text" && t["containerId"] == id && !excalidraw_md::is_deleted(t)
            })
        })
    };
    let text = if is_text {
        text_of(el)
    } else {
        label.map(text_of).unwrap_or_default()
    };
    let r = rect_of(el);
    let mut n = json!({
        "id": node_key(el),
        "text": text,
        "shape": el["type"],
        "x": r.0.round(), "y": r.1.round(), "w": r.2.round(), "h": r.3.round(),
    });
    let stroke = el["strokeColor"].as_str().unwrap_or(INK);
    let fill = el["backgroundColor"].as_str().unwrap_or("transparent");
    if let Some(name) = color_name(stroke, fill) {
        n["color"] = json!(name);
    } else if !is_text && fill == "transparent" && stroke != INK {
        n["color"] = json!(stroke);
    } else {
        if stroke != INK {
            n["stroke"] = json!(stroke_name(stroke));
        }
        if !is_text && fill != "transparent" {
            n["fill"] = json!(fill_name(fill));
        }
    }
    let font = if is_text {
        el["fontSize"].as_f64()
    } else {
        label.and_then(|l| l["fontSize"].as_f64())
    };
    if let Some(f) = font.filter(|f| (f - FONT_SIZE).abs() > 1e-9) {
        n["fontSize"] = json!(f);
    }
    if let Some(s) = el["strokeStyle"].as_str().filter(|s| *s != "solid") {
        n["strokeStyle"] = json!(s);
    }
    if let Some(l) = el["link"].as_str().filter(|l| !l.is_empty()) {
        n["link"] = json!(l);
    }
    n
}

fn edge_json(arrow: &Value, from: &str, to: &str, label: Option<&Value>) -> Value {
    let mut o = Map::new();
    o.insert("from".into(), json!(from));
    o.insert("to".into(), json!(to));
    if let Some(l) = label {
        o.insert("label".into(), json!(text_of(l)));
    }
    if let Some(s) = arrow["strokeStyle"].as_str().filter(|s| *s != "solid") {
        o.insert("style".into(), json!(s));
    }
    if let Some(c) = arrow["strokeColor"].as_str().filter(|c| *c != INK) {
        o.insert("color".into(), json!(stroke_name(c)));
    }
    if !arrow["startArrowhead"].is_null() {
        o.insert("bidirectional".into(), json!(true));
    }
    if let Some(at) = label.and_then(|l| l["customData"]["labelAt"].as_f64()) {
        o.insert("labelAt".into(), json!(at));
    }
    if let Some([a, b]) = arrow["customData"]["writerSides"].as_array().map(|s| {
        [
            s.first().and_then(Value::as_str).unwrap_or(""),
            s.get(1).and_then(Value::as_str).unwrap_or(""),
        ]
    }) {
        if !a.is_empty() {
            o.insert("fromSide".into(), json!(a));
        }
        if !b.is_empty() {
            o.insert("toSide".into(), json!(b));
        }
    }
    if arrow["elbowed"] == true {
        o.insert("route".into(), json!("elbow"));
    }
    if o.len() == 2 {
        json!([from, to])
    } else if o.len() == 3 && label.is_some() {
        json!([from, to, text_of(label.expect("checked"))])
    } else {
        Value::Object(o)
    }
}

/// The compact spec of a scene. What `excalidraw:read` prints.
pub fn read_spec(scene: &Value) -> Value {
    let els = excalidraw_md::elements(scene);
    let live = |e: &&Value| !excalidraw_md::is_deleted(e);
    let keys: HashMap<&str, String> = els
        .iter()
        .filter(|e| is_box(e) || is_free_text(e))
        .filter_map(|e| Some((e["id"].as_str()?, node_key(e))))
        .collect();
    let mut nodes = Vec::new();
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for el in els.iter().filter(|e| is_box(e) || is_free_text(e)) {
        nodes.push(node_json(el, els));
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
    }
    let mut edges = Vec::new();
    let mut other: BTreeMap<String, usize> = BTreeMap::new();
    let mut zones_out = Vec::new();
    for (i, el) in els.iter().enumerate().filter(|(_, e)| live(e)) {
        match el["type"].as_str().unwrap_or("") {
            "arrow" => {
                let end = |k: &str| el[k]["elementId"].as_str().and_then(|id| keys.get(id));
                match (end("startBinding"), end("endBinding")) {
                    (Some(a), Some(b)) => {
                        let label = arrow_labels(els, i)
                            .first()
                            .and_then(|id| els.iter().find(|t| t["id"] == id.as_str()));
                        edges.push(edge_json(el, a, b, label));
                    }
                    _ => *other.entry("arrow".into()).or_default() += 1,
                }
            }
            "rectangle" | "ellipse" | "diamond" | "text" => {}
            "frame" => {
                let id = el["id"].as_str().unwrap_or("");
                let members: Vec<String> = els
                    .iter()
                    .filter(|m| (is_box(m) || is_free_text(m)) && zones::frame_of(m) == Some(id))
                    .map(node_key)
                    .collect();
                if members.is_empty() {
                    *other.entry("frame".into()).or_default() += 1;
                    continue;
                }
                let mut z = json!({
                    "id": zones::zone_key(el),
                    "label": el["name"].as_str().unwrap_or(""),
                    "nodes": members,
                });
                if let Some(c) = el["strokeColor"]
                    .as_str()
                    .filter(|c| *c != zones::FRAME_STROKE)
                {
                    z["color"] = json!(stroke_name(c));
                }
                if let Some(p) =
                    zones::padding_of(el).filter(|p| (p - zones::DEFAULT_PADDING).abs() > 1e-9)
                {
                    z["padding"] = json!(p);
                }
                zones_out.push(z);
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
    if !zones_out.is_empty() {
        out["zones"] = json!(zones_out);
    }
    if !groups.is_empty() {
        out["groups"] = json!(groups);
    }
    let legend = zones::legend_of(scene);
    if !legend.is_empty() {
        out["legend"] = json!(legend);
    }
    if !other.is_empty() {
        out["other"] = json!(other);
    }
    out
}

/// Every link target a drawing's elements carry (`[[Note]]` as the note's name), in order, each
/// once. What `excalidraw:read format=json` lists and the index reads as links of the drawing.
pub fn link_texts(scene: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for el in excalidraw_md::elements(scene)
        .iter()
        .filter(|e| !excalidraw_md::is_deleted(e))
    {
        if let Some(l) = el["link"].as_str().map(str::trim).filter(|l| !l.is_empty()) {
            out.push(l.to_string());
        }
    }
    out
}

/// The note names the element links point at (`[[Note#Heading|alias]]` is `Note`), each once.
pub fn link_targets(scene: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in link_texts(scene) {
        let Some(inner) = l.strip_prefix("[[").and_then(|l| l.strip_suffix("]]")) else {
            continue;
        };
        let target = inner
            .split(['|', '#'])
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !target.is_empty() && !out.contains(&target) {
            out.push(target);
        }
    }
    out
}
