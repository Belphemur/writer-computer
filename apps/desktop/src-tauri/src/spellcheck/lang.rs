//! Which language a piece of a note is in (ADR 2026-11-18, point 5). Precedence, first match
//! wins:
//!
//! 1. the user's override for this note (the status item's list), same weight as the property;
//! 2. the note's `lang:` / `language:` property;
//! 3. a folder rule (`spellcheck.folder-languages`, `Folder=lang`, the longest folder wins);
//! 4. lingua detection over English and French, per block of at least [`MIN_DETECT_CHARS`]
//!    characters of prose and a confidence of at least [`MIN_CONFIDENCE`]; a shorter block or a
//!    lower confidence uses the note's language;
//! 5. the default language (`spellcheck.default-language`).
//!
//! Detection only runs when 1 to 3 gave nothing, and only ever answers English or French
//! (lingua is built with those two models and `with_low_accuracy_mode`). Any other language comes
//! from 1 to 3 or the default.

use lingua::{Language, LanguageDetector, LanguageDetectorBuilder};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::OnceLock;

/// A block shorter than this (in characters of prose) is too short for detection to be reliable
/// in low-accuracy mode; it takes the note's language.
pub const MIN_DETECT_CHARS: usize = 120;
/// The detector's confidence needed to override the note's language.
pub const MIN_CONFIDENCE: f64 = 0.9;

/// A language tag, normalised: lowercase language, optional script in title case and region in
/// upper case, joined by `-` (`en`, `en-GB`, `pt-BR`, `sr-Latn`). The ids of the Hunspell
/// dictionary catalog are exactly such tags, so a `Lang` names a dictionary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Lang(String);

impl Lang {
    /// Parses `fr`, `FR`, `fr_FR`, `fr-fr`, `sr-latn` and `ca-valencia`; `None` for anything that
    /// is not two or three letters, optionally followed by a four-letter script, a two-letter or
    /// three-digit region and a five to eight character variant.
    pub fn parse(input: &str) -> Option<Lang> {
        let mut parts = input.trim().split(['-', '_']);
        let language = parts.next()?;
        if !(2..=3).contains(&language.len()) || !language.chars().all(|c| c.is_ascii_alphabetic())
        {
            return None;
        }
        let mut tag = language.to_ascii_lowercase();
        // script, then region, then variants: each of the first two at most once
        let mut stage = 0;
        for part in parts {
            let letters = part.chars().all(|c| c.is_ascii_alphabetic());
            if part.len() == 4 && letters && stage == 0 {
                let (head, rest) = part.split_at(1);
                tag.push('-');
                tag.push_str(&head.to_ascii_uppercase());
                tag.push_str(&rest.to_ascii_lowercase());
                stage = 1;
            } else if ((part.len() == 2 && letters)
                || (part.len() == 3 && part.chars().all(|c| c.is_ascii_digit())))
                && stage <= 1
            {
                tag.push('-');
                tag.push_str(&part.to_ascii_uppercase());
                stage = 2;
            } else if (5..=8).contains(&part.len())
                && part.chars().all(|c| c.is_ascii_alphanumeric())
            {
                // a variant (`valencia` in `ca-valencia`)
                tag.push('-');
                tag.push_str(&part.to_ascii_lowercase());
                stage = 3;
            } else {
                return None;
            }
        }
        Some(Lang(tag))
    }

    pub fn tag(&self) -> &str {
        &self.0
    }

    /// The language part (`en` for `en-GB`).
    pub fn primary(&self) -> &str {
        self.0.split('-').next().unwrap_or(&self.0)
    }

    /// The region part, when there is one (`GB` for `en-GB`).
    pub fn region(&self) -> Option<&str> {
        self.0
            .split('-')
            .skip(1)
            .find(|p| p.len() == 2 || p.chars().all(|c| c.is_ascii_digit()))
    }

    pub fn is_english(&self) -> bool {
        self.primary() == "en"
    }
}

impl std::fmt::Display for Lang {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Where a block's language came from, for the status item and the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Override,
    Property,
    Folder,
    Detected,
    Default,
}

/// The settings that decide a note's language.
#[derive(Debug, Clone)]
pub struct LangConfig {
    pub default: Lang,
    /// `(folder, language)`, folders vault-relative with no trailing slash.
    pub folders: Vec<(String, Lang)>,
}

impl Default for LangConfig {
    fn default() -> Self {
        Self {
            default: Lang("en".into()),
            folders: Vec::new(),
        }
    }
}

