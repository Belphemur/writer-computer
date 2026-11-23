//! The engine's contract: messages, the ignore block, commits and status in temporary repositories
//! (never the user's git config or vault), the identity against the real `git`, and the source scan.

use super::message::*;
use super::repo::VersionKind;
use super::repo::ISOLATED;
use super::scheduler::AgentTurn;
use super::scheduler::*;
use super::*;
use std::path::Path;
use std::time::{Duration, Instant};

fn ctx() -> TemplateCtx {
    TemplateCtx {
        date: "2026-11-20 14:03".into(),
        hostname: "Studio".into(),
    }
}

fn user(changes: &[Change]) -> String {
    Message::user(changes, DEFAULT_TEMPLATE, &ctx(), "Studio Mac").render()
}

fn add(p: &str) -> Change {
    Change::Add(p.into())
}
fn edit(p: &str) -> Change {
    Change::Edit(p.into())
}
fn del(p: &str) -> Change {
    Change::Delete(p.into())
}

// ---- message builder ----------------------------------------------------------------------------

#[test]
fn every_scope_of_a_single_kind() {
    assert!(user(&[edit("Plan.md")]).starts_with("user(edit): Plan\n"));
    assert!(user(&[add("Ideas.md")]).starts_with("user(add): Ideas\n"));
    assert!(user(&[del("Old draft.md")]).starts_with("user(delete): Old draft\n"));
    let moved = Change::Move {
        from: "Plan.md".into(),
        to: "Archive/Plan.md".into(),
    };
    assert!(user(&[moved]).starts_with("user(move): Plan → Archive/Plan\n"));
    let restore = Message::user_scoped(Scope::Restore, "Plan to 2026-11-19 14:03", "d").render();
    assert!(restore.starts_with("user(restore): Plan to 2026-11-19 14:03\n"));
    let merge = Message::user_scoped(Scope::Merge, "Plan", "d").render();
    assert!(merge.starts_with("user(merge): Plan\n"));
    let setup = Message::chore(Scope::Setup, "start version history", "d").render();
    assert!(setup.starts_with("chore(setup): start version history\n"));
    let ignore = Message::chore(Scope::Ignore, "update ignored files", "d").render();
    assert!(ignore.starts_with("chore(ignore): update ignored files\n"));
}

#[test]
fn mixed_kinds_are_an_edit_and_more_than_two_notes_count() {
    let m = user(&[
        edit("Meeting notes.md"),
        edit("Plan.md"),
        add("A.md"),
        del("B.md"),
    ]);
    assert!(
        m.starts_with("user(edit): Meeting notes, Plan (+2)\n"),
        "{m}"
    );
    let same = user(&[add("a.md"), add("b.md"), add("c.md")]);
    assert!(same.starts_with("user(add): a, b (+1)\n"), "{same}");
}

#[test]
fn titles_drop_md_but_other_files_keep_their_extension() {
    let m = user(&[edit("Notes/Deep/Plan.md"), edit("x/board.canvas")]);
    assert!(m.starts_with("user(edit): Plan, board.canvas\n"), "{m}");
}

#[test]
fn the_template_shapes_only_the_subject() {
    let m = Message::user(
        &[edit("Plan.md"), add("B.md")],
        "{{numFiles}} on {{hostname}} at {{date}}: {{files}}",
        &ctx(),
        "Studio Mac",
    )
    .render();
    assert!(
        m.starts_with("user(edit): 2 on Studio at 2026-11-20 14:03: Plan.md, B.md\n"),
        "{m}"
    );
}

#[test]
fn trailers_for_user_and_agent_commits() {
    let m = user(&[edit("Plan.md")]);
    assert!(m.ends_with("Writer-Device: Studio Mac\n"));
    assert!(!m.contains("Writer-Chat"));
    let models = vec![
        "claude-opus-5-5".to_string(),
        "claude-haiku-5-5".to_string(),
        "claude-opus-5-5".to_string(),
    ];
    let agent = Message::agent(
        &[edit("Plan.md")],
        "Rewrite the interview guide",
        AgentTurnInfo {
            chat_id: "c1",
            turn_id: None,
            backend: "claude",
            models: &models,
        },
        "Studio Mac",
    )
    .render();
    assert_eq!(
        agent,
        "agent(edit): Rewrite the interview guide\n\nWriter-Device: Studio Mac\nWriter-Chat: c1\nWriter-Agent: claude\nWriter-Model: claude-opus-5-5\nWriter-Model: claude-haiku-5-5\n"
    );
}

#[test]
fn an_unknown_model_leaves_the_trailer_out() {
    let agent = Message::agent(
        &[edit("a.md")],
        "t",
        AgentTurnInfo {
            chat_id: "c",
            turn_id: None,
            backend: "claude",
            models: &[],
        },
        "d",
    )
    .render();
    assert!(!agent.contains("Writer-Model"));
}

#[test]
fn a_subject_stays_on_one_line_and_messages_read_back() {
    let m = Message::agent(
        &[edit("a.md")],
        "two\nlines  here",
        AgentTurnInfo {
            chat_id: "c",
            turn_id: None,
            backend: "claude",
            models: &["m1".to_string()],
        },
        "dev",
    );
    let text = m.render();
    assert!(text.starts_with("agent(edit): two lines here\n"));
    let p = parse(&text);
    assert_eq!(p.ty, Some(Type::Agent));
    assert_eq!(p.scope, Some(Scope::Edit));
    assert_eq!(p.subject, "two lines here");
    assert_eq!(p.device.as_deref(), Some("dev"));
    assert_eq!(p.chat.as_deref(), Some("c"));
    assert_eq!(p.agent.as_deref(), Some("claude"));
    assert_eq!(p.models, vec!["m1"]);
    let foreign = parse("fix stuff");
    assert_eq!(foreign.ty, None);
    assert_eq!(foreign.subject, "fix stuff");
}

// ---- the managed ignore block -------------------------------------------------------------------

#[test]
fn the_ignore_block_is_idempotent_and_keeps_user_lines() {
    let user_lines = "node_modules/\n*.log\n";
    let once = ignore::apply(user_lines);
    assert!(once.starts_with(user_lines));
    assert!(once.contains("# writer:begin\n.obsidian/workspace*.json\n"));
    assert!(once.ends_with("# writer:end\n"));
    assert_eq!(ignore::apply(&once), once);
    // a stale block is replaced in place, the lines around it untouched
    let stale = "top\n# writer:begin\nold\n# writer:end\nbottom\n";
    let fixed = ignore::apply(stale);
    assert!(fixed.starts_with("top\n# writer:begin\n.obsidian"));
    assert!(fixed.ends_with("# writer:end\nbottom\n"));
    assert!(!fixed.contains("old"));
    // no trailing newline in the user's file
    assert!(ignore::apply("a").starts_with("a\n\n# writer:begin"));
}

#[test]
fn device_local_paths() {
    for p in [
        ".obsidian/workspace.json",
        ".obsidian/workspace-mobile.json",
        ".obsidian/cache",
        ".writer/index/x.db",
        ".writer/git/state.json",
        ".trash/old.md",
        "a/.DS_Store",
        ".git/index",
    ] {
        assert!(ignore::device_local(p), "{p}");
    }
    for p in ["note.md", ".obsidian/app.json", ".writer/graph.json"] {
        assert!(!ignore::device_local(p), "{p}");
    }
}

// ---- repositories -----------------------------------------------------------------------------

/// A vault in a temp dir with a repo-local identity; reads only that repository's config.
fn vault() -> tempfile::TempDir {
    ISOLATED.with(|i| i.set(true));
    let dir = tempfile::tempdir().unwrap();
    let repo = Repo::init(dir.path()).unwrap();
    drop(repo);
    set_identity(dir.path(), "Ada Writer", "ada@example.test");
    dir
}

