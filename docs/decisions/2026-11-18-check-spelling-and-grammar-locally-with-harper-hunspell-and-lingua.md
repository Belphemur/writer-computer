---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Check spelling and grammar locally with Harper, Hunspell dictionaries and lingua

## Context and Problem Statement

Writer users check grammar with the LanguageTool Obsidian plugin through the plugin host; it sends note text to a LanguageTool HTTP server. The user asked (2026-11-18) to replace it natively, as much as possible in Rust, and to stay local: "don't provide LanguageTool, we stay local, no network calls for this". The vault is mostly English, sometimes French. Research of 2026-11-18 (sources in More Information): Harper (`harper-core`, Apache-2.0, Automattic, weekly releases) is a fast Rust grammar and spelling checker with a Markdown parser, **English only** (US, GB, CA, AU, IN); other languages are in progress as WebAssembly "language plugins", not released. `spellbook` (MPL-2.0, Helix) checks spelling with any Hunspell dictionary. `lingua-rs` (Apache-2.0) detects 75 languages with models compiled in per language. `nlprule` is dead (2021).

## Decision Drivers

- Local only: note text never leaves the machine; no grammar server, remote or local.
- English grammar quality; spelling in every language the user writes.
- As-you-type speed on long notes.
- As much as possible in Rust, shared with the `writer` CLI.
- One checker interface, so Harper's language plugins can join later.

## Considered Options

- A. One Rust checker with two local providers: Harper (English grammar and spelling) and spellbook with Hunspell dictionaries (spelling in other languages); lingua for language detection.
- B. Keep the LanguageTool plugin (network).
- C. A LanguageTool provider (remote or self-hosted) behind the same checker: rejected by the user (no network).

## Decision Outcome

Chosen option: **A**.

1. **Feature**: `apps/desktop/features/spellcheck/` (kill switch `features.spellcheck.enabled`, default on; settings fragment), with the engine Tauri-free in `src-tauri/src/spellcheck/` so the CLI shares it.
2. **Dependencies** (new, each pinned exactly; confirmed with the user before install):
   - `harper-core` 3.2.0 (2026-11-13), chosen by the user over the two-week-old rule (the user, 2026-11-18: "Take 3.2.0"); the project releases weekly, so upgrades are deliberate.
   - `spellbook` 0.4.2.
   - `lingua` 1.8.0 with `default-features = false` and only the `english` and `french` features, built with `with_low_accuracy_mode()` to keep it small (the user, 2026-11-18: "keep things small"); adding a detection language is a build change. The binary and memory cost is measured in the release build and recorded in the spec.
3. **Checker interface** (Rust): `Checker::check(text, lang, ctx) -> Vec<Finding>`, `Finding { start, end, kind: Spelling | Grammar | Style, message, replacements, rule_id, provider }`, offsets in UTF-16 code units for the editor (one conversion point). Providers:
   - `HarperProvider`: English grammar, spelling, punctuation, style; dialect from the setting `spellcheck.english-dialect` (`american` default, `british`, `canadian`, `australian`, `indian`).
   - `HunspellProvider` (spellbook): spelling for any installed Hunspell dictionary, any language.
   - Findings for the same span are deduplicated; grammar takes priority over spelling.