impl LangConfig {
    /// Reads the `Folder=lang` entries of the setting; an entry that is not one is skipped.
    pub fn with_folder_rules<'a>(mut self, entries: impl IntoIterator<Item = &'a str>) -> Self {
        self.folders = entries
            .into_iter()
            .filter_map(|e| {
                let (folder, lang) = e.rsplit_once('=')?;
                let folder = folder.trim().trim_matches('/').replace('\\', "/");
                Some((folder, Lang::parse(lang)?)).filter(|(f, _)| !f.is_empty())
            })
            .collect();
        self
    }

    fn folder_language(&self, rel_path: &str) -> Option<&Lang> {
        let path = rel_path.replace('\\', "/");
        self.folders
            .iter()
            .filter(|(folder, _)| {
                path.strip_prefix(folder.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
            })
            .max_by_key(|(folder, _)| folder.len())
            .map(|(_, lang)| lang)
    }
}

/// A note's language before detection looks at any block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteLang {
    pub lang: Lang,
    pub source: Source,
}

impl NoteLang {
    /// Detection runs only when nothing decided the note's language (no override, property or
    /// folder rule), so a caller can skip building the prose it reads otherwise.
    pub fn detects(&self) -> bool {
        self.source == Source::Default
    }
}

/// The note's language from the override, the property, a folder rule or the default.
pub fn note_language(
    text: &str,
    rel_path: &str,
    config: &LangConfig,
    user_override: Option<&Lang>,
) -> NoteLang {
    if let Some(lang) = user_override {
        return NoteLang {
            lang: lang.clone(),
            source: Source::Override,
        };
    }
    if let Some(lang) = property_language(text) {
        return NoteLang {
            lang,
            source: Source::Property,
        };
    }
    if let Some(lang) = config.folder_language(rel_path) {
        return NoteLang {
            lang: lang.clone(),
            source: Source::Folder,
        };
    }
    NoteLang {
        lang: config.default.clone(),
        source: Source::Default,
    }
}

/// The `lang:` (or `language:`) value in the note's front matter, when it parses as a tag.
pub fn property_language(text: &str) -> Option<Lang> {
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" || line == "..." {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if matches!(key.trim(), "lang" | "language") {
            let value = value.trim().trim_matches(['"', '\'']);
            return Lang::parse(value);
        }
    }
    None
}

/// lingua over English and French, built on first use (the models are decoded then).
pub struct Detector {
    inner: OnceLock<LanguageDetector>,
}

impl Detector {
    pub const fn new() -> Self {
        Self {
            inner: OnceLock::new(),
        }
    }

    fn detector(&self) -> &LanguageDetector {
        self.inner.get_or_init(|| {
            LanguageDetectorBuilder::from_languages(&[Language::English, Language::French])
                .with_low_accuracy_mode()
                .build()
        })
    }

    /// `en` or `fr` when the prose is long enough and the confidence is high enough.
    pub fn detect(&self, prose: &str) -> Option<Lang> {
        if prose.chars().count() < MIN_DETECT_CHARS {
            return None;
        }
        let (language, confidence) = self
            .detector()
            .compute_language_confidence_values(prose)
            .into_iter()
            .next()?;
        if confidence < MIN_CONFIDENCE {
            return None;
        }
        match language {
            Language::English => Lang::parse("en"),
            Language::French => Lang::parse("fr"),
        }
    }
}

impl Default for Detector {
    fn default() -> Self {
        Self::new()
    }
}

