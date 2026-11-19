//! `excalidraw:update`: change what a drawing already holds, in the grammar of `add` (spec
//! `SPECs/excalidraw-spec.md` "Agent commands"). `nodes[]` patch the boxes they name (a field
//! left out stays), `edges[]` re-label, recolour, restyle or re-route the arrows `from -> to`,
//! `zones[]` change a zone's label, colour, padding or members (or create one), `remove` deletes
//! boxes (their arrows and labels with them), arrows and zones (the boxes stay). Everything not
//! named is untouched, byte for byte: only an element that changes moves its `version`, so an
//! open editor sees exactly what changed, and a box that lost or gained an arrow learns about it.
//! A whole update is checked on a copy and reports every problem at once: an unknown id or colour
//! leaves the drawing as it was. Tauri-free.

use super::*;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Updated {
    pub nodes: usize,
    pub edges: usize,
    pub zones: usize,
    pub removed_nodes: usize,
    pub removed_edges: usize,
    pub removed_zones: usize,
}

fn els(scene: &mut Value) -> &mut Vec<Value> {
    scene["elements"]
        .as_array_mut()
        .expect("a scene has elements")
}

fn find(els: &[Value], id: &str) -> Option<usize> {
    els.iter().position(|e| e["id"] == id)
}

fn is_arrow(el: &Value) -> bool {
    !super::super::excalidraw_md::is_deleted(el) && el["type"] == "arrow"
}

/// The element id of the box or text the agent calls `key`.
fn resolve(scene: &Value, key: &str) -> Result<String, String> {
    nodes_by_key(scene)
        .get(key)
        .and_then(|&i| super::super::excalidraw_md::elements(scene)[i]["id"].as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("no node {key}"))
}

/// The ids of the texts bound to a box (its label).
fn labels_of(el: &Value) -> Vec<String> {
    el["boundElements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["id"].as_str().map(str::to_string))
        .collect()
}

fn bound_id<'a>(arrow: &'a Value, end: &str) -> Option<&'a str> {
    arrow[end]["elementId"].as_str()
}

/// Indexes of the arrows from `from` to `to` (element ids).
fn arrows_between(els: &[Value], from: &str, to: &str) -> Vec<usize> {
    (0..els.len())
        .filter(|&i| {
            is_arrow(&els[i])
                && bound_id(&els[i], "startBinding") == Some(from)
                && bound_id(&els[i], "endBinding") == Some(to)
        })
        .collect()
}

/// Delete the elements `ids`; whoever listed one in `boundElements` forgets it and moves.
fn drop_elements(list: &mut Vec<Value>, ids: &BTreeSet<String>, g: &mut Gen) {
    list.retain(|e| !e["id"].as_str().is_some_and(|id| ids.contains(id)));
    for el in list.iter_mut() {
        let bound = el["boundElements"].as_array();
        if bound.is_some_and(|b| {
            b.iter()
                .any(|x| x["id"].as_str().is_some_and(|i| ids.contains(i)))
        }) {
            let kept: Vec<Value> = bound
                .into_iter()
                .flatten()
                .filter(|x| !x["id"].as_str().is_some_and(|i| ids.contains(i)))
                .cloned()
                .collect();
            el["boundElements"] = if kept.is_empty() {
                Value::Null
            } else {
                json!(kept)
            };
            bump(el, g);
        }
    }
}

fn remove_arrows(scene: &mut Value, from: &str, to: &str, g: &mut Gen) -> Result<usize, String> {
    let (a, b) = (resolve(scene, from)?, resolve(scene, to)?);
    let list = els(scene);
    let found = arrows_between(list, &a, &b);
    if found.is_empty() {
        return Err(format!("no arrow {from} -> {to}"));
    }
    let mut ids = BTreeSet::new();
    for &i in &found {
        ids.extend(arrow_labels(list, i));
        ids.insert(list[i]["id"].as_str().unwrap_or("").to_string());
    }
    drop_elements(list, &ids, g);
    Ok(found.len())
}

