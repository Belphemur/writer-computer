use super::*;
use crate::index::Index;
use std::fs;
use tempfile::TempDir;

fn vault(files: &[(&str, &str)]) -> (TempDir, TempDir, PathBuf, Index) {
    let v = TempDir::new().unwrap();
    let d = TempDir::new().unwrap();
    let root = v.path().canonicalize().unwrap();
    for (p, c) in files {
        let abs = root.join(p);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, c).unwrap();
    }
    let index = Index::open_for_cli(&root, Some(d.path())).unwrap();
    (v, d, root, index)
}

#[test]
fn file_name_validation() {
    for ok in [
        "Note",
        "Note.md",
        "my note 2",
        "日本語.md",
        "a-b_c.d",
        "v1.2",
    ] {
        assert!(validate_file_name(ok).is_ok(), "{ok}");
    }
    for bad in [
        "", " ", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a|b", "a#b", "a^b", "a[b",
        "a]b", ".hidden", "..", "x.", " x", "x ", "CON", "nul.md", "a\u{0}b", "a\nb",
    ] {
        assert!(validate_file_name(bad).is_err(), "{bad:?}");
    }
    assert!(validate_file_name(&"a".repeat(256)).is_err());
}

#[test]
fn plan_lists_referrers_without_writing_and_apply_matches() {
    let (_v, _d, root, index) = vault(&[
        ("a/Old.md", "# Old\n"),
        ("Home.md", "[[Old]] [[a/Old|x]]\n"),
        ("Other.md", "[[Home]]\n"),
        ("q.base", "x: link(\"Old\")\n"),
    ]);
    let p = plan(&root, &index, "a/Old.md", "a/New.md", true).unwrap();
    assert_eq!(p.edits.len(), 2);
    assert_eq!(p.links(), 3);
    assert!(root.join("a/Old.md").exists());
    apply(&p).unwrap();
    assert!(root.join("a/New.md").exists() && !root.join("a/Old.md").exists());
    assert_eq!(
        fs::read_to_string(root.join("Home.md")).unwrap(),
        "[[New]] [[a/New|x]]\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("q.base")).unwrap(),
        "x: link(\"New\")\n"
    );
    // no stray temp files
    let strays: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".~"))
        .collect();
    assert!(strays.is_empty());
}

#[test]
fn plan_rejects_collisions_escapes_and_obsidian() {
    let (_v, _d, root, index) = vault(&[("A.md", "a"), ("B.md", "b"), (".obsidian/x.json", "{}")]);
    assert!(plan(&root, &index, "A.md", "B.md", true).is_err());
    assert!(plan(&root, &index, "A.md", "A.md", true).is_err());
    assert!(plan(&root, &index, "A.md", "../out.md", true).is_err());
    assert!(plan(&root, &index, "A.md", ".obsidian/A.md", true).is_err());
    assert!(plan(&root, &index, ".obsidian/x.json", "y.json", true).is_err());
    assert!(plan(&root, &index, "missing.md", "z.md", true).is_err());
    assert!(plan(&root, &index, "A.md", "bad:name.md", true).is_err());
}

#[test]
fn apply_refuses_when_a_referrer_changed_since_planning() {
    let (_v, _d, root, index) = vault(&[("Old.md", "o"), ("H.md", "[[Old]]\n")]);
    let p = plan(&root, &index, "Old.md", "New.md", true).unwrap();
    fs::write(root.join("H.md"), "[[Old]] edited meanwhile\n").unwrap();
    let e = apply(&p).unwrap_err();
    assert!(e.changed.is_empty() && !e.moved, "{e}");
    assert!(root.join("Old.md").exists() && !root.join("New.md").exists());
    assert_eq!(
        fs::read_to_string(root.join("H.md")).unwrap(),
        "[[Old]] edited meanwhile\n"
    );
}

#[cfg(unix)]
#[test]
fn staging_failure_changes_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let (_v, _d, root, index) = vault(&[
        ("Old.md", "o"),
        ("ok/A.md", "[[Old]]\n"),
        ("locked/B.md", "[[Old]]\n"),
    ]);
    let p = plan(&root, &index, "Old.md", "New.md", true).unwrap();
    assert_eq!(p.edits.len(), 2);
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();
    // root can write anywhere; only assert when the lock is effective
    let effective = fs::write(root.join("locked/.probe"), "x").is_err();
    let r = apply(&p);
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    if effective {
        let e = r.unwrap_err();
        assert!(e.changed.is_empty() && !e.moved, "{e}");
        assert!(root.join("Old.md").exists() && !root.join("New.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("ok/A.md")).unwrap(),
            "[[Old]]\n"
        );
        let strays = fs::read_dir(root.join("ok")).unwrap().flatten().count();
        assert_eq!(strays, 1, "staged temp files are cleaned up");
    }
}

#[test]
fn moved_note_gets_its_own_relative_links_fixed_and_dir_created() {
    let (_v, _d, root, index) = vault(&[
        ("n/Src.md", "[s](../docs/spec.md) [[./Side]]\n"),
        ("docs/spec.md", "s"),
        ("n/Side.md", "s"),
    ]);
    let p = plan(&root, &index, "n/Src.md", "deep/er/Src.md", true).unwrap();
    apply(&p).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("deep/er/Src.md")).unwrap(),
        "[s](../../docs/spec.md) [[../../n/Side]]\n"
    );
}

#[test]
fn update_links_false_only_moves() {
    let (_v, _d, root, index) = vault(&[("Old.md", "o"), ("H.md", "[[Old]]\n")]);
    let p = plan(&root, &index, "Old.md", "New.md", false).unwrap();
    assert!(p.edits.is_empty());
    apply(&p).unwrap();
    assert_eq!(fs::read_to_string(root.join("H.md")).unwrap(), "[[Old]]\n");
}