fn set_identity(root: &Path, name: &str, email: &str) {
    let cfg = root.join(".git/config");
    let mut text = std::fs::read_to_string(&cfg).unwrap();
    text.push_str(&format!("[user]\n\tname = {name}\n\temail = {email}\n"));
    std::fs::write(cfg, text).unwrap();
}

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn git_cli(root: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn setup_commits_the_vault_with_the_block_and_status_is_clean() {
    let dir = vault();
    let root = dir.path();
    write(root, "Plan.md", "# Plan\n");
    write(root, "Archive/Old.md", "old\n");
    write(root, ".obsidian/workspace.json", "{}");
    assert!(!is_set_up(root));
    setup(root, SetupMode::LocalOnly, "Studio").unwrap();
    assert!(is_set_up(root));
    let status = status(root, &IdentityCache::default(), true, crate::git::Lfs::OFF).unwrap();
    assert!(status.changes.is_empty(), "{:?}", status.changes);
    let repo = Repo::open(root).unwrap().unwrap();
    let log = repo.log(None, 10).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].message.ty, Some(Type::Chore));
    assert_eq!(log[0].message.scope, Some(Scope::Setup));
    assert_eq!(log[0].message.device.as_deref(), Some("Studio"));
    // the device-local file is not in the repository; the real git agrees with our index
    if let Some(files) = git_cli(root, &["ls-files"]) {
        assert!(files.contains("Plan.md") && files.contains("Archive/Old.md"));
        assert!(files.contains(".gitignore"));
        assert!(!files.contains("workspace.json"), "{files}");
        assert_eq!(git_cli(root, &["status", "--porcelain"]).unwrap(), "");
    }
    // setting up again changes nothing
    setup(root, SetupMode::Existing, "Studio").unwrap();
    assert_eq!(repo.log(None, 10).unwrap().len(), 1);
}

#[test]
fn a_commit_holds_only_the_paths_given() {
    let dir = vault();
    let root = dir.path();
    write(root, "a.md", "a1");
    write(root, "b.md", "b1");
    setup(root, SetupMode::LocalOnly, "d").unwrap();
    write(root, "a.md", "a2");
    write(root, "b.md", "b2");
    write(root, "c.md", "new");
    let repo = Repo::open(root).unwrap().unwrap();
    let changes = repo.changes().unwrap();
    assert_eq!(changes, vec![edit("a.md"), edit("b.md"), add("c.md")]);
    let only_a = [edit("a.md")];
    let msg = Message::user(&only_a, DEFAULT_TEMPLATE, &ctx(), "d");
    repo.commit(&only_a, &msg).unwrap();
    let rest = repo.changes().unwrap();
    assert_eq!(rest, vec![edit("b.md"), add("c.md")]);
    if let Some(s) = git_cli(root, &["status", "--porcelain"]) {
        assert!(
            s.contains(" M b.md") && s.contains("?? c.md") && !s.contains("a.md"),
            "{s}"
        );
        assert_eq!(git_cli(root, &["show", "HEAD:a.md"]).unwrap(), "a2");
    }
}

#[test]
fn deletes_and_moves_are_detected_and_committed() {
    let dir = vault();
    let root = dir.path();
    write(root, "Plan.md", "plan body");
    write(root, "Gone.md", "gone body");
    setup(root, SetupMode::LocalOnly, "d").unwrap();
    std::fs::remove_file(root.join("Gone.md")).unwrap();
    std::fs::create_dir_all(root.join("Archive")).unwrap();
    std::fs::rename(root.join("Plan.md"), root.join("Archive/Plan.md")).unwrap();
    let repo = Repo::open(root).unwrap().unwrap();
    let changes = repo.changes().unwrap();
    assert_eq!(
        changes,
        vec![
            Change::Move {
                from: "Plan.md".into(),
                to: "Archive/Plan.md".into()
            },
            del("Gone.md")
        ]
    );
    let id = commit_user(root, DEFAULT_TEMPLATE, &ctx(), "d", crate::git::Lfs::OFF).unwrap();
    assert!(id.is_some());
    let log = repo.log(None, 5).unwrap();
    assert_eq!(log[0].message.scope, Some(Scope::Edit), "mixed kinds");
    assert!(repo.changes().unwrap().is_empty());
    assert_eq!(
        commit_user(root, DEFAULT_TEMPLATE, &ctx(), "d", crate::git::Lfs::OFF).unwrap(),
        None
    );
    if let Some(s) = git_cli(root, &["ls-files"]) {
        assert!(s.contains("Archive/Plan.md") && !s.contains("Gone.md"));
    }
}

#[test]
fn the_log_of_a_path_lists_only_its_commits() {
    let dir = vault();
    let root = dir.path();
    write(root, "a.md", "1");
    write(root, "b.md", "1");
    setup(root, SetupMode::LocalOnly, "d").unwrap();
    write(root, "a.md", "2");
    commit_user(root, "{{notes}}", &ctx(), "d", crate::git::Lfs::OFF).unwrap();
    write(root, "b.md", "2");
    commit_user(root, "{{notes}}", &ctx(), "d", crate::git::Lfs::OFF).unwrap();
    let repo = Repo::open(root).unwrap().unwrap();
    let a = repo.log(Some("a.md"), 10).unwrap();
    assert_eq!(a.len(), 2);
    assert_eq!(a[0].message.subject, "a");
    assert_eq!(repo.log(None, 10).unwrap().len(), 3);
    assert_eq!(repo.log(None, 1).unwrap().len(), 1);
}

#[test]
fn an_agent_commit_takes_only_the_turns_files() {
    let dir = vault();
    let root = dir.path();
    write(root, "mine.md", "1");
    write(root, "theirs.md", "1");
    setup(root, SetupMode::LocalOnly, "d").unwrap();
    write(root, "mine.md", "2");
    write(root, "theirs.md", "2");
    let turn = AgentTurn {
        chat_id: "chat-1".into(),
        turn_id: None,
        backend: "claude".into(),
        title: "Tidy theirs".into(),
        models: vec!["claude-opus-5-5".into()],
        files: vec!["theirs.md".into()],
    };
    assert!(
        commit_agent(root, &turn, "Agent turn", "d", crate::git::Lfs::OFF)
            .unwrap()
            .is_some()
    );
    let repo = Repo::open(root).unwrap().unwrap();
    assert_eq!(repo.changes().unwrap(), vec![edit("mine.md")]);
    let head = &repo.log(None, 1).unwrap()[0];
    assert_eq!(head.message.ty, Some(Type::Agent));
    assert_eq!(head.message.subject, "Tidy theirs");
    assert_eq!(head.message.chat.as_deref(), Some("chat-1"));
    assert_eq!(head.message.models, vec!["claude-opus-5-5"]);
    // a turn whose files did not change commits nothing
    assert!(commit_agent(root, &turn, "x", "d", crate::git::Lfs::OFF)
        .unwrap()
        .is_none());
}

#[test]
fn no_identity_means_no_commit_and_an_explicit_error() {
    ISOLATED.with(|i| i.set(true));
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a.md", "x");
    let err = setup(dir.path(), SetupMode::LocalOnly, "d").unwrap_err();
    assert!(matches!(err, Error::NoIdentity), "{err}");
    assert!(err.to_string().contains("git config --global user.name"));
    // nothing was written into the vault but the repository
    assert!(!dir.path().join(".gitignore").exists());
    let repo = Repo::open(dir.path()).unwrap().unwrap();
    assert!(!repo.has_commits());
    assert!(
        status(
            dir.path(),
            &IdentityCache::default(),
            true,
            crate::git::Lfs::OFF
        )
        .unwrap()
        .identity_error
    );
}

#[test]
fn a_vault_below_a_repository_is_not_that_repository() {
    ISOLATED.with(|i| i.set(true));
    let outer = tempfile::tempdir().unwrap();
    Repo::init(outer.path()).unwrap();
    let inner = outer.path().join("vault");
    std::fs::create_dir_all(&inner).unwrap();
    assert!(Repo::open(&inner).unwrap().is_none());
    assert!(
        !status(
            &inner,
            &IdentityCache::default(),
            true,
            crate::git::Lfs::OFF
        )
        .unwrap()
        .set_up
    );
}

#[test]
fn pause_is_device_local_state() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!state::paused(dir.path()));
    state::set_paused(dir.path(), true).unwrap();
    assert!(state::paused(dir.path()));
    state::set_paused(dir.path(), false).unwrap();
    assert!(!state::paused(dir.path()));
}

// ---- the commit identity is git's --------------------------------------------------------------

const CHILD: &str = "WRITER_GIT_IDENTITY_CHILD";

/// Run by [`identity_matches_git_var`] in a child process with its own `HOME`: prints what the
/// engine resolves. A plain test run does nothing here.
#[test]
fn identity_child() {
    let Ok(root) = std::env::var(CHILD) else {
        return;
    };
    let repo = Repo::open(Path::new(&root)).unwrap().unwrap();
    // `gix` selects the fallback used when git is not installed
    let resolved = if std::env::var("WRITER_GIT_IDENTITY_VIA").is_ok_and(|v| v == "gix") {
        repo.identities_via_gix()
    } else {
        repo.identities()
    };
    match resolved {
        Ok(ids) => println!(
            "IDENT|{}|{}|{}|{}|",
            ids.author.name, ids.author.email, ids.committer.name, ids.committer.email
        ),
        Err(e) => println!("IDENT-ERR|{e}|"),
    }
}

