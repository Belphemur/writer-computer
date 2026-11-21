//! The 3-way merge: front matter per property, line merge with adjacent edits, true overlaps,
//! JSON per key, binaries, delete against edit.

use super::*;

fn clean(m: &Merged) -> String {
    match m {
        Merged::Clean { bytes: Some(b), .. } => String::from_utf8(b.clone()).unwrap(),
        other => panic!("not clean: {other:?}"),
    }
}

fn merge(path: &str, b: &str, m: &str, t: &str) -> Merged {
    merge_file(
        path,
        Some(b.as_bytes()),
        Some(m.as_bytes()),
        Some(t.as_bytes()),
    )
}

const NOTE: &str =
    "---\nstatus: draft\ntags: [a]\n# a comment\nowner: me\n---\nl1\nl2\nl3\nl4\nl5\n";

#[test]
fn properties_changed_on_different_sides_merge_and_untouched_bytes_stay() {
    let mine = NOTE.replace("status: draft", "status: done");
    let theirs = NOTE.replace("tags: [a]", "tags: [a, b]");
    let out = clean(&merge("n.md", NOTE, &mine, &theirs));
    assert_eq!(
        out,
        "---\nstatus: done\ntags: [a, b]\n# a comment\nowner: me\n---\nl1\nl2\nl3\nl4\nl5\n"
    );
}

#[test]
fn a_property_added_on_both_sides_with_the_same_value_merges() {
    let both = NOTE.replace("owner: me\n", "owner: me\nrating: 5\n");
    assert_eq!(clean(&merge("n.md", NOTE, &both, &both)), both);
    let theirs = NOTE.replace("owner: me\n", "owner: me\nrating: 5\n");
    let mine = NOTE.replace("owner: me\n", "owner: me\nrating: 5\n");
    assert_eq!(clean(&merge("n.md", NOTE, &mine, &theirs)), mine);
}

#[test]
fn a_property_new_on_their_side_comes_after_mine() {
    let theirs = NOTE.replace("owner: me\n", "owner: me\nrating: 5\n");
    let mine = NOTE.replace("status: draft", "status: done");
    let out = clean(&merge("n.md", NOTE, &mine, &theirs));
    assert!(
        out.contains("status: done\n") && out.ends_with("rating: 5\n---\nl1\nl2\nl3\nl4\nl5\n"),
        "{out}"
    );
}

#[test]
fn a_deleted_property_goes_when_the_other_side_left_it() {
    let mine = NOTE.replace("owner: me\n", "");
    let theirs = NOTE.replace("status: draft", "status: done");
    let out = clean(&merge("n.md", NOTE, &mine, &theirs));
    assert!(
        !out.contains("owner") && out.contains("status: done"),
        "{out}"
    );
}

