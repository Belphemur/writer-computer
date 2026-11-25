//! Commit signing run by Writer with the options gix resolves (ADR 2026-11-24): a fake signer
//! (`gpg.format=ssh`, `gpg.ssh.program` a script) in a temporary `HOME`, never the user's keys or
//! configuration; a throwaway `ssh-keygen` key for the real round trip (skipped without
//! `ssh-keygen`). The fixture repositories are made with `git`; each test skips without it.

use super::repo::{Error, Repo, TEST_EXEC};
use super::sync::tests::{have_git, pair, remote_file, run_git, Device, World};
use super::transport::{classify, Exec, Kind, Output};
use super::{commit_user_with, set_signing, ChatNotes, Lfs};
use crate::features::scope::Spawner;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

macro_rules! need_git {
    () => {
        if !have_git() {
            eprintln!("skipped: no git binary");
            return;
        }
    };
}

/// A signer that writes a fake SSH signature where git looks for it (`<buffer>.sig`), or fails.
pub(super) fn signer(dir: &Path, works: bool) -> PathBuf {
    let path = dir.join(if works { "sign-ok" } else { "sign-fail" });
    let body = if works {
        "#!/bin/sh\nfor last; do :; done\nprintf -- '-----BEGIN SSH SIGNATURE-----\\nZmFrZQ==\\n-----END SSH SIGNATURE-----\\n' > \"$last.sig\"\n"
    } else {
        "#!/bin/sh\necho 'incorrect passphrase or key locked' >&2\nexit 1\n"
    };
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

/// Runs the engine's commits through this device's runner (its temporary `HOME`) until dropped.
pub(super) struct Through;
impl Through {
    pub(super) fn of(d: &Device) -> Through {
        TEST_EXEC.with(|e| *e.borrow_mut() = Some(d.exec.clone()));
        Through
    }
}
impl Drop for Through {
    fn drop(&mut self) {
        TEST_EXEC.with(|e| *e.borrow_mut() = None);
    }
}

/// The vault's own config says commits are signed by `program`.
pub(super) fn sign_with(d: &Device, program: &Path) {
    for (k, v) in [
        ("commit.gpgsign", "true"),
        ("gpg.format", "ssh"),
        ("user.signingkey", "ssh-ed25519 AAAAfakefakefake"),
        ("gpg.ssh.program", &program.to_string_lossy()),
    ] {
        d.git(&["config", k, v]);
    }
}

pub(super) fn commit_user(d: &Device) -> super::Result<Option<String>> {
    commit_user_with(
        &d.root,
        "{{notes}}",
        &super::sync::tests::ctx(),
        &d.name,
        Lfs::OFF,
        ChatNotes::Commit,
        None,
    )
}

fn object(d: &Device, rev: &str) -> String {
    d.git(&["cat-file", "-p", rev])
}

#[test]
fn a_commit_is_signed_when_the_config_says_so() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    sign_with(&d, &signer(&w.home, true));
    let _through = Through::of(&d);
    d.write("Plan.md", "# Plan\n");
    d.setup();
    let setup = object(&d, "HEAD");
    assert!(setup.contains("gpgsig "), "{setup}");
    d.write("Plan.md", "# Plan\nmore\n");
    let id = commit_user(&d).unwrap().unwrap();
    assert_eq!(d.head(), id);
    let text = object(&d, "HEAD");
    assert!(text.contains("gpgsig "), "{text}");
    // the same commit Writer would have made unsigned: message, identity, parent
    assert!(text.contains("author A <A@example.test>"), "{text}");
    assert!(text.contains("user(edit): Plan"), "{text}");
    assert!(text.contains("Writer-Device: A"), "{text}");
    assert_eq!(d.git(&["rev-list", "--count", "HEAD"]).trim(), "2");
    assert_eq!(d.git(&["status", "--porcelain"]).trim(), "");
}

