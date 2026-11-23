//! No escape hatches (ADR 2026-11-20, guardrail 1): feature code must not hold a thread, a child
//! process, a watcher observer or an app event listener outside its scope. The scan covers each
//! feature's `rust/` folder and the core modules a feature owns ([`OWNED`]), and fails on a raw
//! `std::thread::spawn`, `thread::Builder`, `Command::spawn`, `watcher::observe_paths` or
//! `.listen(`. Today's offenders are named in [`ALLOWED`] with a reason each; the list only
//! shrinks (an entry that no longer matches fails the test, so it is removed with its fix).
//! The machinery itself (`features/mod.rs`, `lifecycle.rs`, `scope.rs`) is the one place that
//! may use them.

use std::path::{Path, PathBuf};

/// Core modules a feature owns, as paths under `src-tauri/src` (a folder is scanned whole).
const OWNED: &[(&str, &str)] = &[
    ("agent", "agent"),
    ("git", "git"),
    ("lint", "lint"),
    ("spellcheck", "spellcheck"),
    ("bases", "bases"),
    ("obsidian-host", "plugin_proc.rs"),
    ("obsidian-host", "plugin_http.rs"),
    ("obsidian-host", "plugin_env.rs"),
    ("obsidian-host", "plugin_store.rs"),
    ("obsidian-host", "commands/plugins.rs"),
];

const PATTERNS: &[&str] = &[
    "thread::spawn(",
    "thread::Builder",
    ".spawn()",
    "observe_paths(",
    ".listen(",
];

/// `(file suffix, pattern, reason)`: what still escapes the scope today.
const ALLOWED: &[(&str, &str, &str)] = &[
    (
        "spellcheck/harper.rs",
        "thread::Builder",
        "`std_spawner`, the Spawner for the CLI and tests; the app passes the scope's",
    ),
    (
        "plugin_proc.rs",
        ".spawn()",
        "ProcManager is the process owner of the plugin host and the agent: each owning scope adopts it (census and `on_stop` kill_all), a process dies with `kill_all`",
    ),
    (
        "plugin_proc.rs",
        "thread::spawn(",
        "ProcManager's per-process reader and waiter threads end with their process; counted through the adopted process census",
    ),
    (
        "plugin_env.rs",
        ".spawn()",
        "one login-shell PATH probe with a deadline, run once per app (not a running resource)",
    ),
    (
        "plugin_env.rs",
        "thread::spawn(",
        "the reader of that same bounded probe",
    ),
];

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name()
                .is_some_and(|n| n != "tests" && n != "fixtures")
            {
                rust_files(&p, out);
            }
        } else if p.extension().is_some_and(|x| x == "rs") {
            let name = p.file_name().unwrap().to_string_lossy();
            if name != "tests.rs" && !name.ends_with("_tests.rs") {
                out.push(p);
            }
        }
    }
}

fn scanned() -> Vec<PathBuf> {
    let mut files = Vec::new();
    let features = Path::new(env!("CARGO_MANIFEST_DIR")).join("../features");
    for e in std::fs::read_dir(features).unwrap().flatten() {
        let rust = e.path().join("rust");
        if rust.is_dir() {
            rust_files(&rust, &mut files);
        }
    }
    for (_, rel) in OWNED {
        let p = src_dir().join(rel);
        if p.is_dir() {
            rust_files(&p, &mut files);
        } else {
            files.push(p);
        }
    }
    files
}

/// The production part of a file: everything before its `#[cfg(test)] mod`.
fn production(text: &str) -> &str {
    ["\n#[cfg(test)]\nmod ", "\n#[cfg(test)]\npub(crate) mod "]
        .iter()
        .filter_map(|m| text.find(m))
        .min()
        .map_or(text, |i| &text[..i])
}

fn hits() -> Vec<(String, &'static str)> {
    let mut found = Vec::new();
    for file in scanned() {
        let text = std::fs::read_to_string(&file).unwrap();
        let rel = file.to_string_lossy().replace('\\', "/");
        for line in production(&text).lines() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            for p in PATTERNS {
                if code.contains(p) {
                    found.push((rel.clone(), *p));
                }
            }
        }
    }
    found
}

#[test]
fn feature_code_holds_no_thread_process_observer_or_listener_outside_its_scope() {
    let found = hits();
    let unlisted: Vec<_> = found
        .iter()
        .filter(|(f, p)| !ALLOWED.iter().any(|(s, ap, _)| f.ends_with(s) && ap == p))
        .collect();
    assert!(
        unlisted.is_empty(),
        "escapes the feature scope (use FeatureScope spawn/process/observe/listen): {unlisted:#?}"
    );
    for (suffix, pattern, reason) in ALLOWED {
        assert!(
            !reason.is_empty(),
            "{suffix}: an allowlist entry needs a reason"
        );
        assert!(
            found
                .iter()
                .any(|(f, p)| f.ends_with(suffix) && p == pattern),
            "{suffix} no longer uses {pattern}: remove it from the allowlist"
        );
    }
}
