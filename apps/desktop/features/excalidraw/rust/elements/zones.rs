//! Zones and the legend. A zone is an Excalidraw frame sized around its boxes (their labels, the
//! arrows between them) with the zone's label as the frame's name, shown top-left; the members
//! point at it with `frameId`. Frames do not nest in Excalidraw, so a box belongs to one zone at
//! most and a zone cannot hold a zone. The frame's `customData` keeps the id the agent gave
//! (`writerId`) and the padding, so `update` and `read` address and refit it later. A frame the
//! user drew by hand has neither and is never refitted. The legend is text lines under the whole
//! drawing, each tagged `customData.writerLegend` with its place in the list.

use super::super::excalidraw_md;
use super::*;

pub(super) const DEFAULT_PADDING: f64 = 40.0;
pub(super) const FRAME_STROKE: &str = "#bbbbbb";
const LEGEND_GAP: f64 = 60.0;

pub(super) struct Zone {
    pub key: String,
    pub el_id: String,
    pub label: String,
    pub members: Vec<String>,
    pub stroke: String,
    pub padding: f64,
}

/// The key an agent addresses a frame by.
pub(super) fn zone_key(el: &Value) -> String {
    node_key(el)
}

pub(super) fn is_frame(el: &Value) -> bool {
    !excalidraw_md::is_deleted(el) && el["type"] == "frame"
}

/// Frames of the scene by key.
pub(super) fn zones_by_key(scene: &Value) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for (i, el) in excalidraw_md::elements(scene).iter().enumerate() {
        if is_frame(el) {
            out.entry(zone_key(el)).or_insert(i);
            if let Some(id) = el["id"].as_str() {
                out.entry(id.to_string()).or_insert(i);
            }
        }
    }
    out
}

/// The zone of a node (element id of its frame), if any.
pub(super) fn frame_of(el: &Value) -> Option<&str> {
    el["frameId"].as_str()
}

pub(super) fn stroke_of(color: Option<&str>) -> Result<String, String> {
    match color {
        None => Ok(FRAME_STROKE.into()),
        Some(c) => colors(Some(c)).map(|t| t.0),
    }
}

/// The checks of the zones of an `add`/`create` spec, every problem kept.
pub(super) fn plan(
    scene: &Value,
    spec: &Spec,
    existing: &BTreeMap<String, usize>,
    new_keys: &BTreeSet<&str>,
    g: &mut Gen,
    problems: &mut Vec<String>,
) -> Vec<Zone> {
    let frames = zones_by_key(scene);
    let els = excalidraw_md::elements(scene);
    let zone_ids: BTreeSet<&str> = spec.zones.iter().map(|z| z.id.as_str()).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut owner: HashMap<&str, &str> = HashMap::new();
    let mut out = Vec::new();
    for z in &spec.zones {
        let at = |m: String| format!("zone {}: {m}", z.id);
        let mut ok = true;
        let mut bad = |m: String| {
            problems.push(at(m));
            ok = false;
        };
        if z.id.trim().is_empty() {
            bad("every zone needs an id".into());
        } else if !seen.insert(&z.id) {
            bad("zone id is used twice".into());
        } else if frames.contains_key(&z.id) {
            bad("already exists in the drawing (change it with update)".into());
        }
        let stroke = stroke_of(z.color.as_deref()).unwrap_or_else(|m| {
            bad(m);
            FRAME_STROKE.into()
        });
        if z.padding.is_some_and(|p| p < 0.0) {
            bad("padding is not negative".into());
        }
        let members = match z.nodes.as_deref() {
            Some(m) if !m.is_empty() => m,
            _ => {
                bad("needs nodes".into());
                &[]
            }
        };
        for k in members {
            if zone_ids.contains(k.as_str()) {
                bad(format!("{k} is a zone: zones do not nest"));
            } else if !new_keys.contains(k.as_str()) && !existing.contains_key(k) {
                bad(format!("no node {k}"));
            } else if let Some(prev) = owner.insert(k.as_str(), z.id.as_str()) {
                bad(format!(
                    "{k} is already in zone {prev}: a box is in one zone"
                ));
            } else if let Some(&i) = existing.get(k) {
                if let Some(f) = frame_of(&els[i]) {
                    bad(format!("{k} is already in a zone ({f})"));
                }
            }
        }
        if ok {
            out.push(Zone {
                key: z.id.clone(),
                el_id: g.id(),
                label: z.label.clone().unwrap_or_else(|| z.id.clone()),
                members: members.to_vec(),
                stroke,
                padding: z.padding.unwrap_or(DEFAULT_PADDING),
            });
        }
    }
    out
}