#[test]
fn a_commit_is_never_made_unsigned_when_the_signer_fails() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "# Plan\n");
    d.setup();
    let before = d.head();
    sign_with(&d, &signer(&w.home, false));
    let _through = Through::of(&d);
    d.write("Plan.md", "# Plan\nmore\n");
    match commit_user(&d) {
        Err(Error::Signing { details }) => {
            assert!(details.contains("incorrect passphrase"), "{details}");
            assert!(!details.contains(&*d.root.to_string_lossy()));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(d.head(), before, "no commit");
    let repo = Repo::open(&d.root).unwrap().unwrap();
    assert_eq!(repo.changes().unwrap().len(), 1, "still pending");
    assert_eq!(
        Error::Signing {
            details: String::new()
        }
        .to_string(),
        "Signing failed: unlock your key"
    );
    // the signer recovers: the next pass commits what is pending, signed
    sign_with(&d, &signer(&w.home, true));
    assert!(commit_user(&d).unwrap().is_some());
    assert!(object(&d, "HEAD").contains("gpgsig "));
}

#[test]
fn signing_on_or_off_git_runs_nothing_for_it() {
    need_git!();
    let w = World::new();
    // a `git` that records its arguments, then runs the real one
    let bin = w.home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = w.home.join("calls.log");
    let real = String::from_utf8(
        std::process::Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let shim = bin.join("git");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\necho \"$@\" >> '{}'\nexec '{}' \"$@\"\n",
            log.display(),
            real.trim()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut d = w.device("A");
    d.exec = Exec::new(Spawner::detached())
        .with_env(w.env())
        .with_path_prefix(vec![bin]);
    let _through = Through::of(&d);
    d.write("Plan.md", "# Plan\n");
    d.setup();
    d.write("Plan.md", "# Plan\nmore\n");
    assert!(commit_user(&d).unwrap().is_some());
    assert!(!object(&d, "HEAD").contains("gpgsig"));
    // and on: the same flow signs, with the signer Writer runs
    sign_with(&d, &signer(&w.home, true));
    d.write("Plan.md", "# Plan\nmore\nagain\n");
    commit_user(&d).unwrap();
    assert!(object(&d, "HEAD").contains("gpgsig "));
    // git is never asked about signing: no config read, no commit-tree, no identity check
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    for word in ["config --get", "commit-tree", "cat-file"] {
        assert!(!calls.contains(word), "{word}: {calls}");
    }
}

#[test]
fn replayed_commits_are_signed_again_and_a_sync_that_cannot_sign_pushes_nothing() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Shared.md", "shared\n")]);
    a.write("FromA.md", "a\n");
    a.commit();
    a.ok();
    sign_with(&b, &signer(&w.home, true));
    let _through = Through::of(&b);
    b.write("One.md", "1\n");
    assert!(commit_user(&b).unwrap().is_some());
    b.write("Two.md", "2\n");
    assert!(commit_user(&b).unwrap().is_some());
    let r = b.ok();
    assert_eq!((r.pulled, r.pushed), (1, 2), "replayed and pushed");
    let remote = |rev: &str| run_git(&w.env(), &w.remote, &["cat-file", "-p", rev]);
    for rev in ["main", "main~1"] {
        assert!(remote(rev).contains("gpgsig "), "{rev}: {}", remote(rev));
    }
    assert_eq!(remote_file(&w, "Two.md").as_deref(), Some("2\n"));

    // a second round whose signer fails: the replay stops, nothing is pushed, the commit stays
    a.write("More.md", "m\n");
    a.commit();
    a.ok();
    b.write("Three.md", "3\n");
    commit_user(&b).unwrap();
    sign_with(&b, &signer(&w.home, false));
    let remote_head = run_git(&w.env(), &w.remote, &["rev-parse", "main"]);
    let o = b.sync();
    assert!(
        matches!(
            o.error,
            Some(super::sync::Error::Repo(Error::Signing { .. }))
        ),
        "{:?}",
        o.error.map(|e| e.to_string())
    );
    assert_eq!(
        run_git(&w.env(), &w.remote, &["rev-parse", "main"]),
        remote_head
    );
}

#[test]
fn signed_history_with_the_config_off_suggests_signing_and_the_switch_is_local() {
    need_git!();
    let w = World::new();
    let global = w.home.join("gitconfig");
    std::fs::write(
        &global,
        "[user]\n\tsigningkey = ssh-ed25519 AAAAfakefakefake\n",
    )
    .unwrap();
    let mut env = w.env();
    env.retain(|(k, _)| k != "GIT_CONFIG_GLOBAL");
    env.push((
        "GIT_CONFIG_GLOBAL".into(),
        global.to_string_lossy().into_owned(),
    ));
    let mut d = w.device("A");
    d.exec = Exec::new(Spawner::detached()).with_env(env.clone());
    let _through = Through::of(&d);
    let repo = || Repo::open(&d.root).unwrap().unwrap();
    d.write("Plan.md", "1\n");
    d.setup();
    assert!(!repo().signing().suggested(), "no signed commit yet");
    // a signed commit appears in the history (made with the repository's own signing config)
    sign_with(&d, &signer(&w.home, true));
    d.write("Plan.md", "2\n");
    commit_user(&d).unwrap();
    let on = repo().signing();
    assert!(on.on && on.key && !on.suggested());
    // the config goes off: the history still says it signs
    set_signing(&d.exec, &d.root, false).unwrap();
    assert_eq!(
        d.git(&["config", "--local", "commit.gpgsign"]).trim(),
        "false"
    );
    let off = repo().signing();
    assert!(!off.on && off.signed_history && off.suggested(), "{off:?}");
    // the switch writes the vault's config only
    let before = std::fs::read_to_string(&global).unwrap();
    set_signing(&d.exec, &d.root, true).unwrap();
    assert_eq!(
        d.git(&["config", "--local", "commit.gpgsign"]).trim(),
        "true"
    );
    assert_eq!(std::fs::read_to_string(&global).unwrap(), before);
    assert!(repo().signing().on);
}

#[test]
fn the_switch_is_refused_without_a_signing_key() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "1\n");
    d.setup();
    // an ssh signature needs a key; OpenPGP may have a default one (the first signature decides)
    d.git(&["config", "gpg.format", "ssh"]);
    let err = set_signing(&d.exec, &d.root, true).unwrap_err();
    assert_eq!(err, "Set up a signing key in git first");
    let config = std::fs::read_to_string(d.root.join(".git/config")).unwrap();
    assert!(!config.contains("gpgsign"), "{config}");
    // turning it off is always possible
    set_signing(&d.exec, &d.root, false).unwrap();
}

