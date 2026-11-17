//! The child's environment (spec 8): the app's environment minus anything secret-looking
//! (`plugin_env::secret_looking`, shared with the plugin host), except what the claude CLI itself
//! needs for sign-in and routing; `TERM=dumb`; PATH = the login-shell PATH first, then the app's.
//! Writer's own secrets (the plugin keychain item) are never in the process environment, so
//! there is nothing of ours to leak; `WRITER_*` variables are dropped anyway.
//!
//! The child is started with `env_clear()` plus exactly this list, so what the consent dialog
//! shows (names only) is what the child gets.

use crate::plugin_env::secret_looking;
use std::collections::HashSet;

/// Secret-looking names the CLI needs: API-key / token auth, and the Bedrock / Vertex settings.
const EXACT: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLOUD_ML_REGION",
];
const PREFIXES: &[&str] = &["CLAUDE_CODE_", "AWS_", "GOOGLE_"];

fn cli_needs(name: &str) -> bool {
    EXACT.contains(&name) || PREFIXES.iter().any(|p| name.starts_with(p))
}

fn allowed(name: &str) -> bool {
    if name.is_empty() || name.contains(['=', '\0']) || name == "PATH" || name == "TERM" {
        return false;
    }
    if name.starts_with("WRITER_") {
        return false;
    }
    !secret_looking(name) || cli_needs(name)
}

/// `login` entries first, then `app`, absolute and unique.
fn merge_path(login: &str, app: &str) -> String {
    let mut seen = HashSet::new();
    let dirs: Vec<_> = std::env::split_paths(login)
        .chain(std::env::split_paths(app))
        .filter(|d| d.is_absolute() && seen.insert(d.clone()))
        .collect();
    std::env::join_paths(dirs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| app.to_string())
}

/// The environment of one spawn, sorted by name. Pure: callers pass the variables.
pub fn child_env(
    vars: impl Iterator<Item = (String, String)>,
    login_path: &str,
) -> Vec<(String, String)> {
    let mut app_path = String::new();
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in vars {
        if v.contains('\0') {
            continue;
        }
        if k == "PATH" {
            app_path = v;
        } else if allowed(&k) {
            out.push((k, v));
        }
    }
    out.push(("PATH".into(), merge_path(login_path, &app_path)));
    out.push(("TERM".into(), "dumb".into()));
    out.sort();
    out
}

/// The running app's environment, with the user's login PATH (cached, blocks up to 10 s the
/// first time: call from a blocking thread).
pub fn current() -> Vec<(String, String)> {
    child_env(
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
        &crate::plugin_env::login_path(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        child_env(
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())),
            "/login/bin:/usr/bin",
        )
    }

    fn names(e: &[(String, String)]) -> Vec<&str> {
        e.iter().map(|(k, _)| k.as_str()).collect()
    }

    #[test]
    fn drops_secrets_but_keeps_what_the_cli_needs() {
        let e = env(&[
            ("HOME", "/h"),
            ("LANG", "en_US.UTF-8"),
            ("GITHUB_TOKEN", "x"),
            ("MY_PASSWORD", "x"),
            ("SOME_SECRET_THING", "x"),
            ("OPENAI_API_KEY", "x"),
            ("ANTHROPIC_API_KEY", "k"),
            ("ANTHROPIC_AUTH_TOKEN", "t"),
            ("ANTHROPIC_BASE_URL", "https://x"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "o"),
            ("CLAUDE_CONFIG_DIR", "/c"),
            ("AWS_SECRET_ACCESS_KEY", "a"),
            ("AWS_REGION", "r"),
            ("GOOGLE_APPLICATION_CREDENTIALS", "/g"),
            ("HTTPS_PROXY", "p"),
            ("WRITER_E2E_EXTRA_PATH", "/e"),
            ("TERM", "xterm"),
        ]);
        let n = names(&e);
        for gone in [
            "GITHUB_TOKEN",
            "MY_PASSWORD",
            "SOME_SECRET_THING",
            "OPENAI_API_KEY",
            "WRITER_E2E_EXTRA_PATH",
        ] {
            assert!(!n.contains(&gone), "{gone} leaked");
        }
        for kept in [
            "HOME",
            "LANG",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CONFIG_DIR",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_REGION",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "HTTPS_PROXY",
        ] {
            assert!(n.contains(&kept), "{kept} missing");
        }
        assert_eq!(e.iter().find(|(k, _)| k == "TERM").unwrap().1, "dumb");
    }

    #[test]
    fn login_path_comes_first_without_duplicates() {
        let e = env(&[("PATH", "/usr/bin:/app/bin:relative")]);
        let path = &e.iter().find(|(k, _)| k == "PATH").unwrap().1;
        assert_eq!(path, "/login/bin:/usr/bin:/app/bin");
    }
}
