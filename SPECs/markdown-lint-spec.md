# Markdown lint (feature `lint`)

Status: implemented in code and tested (Rust and jsdom); not seen in a real window. Decision: [`docs/decisions/2026-11-19-lint-markdown-with-rumdl-in-a-built-in-lint-feature.md`](../docs/decisions/2026-11-19-lint-markdown-with-rumdl-in-a-built-in-lint-feature.md).

## Goal

Find and fix Markdown formatting problems in notes without ever rewriting Obsidian syntax: warnings in the editor with a Fix action, the safe fixes when a note is saved, and `writer lint` / `writer lint:fix` for agents (and so for the MCP server). One engine for all of them.

## Behaviour

- **Warnings.** After a typing pause of 1 s (`LINT_DEBOUNCE_MS` in `features/lint/web/lib/fix.ts`, the library's `delay`) the note is sent to Rust (`lint_check`); each finding is drawn as a CodeMirror diagnostic (the rule's severity, a card with the rule id and name, rumdl's message, "Fix" when the rule has a fix, "Turn off rule"). "Fix" lints again at the click and applies the fresh answer's edits, so they are placed in the note as it is now.
- **Fix on idle.** Once the note has had no edit for 5 s (`FIX_IDLE_MS`, same file; a timer in the `idleFix` editor extension, restarted by every edit of the user, dead with the view), the feature asks `lint_fix` with scope `safe` and, if the document and the selection are still the ones it sent, applies the answer as **one transaction** (`userEvent: "lint.fix"`, `isolateHistory`): one undo step, the caret and selection mapped through the edits. The edit goes out through the normal autosave; closing the tab or switching notes first leaves the note unfixed. Only enabled **safe** rules run. **The lines being typed in are never touched:** the lines holding a caret or a selection (every range, whole lines) go to `lint_fix` as `keep`, and the engine (`lint::fix_keeping`) drops, whole, a fix with any edit in or touching a kept range (so `# ` keeps its space, trailing spaces at the caret stay, and a blank line a heading rule would add right after the kept line still goes in); the ranges follow the text through the passes. Skipped mid-composition (`view.composing`), for a note over 1,000,000 characters and for a path that is not `.md`/`.markdown`. "Fix all" and one warning's Fix keep nothing and have no delay: the user asked.
- **Never silent elsewhere.** An edit by the agent or on disk reloads the note clean (`reloadFromDisk`), which never saves, so it never reaches the hook. The watcher never fixes. The agent fixes a note by running `writer lint:fix`.
- **Fix all.** The palette command "Fix Markdown formatting" runs `lint_fix` with scope `all` on the open note: every enabled rule that can fix, one undo step.
- **Obsidian guard.** Front matter, wiki links and embeds, callout header lines, block ids and `%%` comments are never changed. A finding whose range, or a fix whose edits, overlap them is dropped (a fix is judged by what it changes after the text it shares with its replacement is trimmed, a finding with no fix by where it points). The ranges come from `markdown_mask::obsidian_syntax`, the spellcheck's scanner (`src-tauri/src/markdown_mask.rs`, moved out of `spellcheck/mask.rs`; `spellcheck::mask` re-exports it). Code is code: a `[[x]]` in a span or a fence is not syntax. rumdl runs with the Obsidian flavor (so `#tag` is a tag, not a heading without a space) and honours its inline `<!-- rumdl-disable MD009 -->` comments.
- **Limit of the guard.** A finding whose range reaches Obsidian syntax is dropped even when the rule is about the rest of the line: MD013 (line length) starts at the limit and runs to the end of the line, so a line whose wiki link lies past the limit is not reported.

## Engine (Tauri-free, `src-tauri/src/lint/`)

| Module         | Job                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `mod.rs`       | `Options`, `check`, `fix`, `Finding`, `Edit`, `Fixed`, the guard, the fix loop. The only code that names `rumdl` (a test scans). |
| `rules.rs`     | The registry (`features/lint/rules.json`, `include_str!`): `all`, `get`, `defaults`.                                             |
| `positions.rs` | The one conversion between rumdl's bytes and 1-based character columns, the scanner's `char` offsets and UTF-16.                 |

- **Fixing.** rumdl's own `Rule::fix` is not used. Each warning's `Fix` (and its additional edits) is trimmed to the characters that differ, guarded, and the non-overlapping ones are applied from the end of the note backwards; the note is linted again until a pass changes nothing, at most 5 passes. A rule that fixes only through `Rule::fix` and attaches no `Fix` to its warnings is reported but not fixed. `rules.json` says `fixable` from rumdl's `fix_capability`; for rules outside the default set that is not verified one by one.
- **Edits for the editor.** When one pass settles the note, the edits are the rules' own (minimal, UTF-16 offsets of the input). After several passes they come from a line diff trimmed to the characters that differ (`agent::line_diff`). Either way the edits applied to the input give the fixed text (tested).
- **Positions.** Findings and edits are UTF-16 offsets of the text that was sent; `line` and `column` are 1-based, the column in characters. Tested with emoji and accents.

## Rules

`features/lint/rules.json` is the one list Writer exposes (Rust, the settings page and the skill read it). `safe`: the fix changes formatting only, never meaning (what saving runs). `default`: on until the user turns it off. A rule rumdl adds in an upgrade is off and unlisted until it is added there; the Markdown flavors and rules for MkDocs, Quarto, merge conflicts, encodings and cross-file checks are not exposed.

| Rule  | Name                                      | Safe | Default | Fixable |
| ----- | ----------------------------------------- | ---- | ------- | ------- |
| MD001 | Heading levels                            | no   | off     | yes     |
| MD003 | Heading style                             | no   | off     | yes     |
| MD004 | List marker style                         | yes  | on      | yes     |
| MD005 | List indent consistency                   | yes  | off     | yes     |
| MD007 | List indentation                          | yes  | off     | yes     |
| MD009 | Trailing spaces                           | yes  | on      | yes     |
| MD010 | Hard tabs                                 | no   | off     | yes     |
| MD011 | Reversed links                            | no   | off     | yes     |
| MD012 | Multiple blank lines                      | yes  | on      | yes     |
| MD013 | Line length                               | no   | off     | yes     |
| MD014 | Dollar signs in commands                  | no   | off     | yes     |
| MD018 | Space after heading hashes                | yes  | on      | yes     |
| MD019 | Extra spaces after heading hashes         | yes  | on      | yes     |
| MD020 | Space inside closed heading hashes        | yes  | off     | yes     |
| MD021 | Extra spaces inside closed heading hashes | yes  | off     | yes     |
| MD022 | Blank lines around headings               | yes  | on      | yes     |
| MD023 | Indented headings                         | yes  | off     | yes     |
| MD024 | Duplicate headings                        | no   | off     | no      |
| MD025 | Multiple top-level headings               | no   | off     | yes     |
| MD026 | Heading punctuation                       | no   | off     | yes     |
| MD027 | Extra spaces after quote marker           | yes  | off     | yes     |
| MD028 | Blank line inside quote                   | no   | off     | yes     |
| MD029 | Ordered list numbering                    | no   | off     | yes     |
| MD030 | Spaces after list markers                 | yes  | off     | yes     |
| MD031 | Blank lines around code fences            | yes  | off     | yes     |
| MD032 | Blank lines around lists                  | no   | off     | yes     |
| MD033 | Inline HTML                               | no   | off     | no      |
| MD034 | Bare URLs                                 | no   | off     | yes     |
| MD035 | Horizontal rule style                     | no   | off     | yes     |
| MD036 | Emphasis as heading                       | no   | off     | yes     |
| MD037 | Spaces inside emphasis                    | no   | off     | no      |
| MD038 | Spaces inside code spans                  | no   | off     | yes     |
| MD039 | Spaces inside link text                   | no   | off     | yes     |
| MD040 | Code fence language                       | no   | off     | yes     |
| MD041 | First line heading                        | no   | off     | no      |
| MD042 | Empty links                               | no   | off     | yes     |
| MD045 | Image alt text                            | no   | off     | no      |
| MD046 | Code block style                          | no   | off     | yes     |
| MD047 | Final newline                             | yes  | on      | yes     |
| MD048 | Code fence style                          | no   | off     | yes     |
| MD049 | Emphasis style                            | no   | off     | yes     |
| MD050 | Strong style                              | no   | off     | yes     |
| MD055 | Table pipe style                          | no   | off     | yes     |
| MD056 | Table column count                        | no   | off     | yes     |
| MD058 | Blank lines around tables                 | yes  | off     | yes     |
| MD060 | Table alignment                           | no   | off     | yes     |
| MD064 | Multiple spaces                           | no   | off     | yes     |
| MD065 | Blank lines around rules                  | yes  | off     | yes     |

MD007 is off by default: on a vault whose lists are indented with tabs (Obsidian's default) it would rewrite each indent to two spaces per level, because rumdl's default indent is 2.

## Settings

Fragment `features/lint/settings.schema.json`; the kill switch `features.lint.enabled` is in the shared schema. The page (Settings > Lint) shows the fix-on-save switch and one switch per rule, the safe rules first.

| Key                | Type    | Default | Meaning                                       |
| ------------------ | ------- | ------- | --------------------------------------------- |
| `lint.rules-on`    | list    | `[]`    | Rules switched on beyond the defaults.        |
| `lint.rules-off`   | list    | `[]`    | Default rules switched off.                   |
| `lint.fix-on-save` | boolean | `true`  | Fix the safe rules after 5 s without an edit. |

The two lists are the difference from the registry, not the full set: a config file stores an empty list as no line and a list of one as a plain value, so "everything off" could not be a list of the rules that are on (the reader takes a plain string as a list of one). The rules in force are the defaults, plus `rules-on`, minus `rules-off`: `lint::Options::from_lookup` in Rust and `enabledRules` in `features/lint/web/lib/settings.ts` (tests pin both).

## CLI, MCP and the agent skill

- `writer lint path=… [rules=MD009,MD012] [format=text|json]` (reads): one line per finding, `path:line:column RULE message` with `[fixable]` (or `[fixable, scope=all]`), or `{path, clean, findings:[{line, column, rule, name, message, severity, fixable, safe}]}`. Exit 0 whatever it finds.
- `writer lint:fix path=… [scope=safe|all] [rules=…]` (writes): rewrites the note atomically through `vault_ops::write_text`, only when something changed, prints `path: fixed MD009, MD012` or `path: nothing to fix`, and how many findings are left. `scope` defaults to `safe`.
- Both read the enabled rules from the global settings file (`rules=` overrides it), accept Markdown notes only, and answer "turned off" while `features.lint.enabled` is false. `file=` or `path=` names the note, like every note command.
- The MCP server lists `lint` as a read tool and `lint:fix` as a write tool, from the registry, with no code of its own.
- The managed skill `writer-lint` (`features/lint/skills/writer-lint/SKILL.md`, bundle v22) tells an agent to run `writer lint:fix path=<note>` after editing a note and `writer lint` for what is left, and not to use `scope=all` unless asked. It is installed with the feature and held while the feature is off.

## Contribution point

`beforeSave` is not used by lint since the fix moved to the idle timer (the contribution point stays, with `tests/features-before-save.test.ts`; table 6.5 of the built-in plugins spec): `{ id, run(path) }`, awaited by `lib/save.ts` before it serializes the note (no await when nothing is registered, so the save's timing is unchanged without the feature). A throw is reported to the feature's health and the save goes on; a contribution is not waited for after 1.5 s. A `run` edits the editor showing the note, never the file.

## Notes for maintainers

- rumdl enables `serde_json`'s `preserve_order` for the whole build (feature unification), so every `serde_json::Value` object now keeps insertion order instead of sorting its keys. The agent goldens (`shared/agent-golden/*.events.json`), two key-order assertions and the literal user line in `claude_stream.rs` changed with it; JSON readers do not care.
- `files.trim-trailing-whitespace` and `files.insert-final-newline` (core, run when serializing) overlap MD009 and MD047; both run, in that order, with the same result.
- The spellcheck's re-check after a dictionary change sets diagnostics with `setDiagnostics`, which replaces every source's marks until the next edit; lint avoids that for its own re-check with `needsRefresh`.
- Positions or edits that do not fit the text (a rule bug) drop the finding instead of panicking.

## Tests

- Rust, `lint/tests.rs`: the registry agrees with rumdl (ids exist, `fixable` equals its capability, ordered, unique), the default set, `Options` from the lists (plain-string list of one, unknown ids, all off), exact fix output per default rule (MD004, MD009, MD012, MD018/MD019, MD022, MD047), enabled-only and scope, every construct byte-identical under all rules with scope all (and no finding or edit inside it; mutation-checked), code is not protected, the ADR's example note, UTF-16 offsets with emoji and accents, the edits rebuild the text, a fix settles and is stable, a disable comment, the source scan (`rumdl` only in `src/lint/`). `markdown_mask.rs`: `obsidian_syntax` per construct.
- Rust, `features/lint/rust/tests.rs`: manifest equals contributions, settings fragment, ACL (allowed from `main` and `w-*`, not from a stranger), `lint_check` / `lint_fix` through IPC, a failed feature, the CLI through the real parser (findings, json, fix, scope, `rules=`, settings file, what is left, refusals, feature off), `lint` read and `lint:fix` write in the registry and the MCP pins (`cli/mcp.rs`), the generated bindings.
- jsdom, `features/lint/tests/`: registration and manifest, imports; `fix-on-save.test.ts` (the idle timer: no fix at 4.9 s, fix at 5 s, restarted by typing, dies with the view; the lines being typed in: `# ` and trailing spaces survive, other lines are fixed, every selection range, caret moved meanwhile, composition, Fix all fixes the caret line; one undo step and the history annotation, caret mapping, skipped when the note changed, off by setting, no safe rule, not Markdown, agent or disk change never fixes, Fix all); `linter.test.ts` (drawing, the 1 s wait restarted by each edit, no request when it should not ask, re-lint on rules change, the per-warning Fix); `settings.test.ts`. `tests/features-before-save.test.ts`: the point.
