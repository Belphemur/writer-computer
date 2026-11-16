# Architecture Decision Records (ADR)

An Architecture Decision Record (ADR) captures an important architecture decision along with its context and consequences.

## Conventions

- Directory: `{ADR_DIR}`
- Naming:
  - Prefer numbered files when starting fresh: `0001-choose-database.md`
  - If the repo already uses slug-only names, keep that: `choose-database.md`
  - Date-prefixed (`bootstrap_adr.js --strategy date`): `2026-11-16-choose-database.md`
- Status values: `proposed`, `accepted`, `rejected`, `deprecated`, `superseded`

## Workflow

- Create a new ADR as `proposed`.
- Discuss and iterate.
- When the team commits: mark it `accepted` (or `rejected`).
- If replaced later: create a new ADR and mark the old one `superseded` with a link.

## ADRs
