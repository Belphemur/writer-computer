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

use super::markdown::LinkKind;
use std::collections::{HashMap, HashSet};

#[derive(Default, Clone)]
pub struct PathIndex {
    paths: HashSet<String>,
    lower_to_path: HashMap<String, String>,
    md_by_base: HashMap<String, Vec<String>>,
    by_name: HashMap<String, Vec<String>>,
}

fn lower(s: &str) -> String {
    s.to_lowercase()
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
                .take_while(|(a, b)| a.eq_ignore_ascii_case(b))
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
        let raw = raw.trim();
        if raw.is_empty() {
            return Some(src_path.to_string());
        }
        let (src_dir, _) = split_name(src_path);

        if raw.starts_with("./") || raw.starts_with("../") {
            let joined = if src_dir.is_empty() {
                raw.to_string()
            } else {
                format!("{src_dir}/{raw}")
            };
            return normalize(&joined).and_then(|p| self.exact(&p));
        }
        let is_markdown = matches!(kind, LinkKind::Markdown | LinkKind::MarkdownEmbed);
        if is_markdown && !src_dir.is_empty() {
            if let Some(p) = normalize(&format!("{src_dir}/{raw}")).and_then(|p| self.exact(&p)) {
                return Some(p);
            }
        }
        let rooted = raw.trim_start_matches('/');
        let rooted = normalize(rooted)?;
        if let Some(p) = self.exact(&rooted) {
            return Some(p);
        }

        let key = lower(&rooted);
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
        Self::best(cands, src_dir)
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
