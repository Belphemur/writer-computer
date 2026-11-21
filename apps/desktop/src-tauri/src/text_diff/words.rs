//! Word-level diff of two short texts (a paragraph, a list item): the marks of the rendered note
//! diff. Tokens are runs of letters and digits, runs of whitespace, and single other characters,
//! diffed with the shared Myers core ([`super::lines`]), then equal neighbours are merged.

use super::lines::{diff_lines, Edit};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DiffOp {
    Eq,
    Ins,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DiffPart {
    pub op: DiffOp,
    pub text: String,
}

/// More tokens than this on a side and the pair is shown as one deletion and one insertion.
const MAX_TOKENS: usize = 4_000;

pub fn tokens(s: &str) -> Vec<&str> {
    #[derive(PartialEq, Clone, Copy)]
    enum Class {
        Word,
        Space,
        Other,
    }
    let class = |c: char| {
        if c.is_alphanumeric() {
            Class::Word
        } else if c.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        }
    };
    let mut out = Vec::new();
    let mut start = 0;
    let mut last: Option<Class> = None;
    for (i, c) in s.char_indices() {
        let k = class(c);
        if let Some(prev) = last {
            if k != prev || k == Class::Other {
                out.push(&s[start..i]);
                start = i;
            }
        }
        last = Some(k);
    }
    if last.is_some() {
        out.push(&s[start..]);
    }
    out
}

fn push(out: &mut Vec<DiffPart>, op: DiffOp, text: &str) {
    match out.last_mut() {
        Some(last) if last.op == op => last.text.push_str(text),
        _ => out.push(DiffPart {
            op,
            text: text.to_string(),
        }),
    }
}

/// The parts that turn `a` into `b`: equal text, insertions and deletions, in reading order.
pub fn diff_words(a: &str, b: &str) -> Vec<DiffPart> {
    let (ta, tb) = (tokens(a), tokens(b));
    let mut out = Vec::new();
    if ta.len() > MAX_TOKENS || tb.len() > MAX_TOKENS {
        push(&mut out, DiffOp::Del, a);
        push(&mut out, DiffOp::Ins, b);
        return out;
    }
    for e in diff_lines(&ta, &tb) {
        match e {
            Edit::Equal(i, _) => push(&mut out, DiffOp::Eq, ta[i]),
            Edit::Del(i) => push(&mut out, DiffOp::Del, ta[i]),
            Edit::Add(j) => push(&mut out, DiffOp::Ins, tb[j]),
        }
    }
    // a deletion that sits right after an insertion reads better the other way round
    let mut i = 0;
    while i + 1 < out.len() {
        if out[i].op == DiffOp::Ins && out[i + 1].op == DiffOp::Del {
            out.swap(i, i + 1);
        }
        i += 1;
    }
    out
}

/// How alike two texts are, 0 to 1: the share of the longer one's words (case kept) the other has.
pub fn similarity(a: &str, b: &str) -> f32 {
    let words = |s: &str| -> Vec<String> {
        tokens(s)
            .into_iter()
            .filter(|t| t.chars().any(char::is_alphanumeric))
            .map(str::to_string)
            .collect()
    };
    let (wa, wb) = (words(a), words(b));
    let longer = wa.len().max(wb.len());
    if longer == 0 {
        return if a == b { 1.0 } else { 0.0 };
    }
    let mut pool = wb;
    let mut shared = 0usize;
    for w in &wa {
        if let Some(pos) = pool.iter().position(|x| x == w) {
            pool.swap_remove(pos);
            shared += 1;
        }
    }
    shared as f32 / longer as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(parts: &[DiffPart], keep: &[DiffOp]) -> String {
        parts
            .iter()
            .filter(|p| keep.contains(&p.op))
            .map(|p| p.text.as_str())
            .collect()
    }

    #[test]
    fn parts_replay_to_both_sides() {
        let (a, b) = ("The quick brown fox.", "The slow brown dog, quickly.");
        let parts = diff_words(a, b);
        assert_eq!(text(&parts, &[DiffOp::Eq, DiffOp::Del]), a);
        assert_eq!(text(&parts, &[DiffOp::Eq, DiffOp::Ins]), b);
    }

    #[test]
    fn one_changed_word_is_one_deletion_and_one_insertion() {
        let parts = diff_words("a b c", "a X c");
        assert_eq!(
            parts,
            vec![
                DiffPart {
                    op: DiffOp::Eq,
                    text: "a ".into()
                },
                DiffPart {
                    op: DiffOp::Del,
                    text: "b".into()
                },
                DiffPart {
                    op: DiffOp::Ins,
                    text: "X".into()
                },
                DiffPart {
                    op: DiffOp::Eq,
                    text: " c".into()
                },
            ]
        );
    }

    #[test]
    fn identical_text_is_one_equal_part_and_empty_is_nothing() {
        assert_eq!(diff_words("same", "same").len(), 1);
        assert!(diff_words("", "").is_empty());
        assert_eq!(diff_words("", "new")[0].op, DiffOp::Ins);
    }

    #[test]
    fn similarity_tells_a_rewrite_from_a_new_paragraph() {
        assert!(similarity("the cat sat on the mat", "the cat sat on a mat") > 0.6);
        assert!(similarity("the cat sat", "completely different words") < 0.2);
        assert_eq!(similarity("", ""), 1.0);
    }
}
