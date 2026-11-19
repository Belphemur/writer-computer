//! `writer excalidraw:update` through the real argument parser on a synthetic vault: every field,
//! moves (arrows and labels follow), removals (a box takes its arrows with it), unknown ids,
//! and the rule that what is not named stays byte for byte, in both encodings.

use super::*;

const D: &str = "D.excalidraw.md";

fn update(v: &Vaults, path: &str, spec: Value) -> String {
    v.ok(&[
        "excalidraw:update",
        &format!("path={path}"),
        &spec_arg(&spec),
    ])
}

fn node(scene: &Value, key: &str) -> Value {
    md::elements(scene)
        .iter()
        .find(|e| e["customData"]["writerId"] == key && !md::is_deleted(e))
        .unwrap_or_else(|| panic!("no node {key}"))
        .clone()
}

fn by_id(scene: &Value, id: &str) -> Option<Value> {
    md::elements(scene).iter().find(|e| e["id"] == id).cloned()
}

/// The label text bound to `container`.
fn label(scene: &Value, container: &Value) -> Option<String> {
    md::elements(scene)
        .iter()
        .find(|t| t["type"] == "text" && t["containerId"] == container["id"])
        .map(|t| t["originalText"].as_str().unwrap().to_string())
}

fn arrows(scene: &Value) -> Vec<Value> {
    md::elements(scene)
        .iter()
        .filter(|e| e["type"] == "arrow")
        .cloned()
        .collect()
}

fn three_boxes(v: &Vaults, path: &str) {
    v.ok(&[
        "excalidraw:create",
        &format!("path={path}"),
        &spec_arg(&json!({
            "nodes": [
                {"id": "api", "text": "API"},
                {"id": "db", "text": "Database"},
                {"id": "cache", "text": "Cache"}
            ],
            "edges": [["api", "db", "reads"], ["api", "cache"]]
        })),
    ]);
}

#[test]
fn text_color_and_shape_change_one_box_and_bump_only_what_changed() {
    let v = Vaults::new();
    three_boxes(&v, D);
    let before = v.scene(D);
    let out = update(
        &v,
        D,
        json!({"nodes": [{"id": "db", "text": "Primary database", "color": "green", "shape": "diamond"}]}),
    );
    assert_eq!(out, "Updated 1 box in D.excalidraw.md\n");
    let after = v.scene(D);
    validate_scene(&after).unwrap();
    let db = node(&after, "db");
    assert_eq!(db["type"], "diamond");
    assert_eq!(db["strokeColor"], "#2f9e44");
    assert_eq!(db["backgroundColor"], "#b2f2bb");
    assert_eq!(label(&after, &db).as_deref(), Some("Primary database"));
    let t = md::elements(&after)
        .iter()
        .find(|t| t["containerId"] == db["id"])
        .unwrap()
        .clone();
    assert_eq!(t["strokeColor"], "#2f9e44");
    assert_eq!(
        db["version"].as_u64().unwrap(),
        node(&before, "db")["version"].as_u64().unwrap() + 1
    );
    // the box grew to fit, never shrank
    assert!(db["width"].as_f64().unwrap() >= node(&before, "db")["width"].as_f64().unwrap());
    // the other box and its label are exactly as they were
    assert_eq!(node(&after, "cache"), node(&before, "cache"));
    let cache = node(&before, "cache");
    assert_eq!(
        by_id(&after, cache["boundElements"][0]["id"].as_str().unwrap()),
        by_id(&before, cache["boundElements"][0]["id"].as_str().unwrap())
    );
    assert_eq!(read_spec(&after)["nodes"].as_array().unwrap().len(), 3);
}

#[test]
fn an_empty_text_clears_the_label_and_text_on_an_unlabelled_box_adds_one() {
    let v = Vaults::new();
    v.ok(&[
        "excalidraw:create",
        &format!("path={D}"),
        &spec_arg(&json!({"nodes": [{"id": "a", "text": "A"}, {"id": "b"}]})),
    ]);
    update(
        &v,
        D,
        json!({"nodes": [{"id": "a", "text": ""}, {"id": "b", "text": "Now labelled"}]}),
    );
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    assert_eq!(label(&s, &node(&s, "a")), None);
    assert_eq!(node(&s, "a")["boundElements"], Value::Null);
    assert_eq!(label(&s, &node(&s, "b")).as_deref(), Some("Now labelled"));
}

