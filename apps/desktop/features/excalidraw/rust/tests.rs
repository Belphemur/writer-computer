//! The feature as a whole: what its manifest says against what it contributes, the skill folder
//! against the bundled files, every example of the skill built into a valid drawing, the five
//! `writer excalidraw:*` commands through the real argument parser on a synthetic vault, and the
//! socket command against a fake window.

use super::*;
use crate::cli::{execute, Env, SystemClipboard, EXIT_FAIL, EXIT_NOT_RUNNING, EXIT_OK, EXIT_USAGE};
use crate::features::Manifest;
use crate::ipc::registry::Vault;
use crate::ipc::{Call, ErrorCode, Host, IpcError};
use elements::{read_spec, validate_scene};
use excalidraw_md as md;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

const MANIFEST: &str = include_str!("../feature.json");

fn manifest_json() -> Value {
    serde_json::from_str(MANIFEST).unwrap()
}

struct Vaults {
    vault: TempDir,
    data: TempDir,
}

impl Vaults {
    fn new() -> Vaults {
        let v = Vaults {
            vault: TempDir::new().unwrap(),
            data: TempDir::new().unwrap(),
        };
        std::fs::write(v.vault.path().join("Note.md"), "# Note\n").unwrap();
        std::fs::create_dir_all(v.vault.path().join(".obsidian")).unwrap();
        v
    }

    fn run(&self, line: &[&str]) -> crate::cli::Outcome {
        let env = Env {
            app_data_dir: Some(self.data.path().to_path_buf()),
            clipboard: Box::new(SystemClipboard),
            utc_offset_minutes: 0,
            launcher: Box::new(crate::writer_cli::SystemLauncher),
            launch_wait: std::time::Duration::ZERO,
        };
        let argv: Vec<String> = line.iter().map(|s| s.to_string()).collect();
        execute(&argv, self.vault.path(), &env)
    }

    fn ok(&self, line: &[&str]) -> String {
        let o = self.run(line);
        assert_eq!(o.code, EXIT_OK, "{line:?}: {}", o.stderr);
        o.stdout
    }

    fn fail(&self, line: &[&str]) -> String {
        let o = self.run(line);
        assert_eq!(o.code, EXIT_FAIL, "{line:?}: {}", o.stdout);
        o.stderr
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.vault.path().join(rel)
    }

    fn scene(&self, rel: &str) -> Value {
        let text = std::fs::read_to_string(self.path(rel)).unwrap();
        md::parse(&text, md::format_of(rel).unwrap()).unwrap().scene
    }
}

fn spec_arg(json: &Value) -> String {
    format!("spec={json}")
}

// ---------- the contribution ----------

#[test]
fn the_manifest_names_exactly_what_the_feature_contributes() {
    let raw = manifest_json();
    let strings = |v: &Value| -> BTreeSet<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    };
    let cli: BTreeSet<String> = cli::COMMANDS.iter().map(|c| c.name.to_string()).collect();
    assert_eq!(strings(&raw["rust"]["cliCommands"]), cli);
    assert!(cli::COMMANDS
        .iter()
        .all(|c| c.feature == Some("excalidraw") && c.group == "Excalidraw"));
    let ipc: BTreeSet<String> = ipc::COMMANDS.iter().map(|c| c.name.to_string()).collect();
    assert_eq!(strings(&raw["rust"]["ipcCommands"]), ipc);
    let skills: BTreeSet<String> = SKILLS.iter().map(|s| s.name.to_string()).collect();
    assert_eq!(strings(&raw["rust"]["skills"]), skills);
    let m: Manifest = serde_json::from_str(MANIFEST).unwrap();
    assert_eq!(m.id, "excalidraw");
    assert!(
        m.rust.commands.is_empty(),
        "no Tauri command: no plugin and no capability file"
    );
}

fn skill_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../features/excalidraw/skills")
}

