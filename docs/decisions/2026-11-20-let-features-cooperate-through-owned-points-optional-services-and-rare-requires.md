---
status: accepted
date: 2026-11-20
decision-makers: Writer maintainers
---

# Let features cooperate through owned points, optional services and rare requires, one protocol in Rust and TypeScript

## Context and Problem Statement

Built-in features (`apps/desktop/features/<id>/`, ADR `2026-11-17-build-first-party-features-as-built-in-plugins-...`) increasingly work with each other: git commits an agent turn and will share its diff with the agent's Changes card, lint shares the Markdown scanner with spellcheck, PDF and Excalidraw feed search through file kinds (ADR `2026-11-18-let-features-contribute-file-kinds-...`), tasks feeds bases rows. The user asked (2026-11-20) for "a standard protocol / system" for how features depend on each other, including features that enhance others such as search, and for every feature to degrade cleanly when another is off.

Today the pieces exist but are uneven: the web side has contribution points owned by core (table 6.5 of `SPECs/builtin-plugins-spec.md`) and services (`src/lib/features/services.ts`, manifest `provides`); the Rust side has one trait method per case (`file_kinds`, `cli_commands`, `index_ddl`); `dependsOn` (spec 7.6) is described but not implemented; and no feature can own a point another feature plugs into, so git's "agent turn finished" has no home.

## Decision Drivers

- A feature that is off, crashed, or on but not set up never breaks another (`.agents/skills/writer-feature/SKILL.md`, "Off must degrade, never break").
- The owner of a behaviour never knows who enhances it (DRY, open/closed): adding an enhancer touches only the enhancer.
- One vocabulary and one manifest shape on both sides, checked by one contract test.
- No new dependency.

## Considered Options

