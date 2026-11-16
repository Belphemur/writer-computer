---
status: accepted
date: 2026-04-30
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Declare settings once in a JSON schema read by Rust and TypeScript, with three layers

> Backfilled on 2026-11-16. `apps/desktop/shared/settings.schema.json` and `config.rs` are in the initial commit (2026-04-30, `594cabd`); the consolidation rule that explains it (`docs/consolidation.md`, "Theme primaries had defaults in three places") predates the recorded history.

## Context and Problem Statement

Settings (theme, fonts, editor width, sidebar behaviour, telemetry, ...) had defaults, labels and types declared in Rust (`default_settings()`, `settings_schema()`) and in TypeScript (a theme presets file). Adding a setting meant editing three files, and forgetting one produced inconsistencies such as a preset selector showing a value that was not the real default.

## Decision

- `apps/desktop/shared/settings.schema.json` is the settings contract: keys, types, defaults, labels, descriptions and CSS-variable bindings. Rust reads it with `include_str!` (`apps/desktop/src-tauri/src/config.rs`) and the frontend through a static import (`apps/desktop/src/lib/settings-schema.ts`). Nothing else may declare defaults, labels or types. Theme preset values live in `apps/desktop/shared/themes/*.json`.
- Settings merge in three layers: defaults, then the global config in the app data directory, then a per-workspace config at `{workspace_root}/.writer/config` (`Settings` in `config.rs`).
- Settings with a CSS binding are applied by one side effect from the schema, not per-setting code (`docs/consolidation.md`: registry over per-case branches).

## Consequences

- Good, because adding a setting is one schema entry; UI controls, defaults and CSS variables derive from it.
- Good, because a workspace can carry its own overrides in `.writer/config` without touching `.obsidian`.
- Bad, because the schema is a contract between two languages: a malformed entry fails at startup or in tests rather than in review.
- Bad, because per-window merged copies can be stale across windows (see `2026-04-30-per-window-workspace-state.md`).

## Implementation Plan

- **Affected paths**: `apps/desktop/shared/settings.schema.json`, `apps/desktop/shared/themes/`, `apps/desktop/src-tauri/src/config.rs`, `apps/desktop/src-tauri/src/commands/settings.rs`, `apps/desktop/src/lib/settings-schema.ts`, `apps/desktop/src/stores/settings-store.ts`.
- **Patterns to follow**: add the key to the schema first; derive labels, defaults and CSS bindings from it.
- **Patterns to avoid**: re-declaring a default or label in TS or Rust.

### Verification

- [ ] `cargo test` in `apps/desktop/src-tauri` and `vp test` in `apps/desktop` pass (schema parse and settings tests).
- [ ] `grep` shows no default value for an existing key outside the schema file.
