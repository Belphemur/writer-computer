//! `excalidraw:lint`: what is wrong with a drawing's layout, read-only, from the geometry of its
//! elements (so it also judges a drawing a person made): a label over a label, a label over a
//! box, an arrow through a box it does not connect, a text that overflows its box, a box inside
//! a zone it does not belong to. Each finding names the elements by the id an agent gave them
//! (`writerId`) or Excalidraw's own. Tauri-free.

use super::elements::Shape;
use super::excalidraw_md::{elements, is_deleted};
use serde_json::{json, Value};
use std::collections::HashMap;

type Rect = (f64, f64, f64, f64);

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub kind: &'static str,
    pub ids: Vec<String>,
    pub message: String,
}

impl Finding {
    pub fn json(&self) -> Value {
        json!({"kind": self.kind, "ids": self.ids, "message": self.message})
    }

    pub fn line(&self) -> String {
        format!("{}: {} [{}]", self.kind, self.message, self.ids.join(", "))
    }
}

fn rect(el: &Value) -> Rect {
    let n = |k: &str| el[k].as_f64().unwrap_or(0.0);
    (n("x"), n("y"), n("width"), n("height"))
}

/// The rectangles overlap by more than `slack` on both axes.
fn overlap(a: Rect, b: Rect, slack: f64) -> bool {
    a.0 + slack < b.0 + b.2
        && b.0 + slack < a.0 + a.2
        && a.1 + slack < b.1 + b.3
        && b.1 + slack < a.1 + a.3
}

