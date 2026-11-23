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
use std::path::PathBuf;
use std::process::Command;

/// Points a test can step into in the middle of a sync (a status read, a crash).
pub(crate) mod hooks {
    use super::Error;
    use std::cell::RefCell;
    use std::path::Path;

    type Hook = Box<dyn Fn(&Path) -> Result<(), Error>>;

    thread_local! {
        static AFTER_MOVE_HEAD: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    /// Runs `hook` right after a sync moves the branch, until the guard drops.
    pub(crate) fn set_after_move_head(hook: Hook) -> impl Drop {
        AFTER_MOVE_HEAD.with(|h| *h.borrow_mut() = Some(hook));
        Reset
    }

    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            AFTER_MOVE_HEAD.with(|h| *h.borrow_mut() = None);
        }
    }

    pub(crate) fn after_move_head(root: &Path) -> Result<(), Error> {
        AFTER_MOVE_HEAD.with(|h| h.borrow().as_ref().map_or(Ok(()), |f| f(root)))
    }
}

pub(crate) fn have_git() -> bool {
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

pub(crate) fn ctx() -> TemplateCtx {
    TemplateCtx {
        date: "2026-11-20 14:03".into(),
        hostname: "Dev".into(),
    }
}

/// git's environment for the test: a temp HOME, no system or global config.
pub(crate) fn env(home: &Path) -> Vec<(String, String)> {
    let home = home.to_string_lossy().into_owned();
    vec![
        ("HOME".into(), home.clone()),
        ("XDG_CONFIG_HOME".into(), home),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
    ]
}

pub(crate) struct World {
    pub(crate) _tmp: tempfile::TempDir,
    pub(crate) home: PathBuf,
    pub(crate) remote: PathBuf,
}

pub(crate) fn run_git(world_env: &[(String, String)], dir: &Path, args: &[&str]) -> String {
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
    pub(crate) fn new() -> World {
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

    pub(crate) fn env(&self) -> Vec<(String, String)> {
        env(&self.home)
    }

    pub(crate) fn url(&self) -> String {
        format!("file://{}", self.remote.display())
    }

    pub(crate) fn exec(&self) -> Exec {
        Exec::new(Spawner::detached()).with_env(self.env())
    }

    /// A vault: a repository on `main` with the remote linked and Writer's setup commit.
    pub(crate) fn device(&self, name: &str) -> Device {
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
    pub(crate) fn clone_device(&self, name: &str) -> Device {
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

pub(crate) struct Device {
    pub(crate) root: PathBuf,
    pub(crate) name: String,
    pub(crate) exec: Exec,
    pub(crate) env: Vec<(String, String)>,
}

impl Device {
    pub(crate) fn write(&self, rel: &str, text: &str) {
        self.write_bytes(rel, text.as_bytes());
    }

    pub(crate) fn write_bytes(&self, rel: &str, bytes: &[u8]) {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    pub(crate) fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root.join(rel)).unwrap()
    }

    pub(crate) fn setup(&self) {
        setup(&self.root, SetupMode::Existing, &self.name).unwrap();
    }

    pub(crate) fn commit(&self) -> Option<String> {
        git::commit_user(
            &self.root,
            "{{notes}}",
            &ctx(),
            &self.name,
            crate::git::Lfs::OFF,
        )
        .unwrap()
    }

    pub(crate) fn sync(&self) -> Outcome {
        let opts = Options {
            exec: &self.exec,
            helper: None,
            secrets: Vec::new(),
            device: &self.name,
            unlocked: None,
            announce: None,
        };
        sync(&self.root, &opts)
    }

    pub(crate) fn ok(&self) -> Report {
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

    pub(crate) fn git(&self, args: &[&str]) -> String {
        run_git(&self.env, &self.root, args)
    }

    pub(crate) fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }

    pub(crate) fn log(&self) -> Vec<String> {
        self.git(&["log", "--format=%an|%s", "--reverse"])
            .lines()
            .map(String::from)
            .collect()
    }
}

pub(crate) fn remote_log(w: &World) -> Vec<String> {
    run_git(
        &w.env(),
        &w.remote,
        &["log", "main", "--format=%an|%s", "--reverse"],
    )
    .lines()
    .map(String::from)
    .collect()
}

pub(crate) fn remote_file(w: &World, path: &str) -> Option<String> {
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
pub(crate) fn pair(w: &World, files: &[(&str, &str)]) -> (Device, Device) {
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
    let status = git::status(
        &b.root,
        &git::IdentityCache::default(),
        true,
        crate::git::Lfs::OFF,
    )
    .unwrap();
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
    assert!(recover(&b.root, None, "B").unwrap().is_some());
    assert_eq!(b.read("New.md"), "from a\n");
    assert_eq!(b.read("Shared.md"), "shared, changed\n");
    assert!(!interrupted(&b.root));
    let status = git::status(
        &b.root,
        &git::IdentityCache::default(),
        true,
        crate::git::Lfs::OFF,
    )
    .unwrap();
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
    assert!(recover(&b.root, None, "B").unwrap().is_some());
    assert_eq!(b.head(), head);
    assert!(!interrupted(&b.root));
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
    recover(&b.root, None, "B").unwrap();
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
    let status = git::status(
        &a.root,
        &git::IdentityCache::default(),
        true,
        crate::git::Lfs::OFF,
    )
    .unwrap();
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

// ---- renames in the replay ----------------------------------------------------------------------

const LINES: &str = "one\ntwo\nthree\nfour\nfive\nsix\n";

fn tree(w: &World) -> String {
    run_git(
        &w.env(),
        &w.remote,
        &["ls-tree", "-r", "--name-only", "main"],
    )
}

#[test]
fn a_rename_here_and_an_edit_there_land_as_an_edited_file_at_the_new_name() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", LINES)]);
    a.write("Note.md", &LINES.replace("two", "TWO from A"));
    a.commit();
    a.ok();
    std::fs::remove_file(b.root.join("Note.md")).unwrap();
    b.write("Renamed.md", LINES);
    b.commit();
    let r = b.ok();
    assert!(r.conflicts.is_empty(), "{:?}", r.conflicts);
    assert_eq!(b.read("Renamed.md"), LINES.replace("two", "TWO from A"));
    assert!(!b.root.join("Note.md").exists());
    assert_eq!(
        remote_file(&w, "Renamed.md").as_deref(),
        Some(LINES.replace("two", "TWO from A").as_str())
    );
    assert!(remote_file(&w, "Note.md").is_none(), "{}", tree(&w));
}

#[test]
fn an_edit_here_and_a_rename_there_land_as_an_edited_file_at_the_new_name() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", LINES)]);
    std::fs::remove_file(a.root.join("Note.md")).unwrap();
    a.write("Renamed.md", LINES);
    a.commit();
    a.ok();
    b.write("Note.md", &LINES.replace("five", "FIVE from B"));
    b.commit();
    let r = b.ok();
    assert!(r.conflicts.is_empty(), "{:?}", r.conflicts);
    assert!(r.restored.is_empty(), "no duplicate: {:?}", r.restored);
    assert_eq!(b.read("Renamed.md"), LINES.replace("five", "FIVE from B"));
    assert!(!b.root.join("Note.md").exists());
    assert_eq!(tree(&w).trim(), ".gitignore\nRenamed.md");
    assert_eq!(
        remote_file(&w, "Renamed.md").as_deref(),
        Some(LINES.replace("five", "FIVE from B").as_str())
    );
}

#[test]
fn an_edit_that_follows_a_rename_edited_there_too_is_a_conflict_not_a_silent_merge() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", LINES)]);
    // the other device moved the note (a recorded move), then edited it
    std::fs::remove_file(a.root.join("Note.md")).unwrap();
    a.write("Renamed.md", LINES);
    a.commit();
    a.write("Renamed.md", &LINES.replace("one", "ONE from A"));
    a.commit();
    a.ok();
    b.write("Note.md", &LINES.replace("six", "SIX from B"));
    b.commit();
    let r = b.ok();
    // a 3-way merge across a rename is the user's to check: both versions stay, recorded
    assert_eq!(r.conflicts.len(), 1, "{:?}", r.conflicts);
    assert_eq!(r.conflicts[0].path, "Note.md");
    assert_eq!(r.conflicts[0].theirs_path.as_deref(), Some("Renamed.md"));
    assert_eq!(b.read("Note.md"), LINES.replace("six", "SIX from B"));
    assert_eq!(b.read("Renamed.md"), LINES.replace("one", "ONE from A"));
    assert!(remote_file(&w, "Note.md").is_none(), "{}", tree(&w));
}

#[test]
fn notes_from_one_template_are_never_paired_across_devices() {
    need_git!();
    let w = World::new();
    let day = |d: &str| {
        format!("---\ndate: {d}\n---\n# Daily\n\n## Tasks\n- [ ]\n\n## Journal\n\n## Links\n")
    };
    let (a, b) = pair(&w, &[("2026-11-01.md", &day("2026-11-01"))]);
    // the other device deleted yesterday's note, then made today's from the same template
    std::fs::remove_file(a.root.join("2026-11-01.md")).unwrap();
    a.commit();
    a.write("2026-11-20.md", &day("2026-11-20"));
    a.commit();
    a.ok();
    // here the old note was edited
    let edited = day("2026-11-01").replace("## Journal\n", "## Journal\nwalked the dog\n");
    b.write("2026-11-01.md", &edited);
    b.commit();
    let r = b.ok();
    assert!(r.conflicts.is_empty(), "{:?}", r.conflicts);
    assert_eq!(r.restored, vec!["2026-11-01.md".to_string()]);
    assert_eq!(b.read("2026-11-01.md"), edited);
    assert_eq!(b.read("2026-11-20.md"), day("2026-11-20"));
    assert_eq!(remote_file(&w, "2026-11-20.md"), Some(day("2026-11-20")));
    assert_eq!(remote_file(&w, "2026-11-01.md"), Some(edited));
}

#[test]
fn renamed_to_different_names_is_a_conflict_that_lists_both_paths() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", LINES)]);
    std::fs::remove_file(a.root.join("Note.md")).unwrap();
    a.write("FromA.md", LINES);
    a.commit();
    a.ok();
    std::fs::remove_file(b.root.join("Note.md")).unwrap();
    b.write("FromB.md", LINES);
    b.commit();
    let r = b.ok();
    assert_eq!(r.conflicts.len(), 1, "{:?}", r.conflicts);
    assert_eq!(r.conflicts[0].path, "FromB.md");
    assert_eq!(r.conflicts[0].theirs_path.as_deref(), Some("FromA.md"));
    // both files are on disk, neither is lost, and mine is never pushed over theirs
    assert_eq!(b.read("FromB.md"), LINES);
    assert_eq!(b.read("FromA.md"), LINES);
    assert!(remote_file(&w, "FromB.md").is_none());
    assert_eq!(conflicts::paths(&b.root), vec!["FromB.md".to_string()]);
    assert!(b.commit().is_none());
}

#[test]
fn a_rename_with_an_edit_here_against_an_edit_there_of_the_same_line_conflicts_at_the_new_name() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", LINES)]);
    a.write("Note.md", &LINES.replace("three", "three from A"));
    a.commit();
    a.ok();
    std::fs::remove_file(b.root.join("Note.md")).unwrap();
    let mine = LINES.replace("three", "three from B");
    b.write("Renamed.md", &mine);
    b.commit();
    let r = b.ok();
    assert_eq!(r.conflicts.len(), 1, "{:?}", r.conflicts);
    assert_eq!(r.conflicts[0].path, "Renamed.md");
    assert_eq!(r.conflicts[0].theirs_path.as_deref(), Some("Note.md"));
    assert_eq!(r.conflicts[0].hunks, 1);
    assert_eq!(b.read("Renamed.md"), mine);
}

// ---- review fixes: confinement, recovery, records, the last push guard -----------------------------

/// `git <args>` in `dir` with `input` on stdin.
fn git_in(w: &World, dir: &Path, args: &[&str], input: &[u8]) -> String {
    use std::io::Write;
    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .envs(w.env().iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `(path components, blob id, mode)` of a file put into a raw tree.
type RawFile<'a> = (Vec<&'a str>, String, &'a str);

/// A tree that is `base` (a tree id) with `files` (`(components, blob, mode)`) put in, built with
/// git's plumbing, which checks no names (a hostile remote need not either).
fn raw_tree(
    w: &World,
    dir: &Path,
    base: Option<&str>,
    files: &[(Vec<&str>, String, &str)],
) -> String {
    let mut entries: BTreeMap<String, String> = BTreeMap::new();
    if let Some(b) = base {
        for line in run_git(&w.env(), dir, &["ls-tree", b]).lines() {
            let (meta, name) = line.split_once('\t').unwrap();
            entries.insert(name.to_string(), meta.to_string());
        }
    }
    let mut groups: BTreeMap<&str, Vec<RawFile<'_>>> = BTreeMap::new();
    for (parts, id, mode) in files {
        if parts.len() == 1 {
            entries.insert(parts[0].to_string(), format!("{mode} blob {id}"));
        } else {
            groups
                .entry(parts[0])
                .or_default()
                .push((parts[1..].to_vec(), id.clone(), mode));
        }
    }
    for (dir_name, inner) in groups {
        let sub_base = entries
            .get(dir_name)
            .and_then(|m| m.strip_prefix("040000 tree ").map(str::to_string));
        let sub = raw_tree(w, dir, sub_base.as_deref(), &inner);
        entries.insert(dir_name.to_string(), format!("040000 tree {sub}"));
    }
    let listing: String = entries
        .iter()
        .map(|(name, meta)| format!("{meta}\t{name}\n"))
        .collect();
    git_in(w, dir, &["mktree"], listing.as_bytes())
}

/// A commit the remote gets from a device that does not play by the rules: `files` put straight
/// into a tree on top of the remote head, then pushed.
fn push_raw(w: &World, files: &[(&str, &[u8], &str)]) {
    let e = w.clone_device("Evil");
    let parts: Vec<RawFile<'_>> = files
        .iter()
        .map(|(path, bytes, mode)| {
            let id = git_in(w, &e.root, &["hash-object", "-w", "--stdin"], bytes);
            (path.split('/').collect(), id, *mode)
        })
        .collect();
    let base = e.git(&["rev-parse", "HEAD^{tree}"]).trim().to_string();
    let tree = raw_tree(w, &e.root, Some(&base), &parts);
    let commit = e
        .git(&["commit-tree", &tree, "-p", "HEAD", "-m", "planted"])
        .trim()
        .to_string();
    e.git(&["push", "origin", &format!("{commit}:refs/heads/main")]);
}

#[test]
fn a_remote_tree_never_writes_device_local_state_or_through_a_link() {
    need_git!();
    let w = World::new();
    let (_a, b) = pair(&w, &[("Shared/keep.md", "x\n")]);
    // here, `Shared` becomes a link to a folder outside the vault
    let outside = tempfile::tempdir().unwrap();
    std::fs::remove_dir_all(b.root.join("Shared")).unwrap();
    std::os::unix::fs::symlink(outside.path(), b.root.join("Shared")).unwrap();
    b.commit();
    push_raw(
        &w,
        &[
            (".writer/git/plugin-scan.json", br#"{"p":"0000"}"#, "100644"),
            ("Shared/a.md", b"outside\n", "100644"),
            ("ok.md", b"fine\n", "100644"),
        ],
    );
    let r = b.ok();
    assert!(!b.root.join(".writer/git/plugin-scan.json").exists());
    assert!(!outside.path().join("a.md").exists());
    assert_eq!(b.read("ok.md"), "fine\n");
    let mut refused = r.refused.clone();
    refused.sort();
    assert_eq!(
        refused,
        vec![
            ".writer/git/plugin-scan.json".to_string(),
            "Shared/a.md".to_string()
        ]
    );
    // listed for the user until dismissed
    assert_eq!(conflicts::read(&b.root).refused.len(), 2);
    let status = git::status(
        &b.root,
        &git::IdentityCache::default(),
        false,
        crate::git::Lfs::OFF,
    )
    .unwrap();
    assert_eq!(status.refused.len(), 2);
}

#[test]
fn a_remote_tree_with_a_case_variant_of_git_never_reaches_the_repository() {
    need_git!();
    let w = World::new();
    let (_a, b) = pair(&w, &[("Note.md", "x\n")]);
    push_raw(
        &w,
        &[
            (".GIT/hooks/pre-push", b"#!/bin/sh\necho owned\n", "100755"),
            ("ok.md", b"fine\n", "100644"),
        ],
    );
    let o = b.sync();
    // gix refuses to read such a tree, and the confinement would refuse to write it: either way
    // nothing lands in `.git` (one folder on a case-insensitive disk) and the sync says so
    assert!(!b.root.join(".git/hooks/pre-push").exists());
    assert!(!b.root.join(".GIT/hooks/pre-push").exists());
    match &o.error {
        Some(_) => assert!(!b.root.join("ok.md").exists()),
        None => assert_eq!(o.report.refused, vec![".GIT/hooks/pre-push".to_string()]),
    }
    assert!(!interrupted(&b.root));
}

/// B fetched, recorded the move, moved the branch and died before the working tree followed:
/// `Shared.md` is still at its old content on disk.
fn crashed_after_the_move(w: &World) -> Device {
    let (a, b) = pair(w, &[("Shared.md", "shared\n")]);
    a.write("Shared.md", "shared, changed by A\n");
    a.commit();
    a.ok();
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
    assert_eq!(b.read("Shared.md"), "shared\n");
    b
}

#[test]
fn a_commit_after_an_interrupted_sync_finishes_it_instead_of_reverting_the_remote() {
    need_git!();
    let w = World::new();
    let b = crashed_after_the_move(&w);
    let before = b.log().len();
    // the engine refuses a bare commit while the record exists
    let repo = Repo::open(&b.root).unwrap().unwrap();
    let refused = repo.commit(
        &[git::Change::Edit("Shared.md".into())],
        &super::super::message::Message::chore(super::super::message::Scope::Setup, "x", "B"),
    );
    assert!(matches!(refused, Err(repo::Error::Operation(_))));
    // the user's commit recovers first: nothing reverted, nothing to commit
    assert_eq!(b.commit(), None);
    assert_eq!(b.read("Shared.md"), "shared, changed by A\n");
    assert!(!interrupted(&b.root));
    assert_eq!(b.log().len(), before);
    b.ok();
    assert_eq!(
        remote_file(&w, "Shared.md").as_deref(),
        Some("shared, changed by A\n")
    );
}

#[test]
fn a_sync_after_an_interrupted_sync_finishes_it_first() {
    need_git!();
    let w = World::new();
    let b = crashed_after_the_move(&w);
    let before = b.log().len();
    let r = b.ok();
    assert!(
        r.written.contains(&"Shared.md".to_string()),
        "{:?}",
        r.written
    );
    assert_eq!(b.read("Shared.md"), "shared, changed by A\n");
    assert!(!interrupted(&b.root));
    assert_eq!(b.log().len(), before);
    assert_eq!(
        remote_file(&w, "Shared.md").as_deref(),
        Some("shared, changed by A\n")
    );
}

/// A replay that ends in a conflict on `Note.md`.
fn overlap(w: &World) -> Device {
    let (a, b) = pair(w, &[("Note.md", LINES)]);
    a.write("Note.md", &LINES.replace("two", "TWO from A"));
    a.commit();
    a.ok();
    b.write("Note.md", &LINES.replace("two", "TWO from B"));
    b.commit();
    b
}

#[test]
fn a_status_read_in_the_middle_of_a_sync_never_drops_its_conflicts() {
    need_git!();
    let w = World::new();
    let b = overlap(&w);
    let _hook = hooks::set_after_move_head(Box::new(|root| {
        git::status(
            root,
            &git::IdentityCache::default(),
            false,
            crate::git::Lfs::OFF,
        )
        .map(|_| ())
        .map_err(Error::Repo)
    }));
    let r = b.ok();
    assert_eq!(r.conflicts.len(), 1);
    assert!(conflicts::find(&b.root, "Note.md").is_some());
}

#[test]
fn a_crash_right_after_the_move_still_finds_the_replays_conflicts() {
    need_git!();
    let w = World::new();
    let b = overlap(&w);
    {
        let _hook =
            hooks::set_after_move_head(Box::new(|_| Err(Error::Io(io::Error::other("crashed")))));
        assert!(b.sync().error.is_some());
    }
    assert!(interrupted(&b.root));
    recover(&b.root, None, "B").unwrap();
    assert!(conflicts::find(&b.root, "Note.md").is_some());
    assert_eq!(b.read("Note.md"), LINES.replace("two", "TWO from B"));
}

#[test]
fn a_failed_push_leaves_no_sync_record() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("A.md", "a\n"), ("B.md", "b\n")]);
    a.write("A.md", "a2\n");
    a.commit();
    a.ok();
    b.write("B.md", "b2\n");
    b.commit();
    let hook = w.remote.join("hooks/pre-receive");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let o = b.sync();
    assert!(o.error.is_some());
    // the branch moved and the working tree followed: nothing is left to recover
    assert_eq!(b.read("A.md"), "a2\n");
    assert!(!interrupted(&b.root));
}

#[test]
fn a_held_token_is_never_pushed_when_the_replay_has_nothing_to_build_on() {
    need_git!();
    let w = World::new();
    let a = w.device("A");
    // the only unpushed change: a flagged plugin settings file, committed behind Writer's back
    a.write(".obsidian/plugins/p/data.json", TOKEN_JSON);
    a.git(&["add", "-A"]);
    a.git(&["commit", "-m", "plugin settings"]);
    let r = a.ok();
    assert_eq!(r.pushed, 0);
    assert_eq!(r.held.len(), 1);
    assert!(remote_log_or_empty(&w).is_empty());
}

fn remote_log_or_empty(w: &World) -> String {
    let out = Command::new("git")
        .args(["log", "main", "--format=%s"])
        .current_dir(&w.remote)
        .envs(w.env().iter().map(|(k, v)| (k, v)))
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn two_binary_conflicts_of_one_file_keep_both_copies() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[]);
    a.write_bytes("pic.png", &[0, 1]);
    a.commit();
    a.ok();
    b.ok();
    let mut copies = Vec::new();
    for round in 2u8..4 {
        a.write_bytes("pic.png", &[0, round, 9]);
        a.commit();
        a.ok();
        b.write_bytes("pic.png", &[0, round, 5]);
        b.commit();
        let r = b.ok();
        assert_eq!(r.copies.len(), 1, "{:?}", r.copies);
        copies.push(r.copies[0].1.clone());
    }
    assert_ne!(copies[0], copies[1]);
    assert_eq!(
        std::fs::read(b.root.join(&copies[0])).unwrap(),
        vec![0, 2, 5]
    );
    assert_eq!(
        std::fs::read(b.root.join(&copies[1])).unwrap(),
        vec![0, 3, 5]
    );
}
