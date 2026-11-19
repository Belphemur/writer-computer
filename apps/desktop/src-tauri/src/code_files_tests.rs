//! Integration tests for code files in the vault: tree listing, the agent-skills exception,
//! index and relocate behaviour. They only read the default policy (never change it).

use crate::commands::fs::{read_directory_impl, read_file_impl, write_file_impl};
use crate::state::WorkspaceState;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn touch(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn state_for(root: &Path) -> WorkspaceState {
    let state = WorkspaceState::default();
    *state.workspace_root.write() = Some(root.to_path_buf());
    state
}

fn names(root: &Path, rel: &str) -> Vec<String> {
    let state = state_for(root);
    read_directory_impl(&root.join(rel).to_string_lossy(), Some(&state))
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect()
}

fn vault() -> (TempDir, std::path::PathBuf) {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    (dir, root)
}

#[test]
fn tree_lists_code_files_and_hides_unknown_secret_and_generated_ones() {
    let (_d, root) = vault();
    for f in [
        "note.md",
        "run.py",
        "app.ts",
        "main.rs",
        "data.json",
        "Dockerfile",
        "Makefile",
        "x.sh",
        "logo.png",
        "logo.svg",
        "nb.ipynb",
        "blob.bin",
        ".env",
        "secrets.yaml",
        "key.pem",
    ] {
        touch(&root, f, "x");
    }
    touch(&root, "web/node_modules/a.js", "x");
    touch(&root, "web/dist/a.js", "x");
    touch(&root, "web/src/a.js", "x");
    touch(&root, "py/__pycache__/a.py", "x");
    touch(&root, ".obsidian/app.json", "{}");
    touch(&root, ".git/config", "x");
    let top = names(&root, "");
    for want in [
        "note.md",
        "run.py",
        "app.ts",
        "main.rs",
        "data.json",
        "Dockerfile",
        "Makefile",
        "x.sh",
        "logo.png",
        "logo.svg",
        "web",
        "py",
    ] {
        assert!(top.contains(&want.to_string()), "{want} in {top:?}");
    }
    for no in [
        "nb.ipynb",
        "blob.bin",
        ".env",
        "secrets.yaml",
        "key.pem",
        ".obsidian",
        ".git",
    ] {
        assert!(!top.contains(&no.to_string()), "{no} in {top:?}");
    }
    let web = names(&root, "web");
    assert_eq!(web, vec!["src".to_string()]);
    // `py` holds only a generated folder: visible as an empty folder, nothing inside.
    assert!(names(&root, "py").is_empty());
}

#[test]
fn images_are_listed_in_the_tree_but_not_in_hidden_or_ignored_folders() {
    let (_d, root) = vault();
    for f in [
        "attachments/shot.PNG",
        "attachments/photo.jpg",
        "attachments/scan.heic",
        "web/dist/built.png",
        "web/node_modules/dep/logo.png",
        ".obsidian/icon.png",
        ".git/x.png",
    ] {
        touch(&root, f, "x");
    }
    let mut listed = names(&root, "attachments");
    listed.sort();
    // heic is on the one image list, so it is listed (the viewer shows a fallback if undecodable)
    assert_eq!(listed, vec!["photo.jpg", "scan.heic", "shot.PNG"]);
    assert!(names(&root, "web").is_empty());
    let top = names(&root, "");
    assert!(!top.contains(&".obsidian".to_string()) && !top.contains(&".git".to_string()));
}

#[test]
fn image_entries_have_no_title() {
    let (_d, root) = vault();
    touch(&root, "a.png", "x");
    let state = state_for(&root);
    let entries = read_directory_impl(&root.to_string_lossy(), Some(&state)).unwrap();
    let image = entries.iter().find(|e| e.name == "a.png").unwrap();
    assert!(!image.is_dir && image.title.is_none());
}

#[test]
fn index_holds_image_rows_resolvable_by_name_without_indexing_their_content() {
    use crate::index::Index;
    let (_d, root) = vault();
    let data = TempDir::new().unwrap();
    touch(&root, "img/shot.png", "not really a png");
    touch(&root, "Note.md", "![[shot.png]]\n");
    let index = Index::open_for_cli(&root, Some(data.path())).unwrap();
    let page = index
        .query_files(&crate::index::FileFilter::default())
        .unwrap();
    let paths: Vec<String> = page.rows.into_iter().map(|r| r.path).collect();
    assert!(paths.contains(&"img/shot.png".to_string()), "{paths:?}");
    // the embed resolves to the image by file name
    let found = index.find_files_by_exact_name("shot.png", 10).unwrap();
    assert_eq!(found, vec!["img/shot.png".to_string()], "{found:?}");
}

#[test]
fn relocating_an_image_rewrites_the_embeds_and_links_to_it() {
    use crate::index::Index;
    let (_d, root) = vault();
    let data = TempDir::new().unwrap();
    touch(&root, "attachments/old.png", "x");
    touch(
        &root,
        "Note.md",
        "![[old.png]] and ![[attachments/old.png]] and [a](attachments/old.png)\n",
    );
    let index = Index::open_for_cli(&root, Some(data.path())).unwrap();
    let plan = crate::relocate::plan(
        &root,
        &index,
        "attachments/old.png",
        "attachments/new.png",
        true,
    )
    .unwrap();
    assert!(!plan.edits.is_empty());
    crate::relocate::apply(&plan).unwrap();
    assert!(root.join("attachments/new.png").exists());
    assert_eq!(
        fs::read_to_string(root.join("Note.md")).unwrap(),
        "![[new.png]] and ![[attachments/new.png]] and [a](attachments/new.png)\n"
    );
}

#[test]
fn code_files_have_no_title_and_notes_keep_theirs() {
    let (_d, root) = vault();
    touch(&root, "a.py", "---\ntitle: Nope\n---\n");
    touch(&root, "n.md", "---\ntitle: Yes\n---\n");
    let state = state_for(&root);
    let list = read_directory_impl(&root.to_string_lossy(), Some(&state)).unwrap();
    let title = |n: &str| list.iter().find(|e| e.name == n).unwrap().title.clone();
    assert_eq!(title("a.py"), None);
    assert_eq!(title("n.md").as_deref(), Some("Yes"));
}

#[test]
fn agent_skill_folders_are_visible_but_nothing_else_dotted() {
    let (_d, root) = vault();
    touch(&root, ".agents/skills/x/SKILL.md", "---\nname: x\n---\n");
    touch(&root, ".agents/skills/x/run.py", "print(1)\n");
    touch(&root, ".agents/skills/x/.env", "TOKEN=1");
    touch(&root, ".agents/skills/x/node_modules/a.js", "x");
    touch(&root, ".agents/notes.md", "x");
    touch(&root, ".claude/settings.json", "{}");
    touch(&root, ".claude/skills/y/run.sh", "echo\n");
    touch(&root, ".other/skills/z/run.py", "x");
    touch(&root, ".chats/c.json", "{}");
    touch(&root, ".writer/config", "x");
    touch(&root, ".obsidian/app.json", "{}");
    let top = names(&root, "");
    assert!(top.contains(&".agents".to_string()) && top.contains(&".claude".to_string()));
    for no in [".other", ".chats", ".writer", ".obsidian"] {
        assert!(!top.contains(&no.to_string()), "{no}");
    }
    assert_eq!(names(&root, ".agents"), vec!["skills".to_string()]);
    assert_eq!(names(&root, ".claude"), vec!["skills".to_string()]);
    assert_eq!(names(&root, ".agents/skills"), vec!["x".to_string()]);
    assert_eq!(
        names(&root, ".agents/skills/x"),
        vec!["run.py".to_string(), "SKILL.md".to_string()]
    );
}

#[test]
fn a_claude_folder_without_skills_is_not_shown() {
    let (_d, root) = vault();
    touch(&root, ".claude/settings.json", "{}");
    touch(&root, "a.md", "x");
    assert!(!names(&root, "").contains(&".claude".to_string()));
}

#[cfg(unix)]
#[test]
fn symlinked_skill_folder_and_file_are_not_followed() {
    let (_d, root) = vault();
    let outside = TempDir::new().unwrap();
    touch(outside.path(), "evil.py", "x");
    fs::create_dir_all(root.join(".agents/skills")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join(".agents/skills/linked")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("evil.py"), root.join("link.py")).unwrap();
    assert!(names(&root, ".agents/skills").is_empty());
    assert!(!names(&root, "").contains(&"link.py".to_string()));
}

#[test]
fn read_file_refuses_binary_and_huge_code_files_but_reads_text() {
    let (_d, root) = vault();
    touch(&root, "ok.py", "print('é')\n");
    fs::write(root.join("bin.py"), b"a\0b").unwrap();
    fs::write(root.join("bad.ts"), [0x61, 0xff, 0xfe]).unwrap();
    assert_eq!(
        read_file_impl(&root.join("ok.py").to_string_lossy())
            .unwrap()
            .content,
        "print('é')\n"
    );
    assert!(read_file_impl(&root.join("bin.py").to_string_lossy()).is_err());
    assert!(read_file_impl(&root.join("bad.ts").to_string_lossy()).is_err());
}

#[cfg(unix)]
#[test]
fn saving_keeps_the_executable_bit() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, root) = vault();
    let p = root.join(".agents/skills/x/run.sh");
    touch(&root, ".agents/skills/x/run.sh", "echo 1\n");
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    write_file_impl(&p.to_string_lossy(), "echo 2\n").unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "echo 2\n");
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn index_covers_code_and_agent_skills_but_not_hidden_or_generated() {
    use crate::index::Index;
    let (_d, root) = vault();
    let data = TempDir::new().unwrap();
    for f in [
        "a.md",
        "s/run.py",
        "web/dist/a.js",
        "web/node_modules/b.js",
        ".agents/skills/x/run.sh",
        ".agents/skills/x/SKILL.md",
        ".claude/settings.json",
        ".obsidian/app.json",
        ".env",
    ] {
        touch(&root, f, "x");
    }
    let index = Index::open_for_cli(&root, Some(data.path())).unwrap();
    let page = index
        .query_files(&crate::index::FileFilter::default())
        .unwrap();
    let mut paths: Vec<String> = page.rows.into_iter().map(|r| r.path).collect();
    paths.sort();
    assert_eq!(
        paths,
        vec![
            ".agents/skills/x/SKILL.md",
            ".agents/skills/x/run.sh",
            "a.md",
            "s/run.py"
        ]
    );
}

