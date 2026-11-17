//! The one search-ranking module: typo-tolerant fuzzy matching of file names
//! and paths, and the recency boost shared by quick open and full-text search.
//!
//! The formula is specified in `SPECs/search-ranking-spec.md`. The palette's
//! TypeScript twin (`src/lib/search-rank.ts`) implements the same algorithm and
//! both assert the same vectors (`shared/search-rank-vectors.json`), so a
//! change here must change the twin and the vectors.
//!
//! Tauri-free: the app, the CLI and tests share it.

use std::collections::HashMap;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

// ---- tunables: the one place ----------------------------------------------

/// Half-life of the "recently opened" signal, in days.
pub const OPENED_HALF_LIFE_DAYS: f64 = 3.0;
/// Half-life of the "recently modified" signal, in days.
pub const MODIFIED_HALF_LIFE_DAYS: f64 = 5.0;
/// Largest relative boost an opened-just-now file gets (`score * (1 + boost)`).
pub const OPENED_WEIGHT: f64 = 0.5;
/// Largest relative boost a modified-just-now file gets.
pub const MODIFIED_WEIGHT: f64 = 0.3;

const MATCH: i32 = 16;
const CONSECUTIVE: i32 = 12;
const BOUNDARY: i32 = 14;
const NAME_START: i32 = 10;
const CAMEL: i32 = 10;
const GAP_OPEN: i32 = 6;
const GAP_EXTEND: i32 = 2;
const LEADING_GAP: i32 = 1;
const LEADING_GAP_CAP: usize = 5;
/// A match that is only in a folder name counts this much of a name match.
const PATH_FACTOR: f64 = 0.5;
const EXACT_STEM: f64 = 120.0;
const PREFIX_STEM: f64 = 40.0;
const COVERAGE: f64 = 10.0;
/// Query words shorter than this must be a contiguous substring.
const SUBSEQUENCE_MIN: usize = 3;
const TYPO_CHAR: f64 = 10.0;
const TYPO_EDIT: f64 = 14.0;

const NEG: i32 = i32::MIN / 2;
const MS_PER_DAY: f64 = 86_400_000.0;

// ---- folding ---------------------------------------------------------------

/// A candidate string folded for matching: NFD, combining marks dropped,
/// lowercased, `_` and `-` turned into spaces, so `François`, `Francois` and
/// `FRANCOIS` fold alike whatever Unicode form the file name uses.
#[derive(Debug, Clone, Default)]
pub struct Prepared {
    chars: Vec<char>,
    /// Per folded char: boundary / camelCase bonus, computed on the original text.
    bonus: Vec<i8>,
    name_start: usize,
    stem_end: usize,
    /// `[start, end)` folded ranges of alphanumeric words.
    words: Vec<(u32, u32)>,
}

impl Prepared {
    /// Prepare a vault-relative path (the file name is what follows the last `/`).
    pub fn new(path: &str) -> Self {
        fold(path).0
    }

    pub fn len(&self) -> usize {
        self.chars.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }
}

fn separator_to_space(c: char) -> char {
    if c == '_' || c == '-' {
        ' '
    } else {
        c
    }
}

/// Fold `s`; the second value maps each folded char to the char index of the
/// original it came from (for highlight indices).
fn fold(s: &str) -> (Prepared, Vec<u32>) {
    let src: Vec<char> = s.chars().collect();
    let last_slash = src.iter().rposition(|&c| c == '/');
    let name_orig = last_slash.map(|i| i + 1).unwrap_or(0);
    let last_dot = src
        .iter()
        .rposition(|&c| c == '.')
        .filter(|&i| i > name_orig);
    let stem_orig = last_dot.unwrap_or(src.len());

    let mut p = Prepared::default();
    let mut map: Vec<u32> = Vec::with_capacity(src.len());
    let mut name_start = None;
    let mut stem_end = None;
    for (i, &c) in src.iter().enumerate() {
        if name_start.is_none() && i >= name_orig {
            name_start = Some(p.chars.len());
        }
        if stem_end.is_none() && i >= stem_orig {
            stem_end = Some(p.chars.len());
        }
        let prev = src[..i]
            .iter()
            .rev()
            .copied()
            .find(|&p| !is_combining_mark(p));
        let bonus = char_bonus(prev, c, i);
        let mut first = true;
        for d in std::iter::once(c).nfd() {
            if is_combining_mark(d) {
                continue;
            }
            for l in d.to_lowercase() {
                p.chars.push(separator_to_space(l));
                p.bonus.push(if first { bonus } else { 0 });
                map.push(i as u32);
                first = false;
            }
        }
    }
    p.name_start = name_start.unwrap_or(p.chars.len());
    p.stem_end = stem_end.unwrap_or(p.chars.len());
    let mut start = None;
    for (j, &c) in p.chars.iter().enumerate() {
        if c.is_alphanumeric() {
            start.get_or_insert(j);
        } else if let Some(s) = start.take() {
            p.words.push((s as u32, j as u32));
        }
    }
    if let Some(s) = start {
        p.words.push((s as u32, p.chars.len() as u32));
    }
    (p, map)
}