/// Does the segment cross the rectangle (Liang-Barsky)?
fn crosses(p: (f64, f64), q: (f64, f64), r: Rect) -> bool {
    let (dx, dy) = (q.0 - p.0, q.1 - p.1);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (pk, qk) in [
        (-dx, p.0 - r.0),
        (dx, r.0 + r.2 - p.0),
        (-dy, p.1 - r.1),
        (dy, r.1 + r.3 - p.1),
    ] {
        if pk == 0.0 {
            if qk < 0.0 {
                return false;
            }
        } else {
            let t = qk / pk;
            if pk < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

fn shrink(r: Rect, by: f64) -> Rect {
    (
        r.0 + by,
        r.1 + by,
        (r.2 - 2.0 * by).max(0.0),
        (r.3 - 2.0 * by).max(0.0),
    )
}

fn shape_of(el: &Value) -> Shape {
    match el["type"].as_str() {
        Some("ellipse") => Shape::Ellipse,
        Some("diamond") => Shape::Diamond,
        _ => Shape::Rectangle,
    }
}

pub fn lint(scene: &Value) -> Vec<Finding> {
    let els: Vec<&Value> = elements(scene).iter().filter(|e| !is_deleted(e)).collect();
    let key = |el: &Value| -> String {
        el["customData"]["writerId"]
            .as_str()
            .or_else(|| el["id"].as_str())
            .unwrap_or("")
            .to_string()
    };
    let by_id: HashMap<&str, &Value> = els
        .iter()
        .filter_map(|e| Some((e["id"].as_str()?, *e)))
        .collect();
    let boxes: Vec<&Value> = els
        .iter()
        .copied()
        .filter(|e| {
            matches!(
                e["type"].as_str(),
                Some("rectangle" | "ellipse" | "diamond")
            )
        })
        .collect();
    let arrow_name = |a: &Value| -> String {
        let end = |k: &str| {
            a[k]["elementId"]
                .as_str()
                .and_then(|id| by_id.get(id))
                .map(|e| key(e))
        };
        match (end("startBinding"), end("endBinding")) {
            (Some(s), Some(t)) => format!("{s}->{t}"),
            _ => key(a),
        }
    };

    // every text that reads as a label, with whom it belongs to
    struct Label<'a> {
        el: &'a Value,
        name: String,
        /// the element ids it may overlap without a finding (its own container)
        own: Option<&'a str>,
    }
    let mut labels: Vec<Label> = Vec::new();
    for t in els.iter().copied().filter(|e| e["type"] == "text") {
        if t["customData"]["writerLegend"].is_number() {
            continue;
        }
        let own = t["containerId"].as_str();
        let name = match own.and_then(|c| by_id.get(c)) {
            Some(c) if c["type"] == "arrow" => format!("label of {}", arrow_name(c)),
            Some(c) => format!("text of {}", key(c)),
            None => match t["customData"]["writerLabelOf"]
                .as_str()
                .and_then(|a| by_id.get(a))
            {
                Some(a) => format!("label of {}", arrow_name(a)),
                None => key(t),
            },
        };
        labels.push(Label { el: t, name, own });
    }

    let mut out = Vec::new();
    for (i, a) in labels.iter().enumerate() {
        for b in &labels[i + 1..] {
            if overlap(rect(a.el), rect(b.el), 1.0) {
                out.push(Finding {
                    kind: "label-over-label",
                    ids: vec![key(a.el), key(b.el)],
                    message: format!("{} overlaps {}", a.name, b.name),
                });
            }
        }
    }
    for l in &labels {
        let in_box = l
            .own
            .and_then(|c| by_id.get(c))
            .is_some_and(|c| c["type"] != "arrow");
        let mut cross = |b: &Value| {
            out.push(Finding {
                kind: "label-over-box",
                ids: vec![key(l.el), key(b)],
                message: format!("{} sits on {}", l.name, key(b)),
            });
        };
        for b in &boxes {
            if in_box && l.own == b["id"].as_str() {
                continue;
            }
            if overlap(rect(l.el), rect(b), 1.0) {
                cross(b);
            }
        }
    }
    for a in els.iter().copied().filter(|e| e["type"] == "arrow") {
        let (x, y) = (
            a["x"].as_f64().unwrap_or(0.0),
            a["y"].as_f64().unwrap_or(0.0),
        );
        let pts: Vec<(f64, f64)> = a["points"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                (
                    x + p[0].as_f64().unwrap_or(0.0),
                    y + p[1].as_f64().unwrap_or(0.0),
                )
            })
            .collect();
        let ends = [
            a["startBinding"]["elementId"].as_str(),
            a["endBinding"]["elementId"].as_str(),
        ];
        for b in &boxes {
            if ends.contains(&b["id"].as_str()) {
                continue;
            }
            let r = shrink(rect(b), 2.0);
            if pts.windows(2).any(|w| crosses(w[0], w[1], r)) {
                out.push(Finding {
                    kind: "arrow-through-box",
                    ids: vec![arrow_name(a), key(b)],
                    message: format!("arrow {} runs through {}", arrow_name(a), key(b)),
                });
            }
        }
    }
    for b in &boxes {
        let Some(t) = els
            .iter()
            .find(|t| t["type"] == "text" && t["containerId"] == b["id"])
        else {
            continue;
        };
        let lines: Vec<String> = t["text"]
            .as_str()
            .unwrap_or("")
            .split('\n')
            .map(str::to_string)
            .collect();
        let font = t["fontSize"].as_f64().unwrap_or(20.0);
        let need = shape_of(b).min_size(&lines, font);
        let have = rect(b);
        if need.0 > have.2 + 0.5 || need.1 > have.3 + 0.5 {
            out.push(Finding {
                kind: "text-overflow",
                ids: vec![key(b)],
                message: format!(
                    "the text of {} needs {} x {}, the box is {} x {}",
                    key(b),
                    need.0.ceil(),
                    need.1.ceil(),
                    have.2.round(),
                    have.3.round()
                ),
            });
        }
    }
    for f in els.iter().copied().filter(|e| e["type"] == "frame") {
        let fid = f["id"].as_str().unwrap_or("");
        for b in &boxes {
            let c = (rect(b).0 + rect(b).2 / 2.0, rect(b).1 + rect(b).3 / 2.0);
            let r = rect(f);
            let inside = c.0 > r.0 && c.0 < r.0 + r.2 && c.1 > r.1 && c.1 < r.1 + r.3;
            if inside && b["frameId"].as_str() != Some(fid) {
                out.push(Finding {
                    kind: "zone-contains-box",
                    ids: vec![key(f), key(b)],
                    message: format!("{} is inside zone {} but not a member", key(b), key(f)),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(id: &str, x: f64, y: f64) -> Value {
        json!({"id": id, "type": "rectangle", "x": x, "y": y, "width": 100, "height": 60, "customData": {"writerId": id}})
    }

    #[test]
    fn segments_and_rectangles() {
        let r = (10.0, 10.0, 20.0, 20.0);
        assert!(crosses((0.0, 20.0), (50.0, 20.0), r));
        assert!(!crosses((0.0, 5.0), (50.0, 5.0), r));
        assert!(!crosses((0.0, 0.0), (5.0, 50.0), r));
        assert!(overlap((0.0, 0.0, 10.0, 10.0), (5.0, 5.0, 10.0, 10.0), 1.0));
        assert!(!overlap(
            (0.0, 0.0, 10.0, 10.0),
            (10.0, 0.0, 10.0, 10.0),
            0.0
        ));
    }

    #[test]
    fn an_arrow_through_a_third_box_is_found() {
        let scene = json!({"elements": [
            sq("a", 0.0, 0.0), sq("b", 400.0, 0.0), sq("c", 200.0, 0.0),
            {"id": "ar", "type": "arrow", "x": 100.0, "y": 30.0, "width": 300.0, "height": 0,
             "points": [[0, 0], [300, 0]],
             "startBinding": {"elementId": "a"}, "endBinding": {"elementId": "b"}}
        ]});
        let f = lint(&scene);
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].kind, "arrow-through-box");
        assert_eq!(f[0].ids, vec!["a->b".to_string(), "c".to_string()]);
    }
}