#[test]
fn relocating_a_code_file_leaves_links_alone() {
    use crate::index::Index;
    let (_d, root) = vault();
    let data = TempDir::new().unwrap();
    touch(&root, "tools/run.py", "print(1)\n");
    touch(
        &root,
        "Note.md",
        "see [[run.py]] and [[run]] and [x](tools/run.py)\n",
    );
    let index = Index::open_for_cli(&root, Some(data.path())).unwrap();
    let plan = crate::relocate::plan(&root, &index, "tools/run.py", "tools/go.py", true).unwrap();
    assert!(plan.edits.is_empty());
    crate::relocate::apply(&plan).unwrap();
    assert!(root.join("tools/go.py").exists() && !root.join("tools/run.py").exists());
    assert_eq!(
        fs::read_to_string(root.join("Note.md")).unwrap(),
        "see [[run.py]] and [[run]] and [x](tools/run.py)\n"
    );
}

// ------------------------------------------------------------------ feature off
// The feature `code-files` off is the notes-only policy (`Policy::notes_only`), run through the
// same seam as the default: each test compares what core lists with the feature on and off.

mod feature_off {
    use super::*;
    use crate::code_files::{self as cf, with_policy_for_test, Policy};

    fn off<T>(f: impl FnOnce() -> T) -> T {
        with_policy_for_test(Policy::notes_only(), f)
    }

