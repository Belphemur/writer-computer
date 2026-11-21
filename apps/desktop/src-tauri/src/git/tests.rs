//! The engine's contract: messages, the ignore block, commits and status in temporary repositories
//! (never the user's git config or vault), the identity against the real `git`, and the source scan.

use super::message::*;
use super::repo::ISOLATED;
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
    let status = status(root, &IdentityCache::default(), true).unwrap();
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
    let id = commit_user(root, DEFAULT_TEMPLATE, &ctx(), "d").unwrap();
    assert!(id.is_some());
    let log = repo.log(None, 5).unwrap();
    assert_eq!(log[0].message.scope, Some(Scope::Edit), "mixed kinds");
    assert!(repo.changes().unwrap().is_empty());
    assert_eq!(
        commit_user(root, DEFAULT_TEMPLATE, &ctx(), "d").unwrap(),
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
    commit_user(root, "{{notes}}", &ctx(), "d").unwrap();
    write(root, "b.md", "2");
    commit_user(root, "{{notes}}", &ctx(), "d").unwrap();
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
        backend: "claude".into(),
        title: "Tidy theirs".into(),
        models: vec!["claude-opus-5-5".into()],
        files: vec!["theirs.md".into()],
    };
    assert!(commit_agent(root, &turn, "Agent turn", "d")
        .unwrap()
        .is_some());
    let repo = Repo::open(root).unwrap().unwrap();
    assert_eq!(repo.changes().unwrap(), vec![edit("mine.md")]);
    let head = &repo.log(None, 1).unwrap()[0];
    assert_eq!(head.message.ty, Some(Type::Agent));
    assert_eq!(head.message.subject, "Tidy theirs");
    assert_eq!(head.message.chat.as_deref(), Some("chat-1"));
    assert_eq!(head.message.models, vec!["claude-opus-5-5"]);
    // a turn whose files did not change commits nothing
    assert!(commit_agent(root, &turn, "x", "d").unwrap().is_none());
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
        status(dir.path(), &IdentityCache::default(), true)
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
        !status(&inner, &IdentityCache::default(), true)
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
    c.turn_started();
    assert_eq!(
        c.tick(at(t0, 600), MIN, false),
        Action::Nothing,
        "turn running"
    );
    c.turn_ended(Some(turn(&["a.md"])));
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
    c.turn_started();
    c.turn_ended(None);
    assert_eq!(c.tick(at(t0, 60), MIN, false), Action::CommitUser);
}

// ---- the dependency stays behind this module ------------------------------------------------------

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
