//! The credential helper and `gh`: answers from the secret or `gh auth token`, only for `get` over
//! https, never a token in argv, in an error's details or in a log line.

use super::*;
use crate::features::scope::Spawner;
use crate::git::gh;
use crate::git::transport::{Exec, Helper, Kind, REMOTE};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

const PLANTED: &str = "ghp_PLANTED_token_9f8e7d6c5b4a";

fn ask(args: &[&str], request: &str, token: Option<&str>, gh_token: Option<&str>) -> String {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let (token, gh_token) = (token.map(str::to_string), gh_token.map(str::to_string));
    let (t, g) = (|| token.clone(), |_: &str| gh_token.clone());
    let mut out = Vec::new();
    let code = run(
        &args,
        Cursor::new(request.as_bytes().to_vec()),
        &mut out,
        &Lookup { token: &t, gh: &g },
    );
    assert_eq!(code, 0);
    String::from_utf8(out).unwrap()
}

const GITHUB: &str = "protocol=https\nhost=github.com\nusername=me\n\n";

#[test]
fn the_token_source_answers_get_over_https() {
    let out = ask(&["--source", "token", "get"], GITHUB, Some(PLANTED), None);
    assert_eq!(out, format!("username=me\npassword={PLANTED}\n\n"));
    // no username in the request: a fixed one
    let out = ask(
        &["--source", "token", "get"],
        "protocol=https\nhost=git.example.test\n\n",
        Some("t0ken"),
        None,
    );
    assert_eq!(out, "username=git\npassword=t0ken\n\n");
}

#[test]
fn it_answers_nothing_for_store_erase_http_or_a_missing_token() {
    assert_eq!(
        ask(&["--source", "token", "store"], GITHUB, Some("x"), None),
        ""
    );
    assert_eq!(
        ask(&["--source", "token", "erase"], GITHUB, Some("x"), None),
        ""
    );
    assert_eq!(
        ask(
            &["--source", "token", "get"],
            "protocol=http\nhost=github.com\n\n",
            Some("x"),
            None
        ),
        ""
    );
    assert_eq!(ask(&["--source", "token", "get"], GITHUB, None, None), "");
    // ssh never reaches a helper, but a stray request is refused
    assert_eq!(
        ask(
            &["--source", "token", "get"],
            "protocol=ssh\nhost=github.com\n\n",
            Some("x"),
            None
        ),
        ""
    );
}

#[test]
fn the_gh_source_reads_the_token_at_use_and_only_for_github() {
    let out = ask(
        &["--source", "gh", "get"],
        GITHUB,
        Some("ignored"),
        Some(PLANTED),
    );
    assert_eq!(out, format!("username=me\npassword={PLANTED}\n\n"));
    assert_eq!(
        ask(
            &["--source", "gh", "get"],
            "protocol=https\nhost=gitlab.com\n\n",
            None,
            Some(PLANTED)
        ),
        "",
        "gh's token is for GitHub only"
    );
    assert_eq!(ask(&["--source", "gh", "get"], GITHUB, Some("t"), None), "");
}

#[test]
fn the_helper_registration_names_where_the_token_is_never_the_token() {
    let h = Helper {
        exe: PathBuf::from("/Applications/Writer.app/Contents/MacOS/Writer"),
        source: Source::Token,
        service: "com.writer-computer.plugin-secrets".into(),
    };
    let cfg = h.config();
    assert!(cfg.starts_with("credential.helper=!'/Applications/Writer.app/Contents/MacOS/Writer' git-credential --source token"));
    assert!(!cfg.contains(PLANTED));
    let quoted = Helper {
        exe: PathBuf::from("/Users/o'neil/Writer"),
        source: Source::Gh,
        service: "s".into(),
    };
    assert!(quoted.config().contains("'/Users/o'\\''neil/Writer'"));
    assert_eq!(
        service_of(&[
            "--source".into(),
            "gh".into(),
            "--service".into(),
            "svc".into()
        ]),
        Some("svc")
    );
}

// ---- gh, mocked -----------------------------------------------------------------------------------

fn fake_gh(dir: &Path, script: &str) {
    let path = dir.join("gh");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn exec_with(dir: &Path) -> Exec {
    Exec::new(Spawner::detached()).with_path_prefix(vec![dir.to_path_buf()])
}

#[cfg(unix)]
#[test]
fn gh_state_token_and_repo_creation_run_through_the_fake_gh() {
    let tmp = tempfile::tempdir().unwrap();
    fake_gh(
        tmp.path(),
        &format!(
            r#"case "$1 $2" in
  "--version "*) echo "gh version 9.9.9" ;;
  "auth status") exit 0 ;;
  "auth token") echo {PLANTED} ;;
  "repo create") echo "https://github.com/me/$3" ;;
  *) exit 2 ;;