    fn on<T>(f: impl FnOnce() -> T) -> T {
        with_policy_for_test(Policy::default(), f)
    }

    #[test]
    fn the_sidebar_lists_notes_and_images_only_without_the_skills_folders() {
        let (_d, root) = vault();
        for f in [
            "note.md",
            "tasks.base",
            "logo.png",
            "run.py",
            "Dockerfile",
            "build/inside.md",
            "dist/a.js",
            ".agents/skills/x/SKILL.md",
        ] {
            touch(&root, f, "x");
        }
        let listed_on = on(|| names(&root, ""));
        for n in [
            "note.md",
            "tasks.base",
            "logo.png",
            "run.py",
            "Dockerfile",
            ".agents",
        ] {
            assert!(listed_on.contains(&n.to_string()), "on: {n}");
        }
        // the ignored-folder list hides `build` with the feature on
        assert!(!listed_on.contains(&"build".to_string()));

        let listed_off = off(|| names(&root, ""));
        for n in ["note.md", "tasks.base", "logo.png", "build"] {
            assert!(listed_off.contains(&n.to_string()), "off: {n}");
        }
        for n in ["run.py", "Dockerfile", ".agents", "dist"] {
            assert!(!listed_off.contains(&n.to_string()), "off hides {n}");
        }
        // images are core: their own setting still hides them
        let no_images = Policy {
            show_images: false,
            ..Policy::notes_only()
        };
        let listed = with_policy_for_test(no_images, || names(&root, ""));
        assert!(!listed.contains(&"logo.png".to_string()));
    }

