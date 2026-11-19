use super::*;
use crate::index::Index;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

fn vault() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    (dir, root)
}

fn write(root: &Path, rel: &str, text: &str) {
    let abs = root.join(rel);
    fs::create_dir_all(abs.parent().unwrap()).unwrap();
    fs::write(abs, text).unwrap();
}

fn iconize(root: &Path, json: &str) {
    write(root, ICONIZE_FILE, json);
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn icon_of_path(root: &Path, path: &str) -> Option<(String, Source)> {
    icon_of(root, path).unwrap().map(|(e, s)| (e.icon, s))
}

#[test]
fn the_store_round_trips_and_keeps_unknown_keys() {
    let (_d, root) = vault();
    write(
        &root,
        ".writer/icons.json",
        r##"{"version":1,"future":{"a":1},"icons":{"A.md":{"icon":"emoji:🚀","color":"#ff0000","note":"keep"}}}"##,
    );
    set(&root, &paths(&["B.md"]), "icon:Rocket01Icon", None).unwrap();
    let text = fs::read_to_string(root.join(".writer/icons.json")).unwrap();
    let doc: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(doc["version"], 1);
    assert_eq!(doc["future"], serde_json::json!({"a": 1}));
    assert_eq!(doc["icons"]["A.md"]["note"], "keep");
    assert_eq!(doc["icons"]["A.md"]["color"], "#ff0000");
    assert_eq!(doc["icons"]["B.md"]["icon"], "icon:Rocket01Icon");
    assert!(doc["icons"]["B.md"].get("color").is_none());
    // updating an entry keeps its unknown keys
    set(&root, &paths(&["A.md"]), "emoji:📚", None).unwrap();
    let doc: Value =
        serde_json::from_str(&fs::read_to_string(root.join(".writer/icons.json")).unwrap())
            .unwrap();
    assert_eq!(doc["icons"]["A.md"]["icon"], "emoji:📚");
    assert_eq!(doc["icons"]["A.md"]["note"], "keep");
}

#[test]
fn a_missing_file_is_an_empty_store_and_nothing_is_created_by_reading() {
    let (_d, root) = vault();
    assert!(load(&root).unwrap().icons.is_empty());
    assert!(!root.join(".writer").exists());
    assert!(resolve(&root).unwrap().icons.is_empty());
    assert!(!root.join(".writer").exists());
}

#[test]
fn bad_entries_are_dropped_and_bad_json_is_an_error() {
    let (_d, root) = vault();
    write(
        &root,
        ".writer/icons.json",
        r##"{"icons":{"ok.md":{"icon":"emoji:✅"},"bad.md":{"icon":"smile"},"c.md":{"icon":"emoji:✅","color":"red"},"n.md":"x"}}"##,
    );
    let store = load(&root).unwrap();
    assert_eq!(store.icons.keys().collect::<Vec<_>>(), ["ok.md"]);
    write(&root, ".writer/icons.json", "{ nope");
    assert!(matches!(load(&root), Err(IconError::Invalid(_))));
    // a bad write is refused before anything is touched
    assert!(set(&root, &paths(&["a.md"]), "smile", None).is_err());
    assert!(set(&root, &paths(&["a.md"]), "emoji:✅", Some("red")).is_err());
}

#[test]
fn iconize_parsing_maps_emoji_and_hugeicons_and_counts_packs() {
    let parsed = parse_iconize(
        r##"{
            "settings": {"rules": [], "migrated": 2},
            "Notes": "📁",
            "Notes/Idea.md": {"iconName": "Rocket01Icon", "iconColor": "#00ff00"},
            "Bell.md": "IbBell",
            "Home.md": {"iconName": "LiHome"},
            "Odd.md": 3,
            "Plain.md": "not an icon"
        }"##,
    );
    assert_eq!(parsed.icons["Notes"].icon, "emoji:📁");
    assert_eq!(parsed.icons["Notes/Idea.md"].icon, "icon:Rocket01Icon");
    assert_eq!(
        parsed.icons["Notes/Idea.md"].color.as_deref(),
        Some("#00ff00")
    );
    assert!(!parsed.icons.contains_key("settings"));
    assert_eq!(parsed.icons.len(), 2);
    // two pack icons and one unknown string; a non-string entry is not an icon at all
    assert_eq!(parsed.unsupported, 3);
    assert_eq!(parse_iconize("not json"), Iconize::default());
}

