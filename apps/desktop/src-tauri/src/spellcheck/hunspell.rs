//! The spelling provider for every language but English: any installed Hunspell dictionary,
//! checked with `spellbook` (MPL-2.0). It reads only the prose the mask leaves, splits it into
//! words and reports the ones the dictionary does not know, with up to [`MAX_SUGGESTIONS`]
//! replacements. It does no grammar.

use super::checker::{CheckProvider, Hit, Kind, Prose, Provider};
use super::dictionaries;
use super::lang::Lang;
use parking_lot::RwLock;
use spellbook::Dictionary;
use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;

const MAX_SUGGESTIONS: usize = 5;

pub struct HunspellProvider {
    dir: PathBuf,
    /// Loaded dictionaries by id; a `None` is a dictionary that failed to load (logged once).
    loaded: RwLock<HashMap<String, Option<Arc<Dictionary>>>>,
}

impl HunspellProvider {
    /// `dir` is the dictionaries folder (`dictionaries::dir`).
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            loaded: RwLock::new(HashMap::new()),
        }
    }

    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    /// Forgets a loaded dictionary (after an install or a removal) so the next check reads the
    /// files again.
    pub fn invalidate(&self, id: &str) {
        self.loaded.write().remove(id);
    }

    fn installed_ids(&self) -> Vec<String> {
        dictionaries::installed(&self.dir)
            .into_iter()
            .map(|d| d.id)
            .collect()
    }

    /// The id of the installed dictionary that checks `lang`.
    pub fn resolve(&self, lang: &Lang) -> Option<String> {
        dictionaries::resolve(&self.installed_ids(), lang)
    }

    fn dictionary(&self, id: &str) -> Option<Arc<Dictionary>> {
        if let Some(d) = self.loaded.read().get(id) {
            return d.clone();
        }
        let loaded = match dictionaries::read_files(&self.dir, id) {
            Ok((aff, dic)) => match Dictionary::new(&aff, &dic) {
                Ok(d) => Some(Arc::new(d)),
                Err(e) => {
                    log::warn!("spellcheck: dictionary {id} did not load: {e}");
                    None
                }
            },
            Err(e) => {
                log::warn!("spellcheck: dictionary {id} is unreadable: {e}");
                None
            }
        };
        self.loaded.write().insert(id.to_string(), loaded.clone());
        loaded
    }
}

impl CheckProvider for HunspellProvider {
    fn id(&self) -> Provider {
        Provider::Hunspell
    }

    fn supports(&self, lang: &Lang) -> bool {
        self.resolve(lang).is_some()
    }

