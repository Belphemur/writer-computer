//! The diagram work (ADR 2026-11-18, 2026-11-19 lane 1) through the real argument parser on a
//! synthetic vault: where a spec comes from (`@file`, stdin, `\n` inside JSON), text that wraps at
//! the box's width, `check` listing every problem, zones as frames, arrow styles and sides, node
//! styles and links, `lint`, the legend and the read / create round trip.

use super::*;

const D: &str = "D.excalidraw";

fn create(v: &Vaults, path: &str, spec: &Value) -> String {
    v.ok(&[
        "excalidraw:create",
        &format!("path={path}"),
        &spec_arg(spec),
    ])
}

fn els(scene: &Value) -> Vec<Value> {
    md::elements(scene)
        .iter()
        .filter(|e| !md::is_deleted(e))
        .cloned()
        .collect()
}

fn node(scene: &Value, key: &str) -> Value {
    els(scene)
        .into_iter()
        .find(|e| e["customData"]["writerId"] == key)
        .unwrap_or_else(|| panic!("no element {key}"))
}

fn read(v: &Vaults, path: &str) -> Value {
    serde_json::from_str(&v.ok(&["excalidraw:read", &format!("path={path}")])).unwrap()
}

fn lint(v: &Vaults, path: &str) -> Vec<Value> {
    let out: Value =
        serde_json::from_str(&v.ok(&["excalidraw:lint", &format!("path={path}")])).unwrap();
    out["findings"].as_array().unwrap().clone()
}

fn kinds(findings: &[Value]) -> Vec<&str> {
    findings
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect()
}

// ---------- where a spec comes from ----------

#[test]
fn a_spec_comes_from_a_vault_file_or_standard_input() {
    let v = Vaults::new();
    let spec = json!({"nodes": [{"id": "a", "text": "A"}, {"id": "b", "text": "B"}], "edges": [["a", "b"]]});
    std::fs::create_dir_all(v.path("Specs")).unwrap();
    std::fs::write(v.path("Specs/arch.json"), spec.to_string()).unwrap();
    let out = v.ok(&["excalidraw:create", "path=F", "spec=@Specs/arch.json"]);
    assert!(out.contains("2 boxes, 1 arrow"), "{out}");
    // stdin
    let o = v.run_stdin(
        &["excalidraw:create", "path=S", "spec=-"],
        &spec.to_string(),
    );
    assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
    assert_eq!(read(&v, "S.excalidraw"), read(&v, "F.excalidraw"));
    // the same for add and update
    let o = v.run_stdin(
        &["excalidraw:add", "path=S.excalidraw", "spec=-"],
        r#"{"nodes":[{"id":"c","text":"C"}]}"#,
    );
    assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
    let o = v.run_stdin(
        &["excalidraw:update", "path=S.excalidraw", "spec=-"],
        r#"{"nodes":[{"id":"c","text":"Cee"}]}"#,
    );
    assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
}

#[test]
fn a_spec_file_is_confined_to_the_vault() {
    let v = Vaults::new();
    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("s.json"), "{}").unwrap();
    std::fs::write(v.path(".obsidian/s.json"), "{}").unwrap();
    for target in [
        format!("@{}", outside.path().join("s.json").display()),
        "@../s.json".to_string(),
        "@.obsidian/s.json".to_string(),
    ] {
        let o = v.run(&["excalidraw:create", "path=X", &format!("spec={target}")]);
        assert_eq!(o.code, EXIT_FAIL, "{target}: {}", o.stdout);
        assert!(!v.path("X.excalidraw").exists(), "{target}");
    }
    let o = v.run(&["excalidraw:create", "path=X", "spec=@missing.json"]);
    assert_eq!(o.code, EXIT_FAIL);
    assert!(o.stderr.contains("no such file"), "{}", o.stderr);
}

#[test]
fn a_newline_escape_inside_a_json_string_reaches_the_parser_as_written() {
    let v = Vaults::new();
    // the two characters backslash and n, as an agent types them inside a JSON string
    let line = r#"spec={"nodes":[{"id":"a","text":"one\ntwo"}]}"#;
    let o = v.run(&["excalidraw:create", "path=N", line]);
    assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
    let scene = v.scene("N.excalidraw");
    let text = els(&scene)
        .into_iter()
        .find(|e| e["type"] == "text")
        .unwrap();
    assert_eq!(text["originalText"], "one\ntwo");
    // and an ordinary parameter is still unescaped
    assert_eq!(read(&v, "N.excalidraw")["nodes"][0]["text"], "one\ntwo");
}

// ---------- text wraps at the box ----------

#[test]
fn text_wraps_at_the_given_width_and_the_box_grows_without_one() {
    let v = Vaults::new();
    let long = "the quick brown fox jumps over the lazy dog again and again";
    create(
        &v,
        D,
        &json!({"nodes": [
            {"id": "narrow", "text": long, "w": 200, "x": 0, "y": 0},
            {"id": "free", "text": long, "x": 400, "y": 0},
            {"id": "short", "text": "Short", "x": 800, "y": 0}
        ]}),
    );
    let s = v.scene(D);
    let t = |key: &str| {
        let b = node(&s, key);
        let lines = els(&s)
            .into_iter()
            .find(|e| e["containerId"] == b["id"])
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .split('\n')
            .count();
        (b["width"].as_f64().unwrap(), lines)
    };
    let (narrow_w, narrow_lines) = t("narrow");
    assert_eq!(narrow_w, 200.0);
    assert!(
        narrow_lines >= 4,
        "wraps at its width: {narrow_lines} lines"
    );
    let (free_w, free_lines) = t("free");
    assert!(
        free_w > 200.0 && free_w <= 400.0,
        "a sane maximum: {free_w}"
    );
    assert!(free_lines < narrow_lines);
    assert!(t("short").0 <= 130.0);
    assert!(lint(&v, D).is_empty(), "{:?}", lint(&v, D));
}