#[test]
fn a_global_gpgsign_in_the_home_config_signs_too() {
    need_git!();
    let w = World::new();
    let signer = signer(&w.home, true);
    let global = w.home.join("gitconfig");
    std::fs::write(
        &global,
        format!(
            "[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[gpg \"ssh\"]\n\tprogram = {}\n[user]\n\tsigningkey = ssh-ed25519 AAAAfakefakefake\n",
            signer.display()
        ),
    )
    .unwrap();
    let mut env = w.env();
    env.retain(|(k, _)| k != "GIT_CONFIG_GLOBAL");
    env.push((
        "GIT_CONFIG_GLOBAL".into(),
        global.to_string_lossy().into_owned(),
    ));
    let mut d = w.device("A");
    d.exec = Exec::new(Spawner::detached()).with_env(env);
    let _through = Through::of(&d);
    d.write("Plan.md", "1\n");
    d.setup();
    assert!(object(&d, "HEAD").contains("gpgsig "));
}

#[test]
fn a_push_refused_for_missing_signatures_is_its_own_kind() {
    let out = |stderr: &str| Output {
        code: Some(1),
        stdout: String::new(),
        stderr: stderr.into(),
    };
    for text in [
        "remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Commits must have verified signatures.\n ! [remote rejected] main -> main (protected branch hook declined)",
        "remote: GitLab: You can only push signed commits to this branch\n ! [remote rejected] main -> main (pre-receive hook declined)",
        "remote: Gitea: branch main requires signed commits\n ! [remote rejected]",
    ] {
        let e = classify(&out(text), Path::new("/vault"), &[]);
        assert_eq!(e.kind, Kind::SignatureRequired, "{text}");
        assert_eq!(e.kind.name(), "signature-required");
    }
    // other refusals keep their kinds
    let other = classify(
        &out("! [remote rejected] main -> main (protected branch hook declined)"),
        Path::new("/vault"),
        &[],
    );
    assert_eq!(other.kind, Kind::Other);
}

#[test]
fn a_configuration_that_cannot_be_read_makes_no_commit_never_an_unsigned_one() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "1\n");
    d.setup();
    let before = d.head();
    d.write("Plan.md", "2\n");
    let repo = Repo::open(&d.root).unwrap().unwrap();

    // a value that is not a boolean
    d.git(&["config", "commit.gpgsign", "maybe"]);
    assert!(matches!(commit_user(&d), Err(Error::Signing { .. })));
    assert!(matches!(
        Repo::open(&d.root).unwrap().unwrap().signer(),
        Err(Error::Signing { .. })
    ));
    assert_eq!(d.head(), before);

    // signing on with a deadline that already passed (a sync at close, out of budget)
    sign_with(&d, &signer(&w.home, true));
    let expired = Exec::new(Spawner::detached())
        .with_env(w.env())
        .with_deadline(Instant::now());
    TEST_EXEC.with(|e| *e.borrow_mut() = Some(expired));
    assert!(matches!(commit_user(&d), Err(Error::Signing { .. })));
    assert_eq!(d.head(), before, "no commit");
    assert_eq!(repo.changes().unwrap().len(), 1, "still pending");
    TEST_EXEC.with(|e| *e.borrow_mut() = None);

    // unset is "off": the unsigned path
    d.git(&["config", "--unset", "commit.gpgsign"]);
    assert!(commit_user(&d).unwrap().is_some());
}

