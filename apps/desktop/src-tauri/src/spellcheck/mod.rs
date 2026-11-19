//! Local spelling and grammar checking: the engine behind the built-in feature `spellcheck`
//! (ADR 2026-11-18 "check spelling and grammar locally with Harper, Hunspell dictionaries and
//! lingua", spec `SPECs/spellcheck-spec.md`). Tauri-free, so the `writer` CLI (`writer check`)
//! and the app run the same code.
//!
//! The pipeline for one note ([`Checker::check_note`]): `mask` splits the text into prose
//! blocks and masks everything that is not prose (code, links, front matter, markup); `lang`
//! picks each block's language (override, property, folder rule, lingua, default); the block is
//! checked by the provider of that language, Harper for English (`harper`) or the installed
//! Hunspell dictionary (`hunspell`), unless the paragraph `cache` already holds the answer;
//! findings are deduplicated (`checker`), filtered by the user's settings, personal dictionary
//! and ignored rules, and converted to UTF-16 offsets at the one conversion point
//! (`checker::Utf16Index`). No network is involved in checking; `dictionaries` downloads a
//! dictionary only when the user asks for one.

pub mod cache;
pub mod checker;
pub mod dictionaries;
pub mod harper;
pub mod hunspell;
pub mod ignored;
pub mod lang;
pub mod mask;
pub mod options;
pub mod personal;

use self::cache::{Cache, Key};
use self::checker::{dedupe, glued_to_mask, CheckProvider, Finding, Hit, Kind, Prose, Utf16Index};
use self::harper::{HarperProvider, Spawner};
use self::hunspell::HunspellProvider;
use self::ignored::Ignored;
use self::lang::{block_language, note_language, Detector, Lang, NoteLang, Source};
use self::mask::Block;
use self::options::Options;
use self::personal::Personal;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

/// Blocks kept in the paragraph cache.
const CACHE_BLOCKS: usize = 8192;
/// Notes whose latest document version the engine remembers (for dropping stale requests).
const TRACKED_NOTES: usize = 256;

/// What a check reads besides the text: the user's settings, personal dictionary and the words
/// ignored per note (the ADR's `ctx`).
pub struct Context<'a> {
    pub options: &'a Options,
    pub personal: &'a Personal,
    /// The vault's per-note ignored words; a note's are read by its path.
    pub ignored: &'a Ignored,
}

/// The note a check is for.
pub struct NoteInput<'a> {
    /// Vault-relative path (folder rules read it); empty for text that is not a vault note.
    pub path: &'a str,
    /// The editor's document version. A request older than one already answered for the same
    /// path is dropped as [`Stale`].
    pub version: u64,
    /// The language the user chose for this note in the status item, if any.
    pub language: Option<Lang>,
}

/// The language of one block, in UTF-16 offsets, for the status item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct BlockLanguage {
    pub start: u32,
    pub end: u32,
    pub lang: Lang,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Checked {
    pub findings: Vec<Finding>,
    pub blocks: Vec<BlockLanguage>,
    /// Languages blocks are in that nothing can check (no dictionary installed), sorted.
    pub missing: Vec<Lang>,
}

/// A newer version of the same note was already answered; this result would be out of date.
#[derive(Debug, PartialEq, Eq)]
pub struct Stale;

pub struct Checker {
    harper: HarperProvider,
    hunspell: HunspellProvider,
    detector: Detector,
    cache: Mutex<Cache<Vec<Hit>>>,
    versions: Mutex<HashMap<String, u64>>,
}

impl Checker {
    /// `dictionaries_dir` is `dictionaries::dir(app_data)`; `spawner` starts Harper's thread.
    pub fn new(dictionaries_dir: PathBuf, spawner: Spawner) -> Self {
        Self {
            harper: HarperProvider::new(spawner),
            hunspell: HunspellProvider::new(dictionaries_dir),
            detector: Detector::new(),
            cache: Mutex::new(Cache::new(CACHE_BLOCKS)),
            versions: Mutex::new(HashMap::new()),
        }
    }

    pub fn dictionaries_dir(&self) -> &std::path::Path {
        self.hunspell.dir()
    }

    /// A dictionary was installed, replaced or removed: forget what was loaded and cached.
    pub fn dictionary_changed(&self, id: &str) {
        self.hunspell.invalidate(id);
        self.cache.lock().clear();
    }

    /// Checks `text` as one language, whatever the note says (the ADR's `Checker::check`): what
    /// the CLI's `lang=` and the tests use.
    pub fn check(&self, text: &str, lang: &Lang, ctx: &Context<'_>) -> Vec<Finding> {
        self.check_as(text, lang, ctx).findings
    }

    /// [`Checker::check`] with the rest of the answer: the blocks and the language nobody could
    /// check (`writer check lang=de` says so when German is not installed).
    pub fn check_as(&self, text: &str, lang: &Lang, ctx: &Context<'_>) -> Checked {
        self.run(text, None, ctx, |_, _| (lang.clone(), Source::Override))
    }