#[test]
fn a_move_takes_the_label_arrows_and_their_labels_along() {
    let v = Vaults::new();
    three_boxes(&v, D);
    let before = v.scene(D);
    update(&v, D, json!({"nodes": [{"id": "db", "x": 900, "y": 400}]}));
    let after = v.scene(D);
    validate_scene(&after).unwrap();
    let db = node(&after, "db");
    assert_eq!(
        (db["x"].as_f64(), db["y"].as_f64()),
        (Some(900.0), Some(400.0))
    );
    // the label stays centred in its box
    let t = md::elements(&after)
        .iter()
        .find(|t| t["containerId"] == db["id"])
        .unwrap()
        .clone();
    let c = |e: &Value| {
        (
            e["x"].as_f64().unwrap() + e["width"].as_f64().unwrap() / 2.0,
            e["y"].as_f64().unwrap() + e["height"].as_f64().unwrap() / 2.0,
        )
    };
    let (tc, bc) = (c(&t), c(&db));
    assert!((tc.0 - bc.0).abs() < 1.0 && (tc.1 - bc.1).abs() < 1.0);
    // the arrow api -> db ends at the new place, and its label sits mid-arrow
    let api = node(&after, "api");
    let arrow = arrows(&after)
        .into_iter()
        .find(|a| a["endBinding"]["elementId"] == db["id"])
        .unwrap();
    let end = (
        arrow["x"].as_f64().unwrap() + arrow["points"][1][0].as_f64().unwrap(),
        arrow["y"].as_f64().unwrap() + arrow["points"][1][1].as_f64().unwrap(),
    );
    assert!(
        end.0 > 880.0 && end.0 < 920.0 + db["width"].as_f64().unwrap(),
        "{end:?}"
    );
    assert_eq!(arrow["startBinding"]["elementId"], api["id"]);
    let arrow_label = md::elements(&after)
        .iter()
        .find(|t| t["containerId"] == arrow["id"])
        .unwrap()
        .clone();
    let mid = (
        arrow["x"].as_f64().unwrap() + arrow["points"][1][0].as_f64().unwrap() / 2.0,
        arrow["y"].as_f64().unwrap() + arrow["points"][1][1].as_f64().unwrap() / 2.0,
    );
    let lc = c(&arrow_label);
    assert!((lc.0 - mid.0).abs() < 1.0 && (lc.1 - mid.1).abs() < 1.0);
    // an arrow nowhere near db did not move: api -> cache is byte for byte
    let untouched = |scene: &Value| {
        arrows(scene)
            .into_iter()
            .find(|a| a["endBinding"]["elementId"] == node(scene, "cache")["id"])
            .unwrap()
    };
    assert_eq!(untouched(&after), untouched(&before));
    assert_eq!(node(&after, "cache"), node(&before, "cache"));
}

#[test]
fn a_size_that_fits_resizes_and_one_that_does_not_is_refused() {
    let v = Vaults::new();
    three_boxes(&v, D);
    update(&v, D, json!({"nodes": [{"id": "api", "w": 300, "h": 140}]}));
    let api = node(&v.scene(D), "api");
    assert_eq!(
        (api["width"].as_f64(), api["height"].as_f64()),
        (Some(300.0), Some(140.0))
    );
    let before = std::fs::read(v.path(D)).unwrap();
    let err = v.fail(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"nodes": [{"id": "api", "w": 10}]})),
    ]);
    assert!(
        err.contains("api") && err.contains("needs at least"),
        "{err}"
    );
    assert_eq!(std::fs::read(v.path(D)).unwrap(), before);
}

#[test]
fn arrows_are_relabelled_cleared_recoloured_and_given_a_first_label() {
    let v = Vaults::new();
    three_boxes(&v, D);
    update(
        &v,
        D,
        json!({"edges": [
            {"from": "api", "to": "db", "label": "queries", "color": "red"},
            ["api", "cache", "hits"]
        ]}),
    );
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let spec = read_spec(&s);
    let edges = spec["edges"].as_array().unwrap();
    assert!(
        edges.contains(&json!({"from": "api", "to": "db", "label": "queries", "color": "red"})),
        "{edges:?}"
    );
    assert!(
        edges.contains(&json!(["api", "cache", "hits"])),
        "{edges:?}"
    );
    let db_arrow = arrows(&s)
        .into_iter()
        .find(|a| a["endBinding"]["elementId"] == node(&s, "db")["id"])
        .unwrap();
    assert_eq!(db_arrow["strokeColor"], "#e03131");
    let l = md::elements(&s)
        .iter()
        .find(|t| t["containerId"] == db_arrow["id"])
        .unwrap()
        .clone();
    assert_eq!(l["strokeColor"], "#e03131");
    // an empty label clears it
    update(&v, D, json!({"edges": [["api", "db", ""]]}));
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    assert!(read_spec(&s)["edges"]
        .as_array()
        .unwrap()
        .contains(&json!({"from": "api", "to": "db", "color": "red"})));
}