#[test]
fn a_signer_that_does_not_answer_is_killed_and_makes_no_commit() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "1\n");
    d.setup();
    let before = d.head();
    // records its pid, then becomes `sleep`
    let pid_file = w.home.join("signer.pid");
    let hang = w.home.join("sign-hang");
    std::fs::write(
        &hang,
        format!(
            "#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n",
            pid_file.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hang, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    sign_with(&d, &hang);
    // the runner's budget cuts the signer's own 120 s bound
    let exec = Exec::new(Spawner::detached())
        .with_env(w.env())
        .with_deadline(Instant::now() + Duration::from_secs(4));
    TEST_EXEC.with(|e| *e.borrow_mut() = Some(exec));
    d.write("Plan.md", "2\n");
    let started = Instant::now();
    assert!(matches!(commit_user(&d), Err(Error::Signing { .. })));
    TEST_EXEC.with(|e| *e.borrow_mut() = None);
    assert!(started.elapsed() < Duration::from_secs(20));
    assert_eq!(d.head(), before, "no commit");
    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .to_string();
    let alive = || {
        std::process::Command::new("kill")
            .args(["-0", &pid])
            .output()
            .unwrap()
            .status
            .success()
    };
    let gone = (0..50).any(|_| {
        std::thread::sleep(Duration::from_millis(100));
        !alive()
    });
    assert!(gone, "the signer was killed");
}

fn bytes_of(d: &Device, rev: &str) -> Vec<u8> {
    std::process::Command::new("git")
        .args(["cat-file", "commit", rev])
        .current_dir(&d.root)
        .envs(d.env.iter().map(|(k, v)| (k, v)))
        .output()
        .unwrap()
        .stdout
}

/// A commit object without its `gpgsig` header (and its continuation lines).
fn unsigned(object: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut skipping = false;
    for line in object.split_inclusive(|b| *b == b'\n') {
        if line.starts_with(b"gpgsig ") {
            skipping = true;
            continue;
        }
        if skipping && line.starts_with(b" ") {
            continue;
        }
        skipping = false;
        out.extend_from_slice(line);
    }
    out
}

#[test]
fn the_signed_commit_is_the_gix_commit_plus_its_signature_byte_for_byte() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    // a name with a trailing dot, which git used to clean: written as it is, both ways
    d.git(&["config", "user.name", "Ada W."]);
    sign_with(&d, &signer(&w.home, true));
    let _through = Through::of(&d);
    d.write("Plan.md", "1\n");
    d.setup();
    d.write("Plan.md", "2\n");
    let id = commit_user(&d).unwrap().unwrap();
    let repo = Repo::open(&d.root).unwrap().unwrap();
    let data = repo.commit_data(&id).unwrap();
    // the name git resolves is the name both paths write, trailing dot or not
    assert!(
        data.author.name.starts_with("Ada W"),
        "{}",
        data.author.name
    );
    let tree = d
        .git(&["rev-parse", &format!("{id}^{{tree}}")])
        .trim()
        .to_string();
    let plain = repo
        .write_commit(
            None,
            &tree,
            &data.parents,
            &data.message,
            &data.author,
            &data.committer,
        )
        .unwrap();
    assert_ne!(plain, id);
    assert_eq!(unsigned(&bytes_of(&d, &id)), bytes_of(&d, &plain));

    // replayed messages go through exact: non-ASCII, no final newline, CRLF
    let exec = repo.signer().unwrap().unwrap();
    for message in [
        "user(edit): caf\u{e9}\n\nWriter-Device: A\n",
        "no final newline",
        "windows\r\nlines\r\n",
    ] {
        let message = message.as_bytes();
        let plain = repo
            .write_commit(
                None,
                &tree,
                &data.parents,
                message,
                &data.author,
                &data.committer,
            )
            .unwrap();
        let signed = repo
            .write_commit(
                Some(&exec),
                &tree,
                &data.parents,
                message,
                &data.author,
                &data.committer,
            )
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes_of(&d, &signed)).contains("gpgsig "));
        assert_eq!(
            unsigned(&bytes_of(&d, &signed)),
            bytes_of(&d, &plain),
            "{message:?}"
        );
    }
    // a Latin-1 message is signed exactly as given (gix writes the bytes, nothing re-encodes)
    let latin = b"user(edit): caf\xe9\n".to_vec();
    let id = repo
        .write_commit(
            Some(&exec),
            &tree,
            &data.parents,
            &latin,
            &data.author,
            &data.committer,
        )
        .unwrap();
    assert_eq!(repo.commit_data(&id).unwrap().message, latin);

    // an identity that cannot be written as it is (`<`, `>`, a line break, an empty name) is
    // refused, not cleaned
    let message = b"user(edit): x\n".to_vec();
    let mut cleaned = data.author.clone();
    cleaned.name = "<>".into();
    let err = repo
        .write_commit(
            Some(&exec),
            &tree,
            &data.parents,
            &message,
            &cleaned,
            &data.committer,
        )
        .unwrap_err();
    assert!(matches!(err, Error::Signing { .. }), "{err:?}");
    let mut nameless = data.author.clone();
    nameless.name = String::new();
    for signer in [Some(&exec), None] {
        let err = repo
            .write_commit(
                signer,
                &tree,
                &data.parents,
                &message,
                &nameless,
                &data.committer,
            )
            .unwrap_err();
        assert!(matches!(err, Error::NoIdentity), "{err:?}");
    }
    for (name, email) in [("", "a@b"), ("A", "a>b"), ("A\nB", "a@b"), ("A", "a\nb")] {
        let mut who = data.author.clone();
        who.name = name.into();
        who.email = email.into();
        assert!(
            repo.write_commit(
                Some(&exec),
                &tree,
                &data.parents,
                &message,
                &who,
                &data.committer
            )
            .is_err(),
            "{name:?} {email:?}"
        );
    }
}

