//! Sync against local bare remotes: two "devices" are two clones in temp dirs with a temp `HOME`,
//! the remote is a `file://` bare repository, nothing touches the network or the user's git
//! config. Each test skips without a `git` binary. Covers the replay, the clean merges, the
//! conflicts that stop one file only, the recovery of an interrupted sync, the token scan and the
//! transport's failure modes.

use super::*;
use crate::features::scope::{FeatureScope, Spawner};
use crate::git::message::TemplateCtx;
use crate::git::repo::ISOLATED;
use crate::git::{self, setup, SetupMode};
use std::process::Command;

fn have_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

macro_rules! need_git {
    () => {
        if !have_git() {
            eprintln!("skipped: no git binary");
            return;
        }
    };
}

fn ctx() -> TemplateCtx {
    TemplateCtx {
        date: "2026-11-20 14:03".into(),
        hostname: "Dev".into(),
    }
}

/// git's environment for the test: a temp HOME, no system or global config.
fn env(home: &Path) -> Vec<(String, String)> {
    let home = home.to_string_lossy().into_owned();
    vec![
        ("HOME".into(), home.clone()),
        ("XDG_CONFIG_HOME".into(), home),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
    ]
}

struct World {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    remote: PathBuf,
}

fn run_git(world_env: &[(String, String)], dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .envs(world_env.iter().map(|(k, v)| (k, v)))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

impl World {
    fn new() -> World {
        ISOLATED.with(|i| i.set(true));
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        run_git(&env(&home), &remote, &["init", "--bare", "-b", "main"]);
        World {
            _tmp: tmp,
            home,
            remote,
        }
    }

    fn env(&self) -> Vec<(String, String)> {
        env(&self.home)
    }

    fn url(&self) -> String {
        format!("file://{}", self.remote.display())
    }

    fn exec(&self) -> Exec {
        Exec::new(Spawner::detached()).with_env(self.env())
    }

    /// A vault: a repository on `main` with the remote linked and Writer's setup commit.
    fn device(&self, name: &str) -> Device {
        let root = self._tmp.path().join(name);
        std::fs::create_dir_all(&root).unwrap();
        let e = self.env();
        run_git(&e, &root, &["init", "-b", "main"]);
        run_git(&e, &root, &["config", "user.name", name]);
        run_git(
            &e,
            &root,
            &["config", "user.email", &format!("{name}@example.test")],
        );
        run_git(&e, &root, &["remote", "add", "origin", &self.url()]);
        Device {
            root,
            name: name.into(),
            exec: self.exec(),
            env: e,
        }
    }

    /// A clone of the remote, set up like a Writer vault.
    fn clone_device(&self, name: &str) -> Device {
        let root = self._tmp.path().join(name);
        let e = self.env();
        run_git(&e, self._tmp.path(), &["clone", &self.url(), name]);
        run_git(&e, &root, &["config", "user.name", name]);
        run_git(
            &e,
            &root,
            &["config", "user.email", &format!("{name}@example.test")],
        );
        Device {
            root,
            name: name.into(),
            exec: self.exec(),
            env: e,
        }
    }
}

struct Device {
    root: PathBuf,
    name: String,
    exec: Exec,
    env: Vec<(String, String)>,
}

impl Device {
    fn write(&self, rel: &str, text: &str) {
        self.write_bytes(rel, text.as_bytes());
    }

    fn write_bytes(&self, rel: &str, bytes: &[u8]) {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root.join(rel)).unwrap()
    }

    fn setup(&self) {
        setup(&self.root, SetupMode::Existing, &self.name).unwrap();
    }

    fn commit(&self) -> Option<String> {
        git::commit_user(&self.root, "{{notes}}", &ctx(), &self.name).unwrap()
    }

    fn sync(&self) -> Outcome {
        let opts = Options {
            exec: &self.exec,
            helper: None,
            secrets: Vec::new(),
            device: &self.name,
            announce: None,
        };
        sync(&self.root, &opts)
    }

    fn ok(&self) -> Report {
        let o = self.sync();
        if let Some(e) = &o.error {
            let details = match e {
                Error::Transport(t) => t.details.clone(),
                _ => String::new(),
            };
            panic!("sync failed: {e} {details}");
        }
        o.report
    }

    fn git(&self, args: &[&str]) -> String {
        run_git(&self.env, &self.root, args)
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }

    fn log(&self) -> Vec<String> {
        self.git(&["log", "--format=%an|%s", "--reverse"])
            .lines()
            .map(String::from)
            .collect()
    }
}