    #[test]
    fn opening_a_code_file_is_the_plain_read_not_the_guarded_one() {
        let (_d, root) = vault();
        let file = root.join("bin.py");
        fs::write(&file, b"abc\0def").unwrap();
        let path = file.to_string_lossy().to_string();
        assert!(on(|| read_file_impl(&path)).is_err());
        assert!(off(|| read_file_impl(&path)).is_ok());
        assert!(!off(|| cf::is_code_path(&file)));
    }

    #[test]
    fn quick_open_and_the_name_index_list_notes_bases_and_images_only() {
        off(|| {
            let sql = cf::listed_sql_predicate();
            assert!(sql.contains("'md'") && sql.contains("'base'") && sql.contains("'png'"));
            assert!(!sql.contains("'py'") && !sql.contains("'Dockerfile'"));
            assert!(cf::is_listed_name("a.md") && cf::is_listed_name("a.png"));
            assert!(!cf::is_listed_name("a.py") && !cf::is_listed_name("Makefile"));
            assert!(cf::is_listed_row("a.md", "md") && !cf::is_listed_row("a.py", "py"));
            assert!(!cf::is_listed_row("Dockerfile", "") && !cf::is_code_name("a.json"));
        });
        on(|| {
            assert!(cf::is_listed_name("a.py") && cf::is_listed_name("Makefile"));
            assert!(cf::listed_sql_predicate().contains("'Dockerfile'"));
        });
    }

    #[test]
    fn relocating_a_code_named_file_rewrites_its_links_when_it_is_not_code() {
        use crate::index::Index;
        let (_d, root) = vault();
        let data = TempDir::new().unwrap();
        touch(&root, "tools/run.py", "print(1)\n");
        touch(&root, "Note.md", "see [x](tools/run.py)\n");
        let index = Index::open_for_cli(&root, Some(data.path())).unwrap();
        let plan = |p: Policy| {
            with_policy_for_test(p, || {
                crate::relocate::plan(&root, &index, "tools/run.py", "tools/go.py", true).unwrap()
            })
        };
        assert!(plan(Policy::default()).edits.is_empty());
        assert!(!plan(Policy::notes_only()).edits.is_empty());
    }
}

// ------------------------------------------------------------------ symlinks
// Rule (`fs_entry`): a link is followed only to a target inside the vault; the index never
// follows links, so the real path is the one indexed.

#[cfg(unix)]
mod symlinks {
    use super::*;
    use std::os::unix::fs::symlink;

    /// The user's setup: `.agents/skills` and `.claude/skills` link to `LLM-Agents/skills`.
    fn linked_vault() -> (TempDir, std::path::PathBuf) {
        let (d, root) = vault();
        touch(&root, "LLM-Agents/skills/x/SKILL.md", "# x\n");
        touch(&root, "LLM-Agents/skills/x/run.py", "print(1)\n");
        for base in [".agents", ".claude"] {
            fs::create_dir_all(root.join(base)).unwrap();
            symlink("../LLM-Agents/skills", root.join(base).join("skills")).unwrap();
        }
        (d, root)
    }

