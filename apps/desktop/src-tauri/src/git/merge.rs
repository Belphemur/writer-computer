//! The 3-way merge of one file (ADR 2026-11-18 point 8, spec `SPECs/git-sync-spec.md` "Merge"):
//! base, mine and theirs in, the merged bytes or a conflict out. Pure and Tauri-free: no
//! repository, no IO, so the replay, the worktree update and the open-note apply all go through
//! the one function, [`merge_file`].
//!
//! - **Markdown**: the front matter is merged per property (a property one side changed takes
//!   that side, both changed differently is a conflict on that property only, untouched
//!   properties stay byte for byte through [`patch::entry_spans`]); the body is a diff3 line
//!   merge over the shared line diff `text_diff::lines`, where edits to adjacent but separate
//!   lines merge cleanly.
//! - **Other text**: the same line merge. JSON files whose three versions parse as objects fall
//!   back to a per-top-level-key merge when the line merge conflicts (two sides editing different
//!   keys of a one-line file).
//! - **Binary**: no merge, [`Merged::BinaryCopy`]: theirs stays at the path, mine is kept beside it.
//! - **Delete against edit**: the edit wins.
//!
//! A conflict never produces text with markers: [`Conflict`] names the overlapping hunks and the
//! conflicting properties, for the status and (phase 4) the merge view.

use crate::index::{frontmatter, patch};
use crate::text_diff::lines::{diff_lines, Edit};
use std::collections::BTreeMap;

/// One side's change to a run of base lines.
#[derive(Debug, Clone, Copy)]
struct Hunk {
    b0: usize,
    b1: usize,
    s0: usize,
    s1: usize,
}

impl Hunk {
    fn empty(&self) -> bool {
        self.b0 == self.b1
    }
}

fn hunks(edits: &[Edit]) -> Vec<Hunk> {
    let (mut bi, mut si) = (0, 0);
    let mut out = Vec::new();
    let mut cur: Option<Hunk> = None;
    for e in edits {
        match *e {
            Edit::Equal(i, j) => {
                out.extend(cur.take());
                bi = i + 1;
                si = j + 1;
            }
            Edit::Del(i) => {
                let h = cur.get_or_insert(Hunk {
                    b0: i,
                    b1: i,
                    s0: si,
                    s1: si,
                });
                h.b1 = i + 1;
                bi = i + 1;
            }
            Edit::Add(j) => {
                let h = cur.get_or_insert(Hunk {
                    b0: bi,
                    b1: bi,
                    s0: j,
                    s1: j,
                });
                h.s1 = j + 1;
                si = j + 1;
            }
        }
    }
    out.extend(cur);
    out
}

/// Does `h` overlap the base range `[g0, g1)`? Touching is not overlapping (the adjacent-lines
/// rule); an insertion overlaps another insertion at the same place or a range it falls strictly
/// inside.
fn overlaps(h: &Hunk, g0: usize, g1: usize) -> bool {
    match (h.empty(), g0 == g1) {
        (true, true) => h.b0 == g0,
        (true, false) => g0 < h.b0 && h.b0 < g1,
        (false, true) => h.b0 < g0 && g0 < h.b1,
        (false, false) => h.b0 < g1 && g0 < h.b1,
    }
}

/// An overlap neither side's version can be preferred in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkConflict {
    /// 0-based line of the first base line of the overlap.
    pub line: usize,
    pub base: String,
    pub mine: String,
    pub theirs: String,
}

/// A piece of a merged text: settled text, or an overlap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    Text(String),
    Conflict(HunkConflict),
}

/// The result of a line merge: the pieces in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextMerge {
    pub parts: Vec<Part>,
}

impl TextMerge {
    /// The merged text when nothing overlaps.
    pub fn clean(&self) -> Option<String> {
        let mut out = String::new();
        for p in &self.parts {
            match p {
                Part::Text(t) => out.push_str(t),
                Part::Conflict(_) => return None,
            }
        }
        Some(out)
    }

    pub fn conflicts(&self) -> Vec<HunkConflict> {
        self.parts
            .iter()
            .filter_map(|p| match p {
                Part::Conflict(c) => Some(c.clone()),
                Part::Text(_) => None,
            })
            .collect()
    }
}

