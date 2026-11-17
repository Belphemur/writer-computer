//! The contract between a feature's manifest, its code, its capability and its settings.
//!
//! `build.rs` turns `feature.json` into ACL permissions, but nothing at compile time ties the
//! manifest to the `#[tauri::command]` functions: a command missing from the manifest is "not
//! allowed" at runtime, a manifest command missing from the handler is "not found". This test is
//! the only guard, so it is mandatory for every registered feature. (The end-to-end IPC/ACL test
//! under Tauri's mock runtime needs the `tauri` `test` feature and is pending approval.)

use super::{fixture, registry, Feature, Manifest};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tauri::plugin::Plugin;
use tauri::Wry;

const WINDOWS: [&str; 2] = ["main", "w-*"];

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `word_count_for_text` -> `allow-word-count-for-text` (how tauri-build names permissions).
fn allow_permission(id: &str, command: &str) -> String {
    format!("{id}:allow-{}", command.replace('_', "-"))
}

/// Names of the `#[tauri::command]` functions in a file, or in every `.rs` file under a folder.
fn scan_commands(path: &Path) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if path.is_dir() {
        for entry in std::fs::read_dir(path).unwrap().flatten() {
            out.extend(scan_commands(&entry.path()));
        }
    } else if path.extension().is_some_and(|e| e == "rs") {
        let src = std::fs::read_to_string(path).unwrap();
        let mut lines = src.lines();
        while let Some(line) = lines.next() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            let sig = lines
                .by_ref()
                .map(str::trim)
                .find(|l| !l.starts_with("#[") && !l.starts_with("///"))
                .unwrap_or_default();
            if let Some(rest) = sig.split("fn ").nth(1) {
                out.insert(rest.split(['(', '<']).next().unwrap().trim().to_string());
            }
        }
    }
    out
}

fn valid_event_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || "-/:_".contains(c))
}

const HOOKS: [&str; 4] = ["setup", "onWorkspaceOpen", "onWorkspaceClose", "onExit"];

fn check_events(m: &Manifest) -> Result<(), String> {
    let id = &m.id;
    for hook in &m.rust.hooks {
        if !HOOKS.contains(&hook.as_str()) {
            return Err(format!(
                "{id}: unknown hook {hook:?}, expected one of {HOOKS:?}"
            ));
        }
    }
    for event in &m.rust.events {
        if !event.starts_with(&format!("{id}:")) || !valid_event_name(event) {
            return Err(format!(
                "{id}: event {event:?} must be \"{id}:<name>\" (no dots)"
            ));
        }
    }
    Ok(())
}

/// Manifest vs the plugin's name, the commands in the source and the capability.
fn check_feature(
    m: &Manifest,
    plugin_name: &str,
    declared: &BTreeSet<String>,
    capability: &Value,
) -> Result<(), String> {
    let id = &m.id;
    if plugin_name != id {
        return Err(format!("{id}: plugin is named {plugin_name:?}, not the id"));
    }
    let listed: BTreeSet<String> = m.rust.commands.iter().cloned().collect();
    if &listed != declared {
        return Err(format!(
            "{id}: feature.json rust.commands {listed:?} != #[tauri::command] fns {declared:?}"
        ));
    }
    check_events(m)?;
    if capability["identifier"] != json!(format!("feature-{id}")) {
        return Err(format!("{id}: capability identifier must be feature-{id}"));
    }
    if capability["windows"] != json!(WINDOWS) {
        return Err(format!(
            "{id}: capability windows must be exactly {WINDOWS:?}"
        ));
    }
    let perms: BTreeSet<&str> = capability["permissions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !perms.contains(format!("{id}:default").as_str()) {
        for cmd in &m.rust.commands {
            let p = allow_permission(id, cmd);
            if !perms.contains(p.as_str()) {
                return Err(format!("{id}: capability lacks {p}"));
            }
        }
    }
    Ok(())
}

/// The generated kill switch of a feature: it lives in `shared/settings.schema.json`, verbatim.
fn kill_switch(m: &Manifest) -> Value {
    json!({
        "key": m.enabled_key(),
        "label": m.name,
        "description": if m.has_rust() {
            format!("Turns the {} feature on or off. The Rust part takes effect after a restart.", m.name)
        } else {
            format!("Turns the {} feature on or off.", m.name)
        },
        "category": "Features",
        "type": "boolean",
        "default": m.enabled_by_default,
        "scope": "global",
    })
}

