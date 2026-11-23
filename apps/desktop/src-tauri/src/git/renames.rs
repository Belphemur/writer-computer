//! Renames among the changes of one commit or of a range (spec `SPECs/git-sync-spec.md` "Merge",
//! "Rename"): the replay follows a file that was renamed on one side while it was edited on the
//! other. Pure and Tauri-free: it pairs the deleted and the added files of a list of
//! [`TreeChange`]s, nothing here opens a repository.
//!
//! A pair is a rename when, in this order of trust:
//!
//! 1. the commit says so (`Writer-Move-From` / `Writer-Move-To`, Writer's own moves);
//! 2. both sides are the same blob (git's exact rename);
//! 3. only within ONE commit ([`Similar::InCommit`]): both are text of the same extension that
//!    share enough of their *distinctive* lines (blank lines, front matter and lines repeated in a
//!    file do not count), at least [`MIN_SHARED`] of them, and the pair is unique: neither file
//!    has another candidate. Notes made from one template look alike without being one file.
//!
//! Over a range of commits (what the other device did since the merge base) only 1 and 2 are
//! trusted ([`Similar::Off`]): the deletion of one daily note and the creation of the next, from
//! the same template, are two files, never a rename.

use super::repo::{Entry, Mode, TreeChange};
use std::collections::{BTreeMap, BTreeSet};

/// The share of distinctive lines two versions must have in common to be one file renamed.
const SIMILAR: f64 = 0.5;
/// The fewest distinctive lines two versions must share to be one file renamed.
pub const MIN_SHARED: usize = 3;
/// A file larger than this is only paired by an exact match (the comparison is not worth it).
const MAX_SIMILAR_BYTES: usize = 512 * 1024;

/// Whether content similarity may pair files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Similar {
    /// Hints and exact blobs only (a range of commits).
    Off,
    /// Also similar text, strictly (the changes of one commit).
    InCommit,
}