#[test]
fn signing_turned_on_remakes_unsigned_local_commits_a_remote_refused() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Shared.md", "shared\n")]);
    drop(a);
    // the remote now takes signed commits only
    let hook = w.remote.join("hooks/pre-receive");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(
        &hook,
        "#!/bin/sh\nwhile read old new ref; do\n  for c in $(git rev-list \"$new\" --not --all); do\n    git cat-file commit \"$c\" | grep -q '^gpgsig ' || { echo 'remote: error: GH006: Commits must have verified signatures.' >&2; exit 1; }\n  done\ndone\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    b.write("One.md", "1\n");
    b.commit();
    std::thread::sleep(Duration::from_millis(1100));
    b.write("Two.md", "2\n");
    b.commit();
    let dates = b.git(&["log", "-2", "--format=%at|%an"]);
    let o = b.sync();
    assert!(
        matches!(&o.error, Some(super::sync::Error::Transport(t)) if t.kind == Kind::SignatureRequired),
        "{:?}",
        o.error.map(|e| e.to_string())
    );
    // signing is turned on: the next sync re-makes both, signed, and the remote takes them
    sign_with(&b, &signer(&w.home, true));
    let _through = Through::of(&b);
    let r = b.ok();
    assert_eq!(r.pushed, 2);
    for rev in ["main", "main~1"] {
        let text = run_git(&w.env(), &w.remote, &["cat-file", "-p", rev]);
        assert!(text.contains("gpgsig "), "{rev}");
    }
    assert_eq!(
        run_git(
            &w.env(),
            &w.remote,
            &["log", "-2", "--format=%at|%an", "main"]
        ),
        dates,
        "the authors and dates are the originals"
    );
    assert_eq!(remote_file(&w, "Two.md").as_deref(), Some("2\n"));
}

