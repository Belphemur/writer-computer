//! LFS against temp repositories and a local bare remote (spec "LFS"). `git-lfs` itself is rarely
//! on a CI machine, so most paths run against a fake `git-lfs` on the runner's `PATH`: a shell
//! script that logs its arguments and moves `.git/lfs/objects` between the repositories and a
//! shared "server" folder, which is all the engine asks of the real one (it records pointers and
//! objects itself, `lfs.rs`). The test that needs the real tool skips without it.

use super::lfs::{self, Lfs, Pointer};
use super::sync::tests::{ctx, have_git, run_git, Device, World};
use super::sync::{self, Options};
use super::transport::Exec;
use super::{commit_user, history, status, IdentityCache};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

macro_rules! need_git {
    () => {
        if !have_git() {
            eprintln!("skipped: no git binary");
            return;
        }
    };
}

const SMALL: u64 = 1024; // the threshold of these tests: 1 KiB stands for 100 MB

fn common(d: &Device) -> PathBuf {
    d.root.join(".git")
}

fn on() -> Lfs {
    Lfs {
        enabled: true,
        threshold: SMALL,
    }
}

fn off() -> Lfs {
    Lfs {
        enabled: false,
        threshold: SMALL,
    }
}

/// A fake `git-lfs`: `install` records, `push` copies this repository's objects to the server,
/// `fetch` copies the server's objects here. Every call is appended to `calls.log`.
fn fake_lfs(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let server = dir.join("lfs-server");
    std::fs::create_dir_all(&server).unwrap();
    let script = format!(
        r#"#!/bin/sh
echo "$@" >> "{log}"
case "$1" in
  install)
    printf '[filter "lfs"]\n\tclean = git-lfs clean -- %%f\n\tsmudge = git-lfs smudge -- %%f\n\tprocess = git-lfs filter-process\n\trequired = true\n' >> "$(git rev-parse --git-dir)/config"
    ;;
  push)
    mkdir -p "$(git rev-parse --git-dir)/lfs/objects"
    cp -R "$(git rev-parse --git-dir)/lfs/objects/." "{server}/" 2>/dev/null
    ;;
  fetch)
    mkdir -p "$(git rev-parse --git-dir)/lfs/objects"
    cp -R "{server}/." "$(git rev-parse --git-dir)/lfs/objects/" 2>/dev/null
    ;;
  fail)
    echo "batch response: boom" >&2; exit 2 ;;
esac
exit 0
"#,
        log = dir.join("calls.log").display(),
        server = server.display()
    );
    let tool = bin.join("git-lfs");
    std::fs::write(&tool, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}

fn calls(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("calls.log"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

fn with_lfs_tool(w: &World, d: &Device, bin: &Path) -> Device {
    let _ = w;
    Device {
        root: d.root.clone(),
        name: d.name.clone(),
        exec: d.exec.clone().with_path_prefix(vec![bin.to_path_buf()]),
        env: d.env.clone(),
    }
}

fn commit(d: &Device, lfs: Lfs) -> Option<String> {
    commit_user(&d.root, "{{notes}}", &ctx(), &d.name, lfs).unwrap()
}

fn sync_with(d: &Device, _lfs: Lfs) -> sync::Outcome {
    sync::sync(
        &d.root,
        &Options {
            exec: &d.exec,
            helper: None,
            secrets: Vec::new(),
            device: &d.name,
            unlocked: None,
            announce: None,
        },
    )
}

fn ok(d: &Device, lfs: Lfs) -> sync::Report {
    let o = sync_with(d, lfs);
    if let Some(e) = &o.error {
        let details = match e {
            sync::Error::Transport(t) => t.details.clone(),
            _ => String::new(),
        };
        panic!("sync failed: {e} {details}");
    }
    o.report
}

fn big(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u8).wrapping_add(seed)).collect()
}

/// The blob git holds for `path` at HEAD, as text.
fn head_blob(d: &Device, path: &str) -> String {
    d.git(&["show", &format!("HEAD:{path}")])
}

// ---- the managed .gitattributes block ----------------------------------------------------------

#[test]
fn a_file_over_the_threshold_is_committed_as_a_pointer_with_its_object_stored() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("Plan.md", "# Plan\n");
    a.setup();
    let content = big(5000, 1);
    a.write_bytes("media/clip.bin", &content);
    a.write(
        ".gitattributes",
        "*.psd filter=lfs diff=lfs merge=lfs -text\n",
    );
    let id = commit(&a, on()).expect("committed");
    assert!(!id.is_empty());
    let p = lfs::pointer_of_bytes(&content);
    assert_eq!(head_blob(&a, "media/clip.bin"), p.text());
    assert!(lfs::has_object(&common(&a), &p));
    assert!(lfs::object_path(&common(&a), &p).is_file());
    // the real file is untouched on disk
    assert_eq!(
        std::fs::read(a.root.join("media/clip.bin")).unwrap(),
        content
    );
    // the managed block tracks exactly that file, the user's line is kept
    let attrs = a.read(".gitattributes");
    assert!(
        attrs.starts_with("*.psd filter=lfs diff=lfs merge=lfs -text\n"),
        "{attrs}"
    );
    assert_eq!(lfs::tracked(&attrs), ["media/clip.bin".to_string()].into());
    assert_eq!(
        head_blob(&a, ".gitattributes"),
        attrs,
        ".gitattributes is in the same commit"
    );
    // a small file is plain
    assert_eq!(head_blob(&a, "Plan.md"), "# Plan\n");
    // nothing is pending: the pointer equals what is on disk
    let s = status(&a.root, &IdentityCache::default(), true, on()).unwrap();
    assert!(s.changes.is_empty(), "{:?}", s.changes);
    assert!(s.too_large.is_empty());
    assert_eq!(s.lfs_files, 1);
}

