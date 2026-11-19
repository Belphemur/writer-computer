//! The registry of file kinds (ADR 2026-11-18 "let features contribute file kinds and text
//! extractors to search", specs `SPECs/search-spec.md` "File kinds" and `SPECs/code-files-spec.md`).
//!
//! A kind is one sort of file the vault lists and searches: a note, an image, a PDF, a code file,
//! a drawing, a base. Each declares the file-name suffixes it owns, the gate that lists it (a
//! feature switch, a core setting or the code-files policy), whether its text is searched and where
//! the matching lines come from, and an optional Rust extractor that turns the file into text.
//! Core contributes the kinds it owns (`note`, `image`); every feature contributes its own through
//! [`crate::features::Feature::file_kinds`] (static data, like `cli_commands`), so a new file type
//! is one entry here and no edit in the listing or the search code.
//!
//! This module is Tauri-free, like the rest of `index/`. "Is this file listed" is still answered
//! by `code_files` (the one visibility seam), which reads this registry; the index walker reads
//! it to decide what to extract.

use crate::code_files::Policy;
use std::path::Path;
use std::sync::OnceLock;

/// What an extractor returns: the document's own title (a PDF's info title) and its text.
/// A paged document starts every page with a line holding one form feed ([`PAGE_BREAK`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Extracted {
    pub title: Option<String>,
    pub body: String,
    /// Links the file carries that its text does not show to the note scanner (a drawing's
    /// element links), written as the markdown would: `[[Note]]`, one per entry. The index reads
    /// them like the body's links, so backlinks, the graph and unresolved links see them as links
    /// of the file, whatever its kind.
    pub links: Vec<String>,
}

/// The line that starts each page of an extracted paged document (a form feed). The snippet's page
/// is the number of such lines above it.
pub const PAGE_BREAK: &str = "\u{c}";

/// Why a file has no content in the index: its name stays listed and searchable, nothing else.
/// The class is what the log carries (never the path or the text).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractError {
    /// Protected by a password.
    Encrypted,
    /// Not a valid file of its kind.
    Malformed,
    /// Binary or not UTF-8, for a text kind.
    NotText,
    /// Above the kind's size cap, or past its page cap.
    TooLarge,
    /// A secret-looking file name: never read for content.
    SecretName,
    /// The extractor panicked (contained by [`extract::run`](super::extract::run)).
    Panicked,
}

impl ExtractError {
    pub fn class(self) -> &'static str {
        match self {
            ExtractError::Encrypted => "encrypted",
            ExtractError::Malformed => "malformed",
            ExtractError::NotText => "not-text",
            ExtractError::TooLarge => "too-large",
            ExtractError::SecretName => "secret-name",
            ExtractError::Panicked => "panicked",
        }
    }
}

/// The extractor of a kind: the file's absolute path (to read its extension, never to log) and its
/// bytes. Runs under `catch_unwind` on the walker threads and the watcher path.
pub type Extractor = fn(&Path, &[u8]) -> Result<Extracted, ExtractError>;

/// What lists a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Always,
    /// The feature `id` is switched on (`features.<id>.enabled`).
    Feature(&'static str),
    /// A core setting that lists the kind (`files.show-images`, `files.show-pdfs`).
    Setting(&'static str),
    /// The code-files policy (the feature switch and the extension list).
    Code,
}

/// Where the matching lines of a kind's hits come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextSource {
    /// No text row: found by name (an image, a base).
    None,
    /// The file on disk, line for line (notes, code).
    Disk,
    /// The extracted text kept in the index (`file_text`): a PDF, a drawing.
    Stored,
}

/// How a kind with a text extractor gets its text.
pub struct Extract {
    pub run: Extractor,
    /// Files above this many bytes are named only; not even read.
    pub max_bytes: fn() -> u64,
}

/// File names a kind owns by a rule that depends on the settings (the code files: the extension
/// list setting and `Dockerfile`-like names), where a fixed suffix list cannot say it.
pub trait NameRule: Sync {
    fn matches(&self, policy: &Policy, name: &str) -> bool;
    /// Lowercase extensions this rule lists under `policy` (for the SQL predicate).
    fn exts(&self, policy: &Policy) -> Vec<String>;
    /// Whole file names this rule lists under `policy`.
    fn names(&self, policy: &Policy) -> Vec<String>;
}