#[test]
fn text_that_cannot_fit_is_an_error_naming_the_size_it_needs() {
    let v = Vaults::new();
    let err = v.fail(&[
        "excalidraw:create",
        "path=X",
        &spec_arg(&json!({"nodes": [{"id": "a", "text": "Extraordinarily", "w": 100}]})),
    ]);
    assert!(
        err.contains("overflows") && err.contains("needs at least"),
        "{err}"
    );
    let err = v.fail(&[
        "excalidraw:create",
        "path=X",
        &spec_arg(
            &json!({"nodes": [{"id": "a", "text": "a b c d e f g h i j k l", "w": 120, "h": 60}]}),
        ),
    ]);
    assert!(err.contains("overflows"), "{err}");
}

// ---------- check ----------

#[test]
fn check_lists_every_problem_and_writes_nothing() {
    let v = Vaults::new();
    let bad = json!({
        "nodes": [
            {"id": "a", "text": "A", "color": "mauve"},
            {"id": "a", "text": "again"},
            {"id": "b", "text": "Extraordinarily", "w": 100},
            {"id": "c", "text": "C", "strokeStyle": "wavy"},
            {"id": "d", "text": "D", "link": "Note"}
        ],
        "edges": [["a", "zz"], {"from": "a", "to": "c", "style": "zigzag"}, {"from": "c", "to": "a", "labelAt": 2}],
        "zones": [{"id": "z", "label": "Z", "nodes": ["a", "nope"]}]
    });
    let o = v.run(&["excalidraw:create", "path=X", "check", &spec_arg(&bad)]);
    assert_eq!(o.code, EXIT_FAIL);
    for needle in [
        "unknown color mauve",
        "used twice",
        "overflows",
        "unknown style wavy",
        "link Note is [[Note]]",
        "no node zz",
        "unknown style zigzag",
        "labelAt",
        "no node nope",
    ] {
        assert!(o.stderr.contains(needle), "{needle}: {}", o.stderr);
    }
    assert!(o.stderr.contains("problems:"), "{}", o.stderr);
    assert!(!v.path("X.excalidraw").exists());
    // a normal run reports them all too, and writes nothing
    let o = v.run(&["excalidraw:create", "path=X", &spec_arg(&bad)]);
    assert_eq!(o.code, EXIT_FAIL);
    assert!(o.stderr.contains("unknown color mauve") && o.stderr.contains("no node nope"));
    assert!(!v.path("X.excalidraw").exists());
    // structural problems are listed together as well
    let o = v.run(&[
        "excalidraw:create",
        "path=X",
        "check",
        r#"spec={"nodes":[{"id":"a","colour":"red"},{"text":"no id"}],"edgez":[]}"#,
    ]);
    assert_eq!(o.code, EXIT_FAIL);
    assert!(
        o.stderr.contains("unknown field edgez")
            && o.stderr.contains("nodes[0] (a)")
            && o.stderr.contains("nodes[1]"),
        "{}",
        o.stderr
    );
}

#[test]
fn a_good_check_says_so_and_writes_nothing_for_create_add_and_update() {
    let v = Vaults::new();
    let good = json!({"nodes": [{"id": "a", "text": "A"}, {"id": "b", "text": "B"}], "edges": [["a", "b"]]});
    let out = v.ok(&["excalidraw:create", "path=C", "check", &spec_arg(&good)]);
    assert!(
        out.starts_with("OK: would create 2 boxes, 1 arrow"),
        "{out}"
    );
    assert!(!v.path("C.excalidraw").exists());
    create(&v, "C", &good);
    let before = std::fs::read(v.path("C.excalidraw")).unwrap();
    let out = v.ok(&[
        "excalidraw:add",
        "path=C.excalidraw",
        "check",
        &spec_arg(&json!({"nodes": [{"id": "c", "text": "C"}]})),
    ]);
    assert!(out.starts_with("OK: would add 1 box and 0 arrows"), "{out}");
    let out = v.ok(&[
        "excalidraw:update",
        "path=C.excalidraw",
        "check",
        &spec_arg(&json!({"nodes": [{"id": "a", "text": "Aye"}]})),
    ]);
    assert!(out.starts_with("OK: updated 1 box"), "{out}");
    let err = v.fail(&[
        "excalidraw:update",
        "path=C.excalidraw",
        "check",
        &spec_arg(
            &json!({"nodes": [{"id": "nope"}, {"id": "ghost"}], "remove": {"nodes": ["zip"]}}),
        ),
    ]);
    assert!(
        err.contains("no node nope")
            && err.contains("no node ghost")
            && err.contains("no node zip"),
        "{err}"
    );
    assert_eq!(std::fs::read(v.path("C.excalidraw")).unwrap(), before);
    // an existing file is a problem to report, not a surprise
    let err = v.fail(&["excalidraw:create", "path=C", "check", &spec_arg(&good)]);
    assert!(err.contains("already exists"), "{err}");
}

