//! The table of forge CLIs and each entry, against a fake `gh` / `fj` on the search path and a
//! fake saved login in a temporary home: no real login is read and nothing touches the network.

use super::*;
use crate::features::scope::Spawner;
use crate::git::forgejo::{self, Saved};
use std::path::{Path, PathBuf};

const PLANTED: &str = "ghp_PLANTED_token_9f8e7d6c5b4a";
const FJ_TOKEN: &str = "fjtoken_PLANTED_1a2b3c4d5e6f";
const FJ_NEW: &str = "fjtoken_REFRESHED_6f5e4d3c2b1a";

fn fake(dir: &Path, binary: &str, script: &str) {
    let path = dir.join(binary);
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

// ---- the table ----------------------------------------------------------------------------------

#[test]
fn the_table_has_github_and_forgejo_and_their_labels_live_in_it() {
    let ids: Vec<&str> = FORGES.iter().map(|f| f.id).collect();
    assert_eq!(ids, ["gh", "fj"]);
    assert_eq!(by_id("gh"), Some(&GITHUB));
    assert_eq!(by_id("fj"), Some(&FORGEJO));
    assert!(by_id("token").is_none() && by_id("hg").is_none());
    assert_eq!(GITHUB.sign_in(), "Sign in with GitHub");
    assert_eq!(GITHUB.install(), "Install GitHub CLI");
    assert_eq!(GITHUB.login, "gh auth login");
    assert_eq!(FORGEJO.sign_in(), "Sign in with Forgejo");
    assert_eq!(FORGEJO.install(), "Install Forgejo CLI");
    assert_eq!(FORGEJO.login, "fj auth login");
    for f in FORGES {
        assert_eq!(f.id, f.binary, "the source's name is the program's");
        assert!(f.install_url.starts_with("https://"));
    }
    // the repository is created private, by name, on gh's own host or on the host asked for
    assert_eq!(
        (GITHUB.create)(None, "Vault"),
        ["repo", "create", "Vault", "--private"]
    );
    assert_eq!(
        (FORGEJO.create)(Some("codeberg.org"), "Vault"),
        ["-H", "codeberg.org", "repo", "create", "Vault", "--private"]
    );
    assert_eq!(
        (FORGEJO.create)(None, "Vault"),
        ["repo", "create", "Vault", "--private"]
    );
    assert!(!GITHUB.expires && FORGEJO.expires);
    assert_eq!(repo_name("My Vault / 2026"), "My-Vault---2026");
    assert_eq!(repo_name("   "), "vault");
}

#[test]
fn gh_answers_for_github_hosts_and_fj_for_the_bound_host() {
    let gh = GITHUB.accepts;
    assert!(gh("github.com", None) && gh("octo.ghe.com", None) && gh("api.github.com", None));
    assert!(!gh("gitlab.com", None) && !gh("evilgithub.com", None));
    let fj = FORGEJO.accepts;
    assert!(fj("codeberg.org", Some("Codeberg.org")));
    assert!(!fj("codeberg.org", None));
    assert!(!fj("codeberg.org", Some("git.example.test")));
    assert!(!fj("github.com", None));
}

// ---- gh, mocked (moved from the credential tests; behaviour unchanged) ----------------------------

#[cfg(unix)]
#[test]
fn gh_state_token_and_repo_creation_run_through_the_fake_gh() {
    let tmp = tempfile::tempdir().unwrap();
    fake(
        tmp.path(),
        "gh",
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
    let p = probe(&exec, &GITHUB);
    assert_eq!((p.state, p.hosts), (State::SignedIn, Vec::new()));
    assert_eq!(
        (GITHUB.token)(&exec, "github.com").as_deref(),
        Some(PLANTED)
    );
    let url = create_repo(&exec, Path::new("/v"), &GITHUB, None, "My-Vault").unwrap();
    assert_eq!(url, "https://github.com/me/My-Vault");

    fake(
        tmp.path(),
        "gh",
        "case \"$1 $2\" in \"auth status\") exit 1 ;; *) echo gh ;; esac",
    );
    assert_eq!(probe(&exec, &GITHUB).state, State::SignedOut);
    // no gh on the path at all
    let none = tempfile::tempdir().unwrap();
    let missing = Exec::new(Spawner::detached()).with_only_path(vec![none.path().to_path_buf()]);
    assert_eq!(probe(&missing, &GITHUB).state, State::Missing);
    let err = create_repo(&missing, Path::new("/v"), &GITHUB, None, "x").unwrap_err();
    assert_eq!(err.kind, Kind::NoGit);
    assert_eq!(err.line, "GitHub CLI is not installed");
}

// ---- fj: the saved login ---------------------------------------------------------------------------

const FUTURE: &str = "[2999,1,0,0,0,0,0,0,0]";
const PAST: &str = "[2000,1,0,0,0,0,0,0,0]";

fn keys(codeberg: &str) -> String {
    format!(
        r#"{{"hosts":{{
  "other.example":{{"type":"Application","token":"fj_OTHER_HOST_token_000"}},
  "codeberg.org":{codeberg},
  "git.example.test:3000":{{"type":"Application","token":"fj_THIRD_token_111"}}}},
  "aliases":{{}},"default_ssh":[]}}"#
    )
}