    #[test]
    fn linked_skills_folder_is_listed_with_its_children() {
        let (_d, root) = linked_vault();
        let top = names(&root, "");
        assert!(top.contains(&".agents".to_string()) && top.contains(&".claude".to_string()));
        assert_eq!(names(&root, ".agents"), vec!["skills".to_string()]);
        assert_eq!(names(&root, ".agents/skills"), vec!["x".to_string()]);
        assert_eq!(
            names(&root, ".claude/skills/x"),
            vec!["run.py".to_string(), "SKILL.md".to_string()]
        );
        // the real folder is listed too (both paths are shown)
        assert_eq!(names(&root, "LLM-Agents/skills"), vec!["x".to_string()]);
        // the link carries its real vault-relative target
        let state = state_for(&root);
        let agents =
            read_directory_impl(&root.join(".agents").to_string_lossy(), Some(&state)).unwrap();
        assert_eq!(
            agents[0].symlink_target.as_deref(),
            Some("LLM-Agents/skills")
        );
        let real =
            read_directory_impl(&root.join("LLM-Agents").to_string_lossy(), Some(&state)).unwrap();
        assert_eq!(real[0].symlink_target, None);
    }

    #[test]
    fn agent_root_with_an_escaping_or_dangling_skills_link_stays_hidden() {
        let (_d, root) = vault();
        let outside = TempDir::new().unwrap();
        touch(outside.path(), "evil/SKILL.md", "x");
        fs::create_dir_all(root.join(".agents")).unwrap();
        fs::create_dir_all(root.join(".claude")).unwrap();
        symlink(outside.path(), root.join(".agents/skills")).unwrap();
        symlink("nowhere", root.join(".claude/skills")).unwrap();
        touch(&root, "a.md", "x");
        assert_eq!(names(&root, ""), vec!["a.md".to_string()]);
    }