// ---------- zones ----------

#[test]
fn zones_are_frames_sized_around_their_boxes_with_the_label_as_name() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({
            "nodes": [
                {"id": "a", "text": "A", "x": 0, "y": 0},
                {"id": "b", "text": "B", "x": 300, "y": 40},
                {"id": "c", "text": "C", "x": 800, "y": 0}
            ],
            "edges": [["a", "b", "calls"], ["b", "c"]],
            "zones": [{"id": "edge", "label": "At the edge", "nodes": ["a", "b"], "color": "blue", "padding": 30}]
        }),
    );
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let frame = node(&s, "edge");
    assert_eq!(frame["type"], "frame");
    assert_eq!(frame["name"], "At the edge");
    assert_eq!(frame["strokeColor"], "#1971c2");
    let fid = frame["id"].as_str().unwrap();
    for k in ["a", "b"] {
        assert_eq!(node(&s, k)["frameId"], fid);
    }
    assert!(node(&s, "c")["frameId"].is_null());
    // the frame holds both boxes with the padding, and the arrow between them with its label
    let (fx, fy, fw, fh) = (
        frame["x"].as_f64().unwrap(),
        frame["y"].as_f64().unwrap(),
        frame["width"].as_f64().unwrap(),
        frame["height"].as_f64().unwrap(),
    );
    for k in ["a", "b"] {
        let b = node(&s, k);
        let (x, y, w, h) = (
            b["x"].as_f64().unwrap(),
            b["y"].as_f64().unwrap(),
            b["width"].as_f64().unwrap(),
            b["height"].as_f64().unwrap(),
        );
        assert!(x >= fx + 30.0 - 0.5 && y >= fy + 30.0 - 0.5, "{k}");
        assert!(
            x + w <= fx + fw - 30.0 + 0.5 && y + h <= fy + fh - 30.0 + 0.5,
            "{k}"
        );
    }
    let inside: Vec<Value> = els(&s)
        .into_iter()
        .filter(|e| e["frameId"] == fid)
        .collect();
    assert!(inside.iter().any(|e| e["type"] == "arrow"));
    assert!(inside
        .iter()
        .any(|e| e["type"] == "text" && e["text"] == "calls"));
    // the arrow that leaves the zone is not in it
    let leaving = els(&s)
        .into_iter()
        .find(|e| e["type"] == "arrow" && e["endBinding"]["elementId"] == node(&s, "c")["id"])
        .unwrap();
    assert!(leaving["frameId"].is_null());
    assert!(lint(&v, D).iter().all(|f| f["kind"] != "zone-contains-box"));
    // read gives the zone back
    let spec = read(&v, D);
    assert_eq!(spec["zones"][0]["id"], "edge");
    assert_eq!(spec["zones"][0]["label"], "At the edge");
    assert_eq!(spec["zones"][0]["nodes"], json!(["a", "b"]));
    assert_eq!(spec["zones"][0]["color"], "blue");
    assert_eq!(spec["zones"][0]["padding"], 30.0);
}

#[test]
fn zones_do_not_nest_and_a_box_is_in_one() {
    let v = Vaults::new();
    let nodes = json!([{"id": "a", "text": "A"}, {"id": "b", "text": "B"}]);
    for (zones, needle) in [
        (
            json!([{"id": "z", "nodes": ["a"]}, {"id": "y", "nodes": ["z"]}]),
            "zones do not nest",
        ),
        (
            json!([{"id": "z", "nodes": ["a"]}, {"id": "y", "nodes": ["a", "b"]}]),
            "one zone",
        ),
        (json!([{"id": "z"}]), "needs nodes"),
        (
            json!([{"id": "z", "nodes": ["a"]}, {"id": "z", "nodes": ["b"]}]),
            "used twice",
        ),
    ] {
        let err = v.fail(&[
            "excalidraw:create",
            "path=Z",
            &spec_arg(&json!({"nodes": nodes, "zones": zones})),
        ]);
        assert!(err.contains(needle), "{zones}: {err}");
    }
}

#[test]
fn update_changes_zone_membership_refits_and_removes_a_zone() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({
            "nodes": [
                {"id": "a", "text": "A", "x": 0, "y": 0},
                {"id": "b", "text": "B", "x": 300, "y": 0},
                {"id": "c", "text": "C", "x": 900, "y": 0}
            ],
            "zones": [{"id": "z", "label": "Z", "nodes": ["a", "b"]}]
        }),
    );
    let width = |s: &Value| node(s, "z")["width"].as_f64().unwrap();
    let w0 = width(&v.scene(D));
    // c joins, the frame grows to hold it
    v.ok(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"zones": [{"id": "z", "nodes": ["a", "b", "c"], "label": "Zone"}]})),
    ]);
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    assert_eq!(node(&s, "c")["frameId"], node(&s, "z")["id"]);
    assert_eq!(node(&s, "z")["name"], "Zone");
    assert!(width(&s) > w0 + 400.0);
    // a box moved inside a zone refits it
    v.ok(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"nodes": [{"id": "c", "x": 400, "y": 0}]})),
    ]);
    assert!(width(&v.scene(D)) < w0 + 400.0);
    // a box in a zone cannot be taken into another
    let err = v.fail(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"zones": [{"id": "y", "label": "Y", "nodes": ["c"]}]})),
    ]);
    assert!(err.contains("already in a zone"), "{err}");
    // removing a zone takes the frame and leaves its boxes, free
    let out = v.ok(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"remove": {"zones": ["z"]}})),
    ]);
    assert!(out.contains("emoved 1 zone"), "{out}");
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    assert!(els(&s).iter().all(|e| e["type"] != "frame"));
    assert!(["a", "b", "c"]
        .iter()
        .all(|k| node(&s, k)["frameId"].is_null()));
}

