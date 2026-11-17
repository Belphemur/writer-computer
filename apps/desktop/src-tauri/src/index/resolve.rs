//! Obsidian-style link resolution against the set of vault paths.
//!
//! Rules (from the public "Internal links" help; the ambiguity tie-break is not
//! specified publicly and is a documented choice, to be confirmed by probes):
//! 1. Empty target (`[[#Heading]]`) is the source file itself.
//! 2. `./x` and `../x` are relative to the source folder.
//! 3. Exact vault path, case-insensitively, with and without a `.md` suffix
//!    (markdown links are tried relative to the source folder first).
//! 4. A target containing `/` matches any file whose path ends with it
//!    (`b/c` matches `a/b/c.md`).
//! 5. A bare name matches the Markdown basename (without extension) or the
//!    full file name for other types (`photo.png`, `x.base`).
//! 6. When several files match: nearest folder wins (most leading folder
//!    components shared with the source), then the shortest path (fewest
//!    components, then fewest characters), then lexicographic order.
//!    A unique match is always taken. No match: unresolved (`None`).
//!
//! Every rule matches on the last path segment (rules 3 to 5 reach a file only through its own
//! name), so a link can only start or stop resolving when a file with the bucket key
//! ([`bucket_key`]) of its target appears or disappears: the argument behind the bucketed
//! re-resolution in `edges.rs`.

use super::markdown::LinkKind;
use std::collections::{HashMap, HashSet};

#[derive(Default, Clone)]
pub struct PathIndex {
    paths: HashSet<String>,
    lower_to_path: HashMap<String, String>,
    md_by_base: HashMap<String, Vec<String>>,
    by_name: HashMap<String, Vec<String>>,
}

/// The comparison key for every name and path: Unicode NFC, then lowercase. macOS file names are
/// often decomposed (NFD: `c` + combining cedilla) while links are typed precomposed (NFC: `ç`);
/// without normalizing, `[[François]]` never finds `François.md`.
pub(crate) fn lower(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfc().collect::<String>().to_lowercase()
}

/// The re-resolution bucket of a link target or a file name: the NFC-lowercase last path
/// segment with a `.md` suffix removed. A link resolves to a file only if both share this key, so
/// a vault change that adds or removes files can affect exactly the links whose key it touches.
/// Empty only for an empty target (a same-file link such as `[[#Heading]]`).
pub fn bucket_key(target: &str) -> String {
    let target = target.trim();
    if target.is_empty() {
        return String::new();
    }
    let key = lower(target);
    let (_, last) = split_name(&key);
    // `[[folder/]]` has no last segment; keep the whole text so the key is never empty.
    let last = if last.is_empty() { key.as_str() } else { last };
    strip_md(last).to_string()
}

/// A resolved link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub path: String,
    /// More than one file matched the link text as written; the nearest-folder rule picked
    /// `path`. A bare `[[index]]` that suddenly changes target when a same-named note is
    /// created is exactly this case.
    pub ambiguous: bool,
}

