//! The English provider: Harper's grammar, spelling, punctuation and style rules (`harper-core`,
//! Apache-2.0) over the prose the mask leaves. Dialect comes from the language's region
//! (`en-GB`); the engine fills the setting `spellcheck.english-dialect` in when the tag has none.
//!
//! Harper is built without its `concurrent` feature, so its linters and documents are `Rc`, not
//! `Send`. The linters therefore live on one worker thread that owns them; a check sends the
//! block there and waits for the findings. The thread is started on first use through the
//! [`Spawner`] the host provides (the app passes `features::spawn`, so a panic fails the feature
//! and not the app) and ends when the provider is dropped.

use super::checker::{CheckProvider, Hit, Kind, Prose, Provider};
use super::lang::Lang;
use harper_core::linting::{LintGroup, LintKind, Suggestion};
use harper_core::parsers::{Parser, PlainEnglish};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document, Lrc, Span, Token, TokenKind};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

/// Starts a named background thread running the closure. The app's spawner is
/// `features::spawn`; [`std_spawner`] is for the CLI and tests.
pub type Spawner = Arc<
    dyn Fn(&'static str, Box<dyn FnOnce() + Send + 'static>) -> std::io::Result<()> + Send + Sync,
>;

pub fn std_spawner() -> Spawner {
    Arc::new(|name, f| {
        std::thread::Builder::new()
            .name(name.into())
            .spawn(f)
            .map(|_| ())
    })
}

struct Job {
    chars: Vec<char>,
    allowed: Vec<Range<usize>>,
    dialect: Dialect,
    reply: Sender<Vec<Hit>>,
}

pub struct HarperProvider {
    spawner: Spawner,
    tx: Mutex<Option<Sender<Job>>>,
}

impl HarperProvider {
    pub fn new(spawner: Spawner) -> Self {
        Self {
            spawner,
            tx: Mutex::new(None),
        }
    }

    /// Sends a job to the worker, starting (or restarting after a crash) the thread when needed.
    fn send(&self, job: Job) -> Result<(), String> {
        let mut tx = self.tx.lock();
        let mut job = Some(job);
        for _ in 0..2 {
            if let Some(sender) = tx.as_ref() {
                match sender.send(job.take().expect("job is sent once")) {
                    Ok(()) => return Ok(()),
                    // the worker is gone: take the job back and start a fresh one
                    Err(e) => job = Some(e.0),
                }
            }
            let (sender, rx) = channel();
            (self.spawner)("spellcheck-harper", Box::new(move || worker(rx)))
                .map_err(|e| e.to_string())?;
            *tx = Some(sender);
        }
        Err("the English checker stopped".into())
    }
}

impl CheckProvider for HarperProvider {
    fn id(&self) -> Provider {
        Provider::Harper
    }

    fn supports(&self, lang: &Lang) -> bool {
        lang.is_english()
    }

    fn check(&self, prose: &Prose<'_>, lang: &Lang) -> Vec<Hit> {
        let (reply, answer) = channel();
        let job = Job {
            chars: prose.chars.to_vec(),
            allowed: prose.allowed.to_vec(),
            dialect: dialect_of(lang).unwrap_or(Dialect::American),
            reply,
        };
        if let Err(e) = self.send(job) {
            log::error!("spellcheck: Harper is not available: {e}");
            return Vec::new();
        }
        answer.recv().unwrap_or_else(|_| {
            log::error!("spellcheck: Harper stopped while checking");
            *self.tx.lock() = None;
            Vec::new()
        })
    }
}

/// The dialect a tag names: `en-GB` is British; `en` and unknown regions name none.
pub fn dialect_of(lang: &Lang) -> Option<Dialect> {
    match lang.region()? {
        "US" => Some(Dialect::American),
        "GB" => Some(Dialect::British),
        "CA" => Some(Dialect::Canadian),
        "AU" => Some(Dialect::Australian),
        "IN" => Some(Dialect::Indian),
        _ => None,
    }
}

/// The region tag of each setting value (`american` to `US`): the one table between the setting
/// and Harper's dialects.
pub fn region_of_setting(value: &str) -> &'static str {
    match value {
        "british" => "GB",
        "canadian" => "CA",
        "australian" => "AU",
        "indian" => "IN",
        _ => "US",
    }
}

/// Harper's parser over the ranges the Markdown mask allowed: each run is parsed as English, and
/// a masked stretch between two runs (inline code, a link destination, a URL) becomes one
/// unlintable token, so rules never read across it as if the words around it were neighbours
/// (`and `code` and` is not a repetition). A gap of only emphasis or bracket characters leaves
/// no token: `a **very** big` still reads as one phrase.
struct MaskedEnglish(Vec<Range<usize>>);

