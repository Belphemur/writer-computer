//! `excalidraw:update`: change what a drawing already holds, in the grammar of `add` (spec
//! `SPECs/excalidraw-spec.md` "Agent commands"). `nodes[]` patch the boxes they name (a field
//! left out stays), `edges[]` re-label or recolour the arrows `from -> to`, `remove` deletes
//! boxes (their arrows and labels with them) and arrows. Everything not named is untouched, byte
//! for byte: only an element that changes moves its `version`, so an open editor sees exactly
//! what changed, and a box that lost or gained an arrow learns about it. A whole update is
//! checked on a copy: an unknown id or colour leaves the drawing as it was. Tauri-free.

use super::*;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Updated {
    pub nodes: usize,
    pub edges: usize,
    pub removed_nodes: usize,
    pub removed_edges: usize,
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

/// The ids of the texts bound to `el` (its label).
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
        ids.extend(labels_of(&list[i]));
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
        ids.extend(labels_of(&list[i]));
        ids.insert(list[i]["id"].as_str().unwrap_or("").to_string());
    }
    drop_elements(list, &ids, g);
    Ok(arrows.len())
}

fn text_of(el: &Value) -> String {
    el["originalText"]
        .as_str()
        .or_else(|| el["text"].as_str())
        .unwrap_or("")
        .to_string()
}

/// Set `text` on a text element and centre it on `at`.
fn set_text(t: &mut Value, lines: &[String], original: &str, at: (f64, f64), g: &mut Gen) {
    let (w, h) = text_size(lines);
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
    let shape = n
        .shape
        .as_deref()
        .map(|s| Shape::parse(Some(s)))
        .transpose()?;
    let tint = n.color.as_deref().map(|c| colors(Some(c))).transpose()?;
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
    let text = n.text.clone().unwrap_or_else(|| old_text.clone());
    let lines = wrap(&text);
    let old = rect_of(&list[i]);
    let kind = shape.unwrap_or_else(|| match list[i]["type"].as_str() {
        Some("ellipse") => Shape::Ellipse,
        Some("diamond") => Shape::Diamond,
        Some("text") => Shape::Text,
        _ => Shape::Rectangle,
    });
    // a relabelled or reshaped box grows to fit, never shrinks (the user may have sized it)
    let regrown = n.text.is_some() || shape.is_some();
    let natural = if free_text {
        if n.text.is_some() {
            text_size(&lines)
        } else {
            (old.2, old.3)
        }
    } else if regrown {
        let need = kind.size(&lines);
        (old.2.max(need.0), old.3.max(need.1))
    } else {
        (old.2, old.3)
    };
    let (w, h) = fit_size(key, natural, &text, &lines, n.w, n.h)?;
    let (x, y) = at.unwrap_or((old.0, old.1));
    let new = (x, y, w, h);
    let moved = new != old;
    let stroke = tint.as_ref().map(|t| t.0.clone());

    let el = &mut list[i];
    let touched = moved || n.text.is_some() || shape.is_some() || tint.is_some();
    if !touched {
        return Ok(None);
    }
    el["x"] = json!(x);
    el["y"] = json!(y);
    el["width"] = json!(w);
    el["height"] = json!(h);
    if free_text {
        el["text"] = json!(lines.join("\n"));
        el["originalText"] = json!(text);
        if let Some(s) = &stroke {
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
    if let Some((s, b)) = &tint {
        el["strokeColor"] = json!(s);
        el["backgroundColor"] = json!(b);
    }
    bump(el, g);
    let c = center(new);
    match (label, text.is_empty()) {
        (Some(l), false) => {
            let t = &mut list[l];
            if n.text.is_some() || regrown || new.2 != old.2 || new.3 != old.3 {
                set_text(t, &lines, &text, c, g);
            } else {
                // only moved: the label keeps its place in the box
                t["x"] = json!(t["x"].as_f64().unwrap_or(0.0) + new.0 - old.0);
                t["y"] = json!(t["y"].as_f64().unwrap_or(0.0) + new.1 - old.1);
                bump(t, g);
            }
            if let Some(s) = &stroke {
                list[l]["strokeColor"] = json!(s);
            }
        }
        (Some(l), true) => {
            let lid = list[l]["id"].as_str().unwrap_or("").to_string();
            drop_elements(list, &BTreeSet::from([lid]), g);
        }
        (None, false) => {
            let tid = g.id();
            let ink = stroke
                .unwrap_or_else(|| list[i]["strokeColor"].as_str().unwrap_or(INK).to_string());
            let t = text_element(&tid, &lines, &text, c, Some(&id), &ink, g);
            push_bound(&mut list[i], &tid, "text");
            list.push(t);
        }
        (None, true) => {}
    }
    Ok(moved.then_some(id))
}

/// Re-label and/or recolour the arrows `from -> to`.
fn patch_edge(scene: &mut Value, e: &EdgeSpec, g: &mut Gen) -> Result<usize, String> {
    let (from, to, label, color) = e.raw()?;
    let tint = color.as_deref().map(|c| colors(Some(c))).transpose()?;
    if label.is_none() && tint.is_none() {
        return Err(format!("edge {from} -> {to}: give a label or a color"));
    }
    let (a, b) = (resolve(scene, &from)?, resolve(scene, &to)?);
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
        let old = labels_of(&list[i]).first().and_then(|l| find(list, l));
        if let Some(s) = tint.as_ref().map(|t| &t.0) {
            list[i]["strokeColor"] = json!(s);
            if let Some(l) = old {
                list[l]["strokeColor"] = json!(s);
                bump(&mut list[l], g);
            }
        }
        if let Some(text) = &label {
            let r = rect_of(&list[i]);
            let end = list[i]["points"]
                .as_array()
                .and_then(|p| p.last())
                .map(|p| (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)))
                .unwrap_or((0.0, 0.0));
            let mid = (r.0 + end.0 / 2.0, r.1 + end.1 / 2.0);
            match (old, text.is_empty()) {
                (Some(l), false) => set_text(&mut list[l], &wrap(text), text, mid, g),
                (Some(l), true) => {
                    let lid = list[l]["id"].as_str().unwrap_or("").to_string();
                    drop_elements(list, &BTreeSet::from([lid]), g);
                }
                (None, false) => {
                    let tid = g.id();
                    let ink = list[i]["strokeColor"].as_str().unwrap_or(INK).to_string();
                    let t = text_element(&tid, &wrap(text), text, mid, Some(arrow_id), &ink, g);
                    push_bound(&mut list[i], &tid, "text");
                    list.push(t);
                }
                (None, true) => {}
            }
        }
        let at = find(list, arrow_id).expect("still there");
        bump(&mut list[at], g);
    }
    Ok(ids.len())
}