const FRAGMENT_FIELDS: [&str; 6] = ["key", "label", "description", "category", "type", "default"];

/// A feature's settings fragment: every key starts with `<id>.`, every entry has the fields the
/// settings UI needs, no key repeats. (This replaces the hand count of the agent's keys.)
fn fragment_entries(m: &Manifest, fragment: &str) -> Result<Vec<Value>, String> {
    let id = &m.id;
    let v: Value = serde_json::from_str(fragment).map_err(|e| format!("{id}: fragment: {e}"))?;
    let list = v["settings"]
        .as_array()
        .ok_or(format!("{id}: fragment has no settings array"))?;
    let mut seen = BTreeSet::new();
    for e in list {
        let key = e["key"]
            .as_str()
            .ok_or(format!("{id}: entry without key"))?;
        if !key.starts_with(&format!("{id}.")) {
            return Err(format!("{id}: key {key} must start with \"{id}.\""));
        }
        for field in FRAGMENT_FIELDS {
            if e.get(field).is_none() {
                return Err(format!("{id}: {key} has no {field}"));
            }
        }
        if !seen.insert(key.to_string()) {
            return Err(format!("{id}: duplicate key {key}"));
        }
    }
    Ok(list.clone())
}

/// What a feature adds to the settings schema: the generated kill switch plus its fragment.
fn schema_entries(m: &Manifest, fragment: Option<&str>) -> Result<Vec<Value>, String> {
    let mut entries = vec![kill_switch(m)];
    if let Some(raw) = fragment {
        entries.extend(fragment_entries(m, raw)?);
    }
    Ok(entries)
}