/// Delete a box with its label and every arrow ending on it (and their labels).
fn remove_node(scene: &mut Value, key: &str, g: &mut Gen) -> Result<usize, String> {
    let id = resolve(scene, key)?;
    let list = els(scene);
    let me = find(list, &id).expect("resolved");
    let mut ids: BTreeSet<String> = labels_of(&list[me]).into_iter().collect();
    ids.insert(id.clone());
    let arrows: Vec<usize> = (0..list.len())
        .filter(|&i| {
            is_arrow(&list[i])
                && [
                    bound_id(&list[i], "startBinding"),
                    bound_id(&list[i], "endBinding"),
                ]
                .contains(&Some(id.as_str()))
        })
        .collect();
    for &i in &arrows {
        ids.extend(arrow_labels(list, i));
        ids.insert(list[i]["id"].as_str().unwrap_or("").to_string());
    }
    drop_elements(list, &ids, g);
    Ok(arrows.len())
}

/// Set `text` on a text element and centre it on `at`.
fn set_text(
    t: &mut Value,
    lines: &[String],
    original: &str,
    at: (f64, f64),
    font: f64,
    g: &mut Gen,
) {
    let (w, h) = text_size(lines, font);
    t["fontSize"] = json!(font);
    t["text"] = json!(lines.join("\n"));
    t["originalText"] = json!(original);
    t["x"] = json!(at.0 - w / 2.0);
    t["y"] = json!(at.1 - h / 2.0);
    t["width"] = json!(w);
    t["height"] = json!(h);
    bump(t, g);
}