pub struct FileKind {
    /// The stable key of `kind:` and of the UI.
    pub id: &'static str,
    pub label: &'static str,
    /// A Hugeicons name; the UI draws it unless the icons feature set one for the file.
    pub icon: &'static str,
    /// Lowercase file-name suffixes with their dot (`.md`, `.excalidraw.md`); the longest match
    /// across all kinds wins, so a drawing note is a `drawing`, not a `note`.
    pub matches: &'static [&'static str],
    pub names: Option<&'static dyn NameRule>,
    pub listed_by: Gate,
    /// What lets the kind's content be read: with it closed the files stay listed (by `listed_by`)
    /// and found by name, and their text is neither extracted nor kept. Usually `listed_by`; the
    /// PDFs are listed by `files.show-pdfs` and read while the `pdf` feature is on.
    pub content_by: Gate,
    pub text: TextSource,
    pub extract: Option<Extract>,
}

/// The kinds core owns. Notes are parsed by the note parser, not an extractor.
static CORE_KINDS: [FileKind; 2] = [
    FileKind {
        id: "note",
        label: "Notes",
        icon: "File02Icon",
        matches: &[".md"],
        names: None,
        listed_by: Gate::Always,
        content_by: Gate::Always,
        text: TextSource::Disk,
        extract: None,
    },
    FileKind {
        id: "image",
        label: "Images",
        icon: "ImageIcon",
        // the one image-type list is `renderExtensions` of `shared/attachments.json`, read by
        // `code_files::is_image_name_with` through [`IMAGE_RULE`]
        matches: &[],
        names: Some(&IMAGE_RULE),
        listed_by: Gate::Setting(crate::code_files::SETTING_IMAGES),
        content_by: Gate::Always,
        text: TextSource::None,
        extract: None,
    },
];

/// The renderable image extensions are data (`shared/attachments.json`), not a suffix list here.
struct ImageRule;
static IMAGE_RULE: ImageRule = ImageRule;

impl NameRule for ImageRule {
    fn matches(&self, policy: &Policy, name: &str) -> bool {
        crate::code_files::is_image_name_with(policy, name)
    }
    fn exts(&self, _policy: &Policy) -> Vec<String> {
        crate::attachments::render_extensions().to_vec()
    }
    fn names(&self, _policy: &Policy) -> Vec<String> {
        Vec::new()
    }
}

/// Every kind: core's, then each feature's in registry order. Read once.
pub fn registry() -> &'static [&'static FileKind] {
    static ALL: OnceLock<Vec<&'static FileKind>> = OnceLock::new();
    ALL.get_or_init(|| {
        let mut all: Vec<&'static FileKind> = CORE_KINDS.iter().collect();
        all.extend(crate::features::file_kinds());
        all
    })
}

pub fn by_id(id: &str) -> Option<&'static FileKind> {
    registry().iter().copied().find(|k| k.id == id)
}

/// The ids of every registered kind (what `kind:` accepts), in registry order.
pub fn ids() -> Vec<&'static str> {
    registry().iter().map(|k| k.id).collect()
}

/// Does the index read the text of files of `kind` under `policy`: the kind has text and its
/// content gate is open.
pub fn indexes_text(policy: &Policy, kind: &FileKind) -> bool {
    kind.text != TextSource::None && gate_open(policy, &kind.content_by)
}

pub fn gate_open(policy: &Policy, gate: &Gate) -> bool {
    match gate {
        Gate::Always => true,
        Gate::Feature(id) => !policy.features_off.contains(*id),
        Gate::Setting(key) => policy.setting_on(key),
        Gate::Code => policy.code,
    }
}

/// Is `name` longer than `suffix` and ending in it? A bare `.md` has no stem and is no note.
fn has_suffix(lower: &str, suffix: &str) -> bool {
    lower.len() > suffix.len() && lower.ends_with(suffix)
}