fn remote_log(w: &World) -> Vec<String> {
    run_git(
        &w.env(),
        &w.remote,
        &["log", "main", "--format=%an|%s", "--reverse"],
    )
    .lines()
    .map(String::from)
    .collect()
}

fn remote_file(w: &World, path: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["show", &format!("main:{path}")])
        .current_dir(&w.remote)
        .envs(w.env().iter().map(|(k, v)| (k, v)))
        .output()
        .unwrap();
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Two devices that share a starting history: A pushed it, B cloned it.
fn pair(w: &World, files: &[(&str, &str)]) -> (Device, Device) {
    let a = w.device("A");
    for (p, t) in files {
        a.write(p, t);
    }
    a.setup();
    a.ok();
    let b = w.clone_device("B");
    b.setup();
    b.commit();
    b.ok();
    a.ok();
    (a, b)
}

// ---- push and replay ----------------------------------------------------------------------------

#[test]
fn a_commit_is_pushed_and_the_status_is_in_step() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("Plan.md", "# Plan\n");
    a.setup();
    let r = a.ok();
    assert_eq!(r.pushed, 1);
    assert_eq!(remote_file(&w, "Plan.md").as_deref(), Some("# Plan\n"));
    a.write("Plan.md", "# Plan\nmore\n");
    assert!(a.commit().is_some());
    let info = remote_info(&a.root);
    assert_eq!((info.ahead, info.behind), (1, 0));
    assert_eq!(a.ok().pushed, 1);
    let info = remote_info(&a.root);
    assert_eq!((info.ahead, info.behind), (0, 0));
    assert_eq!(info.branch.as_deref(), Some("main"));
    assert!(info.url.unwrap().starts_with("file://"));
    // nothing to do the next time
    let again = a.ok();
    assert_eq!((again.pushed, again.pulled), (0, 0));
}

#[test]
fn unpushed_commits_are_replayed_in_order_with_their_authors_and_messages() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Shared.md", "shared\n")]);
    a.write("FromA.md", "a\n");
    a.commit();
    a.ok();
    b.write("One.md", "1\n");
    b.commit();
    b.write("Two.md", "2\n");
    b.write("One.md", "1b\n");
    b.commit();
    let before = b.log();
    let r = b.ok();
    assert_eq!(r.pulled, 1);
    assert_eq!(r.pushed, 2);
    // A's file arrived on disk; B's own files are as they were
    assert_eq!(b.read("FromA.md"), "a\n");
    assert_eq!(b.read("One.md"), "1b\n");
    // the history is linear: A's commit, then B's two in their order, with B as author
    let log = b.log();
    let tail: Vec<&String> = log.iter().rev().take(2).collect();
    let originals: Vec<&String> = before.iter().rev().take(2).collect();
    assert_eq!(tail, originals, "authors and messages kept");
    assert_eq!(log.len(), before.len() + 1);
    assert!(log.iter().any(|l| l.starts_with("A|")));
    assert_eq!(remote_log(&w), log);
    assert_eq!(remote_file(&w, "Two.md").as_deref(), Some("2\n"));
    // the working tree and the index are clean
    assert!(git::Repo::open(&b.root)
        .unwrap()
        .unwrap()
        .changes()
        .unwrap()
        .is_empty());
    assert_eq!(
        b.head(),
        run_git(&w.env(), &w.remote, &["rev-parse", "main"]).trim()
    );
    a.ok();
    assert_eq!(a.read("Two.md"), "2\n");
}

