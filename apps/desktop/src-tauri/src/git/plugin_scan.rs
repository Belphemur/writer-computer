//! The pre-push token scan (spec "Plugin settings and secrets", the user 2026-11-20). Plugin
//! settings (`.obsidian/plugins/<id>/data.json`) are synced, but a file that holds a token-like
//! value is held back: it is never committed while a remote exists and never pushed, until the
//! user chooses **Sync anyway** (this file, until its token values change: the fingerprint of
//! them is recorded device-locally in `.writer/git/plugin-scan.json`) or **Never sync this plugin**
//! (the file joins the managed `.gitignore` block).
//!
//! Token-like: a string value, non-empty, under a key named like `token`, `secret`, `password`,
//! `auth`, `bearer`, `apiKey`, `APIToken`, `key` (the last word of a key), at any depth; or any
//! string that holds a JWT (`eyJ….….…`), a `Bearer …` value, a URL with a password
//! (`https://user:pass@host`) or a `key=` / `token=` query parameter; or any string of 40+
//! characters of the base64/hex alphabet that mixes character kinds and looks random. A
//! `data.json` that is not JSON is held back too (it cannot be checked). The scan is local; it
//! reports the plugin id and a fingerprint, never a value, and nothing here logs.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// `<id>` to `.obsidian/plugins/<id>/data.json` (the one spelling of the path; [`plugin_of`] reads
/// it back).
pub fn data_json_path(id: &str) -> String {
    format!(".obsidian/plugins/{id}/data.json")
}

/// `.obsidian/plugins/<id>/data.json` to `<id>`.
pub fn plugin_of(rel: &str) -> Option<&str> {
    let rest = rel.strip_prefix(".obsidian/plugins/")?;
    let (id, file) = rest.split_once('/')?;
    (file == "data.json" && !id.is_empty() && !id.contains('/')).then_some(id)
}

/// The words of a key: `apiKey`, `api_key` and `api-key` are `api`, `key`; an upper-case run is
/// one word up to the capital that starts the next (`APIToken` is `api`, `token`).
fn words(key: &str) -> Vec<String> {
    let chars: Vec<char> = key.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        let prev = i.checked_sub(1).map(|j| chars[j]);
        let next = chars.get(i + 1).copied();
        let lower = |x: Option<char>| x.is_some_and(|x| x.is_lowercase() || x.is_ascii_digit());
        let starts_word = c.is_uppercase()
            && !cur.is_empty()
            && (lower(prev)
                || (prev.is_some_and(char::is_uppercase) && next.is_some_and(char::is_lowercase)));
        if starts_word {
            out.push(std::mem::take(&mut cur));
        }
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

/// A JWT: three base64url parts separated by dots, the first a JSON header (`eyJ`).
fn has_jwt(s: &str) -> bool {
    let url_b64 = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '=');
    s.match_indices("eyJ").any(|(i, _)| {
        let parts: Vec<&str> = s[i..]
            .split(|c: char| !(url_b64(c) || c == '.'))
            .next()
            .unwrap_or("")
            .split('.')
            .collect();
        parts.len() >= 3 && parts[..3].iter().all(|p| p.len() >= 4)
    })
}

/// A credential written into a string: a JWT, `Bearer <x>`, a URL with a password, or a
/// `key=` / `token=`-like query parameter with a value.
fn embedded_secret(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let bearer = lower.match_indices("bearer ").any(|(i, m)| {
        let word = s[i + m.len()..].split_whitespace().next().unwrap_or("");
        word.len() >= 8
            && word.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '+' | '/' | '=')
            })
    });
    let userinfo = lower.match_indices("://").any(|(i, m)| {
        let rest = &s[i + m.len()..];
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        authority
            .rsplit_once('@')
            .and_then(|(user, _)| user.split_once(':'))
            .is_some_and(|(_, pass)| !pass.is_empty())
    });
    const PARAMS: [&str; 8] = [
        "key",
        "token",
        "api_key",
        "apikey",
        "access_token",
        "auth",
        "secret",
        "password",
    ];
    let param = lower.split(['?', '&', '#']).skip(1).any(|pair| {
        pair.split_once('=')
            .is_some_and(|(k, v)| PARAMS.contains(&k) && !v.is_empty())
    });
    has_jwt(s) || bearer || userinfo || param
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
        Value::String(s) if random_looking(s) || embedded_secret(s) => {
            out.insert(s.clone());
        }
        _ => {}
    }
}

/// The fingerprint of the token-like values of a `data.json`, `None` when it holds none. A file
/// that is not JSON cannot be checked: it is flagged, its fingerprint is the whole file's. It
/// changes when a token value does.
pub fn scan(bytes: &[u8]) -> Option<String> {
    let mut found = BTreeSet::new();
    match serde_json::from_slice::<Value>(bytes) {
        Ok(value) => collect(&value, &mut found),
        Err(_) if bytes.iter().all(u8::is_ascii_whitespace) => return None,
        Err(_) => {
            found.insert(String::from_utf8_lossy(bytes).into_owned());
        }
    }
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

const PREFS: &str = "plugin-scan.json";

/// The "Sync anyway" decisions: plugin id to the fingerprint it was allowed with.
fn allowed(root: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(super::local_path(root, PREFS))
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
    let bytes = std::fs::read(root.join(data_json_path(id)))?;
    let Some(fp) = scan(&bytes) else {
        return Ok(());
    };
    let mut map = allowed(root);
    map.insert(id.to_string(), fp);
    super::write_local(
        root,
        PREFS,
        &serde_json::to_string_pretty(&map).map_err(std::io::Error::other)?,
    )
}

/// "Never sync this plugin": the file joins the managed `.gitignore` block.
pub fn never(root: &Path, id: &str) -> std::io::Result<()> {
    super::ignore::add_line(root, &data_json_path(id))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn held(json: &str) -> bool {
        scan(json.as_bytes()).is_some()
    }

    #[test]
    fn upper_case_runs_split_into_words() {
        assert_eq!(words("APIToken"), vec!["api", "token"]);
        assert_eq!(words("apiKey"), vec!["api", "key"]);
        assert_eq!(words("OAuthSecret"), vec!["o", "auth", "secret"]);
        assert_eq!(words("githubPAT"), vec!["github", "pat"]);
        assert!(token_key("APIToken") && token_key("myAPIKey") && !token_key("keyboard"));
    }

    #[test]
    fn credentials_written_into_strings_are_found() {
        for json in [
            r#"{"APIToken":"abc"}"#,
            r#"{"header":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"}"#,
            r#"{"h":"Authorization: Bearer abcdefgh12345678"}"#,
            r#"{"remote":"https://me:s3cret@example.com/repo.git"}"#,
            r#"{"endpoint":"https://api.example.com/v1?key=abc123"}"#,
            r#"{"endpoint":"https://api.example.com/v1?a=1&token=abc123"}"#,
            "not json at all",
            "{\"broken\": ",
        ] {
            assert!(held(json), "{json}");
        }
        for json in [
            r#"{"url":"https://example.com/repo.git"}"#,
            r#"{"url":"https://me@example.com/repo.git"}"#,
            r#"{"q":"https://example.com/search?q=token"}"#,
            r#"{"t":"bearer of good news"}"#,
            r#"{"v":"eyJ"}"#,
            "  \n",
        ] {
            assert!(!held(json), "{json}");
        }
    }

    #[test]
    fn the_data_json_path_round_trips() {
        assert_eq!(plugin_of(&data_json_path("p")), Some("p"));
    }
}
