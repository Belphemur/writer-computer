//! The pre-push token scan (spec "Plugin settings and secrets", the user 2026-11-20). Plugin
//! settings (`.obsidian/plugins/<id>/data.json`) are synced, but a file that holds a token-like
//! value is held back: it is never committed while a remote exists and never pushed, until the
//! user chooses **Sync anyway** (this file, until its token values change: the fingerprint of
//! them is recorded device-locally in `.writer/git/plugin-scan.json`) or **Never sync this plugin**
//! (the file joins the managed `.gitignore` block).
//!
//! Token-like: a string value, non-empty, under a key named like `token`, `secret`, `password`,
//! `auth`, `bearer`, `apiKey`, `key` (the last word of a key), at any depth, or any string of 40+
//! characters of the base64/hex alphabet that mixes character kinds and looks random. The scan is
//! local; it reports the plugin id and a fingerprint, never a value, and nothing here logs.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// `.obsidian/plugins/<id>/data.json` to `<id>`.
pub fn plugin_of(rel: &str) -> Option<&str> {
    let rest = rel.strip_prefix(".obsidian/plugins/")?;
    let (id, file) = rest.split_once('/')?;
    (file == "data.json" && !id.is_empty() && !id.contains('/')).then_some(id)
}

/// The words of a key: `apiKey`, `api_key` and `api-key` are `api`, `key`.
fn words(key: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in key.chars() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        cur.extend(c.to_lowercase());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn token_key(key: &str) -> bool {
    let w = words(key);
    const NAMES: [&str; 11] = [
        "token",
        "tokens",
        "secret",
        "secrets",
        "password",
        "passwd",
        "auth",
        "authorization",
        "bearer",
        "apikey",
        "pat",
    ];
    w.iter().any(|x| NAMES.contains(&x.as_str())) || w.last().is_some_and(|x| x == "key")
}

fn entropy(s: &str) -> f64 {
    let mut counts: BTreeMap<char, usize> = BTreeMap::new();
    for c in s.chars() {
        *counts.entry(c).or_default() += 1;
    }
    let n = s.chars().count() as f64;
    counts
        .values()
        .map(|&c| {
            let p = c as f64 / n;
            -p * p.log2()
        })
        .sum()
}

fn random_looking(s: &str) -> bool {
    if s.chars().count() < 40
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_'))
    {
        return false;
    }
    let kinds = [
        s.chars().any(|c| c.is_ascii_lowercase()),
        s.chars().any(|c| c.is_ascii_uppercase()),
        s.chars().any(|c| c.is_ascii_digit()),
    ]
    .iter()
    .filter(|k| **k)
    .count();
    kinds >= 2 && entropy(s) >= 3.0
}

fn collect(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Object(map) => {
            for (k, v) in map {
                match v {
                    Value::String(s) if !s.is_empty() && token_key(k) => {
                        out.insert(s.clone());
                    }
                    _ => collect(v, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| collect(i, out)),
        Value::String(s) if random_looking(s) => {
            out.insert(s.clone());
        }
        _ => {}
    }
}

/// The fingerprint of the token-like values of a `data.json`, `None` when it holds none (or is not
/// JSON). It changes when a token value does.
pub fn scan(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let mut found = BTreeSet::new();
    collect(&value, &mut found);
    if found.is_empty() {
        return None;
    }
    let mut hash = Sha256::new();
    for v in &found {
        hash.update(v.as_bytes());
        hash.update([0]);
    }
    Some(
        hash.finalize()
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

fn prefs_path(root: &Path) -> PathBuf {
    root.join(".writer/git/plugin-scan.json")
}

/// The "Sync anyway" decisions: plugin id to the fingerprint it was allowed with.
fn allowed(root: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(prefs_path(root))
        .ok()
        .and_then(|t| serde_json::from_str::<BTreeMap<String, String>>(&t).ok())
        .unwrap_or_default()
}

/// Is this file held back: it holds a token-like value the user has not allowed?
pub fn flagged(root: &Path, rel: &str, bytes: &[u8]) -> bool {
    let Some(id) = plugin_of(rel) else {
        return false;
    };
    match scan(bytes) {
        Some(fp) => allowed(root).get(id) != Some(&fp),
        None => false,
    }
}

/// "Sync anyway": records the fingerprint of the file as it is, so the file syncs until a token
/// value changes.
pub fn allow(root: &Path, id: &str) -> std::io::Result<()> {
    let bytes = std::fs::read(root.join(format!(".obsidian/plugins/{id}/data.json")))?;
    let Some(fp) = scan(&bytes) else {
        return Ok(());
    };
    let mut map = allowed(root);
    map.insert(id.to_string(), fp);
    let path = prefs_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(&map).map_err(std::io::Error::other)?,
    )
}

/// "Never sync this plugin": the file joins the managed `.gitignore` block.
pub fn never(root: &Path, id: &str) -> std::io::Result<()> {
    super::ignore::add_line(root, &format!(".obsidian/plugins/{id}/data.json"))
}

/// A plugin whose settings are held back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub id: String,
    /// The plugin's name from its manifest, else its id.
    pub name: String,
    pub path: String,
}

fn name_of(root: &Path, id: &str) -> String {
    std::fs::read(root.join(format!(".obsidian/plugins/{id}/manifest.json")))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("name")?.as_str().map(str::to_string))
        .unwrap_or_else(|| id.to_string())
}

/// The held files among `paths` (vault-relative, on disk now).
pub fn held_among<'a>(root: &Path, paths: impl IntoIterator<Item = &'a str>) -> Vec<Held> {
    paths
        .into_iter()
        .filter_map(|rel| {
            let id = plugin_of(rel)?;
            let bytes = std::fs::read(root.join(rel)).ok()?;
            flagged(root, rel, &bytes).then(|| Held {
                id: id.to_string(),
                name: name_of(root, id),
                path: rel.to_string(),
            })
        })
        .collect()
}
