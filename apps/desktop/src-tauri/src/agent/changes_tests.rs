use super::*;
use serde_json::json;
use tempfile::TempDir;

const CHAT: &str = "chat-1";

fn vault() -> (TempDir, PathBuf) {
    let d = TempDir::new().unwrap();
    let root = d.path().canonicalize().unwrap();
    (d, root)
}

fn path(root: &Path, rel: &str) -> String {
    root.join(rel).to_string_lossy().into_owned()
}

fn cap(store: &ChangeStore, root: &Path, tool: &str, rel: &str) {
    let key = if tool == "NotebookEdit" {
        "notebook_path"
    } else {
        "file_path"
    };
    store.capture(CHAT, root, root, tool, &json!({ key: path(root, rel) }));
}

fn finish(store: &ChangeStore) -> Option<TurnChangesSummary> {
    store.finish(store.close_turn(CHAT)?)
}

fn file<'a>(s: &'a TurnChangesSummary, rel: &str) -> &'a FileChangeSummary {
    s.files.iter().find(|f| f.path == rel).unwrap()
}

#[test]
fn snapshot_is_taken_at_capture_and_the_first_one_wins() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "one\ntwo\nthree\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "one\nTWO\nthree\n").unwrap();
    // a later call (or the permission request) for the same file must not re-snapshot
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "one\nTWO\nthree\nfour\n").unwrap();
    let s = finish(&store).unwrap();
    let f = file(&s, "a.md");
    assert_eq!(f.status, ChangeStatus::Modified);
    assert_eq!((f.added, f.removed), (2, 1));
}

#[test]
fn statuses_added_deleted_modified_and_unchanged() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("mod.md"), "a\n").unwrap();
    std::fs::write(root.join("del.md"), "x\ny\n").unwrap();
    std::fs::write(root.join("same.md"), "s\n").unwrap();
    for (tool, rel) in [
        ("Write", "new.md"),
        ("Edit", "mod.md"),
        ("Write", "del.md"),
        ("Edit", "same.md"),
    ] {
        cap(&store, &root, tool, rel);
    }
    std::fs::write(root.join("new.md"), "n1\nn2\nn3\n").unwrap();
    std::fs::write(root.join("mod.md"), "a\nb\n").unwrap();
    std::fs::remove_file(root.join("del.md")).unwrap();
    let s = finish(&store).unwrap();
    assert_eq!(s.files.len(), 3, "an unchanged (denied) edit is not listed");
    assert_eq!(file(&s, "new.md").status, ChangeStatus::Added);
    assert_eq!(
        (file(&s, "new.md").added, file(&s, "new.md").removed),
        (3, 0)
    );
    assert_eq!(file(&s, "mod.md").status, ChangeStatus::Modified);
    assert_eq!(file(&s, "del.md").status, ChangeStatus::Deleted);
    assert_eq!(
        (file(&s, "del.md").added, file(&s, "del.md").removed),
        (0, 2)
    );
    assert!(!s.bash);
}

#[test]
fn a_moved_file_is_one_rename_and_undo_restores_both_sides() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("old.md"), "same text\n").unwrap();
    cap(&store, &root, "Write", "new.md");
    cap(&store, &root, "Edit", "old.md");
    std::fs::write(root.join("new.md"), "same text\n").unwrap();
    std::fs::remove_file(root.join("old.md")).unwrap();
    let s = finish(&store).unwrap();
    assert_eq!(s.files.len(), 1);
    let f = &s.files[0];
    assert_eq!(f.status, ChangeStatus::Renamed);
    assert_eq!(
        (f.path.as_str(), f.old_path.as_deref()),
        ("new.md", Some("old.md"))
    );
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["new.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Reverted);
    assert!(!root.join("new.md").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("old.md")).unwrap(),
        "same text\n"
    );
}

#[test]
fn turns_with_only_a_shell_command_have_no_card_and_a_shell_is_flagged_next_to_edits() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    store.capture(
        CHAT,
        &root,
        &root,
        "Bash",
        &json!({"command": "touch x.md"}),
    );
    std::fs::write(root.join("x.md"), "made by bash\n").unwrap();
    assert!(
        finish(&store).is_none(),
        "Bash side effects are not tracked"
    );

    std::fs::write(root.join("a.md"), "1\n").unwrap();
    store.capture(CHAT, &root, &root, "Bash", &json!({"command": "ls"}));
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "2\n").unwrap();
    let s = finish(&store).unwrap();
    assert!(s.bash);
    assert_eq!(s.files.len(), 1, "the Bash-created file is not listed");
}

#[test]
fn read_only_and_unknown_tools_capture_nothing() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "1\n").unwrap();
    store.capture(
        CHAT,
        &root,
        &root,
        "Read",
        &json!({"file_path": path(&root, "a.md")}),
    );
    store.capture(CHAT, &root, &root, "Grep", &json!({"pattern": "x"}));
    store.capture(CHAT, &root, &root, "Edit", &json!("not an object"));
    assert!(store.close_turn(CHAT).is_none());
}

#[test]
fn relative_paths_resolve_from_the_cwd() {
    let (_d, root) = vault();
    std::fs::create_dir(root.join("proj")).unwrap();
    std::fs::write(root.join("proj/a.md"), "1\n").unwrap();
    let store = ChangeStore::default();
    store.capture(
        CHAT,
        &root,
        &root.join("proj"),
        "Edit",
        &json!({"file_path": "a.md"}),
    );
    std::fs::write(root.join("proj/a.md"), "2\n").unwrap();
    let s = finish(&store).unwrap();
    assert_eq!(s.files[0].path, "proj/a.md");
}

#[test]
fn paths_outside_the_vault_are_never_snapshotted() {
    let (_d, root) = vault();
    let (_o, outside) = vault();
    std::fs::write(outside.join("secret.md"), "s\n").unwrap();
    std::fs::create_dir(root.join(".git")).unwrap();
    let store = ChangeStore::default();
    for p in [
        path(&outside, "secret.md"),
        path(&root, "../escape.md"),
        path(&root, ".git/config"),
        "../up.md".to_string(),
    ] {
        store.capture(CHAT, &root, &root, "Write", &json!({ "file_path": p }));
    }
    assert!(store.close_turn(CHAT).is_none());
}