fn git_var(root: &Path, which: &str, envs: &[(&str, String)]) -> Option<(String, String)> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["var", which]).current_dir(root).env_clear();
    cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // `Name <email> 1700000000 +0000`
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (name, rest) = line.split_once(" <")?;
    let (email, _date) = rest.split_once("> ")?;
    Some((name.to_string(), email.to_string()))
}

fn engine_identity(root: &Path, envs: &[(&str, String)]) -> String {
    let exe = std::env::current_exe().unwrap();
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["--exact", "git::tests::identity_child", "--nocapture"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env(CHILD, root);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.starts_with("IDENT"))
        .unwrap_or("")
        .to_string()
}

#[test]
fn identity_matches_git_var() {
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("git is not installed: skipped");
        return;
    }
    // real paths: git matches `gitdir:` against the resolved location (macOS temp dirs are links)
    let home_dir = tempfile::tempdir().unwrap();
    let work_dir = tempfile::tempdir().unwrap();
    let home = home_dir.path().canonicalize().unwrap();
    let work = work_dir.path().canonicalize().unwrap();
    let vault = work.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    {
        ISOLATED.with(|i| i.set(true));
        Repo::init(&vault).unwrap();
        ISOLATED.with(|i| i.set(false));
    }
    let xdg = home.join("xdg");
    std::fs::create_dir_all(xdg.join("git")).unwrap();
    // global config: an `includeIf` on the vault's location pulls in a work identity
    let include = home.join("work.gitconfig");
    std::fs::write(
        &include,
        "[user]\n\tname = Work Ada\n\temail = ada@work.test\n",
    )
    .unwrap();
    std::fs::write(
        home.join(".gitconfig"),
        format!(
            "[user]\n\tname = Home Ada\n\temail = ada@home.test\n[includeIf \"gitdir:{}/\"]\n\tpath = {}\n",
            work.display(),
            include.display()
        ),
    )
    .unwrap();
    let base = vec![
        ("HOME", home.display().to_string()),
        ("XDG_CONFIG_HOME", xdg.display().to_string()),
        ("GIT_CONFIG_NOSYSTEM", "1".to_string()),
    ];
    let check = |envs: &[(&str, String)], label: &str| {
        let a = git_var(&vault, "GIT_AUTHOR_IDENT", envs).expect("git author ident");
        let c = git_var(&vault, "GIT_COMMITTER_IDENT", envs).expect("git committer ident");
        let got = engine_identity(&vault, envs);
        assert_eq!(
            got,
            format!("IDENT|{}|{}|{}|{}|", a.0, a.1, c.0, c.1),
            "{label}"
        );
    };
    // 1. the include wins over the global [user]
    check(&base, "includeIf");
    // 2. the repository's own config wins over the global one
    set_identity(&vault, "Repo Ada", "ada@repo.test");
    check(&base, "repo config");
    // 3. the environment wins over everything, author and committer apart
    let mut envs = base.clone();
    envs.push(("GIT_AUTHOR_NAME", "Env Author".into()));
    envs.push(("GIT_AUTHOR_EMAIL", "author@env.test".into()));
    envs.push(("GIT_COMMITTER_NAME", "Env Committer".into()));
    envs.push(("GIT_COMMITTER_EMAIL", "committer@env.test".into()));
    check(&envs, "env");
    // 4. the XDG config is read when there is no ~/.gitconfig
    std::fs::remove_file(home.join(".gitconfig")).unwrap();
    std::fs::write(
        xdg.join("git/config"),
        "[user]\n\tname = Xdg Ada\n\temail = ada@xdg.test\n",
    )
    .unwrap();
    std::fs::write(
        vault.join(".git/config"),
        "[core]\n\trepositoryformatversion = 0\n",
    )
    .unwrap();
    check(&base, "xdg");
    // 5. nothing configured: the engine refuses where git would guess; never an invented identity
    std::fs::remove_file(xdg.join("git/config")).unwrap();
    let got = engine_identity(&vault, &base);
    assert!(
        got.starts_with("IDENT-ERR|Set your git name and email"),
        "{got}"
    );
}

/// A repository reached through a symlink (macOS temp dirs are links too). `pattern_via_link`
/// puts the `includeIf` on the link spelling instead of the real path.
#[cfg(unix)]
fn symlink_world(
    pattern_via_link: bool,
) -> (
    Vec<tempfile::TempDir>,
    std::path::PathBuf,
    Vec<(&'static str, String)>,
) {
    let home_dir = tempfile::tempdir().unwrap();
    let work_dir = tempfile::tempdir().unwrap();
    let home = home_dir.path().canonicalize().unwrap();
    let real_parent = work_dir.path().canonicalize().unwrap().join("real");
    let vault_real = real_parent.join("vault");
    std::fs::create_dir_all(&vault_real).unwrap();
    let link = work_dir.path().canonicalize().unwrap().join("link");
    std::os::unix::fs::symlink(&real_parent, &link).unwrap();
    ISOLATED.with(|i| i.set(true));
    Repo::init(&vault_real).unwrap();
    ISOLATED.with(|i| i.set(false));
    let include = home.join("work.gitconfig");
    std::fs::write(
        &include,
        "[user]\n\tname = Work Ada\n\temail = ada@work.test\n",
    )
    .unwrap();
    let pattern_dir = if pattern_via_link {
        &link
    } else {
        &real_parent
    };
    std::fs::write(
        home.join(".gitconfig"),
        format!(
            "[user]\n\tname = Home Ada\n\temail = ada@home.test\n[includeIf \"gitdir:{}/\"]\n\tpath = {}\n",
            pattern_dir.display(),
            include.display()
        ),
    )
    .unwrap();
    let envs = vec![
        ("HOME", home.display().to_string()),
        ("XDG_CONFIG_HOME", home.join("xdg").display().to_string()),
        ("GIT_CONFIG_NOSYSTEM", "1".to_string()),
    ];
    (vec![home_dir, work_dir], link.join("vault"), envs)
}

/// git matches `gitdir:` against the resolved path; the engine asks git, so a repository reached
/// through a symlink gets git's identity, and the gix fallback (no `git` installed) agrees.
#[cfg(unix)]
#[test]
fn identity_through_a_symlinked_repo_path_is_gits() {
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("git is not installed: skipped");
        return;
    }
    for via_link in [false, true] {
        let (_keep, vault, envs) = symlink_world(via_link);
        let a = git_var(&vault, "GIT_AUTHOR_IDENT", &envs).expect("git author ident");
        let c = git_var(&vault, "GIT_COMMITTER_IDENT", &envs).expect("git committer ident");
        let want = format!("IDENT|{}|{}|{}|{}|", a.0, a.1, c.0, c.1);
        // the pattern on the real path matches (work); on the link spelling it does not (home)
        assert_eq!(a.0, if via_link { "Home Ada" } else { "Work Ada" });
        assert_eq!(
            engine_identity(&vault, &envs),
            want,
            "engine, pattern via link: {via_link}"
        );
        let mut gix_envs = envs.clone();
        gix_envs.push(("WRITER_GIT_IDENTITY_VIA", "gix".into()));
        assert_eq!(
            engine_identity(&vault, &gix_envs),
            want,
            "gix fallback, pattern via link: {via_link}"
        );
    }
}

#[test]
fn git_var_runs_with_config_only_so_it_never_guesses() {
    // no identity configured anywhere: git (useConfigOnly) refuses, the engine says NoIdentity
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("git is not installed: skipped");
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    ISOLATED.with(|i| i.set(true));
    Repo::init(work.path()).unwrap();
    ISOLATED.with(|i| i.set(false));
    let envs = vec![
        ("HOME", home.path().display().to_string()),
        (
            "XDG_CONFIG_HOME",
            home.path().join("xdg").display().to_string(),
        ),
        ("GIT_CONFIG_NOSYSTEM", "1".to_string()),
    ];
    let got = engine_identity(work.path(), &envs);
    assert!(
        got.starts_with("IDENT-ERR|Set your git name and email"),
        "{got}"
    );
}

// ---- cadence ---------------------------------------------------------------------------------

fn turn(files: &[&str]) -> AgentTurn {
    AgentTurn {
        chat_id: "c".into(),
        turn_id: None,
        backend: "claude".into(),
        title: "T".into(),
        models: vec![],
        files: files.iter().map(|s| s.to_string()).collect(),
    }
}

const MIN: Option<Duration> = Some(Duration::from_secs(60));

fn at(t0: Instant, s: u64) -> Instant {
    t0 + Duration::from_secs(s)
}