/// The kind of the file called `name` under `policy`, or `None` when nothing lists it. The longest
/// matching suffix among the kinds whose gate is open wins; a kind owned by a rule (code, images)
/// comes after every suffix match. A kind whose gate is closed falls through to the next, so a
/// drawing note is a plain note while the drawing feature is off.
pub fn kind_of(policy: &Policy, name: &str) -> Option<&'static FileKind> {
    let lower = name.to_lowercase();
    let mut best: Option<(usize, &'static FileKind)> = None;
    for kind in registry() {
        if !gate_open(policy, &kind.listed_by) {
            continue;
        }
        for suffix in kind.matches {
            if has_suffix(&lower, suffix) && best.is_none_or(|(len, _)| suffix.len() > len) {
                best = Some((suffix.len(), kind));
            }
        }
    }
    if let Some((_, kind)) = best {
        return Some(kind);
    }
    registry().iter().copied().find(|k| {
        gate_open(policy, &k.listed_by) && k.names.is_some_and(|r| r.matches(policy, name))
    })
}

/// The kind id stored in `files.kind` for `name`: the kind's id, or `""` when it is not listed.
pub fn kind_id_of(policy: &Policy, name: &str) -> &'static str {
    kind_of(policy, name).map_or("", |k| k.id)
}

/// What `search_kinds` tells the UI about a listed kind.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct KindInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub icon: &'static str,
}

/// The kinds listed under `policy`, in registry order: the chips of the palettes.
pub fn listed(policy: &Policy) -> Vec<KindInfo> {
    registry()
        .iter()
        .filter(|k| gate_open(policy, &k.listed_by))
        .map(|k| KindInfo {
            id: k.id,
            label: k.label,
            icon: k.icon,
        })
        .collect()
}

/// The ids of the kinds that have text rows (`kind.text != None`): searched by content.
pub fn text_kind_ids() -> Vec<&'static str> {
    registry()
        .iter()
        .filter(|k| k.text != TextSource::None)
        .map(|k| k.id)
        .collect()
}

/// The ids of the kinds found by name only.
pub fn name_only_kind_ids() -> Vec<&'static str> {
    registry()
        .iter()
        .filter(|k| k.text == TextSource::None)
        .map(|k| k.id)
        .collect()
}