#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_vault_is_refused_and_one_inside_resolves_to_its_target() {
    use std::os::unix::fs::symlink;
    let (_d, root) = vault();
    let (_o, outside) = vault();
    std::fs::write(outside.join("t.md"), "s\n").unwrap();
    symlink(outside.join("t.md"), root.join("out.md")).unwrap();
    std::fs::write(root.join("real.md"), "1\n").unwrap();
    symlink(root.join("real.md"), root.join("in.md")).unwrap();
    let store = ChangeStore::default();
    cap(&store, &root, "Edit", "out.md");
    assert!(store.close_turn(CHAT).is_none());
    cap(&store, &root, "Edit", "in.md");
    std::fs::write(root.join("real.md"), "2\n").unwrap();
    let s = finish(&store).unwrap();
    assert_eq!(s.files[0].path, "real.md");
    assert!(root.join("in.md").is_symlink());
}

#[test]
fn detail_has_numbered_rows_and_undo_state() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "one\ntwo\nthree\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "one\n2\nthree\n").unwrap();
    let s = finish(&store).unwrap();
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    let f = &d.files[0];
    assert_eq!(f.undo, UndoState::Available);
    let kinds: Vec<_> = f
        .rows
        .iter()
        .map(|r| (r.kind, r.old_line, r.new_line))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (DiffRowKind::Context, Some(1), Some(1)),
            (DiffRowKind::Del, Some(2), None),
            (DiffRowKind::Add, None, Some(2)),
            (DiffRowKind::Context, Some(3), Some(3)),
        ]
    );
    assert_eq!(f.rows[1].text, "two");
    assert!(store.detail(CHAT, "nope", &root).is_none());
    assert!(store.detail("other-chat", &s.turn_id, &root).is_none());
    let (_o, other_root) = vault();
    assert!(store.detail(CHAT, &s.turn_id, &other_root).is_none());
}

#[test]
fn undo_restores_the_exact_bytes_including_crlf() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let before = "a\r\nb\r\n\r\nno newline at end";
    std::fs::write(root.join("a.md"), before).unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "a\r\nB\r\n").unwrap();
    let s = finish(&store).unwrap();
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["a.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Reverted);
    assert_eq!(std::fs::read(root.join("a.md")).unwrap(), before.as_bytes());
    // done once: the state says so and a second click is a no-op
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert_eq!(d.files[0].undo, UndoState::Reverted);
    let again = store
        .revert(CHAT, &s.turn_id, &root, &["a.md".into()])
        .unwrap();
    assert_eq!(again[0].result, RevertResult::Reverted);
}

#[test]
fn undo_removes_a_created_file_and_restores_a_deleted_one() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::create_dir(root.join("dir")).unwrap();
    std::fs::write(root.join("dir/gone.md"), "keep me\n").unwrap();
    cap(&store, &root, "Write", "made.md");
    cap(&store, &root, "Edit", "dir/gone.md");
    std::fs::write(root.join("made.md"), "new\n").unwrap();
    std::fs::remove_dir_all(root.join("dir")).unwrap();
    let s = finish(&store).unwrap();
    let out = store
        .revert(
            CHAT,
            &s.turn_id,
            &root,
            &["made.md".into(), "dir/gone.md".into()],
        )
        .unwrap();
    assert!(
        out.iter().all(|o| o.result == RevertResult::Reverted),
        "{out:?}"
    );
    assert!(!root.join("made.md").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("dir/gone.md")).unwrap(),
        "keep me\n"
    );
}

#[test]
fn undo_refuses_when_the_file_changed_since_the_turn_ended() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "1\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "2\n").unwrap();
    let s = finish(&store).unwrap();
    std::fs::write(root.join("a.md"), "2\nmy own edit\n").unwrap();
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert_eq!(d.files[0].undo, UndoState::ChangedSince);
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["a.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::ChangedSince);
    assert_eq!(out[0].message.as_deref(), Some("file changed since"));
    assert_eq!(
        std::fs::read_to_string(root.join("a.md")).unwrap(),
        "2\nmy own edit\n",
        "never clobber the user's edits"
    );
}

#[test]
fn undo_of_an_unknown_path_or_vanished_snapshot() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "1\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "2\n").unwrap();
    let s = finish(&store).unwrap();
    let out = store
        .revert(
            CHAT,
            &s.turn_id,
            &root,
            &["../x.md".into(), "zzz.md".into()],
        )
        .unwrap();
    assert!(out.iter().all(|o| o.result == RevertResult::Unavailable));
    assert!(store
        .revert(CHAT, "gone", &root, &["a.md".into()])
        .is_none());
}

#[test]
fn big_and_binary_files_are_listed_without_diff_or_undo() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("big.md"), vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
    std::fs::write(root.join("bin.png"), [0u8, 1, 2, 3]).unwrap();
    cap(&store, &root, "Edit", "big.md");
    cap(&store, &root, "Edit", "bin.png");
    std::fs::write(root.join("big.md"), vec![b'y'; MAX_FILE_BYTES as usize + 5]).unwrap();
    std::fs::write(root.join("bin.png"), [9u8, 9, 9, 9, 9]).unwrap();
    let s = finish(&store).unwrap();
    assert_eq!(s.files.len(), 2);
    for f in &s.files {
        assert!(f.no_diff, "{f:?}");
        assert_eq!((f.added, f.removed), (0, 0));
        assert_eq!(f.status, ChangeStatus::Modified);
    }
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert!(d
        .files
        .iter()
        .all(|f| f.undo == UndoState::Unavailable && f.rows.is_empty()));
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["big.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Unavailable);
}

#[test]
fn total_cap_drops_the_oldest_turn_first() {
    let (_d, root) = vault();
    let store = ChangeStore::with_cap(100);
    let mut ids = Vec::new();
    for i in 0..3 {
        let rel = format!("f{i}.md");
        std::fs::write(root.join(&rel), "x".repeat(40)).unwrap();
        cap(&store, &root, "Edit", &rel);
        std::fs::write(root.join(&rel), "y".repeat(10)).unwrap();
        ids.push(finish(&store).unwrap().turn_id);
    }
    assert!(
        store.detail(CHAT, &ids[0], &root).is_none(),
        "oldest dropped"
    );
    assert!(store.detail(CHAT, &ids[2], &root).is_some(), "newest kept");
}