#[test]
fn no_commit_at_59_seconds_commit_at_60_and_a_write_resets() {
    let t0 = Instant::now();
    let mut c = Cadence::new();
    c.on_write(t0);
    assert_eq!(c.tick(at(t0, 59), MIN, false), Action::Nothing);
    assert_eq!(c.tick(at(t0, 60), MIN, false), Action::CommitUser);
    // committed: nothing more is due
    assert_eq!(c.tick(at(t0, 200), MIN, false), Action::Nothing);
    // a write resets the timer
    c.on_write(at(t0, 300));
    c.on_write(at(t0, 340));
    assert_eq!(c.tick(at(t0, 399), MIN, false), Action::Nothing);
    assert_eq!(c.tick(at(t0, 400), MIN, false), Action::CommitUser);
}

#[test]
fn a_lint_fix_write_inside_the_window_makes_one_commit() {
    let t0 = Instant::now();
    let mut c = Cadence::new();
    c.on_write(t0); // the user's autosave
    c.on_write(at(t0, 5)); // lint's safe fix, 5 s after typing stopped
    assert_eq!(c.tick(at(t0, 64), MIN, false), Action::Nothing);
    assert_eq!(c.tick(at(t0, 65), MIN, false), Action::CommitUser);
    assert_eq!(c.tick(at(t0, 130), MIN, false), Action::Nothing);
}

#[test]
fn manual_and_paused_never_fire() {
    let t0 = Instant::now();
    let mut c = Cadence::new();
    c.on_write(t0);
    assert_eq!(c.tick(at(t0, 10_000), None, false), Action::Nothing);
    assert_eq!(c.tick(at(t0, 10_000), MIN, true), Action::Nothing);
    assert_eq!(c.tick(at(t0, 10_000), MIN, false), Action::CommitUser);
}

#[test]
fn no_user_commit_during_a_turn_and_the_agent_commit_goes_first() {
    let t0 = Instant::now();
    let mut c = Cadence::new();
    c.on_write(t0);
    c.turn_started("chat", t0);
    assert_eq!(
        c.tick(at(t0, 600), MIN, false),
        Action::Nothing,
        "turn running"
    );
    c.turn_ended("chat", Some(turn(&["a.md"])));
    assert_eq!(
        c.tick(at(t0, 601), MIN, false),
        Action::CommitAgent(turn(&["a.md"]))
    );
    // then the quiet timer resumes for the rest
    assert_eq!(c.tick(at(t0, 602), MIN, false), Action::CommitUser);
}

#[test]
fn a_turn_without_changes_just_unblocks() {
    let t0 = Instant::now();
    let mut c = Cadence::new();
    c.on_write(t0);
    c.turn_started("chat", t0);
    c.turn_ended("chat", None);
    assert_eq!(c.tick(at(t0, 60), MIN, false), Action::CommitUser);
}

// ---- the dependency stays behind this module ------------------------------------------------------

// ---- setup by default ---------------------------------------------------------------------------

fn plain_dir() -> tempfile::TempDir {
    ISOLATED.with(|i| i.set(true));
    tempfile::tempdir().unwrap()
}

#[test]
fn a_plain_vault_gets_a_repository_the_block_and_no_commit_without_identity() {
    let dir = plain_dir();
    let root = dir.path();
    write(root, "Plan.md", "# Plan\n");
    assert_eq!(
        auto_setup(root, "Studio").unwrap(),
        Auto::Done { committed: false }
    );
    assert!(is_set_up(root));
    let repo = Repo::open(root).unwrap().unwrap();
    assert!(!repo.has_commits());
    // the identity arrives later: the first commit is the setup commit, with everything in it
    set_identity(root, "Ada Writer", "ada@example.test");
    let repo = Repo::open(root).unwrap().unwrap();
    let id = commit_user(
        root,
        DEFAULT_TEMPLATE,
        &ctx(),
        "Studio",
        crate::git::Lfs::OFF,
    )
    .unwrap();
    assert!(id.is_some());
    let log = repo.log(None, 5).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].message.scope, Some(Scope::Setup));
    assert_eq!(log[0].message.subject, "start version history");
    assert!(repo.changes().unwrap().is_empty());
}

#[test]
fn the_first_commit_of_a_fresh_repository_is_chore_setup() {
    let dir = vault();
    let root = dir.path();
    write(root, "Plan.md", "# Plan\n");
    ignore::ensure(root).unwrap();
    let repo = Repo::open(root).unwrap().unwrap();
    assert_eq!(
        finish_setup(&repo, "Studio").unwrap(),
        Auto::Done { committed: true }
    );
    let log = repo.log(None, 5).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].message.ty, Some(Type::Chore));
    assert_eq!(log[0].message.subject, "start version history");
}

#[test]
fn a_vault_that_is_a_repository_is_used_as_it_is_with_no_extra_commit() {
    let dir = vault();
    let root = dir.path();
    write(root, "Plan.md", "# Plan\n");
    let repo = Repo::open(root).unwrap().unwrap();
    let first = [add("Plan.md")];
    repo.commit(
        &first,
        &Message::user(&first, DEFAULT_TEMPLATE, &ctx(), "d"),
    )
    .unwrap();
    assert!(!is_set_up(root));
    assert_eq!(
        auto_setup(root, "d").unwrap(),
        Auto::Done { committed: false }
    );
    assert!(is_set_up(root));
    assert_eq!(repo.log(None, 5).unwrap().len(), 1, "no commit of its own");
    // the managed block is a pending change until the next commit
    assert_eq!(repo.changes().unwrap(), vec![add(".gitignore")]);
    assert_eq!(auto_setup(root, "d").unwrap(), Auto::Already);
}

#[test]
fn a_vault_inside_another_repository_is_never_set_up_silently() {
    ISOLATED.with(|i| i.set(true));
    let outer = tempfile::tempdir().unwrap();
    Repo::init(outer.path()).unwrap();
    let inner = outer.path().join("docs");
    write(&inner, "Plan.md", "# Plan\n");
    assert!(in_parent_repo(&inner));
    assert_eq!(auto_setup(&inner, "d").unwrap(), Auto::InParentRepo);
    assert!(!inner.join(".git").exists());
    assert!(!inner.join(".gitignore").exists());
    let s = status(
        &inner,
        &IdentityCache::default(),
        true,
        crate::git::Lfs::OFF,
    )
    .unwrap();
    assert!(!s.set_up && s.parent_repo);
    // the user's own choice still sets up a repository of its own
    set_identity_global_free(&inner);
    setup(&inner, SetupMode::LocalOnly, "d").unwrap();
    assert!(is_set_up(&inner));
}

/// A repository made by hand in `root` carries a repo-local identity, so `setup` can commit.
fn set_identity_global_free(root: &Path) {
    Repo::init(root).unwrap();
    set_identity(root, "Ada Writer", "ada@example.test");
}

#[test]
fn stopping_keeps_git_and_history_and_is_not_set_up_again_automatically() {
    let dir = vault();
    let root = dir.path();
    write(root, "Plan.md", "# Plan\n");
    setup(root, SetupMode::LocalOnly, "d").unwrap();
    assert!(is_set_up(root));
    stop(root).unwrap();
    assert!(!is_set_up(root));
    assert!(root.join(".git").exists(), "never deletes .git");
    let repo = Repo::open(root).unwrap().unwrap();
    assert_eq!(repo.log(None, 5).unwrap().len(), 1);
    assert_eq!(auto_setup(root, "d").unwrap(), Auto::Stopped);
    assert!(!is_set_up(root));
    assert!(
        status(root, &IdentityCache::default(), true, crate::git::Lfs::OFF)
            .unwrap()
            .stopped
    );
    // the user's own choice sets it up again
    setup(root, SetupMode::Existing, "d").unwrap();
    assert!(is_set_up(root));
    // the pause flag survives the other flag
    state::set_paused(root, true).unwrap();
    stop(root).unwrap();
    assert!(state::paused(root) && state::stopped(root));
}

// ---- history ------------------------------------------------------------------------------------

fn save(root: &Path, changes: &[Change]) -> String {
    let repo = Repo::open(root).unwrap().unwrap();
    repo.commit(
        changes,
        &Message::user(changes, DEFAULT_TEMPLATE, &ctx(), "Studio"),
    )
    .unwrap()
}

fn history_vault() -> tempfile::TempDir {
    let dir = vault();
    setup(dir.path(), SetupMode::LocalOnly, "Studio").unwrap();
    dir
}

