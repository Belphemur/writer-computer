//! Settling conflicts against local bare remotes (the same two-device world as the sync tests):
//! the view's pieces, a result built from hunk choices, an edited result, a property choice, Save
//! committing and resuming the sync, Cancel, binaries and a rename conflict's path choice.

use super::*;
use crate::git::sync::tests::{have_git, pair, remote_file, World};
use crate::git::{self, conflicts};

macro_rules! need_git {
    () => {
        if !have_git() {
            eprintln!("skipped: no git binary");
            return;
        }
    };
}

const NOTE: &str = "---\nstatus: draft\ntags: [a]\n---\n# Title\n\none\ntwo\nthree\nfour\nfive\n";

fn no_markers(text: &str) {
    assert!(
        !text.contains("<<<<<<<") && !text.contains(">>>>>>>") && !text.contains("=======\n"),
        "{text}"
    );
}

/// The body a user gets from taking one side for every overlap.
fn body_of(view: &View, take: impl Fn(&merge::HunkConflict) -> String) -> String {
    view.parts
        .iter()
        .map(|p| match p {
            Part::Text(t) => t.clone(),
            Part::Conflict(c) => take(c),
        })
        .collect()
}

/// B has a note in conflict with A's: the same line edited on both sides.
fn conflicted(
    w: &World,
) -> (
    crate::git::sync::tests::Device,
    crate::git::sync::tests::Device,
) {
    let (a, b) = pair(w, &[("Note.md", NOTE), ("Other.md", "other\n")]);
    a.write("Note.md", &NOTE.replace("three", "three from A"));
    a.commit();
    a.ok();
    b.write("Note.md", &NOTE.replace("three", "three from B"));
    b.write("Fresh.md", "fresh\n");
    b.commit();
    let r = b.ok();
    assert_eq!(r.conflicts.len(), 1, "{:?}", r.conflicts);
    (a, b)
}

#[test]
fn the_view_lays_out_the_overlap_and_changes_nothing_on_disk() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let before = b.read("Note.md");
    let v = open(&b.root, "Note.md", None).unwrap();
    assert!(v.markdown && v.properties.is_empty());
    let hunks: Vec<_> = v
        .parts
        .iter()
        .filter_map(|p| match p {
            Part::Conflict(c) => Some(c),
            _ => None,
        })
        .collect();
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].mine, "three from B\n");
    assert_eq!(hunks[0].theirs, "three from A\n");
    assert_eq!(hunks[0].base, "three\n");
    // never a marker, and the file is untouched until Save
    assert_eq!(b.read("Note.md"), before);
    no_markers(&b.read("Note.md"));
    assert_eq!(v.mine, before);
}

#[test]
fn the_view_shows_the_buffer_the_user_has_not_the_file() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let buffer = NOTE
        .replace("three", "three from B")
        .replace("five", "FIVE typed");
    let v = open(&b.root, "Note.md", Some(&buffer)).unwrap();
    assert_eq!(v.mine, buffer);
    let mine = body_of(&v, |c| c.mine.clone());
    assert!(
        mine.contains("FIVE typed") && mine.contains("three from B"),
        "{mine}"
    );
}

fn saved(
    b: &crate::git::sync::tests::Device,
    body: &str,
    picks: &[(String, Side)],
    final_path: Option<&str>,
) -> Result<()> {
    let v = open(&b.root, "Note.md", None).unwrap();
    save(
        &b.root,
        "Note.md",
        &Choice {
            mine: &v.mine,
            body,
            picks,
            final_path,
        },
        "B",
        None,
    )
}

#[test]
fn take_mine_take_theirs_and_take_both_make_exact_results() {
    need_git!();
    for (name, pick, expect) in [
        ("mine", 0, "three from B\n"),
        ("theirs", 1, "three from A\n"),
        ("both", 2, "three from B\nthree from A\n"),
    ] {
        let w = World::new();
        let (_a, b) = conflicted(&w);
        let v = open(&b.root, "Note.md", None).unwrap();
        let body = body_of(&v, |c| match pick {
            0 => c.mine.clone(),
            1 => c.theirs.clone(),
            _ => format!("{}{}", c.mine, c.theirs),
        });
        saved(&b, &body, &[], None).unwrap();
        let want = NOTE.replace("three\n", expect);
        assert_eq!(b.read("Note.md"), want, "take {name}");
        no_markers(&b.read("Note.md"));
    }
}