#[test]
fn a_pre_image_over_the_budget_keeps_a_fingerprint_only() {
    let (_d, root) = vault();
    let store = ChangeStore::with_cap(10);
    std::fs::write(root.join("a.md"), "x".repeat(50)).unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "y".repeat(51)).unwrap();
    let s = finish(&store).unwrap();
    assert!(s.files[0].no_diff);
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert_eq!(d.files[0].undo, UndoState::Unavailable);
}

#[test]
fn turn_ids_differ_and_a_new_turn_starts_after_finish() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "1\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "2\n").unwrap();
    let first = finish(&store).unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "3\n").unwrap();
    let second = finish(&store).unwrap();
    assert_ne!(first.turn_id, second.turn_id);
    assert_eq!(second.files[0].added, 1);
    // each turn reverts to its own pre-image once the file is as that turn left it
    let out = store
        .revert(CHAT, &first.turn_id, &root, &["a.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::ChangedSince);
}

#[test]
fn memory_writes_are_not_changes_but_note_edits_in_the_same_turn_are() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::create_dir_all(root.join("Projects/P")).unwrap();
    std::fs::write(root.join("a.md"), "one\n").unwrap();
    // a turn that only saves memory (vault and project) leaves no card
    for rel in [
        ".writer/memory/MEMORY.md",
        ".writer/memory/user-cat.md",
        "Projects/P/.memory/MEMORY.md",
    ] {
        cap(&store, &root, "Write", rel);
        std::fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
        std::fs::write(root.join(rel), "m\n").unwrap();
    }
    assert!(finish(&store).is_none());
    // the same writes next to a note edit: only the note is listed (and undoable)
    for rel in [".writer/memory/MEMORY.md", "Projects/P/.memory/MEMORY.md"] {
        cap(&store, &root, "Edit", rel);
        std::fs::write(root.join(rel), "m2\n").unwrap();
    }
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "one\ntwo\n").unwrap();
    let s = finish(&store).unwrap();
    assert_eq!(s.files.len(), 1);
    assert_eq!(file(&s, "a.md").status, ChangeStatus::Modified);
}

// ---- the chat's session: first-touch baselines across turns (ADR 2026-11-18, changed notes row) ----

fn sess(store: &ChangeStore, root: &Path) -> SessionChangesSummary {
    store.session_summary(CHAT, root).unwrap()
}

fn sess_file<'a>(s: &'a SessionChangesSummary, rel: &str) -> &'a FileChangeSummary {
    s.files.iter().find(|f| f.path == rel).unwrap()
}

#[test]
fn the_first_touch_is_the_baseline_across_turns_and_later_turns_do_not_move_it() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    assert!(store.session_summary(CHAT, &root).is_none(), "no write yet");
    std::fs::write(root.join("a.md"), "one\ntwo\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "one\nTWO\n").unwrap();
    finish(&store).unwrap();
    assert_eq!(sess_file(&sess(&store, &root), "a.md").added, 1);
    // turn 2 edits the same file again: the turn card diffs against turn 2's pre-image only,
    // the session still against the text before turn 1
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "one\nTWO\nthree\n").unwrap();
    let turn2 = finish(&store).unwrap();
    assert_eq!((turn2.files[0].added, turn2.files[0].removed), (1, 0));
    let s = sess(&store, &root);
    assert_eq!(s.files.len(), 1);
    assert_eq!(
        (sess_file(&s, "a.md").added, sess_file(&s, "a.md").removed),
        (2, 1)
    );
    // and the live list needs no turn end: the disk is read when asked
    std::fs::write(root.join("a.md"), "one\ntwo\n").unwrap();
    assert!(
        sess(&store, &root).files.is_empty(),
        "edited back: not changed"
    );
}

#[test]
fn a_sub_agent_edit_counts_and_the_first_author_is_kept() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "x\n").unwrap();
    let worker = Author {
        label: "worker".into(),
        call_id: "toolu_agent1".into(),
    };
    store.capture_by(
        CHAT,
        &root,
        &root,
        "Write",
        &json!({ "file_path": path(&root, "a.md") }),
        Some(&worker),
    );
    std::fs::write(root.join("a.md"), "x\ny\n").unwrap();
    finish(&store).unwrap();
    // the main agent edits it later: the session keeps the first author
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "x\ny\nz\n").unwrap();
    let f = sess(&store, &root).files.remove(0);
    assert_eq!((f.added, f.removed), (2, 0));
    assert_eq!(f.by.as_deref(), Some("worker"));
    assert_eq!(f.by_call.as_deref(), Some("toolu_agent1"));
}

#[test]
fn the_session_knows_created_modified_deleted_and_renamed_files() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("mod.md"), "a\n").unwrap();
    std::fs::write(root.join("gone.md"), "bye\n").unwrap();
    std::fs::write(root.join("old.md"), "same\n").unwrap();
    for (tool, rel) in [
        ("Edit", "mod.md"),
        ("Write", "new.md"),
        ("Edit", "gone.md"),
        ("Edit", "old.md"),
        ("Write", "moved.md"),
    ] {
        cap(&store, &root, tool, rel);
    }
    std::fs::write(root.join("mod.md"), "b\n").unwrap();
    std::fs::write(root.join("new.md"), "n1\nn2\n").unwrap();
    std::fs::remove_file(root.join("gone.md")).unwrap();
    std::fs::rename(root.join("old.md"), root.join("moved.md")).unwrap();
    let s = sess(&store, &root);
    assert_eq!(sess_file(&s, "mod.md").status, ChangeStatus::Modified);
    assert_eq!(sess_file(&s, "new.md").status, ChangeStatus::Added);
    assert_eq!(sess_file(&s, "new.md").added, 2);
    assert_eq!(sess_file(&s, "gone.md").status, ChangeStatus::Deleted);
    let moved = sess_file(&s, "moved.md");
    assert_eq!(moved.status, ChangeStatus::Renamed);
    assert_eq!(moved.old_path.as_deref(), Some("old.md"));
    assert_eq!(s.files.len(), 4);
}