fn executable(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// A fake signer for `format` that answers deterministically and logs its arguments one per
/// line (the log is cleared between runs); `report` says whether an OpenPGP one reports
/// `SIG_CREATED`.
pub(super) fn recording_signer(dir: &Path, ssh: bool, report: bool) -> (PathBuf, PathBuf) {
    let path = dir.join(if ssh { "rec-ssh" } else { "rec-gpg" });
    let log = dir.join(if ssh { "ssh.args" } else { "gpg.args" });
    let record = format!(
        "for a; do printf '%s\\n' \"$a\" >> '{}'; done\n",
        log.display()
    );
    let body = if ssh {
        format!(
            "#!/bin/sh\n{record}for last; do :; done\nprintf -- '-----BEGIN SSH SIGNATURE-----\\r\\nZmFrZQ==\\r\\n-----END SSH SIGNATURE-----\\r\\n' > \"$last.sig\"\n"
        )
    } else {
        let status = if report {
            "echo '[GNUPG:] SIG_CREATED D 22 8 00 1700000000 ABCDEF' >&2\n"
        } else {
            ""
        };
        format!(
            "#!/bin/sh\n{record}cat > /dev/null\n{status}printf -- '-----BEGIN PGP SIGNATURE-----\\r\\n\\r\\nZmFrZQ==\\r\\n-----END PGP SIGNATURE-----\\r\\n'\n"
        )
    };
    executable(&path, &body);
    (path, log)
}

/// The arguments the signer logged in its two runs (Writer's, then gix's), a temporary file
/// (random name) written as `<tmp>`.
fn logged_args(log: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let _ = std::fs::remove_file(log);
    let tmp = std::env::temp_dir();
    text.lines()
        .map(|l| {
            if Path::new(l).starts_with(&tmp) {
                "<tmp>".to_string()
            } else {
                l.to_string()
            }
        })
        .collect()
}

#[test]
fn writer_signs_with_the_same_argv_and_bytes_as_gix_for_every_format() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "1\n");
    d.setup();
    let _through = Through::of(&d);
    let repo = Repo::open(&d.root).unwrap().unwrap();
    let data = repo.commit_data(&d.head()).unwrap();
    let tree = d.git(&["rev-parse", "HEAD^{tree}"]).trim().to_string();
    let exec = d.exec.clone();
    let both = |message: &[u8]| {
        Repo::open(&d.root).unwrap().unwrap().signed_both_ways(
            &exec,
            &tree,
            &data.parents,
            message,
            &data.author,
            &data.committer,
        )
    };

    // OpenPGP and X.509
    for format in ["openpgp", "x509"] {
        let (program, log) = recording_signer(&w.home, false, true);
        d.git(&["config", "gpg.format", format]);
        d.git(&[
            "config",
            &format!(
                "gpg.{}.program",
                if format == "x509" { "x509" } else { "openpgp" }
            ),
            &program.to_string_lossy(),
        ]);
        d.git(&["config", "user.signingkey", "KEYID123"]);
        let (ours, theirs) = both(b"user(edit): a\n");
        assert_eq!(ours, theirs, "{format}: the same commit object");
        // CRLF from the signer is folded
        assert!(!object_text(&d, &ours).contains('\r'));
        // each run logged the same argv: the fixed arguments, the key last
        let args = logged_args(&log);
        let half = args.len() / 2;
        assert_eq!(args[..half], args[half..], "{format}");
        assert_eq!(
            args[..half],
            ["--status-fd=2", "-bsau", "KEYID123"],
            "{format}"
        );
    }

    // a signer that does not report SIG_CREATED is a failure, not an empty signature
    let (program, _log) = recording_signer(&w.home, false, false);
    d.git(&["config", "gpg.format", "openpgp"]);
    d.git(&["config", "gpg.program", &program.to_string_lossy()]);
    let repo = Repo::open(&d.root).unwrap().unwrap();
    let plain = repo
        .write_commit(
            None,
            &tree,
            &data.parents,
            b"x\n",
            &data.author,
            &data.committer,
        )
        .unwrap();
    assert!(!plain.is_empty());
    d.git(&["config", "commit.gpgsign", "true"]);
    d.write("Plan.md", "2\n");
    let before = d.head();
    assert!(matches!(commit_user(&d), Err(Error::Signing { .. })));
    assert_eq!(d.head(), before);
    d.git(&["config", "--unset", "commit.gpgsign"]);

    // SSH, key path and the default key command's absence aside
    let (program, log) = recording_signer(&w.home, true, true);
    d.git(&["config", "gpg.format", "ssh"]);
    d.git(&["config", "gpg.ssh.program", &program.to_string_lossy()]);
    d.git(&["config", "user.signingkey", "/keys/id_test.pub"]);
    let (ours, theirs) = both(b"user(edit): b\n");
    assert_eq!(ours, theirs, "ssh: the same commit object");
    assert!(!object_text(&d, &ours).contains('\r'));
    let args = logged_args(&log);
    let half = args.len() / 2;
    assert_eq!(args[..half], args[half..]);
    assert_eq!(
        args[..half],
        [
            "-Y",
            "sign",
            "-n",
            "git",
            "-f",
            "/keys/id_test.pub",
            "<tmp>"
        ]
    );

    // SSH with an inline key: a temporary key file and -U
    d.git(&["config", "user.signingkey", "key::ssh-ed25519 AAAAfake"]);
    let (ours, theirs) = both(b"user(edit): c\n");
    assert_eq!(ours, theirs, "inline key: the same commit object");
    let args = logged_args(&log);
    let half = args.len() / 2;
    assert_eq!(args[..half], args[half..]);
    assert_eq!(
        args[..half],
        ["-Y", "sign", "-n", "git", "-f", "<tmp>", "-U", "<tmp>"]
    );
}

fn object_text(d: &Device, id: &str) -> String {
    String::from_utf8_lossy(&bytes_of(d, id)).into_owned()
}

fn have_tool(name: &str, probe: &str) -> bool {
    std::process::Command::new(name)
        .arg(probe)
        .output()
        .is_ok_and(|o| o.status.success() || !o.stderr.is_empty() || !o.stdout.is_empty())
}

/// A throwaway ed25519 key in `dir`: (private key path, the public key line).
fn throwaway_key(dir: &Path) -> Option<(PathBuf, String)> {
    let key = dir.join("key");
    let made = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "writer-test", "-f"])
        .arg(&key)
        .output()
        .ok()?;
    made.status.success().then_some(())?;
    let public = std::fs::read_to_string(dir.join("key.pub")).ok()?;
    Some((key, public.trim().to_string()))
}

