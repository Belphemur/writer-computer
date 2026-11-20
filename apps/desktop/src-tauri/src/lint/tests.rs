//! The engine's contract: the registry agrees with rumdl, every default rule fixes to an exact
//! text, the Obsidian guard keeps its syntax byte-identical under every rule, positions are
//! UTF-16, a fix settles, and nothing outside `lint/` names the dependency.

use super::*;
use std::path::Path;

fn options(ids: &[&str]) -> Options {
    Options::default().with_rules(ids.iter().map(|s| s.to_string()))
}

/// Every rule of the registry on: the harshest setting for the guard.
fn everything() -> Options {
    Options::default().with_rules(rules::all().iter().map(|r| r.id.clone()))
}

fn safe_fix(text: &str) -> Fixed {
    fix(text, &Options::default(), FixScope::Safe).unwrap()
}

/// Applies edits (UTF-16 offsets of `text`) the way the editor does: all against the original.
fn apply(text: &str, edits: &[Edit]) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut sorted: Vec<&Edit> = edits.iter().collect();
    sorted.sort_by_key(|e| e.from);
    let mut out: Vec<u16> = Vec::new();
    let mut at = 0usize;
    for e in sorted {
        assert!(e.from as usize >= at, "edits overlap: {edits:?}");
        out.extend(&units[at..e.from as usize]);
        out.extend(e.insert.encode_utf16());
        at = e.to as usize;
    }
    out.extend(&units[at..]);
    String::from_utf16(&out).unwrap()
}

// ---- the registry ------------------------------------------------------------------------

#[test]
fn the_registry_agrees_with_rumdl() {
    let known = rumdl_lib::rules::all_rules(&Config::default());
    let mut seen = BTreeSet::new();
    for r in rules::all() {
        assert!(seen.insert(r.id.clone()), "{} is listed twice", r.id);
        let rule = known
            .iter()
            .find(|k| k.name() == r.id)
            .unwrap_or_else(|| panic!("rumdl has no rule {}", r.id));
        let can_fix = rule.fix_capability() != rumdl_lib::rule::FixCapability::Unfixable;
        assert_eq!(r.fixable, can_fix, "{}: fixable differs from rumdl", r.id);
        assert!(!r.safe || r.fixable, "{} is safe but cannot fix", r.id);
        assert!(!r.default || r.fixable || !r.safe, "{}", r.id);
        assert!(!r.name.is_empty());
    }
    assert!(
        rules::all().windows(2).all(|w| w[0].id < w[1].id),
        "rules.json is in id order"
    );
}