#[test]
fn the_session_detail_diffs_each_file_against_its_first_touch_version() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "keep\nold\n").unwrap();
    std::fs::write(root.join("gone.md"), "removed text\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    cap(&store, &root, "Write", "n.md");
    cap(&store, &root, "Edit", "gone.md");
    std::fs::write(root.join("a.md"), "keep\nmid\n").unwrap();
    finish(&store).unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "keep\nnew\n").unwrap();
    std::fs::write(root.join("n.md"), "fresh\n").unwrap();
    std::fs::remove_file(root.join("gone.md")).unwrap();
    let d = store.session_detail(CHAT, &root).unwrap();
    let rows = |rel: &str| {
        let f = d.files.iter().find(|f| f.summary.path == rel).unwrap();
        f.rows
            .iter()
            .map(|r| (r.kind, r.text.clone()))
            .collect::<Vec<_>>()
    };
    // "mid" never shows: the baseline is the text before the first turn
    assert_eq!(
        rows("a.md"),
        vec![
            (DiffRowKind::Context, "keep".into()),
            (DiffRowKind::Del, "old".into()),
            (DiffRowKind::Add, "new".into())
        ]
    );
    assert_eq!(rows("n.md"), vec![(DiffRowKind::Add, "fresh".into())]);
    assert_eq!(
        rows("gone.md"),
        vec![(DiffRowKind::Del, "removed text".into())]
    );
}

#[test]
fn session_limits_and_exclusions_are_those_of_the_card() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    // binary and over-size files are listed without a diff
    std::fs::write(root.join("bin.dat"), [0u8, 1, 2]).unwrap();
    std::fs::write(root.join("big.md"), vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
    cap(&store, &root, "Write", "bin.dat");
    cap(&store, &root, "Write", "big.md");
    std::fs::write(root.join("bin.dat"), [0u8, 9, 9, 9]).unwrap();
    std::fs::write(root.join("big.md"), vec![b'y'; MAX_FILE_BYTES as usize + 2]).unwrap();
    // memory folders, outside paths and `..` are never tracked
    cap(&store, &root, "Write", ".writer/memory/MEMORY.md");
    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("o.md"), "o").unwrap();
    store.capture(
        CHAT,
        &root,
        &root,
        "Write",
        &json!({ "file_path": outside.path().join("o.md").to_string_lossy() }),
    );
    cap(&store, &root, "Write", "../escape.md");
    let s = sess(&store, &root);
    assert_eq!(s.files.len(), 2);
    assert!(s.files.iter().all(|f| f.no_diff));
    let d = store.session_detail(CHAT, &root).unwrap();
    assert!(d.files.iter().all(|f| f.rows.is_empty()));
    // a baseline over the session budget keeps a fingerprint: listed, no diff
    let small = ChangeStore::with_cap(10);
    std::fs::write(root.join("a.md"), "x".repeat(50)).unwrap();
    cap(&small, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "y".repeat(51)).unwrap();
    assert!(sess(&small, &root).files[0].no_diff);
}

#[test]
fn a_session_is_per_chat_and_per_vault() {
    let (_d, root) = vault();
    let (_d2, other) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "1\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "2\n").unwrap();
    assert!(store.session_summary("chat-2", &root).is_none());
    assert!(store.session_summary(CHAT, &other).is_none());
    assert!(store.session_detail("chat-2", &root).is_none());
    assert_eq!(sess(&store, &root).files.len(), 1);
}

// ---- files changed by shell commands (watcher batches inside a Bash window) ----

use super::super::command_windows::COMMAND_TAIL;
use std::time::{Duration, Instant};

fn bash(store: &ChangeStore) {
    store.capture(CHAT, Path::new("."), Path::new("."), "Bash", &json!({}));
}

fn bash_in(store: &ChangeStore, root: &Path) {
    store.capture(CHAT, root, root, "Bash", &json!({"command": "x"}));
}

fn seen(store: &ChangeStore, chat: &str, root: &Path, rels: &[&str], at: Instant) -> bool {
    let paths: Vec<PathBuf> = rels.iter().map(|r| root.join(r)).collect();
    store.record_command_changes(chat, root, &paths, at, &|rels| vec![None; rels.len()])
}

/// [`seen`] with an asker: `answers` maps a vault-relative path to what the baseline provider says.
fn seen_asking(
    store: &ChangeStore,
    root: &Path,
    rels: &[&str],
    at: Instant,
    answers: &[(&str, Baseline)],
) -> bool {
    let paths: Vec<PathBuf> = rels.iter().map(|r| root.join(r)).collect();
    let ask = |rels: &[String]| -> Vec<Option<Baseline>> {
        rels.iter()
            .map(|rel| {
                answers
                    .iter()
                    .find(|(p, _)| p == rel)
                    .map(|(_, b)| b.clone())
            })
            .collect()
    };
    store.record_command_changes(CHAT, root, &paths, at, &ask)
}

fn author(label: &str) -> Author {
    Author {
        label: label.into(),
        call_id: format!("agent-{label}"),
    }
}

#[test]
fn a_file_changed_during_a_command_is_listed_with_no_diff_counts_or_undo() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    std::fs::write(root.join("n.md"), "before\n").unwrap();
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["n.md"],
        t + Duration::from_millis(400)
    ));
    store.command_finished(CHAT, "b1", t + Duration::from_millis(500));
    let s = finish(&store).unwrap();
    let f = file(&s, "n.md");
    assert_eq!(f.origin, ChangeOrigin::Command);
    assert!(f.no_diff);
    assert_eq!((f.added, f.removed), (0, 0));
    assert_eq!(f.status, ChangeStatus::Modified);
    assert_eq!(f.by, None, "the main agent's command");
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert!(d.files[0].rows.is_empty());
    assert_eq!(d.files[0].undo, UndoState::Unavailable);
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["n.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Unavailable);
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        "after\n"
    );
    // the session lists it too, equally without a diff
    let ss = sess(&store, &root);
    assert_eq!(sess_file(&ss, "n.md").origin, ChangeOrigin::Command);
    assert!(sess_file(&ss, "n.md").no_diff);
}