/// The language of one block: the note's when it was decided (override, property, folder),
/// otherwise the detector's answer for a long confident block, otherwise the default. A detected
/// language that shares the default's language keeps the default's region (`en-GB` stays `en-GB`).
pub fn block_language(
    note: &NoteLang,
    prose: impl FnOnce() -> String,
    detector: &Detector,
) -> (Lang, Source) {
    if !note.detects() {
        return (note.lang.clone(), note.source);
    }
    match detector.detect(&prose()) {
        Some(found) if found.primary() == note.lang.primary() => {
            (note.lang.clone(), Source::Detected)
        }
        Some(found) => (found, Source::Detected),
        None => (note.lang.clone(), Source::Default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENGLISH: &str = "The committee met on Tuesday afternoon to review the proposal that had been circulated the week before, and after a long discussion they agreed to approve it with only a few small changes.";
    const FRENCH: &str = "Le comité s'est réuni mardi après-midi pour examiner la proposition qui avait été distribuée la semaine précédente, et après une longue discussion ils ont décidé de l'approuver avec seulement quelques petites modifications.";

    #[test]
    fn tags_are_normalised_and_bad_ones_refused() {
        for (input, tag) in [
            ("fr", "fr"),
            ("FR", "fr"),
            ("fr_fr", "fr-FR"),
            ("en-gb", "en-GB"),
            ("sr-latn", "sr-Latn"),
            (" pt-BR ", "pt-BR"),
            ("es-419", "es-419"),
            ("CA-Valencia", "ca-valencia"),
        ] {
            assert_eq!(Lang::parse(input).unwrap().tag(), tag, "{input}");
        }
        for bad in [
            "",
            "english",
            "f",
            "fr-",
            "fr-FRA",
            "fr--FR",
            "12",
            "fr FR",
            "fr-toolongvariant",
        ] {
            assert!(Lang::parse(bad).is_none(), "{bad}");
        }
        let gb = Lang::parse("en-GB").unwrap();
        assert_eq!(
            (gb.primary(), gb.region(), gb.is_english()),
            ("en", Some("GB"), true)
        );
        assert_eq!(Lang::parse("sr-Latn").unwrap().region(), None);
    }

    #[test]
    fn the_property_beats_a_folder_rule_and_the_override_beats_both() {
        let config = LangConfig::default().with_folder_rules(["Journal=fr", "Journal/Work=de"]);
        let with_property = "---\nlang: es\n---\nHola";
        let n = note_language(with_property, "Journal/a.md", &config, None);
        assert_eq!((n.lang.tag(), n.source), ("es", Source::Property));

        let n = note_language("Hello", "Journal/Work/a.md", &config, None);
        assert_eq!(
            (n.lang.tag(), n.source),
            ("de", Source::Folder),
            "the longest folder wins"
        );
        let n = note_language("Hello", "Journal/a.md", &config, None);
        assert_eq!(n.lang.tag(), "fr");
        let n = note_language("Hello", "Journalism/a.md", &config, None);
        assert_eq!(
            (n.lang.tag(), n.source),
            ("en", Source::Default),
            "a folder name is not a prefix match"
        );

        let o = Lang::parse("it").unwrap();
        let n = note_language(with_property, "Journal/a.md", &config, Some(&o));
        assert_eq!((n.lang.tag(), n.source), ("it", Source::Override));
    }

    #[test]
    fn the_property_reads_lang_or_language_and_only_in_front_matter() {
        assert_eq!(
            property_language("---\nlanguage: \"fr-CA\"\n---\n")
                .unwrap()
                .tag(),
            "fr-CA"
        );
        assert_eq!(
            property_language("---\ntitle: x\nlang: 'de'\n---\n")
                .unwrap()
                .tag(),
            "de"
        );
        assert!(property_language("lang: fr\n").is_none(), "no front matter");
        assert!(
            property_language("---\ntitle: x\n---\nlang: fr\n").is_none(),
            "after the block"
        );
        assert!(property_language("---\nlang: klingon!\n---\n").is_none());
    }

    #[test]
    fn folder_rule_entries_that_are_not_rules_are_skipped() {
        let config = LangConfig::default().with_folder_rules([
            "nonsense",
            "=fr",
            "A=",
            "B=xx-yy-zz",
            "Notes/=de",
        ]);
        assert_eq!(
            config.folders,
            vec![("Notes".to_string(), Lang::parse("de").unwrap())]
        );
    }

    #[test]
    fn detection_tells_english_from_french_and_ignores_short_text() {
        let d = Detector::new();
        assert_eq!(d.detect(ENGLISH).unwrap().tag(), "en");
        assert_eq!(d.detect(FRENCH).unwrap().tag(), "fr");
        assert!(
            d.detect("Bonjour tout le monde, ceci est court.").is_none(),
            "under the length threshold"
        );
        assert!(
            d.detect(&"x".repeat(MIN_DETECT_CHARS)).is_none(),
            "no confidence on noise"
        );
    }

    #[test]
    fn a_block_uses_the_notes_language_unless_nothing_decided_it() {
        let d = Detector::new();
        let default = NoteLang {
            lang: Lang::parse("en-GB").unwrap(),
            source: Source::Default,
        };
        let (l, s) = block_language(&default, || FRENCH.into(), &d);
        assert_eq!((l.tag(), s), ("fr", Source::Detected));
        let (l, s) = block_language(&default, || ENGLISH.into(), &d);
        assert_eq!(
            (l.tag(), s),
            ("en-GB", Source::Detected),
            "the default's region is kept"
        );
        let (l, s) = block_language(&default, || "Short.".into(), &d);
        assert_eq!((l.tag(), s), ("en-GB", Source::Default));

        let property = NoteLang {
            lang: Lang::parse("en").unwrap(),
            source: Source::Property,
        };
        let (l, s) = block_language(&property, || unreachable!("the property decided"), &d);
        assert_eq!(
            (l.tag(), s),
            ("en", Source::Property),
            "the property always wins"
        );
    }
}
