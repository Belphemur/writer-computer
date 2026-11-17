use super::*;
use std::fs;
use tempfile::TempDir;

/// A fixture vault (canonical root) and a fake home, both temp: the real home is never read.
struct Fixture {
    _vault: TempDir,
    _home: TempDir,
    root: PathBuf,
    home: PathBuf,
}

fn fixture() -> Fixture {
    let vault = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    let home_path = home.path().canonicalize().unwrap();
    fs::create_dir_all(root.join("Projects/P")).unwrap();
    Fixture {
        _vault: vault,
        _home: home,
        root,
        home: home_path,
    }
}

fn write(p: &Path, text: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

impl Fixture {
    /// Claude Code's own memory folder for `abs`, in the fake home.
    fn claude_memory(&self, abs: &Path) -> PathBuf {
        self.home
            .join(".claude/projects")
            .join(claude_project_key(abs))
            .join("memory")
    }
}

#[test]
fn the_folders_are_built_from_the_root_and_the_project() {
    let f = fixture();
    assert_eq!(
        memory_dir(&f.root, None).unwrap(),
        f.root.join(".writer/memory")
    );
    assert_eq!(
        memory_dir(&f.root, Some("")).unwrap(),
        f.root.join(".writer/memory")
    );
    assert_eq!(
        memory_dir(&f.root, Some("Projects/P")).unwrap(),
        f.root.join("Projects/P/.memory")
    );
    // not created by the pure builder
    assert!(!f.root.join(".writer").exists());
    let made = prepare_dir(&f.root, Some("Projects/P")).unwrap();
    assert!(made.is_dir());
}

#[test]
fn a_folder_outside_the_vault_is_refused() {
    let f = fixture();
    let outside = tempfile::tempdir().unwrap();
    for bad in ["../x", "Projects/../../x", "/etc", ".obsidian", ".git/x"] {
        assert!(memory_dir(&f.root, Some(bad)).is_err(), "{bad}");
    }
    assert!(memory_dir(&f.root, Some(outside.path().to_str().unwrap())).is_err());
    // the vault root itself is not a project
    assert!(memory_dir(&f.root, Some(f.root.to_str().unwrap())).is_err());
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_vault_is_refused() {
    use std::os::unix::fs::symlink;
    let f = fixture();
    let outside = tempfile::tempdir().unwrap();
    // `.writer` itself is a link out
    symlink(outside.path(), f.root.join(".writer")).unwrap();
    assert!(memory_dir(&f.root, None).is_err());
    assert!(prepare_dir(&f.root, None).is_err());
    fs::remove_file(f.root.join(".writer")).unwrap();
    // a project that is a link out
    symlink(outside.path(), f.root.join("Projects/Out")).unwrap();
    assert!(memory_dir(&f.root, Some("Projects/Out")).is_err());
    // a `.memory` that is a link out
    symlink(outside.path(), f.root.join("Projects/P/.memory")).unwrap();
    assert!(memory_dir(&f.root, Some("Projects/P")).is_err());
    assert!(prepare_dir(&f.root, Some("Projects/P")).is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[test]
fn memory_paths_are_recognised_by_the_changes_card() {
    for yes in [
        ".writer/memory/MEMORY.md",
        ".writer/memory/user-cat.md",
        "Projects/P/.memory/MEMORY.md",
        ".memory/x.md",
    ] {
        assert!(is_memory_rel(yes), "{yes}");
    }
    for no in [
        "Notes/a.md",
        ".writer/property-types.json",
        ".writer/memory.md",
        "memory/MEMORY.md",
        "Notes/.memory.md",
        ".memory",
    ] {
        assert!(!is_memory_rel(no), "{no}");
    }
}

#[test]
fn claude_project_keys_replace_every_non_alphanumeric_character() {
    // the observed example of the spec: /private/tmp/... -> -private-tmp-...-memtest2
    assert_eq!(
        claude_project_key(Path::new(
            "/private/tmp/claude-502/-Users-antoinea-repos-writer-computer/memtest2"
        )),
        "-private-tmp-claude-502--Users-antoinea-repos-writer-computer-memtest2"
    );
    assert_eq!(
        claude_project_key(Path::new("/Users/a b/my_vault.v2/Projects/P")),
        "-Users-a-b-my-vault-v2-Projects-P"
    );
}

#[test]
fn list_delete_and_forget_all_stay_in_the_memory_folders() {
    let f = fixture();
    let vault_mem = f.root.join(".writer/memory");
    let project_mem = f.root.join("Projects/P/.memory");
    write(&vault_mem.join("MEMORY.md"), "- [cat](user-cat.md)");
    write(&vault_mem.join("user-cat.md"), "Miso");
    write(&project_mem.join("MEMORY.md"), "- p");
    write(&f.root.join("Notes/a.md"), "note");
    write(&f.root.join("Projects/P/project.md"), "p");

    let overview = list(&f.root, Some("Projects/P")).unwrap();
    let names = |m: &MemoryFolder| m.files.iter().map(|x| x.name.clone()).collect::<Vec<_>>();
    assert_eq!(names(&overview.vault), ["MEMORY.md", "user-cat.md"]);
    assert_eq!(names(overview.project.as_ref().unwrap()), ["MEMORY.md"]);
    assert!(overview.vault.exists);
    assert_eq!(list(&f.root, None).unwrap().project, None);
    // a folder that is not there yet is an empty list, and nothing is created
    let fresh = fixture();
    let o = list(&fresh.root, None).unwrap();
    assert!(!o.vault.exists && o.vault.files.is_empty());
    assert!(!fresh.root.join(".writer").exists());

    // names, never paths
    for bad in ["../Notes/a.md", "a/b", "", "..", "."] {
        assert!(
            delete(&f.root, MemoryScope::Vault, None, bad).is_err(),
            "{bad:?}"
        );
    }
    assert!(delete(&f.root, MemoryScope::Project, None, "MEMORY.md").is_err());
    delete(&f.root, MemoryScope::Vault, None, "user-cat.md").unwrap();
    assert!(!vault_mem.join("user-cat.md").exists());
    assert!(vault_mem.join("MEMORY.md").exists());
    assert!(delete(&f.root, MemoryScope::Vault, None, "user-cat.md").is_err());

    // forget all: only the chosen folder, the folder itself stays
    assert_eq!(
        forget_all(&f.root, MemoryScope::Project, Some("Projects/P")).unwrap(),
        1
    );
    assert!(project_mem.is_dir() && fs::read_dir(&project_mem).unwrap().count() == 0);
    assert!(vault_mem.join("MEMORY.md").exists());
    assert_eq!(forget_all(&f.root, MemoryScope::Vault, None).unwrap(), 1);
    assert_eq!(
        fs::read_to_string(f.root.join("Notes/a.md")).unwrap(),
        "note"
    );
    assert!(f.root.join("Projects/P/project.md").exists());
    // nothing to forget in a folder that does not exist
    assert_eq!(
        forget_all(&fresh.root, MemoryScope::Vault, None).unwrap(),
        0
    );
}

#[cfg(unix)]
#[test]
fn a_link_in_the_memory_folder_is_removed_never_followed() {
    use std::os::unix::fs::symlink;
    let f = fixture();
    let outside = tempfile::tempdir().unwrap();
    write(&outside.path().join("keep.md"), "keep");
    let mem = f.root.join(".writer/memory");
    fs::create_dir_all(&mem).unwrap();
    symlink(outside.path(), mem.join("dir-link")).unwrap();
    symlink(outside.path().join("keep.md"), mem.join("file-link.md")).unwrap();
    // links are not listed
    assert!(list(&f.root, None).unwrap().vault.files.is_empty());
    delete(&f.root, MemoryScope::Vault, None, "file-link.md").unwrap();
    assert_eq!(forget_all(&f.root, MemoryScope::Vault, None).unwrap(), 1);
    assert_eq!(
        fs::read_to_string(outside.path().join("keep.md")).unwrap(),
        "keep"
    );
}

#[test]
fn import_copies_only_the_matching_keys_and_never_overwrites() {
    let f = fixture();
    let project = f.root.join("Projects/P");
    // Claude's memory for the vault and the project, another vault's, and a sibling that must
    // never be read
    let other = Path::new("/somewhere/else");
    write(&f.claude_memory(&f.root).join("MEMORY.md"), "vault index");
    write(&f.claude_memory(&f.root).join("user-cat.md"), "Miso");
    write(
        &f.claude_memory(&project).join("MEMORY.md"),
        "project index",
    );
    write(&f.claude_memory(other).join("MEMORY.md"), "not ours");
    let key_dir = f
        .home
        .join(".claude/projects")
        .join(claude_project_key(&f.root));
    write(&key_dir.join("session.jsonl"), "transcript");
    write(&key_dir.join("memory/sub/nested.md"), "nested");
    write(&f.home.join(".claude/CLAUDE.md"), "secret instructions");
    // the target already has a different MEMORY.md
    write(&f.root.join(".writer/memory/MEMORY.md"), "mine");

    let r = import_claude(&f.root, &f.home, &["Projects/P".to_string()]).unwrap();
    assert_eq!(
        r,
        ImportReport {
            folders_found: 2,
            imported: 3,
            skipped: 0
        }
    );
    let vault = f.root.join(".writer/memory");
    assert_eq!(fs::read_to_string(vault.join("MEMORY.md")).unwrap(), "mine");
    assert_eq!(
        fs::read_to_string(vault.join("MEMORY-imported.md")).unwrap(),
        "vault index"
    );
    assert_eq!(
        fs::read_to_string(vault.join("user-cat.md")).unwrap(),
        "Miso"
    );
    assert_eq!(
        fs::read_to_string(project.join(".memory/MEMORY.md")).unwrap(),
        "project index"
    );
    // nothing else was copied: no transcript, no nested folder, no other vault's memory
    let mut all: Vec<_> = fs::read_dir(&vault)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    all.sort();
    assert_eq!(all, ["MEMORY-imported.md", "MEMORY.md", "user-cat.md"]);
    // nothing deleted or changed at the source
    assert_eq!(
        fs::read_to_string(f.claude_memory(&f.root).join("MEMORY.md")).unwrap(),
        "vault index"
    );
    assert!(f.home.join(".claude/CLAUDE.md").exists());
}

#[test]
fn a_second_import_changes_nothing() {
    let f = fixture();
    write(&f.claude_memory(&f.root).join("MEMORY.md"), "vault index");
    write(&f.claude_memory(&f.root).join("user-cat.md"), "Miso");
    write(&f.root.join(".writer/memory/MEMORY.md"), "mine");
    let first = import_claude(&f.root, &f.home, &[]).unwrap();
    assert_eq!(first.imported, 2);
    let snapshot = |dir: &Path| {
        let mut v: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                (p.clone(), fs::read_to_string(p).unwrap())
            })
            .collect();
        v.sort();
        v
    };
    let before = snapshot(&f.root.join(".writer/memory"));
    let second = import_claude(&f.root, &f.home, &[]).unwrap();
    assert_eq!(second.imported, 0);
    assert_eq!(second.skipped, 2);
    assert_eq!(snapshot(&f.root.join(".writer/memory")), before);
    // a source that changed since is imported next to the first copy, not over it
    write(
        &f.claude_memory(&f.root).join("user-cat.md"),
        "Miso, 3 years",
    );
    let third = import_claude(&f.root, &f.home, &[]).unwrap();
    assert_eq!(third.imported, 1);
    let vault = f.root.join(".writer/memory");
    assert_eq!(
        fs::read_to_string(vault.join("user-cat.md")).unwrap(),
        "Miso"
    );
    assert_eq!(
        fs::read_to_string(vault.join("user-cat-imported.md")).unwrap(),
        "Miso, 3 years"
    );
}

#[test]
fn import_without_claude_memory_does_nothing_and_creates_nothing() {
    let f = fixture();
    let r = import_claude(&f.root, &f.home, &["Projects/P".to_string()]).unwrap();
    assert_eq!(r, ImportReport::default());
    assert!(!f.root.join(".writer").exists());
    assert!(!f.root.join("Projects/P/.memory").exists());
}

#[test]
fn import_skips_large_and_non_text_files_and_refuses_a_project_outside_the_vault() {
    let f = fixture();
    let src = f.claude_memory(&f.root);
    write(
        &src.join("big.md"),
        &"x".repeat(MAX_IMPORT_BYTES as usize + 1),
    );
    fs::write(src.join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
    write(&src.join("ok.md"), "ok");
    let r = import_claude(&f.root, &f.home, &[]).unwrap();
    assert_eq!((r.imported, r.skipped), (1, 2));
    assert!(import_claude(&f.root, &f.home, &["../x".to_string()]).is_err());
}

#[test]
fn candidate_names_keep_the_extension() {
    assert_eq!(candidate("a.md", 0), "a.md");
    assert_eq!(candidate("a.md", 1), "a-imported.md");
    assert_eq!(candidate("a.md", 2), "a-imported-2.md");
    assert_eq!(candidate("noext", 1), "noext-imported");
    assert_eq!(candidate(".hidden", 1), ".hidden-imported");
}

#[test]
fn the_vault_index_is_named_relative_to_the_chat_cwd() {
    let root = Path::new("/very/long/vault");
    assert_eq!(vault_index_from(root, root), ".writer/memory/MEMORY.md");
    assert_eq!(
        vault_index_from(root, &root.join("Projects/P")),
        "../../.writer/memory/MEMORY.md"
    );
    // outside the vault (cannot happen for a confined project): absolute, never a `..` guess
    assert_eq!(
        vault_index_from(root, Path::new("/elsewhere")),
        "/very/long/vault/.writer/memory/MEMORY.md"
    );
}