#[test]
fn a_file_a_command_deleted_is_listed_as_deleted() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["gone.md"],
        t + Duration::from_millis(10)
    ));
    let s = finish(&store).unwrap();
    assert_eq!(file(&s, "gone.md").status, ChangeStatus::Deleted);
}

#[test]
fn a_sub_agents_command_is_attributed_to_its_role_even_after_the_main_one_ended() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    bash_in(&store, &root);
    store.command_started(CHAT, "main", None, t);
    store.command_finished(CHAT, "main", t + Duration::from_millis(100));
    // the sub-agent's command outlives the main agent's result (a background run)
    store.command_started(
        CHAT,
        "sub",
        Some(&author("worker")),
        t + Duration::from_millis(50),
    );
    std::fs::write(root.join("w.md"), "w\n").unwrap();
    let late = t + Duration::from_millis(100) + COMMAND_TAIL * 5;
    assert!(seen(&store, CHAT, &root, &["w.md"], late));
    let s = finish(&store).unwrap();
    assert_eq!(file(&s, "w.md").by.as_deref(), Some("worker"));
    assert_eq!(file(&s, "w.md").by_call.as_deref(), Some("agent-worker"));
}

#[test]
fn the_window_runs_from_the_call_until_its_result_plus_the_debounce_tail() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    for f in ["early.md", "tail.md", "late.md"] {
        std::fs::write(root.join(f), "x\n").unwrap();
    }
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t + Duration::from_millis(100));
    store.command_finished(CHAT, "b1", t + Duration::from_millis(200));
    assert!(!seen(
        &store,
        CHAT,
        &root,
        &["early.md"],
        t + Duration::from_millis(50)
    ));
    // the last batch is still debounced when the result arrives
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["tail.md"],
        t + Duration::from_millis(200) + COMMAND_TAIL
    ));
    assert!(!seen(
        &store,
        CHAT,
        &root,
        &["late.md"],
        t + Duration::from_millis(201) + COMMAND_TAIL
    ));
    let s = finish(&store).unwrap();
    assert_eq!(s.files.len(), 1);
    assert_eq!(file(&s, "tail.md").origin, ChangeOrigin::Command);
}

#[test]
fn what_writer_does_not_show_or_the_agent_keeps_to_itself_is_never_listed() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    for dir in [
        ".git",
        ".obsidian",
        ".hidden",
        ".writer/memory",
        "node_modules",
        "dir.md",
    ] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    for f in [
        ".git/x.md",
        ".obsidian/x.md",
        ".hidden/x.md",
        ".writer/memory/fact.md",
        ".writer/chats.md",
        "node_modules/x.md",
        "blob.zip",
    ] {
        std::fs::write(root.join(f), "x\n").unwrap();
    }
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    let skipped = [
        ".git/x.md",
        ".obsidian/x.md",
        ".hidden/x.md",
        ".writer/memory/fact.md",
        ".writer/chats.md",
        "node_modules/x.md",
        "blob.zip",
        "dir.md",
    ];
    assert!(!seen(
        &store,
        CHAT,
        &root,
        &skipped,
        t + Duration::from_millis(10)
    ));
    // outside the vault
    let out = tempfile::TempDir::new().unwrap();
    std::fs::write(out.path().join("o.md"), "x").unwrap();
    assert!(!store.record_command_changes(
        CHAT,
        &root,
        &[out.path().join("o.md")],
        t + Duration::from_millis(10),
        &|rels| vec![None; rels.len()]
    ));
    assert!(finish(&store).is_none(), "nothing to show");
    assert!(store.session_summary(CHAT, &root).is_none());
}

#[test]
fn a_file_an_edit_call_already_tracked_keeps_its_diff_and_is_not_duplicated() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    std::fs::write(root.join("a.md"), "one\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    std::fs::write(root.join("a.md"), "one\ntwo\n").unwrap();
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["a.md", "b.md"],
        t + Duration::from_millis(300)
    ));
    let s = finish(&store).unwrap();
    assert_eq!(s.files.iter().filter(|f| f.path == "a.md").count(), 1);
    assert_eq!(file(&s, "a.md").origin, ChangeOrigin::Edit);
    assert_eq!(file(&s, "a.md").added, 1);
    assert_eq!(file(&s, "b.md").origin, ChangeOrigin::Command);
    // a second batch for the same file adds no second row either
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["b.md"],
        t + Duration::from_millis(900)
    ));
}

#[test]
fn a_second_batch_for_a_command_file_adds_no_second_row() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    std::fs::write(root.join("b.md"), "1\n").unwrap();
    seen(
        &store,
        CHAT,
        &root,
        &["b.md"],
        t + Duration::from_millis(300),
    );
    seen(
        &store,
        CHAT,
        &root,
        &["b.md"],
        t + Duration::from_millis(900),
    );
    let s = finish(&store).unwrap();
    assert_eq!(s.files.len(), 1);
    assert_eq!(sess(&store, &root).files.len(), 1);
}

#[test]
fn every_chat_with_a_command_in_flight_lists_the_change_and_the_others_do_not() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    std::fs::write(root.join("shared.md"), "x\n").unwrap();
    for chat in [CHAT, "chat-2"] {
        store.capture(chat, &root, &root, "Bash", &json!({}));
        store.command_started(chat, "b", None, t);
    }
    store.capture("chat-3", &root, &root, "Read", &json!({}));
    let at = t + Duration::from_millis(300);
    assert!(seen(&store, CHAT, &root, &["shared.md"], at));
    assert!(seen(&store, "chat-2", &root, &["shared.md"], at));
    assert!(!seen(&store, "chat-3", &root, &["shared.md"], at));
    for chat in [CHAT, "chat-2"] {
        let s = store.finish(store.close_turn(chat).unwrap()).unwrap();
        assert_eq!(s.files[0].origin, ChangeOrigin::Command);
    }
    assert!(store.close_turn("chat-3").is_none());
}