#[test]
fn the_same_property_changed_differently_conflicts_on_it_alone() {
    let mine = NOTE.replace("status: draft", "status: review");
    let theirs = NOTE.replace("status: draft", "status: done");
    match merge("n.md", NOTE, &mine, &theirs) {
        Merged::Conflict(c) => {
            assert_eq!(c.properties.len(), 1);
            assert_eq!(c.properties[0].name, "status");
            assert_eq!(c.properties[0].mine.as_deref(), Some("status: review\n"));
            assert_eq!(c.properties[0].theirs.as_deref(), Some("status: done\n"));
            assert!(c.hunks.is_empty());
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_note_gaining_front_matter_on_one_side_keeps_it() {
    let base = "body\n";
    let mine = "---\nstatus: draft\n---\nbody\n";
    assert_eq!(
        clean(&merge("n.md", base, mine, "body, edited\n")),
        "---\nstatus: draft\n---\nbody, edited\n"
    );
}

#[test]
fn adjacent_but_separate_edits_merge_and_overlaps_do_not() {
    let base = "a\nb\nc\nd\n";
    assert_eq!(
        clean(&merge("x.txt", base, "A\nb\nc\nd\n", "a\nB\nc\nd\n")),
        "A\nB\nc\nd\n"
    );
    // an edit and an insertion next to it
    assert_eq!(
        clean(&merge("x.txt", base, "a\nb\nc\nd\n", "a\nb\nX\nc\nd\n")),
        "a\nb\nX\nc\nd\n"
    );
    // both inserted at the same place, differently: overlap
    match merge("x.txt", base, "a\nM\nb\nc\nd\n", "a\nT\nb\nc\nd\n") {
        Merged::Conflict(c) => {
            assert_eq!(c.hunks.len(), 1);
            assert_eq!(
                (c.hunks[0].mine.as_str(), c.hunks[0].theirs.as_str()),
                ("M\n", "T\n")
            );
        }
        other => panic!("{other:?}"),
    }
    // the same line changed to different text
    assert!(matches!(
        merge("x.txt", base, "a\nM\nc\nd\n", "a\nT\nc\nd\n"),
        Merged::Conflict(_)
    ));
    // the same change on both sides is no conflict
    assert_eq!(
        clean(&merge("x.txt", base, "a\nS\nc\nd\n", "a\nS\nc\nd\n")),
        "a\nS\nc\nd\n"
    );
    // an edit inside a range the other side deleted
    assert!(matches!(
        merge("x.txt", base, "a\nb2\nc\nd\n", "a\nd\n"),
        Merged::Conflict(_)
    ));
}

#[test]
fn several_hunks_in_one_overlap_group_conflict_as_one() {
    let base = "1\n2\n3\n4\n5\n6\n";
    // mine edits lines 1 and 5, theirs rewrites 2..5: one group through the base
    match merge("x.txt", base, "ONE\n2\n3\n4\nFIVE\n6\n", "1\nx\n6\n") {
        Merged::Conflict(c) => assert_eq!(c.hunks.len(), 1),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_missing_final_newline_is_just_another_difference() {
    let base = "a\nb\n";
    assert_eq!(
        clean(&merge("x.txt", base, "A\nb\n", "a\nb\nc\n")),
        "A\nb\nc\n"
    );
}

#[test]
fn json_files_fall_back_to_a_merge_per_top_level_key() {
    let base = r#"{"a":1,"b":2,"c":3}"#;
    let mine = r#"{"a":10,"b":2,"c":3}"#;
    let theirs = r#"{"a":1,"b":2,"c":30,"d":4}"#;
    let out = clean(&merge("data.json", base, mine, theirs));
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v, serde_json::json!({"a":10,"b":2,"c":30,"d":4}));
    // the same key changed differently still conflicts
    assert!(matches!(
        merge(
            "data.json",
            base,
            r#"{"a":5,"b":2,"c":3}"#,
            r#"{"a":6,"b":2,"c":3}"#
        ),
        Merged::Conflict(_)
    ));
    // a pretty file whose edits do not overlap line by line is a plain line merge (formatting kept)
    let pretty = "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n";
    let out = clean(&merge(
        "p.json",
        pretty,
        &pretty.replace("\"a\": 1", "\"a\": 9"),
        &pretty.replace("\"c\": 3", "\"c\": 8"),
    ));
    assert_eq!(out, "{\n  \"a\": 9,\n  \"b\": 2,\n  \"c\": 8\n}\n");
}

#[test]
fn binaries_keep_theirs_at_the_path_and_mine_beside_it() {
    let (b, m, t) = (&[0u8, 1][..], &[0u8, 2][..], &[0u8, 3][..]);
    assert_eq!(
        merge_file("a.png", Some(b), Some(m), Some(t)),
        Merged::BinaryCopy
    );
    // only one side changed: no copy
    assert_eq!(
        merge_file("a.png", Some(b), Some(b), Some(t)),
        Merged::Clean {
            bytes: Some(t.to_vec()),
            note: None
        }
    );
    assert_eq!(
        conflict_copy_name("img/pic.png", "Studio/Mac (2)", "2026-11-20 1403"),
        "img/pic (conflict StudioMac 2 2026-11-20 1403).png"
    );
    assert_eq!(
        conflict_copy_name("README", "A", "s"),
        "README (conflict A s)"
    );
}

#[test]
fn a_delete_against_an_edit_keeps_the_edit() {
    let (b, e) = ("one\n", "one edited\n");
    for (mine, theirs) in [(None, Some(e)), (Some(e), None)] {
        let m = merge_file(
            "a.md",
            Some(b.as_bytes()),
            mine.map(str::as_bytes),
            theirs.map(str::as_bytes),
        );
        assert_eq!(
            m,
            Merged::Clean {
                bytes: Some(e.as_bytes().to_vec()),
                note: Some(Note::DeleteEdit)
            }
        );
    }
    // both deleted, or deleted on one side and untouched on the other
    assert_eq!(
        merge_file("a.md", Some(b.as_bytes()), None, None),
        Merged::Clean {
            bytes: None,
            note: None
        }
    );
    assert_eq!(
        merge_file("a.md", Some(b.as_bytes()), None, Some(b.as_bytes())),
        Merged::Clean {
            bytes: None,
            note: None
        }
    );
}

#[test]
fn two_new_files_with_different_text_conflict_and_equal_ones_do_not() {
    assert!(matches!(
        merge_file("n.md", None, Some(b"mine\n"), Some(b"theirs\n")),
        Merged::Conflict(_)
    ));
    assert_eq!(
        clean(&merge_file("n.md", None, Some(b"same\n"), Some(b"same\n"))),
        "same\n"
    );
}

#[test]
fn a_conflict_never_comes_with_text_that_has_markers() {
    for m in [
        merge(
            "n.md",
            NOTE,
            &NOTE.replace("l2", "M"),
            &NOTE.replace("l2", "T"),
        ),
        merge("x.txt", "a\n", "m\n", "t\n"),
    ] {
        assert!(matches!(m, Merged::Conflict(_)), "{m:?}");
    }
}