// ---------- arrows ----------

fn arrow_between(s: &Value, from: &str, to: &str) -> Value {
    let (a, b) = (node(s, from)["id"].clone(), node(s, to)["id"].clone());
    els(s)
        .into_iter()
        .find(|e| {
            e["type"] == "arrow"
                && e["startBinding"]["elementId"] == a
                && e["endBinding"]["elementId"] == b
        })
        .unwrap_or_else(|| panic!("no arrow {from} -> {to}"))
}

fn pair() -> Value {
    json!([
        {"id": "a", "text": "A", "x": 0, "y": 0, "w": 120, "h": 60},
        {"id": "b", "text": "B", "x": 400, "y": 200, "w": 120, "h": 60}
    ])
}

#[test]
fn edges_take_a_style_a_colour_two_heads_and_a_label_position() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({"nodes": pair(), "edges": [
            {"from": "a", "to": "b", "label": "later", "style": "dashed", "color": "red",
             "bidirectional": true, "labelAt": 0.2}
        ]}),
    );
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let ar = arrow_between(&s, "a", "b");
    assert_eq!(ar["strokeStyle"], "dashed");
    assert_eq!(ar["strokeColor"], "#e03131");
    assert_eq!(ar["startArrowhead"], "arrow");
    assert_eq!(ar["endArrowhead"], "arrow");
    // the label is not bound (Excalidraw would centre it) but sits a fifth of the way along
    let label = els(&s)
        .into_iter()
        .find(|e| e["type"] == "text" && e["text"] == "later")
        .unwrap();
    assert!(label["containerId"].is_null());
    assert_eq!(label["customData"]["writerLabelOf"], ar["id"]);
    let (ax, ay) = (ar["x"].as_f64().unwrap(), ar["y"].as_f64().unwrap());
    let end = &ar["points"][1];
    let (cx, cy) = (
        label["x"].as_f64().unwrap() + label["width"].as_f64().unwrap() / 2.0,
        label["y"].as_f64().unwrap() + label["height"].as_f64().unwrap() / 2.0,
    );
    assert!((cx - (ax + end[0].as_f64().unwrap() * 0.2)).abs() < 1.0);
    assert!((cy - (ay + end[1].as_f64().unwrap() * 0.2)).abs() < 1.0);
    // read gives the object form back, and the list form stays for plain arrows
    let spec = read(&v, D);
    assert_eq!(
        spec["edges"][0],
        json!({"from": "a", "to": "b", "label": "later", "style": "dashed", "color": "red",
               "bidirectional": true, "labelAt": 0.2})
    );
    create(
        &v,
        "P",
        &json!({"nodes": pair(), "edges": [["a", "b", "plain"]]}),
    );
    assert_eq!(
        read(&v, "P.excalidraw")["edges"][0],
        json!(["a", "b", "plain"])
    );
    // update re-labels along with the position, recolours and restyles
    v.ok(&["excalidraw:update", &format!("path={D}"), &spec_arg(&json!({"edges": [
        {"from": "a", "to": "b", "style": "dotted", "bidirectional": false, "label": "now", "labelAt": 0.5}
    ]}))]);
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let ar = arrow_between(&s, "a", "b");
    assert_eq!(ar["strokeStyle"], "dotted");
    assert!(ar["startArrowhead"].is_null());
    let label = els(&s)
        .into_iter()
        .find(|e| e["type"] == "text" && e["text"] == "now")
        .unwrap();
    assert_eq!(label["containerId"], ar["id"]);
    assert_eq!(label["originalText"], "now");
}