#[test]
fn an_edited_result_is_saved_as_typed() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    saved(&b, "# Title\n\nwritten by hand\n", &[], None).unwrap();
    assert_eq!(
        b.read("Note.md"),
        "---\nstatus: draft\ntags: [a]\n---\n# Title\n\nwritten by hand\n"
    );
}

#[test]
fn save_commits_the_file_forgets_the_conflict_and_the_next_sync_pushes_it() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let v = open(&b.root, "Note.md", None).unwrap();
    let body = body_of(&v, |c| format!("{}{}", c.mine, c.theirs));
    saved(&b, &body, &[], None).unwrap();
    assert!(conflicts::paths(&b.root).is_empty());
    let log = b.log();
    assert!(
        log.last().is_some_and(|l| l.ends_with("Merge Note")),
        "{log:?}"
    );
    let status = git::status(
        &b.root,
        &git::IdentityCache::default(),
        true,
        crate::git::Lfs::OFF,
    )
    .unwrap();
    assert!(status.changes.is_empty() && status.conflicts.is_empty());
    let r = b.ok();
    assert_eq!(r.pushed, 1, "{r:?}");
    assert_eq!(remote_file(&w, "Note.md").unwrap(), b.read("Note.md"));
    // and the other device takes it without a conflict
    let a = &_a;
    let r = a.ok();
    assert!(r.conflicts.is_empty());
    assert_eq!(a.read("Note.md"), b.read("Note.md"));
}

#[test]
fn a_conflicting_property_needs_a_choice_and_takes_that_side() {
    need_git!();
    let w = World::new();
    let (a, b) = pair(&w, &[("Note.md", NOTE)]);
    a.write("Note.md", &NOTE.replace("status: draft", "status: done"));
    a.commit();
    a.ok();
    b.write(
        "Note.md",
        &NOTE
            .replace("status: draft", "status: review")
            .replace("five", "FIVE"),
    );
    b.commit();
    let r = b.ok();
    assert_eq!(r.conflicts[0].properties, vec!["status".to_string()]);
    let v = open(&b.root, "Note.md", None).unwrap();
    assert_eq!(v.properties.len(), 1);
    assert_eq!(v.properties[0].mine.as_deref(), Some("status: review\n"));
    assert_eq!(v.properties[0].theirs.as_deref(), Some("status: done\n"));
    let body = body_of(&v, |c| c.mine.clone());
    // no choice yet: refused, nothing written
    let err = save(
        &b.root,
        "Note.md",
        &Choice {
            mine: &v.mine,
            body: &body,
            picks: &[],
            final_path: None,
        },
        "B",
        None,
    )
    .unwrap_err();
    assert!(
        matches!(err, Error::Undecided(ref n) if n == "status"),
        "{err}"
    );
    assert!(b.read("Note.md").contains("status: review"));
    assert_eq!(conflicts::paths(&b.root).len(), 1);
    // theirs: the property is theirs, the body is what the editor held
    let picks = [("status".to_string(), Side::Theirs)];
    save(
        &b.root,
        "Note.md",
        &Choice {
            mine: &v.mine,
            body: &body,
            picks: &picks,
            final_path: None,
        },
        "B",
        None,
    )
    .unwrap();
    let text = b.read("Note.md");
    assert!(
        text.contains("status: done") && text.contains("FIVE"),
        "{text}"
    );
    assert!(text.contains("tags: [a]"));
}

#[test]
fn cancel_is_nothing_the_file_stays_mine_conflicted_and_unpushed() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let mine = b.read("Note.md");
    // the view was opened and closed: nothing was called that writes
    open(&b.root, "Note.md", None).unwrap();
    for _ in 0..2 {
        let r = b.ok();
        assert_eq!(r.pushed, 0, "{r:?}");
    }
    assert_eq!(b.read("Note.md"), mine);
    assert_eq!(conflicts::paths(&b.root), vec!["Note.md".to_string()]);
    assert!(b.commit().is_none());
    assert!(remote_file(&w, "Note.md").unwrap().contains("three from A"));
}

