//! Synthetic temp-dir vaults only.

use super::*;
use crate::cli::registry;
use std::collections::BTreeMap;
use std::fs;
use tempfile::TempDir;

fn vault() -> (TempDir, PathBuf) {
    let t = TempDir::new().unwrap();
    let root = t.path().canonicalize().unwrap();
    (t, root)
}

fn skill(name: &str) -> &'static BundledSkill {
    SKILLS.iter().find(|s| s.name == name).unwrap()
}

fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

/// Every file under `dir` as rel path -> bytes.
fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let rel = p
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn actions(r: &SyncReport) -> Vec<Action> {
    r.outcomes.iter().map(|o| o.action).collect()
}

fn assert_all_installed(root: &Path) {
    for base in SKILL_ROOTS {
        for s in SKILLS {
            for f in s.files {
                assert_eq!(
                    read(root, &format!("{base}/{}/{}", s.name, f.rel)),
                    render(s, f),
                    "{base}/{}/{}",
                    s.name,
                    f.rel
                );
            }
        }
    }
}

// ---------------------------------------------------------------- policy

#[test]
fn fresh_install_writes_both_roots() {
    let (_t, root) = vault();
    let r = sync(&root, Mode::Apply).unwrap();
    assert!(r.applied);
    assert_eq!(r.outcomes.len(), SKILL_ROOTS.len() * SKILLS.len());
    assert!(actions(&r).iter().all(|a| *a == Action::Installed), "{r:?}");
    assert_all_installed(&root);
    let md = read(&root, ".agents/skills/writer-cli/SKILL.md");
    let m = parse_marker(&md).unwrap();
    assert_eq!(m.version, Some(BUNDLE_VERSION));
    assert_eq!(
        m.hash.as_deref(),
        Some(skill_hash(skill("writer-cli")).as_str())
    );
    assert_eq!(m.files, vec!["references/commands.md"]);
    assert!(md.contains("Managed by Writer"));
    // No temp files left behind.
    for (rel, _) in snapshot(&root) {
        assert!(!rel.ends_with(".tmp"), "{rel}");
    }
}

#[test]
fn second_run_is_idempotent() {
    let (_t, root) = vault();
    sync(&root, Mode::Apply).unwrap();
    let before = snapshot(&root);
    let mtimes: Vec<_> = before
        .keys()
        .map(|k| fs::metadata(root.join(k)).unwrap().modified().unwrap())
        .collect();
    let r = sync(&root, Mode::Apply).unwrap();
    assert!(actions(&r).iter().all(|a| *a == Action::UpToDate), "{r:?}");
    assert!(!r.changed());
    assert!(!r.notable());
    assert_eq!(snapshot(&root), before);
    let after: Vec<_> = before
        .keys()
        .map(|k| fs::metadata(root.join(k)).unwrap().modified().unwrap())
        .collect();
    assert_eq!(mtimes, after, "an up-to-date file must not be rewritten");
}

#[test]
fn older_marker_is_upgraded_and_stale_files_removed() {
    let (_t, root) = vault();
    let dir = root.join(".agents/skills/writer-search");
    fs::create_dir_all(dir.join("references")).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: writer-search\ndescription: old\nwriter-managed: true\nwriter-skills-version: 0\nwriter-content-hash: abc\nwriter-files: \"references/gone.md\"\n---\nold body\n",
    )
    .unwrap();
    fs::write(dir.join("references/gone.md"), "old reference").unwrap();
    fs::write(dir.join("references/mine.md"), "user note").unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    let o = r
        .outcomes
        .iter()
        .find(|o| o.dir == ".agents/skills/writer-search")
        .unwrap();
    assert_eq!(o.action, Action::Updated);
    assert_all_installed(&root);
    assert!(!dir.join("references/gone.md").exists());
    assert_eq!(
        fs::read_to_string(dir.join("references/mine.md")).unwrap(),
        "user note"
    );
}

#[test]
fn edited_or_missing_managed_files_are_restored() {
    let (_t, root) = vault();
    sync(&root, Mode::Apply).unwrap();
    let md = root.join(".claude/skills/writer-bases/SKILL.md");
    fs::write(
        &md,
        format!("{}\nmy edit\n", fs::read_to_string(&md).unwrap()),
    )
    .unwrap();
    fs::write(
        root.join(".claude/skills/writer-bases/references/recipes.md"),
        "x",
    )
    .unwrap();
    fs::remove_file(root.join(".agents/skills/writer-cli/references/commands.md")).unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    let restored: Vec<_> = r
        .outcomes
        .iter()
        .filter(|o| o.action == Action::Restored)
        .map(|o| o.dir.as_str())
        .collect();
    assert_eq!(
        restored,
        vec![".agents/skills/writer-cli", ".claude/skills/writer-bases"]
    );
    assert_all_installed(&root);
}