#[test]
fn the_block_is_rewritten_idempotently_and_a_gone_file_drops_out() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("one.bin", &big(3000, 1));
    commit(&a, on());
    a.write_bytes("two bin [x].bin", &big(3000, 2));
    commit(&a, on());
    let attrs = a.read(".gitattributes");
    assert_eq!(
        lfs::tracked(&attrs),
        ["one.bin".to_string(), "two bin [x].bin".to_string()].into()
    );
    // committing again changes nothing
    assert!(commit(&a, on()).is_none());
    assert_eq!(a.read(".gitattributes"), attrs);
    std::fs::remove_file(a.root.join("one.bin")).unwrap();
    a.write_bytes("three.bin", &big(3000, 3));
    commit(&a, on());
    // one.bin's pointer is still in HEAD until this commit lands: its line stays for now
    assert_eq!(
        lfs::tracked(&a.read(".gitattributes")),
        ["one.bin", "three.bin", "two bin [x].bin"]
            .map(String::from)
            .into()
    );
    a.write_bytes("four.bin", &big(3000, 4));
    commit(&a, on());
    assert_eq!(
        lfs::tracked(&a.read(".gitattributes")),
        ["four.bin", "three.bin", "two bin [x].bin"]
            .map(String::from)
            .into()
    );
    // git itself agrees which files the block names (the pattern escapes are right)
    let out = a.git(&[
        "check-attr",
        "filter",
        "--",
        "two bin [x].bin",
        "three.bin",
        "n.md",
    ]);
    assert!(out.contains("two bin [x].bin: filter: lfs"), "{out}");
    assert!(out.contains("three.bin: filter: lfs"), "{out}");
    assert!(out.contains("n.md: filter: unspecified"), "{out}");
}

#[test]
fn the_threshold_comes_from_the_setting() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("mid.bin", &big(2000, 1));
    // above 1 KiB but below a 4 KiB threshold: plain
    let high = Lfs::from_settings(true, 1.0, true);
    assert_eq!(high.threshold, 1024 * 1024);
    commit(
        &a,
        Lfs {
            enabled: true,
            threshold: 4096,
        },
    );
    assert!(!lfs::is_pointer(head_blob(&a, "mid.bin").as_bytes()));
    a.write_bytes("mid.bin", &big(5000, 1));
    commit(
        &a,
        Lfs {
            enabled: true,
            threshold: 4096,
        },
    );
    assert!(lfs::is_pointer(head_blob(&a, "mid.bin").as_bytes()));
}

#[test]
fn with_lfs_off_a_large_file_is_skipped_as_before() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("huge.bin", &big(5000, 1));
    let s = status(&a.root, &IdentityCache::default(), true, off()).unwrap();
    assert_eq!(s.too_large, vec!["huge.bin"]);
    commit(&a, off());
    assert!(a.git(&["ls-files"]).lines().all(|l| l != "huge.bin"));
    assert!(!a.root.join(".gitattributes").exists());
    assert!(!lfs::has_store(&common(&a)));
}

#[test]
fn turning_lfs_off_later_keeps_what_is_in_lfs_and_adds_nothing() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    let v1 = big(5000, 1);
    a.write_bytes("keep.bin", &v1);
    commit(&a, on());
    let attrs = a.read(".gitattributes");
    let history_before = a.git(&["log", "--format=%H"]);
    // off: a new large file is not versioned, the existing one is unchanged and not pending
    a.write_bytes("new.bin", &big(5000, 9));
    let s = status(&a.root, &IdentityCache::default(), true, off()).unwrap();
    assert!(s.changes.is_empty(), "{:?}", s.changes);
    assert_eq!(s.too_large, vec!["new.bin"]);
    assert_eq!(s.lfs_files, 1, "the panel still counts it");
    commit(&a, off());
    assert_eq!(
        a.git(&["log", "--format=%H"]),
        history_before,
        "no history rewritten"
    );
    assert_eq!(a.read(".gitattributes"), attrs);
    // an edit to the existing LFS file stays in LFS (git would clean it the same way)
    let v2 = big(6000, 2);
    a.write_bytes("keep.bin", &v2);
    commit(&a, off());
    assert_eq!(head_blob(&a, "keep.bin"), lfs::pointer_of_bytes(&v2).text());
}

#[test]
fn a_moved_large_file_is_one_move() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("a.bin", &big(4000, 1));
    commit(&a, on());
    std::fs::create_dir_all(a.root.join("sub")).unwrap();
    std::fs::rename(a.root.join("a.bin"), a.root.join("sub/a.bin")).unwrap();
    let repo = super::Repo::open_with(&a.root, on()).unwrap().unwrap();
    let changes = repo.changes().unwrap();
    assert_eq!(
        changes,
        vec![super::Change::Move {
            from: "a.bin".into(),
            to: "sub/a.bin".into()
        }]
    );
    commit(&a, on());
    // a.bin's pointer is still in HEAD when the block is written: its line stays one more commit
    assert_eq!(
        lfs::tracked(&a.read(".gitattributes")),
        ["a.bin", "sub/a.bin"].map(String::from).into()
    );
    assert_eq!(
        head_blob(&a, "sub/a.bin"),
        lfs::pointer_of_bytes(&big(4000, 1)).text()
    );
}

