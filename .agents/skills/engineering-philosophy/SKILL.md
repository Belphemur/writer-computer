---
name: engineering-philosophy
description: Writer's coding philosophy, applied to every code change and review: DRY first, then SOLID, then KISS. Use before writing, changing or reviewing any code in this repo, when choosing between abstractions, when about to copy code, add a per-case branch, split or merge a module, or when two principles seem to conflict.
---

# Engineering philosophy: DRY > SOLID > KISS

The order is the rule. When two principles disagree, the earlier one wins. This applies to Rust and TypeScript, app code and tests, and to code written by agents.

## 1. DRY (highest priority): one source of truth for every piece of knowledge

DRY is about **knowledge**, not text. A rule, a constant, a type, a protocol shape, a mapping, a validation or a UI pattern must live in exactly one place; everything else derives from it.

- Before writing code, search for an existing implementation (`rg`, the registries, `docs/consolidation.md`). Reuse or extend it. Never copy-paste a block and tweak it.
- Second occurrence of the same knowledge: extract it now, not at the third (the third is already a bug waiting to diverge). Two things that merely look alike but change for different reasons are not duplication: do not merge those (that is coupling, and it violates SOLID's single responsibility).
- Prefer data and registries over per-case branches: a new case is one new entry in one table, not edits in several files (see `docs/consolidation.md`: if adding the next case touches more than one file, the structure is wrong).
- Cross-language twins (Rust and TypeScript) are allowed only when one side cannot call the other, and then they share a single data source: generated types, a JSON schema (`shared/settings.schema.json`), shared test vectors or goldens (`shared/search-rank-vectors.json`, `shared/agent-golden/`). Never two hand-kept copies without a shared test that fails when they drift.
- One write path per kind of state, one place for each side effect, one helper per repeated mechanism (path confinement, atomic write, debounce, popover shell, list editor, table component...).
- Tests follow the same rule: shared fixtures and helpers, no copy-pasted setup.
- Docs and specs are knowledge too: link to the owning doc instead of restating it.

## 2. SOLID: structure the shared code so it stays easy to change

- **Single responsibility:** a module, hook, component or function has one reason to change. Split when responsibilities diverge, merge nothing that has different reasons to change.
- **Open/closed:** extend behavior by adding an entry to a registry or implementing a trait, not by editing a growing `match`/`if` chain (page kinds, commands, settings blocks, agent backends, plugin processors).
- **Liskov:** implementations of one interface (a port, a trait, a client, a mock) must be substitutable: same contract, same errors, same ordering guarantees. Mocks and fakes follow the real contract (fake `claude`, mock agent client, goldens).
- **Interface segregation:** small interfaces. Callers depend on the narrow port they use (`ProjectPort`, `ChatPort`, `SecretBackend`), not on a god object.
- **Dependency inversion:** high-level logic depends on abstractions; I/O, clocks, processes, Tauri and the file system sit at the boundary behind a trait or an injected function so the core is testable in isolation (Tauri-free Rust cores, injected `Measure`, injected clients).

## 3. KISS (lowest priority, but still binding): the simplest thing that satisfies 1 and 2

- Among designs that are DRY and SOLID, choose the one with the fewest moving parts, the least indirection and the most obvious control flow.
- KISS is never a reason to duplicate code, to bolt a special case onto an unrelated module, or to grow a god function. "Simple" means simple to reason about, not short or copy-pasted.
- No speculative generality: do not add an abstraction for a second case that does not exist yet, unless it is a registry or port that removes existing duplication. Delete code that nothing uses.
- Fail explicitly, keep async flows race-safe, keep side effects at the boundaries (see AGENTS.md guardrails).

## How to apply on every task

1. **Search first.** What already does this? Which registry, helper, trait or schema owns it? Reuse it; if it almost fits, generalize it rather than fork it.
2. **Name the knowledge.** What is the one fact this change introduces (a rule, a shape, a constant)? Put it in one place and derive the rest.
3. **Check the shape.** Does adding this case touch more than one file? Is there a per-case branch? Is a module doing two jobs? Fix the structure, then add the case.
4. **Then simplify.** Remove indirection that no longer earns its keep.
5. **In review, flag in this order:** duplication of knowledge (DRY), then structural violations (SOLID), then needless complexity (KISS). Report findings with the file, the duplicated or violated thing and the single place it should live.

## When the principles seem to conflict

- DRY vs KISS: DRY wins. Extract the shared piece even if the shared code is slightly more abstract, as long as it does not violate SOLID (do not couple unrelated reasons to change).
- SOLID vs KISS: SOLID wins when the structure removes real duplication or an existing change hotspot; KISS wins when the "SOLID" structure only anticipates a case that does not exist.
- Existing code that violates this: do not copy its pattern. Follow the philosophy in the code you touch, and note larger rewrites in `TODOS.md` or the refactor assessment (`SPECs/refactor-assessment.md`) instead of expanding the current change.