#[test]
fn deleted_skill_md_with_leftover_references_is_reinstalled() {
    let (_t, root) = vault();
    sync(&root, Mode::Apply).unwrap();
    let dir = root.join(".agents/skills/writer-cli");
    fs::remove_file(dir.join("SKILL.md")).unwrap();
    fs::write(dir.join(".writer-skill-1-1.tmp"), "half").unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    assert_eq!(r.outcomes[0].action, Action::Installed, "{r:?}");
    assert_all_installed(&root);
}

#[test]
fn unmarked_skill_of_the_same_name_is_never_touched() {
    let (_t, root) = vault();
    let dir = root.join(".claude/skills/writer-cli");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: writer-cli\ndescription: mine\n---\nmine\n",
    )
    .unwrap();
    fs::write(dir.join("extra.txt"), "keep").unwrap();
    let before = snapshot(&dir);
    let r = sync(&root, Mode::Apply).unwrap();
    assert_eq!(snapshot(&dir), before);
    let o = r
        .outcomes
        .iter()
        .find(|o| o.dir == ".claude/skills/writer-cli")
        .unwrap();
    assert_eq!(o.action, Action::SkippedUserOwned);
    assert!(r.problems().count() == 1 && r.notable());
    // The other root and skills are unaffected.
    assert!(root.join(".agents/skills/writer-cli/SKILL.md").exists());
    assert!(root.join(".claude/skills/writer-search/SKILL.md").exists());
}

#[test]
fn unmarked_folder_without_skill_md_is_user_owned() {
    let (_t, root) = vault();
    let dir = root.join(".agents/skills/writer-search");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("notes.txt"), "mine").unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    let o = r
        .outcomes
        .iter()
        .find(|o| o.dir == ".agents/skills/writer-search")
        .unwrap();
    assert_eq!(o.action, Action::SkippedUserOwned);
    assert!(!dir.join("SKILL.md").exists());
}

#[test]
fn removing_the_marker_adopts_the_skill() {
    let (_t, root) = vault();
    sync(&root, Mode::Apply).unwrap();
    let md = root.join(".agents/skills/writer-cli/SKILL.md");
    let text = fs::read_to_string(&md).unwrap();
    let adopted: String = text
        .lines()
        .filter(|l| !l.starts_with("writer-managed:"))
        .map(|l| format!("{l}\n"))
        .collect();
    fs::write(&md, &adopted).unwrap();
    sync(&root, Mode::Apply).unwrap();
    assert_eq!(fs::read_to_string(&md).unwrap(), adopted);
}

#[test]
fn newer_installed_version_is_left_alone() {
    let (_t, root) = vault();
    let dir = root.join(".agents/skills/writer-cli");
    fs::create_dir_all(&dir).unwrap();
    let future = format!(
        "---\nname: writer-cli\ndescription: from the future\nwriter-managed: true\nwriter-skills-version: {}\n---\nnew\n",
        BUNDLE_VERSION + 1
    );
    fs::write(dir.join("SKILL.md"), &future).unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    assert_eq!(r.outcomes[0].action, Action::SkippedNewer);
    assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), future);
    assert!(!dir.join("references").exists());
}