#[test]
fn a_late_change_after_the_turn_closed_reaches_the_session_only() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", Some(&author("worker")), t);
    // the card is finished while the sub-agent's command still runs
    assert!(finish(&store).is_none());
    std::fs::write(root.join("late.md"), "x\n").unwrap();
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["late.md"],
        t + Duration::from_secs(30)
    ));
    assert!(store.close_turn(CHAT).is_none());
    let s = sess(&store, &root);
    assert_eq!(sess_file(&s, "late.md").by.as_deref(), Some("worker"));
}

#[test]
fn a_chat_ending_closes_its_windows() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    store.commands_ended(CHAT, t + Duration::from_millis(100));
    assert!(!seen(
        &store,
        CHAT,
        &root,
        &["a.md"],
        t + Duration::from_millis(101) + COMMAND_TAIL
    ));
}

#[test]
fn a_command_waiting_for_approval_does_not_run_so_its_window_can_be_shut_and_reopened() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    // permission request: shut
    store.command_finished(CHAT, "b1", t + Duration::from_millis(10));
    let waiting = t + Duration::from_secs(60);
    assert!(!seen(&store, CHAT, &root, &["a.md"], waiting));
    // allowed: opens again, under the same call id
    store.command_started(CHAT, "b1", None, waiting);
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["a.md"],
        waiting + Duration::from_millis(50)
    ));
}

#[test]
fn a_command_changed_file_keeps_a_trusted_session_baseline_and_its_diff() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = Instant::now();
    std::fs::write(root.join("a.md"), "one\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "one\ntwo\n").unwrap();
    finish(&store).unwrap();
    // turn 2: a command changes it again
    bash_in(&store, &root);
    store.command_started(CHAT, "b1", None, t);
    std::fs::write(root.join("a.md"), "one\ntwo\nthree\n").unwrap();
    assert!(seen(
        &store,
        CHAT,
        &root,
        &["a.md"],
        t + Duration::from_millis(300)
    ));
    let turn2 = finish(&store).unwrap();
    assert_eq!(file(&turn2, "a.md").origin, ChangeOrigin::Command);
    let s = sess(&store, &root);
    assert_eq!(sess_file(&s, "a.md").origin, ChangeOrigin::Edit);
    assert_eq!(
        sess_file(&s, "a.md").added,
        2,
        "diffed against the text before turn 1"
    );
}

// ---- the timing gap: the pre-image read raced the tool ----

fn cap_input(store: &ChangeStore, root: &Path, tool: &str, input: serde_json::Value) {
    store.capture(CHAT, root, root, tool, &input);
}

fn edit_input(root: &Path, old: &str, new: &str, all: bool) -> serde_json::Value {
    json!({"file_path": path(root, "a.md"), "old_string": old, "new_string": new, "replace_all": all})
}

fn age(root: &Path, rel: &str, secs: u64) {
    let f = std::fs::File::options()
        .write(true)
        .open(root.join(rel))
        .unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_secs(secs))
        .unwrap();
}

#[test]
fn an_edit_that_ran_before_the_read_gets_its_exact_pre_image() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    // the file already holds the edit when it is captured
    std::fs::write(root.join("a.md"), "one\nTWO\nthree\n").unwrap();
    cap_input(
        &store,
        &root,
        "Edit",
        edit_input(&root, "two", "TWO", false),
    );
    let s = finish(&store).unwrap();
    let f = file(&s, "a.md");
    assert_eq!(f.origin, ChangeOrigin::Edit);
    assert_eq!((f.added, f.removed), (1, 1));
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert_eq!(d.files[0].undo, UndoState::Available);
    store
        .revert(CHAT, &s.turn_id, &root, &["a.md".into()])
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("a.md")).unwrap(),
        "one\ntwo\nthree\n"
    );
}

#[test]
fn replace_all_and_multi_edit_races_are_reconstructed() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "dog and dog\n").unwrap();
    cap_input(&store, &root, "Edit", edit_input(&root, "cat", "dog", true));
    let s = finish(&store).unwrap();
    assert_eq!((file(&s, "a.md").added, file(&s, "a.md").removed), (1, 1));
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert!(d.files[0].rows.iter().any(|r| r.text == "cat and cat"));

    std::fs::write(root.join("b.md"), "x c y\n").unwrap();
    let multi = json!({"file_path": path(&root, "b.md"), "edits": [
        {"old_string": "a", "new_string": "b"},
        {"old_string": "b!", "new_string": "c"},
    ]});
    cap_input(&store, &root, "MultiEdit", multi);
    let s = finish(&store).unwrap();
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert!(d.files[0].rows.iter().any(|r| r.text == "x a! y"));
    assert_eq!(d.files[0].undo, UndoState::Available);
}

#[test]
fn an_edit_that_has_not_run_yet_is_captured_as_it_is() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "one\ntwo\n").unwrap();
    cap_input(
        &store,
        &root,
        "Edit",
        edit_input(&root, "two", "TWO", false),
    );
    std::fs::write(root.join("a.md"), "one\nTWO\n").unwrap();
    let s = finish(&store).unwrap();
    assert_eq!(file(&s, "a.md").origin, ChangeOrigin::Edit);
    assert_eq!((file(&s, "a.md").added, file(&s, "a.md").removed), (1, 1));
}

#[test]
fn an_ambiguous_race_is_listed_as_before_unknown_with_no_diff_and_no_undo() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    // "b" occurs twice after the edit: which one was it?
    std::fs::write(root.join("a.md"), "b and b\n").unwrap();
    cap_input(&store, &root, "Edit", edit_input(&root, "x", "b", false));
    let s = finish(&store).unwrap();
    let f = file(&s, "a.md");
    assert_eq!(f.origin, ChangeOrigin::BeforeUnknown);
    assert!(f.no_diff);
    assert_eq!(f.status, ChangeStatus::Modified);
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert!(d.files[0].rows.is_empty());
    assert_eq!(d.files[0].undo, UndoState::Unavailable);
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["a.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Unavailable);
    assert_eq!(
        sess_file(&sess(&store, &root), "a.md").origin,
        ChangeOrigin::BeforeUnknown
    );
}

