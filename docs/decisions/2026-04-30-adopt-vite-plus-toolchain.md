---
status: accepted
date: 2026-04-30
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Use Vite+ (`vp`) as the single frontend toolchain

> Backfilled on 2026-11-16 from the git history. `vite.config.ts` importing `vite-plus` and `docs/vite-plus.md` are in the initial commit (2026-04-30, `594cabd`); the decision predates the recorded history.

## Context and Problem Statement

The repo is a pnpm workspace with a desktop app, a playground, a website and e2e tests. Formatting, linting, type checking, testing, building and Node/package management would otherwise be separate tools with separate versions and configs.

## Decision

Use Vite+ (`vp`), the unified toolchain over Vite, Rolldown, Vitest, Oxlint and Oxfmt. Contributors and agents run `vp install`, `vp dev`, `vp check`, `vp test`, `vp build`; they do not call pnpm, npm, Vite or Vitest directly, and import tooling APIs from `vite-plus` (`vite.config.ts`, `apps/desktop/vite.config.ts`). Details and pitfalls: `docs/vite-plus.md`.

## Consequences

- Good, because one command (`vp check`) is the format, lint and type gate for humans and agents (`AGENTS.md` Validation).
- Bad, because the project follows Vite+ release cadence and its migrations (the 2026-11-13 dependency refresh moved to Vite+ 1.6 with Vitest 5 through `vp migrate`, see `TODOS.md` Done).
- Bad, because commands collide with `package.json` scripts of the same name (`vp run <script>` is needed).

## Implementation Plan

- **Affected paths**: `vite.config.ts`, `apps/desktop/vite.config.ts`, `package.json`, `pnpm-workspace.yaml`, `docs/vite-plus.md`, the Vite+ block at the end of `AGENTS.md`.
- **Patterns to avoid**: `npm run`, `pnpm exec vitest`, importing from `vite` or `vitest`.

### Verification

- [ ] `vp check` and `vp test` succeed in `apps/desktop`.
- [ ] No config file imports `vite` or `vitest` directly.

## More Information

- Related: [`2026-04-30-build-on-tauri-v2-react-zustand.md`](2026-04-30-build-on-tauri-v2-react-zustand.md).
