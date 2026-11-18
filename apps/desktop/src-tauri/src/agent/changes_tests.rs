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