fn char_bonus(prev: Option<char>, c: char, index: usize) -> i8 {
    if !c.is_alphanumeric() {
        return 0;
    }
    let b = match prev {
        None => BOUNDARY + NAME_START,
        Some(p) if !p.is_alphanumeric() => BOUNDARY,
        Some(p) if p.is_lowercase() && c.is_uppercase() => CAMEL,
        _ => 0,
    };
    let _ = index;
    b as i8
}

// ---- matching --------------------------------------------------------------

/// A prepared query: whitespace-separated words, each matched on its own, in
/// any order, all required.
#[derive(Debug, Clone)]
pub struct PreparedQuery {
    words: Vec<Vec<char>>,
}

impl PreparedQuery {
    pub fn new(query: &str) -> Self {
        let (p, _) = fold(query);
        let words = p
            .chars
            .split(|c| c.is_whitespace())
            .filter(|w| !w.is_empty())
            .map(|w| w.to_vec())
            .collect();
        PreparedQuery { words }
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    /// Total chars over all words (the "size" of the query).
    pub fn char_count(&self) -> usize {
        self.words.iter().map(Vec::len).sum()
    }
}

/// Text relevance of one candidate and the matched folded char positions.
#[derive(Debug, Clone, PartialEq)]
pub struct TextMatch {
    pub score: f64,
    /// Folded char positions, ascending and unique.
    pub folded: Vec<usize>,
}

/// Match `q` against one prepared path. `None` when any word fails.
pub fn match_path(q: &PreparedQuery, c: &Prepared) -> Option<TextMatch> {
    if q.words.is_empty() {
        return None;
    }
    let mut total = 0.0;
    let mut hit: Vec<usize> = Vec::new();
    let mut qlen = 0usize;
    for w in &q.words {
        let (s, ids) = best_word(w, c)?;
        total += s;
        hit.extend(ids);
        qlen += w.len();
    }
    let stem = &c.chars[c.name_start..c.stem_end];
    let joined: Vec<char> = q.words.join(&' ');
    if stem == joined.as_slice() {
        total += EXACT_STEM;
    } else if stem.starts_with(&joined) {
        total += PREFIX_STEM;
    }
    total += COVERAGE * (qlen as f64 / stem.len().max(1) as f64).min(1.0);
    hit.sort_unstable();
    hit.dedup();
    Some(TextMatch {
        score: total,
        folded: hit,
    })
}

fn best_word(w: &[char], c: &Prepared) -> Option<(f64, Vec<usize>)> {
    let contiguous = w.len() < SUBSEQUENCE_MIN;
    let path_only = w.contains(&'/');
    let name = if path_only {
        None
    } else {
        dp(w, c, c.name_start, c.stem_end, contiguous)
    };
    let path = dp(w, c, 0, c.chars.len(), contiguous).map(|(s, i)| (s as f64 * PATH_FACTOR, i));
    let best = match (name, path) {
        (Some((s, i)), Some((ps, pi))) => {
            if s as f64 >= ps {
                Some((s as f64, i))
            } else {
                Some((ps, pi))
            }
        }
        (Some((s, i)), None) => Some((s as f64, i)),
        (None, Some(p)) => Some(p),
        (None, None) => None,
    };
    best.or_else(|| if path_only { None } else { typo(w, c) })
}

/// Best-scoring placement of `q` as a subsequence of `c.chars[lo..hi]`
/// (consecutive only when `contiguous`). Smith-Waterman style: a match scores
/// [`MATCH`] plus the candidate char's boundary bonus and [`CONSECUTIVE`] when it
/// follows the previous match directly; gaps cost [`GAP_OPEN`] + [`GAP_EXTEND`]
/// per extra skipped char; the start offset costs [`LEADING_GAP`] per char.
fn dp(
    q: &[char],
    c: &Prepared,
    lo: usize,
    hi: usize,
    contiguous: bool,
) -> Option<(i32, Vec<usize>)> {
    let m = q.len();
    if m == 0 || hi <= lo || hi - lo < m {
        return None;
    }
    let text = &c.chars[lo..hi];
    let n = text.len();
    if contiguous {
        if !text.windows(m).any(|w| w == q) {
            return None;
        }
    } else {
        let mut qi = 0;
        for &ch in text {
            if qi < m && ch == q[qi] {
                qi += 1;
            }
        }
        if qi < m {
            return None;
        }
    }
    let mut h = vec![NEG; m * n];
    for i in 0..m {
        let mut run_best = NEG;
        for j in 0..n {
            if i > 0 && j >= 2 {
                let v = h[(i - 1) * n + j - 2];
                if v > NEG {
                    run_best = run_best.max(v + GAP_EXTEND * (j as i32 - 2));
                }
            }
            if text[j] != q[i] {
                continue;
            }
            let cs = MATCH + c.bonus[lo + j] as i32;
            let val = if i == 0 {
                cs - LEADING_GAP * j.min(LEADING_GAP_CAP) as i32
            } else {
                let mut best = NEG;
                if j >= 1 {
                    let p = h[(i - 1) * n + j - 1];
                    if p > NEG {
                        best = p + CONSECUTIVE;
                    }
                }
                if !contiguous && run_best > NEG {
                    best = best.max(run_best - GAP_EXTEND * (j as i32 - 2) - GAP_OPEN);
                }
                if best == NEG {
                    continue;
                }
                cs + best
            };
            h[i * n + j] = val;
        }
    }
    let last = (m - 1) * n;
    let mut end = None;
    for j in 0..n {
        let v = h[last + j];
        if v > NEG && end.is_none_or(|(_, b)| v > b) {
            end = Some((j, v));
        }
    }
    let (mut j, score) = end?;
    let mut idx = vec![0usize; m];
    for i in (0..m).rev() {
        idx[i] = lo + j;
        if i == 0 {
            break;
        }
        let v = h[i * n + j];
        let prev = v - (MATCH + c.bonus[lo + j] as i32);
        if j >= 1 && h[(i - 1) * n + j - 1] > NEG && h[(i - 1) * n + j - 1] + CONSECUTIVE == prev {
            j -= 1;
            continue;
        }
        let mut found = None;
        if j >= 2 {
            for k in (0..=j - 2).rev() {
                let hk = h[(i - 1) * n + k];
                if hk > NEG && hk - GAP_OPEN - GAP_EXTEND * (j as i32 - k as i32 - 2) == prev {
                    found = Some(k);
                    break;
                }
            }
        }
        j = found?;
    }
    Some((score, idx))
}

/// Edits a query word of `len` chars may be off by.
fn allowed_edits(len: usize) -> usize {
    match len {
        0..=4 => 0,
        5..=7 => 1,
        _ => 2,
    }
}

/// Optimal-string-alignment (Damerau) distance, `> max` once it exceeds it.
fn osa(a: &[char], b: &[char], max: usize) -> usize {
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    let (n, m) = (a.len(), b.len());
    let mut prev2 = vec![0usize; m + 1];
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0usize; m + 1];
    for i in 1..=n {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(prev2[j - 2] + 1);
            }
            cur[j] = v;
            row_min = row_min.min(v);
        }
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[m]
}