esac"#
        ),
    );
    let exec = exec_with(tmp.path());
    assert_eq!(gh::state(&exec), gh::State::SignedIn);
    assert_eq!(
        gh::auth_token(&exec, "github.com").as_deref(),
        Some(PLANTED)
    );
    let url = gh::create_repo(&exec, Path::new("/v"), "My-Vault").unwrap();
    assert_eq!(url, "https://github.com/me/My-Vault");
    assert_eq!(gh::repo_name("My Vault / 2026"), "My-Vault---2026");
    assert_eq!(gh::repo_name("   "), "vault");

    fake_gh(
        tmp.path(),
        "case \"$1 $2\" in \"auth status\") exit 1 ;; *) echo gh ;; esac",
    );
    assert_eq!(gh::state(&exec), gh::State::SignedOut);
    // no gh on the path at all
    let none = tempfile::tempdir().unwrap();
    let missing = Exec::new(Spawner::detached()).with_only_path(vec![none.path().to_path_buf()]);
    assert_eq!(gh::state(&missing), gh::State::Missing);
    assert_eq!(
        gh::create_repo(&missing, Path::new("/v"), "x")
            .unwrap_err()
            .kind,
        Kind::NoGit
    );
}

// ---- the planted token never leaks ------------------------------------------------------------------

/// Every log record of the process, so a test can grep for the planted token.
struct Capture(Mutex<Vec<String>>);

impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, r: &log::Record<'_>) {
        self.0.lock().unwrap().push(format!("{}", r.args()));
    }
    fn flush(&self) {}
}

static CAPTURE: Capture = Capture(Mutex::new(Vec::new()));

pub(crate) fn captured() -> Vec<String> {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = log::set_logger(&CAPTURE);
        log::set_max_level(log::LevelFilter::Trace);
    });
    CAPTURE.0.lock().unwrap().clone()
}

#[test]
fn a_planted_token_is_absent_from_argv_details_and_logs() {
    use crate::git::sync::{self, Options};
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let _ = captured();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("vault");
    std::fs::create_dir_all(&root).unwrap();
    crate::git::repo::ISOLATED.with(|i| i.set(true));
    let env = vec![
        (
            "HOME".to_string(),
            tmp.path().to_string_lossy().into_owned(),
        ),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ("GIT_CONFIG_GLOBAL".to_string(), "/dev/null".to_string()),
    ];
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&root)
            .envs(env.iter().map(|(k, v)| (k, v)))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "T"]);
    git(&["config", "user.email", "t@example.test"]);
    // a remote that refuses us: the token sits in the URL the user pasted wrongly, and the helper
    // would answer with the planted token
    git(&[
        "remote",
        "add",
        REMOTE,
        &format!("https://me:{PLANTED}@localhost:1/x.git"),
    ]);
    std::fs::write(root.join("Plan.md"), "x\n").unwrap();
    crate::git::setup(&root, crate::git::SetupMode::Existing, "T").unwrap();

    let helper = Helper {
        exe: PathBuf::from("/opt/Writer"),
        source: Source::Token,
        service: "svc".into(),
    };
    let exec = Exec::new(Spawner::detached()).with_env(env.clone());
    let cmd = exec.git(&root, Some(&helper), &["fetch", "origin"]);
    let argv: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert!(argv.iter().all(|a| !a.contains(PLANTED)), "{argv:?}");
    let envs: Vec<String> = cmd
        .get_envs()
        .map(|(k, v)| format!("{k:?}={v:?}"))
        .collect();
    assert!(envs.iter().all(|e| !e.contains(PLANTED)), "{envs:?}");

    let outcome = sync::sync(
        &root,
        &Options {
            exec: &exec,
            helper: Some(&helper),
            secrets: vec![PLANTED.to_string()],
            device: "T",
            announce: None,
        },
    );
    let err = outcome.error.expect("the remote is unreachable");
    let mut texts = vec![err.to_string(), format!("{err:?}")];
    if let sync::Error::Transport(t) = &err {
        texts.push(t.details.clone());
        texts.push(t.line.clone());
    }
    texts.push(format!("{:?}", outcome.report));
    texts.push(crate::git::sync::remote_info(&root).url.unwrap_or_default());
    for t in &texts {
        assert!(!t.contains(PLANTED), "leaked: {t}");
    }
    for line in captured() {
        assert!(!line.contains(PLANTED), "logged: {line}");
    }
}