/// A fragment's entries are merged at runtime (`config::settings_schema`): none may also sit in
/// the shared file (one source), all must be in the merged schema, and no key repeats there.
fn check_fragment_merged(
    shared: &Value,
    own: &[Value],
    merged_keys: &[String],
) -> Result<(), String> {
    for e in own {
        let key = e["key"].as_str().unwrap();
        if shared["settings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["key"] == e["key"])
        {
            return Err(format!("{key} is in both its fragment and the shared file"));
        }
        match merged_keys.iter().filter(|k| *k == key).count() {
            1 => {}
            0 => return Err(format!("{key} is not in the merged schema")),
            _ => return Err(format!("{key} is defined twice in the merged schema")),
        }
    }
    Ok(())
}

/// The kill switch must be in `shared/settings.schema.json`, verbatim. Fails with the JSON to add.
fn check_schema(shared: &Value, wanted: &[Value]) -> Result<(), String> {
    let have = shared["settings"].as_array().unwrap();
    for entry in wanted {
        match have.iter().find(|h| h["key"] == entry["key"]) {
            None => {
                return Err(format!(
                    "shared/settings.schema.json lacks {}; add:\n{}",
                    entry["key"],
                    serde_json::to_string_pretty(entry).unwrap()
                ))
            }
            Some(h) if h != entry => {
                return Err(format!(
                    "{} drifted from its feature fragment: {h} != {entry}",
                    entry["key"]
                ))
            }
            Some(_) => {}
        }
    }
    Ok(())
}

fn shared_schema() -> Value {
    let path = crate_dir().join("../shared/settings.schema.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn read_json(path: &Path) -> Value {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn fixture_dir() -> PathBuf {
    crate_dir().join("tests/fixtures/features/fixture-hello")
}

fn fixture_def() -> &'static dyn Feature<Wry> {
    fixture::registry::<Wry>().remove(0)
}

fn fixture_checks(
    m: &Manifest,
    declared: &BTreeSet<String>,
    capability: &Value,
) -> Result<(), String> {
    check_feature(
        m,
        super::plugin_of(&m.id, fixture::handler::<Wry>()).name(),
        declared,
        capability,
    )
}

#[test]
fn every_registered_feature_matches_its_folder_capability_and_settings() {
    let defs = registry::<Wry>();
    let features_dir = crate_dir().join("../features");
    let shared = shared_schema();
    let merged_keys: Vec<String> = crate::config::settings_schema()
        .into_iter()
        .map(|d| d.key)
        .collect();
    let mut ids = BTreeSet::new();
    for def in &defs {
        let m = def.manifest().expect("feature.json parses");
        assert!(ids.insert(m.id.clone()), "duplicate feature id {}", m.id);
        let dir = features_dir.join(&m.id);
        assert_eq!(read_json(&dir.join("feature.json"))["id"], json!(m.id));
        // A feature with hooks or events but no commands has no plugin and no ACL.
        let plugin = def.invoke_handler().map(|h| super::plugin_of(&m.id, h));
        assert_eq!(
            plugin.is_some(),
            !m.rust.commands.is_empty(),
            "{}: a plugin exists exactly when feature.json lists commands",
            m.id
        );
        let declared = scan_commands(&dir.join("rust"));
        match &plugin {
            Some(plugin) => {
                let capability =
                    read_json(&crate_dir().join(format!("capabilities/features/{}.json", m.id)));
                check_feature(&m, plugin.name(), &declared, &capability).unwrap();
            }
            None => {
                assert!(
                    declared.is_empty(),
                    "{}: commands without a manifest entry",
                    m.id
                );
                check_events(&m).unwrap();
            }
        }
        check_schema(&shared, &[kill_switch(&m)]).unwrap();
        if let Some(raw) = def.settings_source() {
            let own = fragment_entries(&m, raw).unwrap();
            check_fragment_merged(&shared, &own, &merged_keys).unwrap();
        }
    }
    // A feature folder without a registry entry would silently get ACL but no plugin, unless it has
    // no Rust half (a TypeScript-only feature): then it has no plugin to register and only its
    // kill switch has to be in the shared schema.
    let mut web_only = BTreeSet::new();
    for entry in std::fs::read_dir(&features_dir)
        .into_iter()
        .flatten()
        .flatten()
    {
        if entry.path().join("feature.json").is_file() {
            let id = read_json(&entry.path().join("feature.json"))["id"]
                .as_str()
                .unwrap()
                .to_string();
            let m: Manifest = serde_json::from_value(read_json(&entry.path().join("feature.json")))
                .expect("feature.json parses");
            if !m.has_rust() && !ids.contains(&id) {
                assert!(
                    !entry.path().join("settings.schema.json").exists(),
                    "{id}: a settings fragment needs a registry entry (Rust merges it)"
                );
                check_schema(&shared, &[kill_switch(&m)]).unwrap();
                web_only.insert(id);
                continue;
            }
            assert!(
                ids.contains(&id),
                "{id} has a folder but no entry in features::registry"
            );
        }
    }
    // Every `features.<id>.enabled` key in the shared file belongs to a registered feature.
    for e in shared["settings"].as_array().unwrap() {
        let key = e["key"].as_str().unwrap();
        if let Some(id) = key
            .strip_prefix("features.")
            .and_then(|k| k.strip_suffix(".enabled"))
        {
            assert!(
                ids.contains(id) || web_only.contains(id),
                "{key} is in the shared schema but {id} is not registered"
            );
        }
    }
}

#[test]
fn the_fixture_feature_satisfies_the_contract() {
    let def = fixture_def();
    let m = def.manifest().unwrap();
    let declared = scan_commands(&crate_dir().join("src/features/fixture.rs"));
    assert_eq!(
        declared,
        ["hello_greet", "hello_shout"].map(String::from).into()
    );
    let cap = read_json(&fixture_dir().join("capability.json"));
    fixture_checks(&m, &declared, &cap).unwrap();
}

#[test]
fn a_stale_manifest_or_capability_fails_the_contract() {
    let def = fixture_def();
    let m = def.manifest().unwrap();
    let declared = scan_commands(&crate_dir().join("src/features/fixture.rs"));
    let cap = read_json(&fixture_dir().join("capability.json"));

    let mut extra = declared.clone();
    extra.insert("added_but_not_in_manifest".into());
    assert!(fixture_checks(&m, &extra, &cap)
        .unwrap_err()
        .contains("rust.commands"));

    let mut hooked = m.clone();
    hooked.rust.hooks = vec!["onSomethingElse".into()];
    assert!(fixture_checks(&hooked, &declared, &cap)
        .unwrap_err()
        .contains("unknown hook"));

    let mut dotted = m.clone();
    dotted.rust.events = vec!["fixture-hello.greeted".into()];
    assert!(fixture_checks(&dotted, &declared, &cap)
        .unwrap_err()
        .contains("no dots"));

    let mut wide = cap.clone();
    wide["windows"] = json!(["*"]);
    assert!(fixture_checks(&m, &declared, &wide)
        .unwrap_err()
        .contains("windows"));

    let mut partial = cap.clone();
    partial["permissions"] = json!(["fixture-hello:allow-hello-greet"]);
    assert!(fixture_checks(&m, &declared, &partial)
        .unwrap_err()
        .contains("fixture-hello:allow-hello-shout"));
    partial["permissions"] = json!([
        "fixture-hello:allow-hello-greet",
        "fixture-hello:allow-hello-shout"
    ]);
    fixture_checks(&m, &declared, &partial).unwrap();
}

#[test]
fn the_kill_switch_must_be_in_the_shared_schema_verbatim_or_the_test_fails() {
    let m = fixture_def().manifest().unwrap();
    let wanted = schema_entries(&m, fixture_def().settings_source()).unwrap();
    assert_eq!(wanted[0]["key"], "features.fixture-hello.enabled");
    assert_eq!(wanted[1]["key"], "fixture-hello.greeting");

    let mut shared = json!({ "settings": [] });
    let err = check_schema(&shared, &wanted[..1]).unwrap_err();
    assert!(err.contains("features.fixture-hello.enabled") && err.contains("add:"));

    shared["settings"] = json!(wanted[..1]);
    check_schema(&shared, &wanted[..1]).unwrap();
    shared["settings"][0]["default"] = json!(false);
    assert!(check_schema(&shared, &wanted[..1])
        .unwrap_err()
        .contains("drifted"));
}

#[test]
fn a_fragment_entry_must_be_merged_once_and_not_sit_in_the_shared_file() {
    let m = fixture_def().manifest().unwrap();
    let own = fragment_entries(&m, fixture::SETTINGS).unwrap();
    let keys = vec!["fixture-hello.greeting".to_string()];
    let empty = json!({ "settings": [] });
    check_fragment_merged(&empty, &own, &keys).unwrap();
    assert!(check_fragment_merged(&empty, &own, &[])
        .unwrap_err()
        .contains("not in the merged"));
    let twice = vec![keys[0].clone(), keys[0].clone()];
    assert!(check_fragment_merged(&empty, &own, &twice)
        .unwrap_err()
        .contains("twice"));
    let shared = json!({ "settings": own });
    assert!(check_fragment_merged(&shared, &own, &keys)
        .unwrap_err()
        .contains("both"));
}

#[test]
fn a_fragment_entry_without_a_label_or_default_is_rejected() {
    let m = fixture_def().manifest().unwrap();
    let bad = r#"{"settings":[{"key":"fixture-hello.x","type":"string"}]}"#;
    assert!(fragment_entries(&m, bad).unwrap_err().contains("has no"));
}

#[test]
fn a_fragment_key_outside_the_feature_prefix_is_rejected() {
    let m = fixture_def().manifest().unwrap();
    let bad = r#"{"settings":[{"key":"editor.font-size"}]}"#;
    assert!(fragment_entries(&m, bad)
        .unwrap_err()
        .contains("must start with"));
}

#[test]
fn the_fixture_enabled_default_comes_from_the_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let s = super::tests::settings_with(dir.path(), &[]);
    let m = fixture_def().manifest().unwrap();
    assert!(super::is_enabled(&s, &m));
}

#[test]
fn the_fixture_commands_work_through_the_plain_function_path() {
    use tauri::async_runtime::block_on;
    assert_eq!(
        block_on(fixture::hello_greet("a".into())).unwrap(),
        "hello a"
    );
    assert_eq!(
        block_on(fixture::hello_shout("a".into())).unwrap(),
        "HELLO A"
    );
}
