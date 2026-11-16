---
status: accepted
date: 2026-04-30
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Build the app on Tauri v2 with a React, Zustand frontend and a Rust backend

> Backfilled on 2026-11-16 from the repository, the README and the website docs. The git history starts on 2026-04-30 (`594cabd`, "Initial commit", already Tauri v2 + React + Zustand), so that is the earliest date git can prove; the choice itself predates it. No earlier discussion is recorded.

## Context and Problem Statement

Writer is a local-first markdown editor for plain-text folders and Obsidian vaults. Its product claims are a small download, fast cold start and instant opening of very large workspaces (`README.md`). The app needs native file access, a file watcher, window management and a signed auto-updater on macOS, plus a rich editing UI.

## Considered Options

- Tauri v2 with a React webview frontend and a Rust backend.
- Electron: the website docs state the app "is built with Tauri rather than Electron, so the download is about 6 MB" (`apps/website/src/routes/docs/index.tsx`); Electron bundles a browser and Node runtime.
- A native macOS UI: no reuse of the CodeMirror ecosystem and not cross-platform.

## Decision Outcome

Chosen option: Tauri v2. The frontend is React 19 with Zustand stores; the backend is Rust (IPC commands, watcher, workspace state, later the vault index and the CLI).

- Frontend state lives in Zustand stores under `apps/desktop/src/stores/` (`workspace-store.ts`, `editor-store.ts`, `settings-store.ts`, `ui-store.ts`, later `plugins-store.ts`); the rules are in `docs/zustand.md` and `docs/react-guidelines.md`.
- The Rust side owns anything that touches disk, so one write path per concern can be enforced (`docs/consolidation.md`).
- Native capabilities come from Tauri plugins already in `apps/desktop/src-tauri/Cargo.toml` (dialog, store, updater, single-instance, clipboard).

### Consequences

- Good, because the download is small and the backend is a single Rust process shared by every window.
- Good, because Rust code that does not need `tauri` types can be reused by a second binary (the `writer` CLI; see `2026-11-15-obsidian-style-writer-cli.md`).
- Bad, because the webview is the platform's (WKWebView on macOS): CSS and API behaviour differ per OS, and plugin code that expects Chromium/Electron needs shims (see `2026-11-13-run-unmodified-obsidian-plugins-through-a-ported-host.md`).
- Bad, because every feature crosses an IPC boundary and needs a Rust command plus a TypeScript caller.

## Implementation Plan

- **Affected paths**: `apps/desktop/src/` (React, stores), `apps/desktop/src-tauri/src/` (`lib.rs` registers plugins and commands, `commands/`), `apps/desktop/src-tauri/Cargo.toml` (`tauri = "2.12"`), `apps/desktop/package.json`.
- **Patterns to follow**: new IPC command = Rust handler in `commands/` registered in `lib.rs` plus a typed caller; side effects at the boundaries (`AGENTS.md` Engineering Guardrails).
- **Patterns to avoid**: a second state container next to Zustand; filesystem access from the webview.

### Verification

- [ ] `vp check` and `vp test` pass from `apps/desktop`; `cargo test` passes in `apps/desktop/src-tauri`.
- [ ] `apps/desktop/e2e/specs/smoke.spec.js` launches the built app.

## More Information

- Related: [`2026-04-30-adopt-vite-plus-toolchain.md`](2026-04-30-adopt-vite-plus-toolchain.md), [`2026-04-30-per-window-workspace-state.md`](2026-04-30-per-window-workspace-state.md).