/// `gpg.ssh.allowedSignersFile` for the device's committer (`A@example.test`).
fn allow_signer(d: &Device, dir: &Path, public: &str) {
    let file = dir.join("allowed_signers");
    std::fs::write(&file, format!("A@example.test {public}\n")).unwrap();
    d.git(&[
        "config",
        "gpg.ssh.allowedSignersFile",
        &file.to_string_lossy(),
    ]);
}

fn verifies_both_ways(d: &Device, id: &str) {
    d.git(&["verify-commit", id]);
    assert!(Repo::open(&d.root).unwrap().unwrap().gix_verifies(id));
}

#[test]
fn a_real_ssh_key_signs_and_both_git_and_gix_verify_it() {
    need_git!();
    if !have_tool("ssh-keygen", "-?") {
        eprintln!("skipped: no ssh-keygen");
        return;
    }
    let w = World::new();
    let Some((key, public)) = throwaway_key(&w.home) else {
        eprintln!("skipped: ssh-keygen cannot make a key");
        return;
    };
    let d = w.device("A");
    let _through = Through::of(&d);
    for (k, v) in [
        ("commit.gpgsign", "true"),
        ("gpg.format", "ssh"),
        ("user.signingkey", &*format!("{}.pub", key.display())),
    ] {
        d.git(&["config", k, v]);
    }
    allow_signer(&d, &w.home, &public);
    d.write("Plan.md", "1\n");
    d.setup();
    d.write("Plan.md", "2\n");
    let id = commit_user(&d).unwrap().unwrap();
    assert!(object_text(&d, &id).contains("gpgsig -----BEGIN SSH SIGNATURE-----"));
    verifies_both_ways(&d, &id);
    verifies_both_ways(&d, d.git(&["rev-parse", "HEAD~1"]).trim());
}

/// A running `ssh-agent` (killed on drop) with `key` loaded, `None` when one cannot start.
struct Agent {
    child: std::process::Child,
    socket: PathBuf,
}

impl Agent {
    fn start(dir: &Path, key: &Path) -> Option<Agent> {
        let socket = dir.join("agent.sock");
        let child = std::process::Command::new("ssh-agent")
            .args(["-D", "-a"])
            .arg(&socket)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let agent = Agent { child, socket };
        let ready = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            agent.socket.exists()
        });
        let added = ready
            && std::process::Command::new("ssh-add")
                .arg(key)
                .env("SSH_AUTH_SOCK", &agent.socket)
                .output()
                .is_ok_and(|o| o.status.success());
        added.then_some(agent)
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn an_inline_key_is_signed_through_the_agent_and_verifies() {
    need_git!();
    if !have_tool("ssh-keygen", "-?") {
        eprintln!("skipped: no ssh-keygen");
        return;
    }
    let w = World::new();
    let Some((key, public)) = throwaway_key(&w.home) else {
        eprintln!("skipped: ssh-keygen cannot make a key");
        return;
    };
    let sockets = tempfile::tempdir().unwrap();
    let Some(agent) = Agent::start(sockets.path(), &key) else {
        eprintln!("skipped: no ssh-agent");
        return;
    };
    let mut d = w.device("A");
    let mut env = w.env();
    env.push((
        "SSH_AUTH_SOCK".into(),
        agent.socket.to_string_lossy().into_owned(),
    ));
    d.exec = Exec::new(Spawner::detached()).with_env(env.clone());
    d.env = env;
    let _through = Through::of(&d);
    // the private half is not in a file the config names: only the agent has it
    let hidden = w.home.join("hidden");
    std::fs::create_dir_all(&hidden).unwrap();
    std::fs::rename(&key, hidden.join("key")).unwrap();
    for (k, v) in [
        ("commit.gpgsign", "true"),
        ("gpg.format", "ssh"),
        ("user.signingkey", &*format!("key::{public}")),
    ] {
        d.git(&["config", k, v]);
    }
    allow_signer(&d, &w.home, &public);
    d.write("Plan.md", "1\n");
    d.setup();
    let id = d.head();
    assert!(object_text(&d, &id).contains("gpgsig -----BEGIN SSH SIGNATURE-----"));
    verifies_both_ways(&d, &id);
    drop(agent);
}