fn set_frame(el: &mut Value, frame: Option<&str>, g: &mut Gen) {
    let want = frame.map_or(Value::Null, |f| json!(f));
    if el["frameId"] != want {
        el["frameId"] = want;
        bump(el, g);
    }
}

/// Make `member_keys` the children of frame `frame` (an element id): the boxes, their labels and
/// the arrows (with their labels) between two children. Children no longer listed leave it.
pub(super) fn assign(scene: &mut Value, frame: &str, member_keys: &[String], g: &mut Gen) {
    let by_key = nodes_by_key(scene);
    let list = scene["elements"]
        .as_array_mut()
        .expect("a scene has elements");
    let member_ids: BTreeSet<String> = member_keys
        .iter()
        .filter_map(|k| by_key.get(k))
        .filter_map(|&i| list[i]["id"].as_str().map(str::to_string))
        .collect();
    let labels_in_member: BTreeSet<String> = list
        .iter()
        .filter(|t| {
            t["type"] == "text"
                && t["containerId"]
                    .as_str()
                    .is_some_and(|c| member_ids.contains(c))
        })
        .filter_map(|t| t["id"].as_str().map(str::to_string))
        .collect();
    let inside = |id: &str| member_ids.contains(id);
    let arrow_inside = |a: &Value| {
        a["type"] == "arrow"
            && a["startBinding"]["elementId"].as_str().is_some_and(inside)
            && a["endBinding"]["elementId"].as_str().is_some_and(inside)
    };
    let arrow_ids: BTreeSet<String> = list
        .iter()
        .filter(|a| !excalidraw_md::is_deleted(a) && arrow_inside(a))
        .filter_map(|a| a["id"].as_str().map(str::to_string))
        .collect();
    for el in list.iter_mut() {
        let id = el["id"].as_str().unwrap_or("").to_string();
        let label_of_arrow = el["type"] == "text"
            && (el["containerId"]
                .as_str()
                .is_some_and(|c| arrow_ids.contains(c))
                || el["customData"]["writerLabelOf"]
                    .as_str()
                    .is_some_and(|c| arrow_ids.contains(c)));
        let child = member_ids.contains(&id)
            || labels_in_member.contains(&id)
            || arrow_ids.contains(&id)
            || label_of_arrow;
        if child {
            set_frame(el, Some(frame), g);
        } else if frame_of(el) == Some(frame) {
            set_frame(el, None, g);
        }
    }
}

/// The frame around everything inside it, `padding` away. `None` when it holds nothing.
fn frame_rect(list: &[Value], frame: &str, padding: f64) -> Option<Rect> {
    let rects: Vec<Rect> = list
        .iter()
        .filter(|e| !excalidraw_md::is_deleted(e) && frame_of(e) == Some(frame))
        .map(rect_of)
        .collect();
    if rects.is_empty() {
        return None;
    }
    let x0 = rects.iter().map(|r| r.0).fold(f64::MAX, f64::min);
    let y0 = rects.iter().map(|r| r.1).fold(f64::MAX, f64::min);
    let x1 = rects.iter().map(|r| r.0 + r.2).fold(f64::MIN, f64::max);
    let y1 = rects.iter().map(|r| r.1 + r.3).fold(f64::MIN, f64::max);
    Some((
        x0 - padding,
        y0 - padding,
        x1 - x0 + 2.0 * padding,
        y1 - y0 + 2.0 * padding,
    ))
}

/// The padding of a frame of ours.
pub(super) fn padding_of(frame: &Value) -> Option<f64> {
    frame["customData"]["padding"].as_f64()
}

