//! The credential helper and the forge CLIs' sources: answers from the secret or `gh auth token`, only for `get` over
//! https, never a token in argv, in an error's details or in a log line.

use super::*;
use crate::features::scope::Spawner;
use crate::git::forge::{self, FORGEJO as FJ, GITHUB as GH};
use crate::git::transport::{self, Exec, Helper, REMOTE};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{Mutex, Once};

const PLANTED: &str = "ghp_PLANTED_token_9f8e7d6c5b4a";

/// `cli_token` answers for whichever forge CLI the source names (the table's functions are the
/// real ones; here only the token's origin is replaced).
fn ask(args: &[&str], request: &str, token: Option<&str>, cli_token: Option<&str>) -> String {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let (token, cli_token) = (token.map(str::to_string), cli_token.map(str::to_string));
    let (t, c) = (|| token.clone(), |_: &Forge, _: &str| cli_token.clone());
    let mut out = Vec::new();
    let code = run(
        &args,
        Cursor::new(request.as_bytes().to_vec()),
        &mut out,
        &Lookup { token: &t, cli: &c },
    );
    assert_eq!(code, 0);
    String::from_utf8(out).unwrap()
}

const GITHUB: &str = "protocol=https\nhost=github.com\nusername=me\n\n";
const GITHUB_REQ: &str = "protocol=https\nhost=github.com\n\n";

#[test]
fn the_token_source_answers_get_over_https() {
    let out = ask(
        &["--source", "token", "--host", "github.com", "get"],
        GITHUB,
        Some(PLANTED),
        None,
    );
    assert_eq!(out, format!("username=me\npassword={PLANTED}\n\n"));
    // no username in the request: a fixed one
    let out = ask(
        &["--source", "token", "--host", "git.example.test", "get"],
        "protocol=https\nhost=git.example.test\n\n",
        Some("t0ken"),
        None,
    );
    assert_eq!(out, "username=git\npassword=t0ken\n\n");
}

#[test]
fn the_token_answers_only_the_host_it_was_saved_for() {
    let other = "protocol=https\nhost=evil.example\n\n";
    assert_eq!(
        ask(
            &["--source", "token", "--host", "github.com", "get"],
            other,
            Some(PLANTED),
            None
        ),
        ""
    );
    // no recorded host: no answer at all
    assert_eq!(
        ask(&["--source", "token", "get"], GITHUB, Some(PLANTED), None),
        ""
    );
    assert_eq!(
        transport::https_host("https://me@GitHub.com:443/o/r.git").as_deref(),
        Some("github.com:443")
    );
    assert_eq!(transport::https_host("git@github.com:o/r.git"), None);
}

