//! The one text diff of Writer (Tauri-free): the agent's "Changes" card, the lint engine's edits
//! and the Git history all compare text through it, so a diff reads the same everywhere.
//!
//! - [`lines`]: the Myers core over any slice of `&str` (moved here from `agent/line_diff.rs`);
//! - [`words`]: word-level marks inside a paragraph;
//! - [`note`]: the rendered view of a note (front matter as property rows, blocks with word
//!   marks), built on the two above;
//! - this file: the row form of a line diff ([`DiffRow`], what the "Source" view shows) and
//!   [`compare`], which gives both views of two texts in one value, [`TextDiff`].

pub mod lines;
pub mod note;
pub mod words;

use lines::{counts, diff_lines, split_lines, Edit};
use serde::{Deserialize, Serialize};

/// A diff longer than this is cut (`truncated`).
pub const MAX_DIFF_ROWS: usize = 20_000;
/// Longer lines are cut for display.
pub const MAX_ROW_CHARS: usize = 2_000;
/// Over this many lines on both sides together the pair is not diffed.
pub const MAX_DIFF_LINES: usize = 200_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DiffRowKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: DiffRowKind,
    /// 1-based; None on an added row.
    pub old_line: Option<u32>,
    /// 1-based; None on a removed row.
    pub new_line: Option<u32>,
    pub text: String,
}

fn cut_row(line: &str) -> String {
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.chars().count() > MAX_ROW_CHARS {
        let mut s: String = line.chars().take(MAX_ROW_CHARS).collect();
        s.push('…');
        s
    } else {
        line.to_string()
    }
}

/// Both views of the difference between two texts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    /// The line diff, the "Source" view. Empty when the texts are equal.
    pub rows: Vec<DiffRow>,
    /// `rows` stops early (very large diff).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub added: u32,
    pub removed: u32,
    /// The texts differ, but only in whitespace and line breaks.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub formatting_only: bool,
    /// The rendered view of a note, when it was asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered: Option<note::NoteDiff>,
}

/// `old` against `new`. `None` when the pair is too large to diff. `rendered` also builds the
/// note view (front matter rows and blocks), which is only worth its cost for a Markdown note
/// that is about to be shown.
pub fn compare(old: &str, new: &str, rendered: bool) -> Option<TextDiff> {
    let (la, lb) = (split_lines(old), split_lines(new));
    if la.len() + lb.len() > MAX_DIFF_LINES {
        return None;
    }
    let edits = diff_lines(&la, &lb);
    let (added, removed) = counts(&edits);
    let mut rows = Vec::with_capacity(edits.len().min(MAX_DIFF_ROWS));
    let mut truncated = false;
    for e in &edits {
        if rows.len() >= MAX_DIFF_ROWS {
            truncated = true;
            break;
        }
        rows.push(match *e {
            Edit::Equal(i, j) => DiffRow {
                kind: DiffRowKind::Context,
                old_line: Some(i as u32 + 1),
                new_line: Some(j as u32 + 1),
                text: cut_row(lb[j]),
            },
            Edit::Del(i) => DiffRow {
                kind: DiffRowKind::Del,
                old_line: Some(i as u32 + 1),
                new_line: None,
                text: cut_row(la[i]),
            },
            Edit::Add(j) => DiffRow {
                kind: DiffRowKind::Add,
                old_line: None,
                new_line: Some(j as u32 + 1),
                text: cut_row(lb[j]),
            },
        });
    }
    let formatting_only = old != new && old.split_whitespace().eq(new.split_whitespace());
    Some(TextDiff {
        rows,
        truncated,
        added,
        removed,
        formatting_only,
        rendered: rendered.then(|| note::diff_note(old, new)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_count_and_number_lines() {
        let d = compare("a\nb\nc\n", "a\nX\nc\n", false).unwrap();
        assert_eq!((d.added, d.removed), (1, 1));
        let shape: Vec<_> = d
            .rows
            .iter()
            .map(|r| (r.kind, r.old_line, r.new_line))
            .collect();
        assert_eq!(
            shape,
            vec![
                (DiffRowKind::Context, Some(1), Some(1)),
                (DiffRowKind::Del, Some(2), None),
                (DiffRowKind::Add, None, Some(2)),
                (DiffRowKind::Context, Some(3), Some(3)),
            ]
        );
        assert!(d.rendered.is_none() && !d.formatting_only && !d.truncated);
    }

    #[test]
    fn whitespace_only_is_formatting_only() {
        let d = compare("one two\nthree\n", "one  two three\n", true).unwrap();
        assert!(d.formatting_only);
        assert!(d.added + d.removed > 0);
        let r = d.rendered.unwrap();
        assert!(r
            .blocks
            .iter()
            .all(|b| b.change == note::DiffBlockChange::Same));
        assert!(!compare("a\n", "b\n", false).unwrap().formatting_only);
        assert!(!compare("a\n", "a\n", false).unwrap().formatting_only);
    }

    #[test]
    fn a_huge_pair_has_no_diff_and_long_lines_are_cut() {
        let big = "x\n".repeat(MAX_DIFF_LINES);
        assert!(compare(&big, "y\n", false).is_none());
        let long = "y".repeat(MAX_ROW_CHARS + 50);
        let d = compare("", &long, false).unwrap();
        assert!(d.rows[0].text.ends_with('…'));
    }
}