/// `(from, to)` pairs: `changes` holds a deletion at `from` and an addition at `to` that are the
/// same file. `hints` are the moves the commits recorded. `read` loads a blob's bytes.
pub fn detect(
    changes: &[TreeChange],
    hints: &[(String, String)],
    read: &dyn Fn(&Entry) -> Option<Vec<u8>>,
    similar: Similar,
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
    // 1. what the commits recorded
    for (from, to) in hints {
        if let (Some((f, _)), Some((t, _))) = (
            deleted.get_key_value(from.as_str()),
            added.get_key_value(to.as_str()),
        ) {
            if !taken.contains(f) && !taken.contains(t) {
                taken.insert(f);
                taken.insert(t);
                pairs.push((f.to_string(), t.to_string()));
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
            pairs.push((from.to_string(), to.to_string()));
        }
    }
    // 3. distinctive lines in common, one commit only, unique pairs only
    if similar == Similar::InCommit {
        let text = |e: &Entry| {
            read(e)
                .filter(|x| x.len() <= MAX_SIMILAR_BYTES)
                .and_then(|x| String::from_utf8(x).ok())
        };
        let sig = |m: &BTreeMap<&str, Entry>| -> BTreeMap<String, BTreeSet<String>> {
            m.iter()
                .filter(|(p, _)| !taken.contains(**p))
                .filter_map(|(p, e)| Some((p.to_string(), distinctive(&text(e)?))))
                .collect()
        };
        let (gone, new) = (sig(&deleted), sig(&added));
        let mut candidates: Vec<(&str, &str)> = Vec::new();
        for (from, a) in &gone {
            for (to, b) in &new {
                if extension(from) == extension(to) && alike(a, b) {
                    candidates.push((from, to));
                }
            }
        }
        for (from, to) in &candidates {
            let once =
                |f: &dyn Fn(&(&str, &str)) -> bool| candidates.iter().filter(|c| f(c)).count() == 1;
            if once(&|c| c.0 == *from) && once(&|c| c.1 == *to) {
                pairs.push((from.to_string(), to.to_string()));
            }
        }
    }
    pairs.sort();
    pairs
}

/// Moves recorded over a range of commits (oldest first), chained: `a -> b` then `b -> c` is
/// `a -> c`, so the range's deletion of `a` and addition of `c` pair.
pub fn chain(moves: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (from, to) in moves {
        match out.iter_mut().find(|(_, t)| *t == from) {
            Some(link) => link.1 = to,
            None => out.push((from, to)),
        }
    }
    out
}

fn extension(path: &str) -> String {
    path.rsplit('/')
        .next()
        .and_then(|n| n.rsplit_once('.'))
        .map_or(String::new(), |(_, e)| e.to_ascii_lowercase())
}

/// The lines that identify a text: trimmed, not blank, outside the front matter, and present
/// exactly once in it (a repeated line, `- [ ]` or a separator, says nothing about which file).
fn distinctive(text: &str) -> BTreeSet<String> {
    let mut lines = text.lines().peekable();
    if lines.peek().map(|l| l.trim_end()) == Some("---") {
        lines.next();
        for l in lines.by_ref() {
            if matches!(l.trim_end(), "---" | "...") {
                break;
            }
        }
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for l in lines {
        let t = l.trim();
        if !t.is_empty() {
            *counts.entry(t).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n == 1)
        .map(|(l, _)| l.to_string())
        .collect()
}

/// Enough distinctive lines in common, and a large enough share of them.
fn alike(a: &BTreeSet<String>, b: &BTreeSet<String>) -> bool {
    let shared = a.intersection(b).count();
    shared >= MIN_SHARED && (2 * shared) as f64 / (a.len() + b.len()) as f64 >= SIMILAR
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
        let out = detect(&changes, &[], &reader(&[]), Similar::Off);
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
        assert_eq!(
            detect(&changes, &[], &reader(FILES), Similar::InCommit).len(),
            1
        );
        let changes = [
            change("a.md", Some("1"), None),
            change("b.md", None, Some("3")),
        ];
        assert!(detect(&changes, &[], &reader(FILES), Similar::InCommit).is_empty());
        // another extension is another file
        let changes = [
            change("a.md", Some("1"), None),
            change("b.txt", None, Some("2")),
        ];
        assert!(detect(&changes, &[], &reader(FILES), Similar::InCommit).is_empty());
    }

    #[test]
    fn a_recorded_move_wins_over_similarity() {
        static FILES: &[(&str, &str)] = &[("1", "alpha\n"), ("2", "omega\n")];
        let changes = [
            change("a.md", Some("1"), None),
            change("b.md", None, Some("2")),
        ];
        let hint = [("a.md".to_string(), "b.md".to_string())];
        assert_eq!(
            detect(&changes, &hint, &reader(FILES), Similar::Off).len(),
            1
        );
    }

    #[test]
    fn notes_from_one_template_are_not_a_rename() {
        static FILES: &[(&str, &str)] = &[
            (
                "d1",
                "---\ndate: 2026-11-01\n---\n# Daily\n\n## Tasks\n- [ ]\n- [ ]\n\n## Journal\n\n## Links\n",
            ),
            (
                "d2",
                "---\ndate: 2026-11-20\n---\n# Daily\n\n## Tasks\n- [ ]\n- [ ]\n\n## Journal\n\n## Links\n",
            ),
            ("d3", "# Daily\n\n## Tasks\n## Journal\n## Links\n"),
        ];
        let changes = [
            change("2026-11-01.md", Some("d1"), None),
            change("2026-11-20.md", None, Some("d2")),
        ];
        // over a range: never by similarity
        assert!(detect(&changes, &[], &reader(FILES), Similar::Off).is_empty());
        // within a commit: two candidates for one file is no rename
        let changes = [
            change("2026-11-01.md", Some("d1"), None),
            change("2026-11-20.md", None, Some("d2")),
            change("2026-11-21.md", None, Some("d3")),
        ];
        assert!(detect(&changes, &[], &reader(FILES), Similar::InCommit).is_empty());
    }

    #[test]
    fn too_few_distinctive_lines_is_no_rename() {
        static FILES: &[(&str, &str)] = &[("1", "a\nb\n\n\n"), ("2", "a\nb\nc\n")];
        let changes = [
            change("a.md", Some("1"), None),
            change("b.md", None, Some("2")),
        ];
        assert!(detect(&changes, &[], &reader(FILES), Similar::InCommit).is_empty());
    }

    #[test]
    fn moves_chain_over_a_range() {
        let m = chain([
            ("a.md".to_string(), "b.md".to_string()),
            ("x.md".to_string(), "y.md".to_string()),
            ("b.md".to_string(), "c.md".to_string()),
        ]);
        assert_eq!(
            m,
            vec![
                ("a.md".to_string(), "c.md".to_string()),
                ("x.md".to_string(), "y.md".to_string())
            ]
        );
    }
}