fn oauth(expires: &str, token: &str) -> String {
    format!(
        r#"{{"type":"OAuth","token":"{token}","refresh_token":"fj_REFRESH_secret","expires_at":{expires}}}"#
    )
}

fn login_in(dir: &Path, text: &str) -> PathBuf {
    let path = dir.join("keys.json");
    std::fs::write(&path, text).unwrap();
    path
}

#[test]
fn the_saved_login_gives_the_token_of_the_asked_host_only() {
    let tmp = tempfile::tempdir().unwrap();
    let app = r#"{"type":"Application","token":"fj_APP_token"}"#;
    let path = login_in(tmp.path(), &keys(app));
    let now = 1_795_428_000;
    let token = |host: &str| match forgejo::saved(&path, host, now) {
        Saved::Token(t) => Some(t.expose().to_string()),
        _ => None,
    };
    assert_eq!(token("codeberg.org").as_deref(), Some("fj_APP_token"));
    assert_eq!(token("CODEBERG.org").as_deref(), Some("fj_APP_token"));
    assert_eq!(
        token("git.example.test:3000").as_deref(),
        Some("fj_THIRD_token_111")
    );
    // a host with no login, and a host that is only a prefix of one
    assert_eq!(token("unknown.example"), None);
    assert_eq!(token("codeberg"), None);
    assert_eq!(
        token("git.example.test"),
        None,
        "the port is part of the host"
    );
    // the token never reaches a Debug rendering
    let shown = format!("{:?}", forgejo::saved(&path, "codeberg.org", now));
    assert!(!shown.contains("fj_APP_token"), "{shown}");
}

#[test]
fn an_oauth_login_is_a_token_until_it_expires() {
    let tmp = tempfile::tempdir().unwrap();
    let now = 1_795_428_000; // 2026-11-23T10:00:00Z
    let at = |expires: &str| {
        let path = login_in(tmp.path(), &keys(&oauth(expires, FJ_TOKEN)));
        forgejo::saved(&path, "codeberg.org", now)
    };
    assert!(matches!(at(FUTURE), Saved::Token(_)));
    assert_eq!(at(PAST), Saved::Expired);
    // the tuple's boundary, the human-readable string and an offset all agree on the instant
    assert_eq!(
        at("[2026,327,10,0,0,0,0,0,0]"),
        Saved::Expired,
        "expired at the instant"
    );
    assert!(matches!(at("[2026,327,10,0,1,0,0,0,0]"), Saved::Token(_)));
    assert!(matches!(
        at("\"2026-11-23 10:00:01.0 +00:00:00\""),
        Saved::Token(_)
    ));
    assert_eq!(at("\"2026-11-23 10:00:00.0 +00:00:00\""), Saved::Expired);
    assert!(matches!(
        at("\"2026-11-23T11:00:01+01:00\""),
        Saved::Token(_)
    ));
    assert_eq!(at("\"2026-11-23T10:00:00Z\""), Saved::Expired);
    // an expiry nobody can read is treated as expired, never as valid
    assert_eq!(at("\"someday\""), Saved::Expired);
    assert_eq!(at("42"), Saved::Expired);
    assert_eq!(at("null"), Saved::Expired);
    let v: serde_json::Value = serde_json::from_str("[2026,327,10,0,0,0,0,0,0]").unwrap();
    assert_eq!(forgejo::unix_seconds(&v), Some(now));
    let v: serde_json::Value = serde_json::from_str("\"2026-11-23T11:00:00+01:00\"").unwrap();
    assert_eq!(forgejo::unix_seconds(&v), Some(now));
}

