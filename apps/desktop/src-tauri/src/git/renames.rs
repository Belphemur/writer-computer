//! Renames among the changes of one commit or of a range (spec `SPECs/git-sync-spec.md` "Merge",
//! "Rename"): the replay follows a file that was renamed on one side while it was edited on the
//! other. Pure and Tauri-free: it pairs the deleted and the added files of a list of
//! [`TreeChange`]s, nothing here opens a repository.
//!
//! A pair is a rename when, in this order of trust:
//!
//! 1. the commit says so (`Writer-Move-From` / `Writer-Move-To`, Writer's own moves);
//! 2. both sides are the same blob (git's exact rename);
//! 3. both are text of the same extension and at least half of their lines are shared (a move
//!    that was edited too).

use super::repo::{Entry, Mode, TreeChange};
use crate::text_diff::lines::{diff_lines, split_lines, Edit};
use std::collections::{BTreeMap, BTreeSet};

/// The share of lines two versions must have in common to be one file renamed.
const SIMILAR: f64 = 0.5;
/// A file larger than this is only paired by an exact match (the line diff is not worth it).
const MAX_SIMILAR_BYTES: usize = 512 * 1024;

/// `(from, to)` pairs: `changes` holds a deletion at `from` and an addition at `to` that are the
/// same file. `hints` are the moves a commit message recorded. `read` loads a blob's bytes.
pub fn detect(
    changes: &[TreeChange],
    hints: &[(String, String)],
    read: &dyn Fn(&Entry) -> Option<Vec<u8>>,
) -> Vec<(String, String)> {
    let plain = |e: &Option<Entry>| e.as_ref().filter(|e| e.mode != Mode::Link).cloned();
    let mut deleted: BTreeMap<&str, Entry> = BTreeMap::new();
    let mut added: BTreeMap<&str, Entry> = BTreeMap::new();
    for c in changes {
        match (plain(&c.before), plain(&c.after)) {
            (Some(b), None) => {
                deleted.insert(&c.path, b);
            }
            (None, Some(a)) => {
                added.insert(&c.path, a);
            }
            _ => {}
        }
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut taken: BTreeSet<&str> = BTreeSet::new();
    let take = |from: &str, to: &str, pairs: &mut Vec<(String, String)>| {
        pairs.push((from.to_string(), to.to_string()));
    };
    // 1. what the commit recorded
    for (from, to) in hints {
        if let (Some((f, _)), Some((t, _))) = (
            deleted.get_key_value(from.as_str()),
            added.get_key_value(to.as_str()),
        ) {
            if !taken.contains(f) && !taken.contains(t) {
                taken.insert(f);
                taken.insert(t);
                take(f, t, &mut pairs);
            }
        }
    }
    // 2. the same blob
    for (from, b) in &deleted {
        if taken.contains(from) {
            continue;
        }
        let same = added
            .iter()
            .find(|(to, a)| !taken.contains(**to) && a.id == b.id);
        if let Some((to, _)) = same {
            taken.insert(from);
            taken.insert(to);
            take(from, to, &mut pairs);
        }
    }
    // 3. mostly the same text
    for (from, b) in &deleted {
        if taken.contains(from) {
            continue;
        }
        let Some(old) = read(b).filter(|x| x.len() <= MAX_SIMILAR_BYTES) else {
            continue;
        };
        let mut best: Option<(&str, f64)> = None;
        for (to, a) in &added {
            if taken.contains(to) || extension(from) != extension(to) {
                continue;
            }
            let Some(new) = read(a).filter(|x| x.len() <= MAX_SIMILAR_BYTES) else {
                continue;
            };
            let share = similarity(&old, &new);
            if share >= SIMILAR && best.is_none_or(|(_, s)| share > s) {
                best = Some((to, share));
            }
        }
        if let Some((to, _)) = best {
            taken.insert(from);
            taken.insert(to);
            take(from, to, &mut pairs);
        }
    }
    pairs.sort();
    pairs
}

fn extension(path: &str) -> String {
    path.rsplit('/')
        .next()
        .and_then(|n| n.rsplit_once('.'))
        .map_or(String::new(), |(_, e)| e.to_ascii_lowercase())
}

/// The share of lines two texts have in common (0 to 1); binary data shares nothing.
fn similarity(a: &[u8], b: &[u8]) -> f64 {
    let (Ok(a), Ok(b)) = (std::str::from_utf8(a), std::str::from_utf8(b)) else {
        return 0.0;
    };
    let (la, lb) = (split_lines(a), split_lines(b));
    let total = la.len() + lb.len();
    if total == 0 {
        return 1.0;
    }
    let equal = diff_lines(&la, &lb)
        .iter()
        .filter(|e| matches!(e, Edit::Equal(..)))
        .count();
    (2 * equal) as f64 / total as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> Entry {
        Entry {
            id: id.into(),
            mode: Mode::Blob,
        }
    }

    fn change(path: &str, before: Option<&str>, after: Option<&str>) -> TreeChange {
        TreeChange {
            path: path.into(),
            before: before.map(entry),
            after: after.map(entry),
        }
    }

    fn reader(
        files: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&Entry) -> Option<Vec<u8>> {
        move |e| {
            files
                .iter()
                .find(|(id, _)| *id == e.id)
                .map(|(_, t)| t.as_bytes().to_vec())
        }
    }

    #[test]
    fn the_same_blob_is_a_rename() {
        let changes = [
            change("a.md", Some("x"), None),
            change("b.md", None, Some("x")),
        ];
        let out = detect(&changes, &[], &reader(&[]));
        assert_eq!(out, vec![("a.md".to_string(), "b.md".to_string())]);
    }

    #[test]
    fn mostly_the_same_text_of_one_extension_is_a_rename_and_other_text_is_not() {
        static FILES: &[(&str, &str)] = &[
            ("1", "one\ntwo\nthree\nfour\n"),
            ("2", "one\ntwo\nthree\nfour and more\n"),
            ("3", "completely\ndifferent\ntext\nhere\n"),
        ];
        let changes = [
            change("a.md", Some("1"), None),
            change("b.md", None, Some("2")),
        ];
        assert_eq!(detect(&changes, &[], &reader(FILES)).len(), 1);
        let changes = [
            change("a.md", Some("1"), None),
            change("b.md", None, Some("3")),
        ];
        assert!(detect(&changes, &[], &reader(FILES)).is_empty());
        // another extension is another file
        let changes = [
            change("a.md", Some("1"), None),
            change("b.txt", None, Some("2")),
        ];
        assert!(detect(&changes, &[], &reader(FILES)).is_empty());
    }

    #[test]
    fn a_recorded_move_wins_over_similarity() {
        static FILES: &[(&str, &str)] = &[("1", "alpha\n"), ("2", "omega\n")];
        let changes = [
            change("a.md", Some("1"), None),
            change("b.md", None, Some("2")),
        ];
        let hint = [("a.md".to_string(), "b.md".to_string())];
        assert_eq!(detect(&changes, &hint, &reader(FILES)).len(), 1);
    }
}