// ---- transfer: push, a second device pulls ------------------------------------------------------

#[test]
fn push_sends_objects_first_and_a_second_clone_gets_the_real_content() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    let content = big(5000, 7);
    a.write_bytes("media/clip.bin", &content);
    assert!(commit(&a, on()).is_some());
    let r = ok(&a, on());
    assert!(r.pushed >= 1);
    let log = calls(w._tmp.path());
    let push_at = log
        .iter()
        .position(|l| l.starts_with("push origin refs/heads/main"));
    assert!(push_at.is_some(), "{log:?}");
    // the remote holds the pointer, never the content
    let remote = super::sync::tests::remote_file(&w, "media/clip.bin").unwrap();
    assert_eq!(remote, lfs::pointer_of_bytes(&content).text());

    // a second device clones (a plain clone: pointers on disk) and syncs with LFS on
    let b = with_lfs_tool(&w, &w.clone_device("B"), &bin);
    assert!(lfs::file_is_pointer(&b.root.join("media/clip.bin")));
    b.setup();
    commit(&b, on());
    ok(&b, on());
    assert_eq!(
        std::fs::read(b.root.join("media/clip.bin")).unwrap(),
        content
    );
    assert!(calls(w._tmp.path())
        .iter()
        .any(|l| l.starts_with("fetch origin refs/remotes/origin/main")));
    // and nothing is pending there
    let s = status(&b.root, &IdentityCache::default(), true, on()).unwrap();
    assert!(s.changes.is_empty(), "{:?}", s.changes);
}

#[test]
fn a_large_file_that_arrives_later_is_written_as_its_content() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    ok(&a, on());
    let b = with_lfs_tool(&w, &w.clone_device("B"), &bin);
    b.setup();
    commit(&b, on());
    ok(&b, on());
    // A adds a large file; B takes it in on its next sync
    let content = big(5000, 4);
    a.write_bytes("big.bin", &content);
    commit(&a, on());
    ok(&a, on());
    let report = ok(&b, on());
    assert!(report.written.contains(&"big.bin".to_string()));
    assert_eq!(std::fs::read(b.root.join("big.bin")).unwrap(), content);
    // B edits it: a new pointer, pushed; A gets the new content
    let v2 = big(6000, 5);
    b.write_bytes("big.bin", &v2);
    commit(&b, on());
    ok(&b, on());
    ok(&a, on());
    assert_eq!(std::fs::read(a.root.join("big.bin")).unwrap(), v2);
}

#[test]
fn two_devices_that_each_add_a_large_file_keep_both_in_the_block() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    ok(&a, on());
    let b = with_lfs_tool(&w, &w.clone_device("B"), &bin);
    b.setup();
    commit(&b, on());
    ok(&b, on());
    ok(&a, on());
    a.write_bytes("from-a.bin", &big(4000, 1));
    b.write_bytes("from-b.bin", &big(4000, 2));
    commit(&a, on());
    commit(&b, on());
    ok(&a, on());
    ok(&b, on()); // diverged: replay merges the two attribute blocks
    ok(&a, on());
    for d in [&a, &b] {
        assert_eq!(
            lfs::tracked(&d.read(".gitattributes")),
            ["from-a.bin".to_string(), "from-b.bin".to_string()].into(),
            "{}",
            d.name
        );
        assert!(d.root.join("from-a.bin").is_file() && d.root.join("from-b.bin").is_file());
    }
    assert!(super::conflicts::paths(&b.root).is_empty());
}

#[test]
fn without_git_lfs_the_push_stops_before_a_pointer_reaches_the_remote() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("big.bin", &big(4000, 1));
    commit(&a, on());
    // no fake on the path, and the runner searches only its own folder: git-lfs is not found
    let empty = w._tmp.path().join("nothing");
    std::fs::create_dir_all(&empty).unwrap();
    let exec = Exec::new(crate::features::scope::Spawner::detached())
        .with_env(a.env.clone())
        .with_path_prefix(vec![empty]);
    if exec.lfs_installed() {
        eprintln!("skipped: git-lfs is installed on the usual path");
        return;
    }
    let o = sync::sync(
        &a.root,
        &Options {
            exec: &exec,
            helper: None,
            secrets: Vec::new(),
            device: "A",
            unlocked: None,
            announce: None,
        },
    );
    match o.error {
        Some(sync::Error::Transport(t)) => {
            assert_eq!(t.kind, super::transport::Kind::NoLfs);
            assert_eq!(t.line, "Install git-lfs to sync large files");
        }
        other => panic!("{other:?}"),
    }
    assert!(super::sync::tests::remote_file(&w, "big.bin").is_none());
}

