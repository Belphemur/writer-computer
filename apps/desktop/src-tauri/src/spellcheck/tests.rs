//! The pipeline end to end: mask, language, provider, cache, filters and offsets together.

use super::checker::Provider;
use super::dictionaries::test_support::{AFF, DIC};
use super::harper::std_spawner;
use super::*;
use std::time::Instant;

fn checker() -> (tempfile::TempDir, Checker) {
    let data = tempfile::tempdir().unwrap();
    let c = Checker::new(dictionaries::dir(data.path()), std_spawner());
    (data, c)
}

/// Installs the test German dictionary the way an install would have left it.
fn install_german(c: &Checker) {
    let de = c.dictionaries_dir().join("de");
    std::fs::create_dir_all(&de).unwrap();
    std::fs::write(de.join("index.aff"), AFF).unwrap();
    std::fs::write(de.join("index.dic"), DIC).unwrap();
    std::fs::write(
        de.join("meta.json"),
        r#"{"id":"de","name":"German","license":"MIT","commit":"","aff_sha256":"","dic_sha256":""}"#,
    )
    .unwrap();
    c.dictionary_changed("de");
}

fn ctx<'a>(o: &'a Options, p: &'a Personal) -> Context<'a> {
    Context {
        options: o,
        personal: p,
    }
}

fn note(c: &Checker, text: &str, path: &str, version: u64, o: &Options, p: &Personal) -> Checked {
    c.check_note(
        text,
        &NoteInput {
            path,
            version,
            language: None,
        },
        &ctx(o, p),
    )
    .unwrap()
}

/// The text a finding covers, read back through UTF-16 offsets.
fn covered(text: &str, f: &Finding) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(&units[f.start as usize..f.end as usize]).unwrap()
}

#[test]
fn english_grammar_and_spelling_findings_are_located_in_utf16() {
    let (_d, c) = checker();
    let (o, p) = (Options::default(), Personal::default());
    // an emoji (two UTF-16 units) and an accent before the errors shift every offset
    let text = "Café 😀 notes. This is an test of the recieved text.";
    let checked = note(&c, text, "a.md", 1, &o, &p);
    let words: Vec<String> = checked.findings.iter().map(|f| covered(text, f)).collect();
    assert!(words.iter().any(|w| w == "recieved"), "{words:?}");
    assert!(
        checked.findings.iter().any(|f| f.kind == Kind::Grammar),
        "{:?}",
        checked.findings
    );
    assert!(checked.missing.is_empty());
    assert_eq!(checked.blocks.len(), 1);
    assert_eq!(
        checked.blocks[0].lang.tag(),
        "en-US",
        "the dialect is part of the checked language"
    );
    assert_eq!(checked.blocks[0].end as usize, text.encode_utf16().count());
}

#[test]
fn code_links_front_matter_and_math_are_never_underlined() {
    let (_d, c) = checker();
    let (o, p) = (Options::default(), Personal::default());
    let text = "---\ntitle: Wrnog tilte\n---\n\nGood prose here.\n\n```js\nconst wrngvar = recieve();\n```\n\nSee [[Wrng Linkk]] and `inlne` and https://exmple.com/wrng and $x wrngg$ done.\n";
    let checked = note(&c, text, "a.md", 1, &o, &p);
    let flagged: Vec<String> = checked.findings.iter().map(|f| covered(text, f)).collect();
    assert!(
        flagged.is_empty(),
        "nothing in code, links, front matter or math: {flagged:?}"
    );
}

#[test]
fn the_dialect_setting_decides_what_english_spelling_is() {
    let (_d, c) = checker();
    let p = Personal::default();
    let text = "The colour was lovely.";
    let american = note(&c, text, "a.md", 1, &Options::default(), &p);
    assert!(american
        .findings
        .iter()
        .any(|f| covered(text, f) == "colour"));
    let british = Options::from_lookup(|k| {
        (k == options::ENGLISH_DIALECT)
            .then(|| crate::config::ConfigValue::String("british".into()))
    });
    let gb = note(&c, text, "a.md", 2, &british, &p);
    assert!(
        !gb.findings.iter().any(|f| covered(text, f) == "colour"),
        "{:?}",
        gb.findings
    );
    assert_eq!(gb.blocks[0].lang.tag(), "en-GB");
}