/// Draw the arrows that end on a box that moved or resized again, straight between their ends,
/// and keep each label on its arrow's middle.
fn reroute(scene: &mut Value, moved: &BTreeSet<String>, g: &mut Gen) {
    let list = els(scene);
    let arrows: Vec<usize> = (0..list.len())
        .filter(|&i| {
            is_arrow(&list[i])
                && ["startBinding", "endBinding"]
                    .iter()
                    .any(|k| bound_id(&list[i], k).is_some_and(|b| moved.contains(b)))
        })
        .collect();
    for i in arrows {
        let a = &list[i];
        let pts = a["points"].as_array().cloned().unwrap_or_default();
        let at = |p: Option<&Value>| {
            p.map_or((0.0, 0.0), |p| {
                (
                    a["x"].as_f64().unwrap_or(0.0) + p[0].as_f64().unwrap_or(0.0),
                    a["y"].as_f64().unwrap_or(0.0) + p[1].as_f64().unwrap_or(0.0),
                )
            })
        };
        let (p0, p1) = (at(pts.first()), at(pts.last()));
        let end = |k: &str, free: (f64, f64)| match bound_id(a, k).and_then(|b| find(list, b)) {
            Some(j) => End::Box(rect_of(&list[j])),
            None => End::Point(free),
        };
        let (s, t) = route(end("startBinding", p0), end("endBinding", p1));
        let (dx, dy) = (t.0 - s.0, t.1 - s.1);
        let labels = labels_of(a);
        let arrow = &mut list[i];
        arrow["x"] = json!(s.0);
        arrow["y"] = json!(s.1);
        arrow["width"] = json!(dx.abs());
        arrow["height"] = json!(dy.abs());
        arrow["points"] = json!([[0, 0], [dx, dy]]);
        bump(arrow, g);
        let label_at: Vec<usize> = labels.iter().filter_map(|l| find(list, l)).collect();
        for l in label_at {
            let lines = wrap(&text_of(&list[l]));
            let original = text_of(&list[l]);
            set_text(
                &mut list[l],
                &lines,
                &original,
                (s.0 + dx / 2.0, s.1 + dy / 2.0),
                g,
            );
        }
    }
}

/// Apply `spec` to `scene`: removals first (arrows, then boxes), then box patches, then arrow
/// patches, then the arrows on anything that moved are redrawn. On an error the scene is
/// untouched.
pub fn update_scene(scene: &mut Value, spec: &Spec, g: &mut Gen) -> Result<Updated, String> {
    if spec.direction.is_some() || !spec.groups.is_empty() {
        return Err(
            "update takes nodes, edges and remove; direction and groups are for create and add"
                .into(),
        );
    }
    let mut work = scene.clone();
    let mut out = Updated::default();
    if let Some(rm) = &spec.remove {
        for (from, to) in &rm.edges {
            out.removed_edges += remove_arrows(&mut work, from, to, g)?;
        }
        for key in &rm.nodes {
            out.removed_edges += remove_node(&mut work, key, g)?;
            out.removed_nodes += 1;
        }
    }
    let mut moved = BTreeSet::new();
    for n in &spec.nodes {
        moved.extend(patch_node(&mut work, n, g)?);
        out.nodes += 1;
    }
    for e in &spec.edges {
        out.edges += patch_edge(&mut work, e, g)?;
    }
    reroute(&mut work, &moved, g);
    *scene = work;
    Ok(out)
}