#[test]
fn an_lfs_error_is_one_sanitized_line() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    // a `git-lfs` that fails every transfer
    let tool = bin.join("git-lfs");
    let script = std::fs::read_to_string(&tool)
        .unwrap()
        .replace("  push)", "  push)\n    echo \"batch response: https://user:secret@host/x.git\" >&2; exit 2 ;;\n  pushx)");
    std::fs::write(&tool, script).unwrap();
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("big.bin", &big(4000, 1));
    commit(&a, on());
    let o = sync_with(&a, on());
    match o.error {
        Some(sync::Error::Transport(t)) => {
            assert_eq!(t.line, "Large file transfer failed");
            assert!(
                t.details.contains("host/x.git") && !t.details.contains("secret"),
                "{}",
                t.details
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn install_runs_once_and_only_when_enabled() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    super::ensure_lfs(&a.exec, &a.root, off()).unwrap();
    assert!(calls(w._tmp.path()).is_empty(), "off: no child");
    super::ensure_lfs(&a.exec, &a.root, on()).unwrap();
    assert_eq!(calls(w._tmp.path()), vec!["install --local"]);
    assert!(lfs::installed_in(&common(&a)));
    super::ensure_lfs(&a.exec, &a.root, on()).unwrap();
    assert_eq!(
        calls(w._tmp.path()).len(),
        1,
        "the config already has the filter"
    );
}

#[test]
fn status_and_commits_never_run_the_lfs_filter() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    super::ensure_lfs(&a.exec, &a.root, on()).unwrap();
    a.write_bytes("big.bin", &big(4000, 1));
    commit(&a, on());
    a.write_bytes("big.bin", &big(4500, 2));
    a.write("n.md", "n2");
    let s = status(&a.root, &IdentityCache::default(), true, on()).unwrap();
    assert_eq!(s.changes.len(), 2, "{:?}", s.changes);
    commit(&a, on());
    let s = status(&a.root, &IdentityCache::default(), true, on()).unwrap();
    assert!(s.changes.is_empty());
    // the filter is configured and the file is tracked, yet git-lfs ran only for `install`
    assert_eq!(calls(w._tmp.path()), vec!["install --local"]);
}

// ---- history, diff, restore ----------------------------------------------------------------------

#[test]
fn history_shows_sizes_and_restore_brings_back_the_real_content() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    let v1 = big(5000, 1);
    let v2 = big(7000, 2);
    a.write_bytes("clip.bin", &v1);
    commit(&a, on());
    a.write_bytes("clip.bin", &v2);
    commit(&a, on());
    let repo = super::Repo::open_with(&a.root, on()).unwrap().unwrap();
    let rows = history::versions(&repo, "clip.bin", 10).unwrap();
    assert_eq!(rows.len(), 2);
    // the diff of the newest version: binary, with the two real sizes
    let d = history::diff(
        &repo,
        &a.root,
        "clip.bin",
        &rows[0].version.id,
        &history::Against::Parent,
    )
    .unwrap();
    match d {
        history::FileDiff::Binary {
            before_size,
            after_size,
        } => {
            assert_eq!((before_size, after_size), (Some(5000), Some(7000)));
        }
        other => panic!("{other:?}"),
    }
    // restore the old version: the file is the real old content again, a new pointer is committed
    let restored = history::restore(&repo, &a.root, "clip.bin", &rows[1].version.id, "A").unwrap();
    assert_eq!(restored.path, "clip.bin");
    assert_eq!(std::fs::read(a.root.join("clip.bin")).unwrap(), v1);
    assert_eq!(head_blob(&a, "clip.bin"), lfs::pointer_of_bytes(&v1).text());
}

#[test]
fn restore_refuses_to_write_a_pointer_that_was_never_downloaded() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("clip.bin", &big(5000, 1));
    commit(&a, on());
    a.write_bytes("clip.bin", &big(5000, 2));
    commit(&a, on());
    let old = lfs::pointer_of_bytes(&big(5000, 1));
    std::fs::remove_file(lfs::object_path(&common(&a), &old)).unwrap();
    let repo = super::Repo::open_with(&a.root, on()).unwrap().unwrap();
    let rows = history::versions(&repo, "clip.bin", 10).unwrap();
    let err = history::restore(&repo, &a.root, "clip.bin", &rows[1].version.id, "A").unwrap_err();
    assert!(err.to_string().contains("not downloaded"), "{err}");
    // the user's file was not touched
    assert_eq!(
        std::fs::read(a.root.join("clip.bin")).unwrap(),
        big(5000, 2)
    );
    // and its diff is the sizes from the pointer
    let d = history::diff(
        &repo,
        &a.root,
        "clip.bin",
        &rows[0].version.id,
        &history::Against::Parent,
    )
    .unwrap();
    assert!(
        matches!(
            d,
            history::FileDiff::Binary {
                before_size: Some(5000),
                ..
            }
        ),
        "{d:?}"
    );
}

// ---- off means no LFS work -------------------------------------------------------------------------

#[test]
fn a_vault_without_large_files_does_no_lfs_work_even_with_the_setting_on() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    ok(&a, on());
    a.write("n.md", "n2");
    commit(&a, on());
    ok(&a, on());
    assert!(
        calls(w._tmp.path()).is_empty(),
        "{:?}",
        calls(w._tmp.path())
    );
    assert!(!a.root.join(".gitattributes").exists());
}

#[test]
fn the_pointer_text_is_what_git_lfs_writes() {
    let p = Pointer {
        oid: "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393".into(),
        size: 12345,
    };
    assert_eq!(
        p.text(),
        "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n"
    );
}

// ---- the real git-lfs (skipped when it is not installed) ---------------------------------------------

