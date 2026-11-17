use super::*;
use crate::relocate::apply;
use std::fs;
use std::path::PathBuf;
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

fn read(root: &Path, p: &str) -> String {
    fs::read_to_string(root.join(p)).unwrap()
}

fn files() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Spec.md", "---\ntitle: Old Name\ntags: [a]\n---\n# Heading\n[[Spec|Old Name]]\n"),
        (
            "Home.md",
            "[[Spec|Old Name]] ![[Spec|Old Name]] [[Spec]] [[Spec|Other]] [[Spec#H|Old Name]] `[[Spec|Old Name]]`\n",
        ),
        ("Else.md", "[[Home|Old Name]]\n"),
    ]
}

#[test]
fn plan_writes_nothing_and_counts_links() {
    let (_v, _d, root, index) = vault(&files());
    let r = plan(&root, &index, "Spec.md", Some("New Name"), true).unwrap();
    assert_eq!(r.old.as_deref(), Some("Old Name"));
    assert_eq!(r.new.as_deref(), Some("New Name"));
    // Home: 3 links (plain, embed, with heading); Spec itself: 1
    assert_eq!(r.link_counts(), (4, 2));
    assert!(read(&root, "Spec.md").contains("title: Old Name"));
    assert!(read(&root, "Home.md").contains("[[Spec|Old Name]]"));
}

#[test]
fn apply_rewrites_only_matching_aliases_and_the_property() {
    let (_v, _d, root, index) = vault(&files());
    let r = plan(&root, &index, "Spec.md", Some("New Name"), true).unwrap();
    apply(&r.plan).unwrap();
    assert_eq!(
        read(&root, "Home.md"),
        "[[Spec|New Name]] ![[Spec|New Name]] [[Spec]] [[Spec|Other]] [[Spec#H|New Name]] `[[Spec|Old Name]]`\n"
    );
    let spec = read(&root, "Spec.md");
    assert!(spec.starts_with("---\ntitle: New Name\ntags: [a]\n---\n# Heading\n[[Spec|New Name]]"));
    // the file was not renamed, unrelated notes untouched
    assert_eq!(read(&root, "Else.md"), "[[Home|Old Name]]\n");
    assert!(!root.join("New Name.md").exists());
}

#[test]
fn without_link_updates_only_the_frontmatter_changes() {
    let (_v, _d, root, index) = vault(&files());
    let r = plan(&root, &index, "Spec.md", Some("New Name"), false).unwrap();
    assert_eq!(r.link_counts(), (0, 0));
    apply(&r.plan).unwrap();
    assert!(read(&root, "Spec.md").contains("title: New Name"));
    assert!(read(&root, "Spec.md").contains("[[Spec|Old Name]]"));
    assert!(read(&root, "Home.md").contains("[[Spec|Old Name]]"));
}

#[test]
fn clear_removes_the_property_and_the_old_alias() {
    let (_v, _d, root, index) = vault(&files());
    let r = plan(&root, &index, "Spec.md", None, true).unwrap();
    apply(&r.plan).unwrap();
    assert_eq!(
        read(&root, "Home.md"),
        "[[Spec]] ![[Spec]] [[Spec]] [[Spec|Other]] [[Spec#H]] `[[Spec|Old Name]]`\n"
    );
    assert!(!read(&root, "Spec.md").contains("title:"));
}

#[test]
fn first_title_on_a_note_without_one_touches_only_its_frontmatter() {
    let (_v, _d, root, index) = vault(&[
        ("N.md", "# H\nbody\n"),
        ("Home.md", "[[N|N]] [[N|Anything]]\n"),
    ]);
    let r = plan(&root, &index, "N.md", Some("Pretty"), true).unwrap();
    assert_eq!(r.old, None);
    assert_eq!(r.plan.edits.len(), 1);
    apply(&r.plan).unwrap();
    assert_eq!(read(&root, "N.md"), "---\ntitle: Pretty\n---\n# H\nbody\n");
    assert_eq!(read(&root, "Home.md"), "[[N|N]] [[N|Anything]]\n");
}

#[test]
fn same_title_is_a_no_op_and_bad_input_is_refused() {
    let (_v, _d, root, index) = vault(&files());
    let r = plan(&root, &index, "Spec.md", Some("  Old Name "), true).unwrap();
    assert!(r.plan.edits.is_empty());
    assert!(plan(&root, &index, "Spec.md", Some("a\nb"), true).is_err());
    assert!(plan(&root, &index, "missing.md", Some("x"), true).is_err());
    fs::write(root.join("pic.png"), "x").unwrap();
    assert!(plan(&root, &index, "pic.png", Some("x"), true).is_err());
}

#[test]
fn stale_referrer_refuses_and_changes_nothing() {
    let (_v, _d, root, index) = vault(&files());
    let r = plan(&root, &index, "Spec.md", Some("New Name"), true).unwrap();
    fs::write(root.join("Home.md"), "changed [[Spec|Old Name]]\n").unwrap();
    assert!(apply(&r.plan).is_err());
    assert!(read(&root, "Spec.md").contains("title: Old Name"));
    assert_eq!(read(&root, "Home.md"), "changed [[Spec|Old Name]]\n");
}

#[test]
fn failure_while_committing_rolls_back_every_file() {
    let (_v, _d, root, index) = vault(&files());
    let mut r = plan(&root, &index, "Spec.md", Some("New Name"), true).unwrap();
    // The note's own write fails (its path is now a directory): referrers must be restored.
    fs::remove_file(root.join("Spec.md")).unwrap();
    fs::create_dir(root.join("Spec.md")).unwrap();
    r.plan.edits.retain(|e| e.rel != "Spec.md");
    r.plan.edits.push(crate::relocate::FileEdit {
        rel: "Spec.md".into(),
        before: String::new(),
        after: "x".into(),
        links: 0,
    });
    assert!(apply(&r.plan).is_err());
    assert_eq!(read(&root, "Home.md"), files()[1].1);
}

#[test]
fn table_cell_escaped_pipe_alias() {
    let (_v, _d, root, index) = vault(&[
        ("N.md", "---\ntitle: Old\n---\n"),
        ("T.md", "| a |\n|---|\n| [[N\\|Old]] |\n"),
    ]);
    let r = plan(&root, &index, "N.md", Some("New"), true).unwrap();
    apply(&r.plan).unwrap();
    assert!(read(&root, "T.md").contains("[[N\\|New]]"));
    let r = plan(&root, &index, "N.md", None, true).unwrap();
    apply(&r.plan).unwrap();
    assert!(read(&root, "T.md").contains("[[N]]"));
}
