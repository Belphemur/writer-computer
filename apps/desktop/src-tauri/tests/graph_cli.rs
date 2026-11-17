//! `writer graph:*` end to end: the real app binary through the `writer` launcher, against a
//! temp vault and a temp index folder (never a real vault). Unix only (the launcher is a symlink).
#![cfg(unix)]

use desktop_lib::agent::cli_launcher;
use desktop_lib::index::INDEX_DIR_ENV;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Setup {
    vault: tempfile::TempDir,
    data: tempfile::TempDir,
    home: tempfile::TempDir,
    launcher: PathBuf,
}

fn setup() -> Setup {
    let data = tempfile::tempdir().unwrap();
    let launcher = cli_launcher::ensure(
        &data.path().join("bin"),
        Path::new(env!("CARGO_BIN_EXE_desktop")),
    )
    .unwrap()
    .join("writer");
    let vault = tempfile::tempdir().unwrap();
    let w = |rel: &str, text: &str| {
        let p = vault.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    };
    w("People/Daniel.md", "---\nmanager: \"[[Priya]]\"\nteam: [\"[[Ana]]\", \"[[Ben]]\"]\n---\n# Daniel\nWorks on [[Project X]]. Missing: [[ghost note]].\n");
    w("People/Priya.md", "Priya manages [[Daniel]].\n");
    w(
        "People/Ana.md",
        "---\nmanager: \"[[Daniel]]\"\n---\n# Ana\n## Work\nOn [[Project X]].\n",
    );
    w("People/Ben.md", "[[Project X]]\n");
    w("Projects/Project X.md", "# P\n[[Ana]]\n");
    w("Far.md", "[[Ben]]\n");
    w("lone.md", "nothing\n");
    Setup {
        vault,
        data,
        home: tempfile::tempdir().unwrap(),
        launcher,
    }
}

impl Setup {
    fn run(&self, args: &[&str]) -> Output {
        Command::new(&self.launcher)
            .arg(format!("vault={}", self.vault.path().display()))
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.home.path())
            .env(INDEX_DIR_ENV, self.data.path().join("index"))
            .output()
            .unwrap()
    }

    fn ok(&self, args: &[&str]) -> String {
        let o = self.run(args);
        assert!(
            o.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8(o.stdout).unwrap()
    }

    fn json(&self, args: &[&str]) -> Value {
        let mut a = args.to_vec();
        a.push("format=json");
        serde_json::from_str(&self.ok(&a)).unwrap()
    }
}

#[test]
fn the_graph_commands_answer_through_the_real_binary() {
    let s = setup();

    let hood = s.json(&["graph:neighbors", "file=Daniel", "depth=2"]);
    assert_eq!(hood["center"], "People/Daniel.md");
    let nodes = hood["nodes"].as_array().unwrap();
    let far = nodes.iter().find(|n| n["path"] == "Far.md").unwrap();
    assert_eq!(far["depth"], 2);
    assert_eq!(far["via"]["label"], "team");
    assert_eq!(hood["truncated"], false);
    assert!(hood["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["label"] == "manager"));

    let text = s.ok(&["graph:neighbors", "file=Daniel", "depth=1", "label=manager"]);
    assert!(
        text.contains("People/Priya.md") && !text.contains("Far.md"),
        "{text}"
    );

    let path = s.json(&["graph:path", "from=Far", "to=Priya"]);
    assert_eq!(
        path["nodes"],
        serde_json::json!([
            "Far.md",
            "People/Ben.md",
            "People/Daniel.md",
            "People/Priya.md"
        ])
    );
    assert_eq!(path["steps"][1]["direction"], "in");
    let none = s.run(&["graph:path", "from=Far", "to=lone"]);
    assert_eq!(none.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&none.stderr).contains("no path within 6 hops"));

    let labels = s.json(&["graph:relationships"]);
    assert_eq!(labels[0]["label"], "manager");
    assert_eq!(labels[0]["edges"], 2);
    let rels = s.json(&["graph:relationships", "file=Daniel", "label=team"]);
    assert_eq!(rels.as_array().unwrap().len(), 2);

    let back = s.json(&["graph:backlinks", "file=Project X", "context"]);
    let ana = back
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["source"] == "People/Ana.md")
        .unwrap();
    assert_eq!(ana["section"], "Work");
    assert_eq!(ana["context"], "On [[Project X]].");

    let related = s.json(&["graph:related", "file=Priya"]);
    assert!(related
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["path"] == "People/Ana.md"));

    assert_eq!(
        s.json(&["graph:hubs", "limit=1"])[0]["path"],
        "People/Daniel.md"
    );
    assert_eq!(s.json(&["graph:components"])[0]["size"], 6);
    assert_eq!(s.ok(&["graph:orphans"]).trim(), "lone.md");

    // Usage errors exit 2 with a message, not a panic.
    let bad = s.run(&["graph:neighbors", "file=Daniel", "depth=9"]);
    assert_eq!(bad.status.code(), Some(2));
    let bad = s.run(&["graph:neighbors", "file=Daniel", "direction=sideways"]);
    assert_eq!(bad.status.code(), Some(2));
}