#[test]
#[ignore = "needs git-lfs on the login-shell PATH: cargo test -- --ignored"]
fn real_git_lfs_round_trips_a_large_file_through_a_local_bare_remote() {
    need_git!();
    let w = World::new();
    let exec = w.exec();
    assert!(exec.lfs_installed(), "this test needs git-lfs installed");
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    let content = big(5000, 3);
    a.write_bytes("big.bin", &content);
    super::ensure_lfs(&a.exec, &a.root, on()).unwrap();
    assert!(lfs::installed_in(&common(&a)));
    commit(&a, on());
    ok(&a, on());
    // the objects reached the remote's own store
    assert!(
        w.remote.join("lfs/objects").is_dir(),
        "the objects reached the remote"
    );
    let b = w.clone_device("B");
    run_git(&b.env, &b.root, &["lfs", "install", "--local"]);
    b.setup();
    commit(&b, on());
    ok(&b, on());
    assert_eq!(std::fs::read(b.root.join("big.bin")).unwrap(), content);
    // git's own clean filter agrees with the pointer Writer wrote
    let ls = run_git(&a.env, &a.root, &["lfs", "ls-files"]);
    assert!(ls.contains("big.bin"), "{ls}");
}

// ---- review fixes ---------------------------------------------------------------------------------

fn tracked_vault(w: &World, bin: &Path) -> Device {
    let a = with_lfs_tool(w, &w.device("A"), bin);
    a.write("n.md", "n");
    a.setup();
    a
}

fn changes_of(d: &Device, lfs: Lfs) -> Vec<super::Change> {
    super::Repo::open_with(&d.root, lfs)
        .unwrap()
        .unwrap()
        .changes()
        .unwrap()
}

#[test]
fn a_moved_lfs_file_stays_in_lfs_when_lfs_is_off() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    let v = big(5000, 1);
    a.write_bytes("a.bin", &v);
    commit(&a, on());
    std::fs::create_dir_all(a.root.join("sub")).unwrap();
    std::fs::rename(a.root.join("a.bin"), a.root.join("sub/a.bin")).unwrap();
    // off: not a delete plus "Not versioned"
    let s = status(&a.root, &IdentityCache::default(), true, off()).unwrap();
    assert!(s.too_large.is_empty(), "{:?}", s.too_large);
    assert_eq!(
        s.changes,
        vec![super::Change::Move {
            from: "a.bin".into(),
            to: "sub/a.bin".into()
        }]
    );
    commit(&a, off());
    assert_eq!(head_blob(&a, "sub/a.bin"), lfs::pointer_of_bytes(&v).text());
    assert!(a.git(&["ls-files"]).lines().all(|l| l != "a.bin"));
    // the new path is tracked in the block so git's own filter agrees
    assert!(a
        .git(&["check-attr", "filter", "--", "sub/a.bin"])
        .contains("filter: lfs"));
}

#[test]
fn a_moved_lfs_file_stays_in_lfs_when_the_threshold_is_raised() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    let v = big(5000, 1);
    a.write_bytes("a.bin", &v);
    commit(&a, on());
    std::fs::rename(a.root.join("a.bin"), a.root.join("b.bin")).unwrap();
    // a threshold far above the file: it is still the same LFS file, moved
    let high = Lfs {
        enabled: true,
        threshold: 1 << 30,
    };
    assert_eq!(
        changes_of(&a, high),
        vec![super::Change::Move {
            from: "a.bin".into(),
            to: "b.bin".into()
        }]
    );
    commit(&a, high);
    assert_eq!(head_blob(&a, "b.bin"), lfs::pointer_of_bytes(&v).text());
}

#[test]
fn a_shrunk_then_moved_lfs_file_is_a_delete_and_a_small_plain_add() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("a.bin", &big(5000, 1));
    commit(&a, on());
    std::fs::remove_file(a.root.join("a.bin")).unwrap();
    a.write_bytes("small.bin", &big(100, 1)); // different content, under the threshold
    let changes = changes_of(&a, off());
    assert_eq!(
        changes,
        vec![
            super::Change::Delete("a.bin".into()),
            super::Change::Add("small.bin".into())
        ]
    );
    commit(&a, off());
    assert_eq!(head_blob(&a, "small.bin").as_bytes(), &big(100, 1)[..]);
}

#[test]
fn the_users_own_lfs_rule_applies_below_the_threshold() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = tracked_vault(&w, &bin);
    a.write(
        ".gitattributes",
        "*.psd filter=lfs diff=lfs merge=lfs -text\n",
    );
    commit(&a, on());
    super::ensure_lfs(&a.exec, &a.root, on()).unwrap(); // the fake writes the process filter too
    let before = calls(w._tmp.path());
    let v = big(2048, 3); // 2 KiB, threshold 4 KiB
    a.write_bytes("art.psd", &v);
    let high = Lfs {
        enabled: true,
        threshold: 4096,
    };
    commit(&a, high);
    assert_eq!(head_blob(&a, "art.psd"), lfs::pointer_of_bytes(&v).text());
    // an edit and a status: git-lfs is never started by us
    a.write_bytes("art.psd", &big(2100, 4));
    let s = status(&a.root, &IdentityCache::default(), true, high).unwrap();
    assert_eq!(s.changes, vec![super::Change::Edit("art.psd".into())]);
    assert_eq!(calls(w._tmp.path()), before);
    // the managed block is not needed for it
    assert!(!lfs::tracked(&a.read(".gitattributes")).contains("art.psd"));
    // and off, a covered file over the threshold is versioned, not "too large"
    a.write_bytes("big.psd", &big(8000, 1));
    let s = status(&a.root, &IdentityCache::default(), true, off()).unwrap();
    assert!(s.too_large.is_empty(), "{:?}", s.too_large);
}