#[test]
fn sides_and_an_elbow_route_draw_right_angles_between_the_chosen_sides() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({"nodes": pair(), "edges": [
            {"from": "a", "to": "b", "fromSide": "right", "toSide": "top", "route": "elbow", "label": "go"},
            {"from": "b", "to": "a", "fromSide": "left", "toSide": "bottom"}
        ]}),
    );
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let ar = arrow_between(&s, "a", "b");
    assert_eq!(ar["elbowed"], true);
    assert!(ar["roundness"].is_null());
    assert_eq!(ar["startBinding"]["fixedPoint"], json!([1.0, 0.5]));
    assert_eq!(ar["endBinding"]["fixedPoint"], json!([0.5, 0.0]));
    // right then down: three points, every segment horizontal or vertical
    let pts = ar["points"].as_array().unwrap();
    assert_eq!(pts.len(), 3);
    for w in pts.windows(2) {
        assert!(w[0][0] == w[1][0] || w[0][1] == w[1][1], "{pts:?}");
    }
    // it starts at the right side of a and ends at the top of b
    let a = node(&s, "a");
    assert!((ar["x"].as_f64().unwrap() - (a["x"].as_f64().unwrap() + 120.0)).abs() <= 5.0);
    let last = pts.last().unwrap();
    let b = node(&s, "b");
    assert!(
        (ar["x"].as_f64().unwrap() + last[0].as_f64().unwrap() - (b["x"].as_f64().unwrap() + 60.0))
            .abs()
            < 1.0
    );
    // a straight arrow on chosen sides is a line between them
    let back = arrow_between(&s, "b", "a");
    assert_eq!(back["elbowed"], false);
    assert_eq!(back["points"].as_array().unwrap().len(), 2);
    assert!(
        (back["x"].as_f64().unwrap() - (b["x"].as_f64().unwrap() - ARROW_GAP_TEST)).abs() < 1.0
    );
    // read gives sides and route back
    let spec = read(&v, D);
    assert_eq!(
        spec["edges"][0],
        json!({"from": "a", "to": "b", "label": "go", "fromSide": "right", "toSide": "top", "route": "elbow"})
    );
    assert_eq!(
        spec["edges"][1],
        json!({"from": "b", "to": "a", "fromSide": "left", "toSide": "bottom"})
    );
    // moving a box draws the elbow again between the same sides
    v.ok(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"nodes": [{"id": "b", "x": 700, "y": 400}]})),
    ]);
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let ar = arrow_between(&s, "a", "b");
    assert_eq!(ar["elbowed"], true);
    for w in ar["points"].as_array().unwrap().windows(2) {
        assert!(w[0][0] == w[1][0] || w[0][1] == w[1][1]);
    }
    // an unknown side or route is named
    let err = v.fail(&[
        "excalidraw:create",
        "path=Q",
        &spec_arg(&json!({"nodes": pair(), "edges": [
            {"from": "a", "to": "b", "fromSide": "middle", "route": "curvy"}
        ]})),
    ]);
    assert!(
        err.contains("unknown side middle") || err.contains("route is straight or elbow"),
        "{err}"
    );
}

const ARROW_GAP_TEST: f64 = 4.0;

// ---------- nodes ----------

#[test]
fn nodes_take_fill_and_stroke_apart_a_font_size_a_line_style_and_a_link() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({"nodes": [
            {"id": "a", "text": "Plain", "color": "blue"},
            {"id": "b", "text": "Split", "fill": "#ffeeaa", "stroke": "red", "strokeStyle": "dashed",
             "fontSize": 28, "link": "[[Release notes]]"},
            {"id": "c", "text": "Light", "fill": "green"}
        ]}),
    );
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let a = node(&s, "a");
    assert_eq!(
        (a["strokeColor"].as_str(), a["backgroundColor"].as_str()),
        (Some("#1971c2"), Some("#a5d8ff"))
    );
    let b = node(&s, "b");
    assert_eq!(b["strokeColor"], "#e03131");
    assert_eq!(b["backgroundColor"], "#ffeeaa");
    assert_eq!(b["strokeStyle"], "dashed");
    assert_eq!(b["link"], "[[Release notes]]");
    let bt = els(&s)
        .into_iter()
        .find(|e| e["containerId"] == b["id"])
        .unwrap();
    assert_eq!(bt["fontSize"], 28.0);
    assert_eq!(bt["strokeColor"], "#e03131");
    let c = node(&s, "c");
    assert_eq!(
        (c["strokeColor"].as_str(), c["backgroundColor"].as_str()),
        (Some(INK_TEST), Some("#b2f2bb"))
    );
    // a bigger font makes a bigger box
    assert!(b["height"].as_f64().unwrap() >= 60.0);
    // read gives it all back, in the same fields
    let spec = read(&v, D);
    let n = |id: &str| {
        spec["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(n("a")["color"], "blue");
    assert_eq!(n("b")["stroke"], "red");
    assert_eq!(n("b")["fill"], "#ffeeaa");
    assert_eq!(n("b")["strokeStyle"], "dashed");
    assert_eq!(n("b")["fontSize"], 28.0);
    assert_eq!(n("b")["link"], "[[Release notes]]");
    assert_eq!(n("c")["fill"], "green");
    assert!(n("c").get("stroke").is_none() && n("c").get("color").is_none());
}

const INK_TEST: &str = "#1e1e1e";

#[test]
fn update_restyles_relinks_and_unlinks_a_box() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({"nodes": [{"id": "a", "text": "A", "link": "[[One]]"}, {"id": "b", "text": "B"}]}),
    );
    let before = v.scene(D);
    v.ok(&["excalidraw:update", &format!("path={D}"), &spec_arg(&json!({"nodes": [
        {"id": "a", "link": "[[Two]]", "fill": "yellow", "strokeStyle": "dotted", "fontSize": 24},
        {"id": "b", "link": "https://example.com/x"}
    ]}))]);
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    assert_eq!(node(&s, "a")["link"], "[[Two]]");
    assert_eq!(node(&s, "a")["backgroundColor"], "#ffec99");
    assert_eq!(node(&s, "a")["strokeColor"], before_stroke(&before, "a"));
    assert_eq!(node(&s, "a")["strokeStyle"], "dotted");
    assert_eq!(node(&s, "b")["link"], "https://example.com/x");
    v.ok(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"nodes": [{"id": "a", "link": ""}]})),
    ]);
    assert!(node(&v.scene(D), "a")["link"].is_null());
    let err = v.fail(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(
            &json!({"nodes": [{"id": "a", "link": "oops"}, {"id": "b", "strokeStyle": "x"}]}),
        ),
    ]);
    assert!(
        err.contains("is [[Note]] or a URL") && err.contains("unknown style x"),
        "{err}"
    );
}