#[test]
fn obsolete_managed_skills_are_removed_but_not_user_files() {
    let (_t, root) = vault();
    let base = root.join(".agents/skills");
    // Managed and obsolete, with a user file next to it.
    let old = base.join("writer-retired");
    fs::create_dir_all(old.join("references")).unwrap();
    fs::write(
        old.join("SKILL.md"),
        "---\nname: writer-retired\nwriter-managed: true\nwriter-skills-version: 1\nwriter-files: \"references/a.md\"\n---\nx\n",
    )
    .unwrap();
    fs::write(old.join("references/a.md"), "a").unwrap();
    fs::write(old.join("mine.txt"), "mine").unwrap();
    // Managed and obsolete, nothing else in it: the folder goes too.
    let clean = base.join("writer-retired-2");
    fs::create_dir_all(&clean).unwrap();
    fs::write(
        clean.join("SKILL.md"),
        "---\nname: x\nwriter-managed: true\n---\nx\n",
    )
    .unwrap();
    // A user's skill and a newer Writer's skill stay.
    let mine = base.join("my-skill");
    fs::create_dir_all(&mine).unwrap();
    fs::write(mine.join("SKILL.md"), "---\nname: my-skill\n---\n").unwrap();
    let newer = base.join("writer-future");
    fs::create_dir_all(&newer).unwrap();
    fs::write(
        newer.join("SKILL.md"),
        format!(
            "---\nname: f\nwriter-managed: true\nwriter-skills-version: {}\n---\n",
            BUNDLE_VERSION + 5
        ),
    )
    .unwrap();

    let r = sync(&root, Mode::Apply).unwrap();
    let removed: Vec<_> = r
        .outcomes
        .iter()
        .filter(|o| o.action == Action::Removed)
        .map(|o| o.dir.as_str())
        .collect();
    assert_eq!(
        removed,
        vec![
            ".agents/skills/writer-retired",
            ".agents/skills/writer-retired-2"
        ]
    );
    assert!(!old.join("SKILL.md").exists());
    assert!(!old.join("references").exists());
    assert_eq!(fs::read_to_string(old.join("mine.txt")).unwrap(), "mine");
    assert!(!clean.exists());
    assert!(mine.join("SKILL.md").exists());
    assert!(newer.join("SKILL.md").exists());
}

#[test]
fn check_mode_reports_without_writing() {
    let (_t, root) = vault();
    let r = sync(&root, Mode::Check).unwrap();
    assert!(!r.applied);
    assert!(actions(&r).iter().all(|a| *a == Action::Installed));
    assert!(snapshot(&root).is_empty());
    assert!(!root.join(".agents").exists());
}

#[test]
fn missing_root_is_an_error() {
    let (_t, root) = vault();
    assert!(sync(&root.join("nope"), Mode::Apply).is_err());
}

// ------------------------------------------------------------- confinement

#[cfg(unix)]
#[test]
fn symlink_out_of_the_vault_is_refused() {
    let (_t, root) = vault();
    let (_o, outside) = vault();
    std::os::unix::fs::symlink(&outside, root.join(".claude")).unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    assert!(snapshot(&outside).is_empty(), "wrote through the symlink");
    for o in r.outcomes.iter().filter(|o| o.dir.starts_with(".claude/")) {
        assert_eq!(o.action, Action::Error, "{o:?}");
        assert!(o.detail.contains("outside the vault"), "{o:?}");
    }
    assert!(root.join(".agents/skills/writer-cli/SKILL.md").exists());
}

#[cfg(unix)]
#[test]
fn symlinked_skill_folder_out_of_the_vault_is_refused() {
    let (_t, root) = vault();
    let (_o, outside) = vault();
    fs::create_dir_all(root.join(".agents/skills")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".agents/skills/writer-cli")).unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    assert!(snapshot(&outside).is_empty());
    assert_eq!(r.outcomes[0].action, Action::Error);
    assert_eq!(r.outcomes[1].action, Action::Installed);
}

#[cfg(unix)]
#[test]
fn symlink_inside_the_vault_is_followed() {
    let (_t, root) = vault();
    fs::create_dir_all(root.join(".agents/skills")).unwrap();
    std::os::unix::fs::symlink(".agents", root.join(".claude")).unwrap();
    let r = sync(&root, Mode::Apply).unwrap();
    assert!(r.problems().next().is_none(), "{r:?}");
    assert_all_installed(&root);
}

#[test]
fn obsidian_and_git_are_never_touched() {
    let (_t, root) = vault();
    fs::create_dir_all(root.join(".obsidian/plugins")).unwrap();
    fs::write(root.join(".obsidian/app.json"), "{}").unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    fs::write(root.join(".gitignore"), "node_modules\n").unwrap();
    fs::write(root.join("Note.md"), "# Note\n").unwrap();
    let before_obsidian = snapshot(&root.join(".obsidian"));
    let before_git = snapshot(&root.join(".git"));
    sync(&root, Mode::Apply).unwrap();
    sync(&root, Mode::Apply).unwrap();
    assert_eq!(snapshot(&root.join(".obsidian")), before_obsidian);
    assert_eq!(snapshot(&root.join(".git")), before_git);
    assert_eq!(read(&root, ".gitignore"), "node_modules\n");
    assert_eq!(read(&root, "Note.md"), "# Note\n");
    // Only the two skill roots were added at the top level.
    let mut top: Vec<String> = entry_names(&root).unwrap();
    top.sort();
    assert_eq!(
        top,
        vec![
            ".agents",
            ".claude",
            ".git",
            ".gitignore",
            ".obsidian",
            "Note.md"
        ]
    );
}

// ------------------------------------------------------------- concurrency