#[test]
fn the_skill_folder_and_the_bundled_files_are_the_same_set() {
    fn collect(dir: &Path, base: &Path, out: &mut BTreeSet<String>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                collect(&p, base, out);
            } else {
                out.insert(
                    p.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let mut on_disk = BTreeSet::new();
    collect(&skill_dir(), &skill_dir(), &mut on_disk);
    let bundled: BTreeSet<String> = SKILLS
        .iter()
        .flat_map(|s| s.files.iter().map(move |f| format!("{}/{}", s.name, f.rel)))
        .collect();
    assert_eq!(on_disk, bundled);
    assert!(SKILLS.iter().all(|s| s.files[0].rel == "SKILL.md"));
}

/// The fenced ```spec blocks of a skill file: (is_add, JSON).
/// The command each kind of example block runs with: ```spec` creates, ```spec add` adds to and
/// ```spec update` updates the drawing the block before it made.
fn spec_blocks(text: &str) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let info = line.strip_prefix("```").unwrap_or("").trim();
        let command = match info {
            "spec" => "excalidraw:create",
            "spec add" => "excalidraw:add",
            "spec update" => "excalidraw:update",
            _ => continue,
        };
        let body: Vec<&str> = lines
            .by_ref()
            .take_while(|l| !l.starts_with("```"))
            .collect();
        out.push((command, body.join("\n")));
    }
    out
}