/// An ssh signer that records the permissions and path of the files it is given, writes the
/// signature, then does `then` (`exit 0`, `exit 1`, `exec sleep 60`).
fn probing_signer(dir: &Path, log: &Path, then: &str) -> PathBuf {
    let path = dir.join("probe");
    executable(
        &path,
        &format!(
            "#!/bin/sh\nprev=\nfor a; do\n  case \"$prev\" in -f) key=\"$a\";; esac\n  prev=\"$a\"\n  last=\"$a\"\ndone\nfor f in \"$key\" \"$last\"; do\n  case \"$f\" in /tmp/*|/var/*|/private/*) printf '%s %s\\n' \"$(ls -ln \"$f\" | cut -c1-10)\" \"$f\" >> '{log}';; esac\ndone\nprintf -- '-----BEGIN SSH SIGNATURE-----\\nZmFrZQ==\\n-----END SSH SIGNATURE-----\\n' > \"$last.sig\"\n{then}\n",
            log = log.display()
        ),
    );
    path
}

#[test]
fn the_signers_temporary_files_are_private_and_gone_after_success_failure_and_timeout() {
    use super::signing::{Format, Key, Signer};
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("files.log");
    let root = dir.path();
    for (then, deadline, ok) in [
        ("exit 0", 30, true),
        ("exit 1", 30, false),
        ("exec sleep 60", 2, false),
    ] {
        let _ = std::fs::remove_file(&log);
        let program = probing_signer(dir.path(), &log, then);
        let signer = Signer {
            format: Format::Ssh,
            program: program.into_os_string(),
            args: Vec::new(),
            key: Key::Literal(b"ssh-ed25519 AAAAfake".to_vec()),
            env: Vec::new(),
        };
        let exec = Exec::new(Spawner::detached())
            .with_deadline(Instant::now() + Duration::from_secs(deadline));
        let made = super::signing::sign(&exec, root, &signer, b"payload");
        assert_eq!(made.is_ok(), ok, "{then}: {made:?}");
        let seen = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = seen.lines().collect();
        assert_eq!(
            lines.len(),
            2,
            "{then}: the key file and the payload: {seen}"
        );
        for line in lines {
            let (mode, file) = line.split_once(' ').unwrap();
            assert_eq!(mode, "-rw-------", "{then}: {file}");
            assert!(!Path::new(file).exists(), "{then}: {file} is gone");
            assert!(
                !Path::new(&format!("{file}.sig")).exists(),
                "{then}: {file}.sig is gone"
            );
        }
    }
}

#[test]
fn a_default_key_command_is_bounded_cancelable_and_its_key_signs_with_the_agent_flag() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "1\n");
    d.setup();
    let before = d.head();
    let (program, log) = recording_signer(&w.home, true, true);
    for (k, v) in [
        ("commit.gpgsign", "true"),
        ("gpg.format", "ssh"),
        ("gpg.ssh.program", &*program.to_string_lossy()),
    ] {
        d.git(&["config", k, v]);
    }
    // a command that never answers: the runner's deadline ends it, no commit, no signer run
    d.git(&["config", "gpg.ssh.defaultKeyCommand", "sleep 600"]);
    let exec = Exec::new(Spawner::detached())
        .with_env(w.env())
        .with_deadline(Instant::now() + Duration::from_secs(2));
    TEST_EXEC.with(|e| *e.borrow_mut() = Some(exec));
    d.write("Plan.md", "2\n");
    let started = Instant::now();
    assert!(matches!(commit_user(&d), Err(Error::Signing { .. })));
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!(d.head(), before, "no commit");
    assert!(!log.exists(), "the signer never ran");
    // a command that prints something that is not a key
    d.git(&["config", "gpg.ssh.defaultKeyCommand", "echo not-a-key"]);
    TEST_EXEC.with(|e| *e.borrow_mut() = Some(d.exec.clone()));
    assert!(matches!(commit_user(&d), Err(Error::Signing { .. })));
    assert_eq!(d.head(), before);
    // a working one: its first line is the inline key
    d.git(&[
        "config",
        "gpg.ssh.defaultKeyCommand",
        "echo ssh-ed25519 AAAAfake; echo more",
    ]);
    assert!(commit_user(&d).unwrap().is_some());
    TEST_EXEC.with(|e| *e.borrow_mut() = None);
    let args = logged_args(&log);
    assert_eq!(
        args,
        ["-Y", "sign", "-n", "git", "-f", "<tmp>", "-U", "<tmp>"]
    );
}

#[test]
fn an_untrusted_folder_makes_no_commit_and_says_so_with_signing_off_too() {
    need_git!();
    let w = World::new();
    let d = w.device("A");
    d.write("Plan.md", "1\n");
    d.setup();
    let before = d.head();
    d.write("Plan.md", "2\n");
    let repo = Repo::open(&d.root).unwrap().unwrap().reduced_trust();
    let changes = repo.changes().unwrap();
    let message = super::message::Message::chore(super::message::Scope::Setup, "x", "A");
    match repo.commit(&changes, &message) {
        Err(Error::Operation(text)) => assert!(text.contains("not trusted by git"), "{text}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(d.head(), before);
}