fn split_name(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

fn is_md(name: &str) -> bool {
    name.len() > 3
        && name
            .get(name.len() - 3..)
            .is_some_and(|e| e.eq_ignore_ascii_case(".md"))
}

fn strip_md(s: &str) -> &str {
    if is_md(s) {
        &s[..s.len() - 3]
    } else {
        s
    }
}

/// Resolve `.` and `..` segments; `None` if the path escapes the root.
fn normalize(path: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(out.join("/"))
}

impl PathIndex {
    pub fn from_paths<I: IntoIterator<Item = String>>(iter: I) -> Self {
        let mut idx = Self::default();
        for p in iter {
            idx.insert(p);
        }
        idx
    }

    /// Every indexed path (any order).
    pub fn paths(&self) -> impl Iterator<Item = &String> {
        self.paths.iter()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn insert(&mut self, path: String) {
        if !self.paths.insert(path.clone()) {
            return;
        }
        let (_, name) = split_name(&path);
        let name = name.to_string();
        self.lower_to_path.insert(lower(&path), path.clone());
        self.by_name
            .entry(lower(&name))
            .or_default()
            .push(path.clone());
        if is_md(&name) {
            self.md_by_base
                .entry(lower(strip_md(&name)))
                .or_default()
                .push(path);
        }
    }

    pub fn remove(&mut self, path: &str) {
        if !self.paths.remove(path) {
            return;
        }
        self.lower_to_path.remove(&lower(path));
        let (_, name) = split_name(path);
        let drop_from = |map: &mut HashMap<String, Vec<String>>, key: String| {
            if let Some(v) = map.get_mut(&key) {
                v.retain(|p| p != path);
                if v.is_empty() {
                    map.remove(&key);
                }
            }
        };
        drop_from(&mut self.by_name, lower(name));
        if is_md(name) {
            drop_from(&mut self.md_by_base, lower(strip_md(name)));
        }
    }

    fn exact(&self, path: &str) -> Option<String> {
        let l = lower(path);
        if let Some(p) = self.lower_to_path.get(&l) {
            return Some(p.clone());
        }
        if !l.ends_with(".md") {
            return self.lower_to_path.get(&format!("{l}.md")).cloned();
        }
        None
    }

    fn best(cands: Vec<&String>, src_dir: &str) -> Option<String> {
        let src: Vec<&str> = src_dir.split('/').filter(|s| !s.is_empty()).collect();
        let shared = |p: &str| {
            let (dir, _) = split_name(p);
            dir.split('/')
                .filter(|s| !s.is_empty())
                .zip(src.iter())
                .take_while(|(a, b)| lower(a) == lower(b))
                .count()
        };
        cands
            .into_iter()
            .min_by(|a, b| {
                shared(b)
                    .cmp(&shared(a))
                    .then(a.matches('/').count().cmp(&b.matches('/').count()))
                    .then(a.len().cmp(&b.len()))
                    .then(a.cmp(b))
            })
            .cloned()
    }

    pub fn resolve(&self, src_path: &str, raw: &str, kind: LinkKind) -> Option<String> {
        self.resolve_detailed(src_path, raw, kind).map(|r| r.path)
    }

    /// [`Self::resolve`] plus whether the link text matched several files.
    pub fn resolve_detailed(
        &self,
        src_path: &str,
        raw: &str,
        kind: LinkKind,
    ) -> Option<Resolution> {
        let raw = raw.trim();
        let explicit = |path: String| Resolution {
            path,
            ambiguous: false,
        };
        if raw.is_empty() {
            return Some(explicit(src_path.to_string()));
        }
        let (src_dir, _) = split_name(src_path);

        if raw.starts_with("./") || raw.starts_with("../") {
            let joined = if src_dir.is_empty() {
                raw.to_string()
            } else {
                format!("{src_dir}/{raw}")
            };
            return normalize(&joined)
                .and_then(|p| self.exact(&p))
                .map(explicit);
        }
        if kind.is_markdown() && !src_dir.is_empty() {
            if let Some(p) = normalize(&format!("{src_dir}/{raw}")).and_then(|p| self.exact(&p)) {
                return Some(explicit(p));
            }
        }
        let rooted = raw.trim_start_matches('/');
        let rooted = normalize(rooted)?;
        let cands = self.candidates(&rooted);
        if let Some(p) = self.exact(&rooted) {
            // A full path names its file; a bare name that also matches others is ambiguous.
            return Some(Resolution {
                path: p,
                ambiguous: !rooted.contains('/') && cands.len() > 1,
            });
        }
        let ambiguous = cands.len() > 1;
        Self::best(cands, src_dir).map(|path| Resolution { path, ambiguous })
    }

    /// Files the link text `rooted` can name by its last segment (and its folders, when it has
    /// some), in no particular order.
    fn candidates(&self, rooted: &str) -> Vec<&String> {
        let key = lower(rooted);
        let (_, last) = split_name(&key);
        let mut cands: Vec<&String> = Vec::new();
        let mut seen = HashSet::new();
        for list in [self.md_by_base.get(strip_md(last)), self.by_name.get(last)]
            .into_iter()
            .flatten()
        {
            for p in list {
                if seen.insert(p) {
                    cands.push(p);
                }
            }
        }
        if rooted.contains('/') {
            let want_md = format!("/{}", strip_md(&key));
            let want_full = format!("/{key}");
            cands.retain(|p| {
                let lp = lower(p);
                lp.ends_with(&want_full) || strip_md(&lp).ends_with(&want_md)
            });
        }
        cands
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(paths: &[&str]) -> PathIndex {
        PathIndex::from_paths(paths.iter().map(|s| s.to_string()))
    }

    #[test]
    fn exact_unique_and_case() {
        let i = idx(&["a/Note.md", "b/Other.md", "img/pic.png", "x.base"]);
        let r = |raw: &str| i.resolve("c/src.md", raw, LinkKind::Wikilink);
        assert_eq!(r("note").as_deref(), Some("a/Note.md"));
        assert_eq!(r("a/Note").as_deref(), Some("a/Note.md"));
        assert_eq!(r("a/Note.md").as_deref(), Some("a/Note.md"));
        assert_eq!(r("Note.md").as_deref(), Some("a/Note.md"));
        assert_eq!(r("pic.png").as_deref(), Some("img/pic.png"));
        assert_eq!(r("img/pic.png").as_deref(), Some("img/pic.png"));
        assert_eq!(r("x.base").as_deref(), Some("x.base"));
        assert_eq!(r("missing"), None);
        assert_eq!(r("a/Other"), None);
        assert_eq!(r("pic"), None);
    }

    #[test]
    fn unicode_normalization_forms_match_each_other() {
        // "François" decomposed (c + U+0327) on disk, precomposed (U+00E7) in the link, and back.
        let nfd = "Fran\u{63}\u{327}ois Lamarre";
        let nfc = "Fran\u{e7}ois Lamarre";
        assert_ne!(nfd, nfc);
        let on_disk_nfd = idx(&[&format!("Boss/{nfd}.md")]);
        let on_disk_nfc = idx(&[&format!("Boss/{nfc}.md")]);
        for (index, expected) in [(&on_disk_nfd, nfd), (&on_disk_nfc, nfc)] {
            for link in [nfc, nfd, &nfc.to_uppercase(), &format!("Boss/{nfc}")] {
                assert_eq!(
                    index.resolve("s.md", link, LinkKind::Wikilink),
                    Some(format!("Boss/{expected}.md")),
                    "link {link:?}"
                );
            }
        }
    }

    #[test]
    fn suffix_path_match() {
        let i = idx(&["deep/a/b/c.md", "x/c.md"]);
        assert_eq!(
            i.resolve("s.md", "b/c", LinkKind::Wikilink).as_deref(),
            Some("deep/a/b/c.md")
        );
    }

    #[test]
    fn duplicates_nearest_then_shortest() {
        let i = idx(&["a/n.md", "b/n.md", "b/sub/n.md"]);
        assert_eq!(
            i.resolve("b/src.md", "n", LinkKind::Wikilink).as_deref(),
            Some("b/n.md")
        );
        assert_eq!(
            i.resolve("b/sub/deep/src.md", "n", LinkKind::Wikilink)
                .as_deref(),
            Some("b/sub/n.md")
        );
        // Nothing shared: shortest path wins.
        assert_eq!(
            i.resolve("z/src.md", "n", LinkKind::Wikilink).as_deref(),
            Some("a/n.md")
        );
        // A note at the vault root is an exact path match and beats nearer folders.
        let r = idx(&["n.md", "b/n.md"]);
        assert_eq!(
            r.resolve("b/src.md", "n", LinkKind::Wikilink).as_deref(),
            Some("n.md")
        );
        let j = idx(&["a/n.md", "b/n.md"]);
        assert_eq!(
            j.resolve("z/s.md", "n", LinkKind::Wikilink).as_deref(),
            Some("a/n.md")
        );
    }

    #[test]
    fn relative_and_self() {
        let i = idx(&["a/b/n.md", "a/m.md", "m.md"]);
        assert_eq!(
            i.resolve("a/b/s.md", "../m", LinkKind::Wikilink).as_deref(),
            Some("a/m.md")
        );
        assert_eq!(
            i.resolve("a/b/s.md", "../../m.md", LinkKind::Markdown)
                .as_deref(),
            Some("m.md")
        );
        assert_eq!(
            i.resolve("a/b/s.md", "../../../m", LinkKind::Wikilink),
            None
        );
        assert_eq!(
            i.resolve("a/b/s.md", "", LinkKind::Wikilink).as_deref(),
            Some("a/b/s.md")
        );
        assert_eq!(
            i.resolve("a/s.md", "m.md", LinkKind::Markdown).as_deref(),
            Some("a/m.md")
        );
    }

    #[test]
    fn unicode_spaces_extension_and_ties() {
        let i = idx(&[
            "Über Ordner/Größe Test.md",
            "x/Zebra.MD",
            "m/Twin.md",
            "k/Twin.md",
            "Some Folder/Sub Dir/My Note.md",
        ]);
        let r = |raw: &str| i.resolve("s/src.md", raw, LinkKind::Wikilink);
        assert_eq!(
            r("größe test").as_deref(),
            Some("Über Ordner/Größe Test.md")
        );
        assert_eq!(r("GRÖSSE test"), None); // no ß -> SS folding: lowercase only
        assert_eq!(r("zebra").as_deref(), Some("x/Zebra.MD"));
        assert_eq!(r("Zebra.md").as_deref(), Some("x/Zebra.MD"));
        assert_eq!(
            r("sub dir/my note").as_deref(),
            Some("Some Folder/Sub Dir/My Note.md")
        );
        assert_eq!(
            r("Some Folder/Sub Dir/My Note.md").as_deref(),
            Some("Some Folder/Sub Dir/My Note.md")
        );
        // equal depth and length: alphabetical
        assert_eq!(r("twin").as_deref(), Some("k/Twin.md"));
        // a frontmatter-title-like phrase that is nobody's file name does not resolve
        assert_eq!(r("A Fancy Title"), None);
        // a note never answers to a name with a different extension
        assert_eq!(r("Twin.png"), None);
    }

    #[test]
    fn bucket_key_is_the_normalised_last_segment() {
        assert_eq!(bucket_key("Note"), "note");
        assert_eq!(bucket_key("a/B/Note.MD"), "note");
        assert_eq!(bucket_key("../x/Pic.PNG"), "pic.png");
        assert_eq!(
            bucket_key("Fran\u{63}\u{327}ois"),
            bucket_key("Fran\u{e7}ois")
        );
        assert_eq!(bucket_key(""), "");
        assert_eq!(bucket_key("  "), "");
        assert_eq!(bucket_key("folder/"), "folder/");
    }

    #[test]
    fn a_link_only_resolves_to_files_sharing_its_bucket_key() {
        // The incremental re-resolution rests on this: whatever the link text, the target's
        // own bucket key is the link's.
        let files = [
            "Note.md",
            "a/Note.md",
            "a/b/Note.md",
            "x/note.MD",
            "img/pic.png",
            "pic.png.md",
            "docs/Spec.PDF",
            "b/n.md",
            "n.md",
            "Ünï/çö.md",
            "c/Makefile",
        ];
        let i = idx(&files);
        let links = [
            "note",
            "Note.md",
            "a/note",
            "b/Note",
            "pic.png",
            "pic",
            "spec.pdf",
            "n",
            "b/n",
            "./n",
            "../n",
            "ÇÖ",
            "Ünï/çö",
            "makefile",
            "nope",
            "a/",
            "..",
        ];
        for src in ["s.md", "a/s.md", "a/b/s.md", "z/y/s.md"] {
            for raw in links {
                for kind in [LinkKind::Wikilink, LinkKind::Markdown] {
                    if let Some(path) = i.resolve(src, raw, kind) {
                        assert_eq!(
                            bucket_key(split_name(&path).1),
                            bucket_key(raw),
                            "{src} -> [[{raw}]] -> {path}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn ambiguity_is_reported_for_bare_names_that_match_several_files() {
        let i = idx(&["a/n.md", "b/n.md", "u/only.md", "n.md"]);
        let d = |src: &str, raw: &str| i.resolve_detailed(src, raw, LinkKind::Wikilink).unwrap();
        // Nearest folder picks one, but the name is shared.
        assert!(d("a/s.md", "n").ambiguous);
        assert_eq!(d("a/s.md", "n").path, "n.md"); // exact root path wins
        assert!(!d("a/s.md", "a/n").ambiguous, "a path names its file");
        assert!(!d("a/s.md", "only").ambiguous);
        let j = idx(&["a/n.md", "b/n.md"]);
        let r = j
            .resolve_detailed("b/s.md", "n", LinkKind::Wikilink)
            .unwrap();
        assert_eq!((r.path.as_str(), r.ambiguous), ("b/n.md", true));
    }

    #[test]
    fn remove_updates_maps() {
        let mut i = idx(&["a/n.md", "b/n.md"]);
        i.remove("a/n.md");
        assert_eq!(
            i.resolve("z.md", "n", LinkKind::Wikilink).as_deref(),
            Some("b/n.md")
        );
        i.remove("b/n.md");
        assert_eq!(i.resolve("z.md", "n", LinkKind::Wikilink), None);
        assert_eq!(i.len(), 0);
    }
}