/// Lines with their terminators, so a missing final newline is a difference like any other.
fn lines_of(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// diff3 over lines.
pub fn merge_text(base: &str, mine: &str, theirs: &str) -> TextMerge {
    if mine == theirs || base == theirs {
        return TextMerge {
            parts: vec![Part::Text(mine.to_string())],
        };
    }
    if base == mine {
        return TextMerge {
            parts: vec![Part::Text(theirs.to_string())],
        };
    }
    let (b, m, t) = (lines_of(base), lines_of(mine), lines_of(theirs));
    // sides: false = mine, true = theirs
    let mut all: Vec<(bool, Hunk)> = hunks(&diff_lines(&b, &m))
        .into_iter()
        .map(|h| (false, h))
        .chain(hunks(&diff_lines(&b, &t)).into_iter().map(|h| (true, h)))
        .collect();
    all.sort_by_key(|(side, h)| (h.b0, h.b1, *side));
    let mut parts: Vec<Part> = Vec::new();
    let mut text = String::new();
    let (mut pos, mut i) = (0usize, 0usize);
    while i < all.len() {
        let (g_side, first) = all[i];
        let (mut g0, mut g1) = (first.b0, first.b1);
        let mut group = vec![(g_side, first)];
        let mut j = i + 1;
        while j < all.len() && overlaps(&all[j].1, g0, g1) {
            g0 = g0.min(all[j].1.b0);
            g1 = g1.max(all[j].1.b1);
            group.push(all[j]);
            j += 1;
        }
        i = j;
        text.push_str(&b[pos..g0].concat());
        pos = g1;
        let side_of = |want: bool| -> Vec<Hunk> {
            group
                .iter()
                .filter(|(s, _)| *s == want)
                .map(|(_, h)| *h)
                .collect()
        };
        let (mh, th) = (side_of(false), side_of(true));
        // a side's text for the whole group range: its hunks with the base between them
        let range_of = |hs: &[Hunk], side: &[&str]| -> Option<String> {
            let (f, l) = (hs.first()?, hs.last()?);
            let start = f.s0 - (f.b0 - g0);
            let end = l.s1 + (g1 - l.b1);
            Some(side[start..end].concat())
        };
        let mine_text = range_of(&mh, &m).unwrap_or_else(|| b[g0..g1].concat());
        let theirs_text = range_of(&th, &t).unwrap_or_else(|| b[g0..g1].concat());
        if mh.is_empty() || mine_text == theirs_text {
            text.push_str(&theirs_text);
        } else if th.is_empty() {
            text.push_str(&mine_text);
        } else {
            if !text.is_empty() {
                parts.push(Part::Text(std::mem::take(&mut text)));
            }
            parts.push(Part::Conflict(HunkConflict {
                line: g0,
                base: b[g0..g1].concat(),
                mine: mine_text,
                theirs: theirs_text,
            }));
        }
    }
    text.push_str(&b[pos..].concat());
    if !text.is_empty() || parts.is_empty() {
        parts.push(Part::Text(text));
    }
    TextMerge { parts }
}

// ---- front matter -------------------------------------------------------------------------------

/// A property both sides changed differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyConflict {
    pub name: String,
    pub base: Option<String>,
    pub mine: Option<String>,
    pub theirs: Option<String>,
}

enum Pick {
    Mine,
    Theirs,
    Conflict,
}

/// Three-way choice of one entry: same on both sides or changed on one side settles it.
fn pick<T: PartialEq>(base: Option<&T>, mine: Option<&T>, theirs: Option<&T>) -> Pick {
    if mine == theirs || theirs == base {
        Pick::Mine
    } else if mine == base {
        Pick::Theirs
    } else {
        Pick::Conflict
    }
}

fn entries<'a>(
    fm: &'a str,
    spans: &'a [(String, std::ops::Range<usize>)],
) -> BTreeMap<&'a str, &'a str> {
    // a key twice keeps its last entry; the splice below is by span, not by this map
    spans
        .iter()
        .map(|(k, r)| (k.as_str(), &fm[r.clone()]))
        .collect()
}

