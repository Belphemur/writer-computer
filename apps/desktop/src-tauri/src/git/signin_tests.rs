//! The one sign-in action against a real temporary repository, a fake `fj` / `gh` on the search
//! path and a stub for the sync: the steps, their order, where it stops, and what it never does.

use super::*;
use crate::git::forgejo::FORGE as FORGEJO;
use crate::git::github::FORGE as GITHUB;
use crate::git::transport::Source;
use std::cell::Cell;
use std::path::PathBuf;

struct Rig {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    log: PathBuf,
    exec: Exec,
}

fn git(root: &Path, env: &[(String, String)], args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A vault named "My Vault" with one commit on `main`, and a fake `binary` made of `script`
/// (each call's arguments are appended to the log first).
fn rig(binary: &str, script: &str, remote: Option<&str>) -> Option<Rig> {
    if !crate::git::sync::tests::have_git() {
        return None;
    }
    crate::git::repo::ISOLATED.with(|i| i.set(true));
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("My Vault");
    let bin = tmp.path().join("bin");
    for d in [&root, &bin] {
        std::fs::create_dir_all(d).unwrap();
    }
    let log = tmp.path().join("argv.log");
    let env = vec![
        (
            "HOME".to_string(),
            tmp.path().to_string_lossy().into_owned(),
        ),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ("GIT_CONFIG_GLOBAL".to_string(), "/dev/null".to_string()),
    ];
    git(&root, &env, &["init", "-b", "main"]);
    git(&root, &env, &["config", "user.name", "T"]);
    git(&root, &env, &["config", "user.email", "t@example.test"]);
    std::fs::write(root.join("Plan.md"), "x\n").unwrap();
    git(&root, &env, &["add", "."]);
    git(&root, &env, &["commit", "-m", "first"]);
    if let Some(url) = remote {
        git(&root, &env, &["remote", "add", "origin", url]);
    }
    let path = bin.join(binary);
    std::fs::write(
        &path,
        format!("#!/bin/sh\necho \"$@\" >> '{}'\n{script}\n", log.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let exec = crate::git::forge::tests::sandbox(&bin, env);
    Some(Rig {
        _tmp: tmp,
        root,
        log,
        exec,
    })
}

impl Rig {
    fn git(&self, args: &[&str]) -> String {
        let env: Vec<(String, String)> = ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]
            .into_iter()
            .map(|k| {
                (
                    k.to_string(),
                    self.exec.var(k).unwrap().to_string_lossy().into_owned(),
                )
            })
            .collect();
        git(&self.root, &env, args)
    }

    fn argv(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    fn run(&self, req: &Request<'_>, sync: Result<(), StepError>) -> (Outcome, usize) {
        let calls = Cell::new(0);
        let out = run(&self.exec, &self.root, req, &|| None, &|| {
            calls.set(calls.get() + 1);
            sync.clone()
        });
        (out, calls.get())
    }
}

fn states(o: &Outcome) -> Vec<(&'static str, &'static str)> {
    o.steps
        .iter()
        .map(|s| (s.id.name(), s.state.name()))
        .collect()
}

const CODEBERG: &str = "codeberg.org";
const ALL_DONE: [(&str, &str); 3] = [("remote", "done"), ("credential", "done"), ("push", "done")];

const FJ_OK: &str = r#"case "$*" in
  "-H codeberg.org repo create "*) echo "Created https://codeberg.org/me/$5" ;;
  "-H codeberg.org whoami") echo "currently signed into me@codeberg.org" ;;
esac"#;

fn fj_req(host: &str) -> Request<'_> {
    Request {
        forge: &FORGEJO,
        host: Some(host),
        name: None,
        link_existing: false,
    }
}

#[cfg(unix)]
#[test]
fn an_existing_remote_on_the_host_is_used_as_it_is_and_the_branch_tracks_it() {
    let Some(r) = rig("fj", FJ_OK, Some("https://codeberg.org/me/notes.git")) else {
        return;
    };
    let (out, pushes) = r.run(&fj_req(CODEBERG), Ok(()));
    assert_eq!(states(&out), ALL_DONE);
    assert!(out.ok() && out.taken.is_none());
    assert_eq!(out.steps[0].line, "codeberg.org/me/notes");
    assert_eq!(out.steps[2].line, "Synced");
    assert_eq!(pushes, 1);
    // nothing was created and the remote is untouched
    assert_eq!(r.argv(), "");
    assert_eq!(
        r.git(&["remote", "get-url", "origin"]),
        "https://codeberg.org/me/notes.git"
    );
    // the first push left tracking in the repository's own config
    assert_eq!(
        r.git(&["config", "--local", "branch.main.remote"]),
        "origin"
    );
    assert_eq!(
        r.git(&["config", "--local", "branch.main.merge"]),
        "refs/heads/main"
    );
    // the credential is the CLI's, bound to the remote's host
    assert_eq!(state::credential_source(&r.root), Source::Cli(&FORGEJO));
    assert_eq!(state::token_host(&r.root).as_deref(), Some(CODEBERG));
}

