//! The checker interface: what a finding is, what a provider is, and the two rules that apply to
//! every provider's output, deduplication and the one char-to-UTF-16 conversion (ADR 2026-11-18,
//! point 3; spec `SPECs/spellcheck-spec.md` "Checker").
//!
//! Providers work in `char` offsets relative to the block of text they were given (a Unicode
//! scalar value is what Harper and the Hunspell tokenizer count). [`Hit`] is that raw shape.
//! [`Finding`] is what leaves the engine: offsets in UTF-16 code units of the whole document, the
//! unit CodeMirror counts in. [`Utf16Index`] is the only place one becomes the other.

use super::lang::Lang;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ops::Range;

/// What a finding is about. The Settings toggles (`spellcheck.check-spelling`, `-grammar`,
/// `-style`) are per kind; the editor draws spelling and grammar as warnings and style as info.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Spelling,
    Grammar,
    Style,
}

impl Kind {
    /// Lower wins when two findings cover the same span: grammar over spelling (ADR point 3),
    /// and a style hint never hides either.
    fn rank(self) -> u8 {
        match self {
            Kind::Grammar => 0,
            Kind::Spelling => 1,
            Kind::Style => 2,
        }
    }
}

/// Which provider produced a finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Harper,
    Hunspell,
}

/// A finding as the providers produce it: `char` offsets relative to the text they checked, no
/// document position. This is what the paragraph cache stores, so an edit above a paragraph does
/// not invalidate it.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub range: Range<usize>,
    pub kind: Kind,
    pub message: String,
    pub replacements: Vec<String>,
    pub rule_id: String,
    pub provider: Provider,
}

/// A finding in the editor's terms: UTF-16 code units from the start of the document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub start: u32,
    pub end: u32,
    pub kind: Kind,
    pub message: String,
    /// Texts that replace `start..end`, best first. Empty when there is no suggestion.
    pub replacements: Vec<String>,
    /// The rule's id, what "Ignore rule" stores in `spellcheck.ignored-rules`.
    pub rule_id: String,
    pub provider: Provider,
}

/// The part of a block of text a provider may look at: every other character is masked (code,
/// links, front matter, markup; see `mask.rs`). `allowed` are sorted, disjoint `char` ranges of
/// `chars`.
pub struct Prose<'a> {
    pub chars: &'a [char],
    pub allowed: &'a [Range<usize>],
}

/// One local checker. Providers share nothing but this interface, so Harper's future language
/// plugins can join as another implementation (ADR point 11).
pub trait CheckProvider: Send + Sync {
    fn id(&self) -> Provider;
    /// Can this provider check `lang` right now (Harper: English; Hunspell: a dictionary is
    /// installed)? The engine picks the provider and reports a language nobody supports.
    fn supports(&self, lang: &Lang) -> bool;
    /// Checks `prose` as `lang`; the caller picked this provider for that language already.
    fn check(&self, prose: &Prose<'_>, lang: &Lang) -> Vec<Hit>;
}

/// Keeps one finding per span: when two cover exactly the same characters the higher-ranked kind
/// stays (grammar over spelling over style), ties keep the first. Overlaps that are not identical
/// are kept, the editor can draw both. Output is sorted by position.
pub fn dedupe(mut hits: Vec<Hit>) -> Vec<Hit> {
    hits.sort_by(|a, b| {
        (a.range.start, a.range.end, a.kind.rank()).cmp(&(
            b.range.start,
            b.range.end,
            b.kind.rank(),
        ))
    });
    hits.dedup_by(|later, kept| later.range == kept.range);
    hits
}

/// Char index to UTF-16 offset for one document: built once per request and the only place the
/// two units meet. `chars.len() + 1` entries so an end offset one past the last char converts.
pub struct Utf16Index(Vec<u32>);

impl Utf16Index {
    pub fn new(chars: &[char]) -> Self {
        let mut at = Vec::with_capacity(chars.len() + 1);
        let mut n = 0u32;
        at.push(0);
        for c in chars {
            n += c.len_utf16() as u32;
            at.push(n);
        }
        Self(at)
    }

    /// The UTF-16 offset of char index `i` (clamped to the end of the document).
    pub fn at(&self, i: usize) -> u32 {
        self.0[i.min(self.0.len() - 1)]
    }

    /// A [`Hit`] found in the block starting at char `block_start`, as a document [`Finding`].
    pub fn finding(&self, block_start: usize, hit: &Hit) -> Finding {
        Finding {
            start: self.at(block_start + hit.range.start),
            end: self.at(block_start + hit.range.end),
            kind: hit.kind,
            message: hit.message.clone(),
            replacements: hit.replacements.clone(),
            rule_id: hit.rule_id.clone(),
            provider: hit.provider,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(range: Range<usize>, kind: Kind) -> Hit {
        Hit {
            range,
            kind,
            message: String::new(),
            replacements: vec![],
            rule_id: format!("{kind:?}"),
            provider: Provider::Harper,
        }
    }

    #[test]
    fn grammar_wins_over_spelling_on_the_same_span() {
        let out = dedupe(vec![
            hit(3..7, Kind::Spelling),
            hit(3..7, Kind::Grammar),
            hit(3..7, Kind::Style),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, Kind::Grammar);
    }

    #[test]
    fn spelling_beats_style_and_other_spans_are_kept_in_order() {
        let out = dedupe(vec![
            hit(10..12, Kind::Style),
            hit(3..7, Kind::Style),
            hit(3..7, Kind::Spelling),
            hit(3..9, Kind::Grammar),
        ]);
        let spans: Vec<_> = out.iter().map(|h| (h.range.clone(), h.kind)).collect();
        assert_eq!(
            spans,
            vec![
                (3..7, Kind::Spelling),
                (3..9, Kind::Grammar),
                (10..12, Kind::Style)
            ]
        );
    }

    #[test]
    fn utf16_counts_surrogate_pairs_and_accents() {
        // "é" is one UTF-16 unit, the emoji two, so "ok" starts at char 3 but UTF-16 offset 4.
        let chars: Vec<char> = "é😀 ok".chars().collect();
        let index = Utf16Index::new(&chars);
        assert_eq!(index.at(0), 0);
        assert_eq!(index.at(1), 1);
        assert_eq!(index.at(2), 3);
        assert_eq!(index.at(4), 5);
        assert_eq!(index.at(99), index.at(chars.len()), "clamped to the end");
        let f = index.finding(3, &hit(0..2, Kind::Spelling));
        assert_eq!((f.start, f.end), (4, 6));
    }
}