#[test]
fn a_gitattributes_both_devices_changed_keeps_lines_outside_the_block() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    ok(&a, on());
    let b = with_lfs_tool(&w, &w.clone_device("B"), &bin);
    b.setup();
    commit(&b, on());
    ok(&b, on());
    ok(&a, on());
    // A tracks a large file; B adds its own rule at the top and tracks another
    a.write_bytes("a.bin", &big(4000, 1));
    commit(&a, on());
    let theirs = std::fs::read_to_string(b.root.join(".gitattributes")).unwrap_or_default();
    b.write(
        ".gitattributes",
        &format!("*.psd filter=lfs diff=lfs merge=lfs -text\n{theirs}"),
    );
    b.write_bytes("b.bin", &big(4000, 2));
    commit(&b, on());
    ok(&a, on());
    ok(&b, on());
    ok(&a, on());
    for d in [&a, &b] {
        let text = d.read(".gitattributes");
        assert!(text.starts_with("*.psd filter=lfs"), "{text}");
        assert_eq!(
            lfs::tracked(&text),
            ["a.bin", "b.bin"].map(String::from).into(),
            "{}",
            d.name
        );
    }
    assert!(super::conflicts::paths(&a.root).is_empty());
}

#[test]
fn an_overlap_outside_the_block_is_a_normal_conflict() {
    let block = lfs::apply("", &BTreeSet::new());
    let base = format!("top\n{block}");
    let m = format!("mine\n{block}");
    let t = format!("theirs\n{block}");
    match super::merge::merge_file(
        ".gitattributes",
        Some(base.as_bytes()),
        Some(m.as_bytes()),
        Some(t.as_bytes()),
    ) {
        super::merge::Merged::Conflict(_) => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_failed_download_never_stops_the_sync_and_the_push_goes_on() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("big.bin", &big(4000, 1));
    commit(&a, on());
    ok(&a, on());
    let b = with_lfs_tool(&w, &w.clone_device("B"), &bin);
    b.setup();
    commit(&b, on());
    // B has only the pointer (a plain clone) and every fetch fails
    let tool = bin.join("git-lfs");
    let script = std::fs::read_to_string(&tool).unwrap().replace(
        "  fetch)",
        "  fetch)\n    echo nope >&2; exit 2 ;;\n  fetchx)",
    );
    std::fs::write(&tool, script).unwrap();
    b.write("later.md", "later");
    commit(&b, on());
    let o = sync_with(&b, on());
    assert!(o.error.is_none(), "{:?}", o.error);
    assert_eq!(o.report.lfs_missing, vec!["big.bin".to_string()]);
    assert!(
        lfs::file_is_pointer(&b.root.join("big.bin")),
        "the pointer is left"
    );
    assert!(
        super::sync::tests::remote_file(&w, "later.md").is_some(),
        "the push went on"
    );
}

#[test]
fn versions_and_diffs_of_large_files_read_no_object() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("clip.bin", &big(5000, 1));
    commit(&a, on());
    a.write_bytes("clip.bin", &big(7000, 2));
    commit(&a, on());
    let repo = super::Repo::open_with(&a.root, on()).unwrap().unwrap();
    lfs::OBJECT_READS.with(|c| c.set(0));
    lfs::HASHES.with(|c| c.set(0));
    let rows = history::versions(&repo, "clip.bin", 10).unwrap();
    assert!(rows.iter().all(|r| r.added.is_none()));
    for against in [
        history::Against::Parent,
        history::Against::Current,
        history::Against::Version(rows[1].version.id.clone()),
    ] {
        let d = history::diff(&repo, &a.root, "clip.bin", &rows[0].version.id, &against).unwrap();
        assert!(matches!(d, history::FileDiff::Binary { .. }), "{d:?}");
    }
    assert_eq!(lfs::OBJECT_READS.with(|c| c.get()), 0);
    assert_eq!(lfs::HASHES.with(|c| c.get()), 0);
}

#[test]
fn the_status_poll_hashes_no_untracked_large_file() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("new.bin", &big(5000, 1));
    lfs::HASHES.with(|c| c.set(0));
    for lfs_setting in [on(), off(), on()] {
        status(&a.root, &IdentityCache::default(), true, lfs_setting).unwrap();
    }
    assert_eq!(lfs::HASHES.with(|c| c.get()), 0);
}

#[test]
fn a_large_file_is_copied_into_the_store_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let common = dir.path().join(".git");
    std::fs::create_dir_all(&common).unwrap();
    let f = dir.path().join("f.bin");
    std::fs::write(&f, big(3000, 1)).unwrap();
    let p = lfs::store_file(&common, &f).unwrap();
    let stored = std::fs::metadata(lfs::object_path(&common, &p))
        .unwrap()
        .modified()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(lfs::store_file(&common, &f).unwrap(), p);
    let again = std::fs::metadata(lfs::object_path(&common, &p))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(stored, again, "not copied again");
    // a store with a vanished tmp leaves nothing behind
    assert_eq!(
        std::fs::read_dir(common.join("lfs/tmp")).unwrap().count(),
        0
    );
}