- A. Points owned by core or by features, optional services, rare `requires`; same three primitives in Rust and TypeScript, declared in `feature.json`.
- B. Every point in core only (core grows hooks about features it doesn't own).
- C. Web-only formalisation; Rust keeps a trait method per case.
- D. Free `dependsOn` with topological start and stop.

## Decision Outcome

Chosen option: **A**, with the user (2026-11-20).

### The three primitives

1. **Point** (many contributors, owner unaware): a named place where others add behaviour or data. Id `<owner>.<point>`, the owner being `core` or a feature id (`core.before-save`, `agent.turn-finished`, `search.providers`, `core.file-kinds`). The owner declares it, defines its contract type, and calls the contributions; contributors declare that they extend it. With the owner off, the point does not exist and contributions to it are simply not called; with a contributor off, its contribution is gone. Kinds: **hook** (the owner notifies: `turn-finished`, `workspace-open`; fire-and-forget or awaited with a timeout), **provider** (the owner collects: file kinds, search providers, menu items, status items), **transform** (the owner passes a value through each contribution in order: before-save).
2. **Service** (one provider, consumer looks it up): a typed capability one feature offers (`bases.views`, `pdf.info`, `agent.context`). The consumer asks at use time and handles absence; it never caches the provider across a switch. Exactly one provider per service id.
3. **Requires** (rare): feature B is meaningless without A. Then B is off whenever A is off or failed, with a one-line reason in Settings > Features ("Needs Agent"). Allowed only when B has no behaviour of its own; everything else is optional. No cycles (contract test). This replaces the unimplemented `dependsOn` of spec 7.6.

### Manifest (`feature.json`)

```json
{
  "points": [{ "id": "agent.turn-finished", "kind": "hook", "side": "rust" }],
  "extends": ["agent.turn-finished", "core.before-save"],
  "provides": ["git.history"],
  "uses": ["agent.context"],
  "requires": []
}
```

`side` is `rust`, `web` or `both`. `provides` keeps its current meaning; `uses` is new and only documents and lets the contract test check consumers. Existing core points of table 6.5 are renamed into this vocabulary in the spec (`core.<point>`) without code churn: their registration keys in `contributes` stay.

### Rules (both sides)

- **Depend on a point or a service, never on a feature.** No import of another feature's runtime code (TypeScript `import type` of the owner's contract from `@features/<owner>/web/api` is allowed; in Rust the contract types live in the owner's public `api` module and are plain data). No `is_enabled("<other>")` checks anywhere outside the registry.
- **The existing behaviour is the no-contributor path.** An enhancer adds to it; nothing moves into the enhancer.
- **Owners never wait on absent or failing contributors.** Hooks are contained (`features::guard` in Rust, `FeatureBoundary`/health strikes in TS); awaited points have a timeout (before-save already has 1.5 s) and skip the contribution on timeout.
- **Order is explicit**: provider and transform contributions run in a declared `order` number, ties by feature id. No dependence on registration order.
- **Everything is removed together** when a contributor goes off, at runtime for the web half, at the next start for the Rust half (as today).

### Rust side

A small registry in `src-tauri/src/features/points.rs`: a point is a typed key (`Point<Args, Ret>`) declared by its owner in its `api` module; a contributor registers a handler in `Feature::setup` through `points::extend(&POINT, owner_id, handler)`; the owner calls `points::emit(&POINT, args)` (hook) or `points::collect(&POINT, args)` (provider). Registration is ignored when the point's owner is off. Services: `points::provide(&SERVICE, impl)` / `points::service(&SERVICE) -> Option<Arc<dyn Trait>>`. Existing trait methods (`file_kinds`, `cli_commands`, `skills`, `index_ddl`) stay as they are: they are core-owned providers read at startup and are documented as such; new cross-feature cooperation uses the registry.

### TypeScript side

The existing `OwnedRegistry` points and `services.ts` are the implementation. Add feature-owned points: an owner exports `definePoint<Args, Ret>("agent.turn-finished")` from its `web/api`; contributors register in `contributes.points: [{ point, id, order?, run }]`; the owner calls `emit` / `collect` from the same module. One registry file, `src/lib/features/points.ts`.

### Settings > Features

Each feature row shows a quiet line "Works with Agent, Search" built from `extends`, `uses` and the reverse. Turning a feature off shows a one-line note of what stops ("Agent turns won't be saved in history"), taken from each extended point's `offNote`, declared by the contributor. A feature with `requires` whose dependency is off shows "Needs <name>" and its toggle is disabled. No dialogs.

### Consequences

- Good: one way to cooperate, visible in manifests and checked by tests; owners stay unaware of enhancers; off and crashed features degrade by construction.
- Good: search, agent and others can be enhanced without core growing per-feature hooks.
- Bad: one more registry on the Rust side and a manifest migration; mitigated by keeping existing trait methods and web keys.
- Bad: feature-owned points create edges between features; mitigated by the contract test (no cycles through `requires`, every `extends` names a declared point, every `uses` a declared `provides`).

## Implementation Plan

- **Affected paths:** `apps/desktop/src-tauri/src/features/{mod.rs,points.rs (new),contract_tests.rs}`, `apps/desktop/src/lib/features/{points.ts (new),registry.ts,types.ts,manifests.ts,services.ts}`, the manifest schema and every `features/*/feature.json` (add `points`/`extends`/`uses` where they already cooperate), the Features settings page (`src/lib/features/settings-sections.ts` host and its component), `SPECs/builtin-plugins-spec.md` (new section "Cooperation", 6.5 renamed into `core.<point>`, 7.6 replaced), `.agents/skills/writer-feature/SKILL.md` (link this ADR from "Off must degrade").
- **First users:** git extends `agent.turn-finished` (Rust hook owned by the agent: chat id, title, files changed, models) — the git phase 1 lane builds its seam to this shape; lint and spellcheck keep sharing `markdown_mask.rs` (core module, not a feature edge).
- **Pattern:** owner declares point + contract in its `api` module; contributor declares `extends` and registers in `setup`/`contributes`; consumer of a service handles `None`.
- **Tests:** Rust: emit with no contributor returns at once; contributor off → not called; panicking contributor contained, others still called; order; owner off → `extend` ignored. TS: same set plus runtime switch-off removes contributions. Contract tests: every `extends` names a declared point with the right `side`; every `uses` a `provides`; no `requires` cycle; a feature with `requires` is off when its dependency is off; no cross-feature runtime import (extend the boundary test to Rust `use crate::features::<other>` outside `api`).

## Verification

- [ ] `features/*/feature.json` declare `points`, `extends`, `uses`, `requires` where they cooperate, and the contract test passes.
- [ ] With git off, an agent turn emits `agent.turn-finished` with no contributor and the Changes card and Undo behave as before.
- [ ] Settings > Features shows "Works with …" and the off note for git.
- [ ] `cargo test`, `cargo clippy`, `vp check` (0 errors), `vp test` pass.

## More Information

- Rules for degrading: `.agents/skills/writer-feature/SKILL.md`, "Off must degrade, never break" (2026-11-20).
- Related: `2026-11-17-build-first-party-features-as-built-in-plugins-...` (manifest, trait, registry), `2026-11-17-contain-feature-failures-...` (guard, strikes), `2026-11-18-let-features-contribute-file-kinds-...` (a core-owned provider point), `2026-11-18-sync-vaults-with-a-built-in-git-feature-...` (first feature-owned point user).