4. **What is checked**: prose only. The Markdown is masked so code blocks, inline code, front matter, URLs, wiki links and embeds, HTML and math are skipped (Harper's Markdown parser for English, one shared mask for the Hunspell provider). Checked paragraph by paragraph; results cached by a hash of the paragraph text and language; only changed paragraphs are re-checked, debounced, and stale results are dropped by document version.
5. **Language**: precedence, first match wins: the note's `lang:` / `language:` property; a folder rule in settings; lingua detection over English and French in low-accuracy mode (per paragraph of at least 120 characters, where that mode is reliable, with a confidence threshold; shorter paragraphs and low confidence use the note's language); the default `spellcheck.default-language` (`en`). A status item shows the language of the paragraph at the cursor; a click overrides it for the note (writes `lang:` on confirm) and lists every installed language. Languages outside the detection set (English, French) are used through the property, a folder rule or this override; they are never auto-detected. lingua's `en` maps to Harper with the chosen dialect; `fr` to the `fr_FR` Hunspell dictionary unless the user picked another variant.
6. **Dictionaries**: English needs none (Harper's curated dictionary is compiled in). Any language with a Hunspell dictionary can be installed (the user, 2026-11-18: "any language of hunspell should be available"): Settings > Spelling > "Add language" lists every dictionary of the `wooorm/dictionaries` repository at the pinned commit (all languages and variants, generated into `hunspell-dictionaries.json`), and the page says, in one line, "Grammar: English only for now; other languages check spelling". The dictionary pair (`.aff`, `.dic`) is downloaded once from the `wooorm/dictionaries` repository at a pinned commit, verified against a sha256 recorded in `apps/desktop/shared/hunspell-dictionaries.json` (language, variant, URL, sha256, licence), stored in the app data dir, and its licence shown. This download sends no note content; it is the only network use of the feature and happens only when the user adds a language. No dictionary is bundled.
7. **Personal dictionary and ignores**: `.writer/dictionary.txt` in the vault (one word per line, shared by every provider and every device), "Add to dictionary" writes it through one Rust write path; ignored rules go to the setting `spellcheck.ignored-rules`.
8. **Editor**: a CodeMirror `linter` source (`@codemirror/lint`, already in the stack) mapping findings to diagnostics: spelling and grammar `warning`, style `info`; actions "Replace with …", "Add to dictionary", "Ignore rule"; Settings toggles per kind (spelling, grammar, style).
9. **LanguageTool plugin coexistence**: the user chooses. Setting `spellcheck.provider-with-languagetool`: when the LanguageTool plugin is enabled in the plugin host, a one-time prompt asks "Use Writer's checker, the LanguageTool plugin, or both"; the answer is stored and changeable in Settings > Spelling. Writer never disables the plugin without that choice and never writes `.obsidian`.
10. **Agents and CLI**: `writer check path=… [lang=…] [format=json]` prints findings with the same engine, headless; documented in the `writer-cli` skill.
11. **Harper language plugins**: when Harper releases non-English language plugins as stable, a new ADR adopts them as a provider behind the same interface (the user: "when mature, yes"); until then non-English grammar is not checked.

### Consequences

- Good: grammar and spelling with no network use for checking; fast; agents can check notes.
- Good: spelling in any Hunspell language through one provider.
- Bad: no grammar checking outside English until Harper's language plugins mature (spelling works in every Hunspell language).
- Bad: three new dependencies; Harper's frequent releases need deliberate upgrades.
- Neutral: detection covers English and French only and runs in low-accuracy mode; adding a language is a build change (lingua models are compiled in).

### Non-goals

- A LanguageTool provider of any kind; any network call that sends note text.
- Grammar outside English (until a later ADR); a thesaurus; style packs like Vale.
- Bundling Hunspell dictionaries.

## Implementation Plan

- **Affected paths**: new `src-tauri/src/spellcheck/` (`checker.rs` interface and dedupe, `harper.rs`, `hunspell.rs`, `mask.rs` Markdown prose mask, `lang.rs` precedence and lingua, `dictionaries.rs` download, verify, install, `personal.rs`, `cache.rs`), commands through `commands::blocking`; `cli/` (`check`); `apps/desktop/features/spellcheck/` (`feature.json`, settings fragment, `rust/` glue, `web/` linter source, actions, status item, Settings > Spelling page); `apps/desktop/shared/hunspell-dictionaries.json`; `Cargo.toml` (pinned deps); specs: new `SPECs/spellcheck-spec.md`, `SPECs/builtin-plugins-spec.md`, `SPECs/writer-cli-spec.md`; the `writer-cli` skill (bump `BUNDLE_VERSION`); `THIRD_PARTY_NOTICES.md` (Harper Apache-2.0, spellbook MPL-2.0, lingua Apache-2.0, each installed dictionary's licence shown at install); `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: Tauri-free Rust core with thin glue; one write path; contribution points; `docs/design.md` (terse Settings, status item); the plugin takeover prompt of the native features.
- **Patterns to avoid**: any network call with note content; a second Markdown mask; blocking the editor thread.
- **Tests**: Harper findings on fixture sentences (grammar, spelling, style) and dialect switch; Hunspell provider with a small test dictionary (misspelling, suggestions, personal words); dedupe and priority; mask (code, front matter, links, math skipped; offsets map back exactly, UTF-16 with emoji and accents); language precedence (property, folder, the 120-character and confidence thresholds, default) and the `en`/`fr` mapping; paragraph cache and stale-result drop; dictionary install (pinned URL, sha256 mismatch refused, licence recorded) against a local file server, never the network in tests; personal dictionary write; LanguageTool coexistence prompt once and the stored choice; CLI `check`; a 10,000-word note re-checked after one edit within a time budget.

### Verification

- [ ] An English note shows grammar and spelling underlines with working Replace, Add to dictionary and Ignore rule.
- [ ] A French note (`lang: fr`, or detected) shows French spelling after "Add language: French".
- [ ] "Add language" lists every Hunspell dictionary; a note with `lang: de` gets German spelling once German is installed.
- [ ] Code blocks, links and front matter are never underlined.
- [ ] No network request is made while checking; the only one is a dictionary install the user started.
- [ ] `writer check path=Note.md` prints the same findings.
- [ ] With the LanguageTool plugin enabled, the user's choice decides which checker runs.

## Pros and Cons of the Options

### A. Harper + Hunspell, local

- Good, because local, fast, Rust, and multi-language spelling.
- Bad, because grammar is English only for now.

### B. Keep the LanguageTool plugin

- Good, because multi-language grammar today.
- Bad, because note text goes over the network; no CLI or agent access.

### C. LanguageTool provider

- Good, because multi-language grammar behind our UI.
- Bad, because the user wants no network for checking.

## More Information

Amendment 2026-11-18: the user chose a per-note, device-local "Ignore" for a misspelled word (stored in the app data dir, not the vault; "Add to dictionary" stays the vault-wide choice).

Research 2026-11-18: github.com/Automattic/harper (releases v3.0.0 2026-10-27 to v3.3.0 2026-11-18, `COMPARISON.md` English only, issues #2654 and #79 roadmap, PR #3402 closed unmerged 2026-11-12 in favour of WebAssembly language plugins, issue #3725 dictionary memory, closed), crates.io `harper-core`; github.com/helix-editor/spellbook (0.4.2, 2026-06-03); github.com/pemistahl/lingua-rs (1.8.0, 2026-03-09, 75 languages, models per language feature); github.com/bminixhofer/nlprule (last release 2021). Revisit when Harper ships stable non-English language plugins.
