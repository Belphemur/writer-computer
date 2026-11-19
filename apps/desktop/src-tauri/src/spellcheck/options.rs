//! The settings the engine reads, in one struct. The keys are declared once, in the feature's
//! settings fragment (`features/spellcheck/settings.schema.json`); this reads them through a
//! lookup so the app (merged settings) and the CLI (the global config file) share the parsing
//! and the defaults.

use super::harper::region_of_setting;
use super::lang::{Lang, LangConfig};
use crate::config::ConfigValue;
use std::collections::BTreeSet;

pub const CHECK_SPELLING: &str = "spellcheck.check-spelling";
pub const CHECK_GRAMMAR: &str = "spellcheck.check-grammar";
pub const CHECK_STYLE: &str = "spellcheck.check-style";
pub const ENGLISH_DIALECT: &str = "spellcheck.english-dialect";
pub const DEFAULT_LANGUAGE: &str = "spellcheck.default-language";
pub const FOLDER_LANGUAGES: &str = "spellcheck.folder-languages";
pub const IGNORED_RULES: &str = "spellcheck.ignored-rules";

#[derive(Debug, Clone)]
pub struct Options {
    pub spelling: bool,
    pub grammar: bool,
    pub style: bool,
    /// The region (`US`, `GB`, `CA`, `AU`, `IN`) an English text without one is checked as.
    pub english_region: &'static str,
    pub languages: LangConfig,
    pub ignored_rules: BTreeSet<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self::from_lookup(|_| None)
    }
}

impl Options {
    /// Builds the options from a settings lookup; a missing or malformed value takes its default.
    pub fn from_lookup(get: impl Fn(&str) -> Option<ConfigValue>) -> Self {
        let flag = |key: &str, default: bool| get(key).and_then(|v| v.as_bool()).unwrap_or(default);
        let list = |key: &str| -> Vec<String> {
            match get(key) {
                Some(ConfigValue::List(v)) => v,
                _ => Vec::new(),
            }
        };
        let default_language = get(DEFAULT_LANGUAGE)
            .and_then(|v| v.as_str().and_then(Lang::parse))
            .or_else(|| Lang::parse("en"))
            .expect("en is a language tag");
        let folders = list(FOLDER_LANGUAGES);
        Self {
            spelling: flag(CHECK_SPELLING, true),
            grammar: flag(CHECK_GRAMMAR, true),
            style: flag(CHECK_STYLE, false),
            english_region: region_of_setting(
                get(ENGLISH_DIALECT)
                    .as_ref()
                    .and_then(|v| v.as_str())
                    .unwrap_or("american"),
            ),
            languages: LangConfig {
                default: default_language,
                folders: Vec::new(),
            }
            .with_folder_rules(folders.iter().map(String::as_str)),
            ignored_rules: list(IGNORED_RULES)
                .into_iter()
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty())
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_check_spelling_and_grammar_in_american_english() {
        let o = Options::default();
        assert!(o.spelling && o.grammar && !o.style);
        assert_eq!(o.english_region, "US");
        assert_eq!(o.languages.default.tag(), "en");
        assert!(o.languages.folders.is_empty() && o.ignored_rules.is_empty());
    }

    #[test]
    fn values_are_read_and_bad_ones_fall_back() {
        let o = Options::from_lookup(|k| match k {
            CHECK_STYLE => Some(ConfigValue::Bool(true)),
            CHECK_SPELLING => Some(ConfigValue::Bool(false)),
            ENGLISH_DIALECT => Some(ConfigValue::String("british".into())),
            DEFAULT_LANGUAGE => Some(ConfigValue::String("fr_FR".into())),
            FOLDER_LANGUAGES => Some(ConfigValue::List(vec!["Work=de".into(), "bad".into()])),
            IGNORED_RULES => Some(ConfigValue::List(vec![" AnA ".into(), "".into()])),
            _ => None,
        });
        assert!(o.style && !o.spelling && o.grammar);
        assert_eq!(o.english_region, "GB");
        assert_eq!(o.languages.default.tag(), "fr-FR");
        assert_eq!(o.languages.folders.len(), 1);
        assert_eq!(o.ignored_rules.iter().collect::<Vec<_>>(), vec!["AnA"]);

        let bad = Options::from_lookup(|k| {
            (k == DEFAULT_LANGUAGE).then(|| ConfigValue::String("???".into()))
        });
        assert_eq!(bad.languages.default.tag(), "en");
    }
}