#[test]
fn the_lock_is_let_go_for_a_transfer_and_a_commit_that_lands_meanwhile_is_pushed_too() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("big.bin", &big(4000, 1));
    commit(&a, on());
    let during = std::cell::Cell::new(0);
    let unlock = |f: &mut dyn FnMut()| {
        // the "lock is free" window: a commit (an agent turn starting) lands
        if during.get() == 0 {
            a.write("meanwhile.md", "x");
            commit(&a, on());
        }
        during.set(during.get() + 1);
        f();
    };
    let o = sync::sync(
        &a.root,
        &Options {
            exec: &a.exec,
            helper: None,
            secrets: Vec::new(),
            device: "A",
            unlocked: Some(&unlock),
            announce: None,
        },
    );
    assert!(o.error.is_none(), "{:?}", o.error);
    assert!(during.get() >= 1);
    assert!(super::sync::tests::remote_file(&w, "meanwhile.md").is_some());
    assert_eq!(
        super::sync::tests::remote_file(&w, "big.bin").unwrap(),
        lfs::pointer_of_bytes(&big(4000, 1)).text()
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_parent_never_receives_a_restored_large_file() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    let out = w._tmp.path().join("outside");
    std::fs::create_dir_all(&out).unwrap();
    a.write_bytes("d/clip.bin", &big(5000, 1));
    commit(&a, on());
    a.write_bytes("d/clip.bin", &big(5000, 2));
    commit(&a, on());
    // `d` becomes a link out of the vault
    std::fs::remove_dir_all(a.root.join("d")).unwrap();
    std::os::unix::fs::symlink(&out, a.root.join("d")).unwrap();
    let repo = super::Repo::open_with(&a.root, on()).unwrap().unwrap();
    let rows = history::versions(&repo, "d/clip.bin", 10).unwrap();
    let err = history::restore(&repo, &a.root, "d/clip.bin", &rows[1].version.id, "A");
    assert!(err.is_err());
    assert_eq!(
        std::fs::read_dir(&out).unwrap().count(),
        0,
        "nothing was written outside"
    );
}

#[test]
fn a_failed_materialize_leaves_no_temp_file_anywhere() {
    let dir = tempfile::tempdir().unwrap();
    let common = dir.path().join(".git");
    let vault = dir.path().join("vault");
    std::fs::create_dir_all(&common).unwrap();
    std::fs::create_dir_all(vault.join("target")).unwrap(); // a directory where the file goes
    let f = dir.path().join("f.bin");
    std::fs::write(&f, big(3000, 1)).unwrap();
    let p = lfs::store_file(&common, &f).unwrap();
    assert!(lfs::materialize(&common, &vault.join("target"), &p).is_err());
    assert_eq!(
        std::fs::read_dir(&vault).unwrap().count(),
        1,
        "the vault holds only what it had"
    );
    assert_eq!(
        std::fs::read_dir(common.join("lfs/tmp")).unwrap().count(),
        0
    );
}

#[test]
fn files_written_from_pointers_are_announced() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("big.bin", &big(4000, 1));
    commit(&a, on());
    ok(&a, on());
    // B is a plain clone: big.bin is a pointer on disk until the sync catches up
    let b = with_lfs_tool(&w, &w.clone_device("B"), &bin);
    b.setup();
    commit(&b, on());
    let seen = std::cell::RefCell::new(Vec::<String>::new());
    let announce = |paths: &[String]| seen.borrow_mut().extend(paths.iter().cloned());
    let o = sync::sync(
        &b.root,
        &Options {
            exec: &b.exec,
            helper: None,
            secrets: Vec::new(),
            device: "B",
            unlocked: None,
            announce: Some(&announce),
        },
    );
    assert!(o.error.is_none(), "{:?}", o.error);
    assert!(
        seen.borrow().contains(&"big.bin".to_string()),
        "{:?}",
        seen.borrow()
    );
    assert_eq!(std::fs::read(b.root.join("big.bin")).unwrap(), big(4000, 1));
}

#[test]
fn lfs_commands_pin_the_remotes_own_server() {
    use super::transport::lfs_endpoint;
    assert_eq!(
        lfs_endpoint("https://github.com/me/vault.git").as_deref(),
        Some("https://github.com/me/vault.git/info/lfs")
    );
    assert_eq!(
        lfs_endpoint("https://github.com/me/vault/").as_deref(),
        Some("https://github.com/me/vault.git/info/lfs")
    );
    assert_eq!(lfs_endpoint("git@github.com:me/vault.git"), None);
    assert_eq!(lfs_endpoint("file:///tmp/remote.git"), None);
    let exec = Exec::new(crate::features::scope::Spawner::detached());
    let cmd = exec.git_lfs(
        Path::new("/vault"),
        None,
        Some("https://github.com/me/vault.git/info/lfs"),
        &["push", "origin", "refs/heads/main"],
    );
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let at = args.iter().position(|a| a == "lfs").unwrap();
    assert!(
        args[..at].contains(&"lfs.url=https://github.com/me/vault.git/info/lfs".to_string()),
        "{args:?}"
    );
    assert!(
        args[..at].contains(&"lfs.pushurl=https://github.com/me/vault.git/info/lfs".to_string())
    );
    assert_eq!(&args[at..], ["lfs", "push", "origin", "refs/heads/main"]);
}

#[test]
fn git_lfs_found_in_a_search_dir_is_on_the_path_of_every_child_so_hooks_find_it() {
    need_git!();
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = with_lfs_tool(&w, &w.device("A"), &bin);
    a.write("n.md", "n");
    a.setup();
    assert!(std::env::split_paths(&a.exec.path()).any(|p| p == bin));
    // a pre-push hook that calls the tool by name, as `git lfs install` writes it
    let hook = a.root.join(".git/hooks/pre-push");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\ngit-lfs pre-push \"$@\"\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    ok(&a, on());
    assert!(
        calls(w._tmp.path())
            .iter()
            .any(|l| l.starts_with("pre-push origin")),
        "{:?}",
        calls(w._tmp.path())
    );
}