    #[test]
    fn outside_dangling_and_hidden_targets_are_skipped_file_links_are_listed() {
        let (_d, root) = vault();
        let outside = TempDir::new().unwrap();
        touch(outside.path(), "out.md", "x");
        touch(&root, "real/a.md", "# a\n");
        touch(&root, ".obsidian/app.json", "{}");
        symlink(outside.path(), root.join("escape")).unwrap();
        symlink(outside.path().join("out.md"), root.join("escape.md")).unwrap();
        symlink("missing", root.join("dangling")).unwrap();
        symlink(".obsidian", root.join("hidden")).unwrap();
        symlink("real/a.md", root.join("alias.md")).unwrap();
        symlink("real", root.join("folder")).unwrap();
        assert_eq!(
            names(&root, ""),
            vec!["folder", "real", "alias.md"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert_eq!(names(&root, "folder"), vec!["a.md".to_string()]);
    }

    #[test]
    fn symlink_cycles_terminate() {
        let (_d, root) = vault();
        touch(&root, "a/note.txt", "x");
        fs::create_dir_all(root.join("b")).unwrap();
        symlink("..", root.join("a/up")).unwrap(); // ancestor: skipped outright
        symlink("../b", root.join("a/to-b")).unwrap(); // mutual cycle a <-> b
        symlink("../a", root.join("b/to-a")).unwrap();
        // the recursive visibility walk of the root must finish (and `a` holds a text file)
        let top = names(&root, "");
        assert_eq!(top, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(
            names(&root, "a"),
            vec!["to-b".to_string(), "note.txt".to_string()]
        );
        // a cycle with nothing else in it classifies as an empty folder, without recursing forever
        let (_d2, r2) = vault();
        fs::create_dir_all(r2.join("p")).unwrap();
        fs::create_dir_all(r2.join("q")).unwrap();
        symlink("../q", r2.join("p/l")).unwrap();
        symlink("../p", r2.join("q/l")).unwrap();
        assert_eq!(names(&r2, ""), vec!["p".to_string(), "q".to_string()]);
    }

    #[test]
    fn index_holds_the_real_path_only() {
        use crate::index::Index;
        let (_d, root) = linked_vault();
        let data = TempDir::new().unwrap();
        symlink("LLM-Agents/skills/x/SKILL.md", root.join("alias.md")).unwrap();
        let index = Index::open_for_cli(&root, Some(data.path())).unwrap();
        let mut paths: Vec<String> = index
            .query_files(&crate::index::FileFilter::default())
            .unwrap()
            .rows
            .into_iter()
            .map(|r| r.path)
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec!["LLM-Agents/skills/x/SKILL.md", "LLM-Agents/skills/x/run.py"]
        );
    }

    #[test]
    fn saving_through_a_link_keeps_the_link() {
        let (_d, root) = linked_vault();
        symlink("LLM-Agents/skills/x/SKILL.md", root.join("alias.md")).unwrap();
        // through a linked file
        write_file_impl(&root.join("alias.md").to_string_lossy(), "# one\n").unwrap();
        assert!(fs::symlink_metadata(root.join("alias.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(root.join("LLM-Agents/skills/x/SKILL.md")).unwrap(),
            "# one\n"
        );
        // through a linked folder
        let via = root.join(".agents/skills/x/run.py");
        write_file_impl(&via.to_string_lossy(), "print(2)\n").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("LLM-Agents/skills/x/run.py")).unwrap(),
            "print(2)\n"
        );
        assert!(fs::symlink_metadata(root.join(".agents/skills"))
            .unwrap()
            .file_type()
            .is_symlink());
        // no temp file left behind
        assert!(!names(&root, "LLM-Agents/skills/x")
            .iter()
            .any(|n| n.starts_with(".~")));
    }

    #[test]
    fn writes_through_an_escaping_link_are_refused_by_authorization() {
        let (_d, root) = vault();
        let outside = TempDir::new().unwrap();
        touch(outside.path(), "o.md", "x");
        symlink(outside.path().join("o.md"), root.join("l.md")).unwrap();
        symlink(outside.path(), root.join("dir")).unwrap();
        let state = state_for(&root);
        assert!(state.authorize_path(&root.join("l.md")).is_err());
        assert!(state.authorize_path(&root.join("dir/o.md")).is_err());
    }

    #[test]
    fn a_symlink_itself_is_not_renamed_but_its_content_is() {
        use crate::commands::fs::rename_entry_impl;
        let (_d, root) = linked_vault();
        let from = root.join(".agents/skills").to_string_lossy().into_owned();
        let to = root.join(".agents/renamed").to_string_lossy().into_owned();
        assert!(rename_entry_impl(&from, &to).is_err());
        assert!(fs::symlink_metadata(root.join(".agents/skills")).is_ok());
        // an entry inside the linked folder is real
        let from = root
            .join(".agents/skills/x/run.py")
            .to_string_lossy()
            .into_owned();
        let to = root
            .join(".agents/skills/x/go.py")
            .to_string_lossy()
            .into_owned();
        rename_entry_impl(&from, &to).unwrap();
        assert!(root.join("LLM-Agents/skills/x/go.py").exists());
    }

    #[test]
    fn deleting_a_link_permanently_keeps_the_target() {
        let (_d, root) = linked_vault();
        crate::commands::fs::delete_entry_with(
            &root.join(".claude/skills").to_string_lossy(),
            true,
        )
        .unwrap();
        assert!(!root.join(".claude/skills").exists());
        assert!(root.join("LLM-Agents/skills/x/SKILL.md").exists());
    }

    #[test]
    fn new_entries_in_a_linked_folder_keep_the_linked_path() {
        use crate::commands::fs::{create_sidebar_entry_impl, SidebarEntryKind};
        let (_d, root) = linked_vault();
        let parent = root.join(".agents/skills");
        let e = create_sidebar_entry_impl(&parent, &root, SidebarEntryKind::File).unwrap();
        assert_eq!(Path::new(&e.path), parent.join("Untitled.md"));
        assert!(root.join("LLM-Agents/skills/Untitled.md").exists());
    }
}