#[cfg(unix)]
#[test]
fn without_a_remote_the_repository_is_created_private_and_linked_over_https() {
    let Some(r) = rig("fj", FJ_OK, None) else {
        return;
    };
    let (out, pushes) = r.run(&fj_req(CODEBERG), Ok(()));
    assert_eq!(states(&out), ALL_DONE);
    assert_eq!(pushes, 1);
    assert_eq!(r.argv(), "-H codeberg.org repo create My-Vault --private\n");
    assert_eq!(
        r.git(&["remote", "get-url", "origin"]),
        "https://codeberg.org/me/My-Vault"
    );
    assert_eq!(state::token_host(&r.root).as_deref(), Some(CODEBERG));
    assert_eq!(
        r.git(&["config", "--local", "branch.main.remote"]),
        "origin"
    );
}

#[cfg(unix)]
#[test]
fn a_name_that_is_taken_stops_there_and_link_existing_uses_the_signed_in_users_own() {
    let taken = r#"case "$*" in
  "-H codeberg.org repo create "*) echo "error: The repository with the same name already exists." >&2; exit 1 ;;
  "-H codeberg.org whoami") echo "currently signed into me@codeberg.org" ;;
esac"#;
    let Some(r) = rig("fj", taken, None) else {
        return;
    };
    let (out, pushes) = r.run(&fj_req(CODEBERG), Ok(()));
    assert_eq!(
        states(&out),
        [
            ("remote", "failed"),
            ("credential", "pending"),
            ("push", "pending")
        ]
    );
    assert_eq!(out.taken.as_deref(), Some("My-Vault"));
    assert_eq!(
        (out.steps[0].kind, out.steps[0].line.as_str()),
        ("taken", "Name taken: My-Vault")
    );
    assert_eq!(pushes, 0);
    // nothing was linked and the sign-in source did not change
    assert!(r.git(&["remote"]).is_empty());
    assert_eq!(state::credential_source(&r.root), Source::Token);

    // "Link existing": the repository of that name under the signed-in user, no create
    let existing = Request {
        link_existing: true,
        name: Some("My-Vault"),
        ..fj_req(CODEBERG)
    };
    let (out, pushes) = r.run(&existing, Ok(()));
    assert_eq!(states(&out), ALL_DONE);
    assert_eq!(pushes, 1);
    assert_eq!(
        r.git(&["remote", "get-url", "origin"]),
        "https://codeberg.org/me/My-Vault.git"
    );
    let log = r.argv();
    assert_eq!(
        log.matches("repo create").count(),
        1,
        "only the first try created: {log}"
    );

    // another name from the field creates under that name
    let ok = rig("fj", FJ_OK, None).unwrap();
    let other = Request {
        name: Some("Notes 2"),
        ..fj_req(CODEBERG)
    };
    let (out, _) = ok.run(&other, Ok(()));
    assert!(out.ok(), "{out:?}");
    assert_eq!(ok.argv(), "-H codeberg.org repo create Notes-2 --private\n");
}

#[cfg(unix)]
#[test]
fn the_remote_is_on_the_chosen_host_even_when_fj_prints_another_address() {
    // Forgejo's ROOT_URL differs from the host fj is signed in to
    let script = r#"case "$*" in
  "-H codeberg.org repo create "*) echo "Created https://forgejo.internal/me/$5" ;;
  "-H codeberg.org whoami") echo "currently signed into me@codeberg.org" ;;
esac"#;
    let Some(r) = rig("fj", script, None) else {
        return;
    };
    let (out, pushes) = r.run(&fj_req(CODEBERG), Ok(()));
    assert_eq!((states(&out), pushes), (ALL_DONE.to_vec(), 1));
    // the address is built from the chosen host, the owner and the name
    assert_eq!(
        r.git(&["remote", "get-url", "origin"]),
        "https://codeberg.org/me/My-Vault.git"
    );
    // and no remote exists for the other host; the credential is bound to the chosen one
    assert_eq!(r.git(&["remote"]), "origin");
    assert!(!r
        .git(&["config", "--local", "--list"])
        .contains("forgejo.internal"));
    assert_eq!(state::token_host(&r.root).as_deref(), Some(CODEBERG));
    assert_eq!(out.steps[0].line, "codeberg.org/me/My-Vault");
}

#[cfg(unix)]
#[test]
fn a_failed_step_stops_the_action_with_its_kind() {
    // the first push fails: remote and credential stand, the push step carries the kind
    let Some(r) = rig("fj", FJ_OK, None) else {
        return;
    };
    let auth = StepError {
        line: "Authentication failed".into(),
        kind: "auth",
    };
    let (out, pushes) = r.run(&fj_req(CODEBERG), Err(auth));
    assert_eq!(
        states(&out),
        [
            ("remote", "done"),
            ("credential", "done"),
            ("push", "failed")
        ]
    );
    assert_eq!(
        (out.steps[2].kind, out.steps[2].line.as_str()),
        ("auth", "Authentication failed")
    );
    assert_eq!(pushes, 1);
    assert!(!out.ok());

    // fj fails to create: nothing after it runs
    let broken = rig("fj", "echo 'error: not logged in' >&2; exit 1", None).unwrap();
    let (out, pushes) = broken.run(&fj_req(CODEBERG), Ok(()));
    assert_eq!(
        states(&out),
        [
            ("remote", "failed"),
            ("credential", "pending"),
            ("push", "pending")
        ]
    );
    assert_eq!((out.taken, pushes), (None, 0));
    assert!(out.steps[1..]
        .iter()
        .all(|s| s.line.is_empty() && s.kind.is_empty()));
}