#[test]
fn a_remote_that_moved_during_the_push_is_fetched_and_replayed_again() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Shared.md", "shared\n")]);
    // a pre-push hook of B pushes another commit to the remote (once), so B's push is rejected
    let c = w.clone_device("C");
    c.setup();
    c.write("FromC.md", "c\n");
    c.commit();
    let hook = b.root.join(".git/hooks/pre-push");
    let marker = b.root.join(".git/hook-ran");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nif [ ! -e '{m}' ]; then touch '{m}'; cd '{c}' && git push --quiet origin main >/dev/null 2>&1; fi\nexit 0\n",
            m = marker.display(),
            c = c.root.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    b.write("FromB.md", "b\n");
    b.commit();
    let r = b.ok();
    assert!(marker.exists(), "the hook ran");
    assert_eq!(remote_file(&w, "FromB.md").as_deref(), Some("b\n"));
    assert_eq!(remote_file(&w, "FromC.md").as_deref(), Some("c\n"));
    assert_eq!(b.read("FromC.md"), "c\n");
    assert!(r.pushed >= 1);
    drop(a);
}

// ---- merges through the replay ------------------------------------------------------------------

const NOTE: &str = "---\nstatus: draft\ntags: [a]\n---\n# Title\n\none\ntwo\nthree\nfour\n";

#[test]
fn both_sides_changing_different_properties_merge_cleanly() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", NOTE)]);
    a.write("Note.md", &NOTE.replace("status: draft", "status: done"));
    a.commit();
    a.ok();
    b.write("Note.md", &NOTE.replace("tags: [a]", "tags: [a, b]"));
    b.commit();
    let r = b.ok();
    assert!(r.conflicts.is_empty(), "{:?}", r.conflicts);
    let merged = b.read("Note.md");
    assert!(
        merged.contains("status: done") && merged.contains("tags: [a, b]"),
        "{merged}"
    );
    assert!(!merged.contains("<<<<") && !merged.contains(">>>>"));
    assert_eq!(remote_file(&w, "Note.md").unwrap(), merged);
}

#[test]
fn adjacent_edits_to_separate_lines_merge_cleanly() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", NOTE)]);
    a.write("Note.md", &NOTE.replace("\none\n", "\nONE\n"));
    a.commit();
    a.ok();
    b.write("Note.md", &NOTE.replace("\ntwo\n", "\nTWO\n"));
    b.commit();
    let r = b.ok();
    assert!(r.conflicts.is_empty());
    assert!(b.read("Note.md").contains("ONE\nTWO\nthree"));
}

#[test]
fn the_same_property_changed_differently_conflicts_on_that_property_only() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", NOTE), ("Other.md", "other\n")]);
    a.write("Note.md", &NOTE.replace("status: draft", "status: done"));
    a.write("Other.md", "other, edited on A\n");
    a.commit();
    a.ok();
    let mine = NOTE.replace("status: draft", "status: review");
    b.write("Note.md", &mine);
    b.write("Fresh.md", "fresh on B\n");
    b.commit();
    let r = b.ok();
    assert_eq!(r.conflicts.len(), 1);
    assert_eq!(r.conflicts[0].path, "Note.md");
    assert_eq!(r.conflicts[0].properties, vec!["status".to_string()]);
    // the file stays as B had it, no markers, and the other files completed
    assert_eq!(b.read("Note.md"), mine);
    assert_eq!(b.read("Other.md"), "other, edited on A\n");
    assert_eq!(remote_file(&w, "Fresh.md").as_deref(), Some("fresh on B\n"));
    assert!(remote_file(&w, "Note.md").unwrap().contains("status: done"));
    // recorded, and never committed over the other side until resolved
    assert_eq!(conflicts::paths(&b.root), vec!["Note.md".to_string()]);
    assert!(b.commit().is_none(), "the conflicted file is not committed");
    let status = git::status(&b.root, &git::IdentityCache::default(), true).unwrap();
    assert!(status.changes.is_empty());
    assert_eq!(status.conflicts.len(), 1);
}