#[test]
fn a_files_log_follows_a_move_with_an_edit_through_the_writer_move_trailer() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Plan.md", "one\ntwo\nthree\n");
    save(root, &[add("Plan.md")]);
    write(root, "Plan.md", "one\ntwo\nthree\nfour\n");
    save(root, &[edit("Plan.md")]);
    // moved and edited at once: no similarity needed, Writer recorded the move
    std::fs::create_dir_all(root.join("Archive")).unwrap();
    std::fs::remove_file(root.join("Plan.md")).unwrap();
    write(root, "Archive/Plan.md", "completely rewritten text\n");
    let mv = [Change::Move {
        from: "Plan.md".into(),
        to: "Archive/Plan.md".into(),
    }];
    let id = save(root, &mv);
    let repo = Repo::open(root).unwrap().unwrap();
    let versions = repo.file_versions("Archive/Plan.md", 10).unwrap();
    assert_eq!(versions.len(), 3, "{versions:?}");
    assert_eq!(versions[0].id, id);
    assert_eq!(versions[0].kind, VersionKind::Move);
    assert_eq!(versions[0].from.as_deref(), Some("Plan.md"));
    assert_eq!(versions[1].kind, VersionKind::Edit);
    assert_eq!(versions[1].path, "Plan.md");
    assert_eq!(versions[2].kind, VersionKind::Add);
    assert_eq!(versions[0].message.moves.len(), 1);
}

#[test]
fn a_files_log_follows_a_rename_git_detects_by_content() {
    let dir = history_vault();
    let root = dir.path();
    let body = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
    write(root, "Old.md", body);
    save(root, &[add("Old.md")]);
    std::fs::remove_file(root.join("Old.md")).unwrap();
    write(root, "New.md", &format!("{body}eta\n"));
    // two plain changes, no trailer: git's own rename detection finds the pair
    save(root, &[del("Old.md"), add("New.md")]);
    let repo = Repo::open(root).unwrap().unwrap();
    let versions = repo.file_versions("New.md", 10).unwrap();
    assert_eq!(versions.len(), 2, "{versions:?}");
    assert_eq!(versions[0].kind, VersionKind::Move);
    assert_eq!(versions[0].from.as_deref(), Some("Old.md"));
    assert_eq!(versions[1].path, "Old.md");
}

#[test]
fn deleted_files_are_listed_but_moved_and_recreated_ones_are_not() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Gone.md", "gone body here\n");
    write(root, "Moved.md", "moved body that is long enough\n");
    write(root, "Again.md", "again\n");
    save(root, &[add("Gone.md"), add("Moved.md"), add("Again.md")]);
    std::fs::remove_file(root.join("Gone.md")).unwrap();
    std::fs::remove_file(root.join("Again.md")).unwrap();
    std::fs::remove_file(root.join("Moved.md")).unwrap();
    write(root, "Elsewhere.md", "moved body that is long enough\n");
    save(
        root,
        &[
            del("Gone.md"),
            del("Again.md"),
            Change::Move {
                from: "Moved.md".into(),
                to: "Elsewhere.md".into(),
            },
        ],
    );
    write(root, "Again.md", "again, back\n");
    save(root, &[add("Again.md")]);
    let repo = Repo::open(root).unwrap().unwrap();
    let deleted: Vec<_> = repo
        .deleted_files(100)
        .unwrap()
        .into_iter()
        .map(|d| d.path)
        .collect();
    assert_eq!(deleted, vec!["Gone.md"]);
}

#[test]
fn rows_carry_line_counts_and_diffs_work_against_parent_current_and_any_two() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Plan.md", "a\nb\nc\n");
    let v1 = save(root, &[add("Plan.md")]);
    write(root, "Plan.md", "a\nB\nc\nd\n");
    let v2 = save(root, &[edit("Plan.md")]);
    write(root, "Plan.md", "a\nB\nc\nd\ne\n");
    let repo = Repo::open(root).unwrap().unwrap();
    let rows = history::versions(&repo, "Plan.md", 10).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].added, rows[0].removed), (Some(2), Some(1)));
    assert_eq!((rows[1].added, rows[1].removed), (Some(3), Some(0)));
    let text = |d: history::FileDiff| match d {
        history::FileDiff::Text { diff } => diff,
        other => panic!("{other:?}"),
    };
    let parent =
        text(history::diff(&repo, root, "Plan.md", &v2, &history::Against::Parent).unwrap());
    assert_eq!((parent.added, parent.removed), (2, 1));
    assert!(parent.rendered.is_some(), "a note has the rendered view");
    let first =
        text(history::diff(&repo, root, "Plan.md", &v1[..8], &history::Against::Parent).unwrap());
    assert_eq!((first.added, first.removed), (3, 0));
    let current =
        text(history::diff(&repo, root, "Plan.md", &v1, &history::Against::Current).unwrap());
    assert_eq!((current.added, current.removed), (3, 1));
    let two = text(
        history::diff(
            &repo,
            root,
            "Plan.md",
            &v1,
            &history::Against::Version(v2.clone()),
        )
        .unwrap(),
    );
    assert_eq!((two.added, two.removed), (2, 1));
}

#[test]
fn diff_kinds_follow_the_file_kind() {
    let png = [0x89u8, b'P', b'N', b'G', 0, 1, 2];
    match history::diff_bytes("a/pic.png", Some(&png), None) {
        history::FileDiff::Image { before, after } => {
            assert_eq!(before.unwrap().mime, "image/png");
            assert!(after.is_none());
        }
        other => panic!("{other:?}"),
    }
    match history::diff_bytes("data.bin", Some(&[0, 1, 2]), Some(&[0, 1, 2, 3])) {
        history::FileDiff::Binary {
            before_size,
            after_size,
        } => {
            assert_eq!((before_size, after_size), (Some(3), Some(4)));
        }
        other => panic!("{other:?}"),
    }
    match history::diff_bytes("x.json", Some(b"{}\n"), Some(b"{\"a\":1}\n")) {
        history::FileDiff::Text { diff } => assert!(diff.rendered.is_none()),
        other => panic!("{other:?}"),
    }
}

#[test]
fn restore_writes_a_new_version_and_never_rewrites_history() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Plan.md", "first\n");
    let v1 = save(root, &[add("Plan.md")]);
    write(root, "Plan.md", "second\n");
    save(root, &[edit("Plan.md")]);
    // an edit not in history yet must survive the restore
    write(root, "Plan.md", "unsaved\n");
    let repo = Repo::open(root).unwrap().unwrap();
    let before = repo.log(None, 20).unwrap().len();
    let done = history::restore(&repo, root, "Plan.md", &v1, "Studio").unwrap();
    assert_eq!(done.path, "Plan.md");
    assert_eq!(
        std::fs::read_to_string(root.join("Plan.md")).unwrap(),
        "first\n"
    );
    let log = repo.log(None, 20).unwrap();
    assert_eq!(log.len(), before + 2, "the unsaved edit, then the restore");
    assert_eq!(log[0].message.ty, Some(Type::User));
    assert_eq!(log[0].message.scope, Some(Scope::Restore));
    assert!(
        log[0].message.subject.starts_with("Plan to "),
        "{}",
        log[0].message.subject
    );
    assert_eq!(log[1].message.scope, Some(Scope::Edit));
    let kept = repo.file_versions("Plan.md", 10).unwrap();
    assert!(
        kept.iter().any(|v| v.id == v1),
        "old versions are still there"
    );
    assert!(repo.changes().unwrap().is_empty());
}

#[test]
fn restoring_a_deleted_file_recreates_it_at_its_path_or_a_free_name() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Notes/Idea.md", "the idea\n");
    save(root, &[add("Notes/Idea.md")]);
    std::fs::remove_dir_all(root.join("Notes")).unwrap();
    save(root, &[del("Notes/Idea.md")]);
    let repo = Repo::open(root).unwrap().unwrap();
    let top = history::versions(&repo, "Notes/Idea.md", 5).unwrap();
    assert_eq!(top[0].version.kind, VersionKind::Delete);
    let done =
        history::restore(&repo, root, "Notes/Idea.md", &top[0].version.id, "Studio").unwrap();
    assert_eq!(done.path, "Notes/Idea.md");
    assert_eq!(
        std::fs::read_to_string(root.join("Notes/Idea.md")).unwrap(),
        "the idea\n"
    );
    // delete again, then a different file takes the path: a free name beside it
    std::fs::remove_file(root.join("Notes/Idea.md")).unwrap();
    save(root, &[del("Notes/Idea.md")]);
    write(root, "Notes/Idea.md", "something else\n");
    let top = history::versions(&repo, "Notes/Idea.md", 5).unwrap();
    let done =
        history::restore(&repo, root, "Notes/Idea.md", &top[0].version.id, "Studio").unwrap();
    assert_eq!(done.path, "Notes/Idea (restored).md");
    assert_eq!(
        std::fs::read_to_string(root.join("Notes/Idea.md")).unwrap(),
        "something else\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join(&done.path)).unwrap(),
        "the idea\n"
    );
}

