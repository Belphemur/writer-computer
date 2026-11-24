//! The fixtures folder holds real captures made safe: this is the Rust twin of the final check of
//! `fixtures/tools/scrub.py` (`--check`), so a fixture added or edited by hand cannot bring a
//! name, a path, a port, a credential or a real id into the repository, base64 values included.
//! Also: the recorded replies parse as the wire types, and the contract list is current.

use super::events_tests::{fixture_names, fixtures_dir};
use super::opencode_api::{Data, Info, ModelInfo};
use base64::Engine as _;
use regex_lite::Regex;

/// Words that must not appear in any fixture (compared case-insensitively). The machine's own
/// user name is added at run time.
const WORDS: &[&str] = &[
    "users/",
    "bearer",
    "wrk_",
    "authorization",
    "/private/",
    "/var/folders",
    "apikey",
    "credential",
    "@",
];

fn id_prefixes() -> Regex {
    Regex::new(r"\b(ses|msg|evt|per|frm|psv|sh|mcp)_([0-9A-Za-z]{10,})").unwrap()
}

/// Problems found in `text` (`where_` says whether it was plain or decoded).
fn problems(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let low = text.to_lowercase();
    let mut words: Vec<String> = WORDS.iter().map(|w| w.to_string()).collect();
    if let Ok(user) = std::env::var("USER") {
        if user.len() >= 4 && user != "user" && user != "root" {
            words.push(user.to_lowercase());
        }
    }
    for w in &words {
        if low.contains(w.as_str()) {
            out.push(format!("word {w:?}"));
        }
    }
    // an id that is not a fake (`ses_fake0001`) is a real one
    for c in id_prefixes().captures_iter(text) {
        if !c[2].starts_with("fake") {
            out.push(format!(
                "unfaked id {}_{}...",
                &c[1],
                &c[2][..4.min(c[2].len())]
            ));
        }
    }
    for m in Regex::new(r"call-([0-9A-Za-z]+)")
        .unwrap()
        .captures_iter(text)
    {
        if !m[1].starts_with("fake")
            && m[1].len() >= 8
            && m[1].bytes().all(|b| b.is_ascii_hexdigit())
        {
            out.push("unfaked call id".into());
        }
    }
    if Regex::new(r"\b[0-9a-f]{40,64}\b").unwrap().is_match(text) {
        out.push("a hash".into());
    }
    for m in Regex::new(r"127\.0\.0\.1:(\d+)")
        .unwrap()
        .captures_iter(text)
    {
        if &m[1] != "0" {
            out.push(format!("port {}", &m[1]));
        }
    }
    if text.contains("/Users/")
        || Regex::new(r"/home/([A-Za-z0-9_.-]+)")
            .unwrap()
            .captures_iter(text)
            .any(|c| &c[1] != "user")
    {
        out.push("a home path".into());
    }
    out
}

fn base64_runs(text: &str) -> Vec<Vec<u8>> {
    Regex::new(r"[A-Za-z0-9+/]{24,}={0,2}")
        .unwrap()
        .find_iter(text)
        .filter_map(|m| {
            base64::engine::general_purpose::STANDARD
                .decode(m.as_str())
                .ok()
        })
        .collect()
}

#[test]
fn no_fixture_holds_a_name_a_path_a_port_a_credential_or_a_real_id() {
    let mut bad = Vec::new();
    let mut files = 0;
    for e in std::fs::read_dir(fixtures_dir()).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !(name.ends_with(".sse") || name.ends_with(".json")) {
            continue;
        }
        files += 1;
        let text = std::fs::read_to_string(e.path()).unwrap();
        for p in problems(&text) {
            bad.push(format!("{name}: {p}"));
        }
        // a value that hides a name in base64 (an attachment, a cursor)
        for raw in base64_runs(&text) {
            if let Ok(inner) = String::from_utf8(raw) {
                for p in problems(&inner) {
                    bad.push(format!("{name} (base64): {p}"));
                }
            }
        }
    }
    assert!(files >= 40, "the fixtures went missing: {files}");
    assert!(bad.is_empty(), "fixtures with personal data: {bad:#?}");
}

#[test]
fn the_check_catches_what_it_is_for() {
    assert!(!problems("see /Users/someone/vault").is_empty());
    assert!(!problems("ses_AbCdEf1234567890").is_empty());
    assert!(!problems("http://127.0.0.1:4242").is_empty());
    assert!(!problems("Authorization: x").is_empty());
    assert!(problems("ses_fake0001 call-fake-0001 http://127.0.0.1:0 /home/user/x").is_empty());
    let hidden = base64::engine::general_purpose::STANDARD.encode("path /Users/someone/notes.md");
    assert!(base64_runs(&hidden)
        .iter()
        .any(|r| !problems(&String::from_utf8_lossy(r)).is_empty()));
}

#[test]
fn every_scenario_has_both_files_and_a_stream_that_starts_connected() {
    for name in fixture_names() {
        assert!(
            fixtures_dir().join(format!("{name}.json")).exists(),
            "{name}.json"
        );
        let sse = std::fs::read_to_string(fixtures_dir().join(format!("{name}.sse"))).unwrap();
        assert!(
            sse.starts_with("data: ") && sse.contains("server.connected"),
            "{name}"
        );
    }
}

fn recorded(key: &str) -> serde_json::Value {
    let all: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures_dir().join("rest.json")).unwrap())
            .unwrap();
    all[key]["body"].clone()
}

#[test]
fn the_recorded_replies_parse_as_the_wire_types() {
    let info: Info = serde_json::from_value(recorded("info")).unwrap();
    assert_eq!(info.version, super::opencode_api::MIN_VERSION);
    let models: Data<Vec<ModelInfo>> = serde_json::from_value(recorded("models")).unwrap();
    assert!(
        models.data.iter().any(|m| m.limit.context > 0),
        "the context window is read"
    );
    assert!(models
        .data
        .iter()
        .all(|m| !m.id.is_empty() && !m.providerID.is_empty()));
}

#[test]
fn a_prompt_id_is_global_across_sessions() {
    // s33, the real server: the same `msg_` id into a second session is a 409 `ConflictError`
    let r = recorded("prompt-id-conflict");
    assert_eq!(r["_tag"], "ConflictError");
    assert!(r["message"].as_str().unwrap().contains("conflicts"));
}