#[test]
fn a_conflict_stays_while_the_remote_moves_on_and_the_view_shows_the_latest_theirs() {
    need_git!();
    let w = World::new();
    let (a, b) = conflicted(&w);
    let mine = b.read("Note.md");
    a.write(
        "Note.md",
        &NOTE
            .replace("three", "three from A")
            .replace("five", "FIVE from A"),
    );
    a.commit();
    a.ok();
    b.ok();
    assert_eq!(b.read("Note.md"), mine, "the user's file is not touched");
    let v = open(&b.root, "Note.md", None).unwrap();
    let theirs = body_of(&v, |c| c.theirs.clone());
    assert!(theirs.contains("FIVE from A"), "{theirs}");
}

#[test]
fn a_whole_side_can_be_taken_for_agents() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    take(&b.root, "Note.md", Take::Theirs, "B", None).unwrap();
    assert_eq!(b.read("Note.md"), NOTE.replace("three", "three from A"));
    assert!(conflicts::paths(&b.root).is_empty());
    assert!(matches!(
        take(&b.root, "Note.md", Take::Mine, "B", None),
        Err(Error::NotConflicted)
    ));
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let mine = b.read("Note.md");
    take(&b.root, "Note.md", Take::Mine, "B", None).unwrap();
    assert_eq!(b.read("Note.md"), mine);
    assert!(conflicts::paths(&b.root).is_empty());
    assert_eq!(b.ok().pushed, 1);
    assert_eq!(remote_file(&w, "Note.md").unwrap(), mine);
}

fn binary_conflict(w: &World) -> (crate::git::sync::tests::Device, String) {
    let (a, b) = pair(w, &[]);
    a.write_bytes("img/pic.png", &[0, 1, 2, 3]);
    a.commit();
    a.ok();
    b.ok();
    a.write_bytes("img/pic.png", &[0, 9, 9, 9]);
    a.commit();
    a.ok();
    b.write_bytes("img/pic.png", &[0, 5, 5, 5]);
    b.commit();
    let r = b.ok();
    (b, r.copies[0].1.clone())
}

#[test]
fn a_binary_keeps_mine_theirs_or_both() {
    need_git!();
    let read = |b: &crate::git::sync::tests::Device, p: &str| std::fs::read(b.root.join(p)).ok();
    // mine: the copy goes over the file and is gone
    let w = World::new();
    let (b, copy) = binary_conflict(&w);
    take(&b.root, "img/pic.png", Take::Mine, "B", None).unwrap();
    assert_eq!(read(&b, "img/pic.png"), Some(vec![0, 5, 5, 5]));
    assert_eq!(read(&b, &copy), None);
    assert!(conflicts::read(&b.root).copies.is_empty());
    assert_eq!(b.ok().pushed, 1);
    // theirs: the copy is dropped
    let w = World::new();
    let (b, copy) = binary_conflict(&w);
    take(&b.root, "img/pic.png", Take::Theirs, "B", None).unwrap();
    assert_eq!(read(&b, "img/pic.png"), Some(vec![0, 9, 9, 9]));
    assert_eq!(read(&b, &copy), None);
    // both: nothing moves, the notice goes
    let w = World::new();
    let (b, copy) = binary_conflict(&w);
    take(&b.root, "img/pic.png", Take::Both, "B", None).unwrap();
    assert_eq!(read(&b, "img/pic.png"), Some(vec![0, 9, 9, 9]));
    assert_eq!(read(&b, &copy), Some(vec![0, 5, 5, 5]));
    assert!(conflicts::read(&b.root).copies.is_empty());
}

fn rename_conflict(w: &World) -> crate::git::sync::tests::Device {
    let body = "one\ntwo\nthree\nfour\nfive\nsix\n";
    let (a, b) = pair(w, &[("Note.md", body)]);
    std::fs::remove_file(a.root.join("Note.md")).unwrap();
    a.write("FromA.md", body);
    a.commit();
    a.ok();
    std::fs::remove_file(b.root.join("Note.md")).unwrap();
    b.write("FromB.md", &body.replace("six", "SIX from B"));
    b.commit();
    let r = b.ok();
    assert_eq!(r.conflicts[0].theirs_path.as_deref(), Some("FromA.md"));
    b
}