/// Typo tolerance: the query word is within a few edits of a whole word of the
/// path, or of that word's leading chars (a half-typed misspelling).
fn typo(w: &[char], c: &Prepared) -> Option<(f64, Vec<usize>)> {
    let max = allowed_edits(w.len());
    if max == 0 {
        return None;
    }
    let mut best: Option<(f64, Vec<usize>)> = None;
    for &(ws, we) in &c.words {
        let (ws, we) = (ws as usize, we as usize);
        let weight = if ws >= c.name_start && we <= c.stem_end {
            1.0
        } else {
            PATH_FACTOR
        };
        let word = &c.chars[ws..we];
        let mut targets: Vec<&[char]> = vec![word];
        if word.len() > w.len() {
            targets.push(&word[..w.len()]);
        }
        for t in targets {
            let d = osa(w, t, max);
            if d == 0 || d > max {
                continue;
            }
            let score =
                (TYPO_CHAR * w.len() as f64 - TYPO_EDIT * d as f64 + c.bonus[ws] as f64) * weight;
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                best = Some((score, (ws..ws + t.len()).collect()));
            }
        }
    }
    best
}

/// Map folded positions back to char indices of the original string.
pub fn original_indices(path: &str, folded: &[usize]) -> Vec<u32> {
    let (_, map) = fold(path);
    let mut out: Vec<u32> = folded.iter().filter_map(|&f| map.get(f).copied()).collect();
    out.sort_unstable();
    out.dedup();
    out
}