fn agent_turn(repo: &Repo, chat: &str, turn: &str, title: &str) -> String {
    let changes = repo.changes().unwrap();
    let models = vec!["claude-opus-5-5".to_string()];
    let m = Message::agent(
        &changes,
        title,
        AgentTurnInfo {
            chat_id: chat,
            turn_id: Some(turn),
            backend: "claude",
            models: &models,
        },
        "d",
    );
    repo.commit(&changes, &m).unwrap()
}

#[test]
fn two_turns_of_one_chat_seconds_apart_resolve_to_their_own_commits() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "a.md", "1");
    let repo = Repo::open(root).unwrap().unwrap();
    let first = agent_turn(&repo, "c1", "turn-A", "one");
    write(root, "a.md", "2");
    let second = agent_turn(&repo, "c1", "turn-B", "two");
    let now = repo.log(None, 1).unwrap()[0].time;
    let found =
        |chat: &str, turn: &str| history::turn_commit(&repo, chat, turn, Some(now)).unwrap();
    assert_eq!(found("c1", "turn-A").rev, Some(first));
    assert_eq!(found("c1", "turn-B").rev, Some(second));
    assert!(found("c1", "turn-B").settled);
    // another chat's turn id, or one that made no commit, is null
    assert_eq!(found("c2", "turn-A").rev, None);
    assert_eq!(found("c1", "turn-C").rev, None);
}

#[test]
fn a_turn_without_a_commit_stays_null_and_settles_once_git_has_moved_on() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "a.md", "1");
    let repo = Repo::open(root).unwrap().unwrap();
    agent_turn(&repo, "c1", "turn-A", "one");
    let head = repo.log(None, 1).unwrap()[0].time;
    // just finished: the commit may still come
    let t = history::turn_commit(&repo, "c1", "turn-X", Some(head)).unwrap();
    assert_eq!((t.rev.clone(), t.settled), (None, false));
    // git committed something else well after the turn ended: there will be none
    let t = history::turn_commit(&repo, "c1", "turn-X", Some(head - 60)).unwrap();
    assert_eq!((t.rev, t.settled), (None, true));
    // no end time is known: never settled
    assert!(
        !history::turn_commit(&repo, "c1", "turn-X", None)
            .unwrap()
            .settled
    );
}

#[test]
fn the_turn_trailer_reads_back() {
    let dir = history_vault();
    write(dir.path(), "a.md", "1");
    let repo = Repo::open(dir.path()).unwrap().unwrap();
    agent_turn(&repo, "c1", "turn-A", "one");
    let log = repo.log(None, 1).unwrap();
    assert_eq!(log[0].message.turn.as_deref(), Some("turn-A"));
    assert_eq!(log[0].message.chat.as_deref(), Some("c1"));
}

// ---- never commit in the middle of an operation -----------------------------------------------

fn pending(root: &Path) -> Repo {
    write(root, "a.md", "1");
    setup(root, SetupMode::LocalOnly, "d").unwrap();
    write(root, "a.md", "2");
    Repo::open(root).unwrap().unwrap()
}

#[test]
fn no_commit_while_a_merge_rebase_or_the_like_is_under_way_and_it_resumes_by_itself() {
    let cases: [(&str, bool, Operation); 8] = [
        ("MERGE_HEAD", false, Operation::Merge),
        ("CHERRY_PICK_HEAD", false, Operation::CherryPick),
        ("REVERT_HEAD", false, Operation::Revert),
        ("rebase-merge", true, Operation::Rebase),
        ("rebase-apply", true, Operation::Rebase),
        ("BISECT_LOG", false, Operation::Bisect),
        // a detached HEAD has no marker file: HEAD names a commit
        ("", false, Operation::DetachedHead),
        ("rebase-apply", false, Operation::Rebase),
    ];
    for (marker, is_dir, op) in cases {
        let dir = history_vault();
        let root = dir.path();
        let repo = pending(root);
        let head = repo.head_id_string().unwrap();
        assert_eq!(operation(root), None, "{marker}");
        let restore_head = if marker.is_empty() {
            let original = std::fs::read_to_string(root.join(".git/HEAD")).unwrap();
            std::fs::write(root.join(".git/HEAD"), format!("{head}\n")).unwrap();
            Some(original)
        } else {
            let p = root.join(".git").join(marker);
            if is_dir {
                std::fs::create_dir_all(&p).unwrap();
            } else {
                std::fs::write(&p, "x").unwrap();
            }
            None
        };
        assert_eq!(operation(root), Some(op), "{marker}");
        // every way to commit refuses, and nothing is written
        let err =
            commit_user(root, DEFAULT_TEMPLATE, &ctx(), "d", crate::git::Lfs::OFF).unwrap_err();
        assert!(matches!(err, Error::Operation(_)), "{marker}: {err}");
        assert!(err.to_string().contains(op.label()), "{err}");
        let turn = AgentTurn {
            chat_id: "c".into(),
            turn_id: Some("t".into()),
            backend: "claude".into(),
            title: "x".into(),
            models: vec![],
            files: vec!["a.md".into()],
        };
        assert!(matches!(
            commit_agent(root, &turn, "t", "d", crate::git::Lfs::OFF),
            Err(Error::Operation(_))
        ));
        let v = repo.log(None, 1).unwrap()[0].id.clone();
        assert!(matches!(
            history::restore(&repo, root, "a.md", &v, "d"),
            Err(Error::Operation(_))
        ));
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "2");
        assert_eq!(repo.head_id_string().unwrap(), head, "{marker}");
        let s = status(root, &IdentityCache::default(), true, crate::git::Lfs::OFF).unwrap();
        assert_eq!(s.operation, Some(op));
        // the markers go: it resumes by itself
        match restore_head {
            Some(original) => std::fs::write(root.join(".git/HEAD"), original).unwrap(),
            None if is_dir => std::fs::remove_dir_all(root.join(".git").join(marker)).unwrap(),
            None => std::fs::remove_file(root.join(".git").join(marker)).unwrap(),
        }
        assert_eq!(operation(root), None, "{marker}");
        assert!(
            commit_user(root, DEFAULT_TEMPLATE, &ctx(), "d", crate::git::Lfs::OFF)
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn setup_writes_nothing_into_a_repository_in_the_middle_of_a_merge() {
    let dir = vault();
    let root = dir.path();
    write(root, "a.md", "1");
    std::fs::write(root.join(".git/MERGE_HEAD"), "x").unwrap();
    assert_eq!(auto_setup(root, "d").unwrap(), Auto::Paused);
    assert!(!root.join(".gitignore").exists());
}

// ---- what Writer does not version ----------------------------------------------------------------

#[test]
fn nested_repositories_and_node_modules_are_never_walked_into() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Notes/a.md", "1");
    // a folder with its own repository, and node_modules at any depth
    write(root, "code/lib/x.js", "x");
    Repo::init(&root.join("code")).unwrap();
    write(root, "node_modules/pkg/index.js", "x");
    write(root, "Notes/node_modules/y.js", "y");
    let repo = Repo::open(root).unwrap().unwrap();
    let paths: Vec<String> = repo
        .changes()
        .unwrap()
        .iter()
        .map(|c| c.path().to_string())
        .collect();
    assert_eq!(paths, vec!["Notes/a.md"], "{paths:?}");
}

#[test]
fn a_file_over_the_limit_is_skipped_and_listed() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "small.md", "s");
    // sparse: no disk is used
    let big = std::fs::File::create(root.join("huge.bin")).unwrap();
    big.set_len(crate::git::lfs::DEFAULT_THRESHOLD + 1).unwrap();
    let repo = Repo::open(root).unwrap().unwrap();
    let (changes, skipped) = repo.changes_and_skipped().unwrap();
    assert_eq!(changes, vec![add("small.md")]);
    assert_eq!(skipped, vec!["huge.bin"]);
    let s = status(root, &IdentityCache::default(), true, crate::git::Lfs::OFF).unwrap();
    assert_eq!(s.too_large, vec!["huge.bin"]);
    // committing everything leaves it out
    commit_user(root, DEFAULT_TEMPLATE, &ctx(), "d", crate::git::Lfs::OFF).unwrap();
    if let Some(files) = git_cli(root, &["ls-files"]) {
        assert!(
            files.contains("small.md") && !files.contains("huge.bin"),
            "{files}"
        );
    }
}

// ---- reading: safety and paths ---------------------------------------------------------------