#[test]
fn a_malformed_or_unknown_login_is_no_token() {
    let tmp = tempfile::tempdir().unwrap();
    let now = 1_795_428_000;
    let none = |text: &str| {
        let path = login_in(tmp.path(), text);
        assert_eq!(
            forgejo::saved(&path, "codeberg.org", now),
            Saved::None,
            "{text}"
        );
    };
    none("");
    none("not json");
    none("[]");
    none(r#"{"hosts":[]}"#);
    none(r#"{"hosts":{"codeberg.org":"a string"}}"#);
    none(r#"{"hosts":{"codeberg.org":{"type":"Application"}}}"#);
    none(r#"{"hosts":{"codeberg.org":{"type":"Application","token":""}}}"#);
    none(r#"{"hosts":{"codeberg.org":{"type":"Application","token":"a\nb"}}}"#);
    none(r#"{"hosts":{"codeberg.org":{"type":"Passkey","token":"x"}}}"#);
    none(r#"{"hosts":{"codeberg.org":{"type":"OAuth"}}}"#);
    none(r#"{"hosts":{"codeberg.org":{"type":"Application","token":7}}}"#);
    none(r#"{"somewhere":{"codeberg.org":{"type":"Application","token":"x"}}}"#);
    // a missing file and a directory
    assert_eq!(
        forgejo::saved(&tmp.path().join("absent.json"), "codeberg.org", now),
        Saved::None
    );
    assert_eq!(forgejo::saved(tmp.path(), "codeberg.org", now), Saved::None);
    // a file that is far too large is not the login file
    let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(2 << 20));
    none(&big);
}

#[test]
fn the_login_file_is_where_fj_keeps_it() {
    let env = |home: &'static str, xdg: Option<&'static str>| {
        move |name: &str| match name {
            "HOME" => Some(home.into()),
            "XDG_DATA_HOME" => xdg.map(Into::into),
            "APPDATA" => Some("/appdata".into()),
            _ => None,
        }
    };
    let file = forgejo::login_file(&env("/home/me", Some("/data")));
    let plain = forgejo::login_file(&env("/home/me", None));
    let relative = forgejo::login_file(&env("/home/me", Some("relative/data")));
    let no_home = forgejo::login_file(&|_| None);
    if cfg!(target_os = "macos") {
        let expected = "/home/me/Library/Application Support/forgejo-cli.forgejo-cli/keys.json";
        assert_eq!(file, Some(PathBuf::from(expected)));
        assert_eq!(plain, file);
    } else if cfg!(windows) {
        assert!(file.is_some());
    } else {
        assert_eq!(file, Some(PathBuf::from("/data/forgejo-cli/keys.json")));
        assert_eq!(
            plain,
            Some(PathBuf::from("/home/me/.local/share/forgejo-cli/keys.json"))
        );
        // a relative XDG_DATA_HOME is ignored, as the `directories` crate does
        assert_eq!(relative, plain);
    }
    assert_eq!(no_home, None);
}

#[test]
fn the_hosts_of_fj_auth_list_are_plain_hosts() {
    assert_eq!(
        forgejo::hosts_in("codeberg.org\ngit.example.test:3000\n  codeberg.org  \nCODEBERG.ORG\n"),
        ["codeberg.org", "git.example.test:3000"]
    );
    // a localized message, a URL, a path, an option-looking line and blanks are not hosts
    assert!(forgejo::hosts_in(
        "\nYou are not logged in\nhttps://codeberg.org\nexample.com/sub\n-H\n--help\n"
    )
    .is_empty());
}

// ---- fj, mocked -------------------------------------------------------------------------------------

/// A temporary home with a login file in the place `fj` keeps it, a log of the fake's arguments,
/// and an `Exec` whose children and lookups see that home.
struct Fj {
    _tmp: tempfile::TempDir,
    bin: PathBuf,
    log: PathBuf,
    keys: PathBuf,
    exec: Exec,
}

fn fj_home(login: Option<&str>, script: &dyn Fn(&Fj) -> String) -> Fj {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let xdg = tmp.path().join("xdg");
    let bin = tmp.path().join("bin");
    for d in [&home, &xdg, &bin] {
        std::fs::create_dir_all(d).unwrap();
    }
    let env = vec![
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
        (
            "XDG_DATA_HOME".to_string(),
            xdg.to_string_lossy().into_owned(),
        ),
    ];
    let exec = exec_with(&bin).with_env(env);
    let keys = forgejo::login_file(&|n| exec.var(n)).unwrap();
    std::fs::create_dir_all(keys.parent().unwrap()).unwrap();
    if let Some(text) = login {
        std::fs::write(&keys, text).unwrap();
    }
    let fj = Fj {
        log: tmp.path().join("argv.log"),
        _tmp: tmp,
        bin,
        keys,
        exec,
    };
    fake(&fj.bin, "fj", &script(&fj));
    fj
}

fn argv(fj: &Fj) -> String {
    std::fs::read_to_string(&fj.log).unwrap_or_default()
}

#[cfg(unix)]
#[test]
fn fj_state_hosts_and_repo_creation_run_through_the_fake_fj() {
    let fj = fj_home(None, &|f| {
        format!(
            r#"echo "$@" >> '{log}'
case "$1 $2" in
  "version ") echo "fj v0.7.0" ;;
  "auth list") printf 'codeberg.org\ngit.example.test:3000\n' ;;
  "-H codeberg.org") echo "Created repository at https://codeberg.org/me/$5." ;;
  *) exit 2 ;;
esac"#,
            log = f.log.display()
        )
    });
    let p = probe(&fj.exec, &FORGEJO);
    assert_eq!(p.state, State::SignedIn);
    assert_eq!(p.hosts, ["codeberg.org", "git.example.test:3000"]);
    let url = create_repo(
        &fj.exec,
        Path::new("/v"),
        &FORGEJO,
        Some("codeberg.org"),
        "My-Vault",
    )
    .unwrap();
    assert_eq!(url, "https://codeberg.org/me/My-Vault");
    let log = argv(&fj);
    assert!(
        log.contains("-H codeberg.org repo create My-Vault --private\n"),
        "{log}"
    );
    assert!(
        log.contains("auth list\n") && log.contains("version\n"),
        "{log}"
    );
}

#[cfg(unix)]
#[test]
fn fj_signed_out_has_no_hosts_and_a_failed_creation_is_explained() {
    // installed, but `auth list` prints nothing (the message goes to stderr) and exits 0
    let out = fj_home(None, &|_| {
        r#"case "$1 $2" in
  "version ") echo "fj v0.7.0" ;;
  "auth list") echo "no hosts" >&2 ;;
  "-H codeberg.org") echo "error: not logged in" >&2; exit 1 ;;
esac"#
            .to_string()
    });
    let p = probe(&out.exec, &FORGEJO);
    assert_eq!((p.state, p.hosts), (State::SignedOut, Vec::new()));
    let err = create_repo(
        &out.exec,
        Path::new("/v"),
        &FORGEJO,
        Some("codeberg.org"),
        "v",
    )
    .unwrap_err();
    assert_eq!(err.kind, Kind::Other);
    // `fj` answering without a URL
    let quiet = fj_home(None, &|_| "exit 0".to_string());
    let err = create_repo(
        &quiet.exec,
        Path::new("/v"),
        &FORGEJO,
        Some("codeberg.org"),
        "v",
    )
    .unwrap_err();
    assert_eq!(err.line, "Forgejo did not return the repository URL");
    // no fj at all
    let none = tempfile::tempdir().unwrap();
    let missing = Exec::new(Spawner::detached()).with_only_path(vec![none.path().to_path_buf()]);
    assert_eq!(probe(&missing, &FORGEJO).state, State::Missing);
    let err = create_repo(
        &missing,
        Path::new("/v"),
        &FORGEJO,
        Some("codeberg.org"),
        "v",
    )
    .unwrap_err();
    assert_eq!(
        (err.kind, err.line.as_str()),
        (Kind::NoGit, "Forgejo CLI is not installed")
    );
}

#[cfg(unix)]
#[test]
fn fj_token_is_read_at_use_for_the_right_host_and_never_passed_in_argv() {
    let login = keys(r#"{"type":"Application","token":"fjtoken_PLANTED_1a2b3c4d5e6f"}"#);
    let fj = fj_home(Some(&login), &|f| {
        format!("echo \"$@\" >> '{}'", f.log.display())
    });
    assert_eq!(
        (FORGEJO.token)(&fj.exec, "codeberg.org").as_deref(),
        Some(FJ_TOKEN)
    );
    assert_eq!(
        (FORGEJO.token)(&fj.exec, "git.example.test:3000").as_deref(),
        Some("fj_THIRD_token_111")
    );
    // a host that has no login, and a hostile one, get nothing
    assert_eq!((FORGEJO.token)(&fj.exec, "unknown.example"), None);
    assert_eq!((FORGEJO.token)(&fj.exec, "evil.example --help"), None);
    assert_eq!((FORGEJO.token)(&fj.exec, ""), None);
    // a valid token never runs fj at all, so there is no argv for it to leak into
    assert_eq!(argv(&fj), "");
    // the file is read-only to Writer
    assert_eq!(std::fs::read_to_string(&fj.keys).unwrap(), login);
    // a malformed file gives nothing
    std::fs::write(&fj.keys, "{ nope").unwrap();
    assert_eq!((FORGEJO.token)(&fj.exec, "codeberg.org"), None);
    // no file gives nothing
    std::fs::remove_file(&fj.keys).unwrap();
    assert_eq!((FORGEJO.token)(&fj.exec, "codeberg.org"), None);
}

#[cfg(unix)]
#[test]
fn an_expired_fj_token_is_refreshed_by_fj_once_then_read_again() {
    let expired = keys(&oauth(PAST, FJ_TOKEN));
    let fresh = keys(&oauth(FUTURE, FJ_NEW));
    // the fake `fj -H <host> whoami` saves a refreshed login, as the real one does
    let fj = fj_home(Some(&expired), &|f| {
        let fresh_file = f.keys.with_file_name("fresh.json");
        std::fs::write(&fresh_file, &fresh).unwrap();
        format!(
            r#"echo "$@" >> '{log}'
case "$1 $3" in
  "-H whoami") cp '{fresh}' '{keys}' ;;
esac"#,
            log = f.log.display(),
            fresh = fresh_file.display(),
            keys = f.keys.display()
        )
    });
    assert_eq!(
        (FORGEJO.token)(&fj.exec, "codeberg.org").as_deref(),
        Some(FJ_NEW)
    );
    assert_eq!(argv(&fj), "-H codeberg.org whoami\n", "one bounded refresh");
    // now valid: a second read runs nothing
    assert_eq!(
        (FORGEJO.token)(&fj.exec, "codeberg.org").as_deref(),
        Some(FJ_NEW)
    );
    assert_eq!(argv(&fj), "-H codeberg.org whoami\n");
    let log = argv(&fj);
    assert!(!log.contains(FJ_TOKEN) && !log.contains(FJ_NEW));
}

#[cfg(unix)]
#[test]
fn an_fj_token_that_cannot_be_refreshed_is_no_token_after_one_try() {
    let expired = keys(&oauth(PAST, FJ_TOKEN));
    // `fj` fails (offline, refresh token revoked) and leaves the file as it was
    let fj = fj_home(Some(&expired), &|f| {
        format!("echo \"$@\" >> '{}'\nexit 1", f.log.display())
    });
    assert_eq!((FORGEJO.token)(&fj.exec, "codeberg.org"), None);
    assert_eq!(argv(&fj), "-H codeberg.org whoami\n", "tried once, no loop");
    // no fj on the path: the same, without a crash
    let none = tempfile::tempdir().unwrap();
    let exec = Exec::new(Spawner::detached())
        .with_only_path(vec![none.path().to_path_buf()])
        .with_env(fj.exec_env());
    assert_eq!((FORGEJO.token)(&exec, "codeberg.org"), None);
    // an Application login never expires and never refreshes
    let app = keys(r#"{"type":"Application","token":"fj_APP_token"}"#);
    std::fs::write(&fj.keys, app).unwrap();
    std::fs::remove_file(&fj.log).unwrap();
    assert_eq!(
        (FORGEJO.token)(&fj.exec, "codeberg.org").as_deref(),
        Some("fj_APP_token")
    );
    assert_eq!(argv(&fj), "");
}

impl Fj {
    /// The environment the fake home was built with (for a runner with another search path).
    fn exec_env(&self) -> Vec<(String, String)> {
        ["HOME", "XDG_DATA_HOME"]
            .into_iter()
            .map(|k| {
                (
                    k.to_string(),
                    self.exec.var(k).unwrap().to_string_lossy().into_owned(),
                )
            })
            .collect()
    }
}