fn with_newline(mut s: String) -> String {
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// The merged front matter text (between the fences), or the properties that conflict.
fn merge_properties(base: &str, mine: &str, theirs: &str) -> Result<String, Vec<PropertyConflict>> {
    let spans = |t: &str| patch::entry_spans(t).ok();
    let (Some(sb), Some(sm), Some(st)) = (spans(base), spans(mine), spans(theirs)) else {
        // not a mapping we can split: the whole block is one line-merged text
        let merged = merge_text(base, mine, theirs);
        return merged.clean().ok_or_else(|| {
            vec![PropertyConflict {
                name: "frontmatter".into(),
                base: Some(base.into()),
                mine: Some(mine.into()),
                theirs: Some(theirs.into()),
            }]
        });
    };
    let (eb, em, et) = (entries(base, &sb), entries(mine, &sm), entries(theirs, &st));
    let mut conflicts = Vec::new();
    let mut out = String::new();
    let mut cursor = 0;
    // mine's skeleton: its own gaps and comments stay; each entry takes its decision
    for (key, range) in &sm {
        out.push_str(&mine[cursor..range.start]);
        cursor = range.end;
        let (b, m, t) = (
            eb.get(key.as_str()),
            em.get(key.as_str()),
            et.get(key.as_str()),
        );
        match pick(b, m, t) {
            Pick::Mine => out.push_str(&mine[range.clone()]),
            Pick::Theirs => {
                if let Some(t) = t {
                    out.push_str(&with_newline((*t).to_string()));
                }
            }
            Pick::Conflict => {
                out.push_str(&mine[range.clone()]);
                conflicts.push(PropertyConflict {
                    name: key.clone(),
                    base: b.map(|s| s.to_string()),
                    mine: m.map(|s| s.to_string()),
                    theirs: t.map(|s| s.to_string()),
                });
            }
        }
    }
    out.push_str(&mine[cursor..]);
    // keys only theirs has: new from theirs (unless mine deleted what base had and theirs changed:
    // that is a conflict), in theirs' order, after mine's entries
    let mut added = String::new();
    for (key, _) in &st {
        if em.contains_key(key.as_str()) {
            continue;
        }
        let (b, t) = (eb.get(key.as_str()), et.get(key.as_str()));
        match pick(b, None, t) {
            Pick::Mine => {}
            Pick::Theirs => added.push_str(&with_newline((*t.expect("changed")).to_string())),
            Pick::Conflict => conflicts.push(PropertyConflict {
                name: key.clone(),
                base: b.map(|s| s.to_string()),
                mine: None,
                theirs: t.map(|s| s.to_string()),
            }),
        }
    }
    if !conflicts.is_empty() {
        return Err(conflicts);
    }
    if !added.is_empty() {
        out = with_newline(out);
        out.push_str(&added);
    }
    Ok(out)
}

/// What the front matter of a note is made of: the text before the block's content (BOM, opening
/// fence), the content, and the closing fence line.
struct Fm<'a> {
    open: &'a str,
    inner: &'a str,
    close: &'a str,
    body: &'a str,
}

fn split_note(text: &str) -> Option<Fm<'_>> {
    let s = frontmatter::split(text);
    let inner = s.fm?;
    let inner_start = inner.as_ptr() as usize - text.as_ptr() as usize;
    let inner_end = inner_start + inner.len();
    Some(Fm {
        open: &text[..inner_start],
        inner,
        close: &text[inner_end..s.body_start],
        body: &text[s.body_start..],
    })
}

/// The merge of one Markdown note.
fn merge_markdown(base: &str, mine: &str, theirs: &str) -> Result<String, Conflict> {
    let (fb, fm, ft) = (split_note(base), split_note(mine), split_note(theirs));
    let body_of = |text: &str, f: &Option<Fm<'_>>| {
        f.as_ref().map_or(text.to_string(), |f| f.body.to_string())
    };
    let body = merge_text(
        &body_of(base, &fb),
        &body_of(mine, &fm),
        &body_of(theirs, &ft),
    );
    let mut conflict = Conflict::default();
    let front = if fm.is_none() && ft.is_none() {
        Some(String::new())
    } else {
        // the skeleton (fences) comes from mine, else from theirs
        let (skeleton, m_in, t_in) = match (&fm, &ft) {
            (Some(m), Some(t)) => (m, m.inner, t.inner),
            (Some(m), None) => (m, m.inner, ""),
            (None, Some(t)) => (t, "", t.inner),
            (None, None) => unreachable!("handled above"),
        };
        let b_in = fb.as_ref().map_or("", |f| f.inner);
        match merge_properties(b_in, m_in, t_in) {
            Ok(inner) => Some(format!("{}{}{}", skeleton.open, inner, skeleton.close)),
            Err(props) => {
                conflict.properties = props;
                None
            }
        }
    };
    let merged_body = body.clean();
    if front.is_none() || merged_body.is_none() {
        conflict.hunks = body.conflicts();
        return Err(conflict);
    }
    Ok(format!(
        "{}{}",
        front.unwrap_or_default(),
        merged_body.unwrap_or_default()
    ))
}

// ---- JSON ---------------------------------------------------------------------------------------