#[test]
fn a_write_that_ran_before_the_read_is_kept_as_before_unknown() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "written\n").unwrap();
    cap_input(
        &store,
        &root,
        "Write",
        json!({"file_path": path(&root, "a.md"), "content": "written\n"}),
    );
    let s = finish(&store).unwrap();
    let f = file(&s, "a.md");
    assert_eq!(f.origin, ChangeOrigin::BeforeUnknown);
    assert!(f.no_diff);
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert_eq!(d.files[0].undo, UndoState::Unavailable);
    // a Write over different text is a normal record
    std::fs::write(root.join("b.md"), "old\n").unwrap();
    cap_input(
        &store,
        &root,
        "Write",
        json!({"file_path": path(&root, "b.md"), "content": "new\n"}),
    );
    std::fs::write(root.join("b.md"), "new\n").unwrap();
    assert_eq!(
        file(&finish(&store).unwrap(), "b.md").origin,
        ChangeOrigin::Edit
    );
}

#[test]
fn an_old_file_never_looks_raced() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    // a failed re-application of an old edit, and a Write of unchanged content: nothing happened
    std::fs::write(root.join("a.md"), "one\nTWO\n").unwrap();
    age(&root, "a.md", 3600);
    std::fs::write(root.join("w.md"), "same\n").unwrap();
    age(&root, "w.md", 3600);
    cap_input(
        &store,
        &root,
        "Edit",
        edit_input(&root, "two", "TWO", false),
    );
    cap_input(
        &store,
        &root,
        "Write",
        json!({"file_path": path(&root, "w.md"), "content": "same\n"}),
    );
    assert!(finish(&store).is_none());
}

// ---- a baseline vouched for by the provider point (ADR 2026-11-23) ----

fn txt(s: &str) -> Baseline {
    Baseline::Bytes(s.as_bytes().to_vec())
}

fn one_command(store: &ChangeStore, root: &Path) -> Instant {
    let t = Instant::now();
    bash_in(store, root);
    store.command_started(CHAT, "b1", None, t);
    t
}

fn end_command(store: &ChangeStore, t: Instant) {
    store.command_finished(CHAT, "b1", t + Duration::from_millis(500));
}

#[test]
fn a_command_file_with_a_text_baseline_gets_a_diff_counts_and_an_undo_that_restores_it() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    let t = one_command(&store, &root);
    let answers = [("n.md", txt("before\n"))];
    assert!(seen_asking(
        &store,
        &root,
        &["n.md"],
        t + Duration::from_millis(400),
        &answers
    ));
    end_command(&store, t);
    let s = finish(&store).unwrap();
    let f = file(&s, "n.md");
    assert_eq!(f.origin, ChangeOrigin::Command, "still marked by command");
    assert!(!f.no_diff);
    assert_eq!((f.added, f.removed), (1, 1));
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert!(!d.files[0].rows.is_empty());
    assert_eq!(d.files[0].undo, UndoState::Available);
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["n.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Reverted);
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        "before\n"
    );
}

#[test]
fn undo_of_a_command_change_refuses_after_a_later_edit() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    let t = one_command(&store, &root);
    let answers = [("n.md", txt("before\n"))];
    seen_asking(&store, &root, &["n.md"], t, &answers);
    end_command(&store, t);
    let s = finish(&store).unwrap();
    std::fs::write(root.join("n.md"), "the user's later edit\n").unwrap();
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["n.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::ChangedSince);
    assert_eq!(
        std::fs::read_to_string(root.join("n.md")).unwrap(),
        "the user's later edit\n"
    );
}

#[test]
fn an_absent_baseline_shows_the_file_as_created_and_undo_deletes_it() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    let t = one_command(&store, &root);
    std::fs::write(root.join("made.md"), "new\n").unwrap();
    seen_asking(
        &store,
        &root,
        &["made.md"],
        t,
        &[("made.md", Baseline::Absent)],
    );
    end_command(&store, t);
    let s = finish(&store).unwrap();
    assert_eq!(file(&s, "made.md").status, ChangeStatus::Added);
    assert_eq!(file(&s, "made.md").added, 1);
    let out = store
        .revert(CHAT, &s.turn_id, &root, &["made.md".into()])
        .unwrap();
    assert_eq!(out[0].result, RevertResult::Reverted);
    assert!(!root.join("made.md").exists());
}

#[test]
fn no_answer_keeps_todays_row_and_the_asker_is_asked_once_per_new_path() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    let t = one_command(&store, &root);
    let asked = std::cell::Cell::new(0);
    let ask = |rels: &[String]| {
        asked.set(asked.get() + rels.len());
        vec![None; rels.len()]
    };
    let p = [root.join("n.md")];
    store.record_command_changes(CHAT, &root, &p, t, &ask);
    store.record_command_changes(CHAT, &root, &p, t, &ask);
    assert_eq!(asked.get(), 1, "known to turn and session: not asked again");
    end_command(&store, t);
    let s = finish(&store).unwrap();
    let f = file(&s, "n.md");
    assert!(f.no_diff && f.origin == ChangeOrigin::Command);
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert_eq!(d.files[0].undo, UndoState::Unavailable);
}

#[test]
fn an_edit_snapshotted_file_keeps_its_snapshot_and_is_not_asked() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "one\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "two\n").unwrap();
    let t = one_command(&store, &root);
    let ask = |_: &[String]| -> Vec<Option<Baseline>> { panic!("the turn tracks it already") };
    store.record_command_changes(CHAT, &root, &[root.join("a.md")], t, &ask);
    end_command(&store, t);
    let s = finish(&store).unwrap();
    assert_eq!(file(&s, "a.md").origin, ChangeOrigin::Edit);
    assert_eq!((file(&s, "a.md").added, file(&s, "a.md").removed), (1, 1));
}

#[test]
fn an_answer_over_the_file_cap_is_no_answer() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    let t = one_command(&store, &root);
    let huge = "x".repeat(MAX_FILE_BYTES as usize + 1);
    seen_asking(
        &store,
        &root,
        &["n.md"],
        t,
        &[("n.md", Baseline::Bytes(huge.into_bytes()))],
    );
    end_command(&store, t);
    assert!(file(&finish(&store).unwrap(), "n.md").no_diff);
}

