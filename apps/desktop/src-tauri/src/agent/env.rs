//! The child's environment (spec 8): the app's environment minus anything secret-looking
//! (`plugin_env::secret_looking`, shared with the plugin host), except what the claude CLI itself
//! needs for sign-in and routing; `TERM=dumb`; PATH = the login-shell PATH first, then the app's,
//! then `/usr/local/bin` (the user-installed `writer` shim); the launcher directory of
//! `cli_launcher` (the `writer` command that always works) goes before all of them.
//! Writer's own secrets (the plugin keychain item) are never in the process environment, so
//! there is nothing of ours to leak; `WRITER_*` variables are dropped anyway.
//!
//! The child is started with `env_clear()` plus exactly this list.

use crate::plugin_env::secret_looking;
use std::collections::HashSet;
use std::path::Path;

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

/// Where "Install 'writer' Command Line Tool" puts the `writer` shim (the parent of
/// `commands::shell_install::INSTALL_TARGET`). Appended last, so a login shell that does not
/// list it (fish without `path_helper`) still lets the agent's Bash run `writer`.
const WRITER_SHIM_DIR: &str = "/usr/local/bin";

/// `launcher` first (so a stale user-installed shim never wins), then `login` entries, then `app`,
/// then [`WRITER_SHIM_DIR`]: absolute and unique.
fn merge_path(launcher: Option<&Path>, login: &str, app: &str) -> String {
    let mut seen = HashSet::new();
    let dirs: Vec<_> = launcher
        .map(Path::to_path_buf)
        .into_iter()
        .chain(std::env::split_paths(login))
        .chain(std::env::split_paths(app))
        .chain(std::iter::once(std::path::PathBuf::from(WRITER_SHIM_DIR)))
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
    launcher_dir: Option<&Path>,
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
    out.push((
        "PATH".into(),
        merge_path(launcher_dir, login_path, &app_path),
    ));
    out.push(("TERM".into(), "dumb".into()));
    out.sort();
    out
}

/// The running app's environment, with the user's login PATH (cached, blocks up to 10 s the
/// first time: call from a blocking thread).
pub fn current(launcher_dir: Option<&Path>) -> Vec<(String, String)> {
    child_env(
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
        &crate::plugin_env::login_path(),
        launcher_dir,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        child_env(
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())),
            "/login/bin:/usr/bin",
            None,
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
        assert_eq!(path, "/login/bin:/usr/bin:/app/bin:/usr/local/bin");
        // already listed: not repeated
        let e = env(&[("PATH", "/usr/local/bin:/usr/bin")]);
        let path = &e.iter().find(|(k, _)| k == "PATH").unwrap().1;
        assert_eq!(path, "/login/bin:/usr/bin:/usr/local/bin");
    }

    #[test]
    fn the_launcher_dir_is_first_and_not_repeated() {
        let path_of = |launcher: &str, app: &str| {
            let e = child_env(
                [("PATH".to_string(), app.to_string())].into_iter(),
                "/login/bin",
                Some(Path::new(launcher)),
            );
            e.into_iter().find(|(k, _)| k == "PATH").unwrap().1
        };
        assert_eq!(
            path_of("/data/bin", "/usr/bin"),
            "/data/bin:/login/bin:/usr/bin:/usr/local/bin"
        );
        // already on the app's PATH: still first, listed once
        assert_eq!(
            path_of("/usr/bin", "/usr/bin:/x"),
            "/usr/bin:/login/bin:/x:/usr/local/bin"
        );
    }
}