#[test]
fn concurrent_syncs_converge() {
    let (_t, root) = vault();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let root = root.clone();
            std::thread::spawn(move || sync(&root, Mode::Apply).unwrap())
        })
        .collect();
    for h in handles {
        let r = h.join().unwrap();
        assert!(r.problems().next().is_none(), "{r:?}");
    }
    assert_all_installed(&root);
    assert!(sync(&root, Mode::Apply)
        .unwrap()
        .outcomes
        .iter()
        .all(|o| o.action == Action::UpToDate));
}

/// Several processes cannot share `SYNC_LOCK`; without it the atomic writes
/// must still leave only complete, correct files.
#[test]
fn unlocked_concurrent_writers_leave_complete_files() {
    let (_t, root) = vault();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let root = root.clone();
            std::thread::spawn(move || {
                let v = Vault {
                    root,
                    mode: Mode::Apply,
                };
                for _ in 0..20 {
                    for base in SKILL_ROOTS {
                        for s in SKILLS {
                            let o = sync_skill(&v, base, s);
                            assert_ne!(o.action, Action::Error, "{o:?}");
                            assert_ne!(o.action, Action::SkippedUserOwned, "{o:?}");
                        }
                    }
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_all_installed(&root);
    for (rel, _) in snapshot(&root) {
        assert!(!rel.ends_with(".tmp"), "{rel}");
    }
}

// ----------------------------------------------------------- bundle checks

#[test]
fn render_and_marker_roundtrip() {
    for s in SKILLS {
        let f = &s.files[0];
        assert_eq!(f.rel, "SKILL.md");
        let text = render(s, f);
        let m = parse_marker(&text).expect("marker");
        assert_eq!(m.version, Some(BUNDLE_VERSION));
        assert_eq!(m.hash, Some(skill_hash(s)));
        assert_eq!(m.files.len(), s.files.len() - 1);
    }
    assert!(parse_marker("no frontmatter").is_none());
    assert!(parse_marker("---\nname: x\n---\n").is_none());
    assert!(
        parse_marker("---\nwriter-managed: true\n").is_none(),
        "unclosed frontmatter"
    );
    assert!(parse_marker("---\nwriter-managed: false\n---\n").is_none());
}

#[test]
fn bundled_skills_have_valid_frontmatter() {
    for s in SKILLS {
        let src = s.files[0].content;
        let rest = src.strip_prefix("---\n").expect("frontmatter");
        let end = rest.find("\n---\n").expect("closing fence");
        let front = &rest[..end];
        let get = |k: &str| {
            front
                .lines()
                .find_map(|l| l.strip_prefix(&format!("{k}: ")))
                .unwrap_or_else(|| panic!("{} lacks {k}", s.name))
        };
        assert_eq!(get("name"), s.name);
        let d = get("description");
        assert!(
            d.len() > 80 && d.len() <= 1024,
            "{}: description length {}",
            s.name,
            d.len()
        );
        assert!(
            !front.contains(KEY_MANAGED),
            "markers are added at install time"
        );
        assert!(!src.contains('\r'));
    }
}

fn collect(dir: &Path, base: &Path, out: &mut BTreeSet<String>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, base, out);
        } else {
            out.insert(
                p.strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

#[test]
fn bundle_matches_skills_directory() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("skills");
    let mut on_disk = BTreeSet::new();
    collect(&dir, &dir, &mut on_disk);
    let bundled: BTreeSet<String> = SKILLS
        .iter()
        .flat_map(|s| s.files.iter().map(move |f| format!("{}/{}", s.name, f.rel)))
        .collect();
    assert_eq!(
        on_disk, bundled,
        "src-tauri/skills and managed_skills/bundle.rs disagree"
    );
    for s in SKILLS {
        assert_eq!(s.files[0].rel, "SKILL.md");
    }
}

#[test]
fn bundle_fingerprint_is_current() {
    assert_eq!(
        bundle_fingerprint(),
        bundle::BUNDLE_FINGERPRINT,
        "bundled skill text changed: bump BUNDLE_VERSION in managed_skills/bundle.rs and set BUNDLE_FINGERPRINT to the left value"
    );
}

// ------------------------------------------- docs cannot drift from the CLI

/// Text inside code: fenced lines (cut at ` # `) and inline `code spans`.
fn code_segments(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            out.push(line.split(" # ").next().unwrap().trim().to_string());
        } else {
            for (i, part) in line.split('`').enumerate() {
                if i % 2 == 1 {
                    out.push(part.to_string());
                }
            }
        }
    }
    out
}

fn param_name(tok: &str) -> Option<&str> {
    let tok = tok.trim_start_matches('[');
    let (n, _) = tok.split_once('=')?;
    (!n.is_empty()
        && n.chars()
            .all(|c| c.is_ascii_lowercase() || c == '-' || c == '_'))
    .then_some(n)
}

#[test]
fn documented_commands_and_parameters_exist_in_the_registry() {
    let mut checked = 0;
    for s in SKILLS {
        for f in s.files {
            for seg in code_segments(f.content) {
                let toks: Vec<&str> = seg.split_whitespace().collect();
                let Some(at) = toks.iter().position(|t| *t == "writer") else {
                    continue;
                };
                let mut i = at + 1;
                while i < toks.len() && (toks[i].starts_with("vault=") || toks[i].starts_with('['))
                {
                    i += 1;
                }
                let Some(cmd) = toks.get(i) else { continue };
                if cmd.starts_with('<') {
                    continue; // the grammar line, `writer <command> ...`
                }
                let spec = registry::find(cmd).unwrap_or_else(|| {
                    panic!(
                        "{}/{} documents `writer {cmd}`, which is not in cli/registry.rs",
                        s.name, f.rel
                    )
                });
                checked += 1;
                for t in &toks[i + 1..] {
                    if let Some(n) = param_name(t) {
                        assert!(
                            spec.params.iter().any(|p| p.name == n),
                            "{}/{}: `{cmd}` has no parameter {n}= (in `{seg}`)",
                            s.name,
                            f.rel
                        );
                    }
                }
            }
        }
    }
    assert!(
        checked > 25,
        "the scan found only {checked} command examples"
    );
}

#[test]
fn command_reference_lists_every_registry_command_exactly() {
    let doc = skill("writer-cli")
        .files
        .iter()
        .find(|f| f.rel == "references/commands.md")
        .unwrap()
        .content;
    let mut listed: BTreeSet<String> = BTreeSet::new();
    for line in doc.lines().filter(|l| l.starts_with("- `")) {
        let name = line[3..].split('`').next().unwrap().to_string();
        listed.insert(name.clone());
        let spec = registry::find(&name)
            .unwrap_or_else(|| panic!("commands.md lists `{name}`, which is not in the registry"));
        let (params_part, flags_part) = match line.split_once("Flags:") {
            Some((a, b)) => (a, b),
            None => (line, ""),
        };
        let params_part = params_part.split("Params:").nth(1).unwrap_or("");
        for p in spec.params {
            let token = format!("`{}=`", p.name);
            let pos = params_part
                .find(&token)
                .unwrap_or_else(|| panic!("commands.md: `{name}` does not list {token}"));
            let after = &params_part[pos + token.len()..];
            assert_eq!(
                after.starts_with(" (required"),
                p.required,
                "commands.md: `{name}` {token} required mismatch"
            );
        }
        for (f, _) in spec.flags {
            assert!(
                flags_part.contains(&format!("`{f}`")),
                "commands.md: `{name}` does not list flag `{f}`"
            );
        }
        // And nothing documented that the command does not take.
        for tok in params_part.split('`').skip(1).step_by(2) {
            if let Some(n) = tok.strip_suffix('=') {
                assert!(
                    spec.params.iter().any(|p| p.name == n),
                    "commands.md: `{name}` documents {n}= which it does not take"
                );
            }
        }
        for tok in flags_part.split('`').skip(1).step_by(2) {
            assert!(
                spec.flags.iter().any(|(f, _)| *f == tok),
                "commands.md: `{name}` documents flag `{tok}` which it does not take"
            );
        }
    }
    let all: BTreeSet<String> = registry::COMMANDS
        .iter()
        .map(|c| c.name.to_string())
        .collect();
    assert_eq!(
        listed, all,
        "commands.md and cli/registry.rs list different commands"
    );
}

#[test]
fn base_yaml_examples_parse() {
    let mut n = 0;
    for f in skill("writer-bases").files {
        let mut block: Option<String> = None;
        for line in f.content.lines() {
            if line.trim_start().starts_with("```") {
                match block.take() {
                    Some(yaml) => {
                        crate::bases::document::Document::parse(&yaml)
                            .unwrap_or_else(|e| panic!("{}: {e}\n{yaml}", f.rel));
                        n += 1;
                    }
                    None if line.trim() == "```yaml" => block = Some(String::new()),
                    None => {}
                }
            } else if let Some(b) = block.as_mut() {
                b.push_str(line);
                b.push('\n');
            }
        }
    }
    assert!(n >= 5, "found {n} yaml examples");
}