impl Parser for MaskedEnglish {
    fn parse(&self, source: &[char]) -> Vec<Token> {
        let mut tokens = Vec::new();
        let mut at: Option<usize> = None;
        for run in &self.0 {
            if let Some(end) = at {
                let gap = &source[end..run.start];
                if gap.iter().any(|c| !is_delimiter(*c)) {
                    tokens.push(Token::new(Span::new(end, run.start), TokenKind::Unlintable));
                }
            }
            tokens.extend(
                PlainEnglish
                    .parse(&source[run.clone()])
                    .into_iter()
                    .map(|mut t| {
                        t.span.push_by(run.start);
                        t
                    }),
            );
            at = Some(run.end);
        }
        tokens
    }
}

/// Characters that are only Markdown syntax when they are all that is masked between two words.
fn is_delimiter(c: char) -> bool {
    c.is_whitespace() || matches!(c, '*' | '_' | '~' | '=' | '|' | '>' | '#' | '[' | ']' | '!')
}

/// The worker: owns the dictionary and one lint group per dialect, answers jobs until the
/// provider is dropped.
fn worker(jobs: Receiver<Job>) {
    let dictionary = FstDictionary::curated();
    let mut groups: HashMap<Dialect, LintGroup> = HashMap::new();
    for job in jobs {
        let group = groups
            .entry(job.dialect)
            .or_insert_with(|| LintGroup::new_curated(dictionary.clone(), job.dialect));
        let hits = lint(group, &dictionary, &job);
        let _ = job.reply.send(hits);
    }
}

fn lint(group: &mut LintGroup, dictionary: &FstDictionary, job: &Job) -> Vec<Hit> {
    let parser = MaskedEnglish(job.allowed.clone());
    let source: Lrc<[char]> = Lrc::from(job.chars.as_slice());
    let document = Document::new_from_chars(source, &parser, dictionary);
    let mut hits = Vec::new();
    for (rule, lints) in group.organized_lints(&document) {
        for lint in lints {
            let range = lint.span.start..lint.span.end.min(job.chars.len());
            if range.start >= range.end {
                continue;
            }
            // A fix that spans masked text (a link, code) would rewrite it: show the finding,
            // offer no replacement.
            let in_one_run = job
                .allowed
                .iter()
                .any(|a| a.start <= range.start && range.end <= a.end);
            let original: String = job.chars[range.clone()].iter().collect();
            let replacements = if in_one_run {
                lint.suggestions
                    .iter()
                    .map(|s| replacement(s, &original))
                    .collect()
            } else {
                Vec::new()
            };
            hits.push(Hit {
                range,
                kind: kind_of(lint.lint_kind),
                message: plain_message(&lint.message),
                replacements,
                rule_id: rule.clone(),
                provider: Provider::Harper,
            });
        }
    }
    hits
}

/// What a suggestion turns the flagged text into.
fn replacement(s: &Suggestion, original: &str) -> String {
    match s {
        Suggestion::ReplaceWith(chars) => chars.iter().collect(),
        Suggestion::InsertAfter(chars) => format!("{original}{}", chars.iter().collect::<String>()),
        Suggestion::Remove => String::new(),
    }
}

/// Harper writes its messages as Markdown (code spans in backticks); the editor shows text.
fn plain_message(message: &str) -> String {
    message.replace('`', "")
}

/// Harper's categories folded into the three the Settings toggles know. A typo is a spelling
/// finding; hints about clarity and polish are style; everything else is grammar, word choice
/// included (it is where "should of" lives, a mistake and not a taste).
pub fn kind_of(kind: LintKind) -> Kind {
    match kind {
        LintKind::Spelling | LintKind::Typo => Kind::Spelling,
        LintKind::Style | LintKind::Readability | LintKind::Enhancement | LintKind::Redundancy => {
            Kind::Style
        }
        _ => Kind::Grammar,
    }
}

#[cfg(test)]
mod tests {
    // These functions take a slice of ranges; a slice of one is what the tests mean.
    #![allow(clippy::single_range_in_vec_init)]
    use super::*;

    fn check(text: &str, lang: &str) -> Vec<Hit> {
        let chars: Vec<char> = text.chars().collect();
        let allowed = vec![0..chars.len()];
        HarperProvider::new(std_spawner()).check(
            &Prose {
                chars: &chars,
                allowed: &allowed,
            },
            &Lang::parse(lang).unwrap(),
        )
    }

    fn text_of(text: &str, h: &Hit) -> String {
        text.chars()
            .skip(h.range.start)
            .take(h.range.len())
            .collect()
    }