/// The `WHERE` predicate over `files.ext` / `files.name` selecting the rows `policy` lists: the
/// fixed suffixes of every open kind, plus what each name rule lists. A suffix with one dot is an
/// extension; a longer one (`.excalidraw.md`) is a `LIKE` on the lowercase name.
pub fn listed_sql_predicate(policy: &Policy) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let mut exts: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut likes: Vec<String> = Vec::new();
    for kind in registry()
        .iter()
        .filter(|k| gate_open(policy, &k.listed_by))
    {
        for suffix in kind.matches {
            let bare = suffix.trim_start_matches('.');
            if bare.contains('.') {
                likes.push(format!(
                    "lower(name) LIKE '%{}' ESCAPE '\\'",
                    suffix
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                        .replace('\'', "''")
                ));
            } else {
                exts.push(bare.to_string());
            }
        }
        if let Some(rule) = kind.names {
            exts.extend(rule.exts(policy));
            names.extend(rule.names(policy));
        }
    }
    exts.sort();
    exts.dedup();
    names.sort();
    names.dedup();
    let mut terms = vec![format!(
        "ext IN ({})",
        exts.iter().map(|e| quote(e)).collect::<Vec<_>>().join(",")
    )];
    if !names.is_empty() {
        terms.push(format!(
            "name IN ({})",
            names.iter().map(|n| quote(n)).collect::<Vec<_>>().join(",")
        ));
    }
    terms.extend(likes);
    format!("({})", terms.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_longest_suffix_wins() {
        let p = Policy::default();
        assert_eq!(kind_id_of(&p, "a.md"), "note");
        assert_eq!(kind_id_of(&p, "Sketch.excalidraw.md"), "drawing");
        assert_eq!(kind_id_of(&p, "Sketch.EXCALIDRAW.MD"), "drawing");
        assert_eq!(kind_id_of(&p, "Sketch.excalidraw"), "drawing");
        assert_eq!(kind_id_of(&p, "t.base"), "base");
        assert_eq!(kind_id_of(&p, "p.png"), "image");
        assert_eq!(kind_id_of(&p, "p.pdf"), "pdf");
        assert_eq!(kind_id_of(&p, "run.py"), "code");
        assert_eq!(kind_id_of(&p, "Dockerfile"), "code");
        // no stem, no kind; unknown and secret names are not listed
        for n in [
            ".md",
            ".pdf",
            "a.zip",
            "noext",
            ".env",
            "id_rsa",
            "secrets.yaml",
        ] {
            assert_eq!(kind_id_of(&p, n), "", "{n}");
        }
    }

    #[test]
    fn a_closed_gate_falls_through_to_the_next_suffix() {
        let mut p = Policy::default();
        p.features_off.insert("excalidraw".into());
        // the drawing note is a plain note while the feature is off; the plain drawing is unlisted
        assert_eq!(kind_id_of(&p, "Sketch.excalidraw.md"), "note");
        assert_eq!(kind_id_of(&p, "Sketch.excalidraw"), "");
        p.features_off.insert("bases".into());
        assert_eq!(kind_id_of(&p, "t.base"), "");
    }

    #[test]
    fn settings_and_the_code_policy_gate_their_kinds() {
        let p = Policy {
            show_images: false,
            show_pdfs: false,
            ..Policy::default()
        };
        assert_eq!(kind_id_of(&p, "p.png"), "");
        assert_eq!(kind_id_of(&p, "p.pdf"), "");
        assert_eq!(kind_id_of(&p, "a.md"), "note");
        let notes_only = Policy::notes_only();
        assert_eq!(kind_id_of(&notes_only, "run.py"), "");
        assert_eq!(kind_id_of(&notes_only, "t.base"), "base");
        let listed: Vec<&str> = listed(&notes_only).iter().map(|k| k.id).collect();
        assert!(!listed.contains(&"code") && listed.contains(&"pdf"));
    }

    #[test]
    fn the_registry_has_unique_ids_and_known_gates() {
        let ids = ids();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "duplicate kind id in {ids:?}");
        for expected in ["note", "image", "base", "code", "drawing", "pdf"] {
            assert!(ids.contains(&expected), "{expected}");
        }
        for k in registry() {
            // a kind with an extractor has text to show
            assert!(
                k.extract.is_none() || k.text != TextSource::None,
                "{}",
                k.id
            );
            for s in k.matches {
                assert!(s.starts_with('.') && *s == s.to_lowercase(), "{} {s}", k.id);
            }
            if let Gate::Feature(id) = k.listed_by {
                assert!(
                    crate::features::registry::<tauri::Wry>()
                        .iter()
                        .any(|f| f.manifest().is_ok_and(|m| m.id == id)),
                    "{}: its feature {id} is not registered",
                    k.id
                );
            }
        }
    }

    #[test]
    fn every_kind_icon_has_a_glyph_in_the_ui_table() {
        // `src/lib/kind-icons.ts` maps the Hugeicons names the registry uses to components: a
        // name is imported and listed there, so it appears at least twice
        let table = include_str!("../../../src/lib/kind-icons.ts");
        for k in registry() {
            assert!(
                table.matches(k.icon).count() >= 2,
                "kind {}: icon {} is missing from src/lib/kind-icons.ts",
                k.id,
                k.icon
            );
        }
    }

    #[test]
    fn the_sql_predicate_follows_the_registry() {
        let sql = listed_sql_predicate(&Policy::default());
        for want in [
            "'md'",
            "'base'",
            "'excalidraw'",
            "'pdf'",
            "'png'",
            "'py'",
            "'Dockerfile'",
        ] {
            assert!(sql.contains(want), "{want} in {sql}");
        }
        assert!(sql.contains("lower(name) LIKE '%.excalidraw.md'"));
        assert!(!sql.contains("'env'") && !sql.contains("'ipynb'"));
        let mut p = Policy::notes_only();
        p.features_off.insert("bases".into());
        let off = listed_sql_predicate(&p);
        assert!(!off.contains("'base'") && !off.contains("'py'") && off.contains("'md'"));
    }
}