#[test]
fn a_true_overlap_stops_that_file_and_never_writes_markers() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", NOTE), ("Other.md", "other\n")]);
    a.write("Note.md", &NOTE.replace("two\nthree", "TWO from A\nthree"));
    a.write("Other.md", "A other\n");
    a.commit();
    a.ok();
    let mine = NOTE.replace("two\nthree", "TWO from B\nthree");
    b.write("Note.md", &mine);
    b.commit();
    let r = b.ok();
    assert_eq!(r.conflicts.len(), 1);
    assert_eq!(r.conflicts[0].hunks, 1);
    assert_eq!(b.read("Note.md"), mine);
    assert_eq!(b.read("Other.md"), "A other\n");
    for p in ["Note.md", "Other.md"] {
        for side in [b.read(p), remote_file(&w, p).unwrap()] {
            assert!(!side.contains("<<<<<<<") && !side.contains("=======\n"));
        }
    }
    // a later sync does not push the conflicted file over the remote's version
    b.ok();
    assert!(remote_file(&w, "Note.md").unwrap().contains("TWO from A"));
}

#[test]
fn a_binary_changed_on_both_sides_keeps_mine_beside_the_remote_version() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[]);
    a.write_bytes("img/pic.png", &[0, 1, 2, 3]);
    a.commit();
    a.ok();
    b.ok();
    a.write_bytes("img/pic.png", &[0, 9, 9, 9]);
    a.commit();
    a.ok();
    b.write_bytes("img/pic.png", &[0, 5, 5, 5]);
    b.commit();
    let r = b.ok();
    assert_eq!(r.copies.len(), 1);
    let (file, copy) = &r.copies[0];
    assert_eq!(file, "img/pic.png");
    assert!(
        copy.starts_with("img/pic (conflict B ") && copy.ends_with(").png"),
        "{copy}"
    );
    assert_eq!(std::fs::read(b.root.join(file)).unwrap(), vec![0, 9, 9, 9]);
    assert_eq!(std::fs::read(b.root.join(copy)).unwrap(), vec![0, 5, 5, 5]);
    assert!(
        remote_file(&w, copy).is_some()
            || run_git(
                &w.env(),
                &w.remote,
                &["ls-tree", "-r", "--name-only", "main"]
            )
            .contains("conflict B")
    );
}

#[test]
fn delete_against_edit_keeps_the_edit() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Keep.md", "one\n")]);
    std::fs::remove_file(a.root.join("Keep.md")).unwrap();
    a.commit();
    a.ok();
    b.write("Keep.md", "one edited\n");
    b.commit();
    let r = b.ok();
    assert_eq!(r.restored, vec!["Keep.md".to_string()]);
    assert_eq!(b.read("Keep.md"), "one edited\n");
    assert_eq!(remote_file(&w, "Keep.md").as_deref(), Some("one edited\n"));
}

// ---- an interrupted sync ------------------------------------------------------------------------

#[test]
fn an_interrupted_sync_after_the_branch_moved_is_finished_from_its_record() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Shared.md", "shared\n")]);
    a.write("New.md", "from a\n");
    a.write("Shared.md", "shared, changed\n");
    a.commit();
    a.ok();
    // B fetched, recorded the move, moved the branch, and died before writing the files
    let t = Transport {
        exec: &b.exec,
        root: &b.root,
        helper: None,
        secrets: Vec::new(),
    };
    t.fetch("main").unwrap();
    let repo = Repo::open(&b.root).unwrap().unwrap();
    let old = repo.head_id_string();
    let new = repo.ref_id("refs/remotes/origin/main").unwrap();
    write_progress(
        &b.root,
        &Progress {
            old_head: old.clone(),
            new_head: new.clone(),
            skip: Vec::new(),
        },
    )
    .unwrap();
    repo.move_head(&new, old.as_deref()).unwrap();
    assert!(!b.root.join("New.md").exists());
    drop(repo);
    assert!(recover(&b.root, None).unwrap());
    assert_eq!(b.read("New.md"), "from a\n");
    assert_eq!(b.read("Shared.md"), "shared, changed\n");
    assert!(!progress_path(&b.root).exists());
    let status = git::status(&b.root, &git::IdentityCache::default(), true).unwrap();
    assert!(status.changes.is_empty(), "{:?}", status.changes);
}

#[test]
fn an_interrupted_sync_before_the_branch_moved_is_rolled_back() {
    need_git!();
    let w = World::new();
    let (_a, b) = pair(&w, &[("Shared.md", "shared\n")]);
    let head = b.head();
    write_progress(
        &b.root,
        &Progress {
            old_head: Some(head.clone()),
            new_head: "0".repeat(40),
            skip: Vec::new(),
        },
    )
    .unwrap();
    assert!(recover(&b.root, None).unwrap());
    assert_eq!(b.head(), head);
    assert!(!progress_path(&b.root).exists());
    // the next sync simply runs
    assert!(b.sync().error.is_none());
}