/// Size frame `frame` (an element id) around its children, if it is one of ours.
pub(super) fn refit(scene: &mut Value, frame: &str, g: &mut Gen) {
    let list = scene["elements"]
        .as_array_mut()
        .expect("a scene has elements");
    let Some(i) = list.iter().position(|e| e["id"] == frame && is_frame(e)) else {
        return;
    };
    let Some(padding) = padding_of(&list[i]) else {
        return;
    };
    if let Some(r) = frame_rect(list, frame, padding) {
        if rect_of(&list[i]) != r {
            list[i]["x"] = json!(r.0);
            list[i]["y"] = json!(r.1);
            list[i]["width"] = json!(r.2);
            list[i]["height"] = json!(r.3);
            bump(&mut list[i], g);
        }
    }
}

/// Refit the frames (ours) that hold any of the `moved` element ids, after boxes moved or grew.
pub(super) fn refit_around(scene: &mut Value, moved: &BTreeSet<String>, g: &mut Gen) {
    let frames: BTreeSet<String> = excalidraw_md::elements(scene)
        .iter()
        .filter(|e| e["id"].as_str().is_some_and(|id| moved.contains(id)))
        .filter_map(|e| frame_of(e).map(str::to_string))
        .collect();
    for f in frames {
        refit(scene, &f, g);
    }
}

/// Create the frames of new zones around their members (already in the scene).
pub(super) fn commit(
    scene: &mut Value,
    zones: &[Zone],
    _rects: &HashMap<String, Rect>,
    g: &mut Gen,
) {
    for z in zones {
        assign(scene, &z.el_id, &z.members, g);
        let list = excalidraw_md::elements(scene);
        let rect = frame_rect(list, &z.el_id, z.padding).unwrap_or((0.0, 0.0, 0.0, 0.0));
        let mut m = base("frame", &z.el_id, rect, g);
        m.insert("strokeColor".into(), json!(z.stroke));
        m.insert("name".into(), json!(z.label));
        m.insert(
            "customData".into(),
            json!({"writerId": z.key, "padding": z.padding}),
        );
        push_elements(scene, vec![Value::Object(m)]);
    }
}

/// Change a zone that exists (`update`): its label, colour, padding and, when `nodes` is given,
/// its members. A zone that does not exist yet is created as `add` would.
pub(super) fn patch(
    scene: &mut Value,
    z: &spec::ZoneSpec,
    g: &mut Gen,
) -> Result<Option<String>, String> {
    let at = |m: String| format!("zone {}: {m}", z.id);
    let stroke = z
        .color
        .as_deref()
        .map(|c| stroke_of(Some(c)))
        .transpose()
        .map_err(at)?;
    if z.padding.is_some_and(|p| p < 0.0) {
        return Err(at("padding is not negative".into()));
    }
    let frames = zones_by_key(scene);
    let Some(&i) = frames.get(&z.id) else {
        return create_in(scene, z, stroke, g).map(Some);
    };
    let by_key = nodes_by_key(scene);
    if let Some(members) = &z.nodes {
        for k in members {
            if frames.contains_key(k) {
                return Err(at(format!("{k} is a zone: zones do not nest")));
            }
            let Some(&n) = by_key.get(k) else {
                return Err(at(format!("no node {k}")));
            };
            let el = &excalidraw_md::elements(scene)[n];
            let own = excalidraw_md::elements(scene)[i]["id"].as_str();
            if frame_of(el).is_some() && frame_of(el) != own {
                return Err(at(format!("{k} is in another zone: a box is in one zone")));
            }
        }
    }
    let list = scene["elements"]
        .as_array_mut()
        .expect("a scene has elements");
    let frame_id = list[i]["id"].as_str().unwrap_or("").to_string();
    let mut touched = false;
    if let Some(l) = &z.label {
        list[i]["name"] = json!(l);
        touched = true;
    }
    if let Some(s) = stroke {
        list[i]["strokeColor"] = json!(s);
        touched = true;
    }
    if let Some(p) = z.padding {
        let mut custom = list[i]["customData"].clone();
        if !custom.is_object() {
            custom = json!({});
        }
        custom["padding"] = json!(p);
        list[i]["customData"] = custom;
        touched = true;
    }
    if touched {
        bump(&mut list[i], g);
    }
    if let Some(members) = &z.nodes {
        assign(scene, &frame_id, members, g);
    }
    refit(scene, &frame_id, g);
    Ok(Some(frame_id))
}