#[test]
fn kinds_ignored_rules_and_the_personal_dictionary_filter_after_the_cache() {
    let (_d, c) = checker();
    let text = "I recieved it. This is an test.";
    let all = Options::default();
    let personal = Personal::default();
    let base = note(&c, text, "a.md", 1, &all, &personal).findings;
    assert!(
        base.iter().any(|f| f.kind == Kind::Spelling)
            && base.iter().any(|f| f.kind == Kind::Grammar)
    );
    let cached = c.cached_blocks();

    let no_spelling = Options::from_lookup(|k| {
        (k == options::CHECK_SPELLING).then_some(crate::config::ConfigValue::Bool(false))
    });
    let r = note(&c, text, "a.md", 2, &no_spelling, &personal).findings;
    assert!(
        r.iter().all(|f| f.kind != Kind::Spelling) && r.iter().any(|f| f.kind == Kind::Grammar)
    );

    let no_grammar = Options::from_lookup(|k| {
        (k == options::CHECK_GRAMMAR).then_some(crate::config::ConfigValue::Bool(false))
    });
    let r = note(&c, text, "a.md", 3, &no_grammar, &personal).findings;
    assert!(
        r.iter().all(|f| f.kind != Kind::Grammar) && r.iter().any(|f| f.kind == Kind::Spelling)
    );

    let rule = base
        .iter()
        .find(|f| f.kind == Kind::Grammar)
        .unwrap()
        .rule_id
        .clone();
    let ignoring = Options::from_lookup(|k| {
        (k == options::IGNORED_RULES).then(|| crate::config::ConfigValue::List(vec![rule.clone()]))
    });
    let r = note(&c, text, "a.md", 4, &ignoring, &personal).findings;
    assert!(
        r.iter().all(|f| f.rule_id != rule),
        "the ignored rule is gone"
    );
    assert!(r.iter().any(|f| f.kind == Kind::Spelling));

    let learned = Personal::from_words(["recieved".to_string()]);
    let r = note(&c, text, "a.md", 5, &all, &learned).findings;
    assert!(
        r.iter().all(|f| covered(text, f) != "recieved"),
        "a personal word is not misspelled"
    );
    assert_eq!(
        c.cached_blocks(),
        cached,
        "none of this re-checked the paragraph"
    );
}

#[test]
fn a_note_in_another_language_is_spelled_by_its_dictionary_once_installed() {
    let (_d, c) = checker();
    let (o, p) = (Options::default(), Personal::default());
    let text = "---\nlang: de\n---\nder Haus und Hauzse\n";
    let before = note(&c, text, "a.md", 1, &o, &p);
    assert!(before.findings.is_empty(), "nothing can check German yet");
    assert_eq!(
        before.missing.iter().map(|l| l.tag()).collect::<Vec<_>>(),
        ["de"]
    );
    assert_eq!(before.blocks[0].source, Source::Property);

    install_german(&c);
    let after = note(&c, text, "a.md", 2, &o, &p);
    assert!(after.missing.is_empty());
    let words: Vec<String> = after.findings.iter().map(|f| covered(text, f)).collect();
    assert_eq!(words, vec!["und", "Hauzse"]);
    assert!(after
        .findings
        .iter()
        .all(|f| f.provider == Provider::Hunspell));
}

#[test]
fn a_folder_rule_and_the_users_override_set_the_language() {
    let (_d, c) = checker();
    install_german(&c);
    let p = Personal::default();
    let ruled = Options::from_lookup(|k| {
        (k == options::FOLDER_LANGUAGES)
            .then(|| crate::config::ConfigValue::List(vec!["Garten=de".into()]))
    });
    let text = "Hauzse";
    let r = note(&c, text, "Garten/a.md", 1, &ruled, &p);
    assert_eq!(
        (r.blocks[0].lang.tag(), r.blocks[0].source),
        ("de", Source::Folder)
    );
    assert_eq!(r.findings.len(), 1);

    let r = c
        .check_note(
            "Hauzse",
            &NoteInput {
                path: "Garten/a.md",
                version: 2,
                language: Lang::parse("en"),
            },
            &ctx(&ruled, &p),
        )
        .unwrap();
    assert_eq!(
        r.blocks[0].source,
        Source::Override,
        "the override beats the folder rule"
    );
    assert_eq!(r.blocks[0].lang.primary(), "en");
}

#[test]
fn a_french_paragraph_in_an_english_note_is_detected_per_paragraph() {
    let (_d, c) = checker();
    let (o, p) = (Options::default(), Personal::default());
    let english = "The committee met on Tuesday afternoon to review the proposal that had been circulated the week before, and after a long discussion they agreed to approve it.";
    let french = "Le comité s'est réuni mardi après-midi pour examiner la proposition qui avait été distribuée la semaine précédente, et après une longue discussion ils ont décidé de l'approuver.";
    let text = format!("{english}\n\n{french}\n\nShort.");
    let r = note(&c, &text, "a.md", 1, &o, &p);
    let langs: Vec<(&str, Source)> = r.blocks.iter().map(|b| (b.lang.tag(), b.source)).collect();
    assert_eq!(
        langs,
        vec![
            ("en-US", Source::Detected),
            ("fr", Source::Detected),
            ("en-US", Source::Default)
        ]
    );
    assert_eq!(
        r.missing.iter().map(|l| l.tag()).collect::<Vec<_>>(),
        ["fr"],
        "French needs its dictionary"
    );
}

