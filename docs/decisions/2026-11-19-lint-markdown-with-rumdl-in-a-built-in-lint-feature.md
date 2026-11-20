---
status: accepted
date: 2026-11-19
decision-makers: Writer maintainers
---

# Lint Markdown with rumdl in a built-in `lint` feature, safe fixes on save

## Context and Problem Statement

The user asked (2026-11-19) for "a proper linter for markdown that auto fix when saving the note", which the agent can also run "as fixing for the note and be aware of it as mcp and skill, using the cli". Writer has no Markdown linter. The spellcheck feature already draws `@codemirror/lint` diagnostics from a Rust engine, and every `writer` CLI command is exposed as a tool by the Writer MCP server (`cli/mcp.rs`), so a CLI command reaches the agent with no extra wiring.

Research of 2026-11-19: Rust Markdown linters are `rumdl` (MIT, 0.3.5, 90 rules with fixes, an `obsidian` flavor, `pulldown-cmark` with wiki links enabled, "Beta"), `mkdlint` (Apache-2.0, 64 rules, documented string-in/fix-out API, no Obsidian awareness) and `markdownlint-rs` (CLI-oriented). None knows callouts, embeds, block ids or `%%` comments.

## Decision Drivers

- One engine for the app, the CLI, the MCP server and the agent skill (Rust, Tauri-free).
- Never break Obsidian syntax: wiki links, embeds, callouts, block ids, `%%` comments, front matter.
- Save never surprises: only fixes that change formatting, not meaning, run automatically.
- Agent edits and external edits are never rewritten silently.

## Considered Options

- A. `rumdl` as a library (`default-features = false`), wrapped by Writer.
- B. Writer's own rules over the spellcheck Markdown scanner (no dependency, ~15-20 rules to write and maintain).
- C. `mkdlint` (clean API, not Obsidian-aware).
- D. `markdownlint` or the Obsidian Linter in TypeScript (no CLI or agent path without a second engine).

## Decision Outcome

Chosen option: **A**, chosen by the user over B (recommended) for rule breadth.

- **Dependency.** `rumdl = { version = "=0.3.5", default-features = false }` in `src-tauri/Cargo.toml`, pinned exactly (Beta API). About 40 new crates in `Cargo.lock` (oxc parser crates, `icu_segmenter`, `serde-saphyr`, `fancy-regex`, `textwrap`, `similar`…); none of the `native` feature (no tokio LSP, no allocators, no `notify`). Licence MIT, credited in `THIRD_PARTY_NOTICES`.
- **Engine.** A Tauri-free module `src-tauri/src/lint/` is the only code that names `rumdl` (a source-scan test enforces it). `lint::check(text, &Options) -> Vec<Finding>` and `lint::fix(text, &Options, FixScope) -> Fixed { text, applied: Vec<RuleId> }`. It runs `rumdl::lint` with `MarkdownFlavor::Obsidian` and the configured rule set, converts rumdl's 1-based character positions to UTF-16 offsets for the editor, and applies fixes itself, one warning's `Fix` at a time, from the end of the note backwards, re-linting until stable (bounded to 5 passes).
- **Obsidian guard.** A finding or fix whose range overlaps Obsidian syntax is dropped: wiki links and embeds, callout header lines `> [!type]`, block ids `^id`, `%%` comments, and front matter (except rules that are about properties). The ranges come from the existing scanner `spellcheck/mask.rs`, through a new narrower function next to it (e.g. `mask::obsidian_syntax(chars)`), which moves to a shared `src-tauri/src/markdown_mask.rs` if both features need it. There is no second scanner.
- **Rule registry.** One shared file `features/lint/rules.json` lists every rule Writer exposes: rumdl id (`MD009`…), short name, `safe` (fix changes formatting only), `default` (on for new vaults). Rust (`include_str!`), the settings page and the skill all read it. A rule rumdl adds in an upgrade is off and unlisted until added there.
- **Defaults.** The feature is on, with a small safe set on: trailing spaces (MD009), multiple blank lines (MD012), final newline (MD047), space after heading hashes (MD018/MD019), blank lines around headings (MD022) and list marker style (MD004). List indentation (MD007) stays off (see More Information). Everything else is off until the user turns it on.
- **Fix on save.** When the user saves a note in the editor (explicit save or autosave), the editor asks `lint_fix` for the text with `FixScope::Safe`, and if the document has not changed since the request, applies the result as one CodeMirror transaction (one undo step, cursor and selection mapped, `userEvent: "lint.fix"`) before the write. Only enabled safe rules run. Unsafe rules show as inline warnings with a "Fix" action and a "Fix all" command. Setting `lint.fix-on-save` (default on) turns it off.
- **Never silent elsewhere.** Agent turns, external edits and the watcher never trigger a fix. The agent fixes a note explicitly through the CLI.
- **CLI and agent.** The feature contributes, through `Feature::cli_commands`, `writer lint path=… [rules=…] [format=json]` (reads: findings) and `writer lint:fix path=… [scope=safe|all]` (writes: rewrites the file atomically through the one write path, prints the rules applied). Both become MCP tools automatically; `lint` is a read tool, `lint:fix` a write tool. The feature contributes a managed skill `writer-lint` (`features/lint/skills/writer-lint/SKILL.md`, generic text): after editing a note, run `writer lint:fix path=<note>`, and read `writer lint` for what is left. `BUNDLE_VERSION` is bumped.
- **Kill switch.** `features.lint.enabled`: off removes the lint source, the fix on save, the CLI commands and the skill.

