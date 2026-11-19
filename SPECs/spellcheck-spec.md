# Spelling and grammar (feature `spellcheck`)

Status: implemented in code and tested (Rust and jsdom); not seen in a real window. Decision: [`docs/decisions/2026-11-18-check-spelling-and-grammar-locally-with-harper-hunspell-and-lingua.md`](../docs/decisions/2026-11-18-check-spelling-and-grammar-locally-with-harper-hunspell-and-lingua.md) (accepted; the ADR is the contract, this file says how it is built).

## Goal

Underline misspellings and (in English) grammar and style problems in the editor, offer fixes, work in the language of each paragraph, and do it all on the machine: **no network call ever carries note text**. It replaces the LanguageTool Obsidian plugin for the vault's usual case (English, some French) and is reachable from the CLI and the agent (`writer check`).

## Engine (Tauri-free, `src-tauri/src/spellcheck/`)

| Module            | Job                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mask.rs`         | The one Markdown prose mask: splits a note into blocks and says which char ranges are prose.                                  |
| `lang.rs`         | Language precedence, `Lang` tags, lingua detection.                                                                           |
| `harper.rs`       | English provider (Harper, `harper-core =3.2.0`, Apache-2.0) on its own worker thread.                                         |
| `hunspell.rs`     | Every other language: an installed Hunspell dictionary read by `spellbook =0.4.2` (MPL-2.0).                                  |
| `checker.rs`      | `Kind`, `Provider`, `Hit` (char offsets in a block), `Finding` (UTF-16 in the note), `CheckProvider`, `dedupe`, `Utf16Index`. |
| `cache.rs`        | The paragraph cache.                                                                                                          |
| `personal.rs`     | `.writer/dictionary.txt`.                                                                                                     |
| `dictionaries.rs` | The catalog, install, remove, resolve.                                                                                        |
| `options.rs`      | The settings the engine reads.                                                                                                |
| `mod.rs`          | `Checker`: `check`, `check_as`, `check_note`.                                                                                 |

`Checker::new(dictionaries_dir, spawner)` is shared by the app and the CLI. Harper is built without its `concurrent` feature, so its linters are not `Send`: they live on one worker thread per checker, fed through a channel. The app passes `features::spawn` as the spawner (the feature's failure containment applies), the CLI and the tests a plain thread.

### The mask

One mask serves both providers (the ADR forbids a second one). It skips front matter, code (fenced, indented, inline), math, `%%` and `<!-- -->` comments, HTML blocks, wiki links and embeds, link destinations, URLs, e-mails, entities, footnote labels, callout headers, tags, block ids, and the markers of lists, headings, quotes and tables, and emphasis delimiters. Harper reads the blocks through a custom parser (`MaskedEnglish`): a masked gap becomes an unlintable token, so a rule never reads across it ("and `x` and" is not a repetition). Hunspell tokenizes only inside the allowed ranges and skips tokens it cannot know (digits, identifiers, acronyms, camelCase, single letters).

Deviation from the ADR text: "Harper's Markdown parser for English" is replaced by this one mask for English too (DRY; the ADR says to avoid a second mask).

### Offsets

Providers answer in `char` offsets relative to their block; `Utf16Index` is the single conversion to the UTF-16 offsets CodeMirror uses (pinned with emoji and accents). A suggestion whose span crosses masked text is dropped.

### Language of a paragraph

Precedence, highest first: the user's choice for the note (status item), the `lang:` or `language:` property, the folder rule (`Folder=lang`, the longest folder wins), lingua detection, the default language. Detection knows English and French only (`lingua` 1.8.0, `with_low_accuracy_mode()`), needs at least 120 characters of prose and a confidence of at least 0.9, and a detected language that shares the default's primary language keeps the default's region. Every block is decided on its own, so a French paragraph in an English note is checked as French. `Lang` is a normalized BCP 47 tag (language, script, region, variant). An English tag without a region takes the region of `spellcheck.english-dialect`.

### Findings

Harper's lint kinds fold into three: Spelling (spelling, typo), Style (style, readability, enhancement, redundancy), Grammar (everything else, word choice included). Two findings on one span keep one (Grammar over Spelling over Style). Settings that filter kinds, the ignored rules and the personal dictionary apply after the cache, so changing one never re-checks a paragraph. The cache is keyed by the block's text, its allowed ranges and the language.

A request carries a document version; the engine refuses one older than an answer it already gave for the same path (`stale`), and the editor asks once more.

### Dictionaries

`apps/desktop/shared/hunspell-dictionaries.json` lists 92 dictionaries from `wooorm/dictionaries` at the pinned commit `8cfea406b505e4d7df52d5a19bce525df98c54ab`, each with url, sha256, size, licence and display name, generated by `scripts/gen-hunspell-dictionaries.mjs` (run by a maintainer, not at build time). No dictionary is bundled. "Add language" downloads one through the plugin store's fetcher (https, GitHub hosts only, size caps), verifies the sha256 (a mismatch installs nothing), checks that `spellbook` parses it, and installs it by rename into `<app data>/spellcheck/dictionaries/<id>/` with a `meta.json` that records the licence. English is never installed: Harper checks it. A tag resolves to the exact dictionary, then its primary language, then the first installed variant.

### Personal dictionary

`.writer/dictionary.txt` in the vault, one word per line, matched case-insensitively for every language, written atomically through the vault's `.writer` folder (never `.obsidian`), at most 64 characters per word and 1 MB per file. It is re-read only when the file changes.

### Ignored in a note

"Ignore" on a misspelled word stops flagging that word (case and apostrophe folded) in that note only. Device-local, never in the vault: `<app data>/spellcheck/ignored-<vault key>.json`, `{version, notes: {<vault-relative path>: [words]}}` (vault key as the index's: `index::vault_key`), written atomically, at most 64 characters per word and 1 MB per file, never logged. `spellcheck/ignored.rs` is the Tauri-free store and the one write path; the checker applies it after the cache next to the personal dictionary (`Context.ignored`, read by the note's path), so it never re-runs a provider. It follows a move or rename of the note or its folder and is dropped with a delete, through `vault_events` (`src-tauri/src/vault_events.rs`), the one "file moved or deleted" hook that `relocate::apply`, the app's rename and delete and the CLI's delete call for every per-path store (icons and this one). There is no list or Clear in Settings: ignoring is one click and not undone from a list (`spellcheck_unignore_word` exists for a later one).

## Settings

Fragment `features/spellcheck/settings.schema.json`; the kill switch `features.spellcheck.enabled` is in the shared schema.

| Key                                     | Default  | Meaning                                                     |
| --------------------------------------- | -------- | ----------------------------------------------------------- |
| `spellcheck.check-spelling`             | on       | Underline misspellings                                      |
| `spellcheck.check-grammar`              | on       | Underline grammar problems (English)                        |
| `spellcheck.check-style`                | off      | Underline style suggestions (English)                       |
| `spellcheck.english-dialect`            | american | American, British, Canadian, Australian, Indian             |
| `spellcheck.default-language`           | `en`     | Language when nothing else decides (workspace may override) |
| `spellcheck.folder-languages`           | none     | `Folder=lang` rules (workspace may override)                |
| `spellcheck.ignored-rules`              | none     | Rules turned off with "Ignore rule"                         |
| `spellcheck.provider-with-languagetool` | ask      | `ask`, `writer`, `languagetool` or `both`                   |

## Commands (`plugin:spellcheck|*`, all `async` through `commands::blocking`)

`spellcheck_check` (`{path, text, version, language}` to findings, blocks, missing languages, stale), `spellcheck_dictionaries`, `spellcheck_install_dictionary`, `spellcheck_remove_dictionary`, `spellcheck_personal_words`, `spellcheck_add_word`, `spellcheck_remove_word`, `spellcheck_ignore_word` and `spellcheck_unignore_word` (`{path, word}`, path vault-relative, to the note's ignored words). The TypeScript bindings are generated (`WRITER_UPDATE_BINDINGS=1 cargo test bindings`); `web/ipc.ts` is their only importer.

## CLI

`writer check path=Note.md [lang=fr] [format=json]`: the same findings as the editor (line and column in characters, UTF-16 start and end in JSON), exit 0 with or without findings. It reads the global settings file and the vault's personal dictionary. A language with no installed dictionary is reported (`missingLanguages` in JSON). See [`writer-cli-spec.md`](writer-cli-spec.md) "Spelling". The managed `writer-cli` skill documents it (bundle v12).

## Editor and Settings

- A lazy `@codemirror/lint` source (750 ms after the last edit) sends the note and draws spelling and grammar as warnings and style as information. Actions: Replace with (up to 5), Add to dictionary and Ignore (this note only), for a spelling rule; Ignore rule for any other. Notes over 1,000,000 characters are not checked. A dictionary install, a word added, a rule ignored, a language picked, a setting changed and the LanguageTool plugin turning up or off all re-check the open notes.
- The tooltip is a compact card (kind icon and title, the message, then a row of chips): each replacement as a word-only chip in the app accent (the first is stronger), "Add to dictionary" and "Ignore" (eye-off icon) for a misspelled word, or "Ignore rule", as quiet chips. It is CodeMirror's lint tooltip, built in `renderMessage` (`editor/diagnostics.ts`, styled by `editor/tooltip-theme.ts`); a chip looks the diagnostic's range up at click time (`liveDiagnostics`) so edits since the check are mapped.
- A masked span counts as a word for its neighbours: a hit that is a suffix glued to one (`'s`, `’s`, `-based` after `[[Ben]]`, `[Ben](x.md)` or `#tag`) is dropped for every provider (`checker::glued_to_mask`, applied before the cache).
- A footer item shows the note's issue count (spell-check icon and number, tooltip "3 spelling, 1 grammar", hidden at 0 or with the checker inactive), read from the groups the linter stores in `spell-store` (no second check). Its popover (`AnchoredPopover`) lists unique issues (`lib/issue-groups.ts`): spelling by word, case and apostrophe folded; grammar and style by rule plus text; spelling first, then grammar, then style, most frequent first; each with `x3`, up to 3 chips that replace every occurrence in one `input.complete` transaction, Add to dictionary and Ignore, or Ignore rule, and a click on the word selects the next occurrence through CodeMirror's `scrollIntoView` effect. A row leaves when the re-check comes back.
- The footer item shows the language of the paragraph at the cursor; its menu lists English and the installed dictionaries. Picking one asks to confirm, then writes `lang:` into the note's front matter through the editor.
- Settings > Spelling: the toggles and dialect, the default language and folder rules, the language list (installed, "Add language" with every catalog entry and its licence shown before the download, remove), and the personal dictionary. One hint line: "Grammar: English only for now; other languages check spelling".