#[test]
fn only_changed_paragraphs_are_checked_again_and_stale_versions_are_dropped() {
    let (_d, c) = checker();
    let (o, p) = (Options::default(), Personal::default());
    let text = "First paragraph with a mistke.\n\nSecond paragraph is fine.\n\nThird one too.";
    let first = note(&c, text, "a.md", 10, &o, &p);
    let cached = c.cached_blocks();
    assert_eq!(cached, 3);

    // an edit above shifts the others: their cached findings are reused and re-offset
    let edited = format!("Intro line added.\n\n{text}");
    let second = note(&c, &edited, "a.md", 11, &o, &p);
    assert_eq!(
        c.cached_blocks(),
        cached + 1,
        "only the new paragraph was checked"
    );
    let a = covered(text, &first.findings[0]);
    let b = covered(&edited, &second.findings[0]);
    assert_eq!((a.as_str(), b.as_str()), ("mistke", "mistke"));
    assert!(second.findings[0].start > first.findings[0].start);

    // an answer for an older version of the same note is refused; another note is not affected
    let stale = c.check_note(
        text,
        &NoteInput {
            path: "a.md",
            version: 9,
            language: None,
        },
        &ctx(&o, &p),
    );
    assert_eq!(stale.unwrap_err(), Stale);
    assert!(c
        .check_note(
            text,
            &NoteInput {
                path: "b.md",
                version: 1,
                language: None
            },
            &ctx(&o, &p)
        )
        .is_ok());
}

#[test]
fn check_runs_a_text_in_the_language_given() {
    let (_d, c) = checker();
    install_german(&c);
    let (o, p) = (Options::default(), Personal::default());
    let de = c.check("Hauzse", &Lang::parse("de").unwrap(), &ctx(&o, &p));
    assert_eq!(de.len(), 1);
    let en = c.check(
        "Hauzse is odd.",
        &Lang::parse("en-GB").unwrap(),
        &ctx(&o, &p),
    );
    assert!(en.iter().all(|f| f.provider == Provider::Harper));
}

/// A long note: a first full check, then one paragraph edited. The re-check must be the cost of
/// one paragraph, not of the note (ADR: a 10,000-word note re-checked after one edit within a
/// time budget). The cold check is measured but not bounded: Harper in a debug build is slow.
#[test]
fn a_ten_thousand_word_note_is_rechecked_quickly_after_one_edit() {
    let (_d, c) = checker();
    let (o, p) = (Options::default(), Personal::default());
    let sentence =
        "The quick brown fox jumps over the lazy dog while the committee reviews the plan. ";
    let paragraph = sentence.repeat(4); // about 60 words
    let paragraphs: Vec<String> = (0..170)
        .map(|i| format!("{paragraph}Item {i} closes the paragraph."))
        .collect();
    let text = paragraphs.join("\n\n");
    assert!(
        text.split_whitespace().count() >= 10_000,
        "{}",
        text.split_whitespace().count()
    );

    let cold = Instant::now();
    let first = note(&c, &text, "long.md", 1, &o, &p);
    let cold = cold.elapsed();

    let mut edited = paragraphs.clone();
    edited[85].push_str(" It has a new mistke in it.");
    let edited = edited.join("\n\n");
    let warm = Instant::now();
    let second = note(&c, &edited, "long.md", 2, &o, &p);
    let warm = warm.elapsed();

    assert!(second
        .findings
        .iter()
        .any(|f| covered(&edited, f) == "mistke"));
    assert!(first.findings.len() < second.findings.len() + 1);
    eprintln!("spellcheck 10k words: cold {cold:?}, one edit {warm:?}");
    assert!(
        warm < std::time::Duration::from_secs(3),
        "a re-check after one edit took {warm:?} (cold check {cold:?})"
    );
}

#[test]
fn a_possessive_glued_to_a_link_is_not_underlined_but_neighbours_still_are() {
    let (_d, c) = checker();
    let (o, p) = (Options::default(), Personal::default());
    let flagged = |text: &str| -> Vec<String> {
        let checked = note(&c, text, "a.md", 1, &o, &p);
        checked.findings.iter().map(|f| covered(text, f)).collect()
    };
    for text in [
        "I met [[Ben]]'s dog today.\n",
        "I met [[Ben|Benjamin]]\u{2019}s dog today.\n",
        "I met [Ben](x.md)'s dog today.\n",
        "I met #tag's dog today.\n",
    ] {
        assert!(flagged(text).is_empty(), "{text:?}: {:?}", flagged(text));
    }
    assert_eq!(flagged("I met [[Ben]] teh dog.\n"), vec!["teh"]);
    assert_eq!(flagged("I met [[Ben]] wrng today.\n"), vec!["wrng"]);
}