#[test]
fn writer_wins_over_iconize_and_a_hidden_entry_hides_it() {
    let (_d, root) = vault();
    iconize(&root, r#"{"A.md":"🚀","B.md":"📚","C.md":"🎯"}"#);
    set(&root, &paths(&["A.md"]), "emoji:✅", None).unwrap();
    remove(&root, &paths(&["B.md"])).unwrap();
    assert_eq!(
        icon_of_path(&root, "A.md"),
        Some(("emoji:✅".into(), Source::Writer))
    );
    assert_eq!(icon_of_path(&root, "B.md"), None, "removed, not revealed");
    assert_eq!(
        icon_of_path(&root, "C.md"),
        Some(("emoji:🎯".into(), Source::Iconize))
    );
    assert_eq!(icon_of_path(&root, "D.md"), None);
    // removing a Writer-only icon deletes its entry instead of keeping a marker
    set(&root, &paths(&["W.md"]), "emoji:✅", None).unwrap();
    remove(&root, &paths(&["W.md"])).unwrap();
    assert!(load(&root).unwrap().get("W.md").is_none());
    // a folder does not pass its icon to its contents
    iconize(&root, r#"{"Dir":"📁"}"#);
    assert_eq!(icon_of_path(&root, "Dir/x.md"), None);
}

#[test]
fn the_iconize_file_is_never_written() {
    let (_d, root) = vault();
    let text = r#"{"A.md":"🚀"}"#;
    iconize(&root, text);
    let before = fs::metadata(root.join(ICONIZE_FILE))
        .unwrap()
        .modified()
        .unwrap();
    set(&root, &paths(&["A.md"]), "emoji:✅", None).unwrap();
    remove(&root, &paths(&["A.md"])).unwrap();
    rekey(&root, "A.md", "B.md").unwrap();
    drop_under(&root, "A.md").unwrap();
    assert_eq!(fs::read_to_string(root.join(ICONIZE_FILE)).unwrap(), text);
    assert_eq!(
        fs::metadata(root.join(ICONIZE_FILE))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert!(!root
        .join(".obsidian/plugins/obsidian-icon-folder/icons.json")
        .exists());
}

#[test]
fn a_file_move_re_keys_its_entry() {
    let (_d, root) = vault();
    set(&root, &paths(&["a/Old.md", "a/Keep.md"]), "emoji:🚀", None).unwrap();
    rekey(&root, "a/Old.md", "b/New.md").unwrap();
    let store = load(&root).unwrap();
    assert!(store.get("a/Old.md").is_none());
    assert_eq!(store.get("b/New.md").unwrap().icon, "emoji:🚀");
    assert!(store.get("a/Keep.md").is_some());
}

#[test]
fn a_folder_move_re_keys_every_descendant_and_only_them() {
    let (_d, root) = vault();
    set(
        &root,
        &paths(&[
            "Dir",
            "Dir/x.md",
            "Dir/sub/y.md",
            "Dir2/z.md",
            "Directory.md",
        ]),
        "emoji:📁",
        None,
    )
    .unwrap();
    rekey(&root, "Dir", "Moved/Dir").unwrap();
    let keys: Vec<_> = load(&root).unwrap().icons.into_keys().collect();
    assert_eq!(
        keys,
        [
            "Dir2/z.md",
            "Directory.md",
            "Moved/Dir",
            "Moved/Dir/sub/y.md",
            "Moved/Dir/x.md"
        ]
    );
}

#[test]
fn an_iconize_only_icon_is_copied_on_rename_and_hidden_at_the_old_path() {
    let (_d, root) = vault();
    iconize(&root, r#"{"Dir":"📁","Dir/x.md":"🚀","Other.md":"🎯"}"#);
    set(&root, &paths(&["Dir/x.md"]), "emoji:✅", None).unwrap();
    rekey(&root, "Dir", "Renamed").unwrap();
    assert_eq!(
        icon_of_path(&root, "Renamed"),
        Some(("emoji:📁".into(), Source::Writer))
    );
    assert_eq!(
        icon_of_path(&root, "Renamed/x.md"),
        Some(("emoji:✅".into(), Source::Writer)),
        "Writer's own entry moved, Iconize's was not copied over it"
    );
    assert_eq!(
        icon_of_path(&root, "Dir"),
        None,
        "a new Dir does not inherit"
    );
    assert_eq!(icon_of_path(&root, "Dir/x.md"), None);
    assert_eq!(
        icon_of_path(&root, "Other.md"),
        Some(("emoji:🎯".into(), Source::Iconize)),
        "an unrelated Iconize icon is untouched"
    );
}

#[test]
fn a_move_without_icons_writes_nothing() {
    let (_d, root) = vault();
    rekey(&root, "a.md", "b.md").unwrap();
    assert!(!root.join(".writer").exists());
}

#[test]
fn a_delete_drops_the_entry_and_the_descendants() {
    let (_d, root) = vault();
    set(
        &root,
        &paths(&["Dir", "Dir/x.md", "Dirx.md", "Keep.md"]),
        "emoji:📁",
        None,
    )
    .unwrap();
    drop_under(&root, "Dir").unwrap();
    let keys: Vec<_> = load(&root).unwrap().icons.into_keys().collect();
    assert_eq!(keys, ["Dirx.md", "Keep.md"]);
}

#[test]
fn normalize_accepts_the_stored_format_a_bare_emoji_and_a_bare_name() {
    assert_eq!(normalize_icon("emoji:🚀").as_deref(), Some("emoji:🚀"));
    assert_eq!(normalize_icon("🚀").as_deref(), Some("emoji:🚀"));
    assert_eq!(
        normalize_icon("Rocket01Icon").as_deref(),
        Some("icon:Rocket01Icon")
    );
    assert_eq!(
        normalize_icon("icon:Rocket01Icon").as_deref(),
        Some("icon:Rocket01Icon")
    );
    for bad in ["", "rocket", "ab", "emoji:", "Rocket01"] {
        assert_eq!(normalize_icon(bad), None, "{bad:?}");
    }
}

#[test]
fn the_shared_vectors_agree_with_the_validator_the_store_uses() {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../shared/icon-value-vectors.json")).unwrap();
    for v in vectors["valid"].as_array().unwrap() {
        assert!(valid_icon(v.as_str().unwrap()));
    }
    for v in vectors["invalid"].as_array().unwrap() {
        assert!(!valid_icon(v.as_str().unwrap()), "{v}");
    }
}

#[test]
fn colours_are_six_digit_hex() {
    for ok in ["#000000", "#FfAa00"] {
        assert!(valid_color(ok));
    }
    for bad in ["", "red", "#fff", "000000", "#00000g", "#0000000"] {
        assert!(!valid_color(bad), "{bad}");
    }
}

#[test]
fn a_relocate_apply_re_keys_the_icon_in_the_same_operation() {
    let _on = TEST_SWITCH.lock();
    set_enabled(true);
    let (_d, root) = vault();
    let data = TempDir::new().unwrap();
    write(&root, "a/Old.md", "# Old\n");
    write(&root, "Home.md", "[[Old]]\n");
    set(&root, &paths(&["a/Old.md"]), "emoji:🚀", None).unwrap();
    let index = Index::open_for_cli(&root, Some(data.path())).unwrap();
    let plan = crate::relocate::plan(&root, &index, "a/Old.md", "b/New.md", true).unwrap();
    crate::relocate::apply(&plan).unwrap();
    assert_eq!(
        icon_of_path(&root, "b/New.md"),
        Some(("emoji:🚀".into(), Source::Writer))
    );
    assert_eq!(icon_of_path(&root, "a/Old.md"), None);
}

#[test]
fn with_the_feature_off_a_move_and_a_delete_write_nothing() {
    let _off = TEST_SWITCH.lock();
    let (_d, root) = vault();
    iconize(&root, r#"{"A.md":"🚀"}"#);
    set(&root, &paths(&["W.md"]), "emoji:✅", None).unwrap();
    let before = fs::read_to_string(root.join(".writer/icons.json")).unwrap();
    set_enabled(false);
    on_move(&root, "W.md", "X.md").unwrap();
    on_move(&root, "A.md", "B.md").unwrap();
    on_delete(&root, "W.md").unwrap();
    set_enabled(true);
    assert_eq!(
        fs::read_to_string(root.join(".writer/icons.json")).unwrap(),
        before
    );
}

#[test]
fn a_symlinked_writer_dir_is_refused() {
    #[cfg(unix)]
    {
        let (_d, root) = vault();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join(".writer")).unwrap();
        assert!(matches!(
            set(&root, &paths(&["a.md"]), "emoji:✅", None),
            Err(IconError::Invalid(_))
        ));
        assert!(!outside.path().join(FILE).exists());
    }
}