#[test]
fn every_example_spec_in_the_skill_builds_a_valid_drawing() {
    let mut built = 0;
    for file in ["SKILL.md", "references/examples.md"] {
        let text =
            std::fs::read_to_string(skill_dir().join("writer-excalidraw").join(file)).unwrap();
        let blocks = spec_blocks(&text);
        assert!(!blocks.is_empty(), "{file} has examples");
        let v = Vaults::new();
        let mut last: Option<String> = None;
        for (i, (command, body)) in blocks.iter().enumerate() {
            let spec: Value =
                serde_json::from_str(body).unwrap_or_else(|e| panic!("{file} #{i}: {e}"));
            let rel = if *command == "excalidraw:create" {
                format!("ex-{i}.excalidraw.md")
            } else {
                last.clone().expect(
                    "a `spec add` or `spec update` block follows the block that made the drawing",
                )
            };
            let path = format!("path={rel}");
            v.ok(&[command, &path, &spec_arg(&spec)]);
            let scene = v.scene(&rel);
            validate_scene(&scene).unwrap_or_else(|e| panic!("{file} #{i}: {e}"));
            let read = read_spec(&scene);
            let ids: BTreeSet<&str> = read["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n["id"].as_str().unwrap())
                .collect();
            for n in spec["nodes"].as_array().into_iter().flatten() {
                assert!(
                    ids.contains(n["id"].as_str().unwrap()),
                    "{file} #{i}: node {} is in the drawing",
                    n["id"]
                );
            }
            assert!(
                read["edges"].as_array().unwrap().len()
                    >= spec["edges"].as_array().map_or(0, Vec::len)
            );
            last = Some(rel);
            built += 1;
        }
    }
    assert!(built >= 7, "the skill teaches with examples: {built}");
}

// ---------- the commands ----------

fn two_boxes() -> Value {
    json!({
        "nodes": [{"id": "api", "text": "API"}, {"id": "db", "text": "Database", "shape": "ellipse", "color": "green"}],
        "edges": [["api", "db", "reads"]],
        "groups": [{"nodes": ["api", "db"]}]
    })
}

#[test]
fn create_keeps_ids_binds_arrows_and_reads_back() {
    let v = Vaults::new();
    let out = v.ok(&[
        "excalidraw:create",
        "path=Diagrams/Arch",
        &spec_arg(&two_boxes()),
    ]);
    assert_eq!(
        out,
        "Created Diagrams/Arch.excalidraw.md (2 boxes, 1 arrow)\n"
    );
    let scene = v.scene("Diagrams/Arch.excalidraw.md");
    validate_scene(&scene).unwrap();
    let els = md::elements(&scene);
    let kinds: Vec<&str> = els.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        ["rectangle", "text", "ellipse", "text", "arrow", "text"]
    );
    assert_eq!(els[0]["customData"]["writerId"], "api");
    let arrow = &els[4];
    assert_eq!(arrow["startBinding"]["elementId"], els[0]["id"]);
    assert_eq!(arrow["endBinding"]["elementId"], els[2]["id"]);
    assert!(els[0]["boundElements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["id"] == arrow["id"]));
    assert_eq!(els[0]["groupIds"], els[2]["groupIds"]);
    assert_eq!(
        els[0]["groupIds"], els[1]["groupIds"],
        "bound text joins its box's group"
    );

    let read: Value =
        serde_json::from_str(&v.ok(&["excalidraw:read", "path=Diagrams/Arch.excalidraw.md"]))
            .unwrap();
    assert_eq!(read["edges"], json!([["api", "db", "reads"]]));
    assert_eq!(read["nodes"][1]["text"], "Database");
    assert_eq!(read["nodes"][1]["color"], "green");
    assert_eq!(read["groups"][0]["nodes"], json!(["api", "db"]));

    // the file is the plugin's shape: front matter, text elements, drawing block
    let text = std::fs::read_to_string(v.path("Diagrams/Arch.excalidraw.md")).unwrap();
    assert!(text.starts_with("---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n"));
    assert!(text.contains("## Text Elements\nAPI ^"));
    assert!(text.contains("```compressed-json\n"));
    assert!(v
        .fail(&[
            "excalidraw:create",
            "path=Diagrams/Arch",
            &spec_arg(&two_boxes())
        ])
        .contains("already exists"));
    v.ok(&["excalidraw:create", "path=Diagrams/Arch", "overwrite"]);
    assert!(md::elements(&v.scene("Diagrams/Arch.excalidraw.md")).is_empty());
}

#[test]
fn boxes_without_a_position_never_overlap_and_a_given_one_stays() {
    let v = Vaults::new();
    let mut nodes: Vec<Value> = (0..12)
        .map(|i| json!({"id": format!("n{i}"), "text": format!("Step number {i} of the pipeline")}))
        .collect();
    nodes.push(json!({"id": "fixed", "text": "Pinned", "x": 500, "y": 40}));
    let edges: Vec<Value> = (0..11)
        .map(|i| json!([format!("n{i}"), format!("n{}", i + 1)]))
        .collect();
    v.ok(&[
        "excalidraw:create",
        "path=Flow",
        &spec_arg(&json!({"nodes": nodes, "edges": edges, "direction": "TB"})),
    ]);
    let scene = v.scene("Flow.excalidraw.md");
    let boxes: Vec<(f64, f64, f64, f64)> = md::elements(&scene)
        .iter()
        .filter(|e| e["type"] == "rectangle")
        .map(|e| {
            (
                e["x"].as_f64().unwrap(),
                e["y"].as_f64().unwrap(),
                e["width"].as_f64().unwrap(),
                e["height"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(boxes.len(), 13);
    for i in 0..boxes.len() {
        for j in i + 1..boxes.len() {
            let (a, b) = (boxes[i], boxes[j]);
            assert!(
                !(a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3),
                "{i} overlaps {j}"
            );
        }
    }
    let fixed = md::elements(&scene)
        .iter()
        .find(|e| e["customData"]["writerId"] == "fixed")
        .unwrap()
        .clone();
    assert_eq!(
        (fixed["x"].as_f64(), fixed["y"].as_f64()),
        (Some(500.0), Some(40.0))
    );
}

#[test]
fn add_leaves_what_is_there_alone_except_what_it_connects() {
    let v = Vaults::new();
    v.ok(&[
        "excalidraw:create",
        "path=D.excalidraw.md",
        &spec_arg(&two_boxes()),
    ]);
    let before = v.scene("D.excalidraw.md");
    let by_id = |scene: &Value, id: &str| {
        md::elements(scene)
            .iter()
            .find(|e| e["id"] == id)
            .cloned()
            .unwrap()
    };

    let out = v.ok(&[
        "excalidraw:add",
        "path=D.excalidraw.md",
        &spec_arg(&json!({
            "nodes": [{"id": "cache", "text": "Cache"}],
            "edges": [["api", "cache", "hits"]]
        })),
    ]);
    assert_eq!(out, "Added 1 box and 1 arrow to D.excalidraw.md\n");
    let after = v.scene("D.excalidraw.md");
    validate_scene(&after).unwrap();
    let old_ids: Vec<String> = md::elements(&before)
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_string())
        .collect();
    let untouched_ids: Vec<&String> = old_ids
        .iter()
        .filter(|id| {
            let b = by_id(&before, id);
            let a = by_id(&after, id);
            a == b
        })
        .collect();
    // every old element but the box that got a new arrow is exactly as it was
    assert_eq!(untouched_ids.len(), old_ids.len() - 1);
    let api_before = md::elements(&before)
        .iter()
        .find(|e| e["customData"]["writerId"] == "api")
        .unwrap()
        .clone();
    let api_after = by_id(&after, api_before["id"].as_str().unwrap());
    assert_eq!(
        api_after["version"].as_u64(),
        Some(api_before["version"].as_u64().unwrap() + 1)
    );
    assert_eq!(api_after["x"], api_before["x"]);
    // the new box is below everything that was drawn
    let cache = md::elements(&after)
        .iter()
        .find(|e| e["customData"]["writerId"] == "cache")
        .unwrap()
        .clone();
    assert!(
        cache["y"].as_f64().unwrap()
            > api_before["y"].as_f64().unwrap() + api_before["height"].as_f64().unwrap()
    );

    // an arrow between boxes that are both already drawn is an `add` with only edges
    v.ok(&[
        "excalidraw:add",
        "path=D.excalidraw.md",
        &spec_arg(&json!({"edges": [["cache", "db", "writes"]]})),
    ]);
    let read: Value = serde_json::from_str(&v.ok(&["excalidraw:read", "file=D.excalidraw"]))
        .unwrap_or_else(|_| {
            serde_json::from_str(&v.ok(&["excalidraw:read", "path=D.excalidraw.md"])).unwrap()
        });
    assert_eq!(read["edges"].as_array().unwrap().len(), 3);
    assert!(read["edges"]
        .as_array()
        .unwrap()
        .contains(&json!(["cache", "db", "writes"])));
    validate_scene(&v.scene("D.excalidraw.md")).unwrap();
}

#[test]
fn an_obsidian_drawing_keeps_its_sections_when_an_agent_adds_to_it() {
    let v = Vaults::new();
    let fixture = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/excalidraw-fixtures/unknown-sections.excalidraw.md"),
    )
    .unwrap();
    std::fs::write(v.path("Sketch.excalidraw.md"), &fixture).unwrap();
    v.ok(&[
        "excalidraw:add",
        "path=Sketch.excalidraw.md",
        &spec_arg(&json!({"nodes": [{"id": "n", "text": "Added"}]})),
    ]);
    let out = std::fs::read_to_string(v.path("Sketch.excalidraw.md")).unwrap();
    let head = |t: &str| t[..t.find("## Text Elements").unwrap()].to_string();
    assert_eq!(head(&out), head(&fixture));
    assert!(
        out.contains("## Reviewer comments\nKeep this line exactly, with trailing spaces:   \n")
    );
    assert!(out.contains("f1e2d3c4b5a6978877665544: [[attachments/pic.png]]"));
    assert!(out.contains("Added ^"));
    let read: Value =
        serde_json::from_str(&v.ok(&["excalidraw:read", "path=Sketch.excalidraw.md"])).unwrap();
    assert!(read["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["id"] == "n"));
    assert_eq!(
        read["other"]["image"], 1,
        "what a spec cannot say is counted, and kept"
    );
}

#[test]
fn a_plain_excalidraw_file_works_too() {
    let v = Vaults::new();
    v.ok(&[
        "excalidraw:create",
        "path=P.excalidraw",
        &spec_arg(&two_boxes()),
    ]);
    let text = std::fs::read_to_string(v.path("P.excalidraw")).unwrap();
    assert!(text.trim_start().starts_with('{') && !text.contains("## "));
    v.ok(&[
        "excalidraw:add",
        "path=P.excalidraw",
        &spec_arg(&json!({"edges": [["db", "api"]]})),
    ]);
    let scene = v.scene("P.excalidraw");
    validate_scene(&scene).unwrap();
    assert_eq!(read_spec(&scene)["edges"].as_array().unwrap().len(), 2);
}

#[test]
fn bad_input_is_refused_before_anything_is_written() {
    let v = Vaults::new();
    let create = |path: &str, spec: &Value| v.run(&["excalidraw:create", path, &spec_arg(spec)]);
    // outside the vault, or in a folder the app owns
    for bad in [
        "path=../escape.excalidraw.md",
        "path=.obsidian/x.excalidraw.md",
    ] {
        let o = create(bad, &two_boxes());
        assert_eq!(o.code, EXIT_FAIL, "{bad}: {}", o.stderr);
    }
    assert!(!v.path("../escape.excalidraw.md").exists());
    assert!(!v.path(".obsidian/x.excalidraw.md").exists());
    // a spec with a mistake names it
    for (spec, needle) in [
        (json!({"nodes": [{"id": "a"}, {"id": "a"}]}), "used twice"),
        (
            json!({"nodes": [{"id": "a", "color": "teal"}]}),
            "unknown color",
        ),
        (
            json!({"nodes": [{"id": "a", "shape": "star"}]}),
            "unknown shape",
        ),
        (json!({"nodes": [{"id": "a", "x": 1}]}), "both x and y"),
        (
            json!({"nodes": [{"id": "a"}], "edges": [["a", "zz"]]}),
            "no node zz",
        ),
        (
            json!({"nodes": [{"id": "a"}], "edges": [["a", "a"]]}),
            "point at itself",
        ),
        (
            json!({"nodes": [{"id": "a"}], "groups": [{"nodes": ["q"]}]}),
            "not one of the nodes",
        ),
        (json!({"direction": "up"}), "LR or TB"),
    ] {
        let o = create("path=Bad", &spec);
        assert_eq!(o.code, EXIT_FAIL, "{spec}: {}", o.stderr);
        assert!(o.stderr.contains(needle), "{spec}: {}", o.stderr);
        assert!(!v.path("Bad.excalidraw.md").exists(), "{spec}");
    }
    let o = v.run(&["excalidraw:create", "path=Bad", "spec={\"nodez\":[]}"]);
    assert_eq!(o.code, EXIT_USAGE);
    assert!(o.stderr.contains("not valid"));
    // a note is not a drawing; a node that exists cannot be added again
    assert!(v
        .fail(&["excalidraw:read", "path=Note.md"])
        .contains("not a drawing"));
    v.ok(&["excalidraw:create", "path=D", &spec_arg(&two_boxes())]);
    assert!(v
        .fail(&[
            "excalidraw:add",
            "path=D.excalidraw.md",
            &spec_arg(&json!({"nodes": [{"id": "api"}]}))
        ])
        .contains("already exists"));
    assert!(v
        .fail(&[
            "excalidraw:add",
            "path=D.excalidraw.md",
            &spec_arg(&json!({"edges": [["api", "nope"]]}))
        ])
        .contains("no node nope"));
    let before = std::fs::read(v.path("D.excalidraw.md")).unwrap();
    v.run(&[
        "excalidraw:add",
        "path=D.excalidraw.md",
        &spec_arg(&json!({"nodes": [{"id": "x"}], "edges": [["x", "ghost"]]})),
    ]);
    assert_eq!(
        std::fs::read(v.path("D.excalidraw.md")).unwrap(),
        before,
        "a refused add writes nothing"
    );
}

#[test]
fn export_without_the_app_says_so_and_a_switched_off_feature_runs_nothing() {
    let v = Vaults::new();
    v.ok(&["excalidraw:create", "path=D", &spec_arg(&two_boxes())]);
    for line in [
        &["excalidraw:export", "path=D.excalidraw.md"][..],
        &["excalidraw:export", "path=D.excalidraw.md", "format=png"],
        &["excalidraw:preview", "path=D.excalidraw.md"],
        &["excalidraw:preview", "path=D.excalidraw.md", "scale=2"],
    ] {
        let o = v.run(line);
        assert_eq!(o.code, EXIT_NOT_RUNNING, "{line:?}");
        assert!(o.stderr.contains("Writer is not running"), "{}", o.stderr);
    }
    // a bad format or scale is a usage error, before the app is looked for
    for bad in ["format=gif", "scale=abc"] {
        let o = v.run(&["excalidraw:preview", "path=D.excalidraw.md", bad]);
        assert_eq!(o.code, EXIT_USAGE, "{bad}");
    }

    std::fs::write(
        v.data.path().join("config"),
        "features.excalidraw.enabled = false\n",
    )
    .unwrap();
    for line in [
        &["excalidraw:create", "path=Z"][..],
        &["excalidraw:read", "path=D.excalidraw.md"],
        &["excalidraw:export", "path=D.excalidraw.md"],
        &["excalidraw:preview", "path=D.excalidraw.md"],
        &["excalidraw:update", "path=D.excalidraw.md", "spec={}"],
    ] {
        let o = v.run(line);
        assert_eq!(o.code, EXIT_FAIL, "{line:?}");
        assert!(
            o.stderr.contains("the excalidraw feature is turned off"),
            "{}",
            o.stderr
        );
    }
    assert!(!v.path("Z.excalidraw.md").exists());
}

// ---------- the socket commands ----------

struct FakeWindow {
    root: PathBuf,
    answer: Value,
    asked: std::sync::Mutex<Vec<Value>>,
}

impl Host for FakeWindow {
    fn app_version(&self) -> String {
        "test".into()
    }
    fn open_vaults(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }
    fn feature_live(&self, _: &str) -> bool {
        true
    }
    fn command_panicked(&self, _: Option<&'static str>) {}
    fn open_vault_window<'a>(
        &'a self,
        _: &'a Path,
        _: bool,
    ) -> crate::ipc::BoxFuture<'a, Result<(), IpcError>> {
        Box::pin(async { Ok(()) })
    }
    fn ask_window<'a>(
        &'a self,
        _: &'a Path,
        topic: &'a str,
        payload: Value,
    ) -> crate::ipc::BoxFuture<'a, Result<Value, IpcError>> {
        assert_eq!(topic, "excalidraw:render");
        assert!(payload["path"]
            .as_str()
            .unwrap()
            .ends_with("D.excalidraw.md"));
        self.asked.lock().unwrap().push(payload);
        let answer = self.answer.clone();
        Box::pin(async move { Ok(answer) })
    }
}

/// A one-pixel PNG, base64.
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/// Run the command `name` against a fake window answering `answer`. Returns the result, the
/// vault (kept alive) and what the window was asked.
fn run_ipc(
    name: &str,
    answer: Value,
    args: Value,
) -> (Result<Value, IpcError>, TempDir, Vec<Value>) {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(
        root.join("D.excalidraw.md"),
        md::new_drawing_text(md::Format::Md, &md::empty_scene()),
    )
    .unwrap();
    std::fs::write(root.join("Note.md"), "x").unwrap();
    let window = Arc::new(FakeWindow {
        answer,
        root: root.clone(),
        asked: Default::default(),
    });
    let host: Arc<dyn Host> = window.clone();
    let call = Call {
        host,
        vault: Some(Vault {
            root: root.clone(),
            open: true,
        }),
        args: args.as_object().unwrap().clone(),
    };
    let run = ipc::COMMANDS.iter().find(|c| c.name == name).unwrap().run;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let out = rt.block_on(run(call));
    let asked = window.asked.lock().unwrap().clone();
    (out, dir, asked)
}

fn png_answer() -> Value {
    json!({"format": "png", "data": PNG_B64})
}

#[test]
fn the_commands_are_on_the_allowlist_as_feature_commands() {
    let names: Vec<_> = ipc::COMMANDS.iter().map(|c| (c.name, c.feature)).collect();
    assert_eq!(
        names,
        [
            ("excalidraw:export", Some("excalidraw")),
            ("excalidraw:preview", Some("excalidraw"))
        ]
    );
}

#[test]
fn preview_writes_a_png_outside_the_vault_and_answers_only_its_path() {
    let (out, dir, asked) = run_ipc(
        "excalidraw:preview",
        png_answer(),
        json!({"path": "D.excalidraw.md", "scale": 2}),
    );
    let path = PathBuf::from(out.unwrap()["path"].as_str().unwrap());
    assert!(path.is_absolute());
    assert!(
        !path.starts_with(dir.path().canonicalize().unwrap()),
        "never in the vault"
    );
    assert!(path.starts_with(std::env::temp_dir().join("writer-previews")));
    assert!(path.extension().is_some_and(|e| e == "png"));
    assert!(std::fs::read(&path)
        .unwrap()
        .starts_with(b"\x89PNG\r\n\x1a\n"));
    assert_eq!(asked[0]["format"], "png");
    assert_eq!(asked[0]["scale"], 2.0);
    // the vault holds nothing new
    assert!(!dir.path().join("D.png").exists());
    let _ = std::fs::remove_file(path);
}

#[test]
fn preview_defaults_to_png_and_can_be_an_svg() {
    let (_, dir, asked) = run_ipc(
        "excalidraw:preview",
        png_answer(),
        json!({"path": "D.excalidraw.md"}),
    );
    assert_eq!(
        (asked[0]["format"].clone(), asked[0]["scale"].clone()),
        (json!("png"), json!(1.0))
    );
    drop(dir);
    let (out, _dir, _) = run_ipc(
        "excalidraw:preview",
        json!({"format": "svg", "data": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"}),
        json!({"path": "D.excalidraw.md", "format": "svg"}),
    );
    let path = PathBuf::from(out.unwrap()["path"].as_str().unwrap());
    assert!(std::fs::read_to_string(&path).unwrap().starts_with("<svg"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn export_writes_beside_the_drawing_in_the_vault_as_svg_or_png() {
    let (out, dir, _) = run_ipc(
        "excalidraw:export",
        json!({"format": "svg", "data": "<svg>note text</svg>"}),
        json!({"path": "D.excalidraw.md", "format": "svg"}),
    );
    assert_eq!(
        out.unwrap(),
        json!({"path": "D.svg"}),
        "only the path leaves the app"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("D.svg")).unwrap(),
        "<svg>note text</svg>"
    );

    let (out, dir, _) = run_ipc(
        "excalidraw:export",
        png_answer(),
        json!({"path": "D.excalidraw.md", "format": "png"}),
    );
    assert_eq!(out.unwrap(), json!({"path": "D.png"}));
    assert!(std::fs::read(dir.path().join("D.png"))
        .unwrap()
        .starts_with(b"\x89PNG"));
    // export stays an SVG unless asked otherwise
    let (_, _dir, asked) = run_ipc(
        "excalidraw:export",
        json!({"data": "<svg/>"}),
        json!({"path": "D.excalidraw.md"}),
    );
    assert_eq!(asked[0]["format"], "svg");
}

#[test]
fn the_socket_commands_confine_the_path_and_refuse_bad_arguments() {
    for name in ["excalidraw:export", "excalidraw:preview"] {
        for bad in [
            json!({"path": "../D.excalidraw.md"}),
            json!({"path": "missing.excalidraw.md"}),
            json!({"path": "Note.md"}),
            json!({"path": "D.excalidraw.md", "extra": 1}),
            json!({"path": "D.excalidraw.md", "format": "gif"}),
            json!({"path": "D.excalidraw.md", "scale": 9}),
            json!({"path": "D.excalidraw.md", "scale": "big"}),
            json!({"path": "D.excalidraw.md", "format": "svg", "scale": 2}),
        ] {
            let (out, _dir, asked) = run_ipc(name, png_answer(), bad.clone());
            assert!(out.is_err(), "{name} {bad}");
            assert!(asked.is_empty(), "the window is not bothered: {bad}");
        }
    }
}

#[test]
fn an_answer_that_is_not_the_image_it_claims_is_not_believed() {
    for (name, answer, format) in [
        ("excalidraw:preview", json!({"data": "bm90IGEgcG5n"}), "png"),
        ("excalidraw:preview", json!({"data": "!!"}), "png"),
        ("excalidraw:preview", json!({}), "png"),
        ("excalidraw:export", json!({"data": "<html>"}), "svg"),
    ] {
        let (out, dir, _) = run_ipc(
            name,
            answer,
            json!({"path": "D.excalidraw.md", "format": format}),
        );
        assert_eq!(out.unwrap_err().code, ErrorCode::Internal);
        assert!(!dir.path().join("D.png").exists() && !dir.path().join("D.svg").exists());
    }
}

// ---------- the previews folder ----------

#[test]
fn previews_are_private_and_old_ones_are_swept() {
    use std::time::{Duration, SystemTime};
    let base = TempDir::new().unwrap();
    let now = SystemTime::now();
    let first = previews::save(base.path(), "My note/odd name", "png", b"a", now).unwrap();
    let name = first.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("My-note-odd-name-") && name.ends_with(".png"),
        "{name}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(first.parent().unwrap()), 0o700);
        assert_eq!(mode(&first), 0o600);
    }
    // a later preview, past the keep time, sweeps the first
    let later = now + previews::KEEP + Duration::from_secs(60);
    // the file's mtime is real "now", so age it by asking from the future
    let second = previews::save(base.path(), "x", "png", b"b", later).unwrap();
    assert!(!first.exists() && second.exists());
    // a symlink in the place of the folder is refused
    #[cfg(unix)]
    {
        let other = TempDir::new().unwrap();
        let b2 = TempDir::new().unwrap();
        std::os::unix::fs::symlink(other.path(), b2.path().join(previews::FOLDER)).unwrap();
        assert!(previews::save(b2.path(), "x", "png", b"c", now).is_err());
    }
}

mod update;