#[test]
fn a_file_the_user_edited_meanwhile_is_merged_not_overwritten_when_the_sync_resumes() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", NOTE)]);
    a.write("Note.md", &NOTE.replace("four", "FOUR"));
    a.commit();
    a.ok();
    let t = Transport {
        exec: &b.exec,
        root: &b.root,
        helper: None,
        secrets: Vec::new(),
    };
    t.fetch("main").unwrap();
    // the user typed into line one of the body while the sync ran
    b.write("Note.md", &NOTE.replace("\none\n", "\nONE typed\n"));
    let repo = Repo::open(&b.root).unwrap().unwrap();
    let (old, new) = (
        repo.head_id_string(),
        repo.ref_id("refs/remotes/origin/main").unwrap(),
    );
    write_progress(
        &b.root,
        &Progress {
            old_head: old.clone(),
            new_head: new.clone(),
            skip: Vec::new(),
        },
    )
    .unwrap();
    repo.move_head(&new, old.as_deref()).unwrap();
    drop(repo);
    recover(&b.root, None).unwrap();
    let text = b.read("Note.md");
    assert!(
        text.contains("ONE typed") && text.contains("FOUR"),
        "{text}"
    );
}

// ---- never in the middle of an operation -----------------------------------------------------------

#[test]
fn sync_never_runs_during_a_merge_or_on_a_detached_head() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("Plan.md", "x\n");
    a.setup();
    a.ok();
    std::fs::write(a.root.join(".git/MERGE_HEAD"), a.head()).unwrap();
    let o = a.sync();
    assert!(
        matches!(o.error, Some(Error::Operation(_))),
        "{:?}",
        o.error.map(|e| e.to_string())
    );
    std::fs::remove_file(a.root.join(".git/MERGE_HEAD")).unwrap();
    assert!(a.sync().error.is_none());
    let head = a.head();
    a.git(&["checkout", "--detach", &head]);
    assert!(matches!(a.sync().error, Some(Error::Operation(_))));
}

// ---- the plugin token scan --------------------------------------------------------------------------

const TOKEN_JSON: &str = r#"{"apiKey": "sk-live-planted-0123456789abcdef", "theme": "dark"}"#;

#[test]
fn a_plugin_settings_file_with_a_token_is_never_committed_or_pushed_until_allowed() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("Plan.md", "x\n");
    a.write(
        ".obsidian/plugins/sync-thing/manifest.json",
        r#"{"name":"Sync Thing"}"#,
    );
    a.setup();
    a.ok();
    a.write(".obsidian/plugins/sync-thing/data.json", TOKEN_JSON);
    a.write(".obsidian/plugins/calm/data.json", r#"{"theme": "dark"}"#);
    // with a remote linked the scan holds the file out of the version
    let id = a
        .commit()
        .expect("the calm plugin's settings are committed");
    assert!(!a.git(&["show", "--stat", &id]).contains("sync-thing"));
    let status = git::status(&a.root, &git::IdentityCache::default(), true).unwrap();
    assert_eq!(status.held.len(), 1);
    assert_eq!(status.held[0].id, "sync-thing");
    assert_eq!(status.held[0].name, "Sync Thing");
    assert!(
        status.changes.is_empty(),
        "held files are not pending changes"
    );
    a.ok();
    assert!(remote_file(&w, ".obsidian/plugins/sync-thing/data.json").is_none());
    assert!(remote_file(&w, ".obsidian/plugins/calm/data.json").is_some());
    // "Sync anyway" lets this file through until its token value changes
    plugin_scan::allow(&a.root, "sync-thing").unwrap();
    assert_eq!(a.commit().map(|_| ()), Some(()));
    a.ok();
    assert!(remote_file(&w, ".obsidian/plugins/sync-thing/data.json").is_some());
    a.write(
        ".obsidian/plugins/sync-thing/data.json",
        r#"{"apiKey": "sk-live-ROTATED-0123456789abcdef", "theme": "dark"}"#,
    );
    assert!(a.commit().is_none(), "a changed token is held again");
    // "Never sync this plugin" adds the file to the managed block, idempotently
    plugin_scan::never(&a.root, "sync-thing").unwrap();
    plugin_scan::never(&a.root, "sync-thing").unwrap();
    let ignore = a.read(".gitignore");
    assert_eq!(
        ignore
            .matches(".obsidian/plugins/sync-thing/data.json")
            .count(),
        1
    );
    let begin = ignore.find(git::ignore::BEGIN).unwrap();
    let end = ignore.find(git::ignore::END).unwrap();
    assert!(
        ignore[begin..end].contains("sync-thing/data.json"),
        "inside the block"
    );
}