#[test]
fn the_session_baseline_is_the_answer_of_the_first_turn_that_touched_the_path() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    // turn 1: the command rewrites v0 into v1
    std::fs::write(root.join("n.md"), "v1\n").unwrap();
    let t = one_command(&store, &root);
    seen_asking(&store, &root, &["n.md"], t, &[("n.md", txt("v0\n"))]);
    end_command(&store, t);
    finish(&store).unwrap();
    // turn 2: another command, whose turn started at v1
    std::fs::write(root.join("n.md"), "v2\n").unwrap();
    let t = one_command(&store, &root);
    seen_asking(&store, &root, &["n.md"], t, &[("n.md", txt("v1\n"))]);
    end_command(&store, t);
    let s = finish(&store).unwrap();
    // the card of turn 2 diffs against v1, the session against v0
    let d = store.detail(CHAT, &s.turn_id, &root).unwrap();
    assert_eq!(file(&s, "n.md").origin, ChangeOrigin::Command);
    assert!(!d.files[0].rows.is_empty());
    let sd = store.session_detail(CHAT, &root).unwrap();
    assert!(!sd.files[0].summary.no_diff);
    let texts: String = sd.files[0]
        .rows
        .iter()
        .map(|r| format!("{r:?}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(texts.contains("v0") && texts.contains("v2") && !texts.contains("v1"));
}

#[test]
fn a_session_baseline_from_an_answer_marks_by_command_with_counts() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    let t = one_command(&store, &root);
    seen_asking(&store, &root, &["n.md"], t, &[("n.md", txt("before\n"))]);
    let ss = sess(&store, &root);
    let f = sess_file(&ss, "n.md");
    assert_eq!(f.origin, ChangeOrigin::Command);
    assert_eq!((f.added, f.removed), (1, 1));
}

#[test]
fn a_path_writer_wrote_itself_since_the_turn_began_is_never_asked_about() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("mine.md"), "the user's edit, after the command\n").unwrap();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    store.begin_turn(CHAT);
    let t = one_command(&store, &root);
    // the editor saved mine.md after the turn began
    store.note_own_writes(CHAT, &root, &[root.join("mine.md")]);
    let answers = [
        ("mine.md", txt("before the user's edit\n")),
        ("n.md", txt("before\n")),
    ];
    seen_asking(&store, &root, &["mine.md", "n.md"], t, &answers);
    end_command(&store, t);
    let s = finish(&store).unwrap();
    assert!(
        file(&s, "mine.md").no_diff,
        "an own write is not vouched for"
    );
    assert!(!file(&s, "mine.md").before_known);
    assert!(!file(&s, "n.md").no_diff);
    assert!(file(&s, "n.md").before_known);
    // a new turn forgets them
    store.begin_turn(CHAT);
    let t = one_command(&store, &root);
    std::fs::write(root.join("mine.md"), "later\n").unwrap();
    seen_asking(&store, &root, &["mine.md"], t, &answers);
    end_command(&store, t);
    assert!(!file(&finish(&store).unwrap(), "mine.md").no_diff);
}

#[test]
fn a_path_another_chats_open_turn_tracks_is_not_asked_about() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("shared.md"), "edited by the other chat\n").unwrap();
    std::fs::write(root.join("mine.md"), "after\n").unwrap();
    // the other chat's turn already tracks shared.md
    store.capture(
        "chat-2",
        &root,
        &root,
        "Edit",
        &json!({"file_path": path(&root, "shared.md")}),
    );
    let t = one_command(&store, &root);
    let asked = std::cell::RefCell::new(Vec::<String>::new());
    let ask = |rels: &[String]| {
        asked.borrow_mut().extend(rels.iter().cloned());
        vec![None; rels.len()]
    };
    let paths = [root.join("shared.md"), root.join("mine.md")];
    store.record_command_changes(CHAT, &root, &paths, t, &ask);
    assert_eq!(*asked.borrow(), vec!["mine.md".to_string()]);
}

#[test]
fn asking_stops_once_the_answers_fill_the_room_the_store_has() {
    let (_d, root) = vault();
    // room for about three of the answers below
    let store = ChangeStore::with_cap(100);
    let rels: Vec<String> = (0..40).map(|i| format!("f{i}.md")).collect();
    for rel in &rels {
        std::fs::write(root.join(rel), "after\n").unwrap();
    }
    let t = one_command(&store, &root);
    let asked = std::cell::Cell::new(0usize);
    let ask = |batch: &[String]| {
        asked.set(asked.get() + batch.len());
        batch.iter().map(|_| Some(txt(&"x".repeat(30)))).collect()
    };
    let paths: Vec<PathBuf> = rels.iter().map(|r| root.join(r)).collect();
    store.record_command_changes(CHAT, &root, &paths, t, &ask);
    assert!(
        asked.get() <= 8,
        "one batch, then it stops: {}",
        asked.get()
    );
    end_command(&store, t);
    let s = finish(&store).unwrap();
    let known = s.files.iter().filter(|f| f.before_known).count();
    assert!((1..=3).contains(&known), "{known} answers kept");
    assert_eq!(s.files.len(), 40, "every file is still listed");
}

#[test]
fn an_answer_that_is_not_text_is_no_answer() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    let t = one_command(&store, &root);
    seen_asking(
        &store,
        &root,
        &["n.md"],
        t,
        &[("n.md", Baseline::Bytes(vec![b'a', 0, b'b']))],
    );
    end_command(&store, t);
    assert!(file(&finish(&store).unwrap(), "n.md").no_diff);
}

#[test]
fn only_a_command_file_with_a_vouched_before_says_before_known() {
    let (_d, root) = vault();
    let store = ChangeStore::default();
    std::fs::write(root.join("a.md"), "one\n").unwrap();
    cap(&store, &root, "Edit", "a.md");
    std::fs::write(root.join("a.md"), "two\n").unwrap();
    std::fs::write(root.join("n.md"), "after\n").unwrap();
    let t = one_command(&store, &root);
    seen_asking(&store, &root, &["n.md"], t, &[("n.md", txt("before\n"))]);
    end_command(&store, t);
    let s = finish(&store).unwrap();
    assert!(file(&s, "n.md").before_known);
    assert!(!file(&s, "a.md").before_known, "an edit is not marked");
}