#[test]
fn a_rename_conflict_is_a_path_choice_and_the_other_name_goes() {
    need_git!();
    // mine's name: its edit merges over the other side's unchanged content
    let w = World::new();
    let b = rename_conflict(&w);
    let v = open(&b.root, "FromB.md", None).unwrap();
    assert_eq!(v.theirs_path.as_deref(), Some("FromA.md"));
    let body = body_of(&v, |c| c.mine.clone());
    assert!(body.contains("SIX from B"), "{body}");
    save(
        &b.root,
        "FromB.md",
        &Choice {
            mine: &v.mine,
            body: &body,
            picks: &[],
            final_path: Some("FromB.md"),
        },
        "B",
        None,
    )
    .unwrap();
    assert!(b.root.join("FromB.md").exists() && !b.root.join("FromA.md").exists());
    assert_eq!(b.ok().pushed, 1);
    assert!(remote_file(&w, "FromB.md").is_some() && remote_file(&w, "FromA.md").is_none());
    // theirs' name
    let w = World::new();
    let b = rename_conflict(&w);
    let v = open(&b.root, "FromB.md", None).unwrap();
    let body = body_of(&v, |c| c.mine.clone());
    save(
        &b.root,
        "FromB.md",
        &Choice {
            mine: &v.mine,
            body: &body,
            picks: &[],
            final_path: Some("FromA.md"),
        },
        "B",
        None,
    )
    .unwrap();
    assert!(b.root.join("FromA.md").exists() && !b.root.join("FromB.md").exists());
    assert!(b.read("FromA.md").contains("SIX from B"));
    // a path that is neither is refused
    let w = World::new();
    let b = rename_conflict(&w);
    let err = take(&b.root, "FromB.md", Take::Both, "B", None).unwrap_err();
    assert!(matches!(err, Error::NotText));
    let v = open(&b.root, "FromB.md", None).unwrap();
    let err = save(
        &b.root,
        "FromB.md",
        &Choice {
            mine: &v.mine,
            body: "x",
            picks: &[],
            final_path: Some("Elsewhere.md"),
        },
        "B",
        None,
    )
    .unwrap_err();
    assert!(matches!(err, Error::BadPath));
}

#[test]
fn the_editors_are_told_before_the_files_are_written() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let told = std::cell::RefCell::new(Vec::<String>::new());
    let announce = |paths: &[String]| told.borrow_mut().extend(paths.iter().cloned());
    let v = open(&b.root, "Note.md", None).unwrap();
    save(
        &b.root,
        "Note.md",
        &Choice {
            mine: &v.mine,
            body: "# Title\n",
            picks: &[],
            final_path: None,
        },
        "B",
        Some(&announce),
    )
    .unwrap();
    assert_eq!(told.into_inner(), vec!["Note.md".to_string()]);
}

#[test]
fn edits_made_after_the_view_opened_survive_save_or_stop_it() {
    need_git!();
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let v = open(&b.root, "Note.md", None).unwrap();
    let body = body_of(&v, |c| c.theirs.clone());
    // the editor kept saving while the view was open: a line far from the overlap
    let later = format!("{}typed later\n", v.mine);
    b.write("Note.md", &later);
    let choice = Choice {
        mine: &v.mine,
        body: &body,
        picks: &[],
        final_path: None,
    };
    save(&b.root, "Note.md", &choice, "B", None).unwrap();
    let text = b.read("Note.md");
    assert!(text.contains("typed later"), "{text}");
    assert!(text.contains("three from A"), "{text}");

    // the same line changed again meanwhile: nothing is written, the conflict stays
    let w = World::new();
    let (_a, b) = conflicted(&w);
    let v = open(&b.root, "Note.md", None).unwrap();
    let body = body_of(&v, |c| c.theirs.clone());
    let later = v.mine.replace("three from B", "three from B, rewritten");
    b.write("Note.md", &later);
    let err = save(
        &b.root,
        "Note.md",
        &Choice {
            mine: &v.mine,
            body: &body,
            picks: &[],
            final_path: None,
        },
        "B",
        None,
    )
    .unwrap_err();
    assert!(matches!(err, Error::Changed), "{err}");
    assert_eq!(b.read("Note.md"), later);
    assert!(conflicts::find(&b.root, "Note.md").is_some());
}
