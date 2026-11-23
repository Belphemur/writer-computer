//! Commit signing through the installed git (ADR 2026-11-18, the 2026-11-23 notes): a fake signer
//! (`gpg.format=ssh`, `gpg.ssh.program` a script) in a temporary `HOME`, never a real key or the
//! user's configuration. Each test skips without a `git` binary.

use super::repo::{Error, Repo, TEST_EXEC};
use super::sync::tests::{have_git, pair, remote_file, run_git, Device, World};
use super::transport::{classify, Exec, Kind, Output};
use super::{commit_user_with, set_signing, ChatNotes, Lfs};
use crate::features::scope::Spawner;
use std::path::{Path, PathBuf};

macro_rules! need_git {
    () => {
        if !have_git() {
            eprintln!("skipped: no git binary");
            return;
        }
    };
}

/// A signer that writes a fake SSH signature where git looks for it (`<buffer>.sig`), or fails.
fn signer(dir: &Path, works: bool) -> PathBuf {
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
struct Through;
impl Through {
    fn of(d: &Device) -> Through {
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
fn sign_with(d: &Device, program: &Path) {
    for (k, v) in [
        ("commit.gpgsign", "true"),
        ("gpg.format", "ssh"),
        ("user.signingkey", "ssh-ed25519 AAAAfakefakefake"),
        ("gpg.ssh.program", &program.to_string_lossy()),
    ] {
        d.git(&["config", k, v]);
    }
}

fn commit_user(d: &Device) -> super::Result<Option<String>> {
    commit_user_with(
        &d.root,
        "{{notes}}",
        &super::sync::tests::ctx(),
        &d.name,
        Lfs::OFF,
        ChatNotes::Commit,
    )
}

fn object(d: &Device, rev: &str) -> String {
    d.git(&["cat-file", "-p", rev])
}

#[test]
fn a_commit_is_signed_by_git_when_the_config_says_so() {
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
fn signing_off_never_calls_commit_tree() {
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
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(
        calls.contains("config --get"),
        "the setting is read: {calls}"
    );
    assert!(!calls.contains("commit-tree"), "{calls}");
    assert!(!object(&d, "HEAD").contains("gpgsig"));
    // and on: the very same flow goes through commit-tree
    sign_with(&d, &signer(&w.home, true));
    d.write("Plan.md", "# Plan\nmore\nagain\n");
    commit_user(&d).unwrap();
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("commit-tree -S"), "{calls}");
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