#[cfg(unix)]
#[test]
fn the_file_now_is_never_read_through_a_link_that_leaves_the_vault() {
    let dir = history_vault();
    let root = dir.path();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), "secret\n").unwrap();
    write(root, "Plan.md", "plan\n");
    let v = save(root, &[add("Plan.md")]);
    std::fs::remove_file(root.join("Plan.md")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret.md"), root.join("Plan.md")).unwrap();
    let repo = Repo::open(root).unwrap().unwrap();
    match history::diff(
        &repo,
        root.canonicalize().unwrap().as_path(),
        "Plan.md",
        &v,
        &history::Against::Current,
    )
    .unwrap()
    {
        history::FileDiff::Text { diff } => {
            let text: String = diff.rows.iter().map(|r| r.text.as_str()).collect();
            assert!(!text.contains("secret"), "{text}");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_deleted_list_leaves_out_protected_and_device_local_paths() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Gone.md", "g");
    write(root, ".obsidian/app.json", "{}");
    write(root, "node_modules/p/i.js", "x");
    save(
        root,
        &[
            add("Gone.md"),
            add(".obsidian/app.json"),
            add("node_modules/p/i.js"),
        ],
    );
    for p in ["Gone.md", ".obsidian/app.json", "node_modules/p/i.js"] {
        std::fs::remove_file(root.join(p)).unwrap();
    }
    save(
        root,
        &[
            del("Gone.md"),
            del(".obsidian/app.json"),
            del("node_modules/p/i.js"),
        ],
    );
    let repo = Repo::open(root).unwrap().unwrap();
    let paths: Vec<_> = repo
        .deleted_files(100)
        .unwrap()
        .into_iter()
        .map(|d| d.path)
        .collect();
    assert_eq!(paths, vec!["Gone.md"]);
}

#[test]
fn moves_survive_arrows_and_double_spaces_in_names() {
    let dir = history_vault();
    let root = dir.path();
    let (from, to) = ("a -> b  c.md", "Archive/50% -> done  \u{e9}.md");
    write(root, from, "one\ntwo\nthree\nfour\n");
    save(root, &[add(from)]);
    std::fs::remove_file(root.join(from)).unwrap();
    write(root, to, "totally rewritten body\n");
    let mv = [Change::Move {
        from: from.into(),
        to: to.into(),
    }];
    save(root, &mv);
    let repo = Repo::open(root).unwrap().unwrap();
    let log = repo.log(None, 1).unwrap();
    assert_eq!(
        log[0].message.moves,
        vec![(from.to_string(), to.to_string())]
    );
    let versions = repo.file_versions(to, 10).unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].from.as_deref(), Some(from));
}

#[test]
fn a_version_is_found_in_one_commit_and_a_prefix_without_reading_messages() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "a.md", "1\n");
    let v1 = save(root, &[add("a.md")]);
    write(root, "a.md", "2\n");
    let v2 = save(root, &[edit("a.md")]);
    let repo = Repo::open(root).unwrap().unwrap();
    let one = repo.version_in_commit(&v2, "a.md").unwrap().unwrap();
    assert_eq!(one.id, v2);
    assert_eq!(one.kind, VersionKind::Edit);
    assert!(repo.version_in_commit(&v2, "other.md").unwrap().is_none());
    assert_eq!(
        history::find(&repo, "a.md", &v1[..8]).unwrap().kind,
        VersionKind::Add
    );
    // the cache answers the second time with the same list, and forgets it when HEAD moves
    let cache = history::Cache::default();
    let first = cache.versions(&repo, "a.md", 10).unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(cache.versions(&repo, "a.md", 10).unwrap(), first);
    write(root, "a.md", "3\n");
    save(root, &[edit("a.md")]);
    assert_eq!(cache.versions(&repo, "a.md", 10).unwrap().len(), 3);
}

#[test]
fn a_rev_is_a_full_id_or_a_unique_prefix() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "a.md", "a\n");
    let id = save(root, &[add("a.md")]);
    let repo = Repo::open(root).unwrap().unwrap();
    assert_eq!(repo.resolve(&id).unwrap(), id);
    assert_eq!(repo.resolve(&id[..7]).unwrap(), id);
    assert!(repo.resolve("zzzz").is_err());
    assert!(repo.resolve(&id[..2]).is_err());
}

#[test]
fn only_the_git_module_names_the_dependency() {
    fn scan(dir: &Path, own: &Path, hits: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path != own && path.file_name().is_some_and(|n| n != "node_modules") {
                    scan(&path, own, hits);
                }
            } else if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                if text.lines().any(|l| {
                    let l = l.trim_start();
                    !l.starts_with("//") && (l.contains("gix::") || l.contains("use gix"))
                }) {
                    hits.push(path.display().to_string());
                }
            }
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let own = manifest.join("src/git");
    let mut hits = Vec::new();
    scan(&manifest.join("src"), &own, &mut hits);
    scan(&manifest.join("../features"), &own, &mut hits);
    assert!(hits.is_empty(), "gix is named outside src/git: {hits:?}");
}

// ---- the sync timer ------------------------------------------------------------------------------

#[test]
fn the_sync_timer_follows_commits_the_interval_open_and_requests() {
    let t0 = Instant::now();
    let every = Some(Duration::from_secs(300));
    let secs = Duration::from_secs;
    let mut t = SyncTimer::new();
    assert!(!t.tick(t0, every, || true), "nothing is due at first");
    // a commit syncs 10 s later
    t.on_commit(t0);
    assert!(!t.tick(t0 + secs(9), every, || true));
    assert!(t.tick(t0 + secs(10), every, || true));
    assert!(!t.tick(t0 + secs(11), every, || true), "consumed");
    // then every interval since the last attempt
    assert!(!t.tick(t0 + secs(300), every, || true));
    assert!(t.tick(t0 + secs(310), every, || true));
    // opening syncs once; so does a request, also with Manual
    t.on_open();
    assert!(t.tick(t0 + secs(311), every, || true));
    t.request();
    assert!(t.tick(t0 + secs(312), None, || true));
    t.on_commit(t0 + secs(400));
    t.on_open();
    assert!(
        !t.tick(t0 + secs(500), None, || true),
        "Manual only syncs on request"
    );
    // not allowed: nothing runs, and the trigger is used up (no asking again every second)
    let mut t = SyncTimer::new();
    t.on_open();
    assert!(!t.tick(t0, every, || false));
    assert!(
        !t.tick(t0 + secs(1), every, || true),
        "the open trigger is gone"
    );
    t.request();
    assert!(
        !t.tick(t0 + secs(2), every, || false),
        "paused or no remote"
    );
    assert!(!t.tick(t0 + secs(3), every, || true));
    assert!(
        t.tick(t0 + secs(302), every, || true),
        "the interval asks again"
    );
}

#[test]
fn turns_are_a_set_of_chats_and_a_lost_one_expires() {
    let t0 = Instant::now();
    let mut c = Cadence::new();
    c.turn_started("a", t0);
    c.turn_started("a", t0);
    c.turn_ended("unknown", None);
    assert!(
        c.turn_running(),
        "a finish for another chat changes nothing"
    );
    c.turn_ended("a", None);
    assert!(!c.turn_running(), "a double start is one entry");
    // a finish that never comes (the agent was turned off): the next finish or the cap clears it
    c.turn_started("b", t0);
    c.on_write(t0);
    let quiet = Some(Duration::from_secs(60));
    assert_eq!(
        c.tick(t0 + Duration::from_secs(120), quiet, false),
        Action::Nothing
    );
    assert_eq!(
        c.tick(t0 + TURN_CAP + Duration::from_secs(1), quiet, false),
        Action::CommitUser
    );
    assert_eq!(c.take_expired(), 1);
}

#[test]
fn the_stat_is_taken_before_the_bytes_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.md");
    std::fs::write(&file, "one").unwrap();
    let (bytes, meta) = repo::read_after_stat(&file, || {
        std::fs::write(&file, "one and a write that lands mid-commit").unwrap();
    })
    .unwrap();
    assert_eq!(bytes, b"one and a write that lands mid-commit");
    assert_eq!(
        meta.len(),
        3,
        "the stat is the older one, so the file shows as changed"
    );
}

#[test]
fn homebrew_comes_before_the_usr_bin_stub() {
    let path = transport::Exec::new(crate::features::scope::Spawner::detached()).path();
    let dirs: Vec<_> = std::env::split_paths(&path).collect();
    let at = |d: &str| dirs.iter().position(|p| p == Path::new(d)).unwrap();
    assert!(at("/opt/homebrew/bin") < at("/usr/bin"));
    assert!(at("/usr/local/bin") < at("/usr/bin"));
}