    #[test]
    fn grammar_spelling_and_their_kinds() {
        let text = "This is an test. I recieved the packge yesterday.";
        let hits = check(text, "en-US");
        let a_an = hits
            .iter()
            .find(|h| text_of(text, h) == "an test" || text_of(text, h) == "an")
            .expect("an test");
        assert_eq!(a_an.kind, Kind::Grammar);
        assert!(
            a_an.replacements
                .iter()
                .any(|r| r.contains("a test") || r == "a"),
            "{:?}",
            a_an.replacements
        );
        let spelling: Vec<_> = hits
            .iter()
            .filter(|h| h.kind == Kind::Spelling)
            .map(|h| text_of(text, h))
            .collect();
        assert!(spelling.contains(&"recieved".to_string()), "{spelling:?}");
        assert!(spelling.contains(&"packge".to_string()), "{spelling:?}");
        let r = hits
            .iter()
            .find(|h| text_of(text, h) == "recieved")
            .unwrap();
        assert!(
            r.replacements.contains(&"received".to_string()),
            "{:?}",
            r.replacements
        );
        assert_eq!(r.provider, Provider::Harper);
        assert_eq!(r.rule_id, "SpellCheck");
    }

    #[test]
    fn the_dialect_changes_what_is_spelling() {
        let text = "The colour of the neighbour's centre was lovely.";
        let us: Vec<_> = check(text, "en-US")
            .iter()
            .map(|h| text_of(text, h))
            .collect();
        let gb: Vec<_> = check(text, "en-GB")
            .iter()
            .map(|h| text_of(text, h))
            .collect();
        assert!(
            us.contains(&"colour".to_string()),
            "american flags colour: {us:?}"
        );
        assert!(
            !gb.contains(&"colour".to_string()),
            "british accepts colour: {gb:?}"
        );
        let text = "The color of the neighbor's center was lovely.";
        let gb: Vec<_> = check(text, "en-GB")
            .iter()
            .map(|h| text_of(text, h))
            .collect();
        assert!(
            gb.contains(&"color".to_string()),
            "british flags color: {gb:?}"
        );
    }

    #[test]
    fn a_style_hint_has_the_style_kind() {
        let text = "It is somewhat of a problem.";
        let hits = check(text, "en-US");
        assert!(
            hits.iter().any(|h| h.kind == Kind::Style),
            "expected a style hint: {hits:?}"
        );
        let text = "We should of gone.";
        let hits = check(text, "en-US");
        assert!(
            hits.iter()
                .any(|h| h.kind == Kind::Grammar && text_of(text, h) == "should of"),
            "{hits:?}"
        );
    }

    #[test]
    fn only_allowed_ranges_are_checked_and_offsets_stay_exact() {
        let text = "Good text `wrngword` more recieved here.";
        let chars: Vec<char> = text.chars().collect();
        let masked_start = text.find('`').unwrap();
        let masked_end = text.rfind('`').unwrap() + 1;
        let allowed = vec![0..masked_start, masked_end..chars.len()];
        let hits = HarperProvider::new(std_spawner()).check(
            &Prose {
                chars: &chars,
                allowed: &allowed,
            },
            &Lang::parse("en").unwrap(),
        );
        let words: Vec<_> = hits.iter().map(|h| text_of(text, h)).collect();
        assert!(words.contains(&"recieved".to_string()), "{words:?}");
        assert!(
            !words.iter().any(|w| w.contains("wrngword")),
            "masked text is never checked: {words:?}"
        );
    }

    #[test]
    fn a_fix_that_would_cross_masked_text_is_not_offered() {
        let chars: Vec<char> = "an `x` test".chars().collect();
        // allow "an " and " test" as separate runs: a lint spanning both has no replacement
        let allowed = vec![0..3, 6..chars.len()];
        let hits = HarperProvider::new(std_spawner()).check(
            &Prose {
                chars: &chars,
                allowed: &allowed,
            },
            &Lang::parse("en").unwrap(),
        );
        for h in &hits {
            let in_one = allowed
                .iter()
                .any(|a| a.start <= h.range.start && h.range.end <= a.end);
            assert!(in_one || h.replacements.is_empty(), "{h:?}");
        }
    }

    #[test]
    fn the_region_of_each_setting_value_names_a_dialect() {
        for v in ["american", "british", "canadian", "australian", "indian"] {
            let tag = format!("en-{}", region_of_setting(v));
            assert!(dialect_of(&Lang::parse(&tag).unwrap()).is_some(), "{v}");
        }
        assert!(dialect_of(&Lang::parse("en").unwrap()).is_none());
    }

    #[test]
    fn kinds_fold_into_three() {
        assert_eq!(kind_of(LintKind::Spelling), Kind::Spelling);
        assert_eq!(kind_of(LintKind::Typo), Kind::Spelling);
        assert_eq!(kind_of(LintKind::Redundancy), Kind::Style);
        assert_eq!(
            kind_of(LintKind::WordChoice),
            Kind::Grammar,
            "\"should of\" is a mistake"
        );
        assert_eq!(kind_of(LintKind::Agreement), Kind::Grammar);
        assert_eq!(kind_of(LintKind::Capitalization), Kind::Grammar);
    }
}