#[test]
fn removing_a_box_takes_its_label_and_arrows_and_tells_the_boxes_on_the_other_end() {
    let v = Vaults::new();
    three_boxes(&v, D);
    let before = v.scene(D);
    let out = update(&v, D, json!({"remove": {"nodes": ["db"]}}));
    assert_eq!(out, "Removed 1 box, removed 1 arrow in D.excalidraw.md\n");
    let after = v.scene(D);
    validate_scene(&after).unwrap();
    let spec = read_spec(&after);
    let ids: Vec<&str> = spec["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["api", "cache"]);
    assert_eq!(spec["edges"], json!([["api", "cache"]]));
    // nothing of it is left: not the box, its label, the arrow or the arrow's label
    let db = node(&before, "db");
    let gone: Vec<&str> = md::elements(&before)
        .iter()
        .filter(|e| {
            e["id"] == db["id"]
                || e["containerId"] == db["id"]
                || e["endBinding"]["elementId"] == db["id"]
        })
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert!(gone.len() >= 3);
    for id in gone {
        assert!(by_id(&after, id).is_none(), "{id} should be gone");
    }
    // api lost an arrow: it moved on; cache and its arrow are as they were
    let api = node(&after, "api");
    assert_eq!(
        api["version"].as_u64().unwrap(),
        node(&before, "api")["version"].as_u64().unwrap() + 1
    );
    assert_eq!(node(&after, "cache"), node(&before, "cache"));
}

#[test]
fn removing_an_arrow_leaves_both_boxes() {
    let v = Vaults::new();
    three_boxes(&v, D);
    let out = update(&v, D, json!({"remove": {"edges": [["api", "db"]]}}));
    assert_eq!(out, "Removed 1 arrow in D.excalidraw.md\n");
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    let spec = read_spec(&s);
    assert_eq!(spec["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(spec["edges"], json!([["api", "cache"]]));
    // the direction matters: db -> api is no arrow
    let err = v.fail(&[
        "excalidraw:update",
        &format!("path={D}"),
        &spec_arg(&json!({"remove": {"edges": [["db", "api"]]}})),
    ]);
    assert!(err.contains("no arrow db -> api"), "{err}");
}

#[test]
fn an_unknown_id_names_it_and_a_refused_update_writes_nothing() {
    let v = Vaults::new();
    three_boxes(&v, D);
    let before = std::fs::read(v.path(D)).unwrap();
    for (spec, needle) in [
        (
            json!({"nodes": [{"id": "ghost", "text": "x"}]}),
            "no node ghost",
        ),
        (json!({"remove": {"nodes": ["ghost"]}}), "no node ghost"),
        (json!({"edges": [["api", "ghost", "x"]]}), "no node ghost"),
        (
            json!({"edges": [["db", "cache", "x"]]}),
            "no arrow db -> cache",
        ),
        (
            json!({"edges": [["api", "db"]]}),
            "give a label, color, style",
        ),
        (
            json!({"nodes": [{"id": "api", "color": "mauve"}]}),
            "unknown color mauve",
        ),
        (json!({"nodes": [{"id": "api", "x": 5}]}), "both x and y"),
        (
            json!({"nodes": [{"id": "api", "shape": "text"}]}),
            "cannot become a text",
        ),
        (json!({"direction": "TB"}), "direction, groups and legend"),
        // a good change first, then a bad one: all or nothing
        (
            json!({"nodes": [{"id": "api", "text": "Fine"}, {"id": "nope"}]}),
            "no node nope",
        ),
    ] {
        let err = v.fail(&["excalidraw:update", &format!("path={D}"), &spec_arg(&spec)]);
        assert!(err.contains(needle), "{spec}: {err}");
        assert_eq!(std::fs::read(v.path(D)).unwrap(), before, "{spec}");
    }
    // `remove` is not for create or add
    let err = v.fail(&[
        "excalidraw:add",
        &format!("path={D}"),
        &spec_arg(&json!({"remove": {"nodes": ["api"]}})),
    ]);
    assert!(err.contains("only for update"), "{err}");
    assert_eq!(std::fs::read(v.path(D)).unwrap(), before);
    // a usage error without a spec, and a file that is not a drawing
    assert_eq!(
        v.run(&["excalidraw:update", &format!("path={D}")]).code,
        EXIT_USAGE
    );
    assert!(v
        .fail(&["excalidraw:update", "path=Note.md", "spec={}"])
        .contains("not a drawing"));
}

#[test]
fn add_takes_a_size_and_an_arrow_colour_too() {
    let v = Vaults::new();
    v.ok(&[
        "excalidraw:create",
        &format!("path={D}"),
        &spec_arg(&json!({
            "nodes": [{"id": "a", "text": "A", "w": 300, "h": 100}, {"id": "b", "text": "B"}],
            "edges": [{"from": "a", "to": "b", "color": "purple"}]
        })),
    ]);
    let s = v.scene(D);
    validate_scene(&s).unwrap();
    assert_eq!(node(&s, "a")["width"], 300.0);
    assert_eq!(arrows(&s)[0]["strokeColor"], "#6741d9");
}

fn bytes_of_untouched(before: &Value, after: &Value, except: &[&str]) {
    for e in md::elements(before) {
        let id = e["id"].as_str().unwrap();
        if except.contains(&id) {
            continue;
        }
        assert_eq!(by_id(after, id).as_ref(), Some(e), "{id} changed");
    }
}

#[test]
fn an_update_keeps_the_users_other_elements_and_an_obsidian_files_sections() {
    let v = Vaults::new();
    let fixture = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/excalidraw-fixtures/unknown-sections.excalidraw.md"),
    )
    .unwrap();
    std::fs::write(v.path("S.excalidraw.md"), &fixture).unwrap();
    // give the user's file a box of ours to change, then change only that
    v.ok(&[
        "excalidraw:add",
        "path=S.excalidraw.md",
        &spec_arg(&json!({"nodes": [{"id": "n", "text": "Added"}, {"id": "m", "text": "Other"}], "edges": [["n", "m"]]})),
    ]);
    let before = v.scene("S.excalidraw.md");
    let text_before = std::fs::read_to_string(v.path("S.excalidraw.md")).unwrap();
    update(
        &v,
        "S.excalidraw.md",
        json!({"nodes": [{"id": "n", "text": "Renamed"}], "remove": {"edges": [["n", "m"]]}}),
    );
    let after = v.scene("S.excalidraw.md");
    validate_scene(&after).unwrap();
    let n = node(&before, "n");
    let m = node(&before, "m");
    let touched: Vec<&str> = md::elements(&before)
        .iter()
        .filter(|e| {
            e["customData"]["writerId"] == "n"
                || e["containerId"] == n["id"]
                || e["type"] == "arrow" && e["startBinding"]["elementId"] == n["id"]
                || e["containerId"]
                    .as_str()
                    .is_some_and(|c| arrows(&before).iter().any(|a| a["id"] == c))
        })
        .map(|e| e["id"].as_str().unwrap())
        .chain([m["id"].as_str().unwrap()])
        .collect();
    bytes_of_untouched(&before, &after, &touched);
    // the image the spec cannot express is still counted and still on disk
    assert_eq!(read_spec(&after)["other"]["image"], 1);
    let out = std::fs::read_to_string(v.path("S.excalidraw.md")).unwrap();
    let head = |t: &str| t[..t.find("## Text Elements").unwrap()].to_string();
    assert_eq!(head(&out), head(&text_before));
    assert!(
        out.contains("## Reviewer comments\nKeep this line exactly, with trailing spaces:   \n")
    );
    assert!(out.contains("f1e2d3c4b5a6978877665544: [[attachments/pic.png]]"));
    assert!(out.contains("Renamed ^") && !out.contains("Added ^"));
}

#[test]
fn a_compressed_drawing_and_a_plain_excalidraw_file_both_update() {
    let v = Vaults::new();
    let fixture = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/excalidraw-fixtures/compressed.excalidraw.md"),
    )
    .unwrap();
    std::fs::write(v.path("C.excalidraw.md"), &fixture).unwrap();
    let before = v.scene("C.excalidraw.md");
    v.ok(&[
        "excalidraw:add",
        "path=C.excalidraw.md",
        &spec_arg(&json!({"nodes": [{"id": "z", "text": "Zed"}]})),
    ]);
    update(
        &v,
        "C.excalidraw.md",
        json!({"nodes": [{"id": "z", "text": "Zee", "color": "blue"}]}),
    );
    let after = v.scene("C.excalidraw.md");
    validate_scene(&after).unwrap();
    assert_eq!(label(&after, &node(&after, "z")).as_deref(), Some("Zee"));
    bytes_of_untouched(&before, &after, &[]);
    let text = std::fs::read_to_string(v.path("C.excalidraw.md")).unwrap();
    assert!(text.contains("```compressed-json"), "stays compressed");

    v.ok(&[
        "excalidraw:create",
        "path=P.excalidraw",
        &spec_arg(&two_boxes()),
    ]);
    update(
        &v,
        "P.excalidraw",
        json!({"nodes": [{"id": "api", "text": "Gateway"}], "remove": {"nodes": ["db"]}}),
    );
    let s = v.scene("P.excalidraw");
    validate_scene(&s).unwrap();
    assert_eq!(label(&s, &node(&s, "api")).as_deref(), Some("Gateway"));
    assert_eq!(read_spec(&s)["nodes"].as_array().unwrap().len(), 1);
    assert!(std::fs::read_to_string(v.path("P.excalidraw"))
        .unwrap()
        .trim_start()
        .starts_with('{'));
}