## LanguageTool coexistence

When the LanguageTool community plugin runs in Writer's plugin host, Writer asks once ("Writer", "LanguageTool", "Both"; closing the dialog means Both) through the shared takeover mechanism `src/lib/plugin-takeover.ts` (also used by Excalidraw), and stores the answer in `spellcheck.provider-with-languagetool`. "Writer" turns the plugin off in Writer's own plugin state only, never in the vault's `.obsidian` folder. With "LanguageTool" chosen and the plugin running, Writer's checker stays quiet. Until the question is answered it runs: nothing is turned off without the user's word.

## Network

Checking uses no network. The only request is a dictionary download the user starts, to the pinned `wooorm/dictionaries` commit, verified by sha256. Tests use a local file server.

## Cost

Binary and memory cost: pending a release build (the debug build is not representative). Measured in a debug build: a cold check of a 10,000-word note about 9 s, one edit re-checked in about 450 ms (the test budget is 3 s for the re-check).

## Tests

Rust: mask, lang, harper, hunspell, dictionaries (local file server, sha256 mismatch, licence recorded), personal, ignored (per-note, re-key on move, drop on delete, nothing in the vault), `vault_events`, cache, the pipeline (`spellcheck/tests.rs`: UTF-16 offsets, dialect, post-cache filters (an ignored word hides in its note only), German install, folder rule, per-paragraph detection, stale, 10,000-word timing), the feature glue and the CLI end to end (`features/spellcheck/rust/tests.rs`). jsdom (`features/spellcheck/tests/`): registration, manifest and schema contract, import boundaries and startup graph, IPC, diagnostics, language property edit, settings readers; `src/lib/plugin-takeover.test.ts`.

## Not verified without a real window

The underline look and tooltip, the footer menu and the confirm, the native three-button LanguageTool dialog, a real dictionary download, Settings > Spelling, and the release binary size and memory.

## Deferred

Grammar for languages other than English (revisit when Harper ships non-English language plugins); detection of languages beyond English and French (each lingua model adds binary size).