#[test]
fn a_token_already_committed_locally_is_replayed_out_of_what_is_pushed() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("Plan.md", "x\n");
    a.setup();
    a.ok();
    // committed behind Writer's back (the user's own git)
    a.write(".obsidian/plugins/p/data.json", TOKEN_JSON);
    a.git(&["add", "-A"]);
    a.git(&["commit", "-m", "plugin settings"]);
    let r = a.ok();
    assert_eq!(r.held.len(), 1);
    assert!(remote_file(&w, ".obsidian/plugins/p/data.json").is_none());
    // the file stays on the disk as the user has it
    assert!(a.read(".obsidian/plugins/p/data.json").contains("planted"));
}

#[test]
fn the_scan_names_what_looks_like_a_token() {
    for (json, held) in [
        (r#"{"token":"abc"}"#, true),
        (r#"{"nested":{"apiKey":"abc"}}"#, true),
        (r#"{"openai_api_key":"abc"}"#, true),
        (r#"{"Password":"hunter2"}"#, true),
        (r#"{"bearer":"x"}"#, true),
        (
            r#"{"x":"0123456789abcdef0123456789abcdef0123456789abcdef"}"#,
            true,
        ),
        (r#"{"token":""}"#, false),
        (
            r#"{"hotkeys":"Ctrl+K","keyboard":"on","folder":"a-very-long-folder-name-for-templates-and-more"}"#,
            false,
        ),
        (r#"{"tokenCount":3,"key":null}"#, false),
        (r#"["not an object"]"#, false),
    ] {
        assert_eq!(plugin_scan::scan(json.as_bytes()).is_some(), held, "{json}");
    }
    assert_ne!(
        plugin_scan::scan(br#"{"token":"abc"}"#),
        plugin_scan::scan(br#"{"token":"abd"}"#),
        "the fingerprint follows the value"
    );
    assert_eq!(
        plugin_scan::plugin_of(".obsidian/plugins/x/data.json"),
        Some("x")
    );
    assert_eq!(plugin_scan::plugin_of(".obsidian/plugins/x/main.js"), None);
}

// ---- transport -----------------------------------------------------------------------------------------

#[test]
fn a_missing_git_is_reported_as_such() {
    let tmp = tempfile::tempdir().unwrap();
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let exec = Exec::new(Spawner::detached()).with_only_path(vec![empty]);
    let t = Transport {
        exec: &exec,
        root: tmp.path(),
        helper: None,
        secrets: Vec::new(),
    };
    let e = t.fetch("main").unwrap_err();
    assert_eq!(e.kind, Kind::NoGit);
    assert_eq!(e.line, "Git is not installed");
}

#[test]
fn an_unreachable_remote_is_offline_and_a_slow_one_times_out() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.write("Plan.md", "x\n");
    a.setup();
    a.git(&[
        "remote",
        "set-url",
        "origin",
        "https://localhost:1/none.git",
    ]);
    let o = a.sync();
    match o.error {
        Some(Error::Transport(e)) => assert!(
            matches!(e.kind, Kind::Offline | Kind::Auth | Kind::Other),
            "{e:?}"
        ),
        other => panic!("{:?}", other.map(|e| e.to_string())),
    }
    // a timeout kills the child
    let exec = a.exec.clone();
    let mut cmd = exec.git(&a.root, None, &["--version"]);
    cmd = {
        let mut sleeper = Command::new("sleep");
        sleeper.arg("30");
        let _ = cmd;
        sleeper
    };
    let start = std::time::Instant::now();
    let r = exec.run(cmd, Duration::from_millis(200));
    assert_eq!(r.unwrap_err(), RunError::Timeout);
    assert!(start.elapsed() < Duration::from_secs(5));
}

use super::super::transport::RunError;
use std::time::Duration;

#[test]
fn stopping_the_scope_kills_the_git_child() {
    let scope = FeatureScope::new("t", None);
    let exec = Exec::new(scope.spawner());
    let handle = std::thread::spawn(move || {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        exec.run(cmd, Duration::from_secs(60))
    });
    std::thread::sleep(Duration::from_millis(300));
    let start = std::time::Instant::now();
    scope.shutdown(Duration::from_secs(2));
    let r = handle.join().unwrap();
    assert_eq!(r.unwrap_err(), RunError::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn remote_urls_are_checked_and_credentials_are_refused() {
    use super::super::transport::{check_url, display_url};
    for ok in [
        "git@github.com:me/vault.git",
        "https://github.com/me/vault.git",
        "https://me@github.com/me/vault.git",
        "ssh://git@host/me/vault",
        "file:///tmp/remote.git",
        "/srv/git/vault.git",
    ] {
        assert!(check_url(ok).is_ok(), "{ok}");
    }
    for bad in [
        "",
        "--upload-pack=x",
        "https://me:secret@github.com/me/vault.git",
        "ftp://host/x",
        "just words",
        "https://x/a b",
    ] {
        assert!(check_url(bad).is_err(), "{bad}");
    }
    assert_eq!(
        display_url("https://me@github.com/me/vault.git"),
        "github.com/me/vault"
    );
    assert_eq!(
        display_url("git@github.com:me/vault.git"),
        "github.com/me/vault"
    );
}

#[test]
fn remotes_are_added_changed_and_removed_through_git() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    a.git(&["remote", "remove", "origin"]);
    a.write("Plan.md", "x\n");
    a.setup();
    let t = Transport {
        exec: &a.exec,
        root: &a.root,
        helper: None,
        secrets: Vec::new(),
    };
    assert_eq!(remote_info(&a.root).url, None);
    assert!(matches!(a.sync().error, Some(Error::NoRemote)));
    t.set_remote(&w.url()).unwrap();
    t.check_reachable().unwrap();
    assert_eq!(remote_info(&a.root).url, Some(w.url()));
    let r = a.ok();
    assert_eq!(r.pushed, 1, "adding a remote pushes the existing history");
    assert!(t
        .set_remote("https://me:secret@example.test/x.git")
        .is_err());
    t.remove_remote().unwrap();
    assert_eq!(remote_info(&a.root).url, None);
}

#[test]
fn errors_are_classified_and_scrubbed() {
    use super::super::transport::{classify, sanitize, Output};
    let out = |stderr: &str| Output {
        code: Some(128),
        stdout: String::new(),
        stderr: stderr.into(),
    };
    let root = Path::new("/Users/me/Vault");
    let e = classify(
        &out(
            "fatal: Authentication failed for 'https://me:ghp_planted123456@github.com/me/v.git/'",
        ),
        root,
        &["ghp_planted123456"],
    );
    assert_eq!(e.kind, Kind::Auth);
    assert!(!e.details.contains("ghp_planted123456"), "{}", e.details);
    assert!(!e.details.contains("me:"), "{}", e.details);
    assert_eq!(
        classify(
            &out("fatal: unable to access 'https://x/': Could not resolve host: x"),
            root,
            &[]
        )
        .kind,
        Kind::Offline
    );
    assert_eq!(
        classify(&out(" ! [rejected] main -> main (fetch first)"), root, &[]).kind,
        Kind::Rejected
    );
    assert_eq!(
        classify(&out("remote: Repository not found."), root, &[]).kind,
        Kind::NotFound
    );
    assert_eq!(
        classify(
            &out("git@github.com: Permission denied (publickey)."),
            root,
            &[]
        )
        .kind,
        Kind::Auth
    );
    assert!(!sanitize("error in /Users/me/Vault/Notes", root, &[]).contains("/Users/me"));
}
