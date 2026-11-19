//! What counts as a URL property value (spec: `SPECs/properties-types-spec.md` "URL"): the one
//! predicate of the Rust side, the twin of `src/lib/url-value.ts`; both tests read
//! `shared/url-vectors.json`. Pure and Tauri-free.
//!
//! A URL is, with no whitespace or control character anywhere, either an address of one of the
//! schemes Writer hands to the system browser (`shared/external-protocols.json`: an authority
//! scheme needs a non-empty host after `//`, the mail scheme needs `local@domain`), or a bare
//! domain (ASCII labels, a TLD of 2+ letters, optional port and path) which opens as `https`,
//! unless the whole value is `name.ext` of a vault file (`notes.md`, `photo.png`).
//! Anything else (`javascript:`, `ftp:`, `file:`) is not a URL.

use std::sync::OnceLock;

/// Extensions of vault files, from the shared lists (image import and render types, the code-files
/// `neverExtensions` such as `md` and `base`, and `shared/vault-file-extensions.json`): a bare
/// `name.ext` with one of them is a file name, not a domain.
fn file_extensions() -> &'static std::collections::HashSet<String> {
    static SET: OnceLock<std::collections::HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        let read = |text: &str, keys: &[&str]| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(text).expect("shared list is valid");
            keys.iter()
                .flat_map(|k| v[*k].as_array().cloned().unwrap_or_default())
                .filter_map(|e| e.as_str().map(str::to_ascii_lowercase))
                .collect()
        };
        let mut all = read(
            include_str!("../../shared/attachments.json"),
            &["importExtensions", "renderExtensions"],
        );
        all.extend(read(
            include_str!("../../shared/code-files.json"),
            &["neverExtensions"],
        ));
        all.extend(read(
            include_str!("../../shared/vault-file-extensions.json"),
            &["extensions"],
        ));
        all.into_iter().collect()
    })
}

fn is_file_name(value: &str) -> bool {
    !value.contains(['/', '?', '#', ':'])
        && !value.to_ascii_lowercase().starts_with("www.")
        && value
            .rsplit_once('.')
            .is_some_and(|(_, ext)| file_extensions().contains(&ext.to_ascii_lowercase()))
}

fn bare_domain() -> &'static regex_lite::Regex {
    static RE: OnceLock<regex_lite::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex_lite::Regex::new(
            r"(?i)^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::[0-9]{1,5})?(?:[/?#]\S*)?$",
        )
        .expect("valid domain pattern")
    })
}

/// The address handed to the system browser for `value`, or `None` when it is not a URL. A bare
/// domain gains `https://`; any other URL is returned as written.
pub fn href(value: &str) -> Option<String> {
    if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    for s in crate::plugin_env::external_schemes() {
        let Some(rest) = lower
            .strip_prefix(s.scheme.as_str())
            .and_then(|r| r.strip_prefix(':'))
        else {
            continue;
        };
        let ok = if s.authority {
            rest.strip_prefix("//")
                .is_some_and(|host| !host.starts_with(['/', '?', '#']) && !host.is_empty())
        } else {
            let (address, _query) = rest.split_once('?').unwrap_or((rest, ""));
            matches!(address.split_once('@'),
                Some((local, domain)) if !local.is_empty() && !domain.is_empty() && !domain.contains('@'))
        };
        return ok.then(|| value.to_owned());
    }
    (bare_domain().is_match(value) && !is_file_name(value)).then(|| format!("https://{value}"))
}

/// Whether `value` is a URL.
pub fn is_url(value: &str) -> bool {
    href(value).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_predicate_matches_the_shared_vectors() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/url-vectors.json")).unwrap();
        for c in v["valid"].as_array().unwrap() {
            let (value, want) = (c["value"].as_str().unwrap(), c["href"].as_str().unwrap());
            assert_eq!(
                href(value).as_deref(),
                Some(want),
                "{value:?} should be a URL"
            );
            assert!(is_url(value));
        }
        for c in v["invalid"].as_array().unwrap() {
            let value = c.as_str().unwrap();
            assert!(!is_url(value), "{value:?} should not be a URL");
        }
    }
}