/// Patch one box (or free text) of the drawing. Returns the element id when its rectangle
/// changed, so the arrows on it are redrawn.
fn patch_node(scene: &mut Value, n: &NodeSpec, g: &mut Gen) -> Result<Option<String>, String> {
    let id = resolve(scene, &n.id)?;
    let key = &n.id;
    let at_node = |m: String| format!("node {key}: {m}");
    let shape = n
        .shape
        .as_deref()
        .map(|s| Shape::parse(Some(s)))
        .transpose()
        .map_err(at_node)?;
    // `color` sets both halves, `stroke` and `fill` override one
    let (mut new_stroke, mut new_fill) = (None, None);
    if let Some(c) = n.color.as_deref() {
        let (s, b) = colors(Some(c)).map_err(at_node)?;
        (new_stroke, new_fill) = (Some(s), Some(b));
    }
    if let Some(c) = n.stroke.as_deref() {
        new_stroke = Some(tone(c, false).map_err(at_node)?);
    }
    if let Some(c) = n.fill.as_deref() {
        new_fill = Some(tone(c, true).map_err(at_node)?);
    }
    let style = stroke_style(n.stroke_style.as_deref()).map_err(at_node)?;
    if let Some(l) = n.link.as_deref().filter(|l| !l.is_empty()) {
        check_link(l).map_err(at_node)?;
    }
    if n.font_size.is_some_and(|f| !(6.0..=200.0).contains(&f)) {
        return Err(at_node("fontSize is from 6 to 200".into()));
    }
    let at = match (n.x, n.y) {
        (Some(x), Some(y)) => Some((x, y)),
        (None, None) => None,
        _ => return Err(format!("node {key}: give both x and y, or neither")),
    };
    let list = els(scene);
    let i = find(list, &id).expect("resolved");
    let free_text = list[i]["type"] == "text";
    if free_text && (n.w.is_some() || n.h.is_some()) {
        return Err(format!(
            "node {key}: a text sizes itself, w and h are for boxes"
        ));
    }
    if free_text && shape.is_some_and(|s| s != Shape::Text) {
        return Err(format!(
            "node {key}: a text cannot become a box; add a box instead"
        ));
    }
    if !free_text && shape == Some(Shape::Text) {
        return Err(format!(
            "node {key}: a box cannot become a text; add a text instead"
        ));
    }
    let label = if free_text {
        None
    } else {
        labels_of(&list[i]).first().and_then(|l| find(list, l))
    };
    let old_text = if free_text {
        text_of(&list[i])
    } else {
        label.map(|l| text_of(&list[l])).unwrap_or_default()
    };
    let old_font = if free_text {
        list[i]["fontSize"].as_f64()
    } else {
        label.and_then(|l| list[l]["fontSize"].as_f64())
    }
    .unwrap_or(FONT_SIZE);
    let font = n.font_size.unwrap_or(old_font);
    let text = n.text.clone().unwrap_or_else(|| old_text.clone());
    let old = rect_of(&list[i]);
    let kind = shape.unwrap_or_else(|| match list[i]["type"].as_str() {
        Some("ellipse") => Shape::Ellipse,
        Some("diamond") => Shape::Diamond,
        Some("text") => Shape::Text,
        _ => Shape::Rectangle,
    });
    let lines = lay_text(kind, &text, font, n.w);
    // a relabelled, reshaped or resized box grows to fit, never shrinks on its own (the user
    // may have sized it)
    let restyled_text = n.text.is_some() || shape.is_some() || n.font_size.is_some();
    let resized = n.w.is_some() || n.h.is_some();
    let (w, h) = if restyled_text || resized {
        let least = if free_text {
            (0.0, 0.0)
        } else {
            (old.2, old.3)
        };
        fit_size(key, kind, &lines, font, n.w, n.h, least)?
    } else {
        (old.2, old.3)
    };
    let (x, y) = at.unwrap_or((old.0, old.1));
    let new = (x, y, w, h);
    let moved = new != old;

    let el = &mut list[i];
    let touched = moved
        || restyled_text
        || new_stroke.is_some()
        || new_fill.is_some()
        || style.is_some()
        || n.link.is_some();
    if !touched {
        return Ok(None);
    }
    el["x"] = json!(x);
    el["y"] = json!(y);
    el["width"] = json!(w);
    el["height"] = json!(h);
    if let Some(s) = style {
        el["strokeStyle"] = json!(s);
    }
    if let Some(l) = &n.link {
        el["link"] = if l.is_empty() { Value::Null } else { json!(l) };
    }
    if free_text {
        if restyled_text {
            el["text"] = json!(lines.join("\n"));
            el["originalText"] = json!(text);
            el["fontSize"] = json!(font);
        }
        if let Some(s) = &new_stroke {
            el["strokeColor"] = json!(s);
        }
        bump(el, g);
        return Ok(moved.then_some(id));
    }
    if shape.is_some() {
        el["type"] = json!(kind.name());
        el["roundness"] = match kind {
            Shape::Rectangle => json!({"type": 3}),
            Shape::Diamond => json!({"type": 2}),
            _ => Value::Null,
        };
    }
    if let Some(s) = &new_stroke {
        el["strokeColor"] = json!(s);
    }
    if let Some(b) = &new_fill {
        el["backgroundColor"] = json!(b);
    }
    bump(el, g);
    let c = center(new);
    match (label, text.is_empty()) {
        (Some(l), false) => {
            let t = &mut list[l];
            if restyled_text || resized || new.2 != old.2 || new.3 != old.3 {
                set_text(t, &lines, &text, c, font, g);
            } else {
                // only moved: the label keeps its place in the box
                t["x"] = json!(t["x"].as_f64().unwrap_or(0.0) + new.0 - old.0);
                t["y"] = json!(t["y"].as_f64().unwrap_or(0.0) + new.1 - old.1);
                bump(t, g);
            }
            if let Some(s) = &new_stroke {
                list[l]["strokeColor"] = json!(s);
            }
        }
        (Some(l), true) => {
            let lid = list[l]["id"].as_str().unwrap_or("").to_string();
            drop_elements(list, &BTreeSet::from([lid]), g);
        }
        (None, false) => {
            let tid = g.id();
            let ink = new_stroke
                .unwrap_or_else(|| list[i]["strokeColor"].as_str().unwrap_or(INK).to_string());
            let frame = list[i]["frameId"].clone();
            let mut t = text_element(&tid, &lines, &text, c, Some(&id), (&ink, font), g);
            t["frameId"] = frame;
            push_bound(&mut list[i], &tid, "text");
            list.push(t);
        }
        (None, true) => {}
    }
    Ok(moved.then_some(id))
}

/// What `patch_edge` asks of the redraw: arrows to draw again by their stored route.
type Redraw = BTreeSet<String>;