fn before_stroke(scene: &Value, key: &str) -> Value {
    node(scene, key)["strokeColor"].clone()
}

// ---------- legend ----------

#[test]
fn the_legend_is_text_under_the_drawing_and_reads_back_as_a_list() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({"nodes": pair(), "edges": [["a", "b"]],
                "legend": ["Blue: runs in the cloud", "Open: who owns the queue?"]}),
    );
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let legend: Vec<Value> = els(&s)
        .into_iter()
        .filter(|e| e["customData"]["writerLegend"].is_number())
        .collect();
    assert_eq!(legend.len(), 2);
    let bottom = ["a", "b"]
        .iter()
        .map(|k| node(&s, k)["y"].as_f64().unwrap() + node(&s, k)["height"].as_f64().unwrap())
        .fold(0.0, f64::max);
    assert!(legend.iter().all(|l| l["y"].as_f64().unwrap() > bottom));
    assert!(legend[1]["y"].as_f64().unwrap() > legend[0]["y"].as_f64().unwrap());
    let spec = read(&v, D);
    assert_eq!(
        spec["legend"],
        json!(["Blue: runs in the cloud", "Open: who owns the queue?"])
    );
    // legend lines are not nodes
    assert_eq!(spec["nodes"].as_array().unwrap().len(), 2);
    assert!(spec.get("other").is_none());
    // add appends below
    v.ok(&[
        "excalidraw:add",
        &format!("path={D}"),
        &spec_arg(&json!({"legend": ["Scope: v2 only"]})),
    ]);
    let spec = read(&v, D);
    assert_eq!(spec["legend"].as_array().unwrap().len(), 3);
    assert_eq!(spec["legend"][2], "Scope: v2 only");
    assert!(lint(&v, D).is_empty(), "{:?}", lint(&v, D));
}

// ---------- lint ----------

#[test]
fn lint_finds_an_arrow_through_a_box_a_label_over_a_box_and_a_label_over_a_label() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({
            "nodes": [
                {"id": "a", "text": "A", "x": 0, "y": 0, "w": 120, "h": 60},
                {"id": "mid", "text": "Middle", "x": 300, "y": 0, "w": 120, "h": 60},
                {"id": "b", "text": "B", "x": 700, "y": 0, "w": 120, "h": 60},
                {"id": "c", "text": "C", "x": 0, "y": 300, "w": 120, "h": 60},
                {"id": "d", "text": "D", "x": 700, "y": 300, "w": 120, "h": 60}
            ],
            "edges": [
                ["a", "b", "through"],
                {"from": "c", "to": "d", "label": "one", "labelAt": 0.5},
                {"from": "d", "to": "c", "label": "two", "fromSide": "bottom", "toSide": "bottom", "route": "elbow"}
            ]
        }),
    );
    let findings = lint(&v, D);
    let ks = kinds(&findings);
    assert!(ks.contains(&"arrow-through-box"), "{findings:?}");
    let through = findings
        .iter()
        .find(|f| f["kind"] == "arrow-through-box")
        .unwrap();
    assert_eq!(through["ids"], json!(["a->b", "mid"]));
    // the label of a->b sits in the middle of the line, on top of the box in the way
    assert!(ks.contains(&"label-over-box"), "{findings:?}");
    let text_out = v.ok(&["excalidraw:lint", &format!("path={D}"), "format=text"]);
    assert!(
        text_out.contains("arrow-through-box: arrow a->b runs through mid"),
        "{text_out}"
    );
    // move the labels onto each other: two labels at the same spot
    create(
        &v,
        "L",
        &json!({
            "nodes": [
                {"id": "a", "text": "A", "x": 0, "y": 0, "w": 120, "h": 60},
                {"id": "b", "text": "B", "x": 600, "y": 0, "w": 120, "h": 60}
            ],
            "edges": [
                {"from": "a", "to": "b", "label": "first"},
                {"from": "b", "to": "a", "label": "second"}
            ]
        }),
    );
    let l = lint(&v, "L.excalidraw");
    assert!(kinds(&l).contains(&"label-over-label"), "{l:?}");
    // lint writes nothing
    let before = std::fs::read(v.path("L.excalidraw")).unwrap();
    lint(&v, "L.excalidraw");
    assert_eq!(std::fs::read(v.path("L.excalidraw")).unwrap(), before);
}

#[test]
fn lint_finds_text_that_overflows_its_box_and_a_stray_box_in_a_zone() {
    let v = Vaults::new();
    create(
        &v,
        D,
        &json!({"nodes": [
        {"id": "a", "text": "A", "x": 0, "y": 0},
        {"id": "b", "text": "B", "x": 200, "y": 0},
        {"id": "far", "text": "Far", "x": 1000, "y": 0}
    ], "zones": [{"id": "z", "label": "Z", "nodes": ["a"]}]}),
    );
    // a hand edit that shrinks the box under its text: a text overflow
    let path = v.path(D);
    let mut scene: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for e in scene["elements"].as_array_mut().unwrap() {
        if e["customData"]["writerId"] == "far" {
            e["width"] = json!(40);
        }
        // the zone grows over b, which is not a member
        if e["customData"]["writerId"] == "z" {
            e["width"] = json!(500);
        }
    }
    std::fs::write(&path, serde_json::to_string_pretty(&scene).unwrap()).unwrap();
    let findings = lint(&v, D);
    let ks = kinds(&findings);
    assert!(ks.contains(&"text-overflow"), "{findings:?}");
    assert!(ks.contains(&"zone-contains-box"), "{findings:?}");
    let o = findings
        .iter()
        .find(|f| f["kind"] == "text-overflow")
        .unwrap();
    assert_eq!(o["ids"], json!(["far"]));
}

