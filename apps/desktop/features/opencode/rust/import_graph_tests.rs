//! The neutral agent never names OpenCode: `src/agent/` and `features/agent/` (Rust and web) are
//! backend-neutral, and the OpenCode feature reaches them only through the `Transport` seam and
//! the registration points (ADR, spec section 5). The web twin of this test is
//! `features/opencode/tests/import-graph.test.ts`.

use std::path::{Path, PathBuf};

fn files(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name()
                .is_some_and(|n| n == "node_modules" || n == "fixtures" || n == "goldens")
            {
                continue;
            }
            files(&p, ext, out);
        } else if p.extension().is_some_and(|x| x == ext) {
            out.push(p);
        }
    }
}

/// The code of a Rust file: everything before a `//` on each line (doc comments included). The
/// neutral side may say in a comment what a seam was made for; only code must not name a backend.
fn code(text: &str) -> String {
    text.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_neutral_agent_code_never_names_opencode() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut all = Vec::new();
    files(&root.join("src/agent"), "rs", &mut all);
    files(&root.join("../features/agent/rust"), "rs", &mut all);
    assert!(all.len() >= 20, "the scan found {} files", all.len());
    let mut bad = Vec::new();
    for f in all {
        let text = std::fs::read_to_string(&f).unwrap();
        let low = code(&text).to_lowercase();
        // `intoOpenCode`-style identifiers of other words do not exist here: any hit is a leak
        if low.contains("opencode") {
            bad.push(f.display().to_string());
        }
    }
    assert!(bad.is_empty(), "these name OpenCode in code: {bad:#?}");
}

#[test]
fn the_scan_sees_a_leak() {
    assert!(!code("let x = 1; // opencode here\nfn open_code() {}")
        .to_lowercase()
        .contains("opencode"));
    assert!(code("let opencode = 1;").contains("opencode"));
}

#[test]
fn the_opencode_feature_does_not_reach_into_the_agent_pane_internals() {
    // it may use `crate::agent` (the seam types and the pure mappers' inputs), never the Session
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../features/opencode/rust");
    let mut all = Vec::new();
    files(&root, "rs", &mut all);
    let mut bad = Vec::new();
    for f in all {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        if name == "import_graph_tests.rs" {
            continue;
        }
        let text = code(&std::fs::read_to_string(&f).unwrap());
        for banned in [
            "agent::runner",
            "agent::session",
            "agent::claude",
            "agent::stdio_transport",
        ] {
            if text.contains(banned) {
                bad.push(format!("{name}: {banned}"));
            }
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}