### Consequences

- Good: 90 maintained rules, one engine for app, CLI, MCP and agent; markdownlint ids users already know.
- Good: Obsidian syntax is protected by Writer, not by trusting the dependency.
- Bad: a Beta dependency with ~40 crates; its library API may change. Mitigated by the exact pin and the single wrapping module.
- Bad: rumdl's own fixes are bypassed (Writer applies warning fixes individually), so a rule that only fixes via `Rule::fix` without a warning `Fix` is not offered; such rules are marked unfixable in `rules.json`.

## Implementation Plan

- **Affected paths:** `apps/desktop/src-tauri/Cargo.toml`, `src-tauri/src/lint/` (new, Tauri-free), `src-tauri/src/spellcheck/mask.rs` (narrow Obsidian-syntax function, or move to `markdown_mask.rs`), `apps/desktop/features/lint/` (new feature: `feature.json`, `rust/` commands + CLI + settings fragment, `web/` lint source, save hook, settings page, `rules.json`, `skills/writer-lint/`), the editor save path (one hook point before the write, owned by the feature through an existing or new contribution point, never an import from core), `THIRD_PARTY_NOTICES`, `SPECs/markdown-lint-spec.md`, `CHANGELOG.md`, `TODOS.md`.
- **Pattern:** follow `.agents/skills/writer-feature/SKILL.md`; mirror `features/spellcheck` for the lint source and tooltip; commands are `async` via `commands::blocking`.
- **Tests:** Rust unit tests per default rule (fix output exact), the Obsidian guard (wiki link, embed, callout, block id, `%%`, front matter untouched by every enabled rule), UTF-16 offsets with emoji and accents, fix stability; CLI `lint`/`lint:fix` tests on a temp vault; the source-scan test (`rumdl` only in `lint/`); web tests: fix on save is one undo step, skipped when the doc changed meanwhile, off with the setting or the kill switch, never run on agent or external changes.

## Verification

- [ ] `writer lint:fix` on a note with trailing spaces, three blank lines and `##Heading` fixes all three and leaves `[[A|b]]`, `![[x.png]]`, `> [!note]`, `^abc` and `%%c%%` byte-identical.
- [ ] Saving such a note in the editor fixes it in one undo step.
- [ ] An agent edit leaves the note unfixed until the agent runs `writer lint:fix`.
- [ ] `writer mcp` lists `lint` as a read tool and `lint:fix` as a write tool.
- [ ] `features.lint.enabled = false` removes all of it.
- [ ] `cargo test`, `cargo clippy`, `vp check` (0 errors), `vp test` pass.

## More Information

- rumdl: https://docs.rs/crate/rumdl/latest/source/README.md (API read from the 0.3.5 crate source, MIT).
- mkdlint: https://docs.rs/crate/mkdlint/latest/source/README.md.
- Spec: `SPECs/markdown-lint-spec.md`.
- 2026-11-19, implementation notes: rumdl turns on `serde_json`'s `preserve_order` for the whole build, so JSON objects keep insertion order instead of sorted keys (agent goldens regenerated; accepted). MD007 (list indentation) is not a default: it rewrites Obsidian's tab-indented lists. `#Heading` is a tag under the obsidian flavor, not a heading. The settings store the difference from the registry defaults as `lint.rules-on` / `lint.rules-off`. Fix on save runs through a new `beforeSave` contribution point (`src/lib/features/before-save.ts`). The scanner moved to `src-tauri/src/markdown_mask.rs`, shared by spellcheck and lint.
- 2026-11-20: fix on save became fix on idle, and never touches the line being edited. Warnings are checked after 1 s without an edit; the safe fixes run after 5 s without an edit (an idle timer in the `idleFix` editor extension, no longer the `beforeSave` hook; the edit goes out through the normal autosave, and closing the note first leaves it unfixed). `# ` lost its space to MD009/MD018 because every autosave rewrote the line under the caret. The web side sends the lines holding a caret or selection as `keep` to `lint_fix`, and the engine (`lint::fix_keeping`) drops, whole, any fix with an edit in or touching them, following the ranges through its passes; it never runs mid-composition. "Fix all" and the CLI fix everything at once. Lint no longer uses `beforeSave`; the contribution point stays.
