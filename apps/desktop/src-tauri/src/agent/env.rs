//! The child's environment (spec 8): the app's environment minus anything secret-looking
//! (`plugin_env::secret_looking`, shared with the plugin host), except what the claude CLI itself
//! needs for sign-in and routing; `TERM=dumb`; PATH = the login-shell PATH first, then the app's,
//! then the user-installed `writer` shim's folder (`/usr/local/bin`; also `~/.local/bin` on Linux); the launcher directory of
//! `cli_launcher` (the `writer` command that always works) goes before all of them.
//! Writer's own secrets (the plugin keychain item) are never in the process environment, so
//! there is nothing of ours to leak; `WRITER_*` variables are dropped anyway.
//!
//! The child is started with `env_clear()` plus exactly this list.

use super::events::AgentMemory;
use crate::platform::Os;
use crate::plugin_env::secret_looking;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

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

/// Where "Install 'writer' Command Line Tool" puts the `writer` shim: `/usr/local/bin` on macOS
/// (the parent of `commands::shell_install::INSTALL_TARGET`), `~/.local/bin` on Linux (the parent
/// of `cli_install::user_target`, the one place that path is spelled). Appended last, so a login
/// shell that does not list it (fish without `path_helper`, a GUI launch) still lets the agent's
/// Bash run `writer`.
fn shim_dirs(os: Os, home: Option<&OsStr>) -> Vec<PathBuf> {
    let user = crate::cli_install::user_target(home)
        .and_then(|t| t.parent().map(Path::to_path_buf))
        .filter(|_| os == Os::Linux);
    std::iter::once(PathBuf::from("/usr/local/bin"))
        .chain(user)
        .collect()
}

/// `launcher` first (so a stale user-installed shim never wins), then `login` entries, then `app`,
/// then the `shim` dirs: absolute and unique.
fn merge_path(launcher: Option<&Path>, login: &str, app: &str, shim: Vec<PathBuf>) -> String {
    let mut seen = HashSet::new();
    let dirs: Vec<_> = launcher
        .map(Path::to_path_buf)
        .into_iter()
        .chain(std::env::split_paths(login))
        .chain(std::env::split_paths(app))
        .chain(shim)
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
    child_env_on(Os::current(), vars, login_path, launcher_dir)
}

fn child_env_on(
    os: Os,
    vars: impl Iterator<Item = (String, String)>,
    login_path: &str,
    launcher_dir: Option<&Path>,
) -> Vec<(String, String)> {
    let mut app_path = String::new();
    let mut home = None;
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in vars {
        if v.contains('\0') {
            continue;
        }
        if k == "PATH" {
            app_path = v;
        } else {
            if k == "HOME" {
                home = Some(v.clone());
            }
            if allowed(&k) {
                out.push((k, v));
            }
        }
    }
    let shim = shim_dirs(os, home.as_deref().map(OsStr::new));
    out.push((
        "PATH".into(),
        merge_path(launcher_dir, login_path, &app_path, shim),
    ));
    out.push(("TERM".into(), "dumb".into()));
    out.sort();
    out
}

/// The CLI's own off-switch for auto memory: set for `agent.memory` = `off`, removed for `vault`.
pub const DISABLE_AUTO_MEMORY: &str = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/// `env` as `agent.memory` wants it. The one place Writer touches the switch: `Off` sets it to 1
/// (replacing any value the app's environment carried); `Vault` removes it, so a value from the
/// user's shell cannot silently disable the memory the Writer block tells the agent about;
/// `Default` leaves it as the user has it.
pub fn with_memory_mode(
    mut env: Vec<(String, String)>,
    mode: AgentMemory,
) -> Vec<(String, String)> {
    match mode {
        AgentMemory::Default => {}
        AgentMemory::Vault => env.retain(|(k, _)| k != DISABLE_AUTO_MEMORY),
        AgentMemory::Off => {
            env.retain(|(k, _)| k != DISABLE_AUTO_MEMORY);
            env.push((DISABLE_AUTO_MEMORY.into(), "1".into()));
            env.sort();
        }
    }
    env
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
    fn memory_mode_owns_the_cli_switch() {
        let base = env(&[("HOME", "/h"), (DISABLE_AUTO_MEMORY, "1")]);
        let has =
            |e: &[(String, String)]| e.iter().find(|(k, _)| k == DISABLE_AUTO_MEMORY).cloned();
        let others = |e: &[(String, String)]| {
            e.iter()
                .filter(|(k, _)| k != DISABLE_AUTO_MEMORY)
                .cloned()
                .collect::<Vec<_>>()
        };
        // default: the user's env, untouched
        assert_eq!(with_memory_mode(base.clone(), AgentMemory::Default), base);
        // vault: a value from the user's shell is removed, the rest kept
        let vault = with_memory_mode(base.clone(), AgentMemory::Vault);
        assert!(has(&vault).is_none());
        assert_eq!(others(&vault), others(&base));
        // off: set to 1 exactly once, even over another value, and the list stays sorted
        let other_value = env(&[("HOME", "/h"), (DISABLE_AUTO_MEMORY, "0")]);
        let off = with_memory_mode(other_value.clone(), AgentMemory::Off);
        assert_eq!(
            off.iter().filter(|(k, _)| k == DISABLE_AUTO_MEMORY).count(),
            1
        );
        assert_eq!(has(&off).unwrap().1, "1");
        assert_eq!(others(&off), others(&other_value));
        let mut sorted = off.clone();
        sorted.sort();
        assert_eq!(off, sorted);
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

    #[test]
    fn linux_adds_the_user_shim_dir_last_and_macos_does_not() {
        let path_on = |os: Os, home: &[(&str, &str)]| {
            let vars = [("PATH", "/usr/bin")].iter().chain(home.iter());
            child_env_on(
                os,
                vars.map(|(k, v)| (k.to_string(), v.to_string())),
                "/login/bin",
                None,
            )
            .into_iter()
            .find(|(k, _)| k == "PATH")
            .unwrap()
            .1
        };
        assert_eq!(
            path_on(Os::Linux, &[("HOME", "/home/me")]),
            "/login/bin:/usr/bin:/usr/local/bin:/home/me/.local/bin"
        );
        // already on the login PATH: listed once, where the login shell has it
        let on_login = child_env_on(
            Os::Linux,
            [("HOME", "/home/me"), ("PATH", "/usr/bin")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string())),
            "/home/me/.local/bin",
            None,
        );
        let p = &on_login.iter().find(|(k, _)| k == "PATH").unwrap().1;
        assert_eq!(p, "/home/me/.local/bin:/usr/bin:/usr/local/bin");
        // no HOME: nothing to add; macOS never adds it
        assert_eq!(
            path_on(Os::Linux, &[]),
            "/login/bin:/usr/bin:/usr/local/bin"
        );
        assert_eq!(
            path_on(Os::MacOs, &[("HOME", "/Users/me")]),
            "/login/bin:/usr/bin:/usr/local/bin"
        );
    }
}
