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
        "web",
        "py",
    ] {
        assert!(top.contains(&want.to_string()), "{want} in {top:?}");
    }
    for no in [
        "logo.png",
        "logo.svg",
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