/// Per top-level key merge of three JSON objects, `None` when one is not an object or a key
/// conflicts. Serialised like mine (compact when mine is one line, else 2-space pretty).
fn merge_json_keys(base: &str, mine: &str, theirs: &str) -> Option<String> {
    use serde_json::Value;
    let parse = |t: &str| match serde_json::from_str::<Value>(t) {
        Ok(Value::Object(o)) => Some(o),
        _ => None,
    };
    let (b, m, t) = (parse(base)?, parse(mine)?, parse(theirs)?);
    let mut out = serde_json::Map::new();
    let keys: std::collections::BTreeSet<&String> =
        b.keys().chain(m.keys()).chain(t.keys()).collect();
    for k in keys {
        let chosen = match pick(b.get(k), m.get(k), t.get(k)) {
            Pick::Mine => m.get(k),
            Pick::Theirs => t.get(k),
            Pick::Conflict => return None,
        };
        if let Some(v) = chosen {
            out.insert(k.clone(), v.clone());
        }
    }
    let value = Value::Object(out);
    let mut text = if mine.trim().contains('\n') {
        serde_json::to_string_pretty(&value).ok()?
    } else {
        serde_json::to_string(&value).ok()?
    };
    if mine.ends_with('\n') {
        text.push('\n');
    }
    Some(text)
}

// ---- one file -----------------------------------------------------------------------------------

/// What kept a merge from being clean.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Conflict {
    pub hunks: Vec<HunkConflict>,
    pub properties: Vec<PropertyConflict>,
}

/// Why a clean result is worth telling the user about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Note {
    /// One side deleted the file, the other edited it: the edit won and the file is back.
    DeleteEdit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Merged {
    /// The file's content (`None`: it does not exist).
    Clean {
        bytes: Option<Vec<u8>>,
        note: Option<Note>,
    },
    /// A binary changed on both sides: theirs stays at the path, mine is kept beside it.
    BinaryCopy,
    Conflict(Conflict),
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn extension(path: &str) -> String {
    path.rsplit('.')
        .next()
        .filter(|e| !e.contains('/'))
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Merges one file: `base` is the version both sides started from (`None`: added on both), `mine`
/// and `theirs` the two results (`None`: deleted).
pub fn merge_file(
    path: &str,
    base: Option<&[u8]>,
    mine: Option<&[u8]>,
    theirs: Option<&[u8]>,
) -> Merged {
    let clean = |bytes: Option<&[u8]>, note| Merged::Clean {
        bytes: bytes.map(<[u8]>::to_vec),
        note,
    };
    if mine == theirs || theirs == base {
        return clean(mine, None);
    }
    if mine == base {
        return clean(theirs, None);
    }
    match (mine, theirs) {
        // a delete on one side against an edit on the other: the edit wins
        (None, Some(t)) => return clean(Some(t), Some(Note::DeleteEdit)),
        (Some(m), None) => return clean(Some(m), Some(Note::DeleteEdit)),
        (None, None) => return clean(None, None),
        _ => {}
    }
    let (m, t) = (mine.unwrap_or_default(), theirs.unwrap_or_default());
    let b = base.unwrap_or_default();
    if is_binary(m) || is_binary(t) || is_binary(b) {
        return Merged::BinaryCopy;
    }
    let (b, m, t) = (
        std::str::from_utf8(b).unwrap_or_default(),
        std::str::from_utf8(m).unwrap_or_default(),
        std::str::from_utf8(t).unwrap_or_default(),
    );
    let ext = extension(path);
    let text = if matches!(ext.as_str(), "md" | "markdown") {
        merge_markdown(b, m, t)
    } else {
        let merged = merge_text(b, m, t);
        match merged.clean() {
            Some(text) => Ok(text),
            None => {
                let json = matches!(ext.as_str(), "json" | "canvas" | "excalidraw")
                    .then(|| merge_json_keys(b, m, t))
                    .flatten();
                json.ok_or_else(|| Conflict {
                    hunks: merged.conflicts(),
                    properties: Vec::new(),
                })
            }
        }
    };
    match text {
        Ok(text) => Merged::Clean {
            bytes: Some(text.into_bytes()),
            note: None,
        },
        Err(c) => Merged::Conflict(c),
    }
}

/// `Plan.png` to `Plan (conflict Studio 2026-11-20 1403).png`, beside the original.
pub fn conflict_copy_name(path: &str, device: &str, stamp: &str) -> String {
    let (dir, file) = path.rsplit_once('/').map_or(("", path), |(d, f)| (d, f));
    let (stem, ext) = match file.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (file, String::new()),
    };
    let device: String = device
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '(' | ')'))
        .collect();
    let name = format!("{stem} (conflict {} {stamp}){ext}", device.trim());
    if dir.is_empty() {
        name
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(test)]
#[path = "merge_tests.rs"]
mod tests;