// ---------- the round trip ----------

fn rich_spec() -> Value {
    json!({
        "nodes": [
            {"id": "web", "text": "Web app", "x": 0, "y": 0, "w": 160, "h": 70, "color": "blue", "link": "[[Web]]"},
            {"id": "api", "text": "Public API with a long name that wraps", "x": 300, "y": 0, "w": 220, "h": 110,
             "fill": "#ffeeaa", "stroke": "red", "strokeStyle": "dashed", "fontSize": 18},
            {"id": "db", "text": "Database", "shape": "ellipse", "x": 650, "y": 200, "w": 190, "h": 100, "color": "green"},
            {"id": "note", "text": "Planned", "shape": "text", "x": 0, "y": 250}
        ],
        "edges": [
            ["web", "api", "https"],
            {"from": "api", "to": "db", "style": "dotted", "color": "purple", "bidirectional": true,
             "fromSide": "right", "toSide": "top", "route": "elbow"},
            {"from": "db", "to": "web", "label": "sync", "labelAt": 0.25, "style": "dashed"}
        ],
        "zones": [{"id": "cloud", "label": "Cloud", "nodes": ["api", "db"], "color": "orange", "padding": 50}],
        "groups": [{"id": "g1", "nodes": ["web", "note"]}],
        "legend": ["Orange: cloud", "Open: caching"]
    })
}

#[test]
fn create_from_what_read_prints_reproduces_the_same_spec() {
    let v = Vaults::new();
    for (i, path) in ["R1.excalidraw", "R1.excalidraw.md"]
        .into_iter()
        .enumerate()
    {
        create(&v, path, &rich_spec());
        let first = read(&v, path);
        // the first read keeps what was asked for
        assert_eq!(first["zones"][0]["nodes"], json!(["api", "db"]), "{i}");
        assert_eq!(first["legend"], json!(["Orange: cloud", "Open: caching"]));
        let copy = format!("R2-{i}.excalidraw");
        create(&v, &copy, &first);
        assert_eq!(read(&v, &copy), first, "{path}");
        let scene = v.scene(&copy);
        validate_scene(&scene).unwrap();
        // and once more, through a file and the read's own text
        std::fs::write(
            v.path("spec.json"),
            serde_json::to_string_pretty(&first).unwrap(),
        )
        .unwrap();
        let again = format!("R3-{i}.excalidraw");
        v.ok(&[
            "excalidraw:create",
            &format!("path={again}"),
            "spec=@spec.json",
        ]);
        assert_eq!(read(&v, &again), first);
    }
}

#[test]
fn read_json_has_the_path_the_title_and_the_link_targets() {
    let v = Vaults::new();
    create(&v, "Diagrams/Arch Overview.excalidraw.md", &rich_spec());
    let out: Value = serde_json::from_str(&v.ok(&[
        "excalidraw:read",
        "path=Diagrams/Arch Overview.excalidraw.md",
        "format=json",
    ]))
    .unwrap();
    assert_eq!(out["path"], "Diagrams/Arch Overview.excalidraw.md");
    assert_eq!(out["title"], "Arch Overview");
    assert_eq!(out["links"], json!(["Web"]));
    assert_eq!(
        out["spec"],
        read(&v, "Diagrams/Arch Overview.excalidraw.md")
    );
    let err = v.run(&[
        "excalidraw:read",
        "path=Diagrams/Arch Overview.excalidraw.md",
        "format=yaml",
    ]);
    assert_eq!(err.code, EXIT_USAGE);
}

#[test]
fn a_drawing_with_links_stays_readable_by_the_plugin_in_the_markdown_file() {
    let v = Vaults::new();
    create(
        &v,
        "L.excalidraw.md",
        &json!({"nodes": [
            {"id": "a", "text": "A", "link": "[[Note]]"},
            {"id": "b", "text": "B", "link": "[[Other]]"},
            {"id": "c", "text": "C"}
        ]}),
    );
    let text = std::fs::read_to_string(v.path("L.excalidraw.md")).unwrap();
    let section = text
        .split(
            "## Element Links
",
        )
        .nth(1)
        .expect("the plugin's section");
    let entries: Vec<&str> = section
        .split(
            "

",
        )
        .take_while(|e| !e.starts_with("%%"))
        .collect();
    assert_eq!(entries.len(), 2, "{section}");
    for (e, link) in entries.iter().zip(["[[Note]]", "[[Other]]"]) {
        let (id, l) = e.split_once(": ").unwrap();
        assert_eq!(
            id.len(),
            8,
            "the plugin matches an eight-character id: {id}"
        );
        assert_eq!(l, link);
    }
    // the ids in the scene are the same short ones, and a later edit keeps the section in step
    let s = v.scene("L.excalidraw.md");
    assert!(els(&s)
        .iter()
        .filter(|e| e["link"].is_string())
        .all(|e| e["id"].as_str().unwrap().len() == 8));
    v.ok(&[
        "excalidraw:update",
        "path=L.excalidraw.md",
        &spec_arg(&json!({"nodes": [{"id": "a", "link": ""}, {"id": "c", "link": "[[Third]]"}]})),
    ]);
    let text = std::fs::read_to_string(v.path("L.excalidraw.md")).unwrap();
    assert!(
        text.contains("[[Other]]") && text.contains("[[Third]]") && !text.contains("[[Note]]"),
        "{text}"
    );
    v.ok(&[
        "excalidraw:update",
        "path=L.excalidraw.md",
        &spec_arg(&json!({"nodes": [{"id": "b", "link": ""}, {"id": "c", "link": ""}]})),
    ]);
    assert!(!std::fs::read_to_string(v.path("L.excalidraw.md"))
        .unwrap()
        .contains("Element Links"));
    validate_scene(&v.scene("L.excalidraw.md")).unwrap();
}