// ---- recency ---------------------------------------------------------------

/// When a file was last seen and last written, unix milliseconds.
#[derive(Debug, Clone, Copy, Default)]
pub struct Recency {
    pub opened_ms: Option<i64>,
    pub mtime_ms: i64,
}

fn decay(age_ms: i64, half_life_days: f64) -> f64 {
    let days = age_ms.max(0) as f64 / MS_PER_DAY;
    0.5f64.powf(days / half_life_days)
}

/// Relative boost in `[0, OPENED_WEIGHT + MODIFIED_WEIGHT]`. Both signals decay
/// exponentially, so the boost is smooth and a stale file gets none.
pub fn recency_boost(now_ms: i64, r: Recency) -> f64 {
    let opened = r.opened_ms.map_or(0.0, |o| {
        OPENED_WEIGHT * decay(now_ms - o, OPENED_HALF_LIFE_DAYS)
    });
    let modified = if r.mtime_ms > 0 {
        MODIFIED_WEIGHT * decay(now_ms - r.mtime_ms, MODIFIED_HALF_LIFE_DAYS)
    } else {
        0.0
    };
    opened + modified
}

/// Final rank value: text relevance scaled by `1 + boost`.
pub fn combine(text: f64, boost: f64) -> f64 {
    text * (1.0 + boost)
}

/// Sort key for an empty query: opened files first (newest open first), then
/// the rest by modification time. Larger sorts first.
pub fn empty_query_key(r: Recency) -> (i64, i64) {
    (r.opened_ms.unwrap_or(0), r.mtime_ms)
}

/// Rank `(path, recency)` candidates for `query`; best first, ties by path.
/// `recency` of `None` ranks on text alone. Used by the cross-language vectors
/// and by [`crate::index::names`].
pub fn rank_paths<'a>(
    candidates: impl Iterator<Item = (&'a str, &'a Prepared, Recency)>,
    query: &str,
    now_ms: i64,
    use_recency: bool,
) -> Vec<(&'a str, f64)> {
    let q = PreparedQuery::new(query);
    let mut out: Vec<(&str, f64)> = Vec::new();
    for (path, prepared, r) in candidates {
        if let Some(m) = match_path(&q, prepared) {
            let boost = if use_recency {
                recency_boost(now_ms, r)
            } else {
                0.0
            };
            out.push((path, combine(m.score, boost)));
        }
    }
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    out
}