fn create_in(
    scene: &mut Value,
    z: &spec::ZoneSpec,
    stroke: Option<String>,
    g: &mut Gen,
) -> Result<String, String> {
    let at = |m: String| format!("zone {}: {m}", z.id);
    let members = match z.nodes.as_deref() {
        Some(m) if !m.is_empty() => m,
        _ => return Err(at("a new zone needs nodes".into())),
    };
    let by_key = nodes_by_key(scene);
    for k in members {
        let Some(&n) = by_key.get(k) else {
            return Err(at(format!("no node {k}")));
        };
        if frame_of(&excalidraw_md::elements(scene)[n]).is_some() {
            return Err(at(format!(
                "{k} is already in a zone: a box is in one zone"
            )));
        }
    }
    let zone = Zone {
        key: z.id.clone(),
        el_id: g.id(),
        label: z.label.clone().unwrap_or_else(|| z.id.clone()),
        members: members.to_vec(),
        stroke: stroke.unwrap_or_else(|| FRAME_STROKE.into()),
        padding: z.padding.unwrap_or(DEFAULT_PADDING),
    };
    let id = zone.el_id.clone();
    commit(scene, &[zone], &HashMap::new(), g);
    Ok(id)
}

/// Delete the frame of zone `key`; its boxes stay, outside any zone.
pub(super) fn remove(scene: &mut Value, key: &str, g: &mut Gen) -> Result<(), String> {
    let frames = zones_by_key(scene);
    let &i = frames.get(key).ok_or_else(|| format!("no zone {key}"))?;
    let list = scene["elements"]
        .as_array_mut()
        .expect("a scene has elements");
    let id = list[i]["id"].as_str().unwrap_or("").to_string();
    for el in list.iter_mut() {
        if frame_of(el) == Some(id.as_str()) {
            set_frame(el, None, g);
        }
    }
    list.remove(i);
    Ok(())
}

// ---------- the legend ----------

/// Append `lines` as text blocks under everything already drawn, left-aligned with it.
pub(super) fn add_legend(scene: &mut Value, lines: &[String], g: &mut Gen) {
    if lines.is_empty() {
        return;
    }
    let els = excalidraw_md::elements(scene);
    let live: Vec<&Value> = els
        .iter()
        .filter(|e| !excalidraw_md::is_deleted(e))
        .collect();
    let existing: Vec<&Value> = live
        .iter()
        .copied()
        .filter(|e| e["customData"]["writerLegend"].is_number())
        .collect();
    let first = existing.len();
    let x = existing
        .iter()
        .map(|e| e["x"].as_f64().unwrap_or(0.0))
        .fold(f64::MAX, f64::min);
    let x = if existing.is_empty() {
        live.iter()
            .map(|e| e["x"].as_f64().unwrap_or(0.0))
            .fold(f64::MAX, f64::min)
    } else {
        x
    };
    let x = if x == f64::MAX { 0.0 } else { x };
    let bottom = live
        .iter()
        .map(|e| e["y"].as_f64().unwrap_or(0.0) + e["height"].as_f64().unwrap_or(0.0))
        .fold(f64::MIN, f64::max);
    let mut y = if bottom == f64::MIN {
        0.0
    } else if existing.is_empty() {
        bottom + LEGEND_GAP
    } else {
        bottom + 10.0
    };
    let mut built = Vec::new();
    for (n, line) in lines.iter().enumerate() {
        let wrapped = wrap(line, LEGEND_FONT, Some(LEGEND_WIDTH));
        let (w, h) = text_size(&wrapped, LEGEND_FONT);
        let id = g.id();
        let mut t = text_element(
            &id,
            &wrapped,
            line,
            (x + w / 2.0, y + h / 2.0),
            None,
            (INK, LEGEND_FONT),
            g,
        );
        t["customData"] = json!({"writerLegend": first + n});
        built.push(t);
        y += h + 10.0;
    }
    push_elements(scene, built);
}

/// The legend lines of a scene, in order.
pub(super) fn legend_of(scene: &Value) -> Vec<String> {
    let mut lines: Vec<(u64, String)> = excalidraw_md::elements(scene)
        .iter()
        .filter(|e| !excalidraw_md::is_deleted(e))
        .filter_map(|e| Some((e["customData"]["writerLegend"].as_u64()?, text_of(e))))
        .collect();
    lines.sort_by_key(|(n, _)| *n);
    lines.into_iter().map(|(_, t)| t).collect()
}