    /// Checks a note: each block in the language the precedence rules give it.
    pub fn check_note(
        &self,
        text: &str,
        note: &NoteInput<'_>,
        ctx: &Context<'_>,
    ) -> Result<Checked, Stale> {
        if !self.admit(note.path, note.version) {
            return Err(Stale);
        }
        let decided: NoteLang = note_language(
            text,
            note.path,
            &ctx.options.languages,
            note.language.as_ref(),
        );
        Ok(self.run(text, Some(note.path), ctx, |chars, block| {
            block_language(&decided, || block.prose(chars), &self.detector)
        }))
    }

    /// Records the version; false when a newer one for this path was already seen.
    fn admit(&self, path: &str, version: u64) -> bool {
        let mut seen = self.versions.lock();
        if seen.get(path).is_some_and(|latest| *latest > version) {
            return false;
        }
        if seen.len() >= TRACKED_NOTES && !seen.contains_key(path) {
            seen.clear();
        }
        seen.insert(path.to_string(), version);
        true
    }

    fn run(
        &self,
        text: &str,
        note: Option<&str>,
        ctx: &Context<'_>,
        language_of: impl Fn(&[char], &Block) -> (Lang, Source),
    ) -> Checked {
        let chars: Vec<char> = text.chars().collect();
        let index = Utf16Index::new(&chars);
        let mut out = Checked {
            findings: Vec::new(),
            blocks: Vec::new(),
            missing: Vec::new(),
        };
        let mut missing: BTreeSet<Lang> = BTreeSet::new();
        let mut supported: HashMap<Lang, bool> = HashMap::new();
        for block in mask::blocks(&chars) {
            let (lang, source) = language_of(&chars, &block);
            let lang = with_dialect(lang, ctx.options);
            let provider: Option<&dyn CheckProvider> = if self.harper.supports(&lang) {
                Some(&self.harper)
            } else if *supported
                .entry(lang.clone())
                .or_insert_with(|| self.hunspell.supports(&lang))
            {
                Some(&self.hunspell)
            } else {
                None
            };
            out.blocks.push(BlockLanguage {
                start: index.at(block.start),
                end: index.at(block.end),
                lang: lang.clone(),
                source,
            });
            let Some(provider) = provider else {
                missing.insert(lang);
                continue;
            };
            let hits = self.block_hits(&chars, &block, &lang, provider);
            let text = &chars[block.start..block.end];
            out.findings.extend(
                hits.iter()
                    .filter(|h| keep(h, text, note, ctx))
                    .map(|h| index.finding(block.start, h)),
            );
        }
        out.missing = missing.into_iter().collect();
        out
    }

    fn block_hits(
        &self,
        chars: &[char],
        block: &Block,
        lang: &Lang,
        provider: &dyn CheckProvider,
    ) -> Arc<Vec<Hit>> {
        let source = &chars[block.start..block.end];
        let key = Key::new(source, &block.allowed, lang.tag());
        if let Some(hits) = self.cache.lock().get(&key) {
            return hits;
        }
        // not under the lock: a check can take a while and other windows share the engine
        let mut hits = provider.check(
            &Prose {
                chars: source,
                allowed: &block.allowed,
            },
            lang,
        );
        hits.retain(|h| !glued_to_mask(source, &block.allowed, &h.range));
        let hits = Arc::new(dedupe(hits));
        self.cache.lock().put(key, hits.clone());
        hits
    }

    /// How many blocks the cache holds (tests and the status of a long session).
    pub fn cached_blocks(&self) -> usize {
        self.cache.lock().len()
    }
}

/// An English tag without a region is checked in the dialect of the setting.
fn with_dialect(lang: Lang, options: &Options) -> Lang {
    if lang.is_english() && lang.region().is_none() {
        Lang::parse(&format!("{}-{}", lang.tag(), options.english_region)).unwrap_or(lang)
    } else {
        lang
    }
}

/// The settings, the personal dictionary, the ignored rules and the note's ignored words apply
/// after the cache: changing one never re-checks a paragraph.
fn keep(hit: &Hit, block_text: &[char], note: Option<&str>, ctx: &Context<'_>) -> bool {
    let enabled = match hit.kind {
        Kind::Spelling => ctx.options.spelling,
        Kind::Grammar => ctx.options.grammar,
        Kind::Style => ctx.options.style,
    };
    if !enabled || ctx.options.ignored_rules.contains(&hit.rule_id) {
        return false;
    }
    if hit.kind == Kind::Spelling {
        let word: String = block_text[hit.range.clone()]
            .iter()
            .map(|&c| if c == '’' { '\'' } else { c })
            .collect();
        if ctx.personal.contains(&word) || note.is_some_and(|n| ctx.ignored.contains(n, &word)) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests;