/// A small deterministic generator (the property test needs no dependency).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

/// A random but valid spec: boxes of every shape and style, arrows of every kind between them,
/// zones over disjoint runs of boxes, a legend.
fn random_spec(rng: &mut Rng) -> Value {
    let n = 2 + rng.below(6);
    let words = [
        "gateway",
        "queue",
        "worker pool",
        "cache",
        "metrics",
        "a longer name that wraps",
    ];
    let mut nodes = Vec::new();
    for i in 0..n {
        let mut node = json!({
            "id": format!("n{i}"),
            "text": rng.pick(&words),
            "shape": rng.pick(&["rectangle", "ellipse", "diamond"]),
        });
        match rng.below(4) {
            0 => node["color"] = json!(rng.pick(&["blue", "green", "red", "purple"])),
            1 => {
                node["fill"] = json!(rng.pick(&["yellow", "#ccddee", "gray"]));
                node["stroke"] = json!(rng.pick(&["red", "#112233"]));
            }
            _ => {}
        }
        if rng.below(3) == 0 {
            node["strokeStyle"] = json!(rng.pick(&["dashed", "dotted"]));
        }
        if rng.below(3) == 0 {
            node["fontSize"] = json!(14 + rng.below(3) * 4);
        }
        if rng.below(3) == 0 {
            node["link"] = json!(format!("[[Note {i}]]"));
        }
        if rng.below(2) == 0 {
            node["w"] = json!(220 + rng.below(3) * 40);
        }
        node["x"] = json!((i % 3) * 420);
        node["y"] = json!((i / 3) * 260);
        nodes.push(node);
    }
    let mut edges = Vec::new();
    for _ in 0..rng.below(2 * n) {
        let (a, b) = (rng.below(n), rng.below(n));
        if a == b {
            continue;
        }
        let mut e = json!({"from": format!("n{a}"), "to": format!("n{b}")});
        if rng.below(2) == 0 {
            e["label"] = json!(rng.pick(&["calls", "publishes", "reads"]));
        }
        if rng.below(3) == 0 {
            e["style"] = json!(rng.pick(&["dashed", "dotted"]));
        }
        if rng.below(4) == 0 {
            e["bidirectional"] = json!(true);
        }
        if e.get("label").is_some() && rng.below(3) == 0 {
            e["labelAt"] = json!([0.25, 0.75][rng.below(2)]);
        }
        if rng.below(3) == 0 {
            e["route"] = json!("elbow");
        }
        if rng.below(3) == 0 {
            e["fromSide"] = json!(rng.pick(&["top", "right", "bottom", "left"]));
            e["toSide"] = json!(rng.pick(&["top", "right", "bottom", "left"]));
        }
        edges.push(e);
    }
    let mut spec = json!({"nodes": nodes, "edges": edges});
    if n >= 4 && rng.below(2) == 0 {
        spec["zones"] = json!([
            {"id": "z1", "label": "First", "nodes": ["n0", "n1"], "color": "blue"},
            {"id": "z2", "label": "Second", "nodes": ["n2", "n3"], "padding": 25}
        ]);
    }
    if rng.below(2) == 0 {
        spec["legend"] = json!(["Key: dashed means planned", "Open: owner unknown"]);
    }
    spec
}

#[test]
fn any_spec_read_back_and_created_again_reads_back_the_same() {
    let v = Vaults::new();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for i in 0..40 {
        let spec = random_spec(&mut rng);
        let md = i % 2 == 0;
        let path = format!("P{i}.excalidraw{}", if md { ".md" } else { "" });
        let made = v.run(&[
            "excalidraw:create",
            &format!("path={path}"),
            &spec_arg(&spec),
        ]);
        assert_eq!(made.code, EXIT_OK, "{spec}: {}", made.stderr);
        validate_scene(&v.scene(&path)).unwrap_or_else(|e| panic!("{spec}: {e}"));
        let first = read(&v, &path);
        let copy = format!("C{i}.excalidraw");
        let again = v.run(&[
            "excalidraw:create",
            &format!("path={copy}"),
            &spec_arg(&first),
        ]);
        assert_eq!(again.code, EXIT_OK, "{first}: {}", again.stderr);
        assert_eq!(read(&v, &copy), first, "{spec}");
        // lint never fails on what the commands made
        let _ = lint(&v, &path);
    }
}