#[test]
fn the_default_rules_are_the_small_safe_set() {
    // MD007 is not one: Obsidian indents lists with tabs, and saving must never surprise
    let want: BTreeSet<String> = [
        "MD004", "MD009", "MD012", "MD018", "MD019", "MD022", "MD047",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(rules::defaults(), want);
    assert!(want.iter().all(|id| rules::get(id).unwrap().safe));
}

#[test]
fn options_are_the_defaults_changed_by_the_two_lists() {
    assert_eq!(Options::default().rules, rules::defaults());
    assert!(Options::default().fix_on_save);
    let o = Options::from_lookup(|k| match k {
        RULES_ON_KEY => Some(ConfigValue::List(vec![
            "MD013".into(),
            "MD999".into(), // unknown: dropped
        ])),
        RULES_OFF_KEY => Some(ConfigValue::String("MD009".into())), // a list of one, as a config file reads it
        FIX_ON_SAVE_KEY => Some(ConfigValue::Bool(false)),
        _ => None,
    });
    let mut want = rules::defaults();
    want.remove("MD009");
    want.insert("MD013".to_string());
    assert_eq!(o.rules, want);
    assert!(!o.fix_on_save);
    // everything off: the default rules listed as off (an empty list would not survive the config file)
    let all_off = Options::from_lookup(|k| {
        (k == RULES_OFF_KEY).then(|| ConfigValue::List(rules::defaults().into_iter().collect()))
    });
    assert!(all_off.rules.is_empty());
}

// ---- the default rules, exact output ---------------------------------------------------------

#[test]
fn md009_trailing_spaces() {
    let f = safe_fix("one   \ntwo \n\nthree  \nfour");
    // two spaces are a hard line break and stay
    assert_eq!(f.text, "one\ntwo\n\nthree  \nfour\n");
    assert!(f.applied.contains(&"MD009".to_string()));
}

#[test]
fn md012_multiple_blank_lines() {
    assert_eq!(safe_fix("a\n\n\n\nb\n").text, "a\n\nb\n");
}

#[test]
fn md047_final_newline() {
    assert_eq!(safe_fix("a").text, "a\n");
    assert_eq!(safe_fix("a\n\n\n").text, "a\n");
}

#[test]
fn md018_and_md019_space_after_heading_hashes() {
    assert_eq!(safe_fix("##Heading\n").text, "## Heading\n");
    assert_eq!(safe_fix("##   Heading\n").text, "## Heading\n");
    // `#word` is an Obsidian tag, not a heading
    assert_eq!(safe_fix("#tag\n").text, "#tag\n");
}

#[test]
fn md022_blank_lines_around_headings() {
    assert_eq!(
        safe_fix("text\n# Title\nmore\n").text,
        "text\n\n# Title\n\nmore\n"
    );
}

#[test]
fn md004_list_marker_style() {
    assert_eq!(safe_fix("- a\n* b\n+ c\n").text, "- a\n- b\n- c\n");
}

#[test]
fn md007_list_indentation() {
    // off by default: run it explicitly
    let indented = "- a\n    - b\n        - c\n";
    assert_eq!(safe_fix(indented).text, indented);
    assert_eq!(
        fix(indented, &options(&["MD007"]), FixScope::Safe)
            .unwrap()
            .text,
        "- a\n  - b\n    - c\n"
    );
}

#[test]
fn a_clean_note_is_returned_untouched() {
    let clean = "# Title\n\nSome text.\n\n- a\n- b\n";
    let f = safe_fix(clean);
    assert_eq!(f.text, clean);
    assert!(f.applied.is_empty() && f.edits.is_empty());
    assert!(check(clean, &Options::default()).unwrap().is_empty());
    assert_eq!(safe_fix("").text, "");
}

#[test]
fn only_enabled_rules_run_and_safe_scope_skips_unsafe_ones() {
    let text = "one   \n\n\n\ntwo";
    // MD012 off: its blank lines stay
    let f = fix(text, &options(&["MD009"]), FixScope::Safe).unwrap();
    assert_eq!(f.text, "one\n\n\n\ntwo");
    assert_eq!(f.applied, vec!["MD009"]);
    // MD026 (heading punctuation) is enabled but not safe: scope safe leaves it, scope all fixes it
    let heading = "# Title.\n";
    let o = options(&["MD026"]);
    assert_eq!(fix(heading, &o, FixScope::Safe).unwrap().text, heading);
    assert_eq!(fix(heading, &o, FixScope::All).unwrap().text, "# Title\n");
    // found either way, flagged as not safe
    let found = check(heading, &o).unwrap();
    assert_eq!(found.len(), 1);
    assert!(!found[0].safe);
}

// ---- the Obsidian guard ---------------------------------------------------------------------

/// Each construct, tempting a rule: `needle` must survive a fix by every rule, byte for byte.
const CONSTRUCTS: &[(&str, &str)] = &[
    ("a wiki link", "[[Note  name | with   spaces]]"),
    ("a wiki link heading", "[[Note#Heading ]]"),
    ("an embed", "![[image.png|100x  200]]"),
    ("a callout header", "> [!note]-  Title   with  spaces"),
    ("a block id", "^block-id"),
    ("a comment", "%%  hidden   words  %%"),
    ("front matter", "tags:   [a,b]\ntitle: x   \nalias:\t- y"),
];

#[test]
fn every_rule_leaves_obsidian_syntax_byte_identical() {
    for (what, needle) in CONSTRUCTS {
        let doc = match *what {
            "front matter" => format!("---\n{needle}\n---\n\n\n\n#  Body  \ntext   \n"),
            "a callout header" => format!("text\n{needle}\n> body   \n\n\n\n- a\n\t- b\n"),
            "a block id" => format!("#  Title\npara   {needle}\n\n\n\n* x\n"),
            _ => format!("#  Title\n\nbefore {needle} after   \n\n\n\n* x\n    - y\n"),
        };
        let fixed = fix(&doc, &everything(), FixScope::All).unwrap();
        assert!(
            fixed.text.contains(needle),
            "{what}: {needle:?} was changed in {:?}",
            fixed.text
        );
        // the rules did run elsewhere in the note
        assert_ne!(fixed.text, doc, "{what}: nothing was fixed");
        // and no finding points into it
        let start = doc.find(needle).unwrap();
        let (from, to) = (
            doc[..start].encode_utf16().count() as u32,
            doc[..start + needle.len()].encode_utf16().count() as u32,
        );
        for f in check(&doc, &everything()).unwrap() {
            let inside = f.start < to && from < f.end.max(f.start + 1);
            let edit_inside = f.fix.iter().any(|e| e.from < to && from < e.to);
            assert!(
                !inside || f.rule == "MD013" && f.fix.is_empty(),
                "{what}: {} points into the syntax",
                f.rule
            );
            assert!(!edit_inside, "{what}: {} edits the syntax", f.rule);
        }
    }
}

#[test]
fn code_that_looks_like_syntax_is_not_protected() {
    // a wiki link in a code span is code: the trailing spaces after it are still fixed
    assert_eq!(safe_fix("`[[x]]`   \nnext\n").text, "`[[x]]`\nnext\n");
}

#[test]
fn the_user_example_of_the_adr() {
    let doc = "##Heading\n\ntext   \n\n\n\nSee [[A|b]]\n![[x.png]]\n> [!note]\n> body\n\npara ^abc\n%%c%%\n";
    let f = safe_fix(doc);
    assert_eq!(
        f.text,
        "## Heading\n\ntext\n\nSee [[A|b]]\n![[x.png]]\n> [!note]\n> body\n\npara ^abc\n%%c%%\n"
    );
}

// ---- positions -----------------------------------------------------------------------------

#[test]
fn offsets_are_utf16_with_emoji_and_accents() {
    // "é" is one unit, "🎉" two, "日" one, then " ok": the trailing spaces start at unit 7
    let text = "é🎉日 ok   \nnext\n";
    let found = check(text, &Options::default()).unwrap();
    let f = found.iter().find(|f| f.rule == "MD009").unwrap();
    let units: Vec<u16> = text.encode_utf16().collect();
    assert_eq!((f.start, f.end), (7, 10));
    assert_eq!(String::from_utf16_lossy(&units[7..10]), "   ");
    assert_eq!((f.line, f.column), (1, 7)); // columns count characters, not units
    assert_eq!(
        f.fix,
        vec![Edit {
            from: 7,
            to: 10,
            insert: String::new()
        }]
    );
    assert_eq!(apply(text, &f.fix), "é🎉日 ok\nnext\n");
}

#[test]
fn a_finding_on_a_later_line_is_placed_after_wide_characters() {
    let text = "🎉🎉\n\n\n\n##Titre éé\n";
    let found = check(text, &Options::default()).unwrap();
    let f = found.iter().find(|f| f.rule == "MD018").unwrap();
    let want = text.encode_utf16().take_while(|_| true).count();
    assert!(f.start < want as u32);
    assert_eq!(apply(text, &f.fix), "🎉🎉\n\n\n\n## Titre éé\n");
}

#[test]
fn the_edits_of_a_fix_rebuild_its_text() {
    for doc in [
        "é🎉 text   \n\n\n\n##Titre  \n- a\n* b\n    - c\nfin",
        "# T\n\n\n\n\nx\n",
        "tab\t\n",
        "##A\n##B\n\n\n\n\n\n##C",
    ] {
        for scope in [FixScope::Safe, FixScope::All] {
            let o = if scope == FixScope::All {
                everything()
            } else {
                Options::default()
            };
            let f = fix(doc, &o, scope).unwrap();
            assert_eq!(apply(doc, &f.edits), f.text, "{doc:?}");
        }
    }
}

// ---- stability ---------------------------------------------------------------------------

#[test]
fn a_fix_settles_and_fixing_again_changes_nothing() {
    let messy = "#  Title\n\n\n\ntext   \n* a\n    - b\n\n\n\n## Two\nmore text\n- c\n\n```\ncode   \n\n\n\n```\nend";
    for scope in [FixScope::Safe, FixScope::All] {
        let o = if scope == FixScope::All {
            everything()
        } else {
            Options::default()
        };
        let once = fix(messy, &o, scope).unwrap();
        let twice = fix(&once.text, &o, scope).unwrap();
        assert_eq!(twice.text, once.text, "{scope:?} is not stable");
        assert!(twice.applied.is_empty());
    }
}

#[test]
fn code_blocks_keep_their_blank_lines_and_spaces() {
    let doc = "```\ncode   \n\n\n\nmore\n```\n";
    assert_eq!(safe_fix(doc).text, doc);
}

#[test]
fn a_disable_comment_is_honoured() {
    let doc = "<!-- rumdl-disable MD009 -->\nkeep   \n";
    assert_eq!(safe_fix(doc).text, doc);
}

// ---- the dependency stays behind this module ---------------------------------------------------

#[test]
fn only_the_lint_module_names_the_dependency() {
    fn scan(dir: &Path, lint_dir: &Path, hits: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path != lint_dir && path.file_name().is_some_and(|n| n != "node_modules") {
                    scan(&path, lint_dir, hits);
                }
            } else if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                // a comment may name it (the ADR title does); code may not
                if text
                    .lines()
                    .any(|l| !l.trim_start().starts_with("//") && l.contains("rumdl"))
                {
                    hits.push(path.display().to_string());
                }
            }
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let lint_dir = manifest.join("src/lint");
    let mut hits = Vec::new();
    scan(&manifest.join("src"), &lint_dir, &mut hits);
    scan(&manifest.join("../features"), &lint_dir, &mut hits);
    assert!(hits.is_empty(), "rumdl is named outside src/lint: {hits:?}");
}

