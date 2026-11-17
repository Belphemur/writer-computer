---
status: accepted
date: 2026-11-16
decision-makers: Writer maintainers
---

# Adopt architecture decision records with date-prefixed filenames

## Context and Problem Statement

Writer's architecture decisions were recorded in feature specs (`SPECs/`), in `CHANGELOG.md`, in `TODOS.md` and in commit messages. Specs hold the detailed design, but they mix decisions with status, test results and QA notes, and several are amended in place (for example the Bases engine moved from TypeScript to Rust inside `SPECs/obsidian-bases-spec.md`). A new contributor or agent cannot list "what did we decide, when, and what did we reject" without reading every spec.

The plugin host, the vault index, the Bases engine and the `writer` CLI landed within three days (2026-11-13 to 2026-11-15) and each carries trust, storage or API choices that are expensive to reverse. The next change in those areas needs the reasoning, not only the code.

## Decision

Keep one ADR per significant architecture decision in `docs/decisions/`, using the `adr-skill` in `.agents/skills/adr-skill/`.

- **Filenames are `YYYY-MM-DD-<slug>.md`**, the ISO date of the decision, equal to the `date` front matter field. No sequence numbers. The skill scripts support this with `--strategy date` and `--date`.
- **`docs/decisions/README.md` is the index**: a table of date, title, status and links (the spec or doc that holds the detail), ordered by date. It is updated in the same change as the ADR.
- **ADRs link to specs and docs, they do not copy them.** A spec stays the place for behaviour, schemas and test matrices; the ADR records context, options, the decision, consequences and where to verify it.
- **When to write one** follows the skill: a decision that changes how the system is built or operated, is hard to reverse, affects later contributors, and had real alternatives. Routine choices inside an established pattern are not ADRs.
- **Backfilled ADRs** record the date the decision was actually made (the first commit that introduced it, from `git log`) and say so in a note under the title. Decisions that predate the repository history (the first commit is 2026-04-30) take that date.
- **Statuses**: `accepted` for shipped decisions, `proposed` for open ones, `superseded by ...` when replaced by a newer ADR (link both ways).

## Consequences

- Good, because the reasoning behind the stack, the plugin trust model, the vault index and the CLI is findable from one index.
- Good, because agents are told (AGENTS.md Hard Rules) to write an ADR in the same change as the decision, so the record cannot lag behind the code.
- Bad, because the index and the front matter can drift; `node .agents/skills/adr-skill/scripts/check_adr.js --dir docs/decisions` checks filename date, front matter and index rows.
- Neutral, because backfilled ADRs summarise specs: when a spec and an ADR disagree, the spec's current text wins for behaviour and the ADR is amended with a dated note.

## Implementation Plan

- **Affected paths**: `docs/decisions/` (this directory), `.agents/skills/adr-skill/scripts/{new_adr,bootstrap_adr,check_adr}.js` and `scripts/package.json` (CommonJS marker, because the repo root is `"type": "module"`), `AGENTS.md` (Docs Index and Hard Rules), `CHANGELOG.md`.
- **Patterns to follow**: create with `node .agents/skills/adr-skill/scripts/new_adr.js --title "..." --template madr --status proposed --update-index` (add `--date YYYY-MM-DD` only when backfilling); link the ADR from the spec or TODO that motivated it.
- **Patterns to avoid**: numbered filenames; rewriting an accepted ADR instead of superseding it; copying spec content into an ADR.

### Verification

- [ ] `node .agents/skills/adr-skill/scripts/check_adr.js --dir docs/decisions` prints `ok`.
- [ ] Every file in `docs/decisions/` other than `README.md` starts with an ISO date equal to its `date` front matter.
- [ ] `AGENTS.md` Hard Rules mention the ADR rule and the Docs Index links `docs/decisions/README.md`.

## Alternatives Considered

- Specs only (status quo): no single list of decisions, decisions are amended in place and lose their date.
- Numbered ADRs (`0001-...`, the skill default): numbers say nothing about when a decision was made and collide across parallel worktrees (`docs/workflows/worktrees.md`); a date prefix sorts the same way and is meaningful for backfilled records.
- A wiki or Notion page: drifts from the code and is not versioned with it.

2026-11-17: the consistency check moved to `scripts/check-adr.cjs` (repo-owned); the `adr-skill` itself is now installed from `skills-lock.json` and not committed.