#[test]
fn it_answers_nothing_for_store_erase_http_or_a_missing_token() {
    assert_eq!(
        ask(
            &["--source", "token", "--host", "github.com", "store"],
            GITHUB,
            Some("x"),
            None
        ),
        ""
    );
    assert_eq!(
        ask(
            &["--source", "token", "--host", "github.com", "erase"],
            GITHUB,
            Some("x"),
            None
        ),
        ""
    );
    assert_eq!(
        ask(
            &["--source", "token", "--host", "github.com", "get"],
            "protocol=http\nhost=github.com\n\n",
            Some("x"),
            None
        ),
        ""
    );
    assert_eq!(
        ask(
            &["--source", "token", "--host", "github.com", "get"],
            GITHUB,
            None,
            None
        ),
        ""
    );
    // ssh never reaches a helper, but a stray request is refused
    assert_eq!(
        ask(
            &["--source", "token", "--host", "github.com", "get"],
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
fn the_fj_source_answers_only_the_host_the_vault_is_bound_to() {
    let codeberg = "protocol=https\nhost=codeberg.org\nusername=me\n\n";
    let out = ask(
        &["--source", "fj", "--host", "codeberg.org", "get"],
        codeberg,
        Some("ignored"),
        Some(PLANTED),
    );
    assert_eq!(out, format!("username=me\npassword={PLANTED}\n\n"));
    // the host is compared without case
    let loud = "protocol=https\nhost=Codeberg.ORG\n\n";
    assert_eq!(
        ask(
            &["--source", "fj", "--host", "codeberg.org", "get"],
            loud,
            None,
            Some(PLANTED)
        ),
        format!("username=git\npassword={PLANTED}\n\n")
    );
    // another host, even a Forgejo one, gets nothing
    assert_eq!(
        ask(
            &["--source", "fj", "--host", "codeberg.org", "get"],
            "protocol=https\nhost=evil.example\n\n",
            None,
            Some(PLANTED)
        ),
        ""
    );
    // not bound to any host: no answer at all, GitHub included
    assert_eq!(
        ask(&["--source", "fj", "get"], codeberg, None, Some(PLANTED)),
        ""
    );
    assert_eq!(
        ask(&["--source", "fj", "get"], GITHUB_REQ, None, Some(PLANTED)),
        ""
    );
    // http, store and a missing token
    assert_eq!(
        ask(
            &["--source", "fj", "--host", "codeberg.org", "get"],
            "protocol=http\nhost=codeberg.org\n\n",
            None,
            Some(PLANTED)
        ),
        ""
    );
    assert_eq!(
        ask(
            &["--source", "fj", "--host", "codeberg.org", "store"],
            codeberg,
            None,
            Some(PLANTED)
        ),
        ""
    );
    assert_eq!(
        ask(
            &["--source", "fj", "--host", "codeberg.org", "get"],
            codeberg,
            None,
            None
        ),
        ""
    );
}

#[test]
fn the_sources_are_the_tables_and_the_helper_names_them() {
    assert_eq!(Source::parse("token"), Some(Source::Token));
    assert_eq!(Source::parse("gh"), Some(Source::Cli(&GH)));
    assert_eq!(Source::parse("fj"), Some(Source::Cli(&FJ)));
    assert_eq!(Source::parse("hg"), None);
    for f in forge::FORGES {
        assert_eq!(Source::Cli(f).arg(), f.id);
    }
    let h = Helper {
        exe: PathBuf::from("/opt/Writer"),
        source: Source::Cli(&FJ),
        service: "svc".into(),
        host: Some("codeberg.org".into()),
    };
    let args = h.config_args();
    assert!(args[3].contains("--source fj"), "{args:?}");
    assert!(args[3].ends_with("--host 'codeberg.org'"), "{args:?}");
    assert_eq!(
        h.sign_in_again().as_deref(),
        Some("Sign in again: fj auth login")
    );
    let gh = Helper {
        source: Source::Cli(&GH),
        ..h.clone()
    };
    assert_eq!(gh.sign_in_again(), None, "gh's behaviour is unchanged");
}

#[test]
fn the_helper_registration_names_where_the_token_is_never_the_token() {
    let h = Helper {
        exe: PathBuf::from("/Applications/Writer.app/Contents/MacOS/Writer"),
        source: Source::Token,
        service: "com.writer-computer.plugin-secrets".into(),
        host: Some("github.com".into()),
    };
    let args = h.config_args();
    // the user's helpers are cleared first, then Writer's is the only one
    assert_eq!(args[..3], ["-c", "credential.helper=", "-c"]);
    assert!(args[3].starts_with("credential.helper=!'/Applications/Writer.app/Contents/MacOS/Writer' git-credential --source token"));
    assert!(args[3].ends_with("--host 'github.com'"));
    assert!(args.iter().all(|a| !a.contains(PLANTED)));
    let quoted = Helper {
        exe: PathBuf::from("/Users/o'neil/Writer"),
        source: Source::Cli(&GH),
        service: "s".into(),
        host: None,
    };
    assert!(quoted.config_args()[3].contains("'/Users/o'\\''neil/Writer'"));
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
        host: Some("localhost:1".into()),
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
            unlocked: None,
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

/// git's own `store` after a success reaches every helper in the list: with Writer's registration
/// the user's `store` helper (here git's `store`, configured globally) never sees the password.
#[test]
fn the_users_helpers_never_store_writers_token() {
    if !crate::git::sync::tests::have_git() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    let global = home.join("gitconfig");
    std::fs::write(&global, "[credential]\n\thelper = store\n").unwrap();
    let approve = |extra: &[String]| {
        use std::io::Write;
        let mut child = std::process::Command::new("git")
            .args(extra)
            .args(["credential", "approve"])
            .env("HOME", home)
            .env("XDG_CONFIG_HOME", home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &global)
            .current_dir(home)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                format!("protocol=https\nhost=example.test\nusername=git\npassword={PLANTED}\n\n")
                    .as_bytes(),
            )
            .unwrap();
        assert!(child.wait().unwrap().success());
    };
    let helper = Helper {
        exe: PathBuf::from("/bin/true"),
        source: Source::Token,
        service: "svc".into(),
        host: Some("example.test".into()),
    };
    approve(&helper.config_args());
    let stored = home.join(".git-credentials");
    assert!(
        std::fs::read_to_string(&stored).map_or(true, |t| !t.contains(PLANTED)),
        "the user's store helper got the token"
    );
    // the control: without the reset, git's store does write it
    approve(&[]);
    assert!(std::fs::read_to_string(&stored).unwrap().contains(PLANTED));
}