    fn check(&self, prose: &Prose<'_>, lang: &Lang) -> Vec<Hit> {
        let Some(dictionary) = self.resolve(lang).and_then(|id| self.dictionary(&id)) else {
            return Vec::new();
        };
        let mut hits = Vec::new();
        for (range, word) in words(prose) {
            if dictionary.check(&word) {
                continue;
            }
            let mut suggestions = Vec::new();
            dictionary.suggest(&word, &mut suggestions);
            suggestions.truncate(MAX_SUGGESTIONS);
            hits.push(Hit {
                range,
                kind: Kind::Spelling,
                message: "Possible misspelling".into(),
                replacements: suggestions,
                rule_id: "hunspell.spelling".into(),
                provider: Provider::Hunspell,
            });
        }
        hits
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || ('\u{300}'..='\u{36f}').contains(&c)
}

fn is_connector(c: char) -> bool {
    matches!(c, '\'' | '’' | '-' | '\u{2011}')
}

/// Whether a token is worth checking: not a number, an identifier, an acronym or a camelCase
/// name, none of which a dictionary knows.
fn worth_checking(word: &str) -> bool {
    let letters = word.chars().filter(|c| c.is_alphabetic()).count();
    if letters < 2 || word.chars().any(|c| c.is_numeric() || c == '_') {
        return false;
    }
    if word.chars().all(|c| !c.is_alphabetic() || c.is_uppercase()) {
        return false; // an acronym
    }
    let mut prev_lower = false;
    for c in word.chars() {
        if c.is_uppercase() && prev_lower {
            return false; // camelCase
        }
        prev_lower = c.is_lowercase();
    }
    true
}

/// The words of the allowed ranges: `char` range in the block and the text to check (a curly
/// apostrophe becomes a straight one, what dictionaries are written with).
fn words(prose: &Prose<'_>) -> Vec<(Range<usize>, String)> {
    let mut out = Vec::new();
    for run in prose.allowed {
        let mut i = run.start;
        while i < run.end {
            if !is_word_char(prose.chars[i]) {
                i += 1;
                continue;
            }
            let start = i;
            while i < run.end
                && (is_word_char(prose.chars[i])
                    || (is_connector(prose.chars[i])
                        && i + 1 < run.end
                        && is_word_char(prose.chars[i + 1])))
            {
                i += 1;
            }
            let word: String = prose.chars[start..i]
                .iter()
                .map(|&c| if c == '’' { '\'' } else { c })
                .collect();
            if worth_checking(&word) {
                out.push((start..i, word));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::dictionaries::test_support::{AFF, DIC};
    use super::*;

    fn provider() -> (tempfile::TempDir, HunspellProvider) {
        let dir = tempfile::tempdir().unwrap();
        let de = dir.path().join("de");
        std::fs::create_dir_all(&de).unwrap();
        std::fs::write(de.join("index.aff"), AFF).unwrap();
        std::fs::write(de.join("index.dic"), DIC).unwrap();
        std::fs::write(de.join("meta.json"), r#"{"id":"de","name":"German","license":"MIT","commit":"","aff_sha256":"","dic_sha256":""}"#).unwrap();
        let p = HunspellProvider::new(dir.path().to_path_buf());
        (dir, p)
    }

    fn check(p: &HunspellProvider, text: &str, lang: &str) -> Vec<(String, Hit)> {
        let chars: Vec<char> = text.chars().collect();
        let allowed = vec![0..chars.len()];
        p.check(
            &Prose {
                chars: &chars,
                allowed: &allowed,
            },
            &Lang::parse(lang).unwrap(),
        )
        .into_iter()
        .map(|h| (chars[h.range.clone()].iter().collect::<String>(), h))
        .collect()
    }

    #[test]
    fn a_misspelling_is_found_with_suggestions_and_known_words_are_not() {
        let (_d, p) = provider();
        let hits = check(&p, "der Haus und Hauzse Garten", "de");
        let words: Vec<_> = hits.iter().map(|(w, _)| w.as_str()).collect();
        assert_eq!(
            words,
            vec!["und", "Hauzse"],
            "Haus, Garten and der are known"
        );
        let (_, h) = &hits[1];
        assert_eq!((h.kind, h.provider), (Kind::Spelling, Provider::Hunspell));
        assert!(h.replacements.len() <= MAX_SUGGESTIONS);
    }

    #[test]
    fn affix_rules_make_inflected_forms_known() {
        let (_d, p) = provider();
        assert!(
            check(&p, "Hause Bucher Buche", "de")
                .iter()
                .all(|(w, _)| w != "Hause" && w != "Buche"),
            "Haus+e and Buch+e come from the S rule"
        );
    }

    #[test]
    fn tokens_a_dictionary_cannot_know_are_skipped() {
        let (_d, p) = provider();
        let text = "snake_case 1234 HTTP iPhone x2 a der";
        assert!(
            check(&p, text, "de").is_empty(),
            "identifiers, numbers, acronyms, camelCase and single letters"
        );
    }

    #[test]
    fn only_allowed_ranges_are_read_and_offsets_are_char_offsets() {
        let (_d, p) = provider();
        let text = "ünd `bogus` bad";
        let chars: Vec<char> = text.chars().collect();
        let allowed = vec![0..4, 12..chars.len()];
        let hits = p.check(
            &Prose {
                chars: &chars,
                allowed: &allowed,
            },
            &Lang::parse("de").unwrap(),
        );
        let ranges: Vec<_> = hits.iter().map(|h| h.range.clone()).collect();
        assert_eq!(
            ranges,
            vec![0..3, 12..15],
            "the masked word is skipped; ü counts one char"
        );
    }

    #[test]
    fn a_curly_apostrophe_is_checked_as_a_straight_one() {
        let chars: Vec<char> = "l’école d'abord".chars().collect();
        let allowed = vec![0..chars.len()];
        let w: Vec<_> = words(&Prose {
            chars: &chars,
            allowed: &allowed,
        })
        .into_iter()
        .map(|(_, w)| w)
        .collect();
        assert_eq!(w, vec!["l'école", "d'abord"]);
    }

    #[test]
    fn a_language_without_a_dictionary_is_unsupported_and_checks_nothing() {
        let (_d, p) = provider();
        assert!(
            p.supports(&Lang::parse("de-AT").unwrap()),
            "a variant uses the installed language"
        );
        assert!(!p.supports(&Lang::parse("fr").unwrap()));
        assert!(!p.supports(&Lang::parse("en").unwrap()));
        assert!(check(&p, "bonjour mondee", "fr").is_empty());
    }

    #[test]
    fn invalidating_picks_up_a_changed_dictionary() {
        let (d, p) = provider();
        assert_eq!(check(&p, "Wald", "de").len(), 1);
        std::fs::write(
            d.path().join("de").join("index.dic"),
            format!("7\n{}Wald\n", &DIC[2..]),
        )
        .unwrap();
        assert_eq!(check(&p, "Wald", "de").len(), 1, "still the loaded copy");
        p.invalidate("de");
        assert!(check(&p, "Wald", "de").is_empty());
    }
}