/// The process working directory is shared by every test: one test at a time moves it.
static CWD: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn status_from_a_vault_subfolder_never_starts_the_filter() {
    need_git!();
    let _only = CWD.lock().unwrap_or_else(|e| e.into_inner());
    let w = World::new();
    let bin = fake_lfs(w._tmp.path());
    let a = tracked_vault(&w, &bin);
    super::ensure_lfs(&a.exec, &a.root, on()).unwrap();
    a.write_bytes("sub/big.bin", &big(4000, 1));
    commit(&a, on());
    a.write_bytes("sub/big.bin", &big(4100, 2));
    let before = calls(w._tmp.path());
    let here = std::env::current_dir().unwrap();
    std::env::set_current_dir(a.root.join("sub")).unwrap();
    let s = status(&a.root, &IdentityCache::default(), true, on());
    std::env::set_current_dir(here).unwrap();
    let s = s.unwrap();
    assert_eq!(s.changes, vec![super::Change::Edit("sub/big.bin".into())]);
    assert_eq!(calls(w._tmp.path()), before);
}

#[test]
fn a_linked_worktree_keeps_its_objects_in_the_common_git_dir() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    let wt = w._tmp.path().join("linked");
    a.git(&["worktree", "add", wt.to_str().unwrap(), "-b", "wt"]);
    std::fs::write(wt.join("big.bin"), big(4000, 1)).unwrap();
    commit_user(&wt, "{{notes}}", &ctx(), "A", on())
        .unwrap()
        .expect("committed");
    let p = lfs::pointer_of_bytes(&big(4000, 1));
    assert!(
        lfs::has_object(&a.root.join(".git"), &p),
        "under <common>/lfs/objects"
    );
    assert!(!wt.join(".git").is_dir());
}

#[test]
fn restoring_a_deleted_large_file_with_lfs_off_is_refused_not_a_silent_no_op() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.setup();
    a.write_bytes("clip.bin", &big(5000, 1));
    commit(&a, on());
    std::fs::remove_file(a.root.join("clip.bin")).unwrap();
    commit(&a, off());
    // the next large file rewrites the block: clip.bin's line goes, nothing covers its path now
    a.write_bytes("other.bin", &big(5000, 9));
    commit(&a, on());
    assert!(!lfs::tracked(&a.read(".gitattributes")).contains("clip.bin"));
    let repo = super::Repo::open_with(&a.root, off()).unwrap().unwrap();
    let rows = history::versions(&repo, "clip.bin", 10).unwrap();
    let err = history::restore(&repo, &a.root, "clip.bin", &rows[0].version.id, "A").unwrap_err();
    assert!(err.to_string().contains("Turn on large files"), "{err}");
    assert!(!a.root.join("clip.bin").exists());
    // with LFS on it comes back as a pointer again
    let repo = super::Repo::open_with(&a.root, on()).unwrap().unwrap();
    let done = history::restore(&repo, &a.root, "clip.bin", &rows[0].version.id, "A").unwrap();
    assert!(!done.commit.is_empty());
    assert_eq!(
        std::fs::read(a.root.join("clip.bin")).unwrap(),
        big(5000, 1)
    );
}

#[test]
fn only_the_managed_block_change_is_committed_the_users_other_edits_stay_pending() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("n.md", "n");
    a.write(".gitattributes", "# mine\n");
    a.setup();
    commit(&a, on());
    // an unsaved edit of the user's own file, then a large file lands in the same pass
    a.write(".gitattributes", "# mine\n# edited later\n");
    a.write_bytes("big.bin", &big(4000, 1));
    let only: Vec<super::Change> = vec![super::Change::Add("big.bin".into())];
    let repo = super::Repo::open_with(&a.root, on()).unwrap().unwrap();
    repo.commit(
        &only,
        &super::message::Message::chore(super::message::Scope::Setup, "x", "d"),
    )
    .unwrap();
    let committed = head_blob(&a, ".gitattributes");
    assert!(
        committed.starts_with("# mine\n") && !committed.contains("edited later"),
        "{committed}"
    );
    assert!(lfs::tracked(&committed).contains("big.bin"));
    // the disk keeps the user's edit and the block line, and the file is still pending
    let disk = a.read(".gitattributes");
    assert!(disk.contains("edited later") && lfs::tracked(&disk).contains("big.bin"));
    assert_eq!(
        changes_of(&a, on()),
        vec![super::Change::Edit(".gitattributes".into())]
    );
}

#[test]
fn patterns_agree_with_git_for_awkward_names() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    let names = [
        "plain.bin",
        "dir/my file.bin",
        "star*name.bin",
        "q?mark.bin",
        "brack[et].bin",
        "#hash.bin",
        "!bang.bin",
        "back\\slash.bin",
        "quo\"te.bin",
        "tab\there.bin",
        "new\nline.bin",
        "cr\rname.bin",
        "é/ü.bin",
    ];
    let set: BTreeSet<String> = names.iter().map(|n| n.to_string()).collect();
    a.write(".gitattributes", &lfs::apply("", &set));
    for n in names {
        let out = Command::new("git")
            .args(["check-attr", "-z", "filter", "--", n])
            .current_dir(&a.root)
            .envs(a.env.iter().map(|(k, v)| (k, v)))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(text.ends_with("filter\0lfs\0"), "{n:?}: {text:?}");
    }
    // and a name that is not in the block is not matched by a neighbour's escape
    let out = a.git(&["check-attr", "filter", "--", "starXname.bin"]);
    assert!(out.contains("unspecified"), "{out}");
}