/// Opened-at (unix ms) by vault-relative path.
pub type OpenedMap = HashMap<String, i64>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const DAY: i64 = 86_400_000;
    const NOW: i64 = 1_800_000_000_000;

    #[derive(Deserialize)]
    struct Entry {
        path: String,
        #[serde(default)]
        opened_days_ago: Option<f64>,
        #[serde(default)]
        modified_days_ago: Option<f64>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        entries: Vec<Entry>,
        query: String,
        #[serde(default = "yes")]
        recency: bool,
        expect: Vec<String>,
    }

    fn yes() -> bool {
        true
    }

    /// The same vectors `tests/search-rank.test.ts` asserts.
    #[test]
    fn shared_vectors() {
        let raw = include_str!("../../../shared/search-rank-vectors.json");
        let cases: Vec<Case> = serde_json::from_str(raw).unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let prepared: Vec<(String, Prepared, Recency)> = case
                .entries
                .iter()
                .map(|e| {
                    (
                        e.path.clone(),
                        Prepared::new(&e.path),
                        Recency {
                            opened_ms: e.opened_days_ago.map(|d| NOW - (d * DAY as f64) as i64),
                            mtime_ms: NOW
                                - (e.modified_days_ago.unwrap_or(10_000.0) * DAY as f64) as i64,
                        },
                    )
                })
                .collect();
            let got: Vec<&str> = rank_paths(
                prepared.iter().map(|(p, pr, r)| (p.as_str(), pr, *r)),
                &case.query,
                NOW,
                case.recency,
            )
            .into_iter()
            .map(|(p, _)| p)
            .collect();
            assert_eq!(got, case.expect, "case {:?}", case.name);
        }
    }

    fn score(query: &str, path: &str) -> Option<f64> {
        match_path(&PreparedQuery::new(query), &Prepared::new(path)).map(|m| m.score)
    }

    #[test]
    fn typo_and_subsequence_tiers_are_ordered() {
        let exact = score("planning", "planning.md").unwrap();
        let sub = score("plnng", "planning.md").unwrap();
        let typo = score("plannign", "planning.md").unwrap();
        assert!(exact > sub, "{exact} {sub}");
        assert!(sub > 0.0 && typo > 0.0);
        assert!(score("zzzz", "planning.md").is_none());
    }

    #[test]
    fn short_words_are_substring_only() {
        assert!(score("pn", "planning.md").is_none());
        assert!(score("an", "planning.md").is_some());
    }

    #[test]
    fn highlight_indices_are_original_chars() {
        let q = PreparedQuery::new("lamarre");
        let path = "People/François Lamarre.md";
        let m = match_path(&q, &Prepared::new(path)).unwrap();
        let idx = original_indices(path, &m.folded);
        let start = "People/François ".chars().count() as u32;
        assert_eq!(idx, (start..start + 7).collect::<Vec<_>>());
    }

    #[test]
    fn decomposed_and_composed_names_fold_alike() {
        let nfd = "Franc\u{0327}ois.md";
        let nfc = "Fran\u{00e7}ois.md";
        let a = score("francois", nfd).unwrap();
        let b = score("francois", nfc).unwrap();
        assert_eq!(a, b);
        assert!(score("FRANÇOIS", nfd).is_some());
    }

    #[test]
    fn recency_boost_decays_smoothly_and_is_bounded() {
        let fresh = recency_boost(
            NOW,
            Recency {
                opened_ms: Some(NOW),
                mtime_ms: NOW,
            },
        );
        assert!((fresh - (OPENED_WEIGHT + MODIFIED_WEIGHT)).abs() < 1e-9);
        let half = recency_boost(
            NOW,
            Recency {
                opened_ms: Some(NOW - 3 * DAY),
                mtime_ms: 0,
            },
        );
        assert!((half - OPENED_WEIGHT / 2.0).abs() < 1e-9);
        let stale = recency_boost(
            NOW,
            Recency {
                opened_ms: None,
                mtime_ms: NOW - 400 * DAY,
            },
        );
        assert!(stale < 0.001);
    }

    /// 10k synthetic names: one keystroke worth of ranking stays well under
    /// 50 ms in release builds (debug builds only check it finishes).
    #[test]
    fn ten_thousand_names_rank_fast() {
        let prepared: Vec<(String, Prepared)> = (0..10_000)
            .map(|i| {
                let p = format!(
                    "area-{}/project-{}/Note {} planning meeting {}.md",
                    i % 20,
                    i % 200,
                    i,
                    ["alpha", "Francois Lamarre", "budget", "retro"][i % 4]
                );
                let pr = Prepared::new(&p);
                (p, pr)
            })
            .collect();
        for query in ["planning", "frlam", "francios lamare", "prj 17 retr"] {
            let t = std::time::Instant::now();
            let got = rank_paths(
                prepared.iter().map(|(p, pr)| {
                    (
                        p.as_str(),
                        pr,
                        Recency {
                            opened_ms: None,
                            mtime_ms: NOW - 3 * DAY,
                        },
                    )
                }),
                query,
                NOW,
                true,
            );
            let elapsed = t.elapsed();
            assert!(!got.is_empty(), "{query}");
            let budget = if cfg!(debug_assertions) { 2000 } else { 50 };
            assert!(
                elapsed.as_millis() < budget,
                "{query}: {elapsed:?} for {} hits",
                got.len()
            );
        }
    }
}