#[cfg(unix)]
fn fake_git(script: &str) -> (tempfile::TempDir, transport::Exec) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("git");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let exec = transport::Exec::new(crate::features::scope::Spawner::detached())
        .with_path_prefix(vec![dir.path().to_path_buf()]);
    (dir, exec)
}

#[cfg(unix)]
#[test]
fn a_git_that_fails_for_another_reason_leaves_the_identity_to_gix_and_only_its_own_words_mean_none()
{
    let vault = vault();
    let repo = Repo::open(vault.path()).unwrap().unwrap();
    let (_d, broken) =
        fake_git("echo 'xcode-select: note: no developer tools were found' >&2; exit 1");
    let ids = repo.identities_using(&broken).unwrap();
    assert_eq!(ids.author.name, "Ada Writer", "gix answered");
    let (_d, says_none) =
        fake_git("echo 'fatal: no name was given and auto-detection is disabled' >&2; exit 128");
    assert!(matches!(
        repo.identities_using(&says_none),
        Err(Error::NoIdentity)
    ));
}

// ---- chat notes ---------------------------------------------------------------------------------

const CHAT_A: &str = "0b1c2d3e-0000-4000-8000-00000000000a";
const CHAT_B: &str = "0b1c2d3e-0000-4000-8000-00000000000b";

/// A chat note as the agent writes it: identity and title in the front matter, never the file name.
fn chat_note(root: &Path, rel: &str, id: &str, title: &str, text: &str) {
    write(
        root,
        rel,
        &format!("---\nwriter-chat-id: {id}\nwriter-chat-title: {title}\n---\n\n{text}\n"),
    );
}

fn head_message(root: &Path) -> Parsed {
    Repo::open(root).unwrap().unwrap().log(None, 1).unwrap()[0]
        .message
        .clone()
}

fn user_commit(root: &Path) -> Option<String> {
    commit_user(root, DEFAULT_TEMPLATE, &ctx(), "Studio", Lfs::OFF).unwrap()
}

#[test]
fn a_chat_note_alone_is_an_agent_chat_commit_titled_from_the_note() {
    let dir = history_vault();
    let root = dir.path();
    chat_note(
        root,
        ".writer/chats/2026-11-23-0900-zzz-file-name-0b1c2d3e.md",
        CHAT_A,
        "Plan the review",
        "hi",
    );
    assert!(user_commit(root).is_some());
    let m = head_message(root);
    assert_eq!((m.ty, m.scope), (Some(Type::Agent), Some(Scope::Chat)));
    // the title is the note's, not the file name's
    assert_eq!(m.subject, "Plan the review");
    assert_eq!(m.chat.as_deref(), Some(CHAT_A));
    assert_eq!(m.device.as_deref(), Some("Studio"));
    // a project's chats live in `.chats`
    chat_note(root, "Clients/.chats/x.md", CHAT_B, "Acme call", "hi");
    user_commit(root);
    assert_eq!(head_message(root).subject, "Acme call");
}

#[test]
fn a_user_commit_never_holds_chat_notes_and_several_chats_are_named_like_notes() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Plan.md", "# Plan\n");
    chat_note(root, ".writer/chats/a.md", CHAT_A, "First", "x");
    chat_note(root, ".writer/chats/b.md", CHAT_B, "Second", "x");
    chat_note(
        root,
        ".writer/chats/c.md",
        "0b1c2d3e-0000-4000-8000-00000000000c",
        "Third",
        "x",
    );
    assert!(user_commit(root).is_some());
    let repo = Repo::open(root).unwrap().unwrap();
    let log = repo.log(None, 3).unwrap();
    assert_eq!(log.len(), 3, "setup, the user's, the chats'");
    // newest first: the chats' own commit, then the user's with Plan alone
    assert_eq!(log[0].message.subject, "First, Second (+1)");
    assert_eq!(log[0].message.scope, Some(Scope::Chat));
    assert_eq!(log[1].message.ty, Some(Type::User));
    assert_eq!(log[1].message.subject, "Plan");
    let in_user = repo
        .tree_changes(Some(&log[2].id), Some(&log[1].id))
        .unwrap();
    assert_eq!(
        in_user.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        ["Plan.md"]
    );
    let raw = git_cli(root, &["show", "--format=%B", "--no-patch", &log[0].id]);
    if let Some(raw) = raw {
        assert_eq!(raw.matches("Writer-Chat:").count(), 3, "{raw}");
    }
}

#[test]
fn holding_chat_notes_back_leaves_them_for_the_turns_commit() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Plan.md", "# Plan\n");
    chat_note(root, ".writer/chats/a.md", CHAT_A, "First", "x");
    commit_user_with(
        root,
        DEFAULT_TEMPLATE,
        &ctx(),
        "Studio",
        Lfs::OFF,
        ChatNotes::Hold,
    )
    .unwrap();
    assert_eq!(head_message(root).ty, Some(Type::User));
    let repo = Repo::open(root).unwrap().unwrap();
    assert_eq!(
        repo.changes().unwrap().len(),
        1,
        "the note is still pending"
    );
}

fn chat_turn(chat: &str, files: &[&str]) -> AgentTurn {
    AgentTurn {
        chat_id: chat.into(),
        turn_id: Some("t1".into()),
        backend: "claude".into(),
        title: "Rewrite the guide".into(),
        models: Vec::new(),
        files: files.iter().map(|f| f.to_string()).collect(),
    }
}

#[test]
fn a_turns_commit_takes_its_own_chats_note_and_leaves_another_chats() {
    let dir = history_vault();
    let root = dir.path();
    write(root, "Guide.md", "v1\n");
    chat_note(
        root,
        ".writer/chats/a.md",
        CHAT_A,
        "Rewrite the guide",
        "turn",
    );
    chat_note(root, ".writer/chats/b.md", CHAT_B, "Other chat", "turn");
    let id = commit_agent(
        root,
        &chat_turn(CHAT_A, &["Guide.md"]),
        "Agent turn",
        "Studio",
        Lfs::OFF,
    )
    .unwrap()
    .unwrap();
    let repo = Repo::open(root).unwrap().unwrap();
    let m = head_message(root);
    assert_eq!((m.ty, m.scope), (Some(Type::Agent), Some(Scope::Add)));
    assert_eq!(m.subject, "Rewrite the guide");
    assert_eq!(m.chat.as_deref(), Some(CHAT_A));
    let log = repo.log(None, 2).unwrap();
    let parent = log[1].id.clone();
    let paths: Vec<String> = repo
        .tree_changes(Some(&parent), Some(&id))
        .unwrap()
        .into_iter()
        .map(|c| c.path)
        .collect();
    assert_eq!(
        paths,
        [".writer/chats/a.md", "Guide.md"],
        "one turn, one commit"
    );
    // the other chat's note waits for its own commit
    assert_eq!(repo.changes().unwrap().len(), 1);
    user_commit(root);
    assert_eq!(head_message(root).subject, "Other chat");
}

#[test]
fn a_turn_whose_files_are_unchanged_still_commits_its_chat_note_as_a_chat_commit() {
    let dir = history_vault();
    let root = dir.path();
    chat_note(root, ".writer/chats/a.md", CHAT_A, "Only talk", "x");
    commit_agent(
        root,
        &chat_turn(CHAT_A, &["Gone.md"]),
        "Agent turn",
        "Studio",
        Lfs::OFF,
    )
    .unwrap()
    .unwrap();
    let m = head_message(root);
    assert_eq!(
        (m.scope, m.subject.as_str()),
        (Some(Scope::Chat), "Only talk")
    );
    assert_eq!(m.turn.as_deref(), Some("t1"));
}

#[test]
fn a_failed_signature_requeues_the_turn_and_holds_commits_for_a_minute() {
    let t0 = Instant::now();
    let mut c = Cadence::new();
    c.on_write(t0);
    c.turn_started("c", t0);
    c.turn_ended("c", Some(chat_turn("c", &["a.md"])));
    let quiet = Some(Duration::from_secs(30));
    let Action::CommitAgent(t) = c.tick(t0, quiet, false) else {
        panic!("the turn's commit is due first")
    };
    c.signing_failed(t0, Some(t.clone()));
    // nothing for a minute, not on the next second
    assert_eq!(
        c.tick(t0 + Duration::from_secs(1), quiet, false),
        Action::Nothing
    );
    assert_eq!(
        c.tick(t0 + Duration::from_secs(59), quiet, false),
        Action::Nothing
    );
    // then the same turn first, and the user's changes after it
    assert_eq!(
        c.tick(t0 + SIGN_RETRY, quiet, false),
        Action::CommitAgent(t)
    );
    assert_eq!(c.tick(t0 + SIGN_RETRY, quiet, false), Action::CommitUser);
}