#[cfg(unix)]
#[test]
fn a_remote_on_another_host_is_never_overwritten() {
    let Some(r) = rig("fj", FJ_OK, Some("https://github.com/me/notes.git")) else {
        return;
    };
    let (out, pushes) = r.run(&fj_req(CODEBERG), Ok(()));
    assert_eq!(states(&out)[0], ("remote", "failed"));
    assert_eq!(pushes, 0);
    assert_eq!(
        r.git(&["remote", "get-url", "origin"]),
        "https://github.com/me/notes.git"
    );
    assert_eq!(r.argv(), "");
    // an SSH remote is not replaced either
    let ssh = rig("fj", FJ_OK, Some("git@codeberg.org:me/notes.git")).unwrap();
    let (out, _) = ssh.run(&fj_req(CODEBERG), Ok(()));
    assert_eq!(states(&out)[0], ("remote", "failed"));
    assert_eq!(
        ssh.git(&["remote", "get-url", "origin"]),
        "git@codeberg.org:me/notes.git"
    );
}

#[cfg(unix)]
#[test]
fn github_goes_through_the_same_steps() {
    let gh = r#"case "$1 $2" in
  "repo create") echo "https://github.com/me/$3" ;;
  "api user") echo me ;;
esac"#;
    let req = |link| Request {
        forge: &GITHUB,
        host: None,
        name: None,
        link_existing: link,
    };
    let Some(r) = rig("gh", gh, None) else {
        return;
    };
    let (out, pushes) = r.run(&req(false), Ok(()));
    assert_eq!((states(&out), pushes), (ALL_DONE.to_vec(), 1));
    assert_eq!(r.argv(), "repo create My-Vault --private\n");
    assert_eq!(
        r.git(&["remote", "get-url", "origin"]),
        "https://github.com/me/My-Vault"
    );
    assert_eq!(state::credential_source(&r.root), Source::Cli(&GITHUB));
    assert_eq!(state::token_host(&r.root).as_deref(), Some("github.com"));
    // an existing GitHub remote is reused, and link-existing builds the user's own URL
    let reuse = rig("gh", gh, Some("https://github.com/me/n.git")).unwrap();
    assert!(reuse.run(&req(false), Ok(())).0.ok());
    assert_eq!(reuse.argv(), "");
    let link = rig("gh", gh, None).unwrap();
    assert!(link.run(&req(true), Ok(())).0.ok());
    assert_eq!(
        link.git(&["remote", "get-url", "origin"]),
        "https://github.com/me/My-Vault.git"
    );
}

#[test]
fn whoami_names_the_owner_whatever_the_language() {
    use crate::git::forgejo::owner_in;
    assert_eq!(
        owner_in("currently signed into me@codeberg.org\n", CODEBERG).as_deref(),
        Some("me")
    );
    // Fluent isolates its arguments in bidi marks; other languages put other words around
    assert_eq!(
        owner_in(
            "connecté en tant que \u{2068}anne-lise@Codeberg.org\u{2069}.",
            CODEBERG
        )
        .as_deref(),
        Some("anne-lise")
    );
    assert_eq!(owner_in("me@other.example", CODEBERG), None);
    assert_eq!(owner_in("no login here", CODEBERG), None);
    assert_eq!(owner_in("@codeberg.org", CODEBERG), None);
}

#[test]
fn macos_local_network_refusals_get_their_own_line() {
    use crate::git::transport::{classify, Output};
    let out = Output {
        code: Some(128),
        stdout: String::new(),
        stderr: "fatal: unable to access 'https://git.lan/me/v.git/': Failed to connect to git.lan port 443 after 1 ms: No route to host".into(),
    };
    let e = classify(&out, Path::new("/v"), &[]);
    if cfg!(target_os = "macos") {
        assert_eq!(e.kind, Kind::LocalNetwork);
        assert_eq!(
            e.line,
            "Can't reach the server. On macOS, check Privacy & Security > Local Network."
        );
    } else {
        assert_eq!(
            e.kind,
            Kind::Offline,
            "only macOS has Local Network privacy"
        );
    }
    assert_eq!(Kind::LocalNetwork.name(), "local-network");
    // an ordinary DNS failure stays Offline everywhere
    let dns = Output {
        stderr: "fatal: unable to access 'https://x/': Could not resolve host: x".into(),
        ..out
    };
    assert_eq!(classify(&dns, Path::new("/v"), &[]).kind, Kind::Offline);
}