/// Re-label, recolour, restyle and re-route the arrows `from -> to`.
fn patch_edge(
    scene: &mut Value,
    e: &EdgeSpec,
    redraw: &mut Redraw,
    g: &mut Gen,
) -> Result<usize, String> {
    let (from, to) = (&e.from, &e.to);
    if !e.changes_something() {
        return Err(format!(
            "edge {from} -> {to}: give a label, color, style, bidirectional, labelAt, route or a side"
        ));
    }
    let plan = EdgePlan::from_spec(e)?;
    let new_ink = e.color.as_ref().map(|_| plan.ink.clone());
    let (a, b) = (resolve(scene, from)?, resolve(scene, to)?);
    let list = els(scene);
    let found = arrows_between(list, &a, &b);
    if found.is_empty() {
        return Err(format!("no arrow {from} -> {to}"));
    }
    // ids, not indexes: dropping a label shifts the list
    let ids: Vec<String> = found
        .iter()
        .map(|&i| list[i]["id"].as_str().unwrap_or("").to_string())
        .collect();
    for arrow_id in &ids {
        let i = find(list, arrow_id).expect("still there");
        let labels: Vec<usize> = arrow_labels(list, i)
            .iter()
            .filter_map(|l| find(list, l))
            .collect();
        if let Some(s) = &new_ink {
            list[i]["strokeColor"] = json!(s);
            for &l in &labels {
                list[l]["strokeColor"] = json!(s);
                bump(&mut list[l], g);
            }
        }
        if let Some(s) = plan.style {
            list[i]["strokeStyle"] = json!(s);
        }
        if let Some(bi) = e.bidirectional {
            list[i]["startArrowhead"] = if bi { json!("arrow") } else { Value::Null };
        }
        if e.route.is_some() || e.from_side.is_some() || e.to_side.is_some() {
            let mut sides: Vec<String> = list[i]["customData"]["writerSides"]
                .as_array()
                .map(|s| {
                    s.iter()
                        .map(|v| v.as_str().unwrap_or("").to_string())
                        .collect()
                })
                .unwrap_or_else(|| vec![String::new(), String::new()]);
            sides.resize(2, String::new());
            if let Some(s) = &e.from_side {
                sides[0] = s.clone();
            }
            if let Some(s) = &e.to_side {
                sides[1] = s.clone();
            }
            if sides.iter().any(|s| !s.is_empty()) {
                let mut custom = list[i]["customData"].clone();
                if !custom.is_object() {
                    custom = json!({});
                }
                custom["writerSides"] = json!(sides);
                list[i]["customData"] = custom;
            }
            if let Some(r) = &e.route {
                list[i]["elbowed"] = json!(r == "elbow");
            }
            redraw.insert(arrow_id.clone());
        }
        if e.label.is_some() || e.label_at.is_some() {
            let old_text = labels.first().map(|&l| text_of(&list[l]));
            let old_at = labels
                .first()
                .and_then(|&l| list[l]["customData"]["labelAt"].as_f64());
            let text = e.label.clone().or(old_text).unwrap_or_default();
            let ink = new_ink
                .clone()
                .unwrap_or_else(|| list[i]["strokeColor"].as_str().unwrap_or(INK).to_string());
            let lids: BTreeSet<String> = labels
                .iter()
                .filter_map(|&l| list[l]["id"].as_str().map(str::to_string))
                .collect();
            drop_elements(list, &lids, g);
            if !text.is_empty() {
                let i = find(list, arrow_id).expect("still there");
                let pts = path_of(&list[i]);
                let frame = list[i]["frameId"].clone();
                let mut arrow = list[i].clone();
                let mut t = make_label(&mut arrow, &pts, &text, e.label_at.or(old_at), &ink, g);
                t["frameId"] = frame;
                list[i] = arrow;
                list.push(t);
            }
        }
        let at = find(list, arrow_id).expect("still there");
        bump(&mut list[at], g);
    }
    Ok(ids.len())
}