// ---- keeping the lines being typed in --------------------------------------------------------

fn keep_fix(text: &str, keep: &[Range<u32>]) -> Fixed {
    fix_keeping(text, &Options::default(), FixScope::Safe, keep).unwrap()
}

#[test]
fn a_kept_line_is_not_fixed_and_the_others_are() {
    // the line being typed in ends in a space, the first has trailing spaces and `##Heading` follows
    let text = "one   \n# \n##Heading\n";
    let f = keep_fix(text, &[7..9]);
    // MD022 puts a blank line after the kept heading line, outside it
    assert_eq!(f.text, "one\n# \n\n## Heading\n");
    assert!(f.edits.iter().all(|e| !(7..=9).contains(&e.from)));
}

#[test]
fn a_kept_line_holding_a_heading_without_its_space_stays() {
    let f = keep_fix("##Heading\n", &[0..9]);
    assert_eq!(f.text, "##Heading\n");
    assert!(f.edits.is_empty() && f.applied.is_empty());
}

#[test]
fn a_fix_touching_a_kept_line_is_dropped_whole_and_ranges_follow_the_text() {
    // fixing the first line shifts the kept one: a later pass must still keep it
    let text = "a   \n\n\n\nb   ";
    let f = keep_fix(text, &[11..12]);
    assert_eq!(f.text, "a\n\nb   \n".replace("b   \n", "b   "));
}

#[test]
fn kept_ranges_are_utf16() {
    // "é😀" is 3 UTF-16 units; the kept line is the second, so the first still trims
    let f = keep_fix("é😀   \nx   \n", &[7..11]);
    assert_eq!(f.text, "é😀\nx   \n");
}