/// Draw again, by each arrow's own route (straight, or elbow between its chosen sides), the
/// arrows that end on a box that moved or resized and the ones in `extra`; keep each label where
/// it sits on its arrow.
fn reroute(scene: &mut Value, moved: &BTreeSet<String>, extra: &Redraw, g: &mut Gen) {
    let list = els(scene);
    let arrows: Vec<usize> = (0..list.len())
        .filter(|&i| {
            is_arrow(&list[i])
                && (list[i]["id"].as_str().is_some_and(|id| extra.contains(id))
                    || ["startBinding", "endBinding"]
                        .iter()
                        .any(|k| bound_id(&list[i], k).is_some_and(|b| moved.contains(b))))
        })
        .collect();
    for i in arrows {
        let a = &list[i];
        let pts = path_of(a);
        let (p0, p1) = (
            pts.first().copied().unwrap_or((0.0, 0.0)),
            pts.last().copied().unwrap_or((0.0, 0.0)),
        );
        let rect_at = |k: &str| {
            bound_id(a, k)
                .and_then(|b| find(list, b))
                .map(|j| rect_of(&list[j]))
        };
        let side = |n: usize| {
            a["customData"]["writerSides"][n]
                .as_str()
                .and_then(|s| Side::parse(s).ok())
        };
        let elbow = a["elbowed"] == true;
        let plan = EdgePlan::for_route(elbow, (side(0), side(1)));
        let path = match (rect_at("startBinding"), rect_at("endBinding")) {
            (Some(ra), Some(rb)) => arrow_path(ra, rb, &plan),
            (ra, rb) => {
                let end = |r: Option<Rect>, free| r.map_or(End::Point(free), End::Box);
                let (s, t) = route(end(ra, p0), end(rb, p1));
                Path {
                    points: vec![s, t],
                    sides: None,
                }
            }
        };
        let label_ids = arrow_labels(list, i);
        let arrow = &mut list[i];
        set_path(arrow, &path, elbow);
        bump(arrow, g);
        for lid in label_ids {
            let Some(l) = find(list, &lid) else { continue };
            let original = text_of(&list[l]);
            let lines = wrap(&original, FONT_SIZE, None);
            let at = match list[l]["customData"]["labelAt"].as_f64() {
                Some(f) => along(&path.points, f),
                None => label_anchor(&path.points),
            };
            let font = list[l]["fontSize"].as_f64().unwrap_or(FONT_SIZE);
            set_text(&mut list[l], &lines, &original, at, font, g);
        }
    }
}

/// Apply `spec` to `scene`: removals first (arrows, boxes, zones), then box patches, then arrow
/// patches, then the arrows on anything that moved are redrawn, then the zones. On any problem
/// the scene is untouched and every problem is returned.
pub fn update_scene(scene: &mut Value, spec: &Spec, g: &mut Gen) -> Result<Updated, Vec<String>> {
    if spec.direction.is_some() || !spec.groups.is_empty() || !spec.legend.is_empty() {
        return Err(vec![
            "update takes nodes, edges, zones and remove; direction, groups and legend are for create and add"
                .into(),
        ]);
    }
    let mut work = scene.clone();
    let mut out = Updated::default();
    let mut problems: Vec<String> = Vec::new();
    let mut keep = |r: Result<(), String>| {
        if let Err(e) = r {
            problems.push(e);
        }
    };
    if let Some(rm) = &spec.remove {
        for (from, to) in &rm.edges {
            match remove_arrows(&mut work, from, to, g) {
                Ok(n) => out.removed_edges += n,
                Err(e) => keep(Err(e)),
            }
        }
        for key in &rm.nodes {
            match remove_node(&mut work, key, g) {
                Ok(n) => {
                    out.removed_edges += n;
                    out.removed_nodes += 1;
                }
                Err(e) => keep(Err(e)),
            }
        }
        for key in &rm.zones {
            match zones::remove(&mut work, key, g) {
                Ok(()) => out.removed_zones += 1,
                Err(e) => keep(Err(e)),
            }
        }
    }
    let mut moved = BTreeSet::new();
    for n in &spec.nodes {
        match patch_node(&mut work, n, g) {
            Ok(m) => {
                moved.extend(m);
                out.nodes += 1;
            }
            Err(e) => keep(Err(e)),
        }
    }
    let mut redraw = Redraw::new();
    for e in &spec.edges {
        match patch_edge(&mut work, e, &mut redraw, g) {
            Ok(n) => out.edges += n,
            Err(e) => keep(Err(e)),
        }
    }
    reroute(&mut work, &moved, &redraw, g);
    for z in &spec.zones {
        match zones::patch(&mut work, z, g) {
            Ok(_) => out.zones += 1,
            Err(e) => keep(Err(e)),
        }
    }
    zones::refit_around(&mut work, &moved, g);
    if !problems.is_empty() {
        return Err(problems);
    }
    *scene = work;
    Ok(out)
}
