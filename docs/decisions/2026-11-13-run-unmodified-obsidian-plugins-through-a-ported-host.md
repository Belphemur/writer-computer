---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Run unmodified Obsidian community plugins through a host ported from opensidian

> Backfilled on 2026-11-16 from `SPECs/obsidian-plugins-spec.md`. Date = the first plugin-host commits of 2026-11-13 (`0c518f0` adds the spec, `ab56648` the Rust backend, `f3141fa` the TypeScript host). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md); host notes: `apps/desktop/src/lib/obsidian-host/README.md`.

## Context and Problem Statement

Writer's users keep vaults that already use Obsidian community plugins; the first target is obsidian-copilot (AGPL-3.0). Writer needs those plugins to run without forking them, and without reading Obsidian's own code.

## Considered Options

- Port opensidian's plugin host (GPL-3.0-or-later, the same licence as Writer): reuse its Rust modules near as-is and rewrite its JS API shim in TypeScript to fit Writer's stores and page kinds (chosen).
- Build a new plugin API: plugins from the Obsidian ecosystem would not run.
- Bundle or patch plugins in Writer: rejected; Copilot is AGPL and a patch would break on every update.

## Decision Outcome

Chosen option: port the host, with these fixed rules.

- **Clean room.** Behaviour comes from the public `obsidian.d.ts`, the public developer docs and public help pages. No Obsidian application code, CSS or binaries are read or copied.
- **Never patch or fork a plugin.** The host adapts (Node shims, API shims, a settings seed applied on first enable only) so plugins run unmodified. Plugins are loaded from the user's vault, never bundled.
- **Storage is Obsidian's.** Plugins live in `.obsidian/plugins/<id>/` with `.obsidian/community-plugins.json`, so an existing vault works unchanged. `.obsidian` stays hidden in the sidebar and out of the index. Only the plugin commands (`plugins.rs`, `plugin_store.rs`) write there; `vault_ops.rs` lists `.obsidian` and `.git` as protected, and the CLI and Bases code never write into it.
- **Port style:** Rust modules reused, TypeScript shim rewritten (`apps/desktop/src/lib/obsidian-host/`).
- **Bases is a separate phase** after Copilot works (see `2026-11-15-bases-engine-in-rust-shared-by-app-and-cli.md`).

### Consequences

- Good, because Copilot 4.0.20 loads unmodified in the built app (`apps/desktop/e2e/specs/copilot-fake-claude.spec.js`).
- Bad, because API breadth is an open-ended compatibility surface: every plugin can reveal a missing shim (for example `setCssProps`, `Element.onWindowMigrated`, `Modal` layout), fixed in the host, never in the plugin.
- Bad, because an Obsidian-shaped API forces synchronous DOM and editor access into the main webview, which rules out a real sandbox (see `2026-11-13-trust-vaults-before-running-plugins-no-in-page-sandbox.md`).

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/obsidian-host/` (`loader.ts`, `api/`, `node/`), `apps/desktop/src/stores/plugins-store.ts`, `apps/desktop/src-tauri/src/plugins.rs`, `commands/plugins.rs`, `plugin_store.rs`, `plugin_proc.rs`, `plugin_http.rs`, `plugin_secrets.rs`.
- **Patterns to follow**: one `OwnedRegistry` per plugin id so disabling tears everything down; fix incompatibilities in the host; test with fakes first.
- **Patterns to avoid**: reading the installed Obsidian app; editing a plugin's files; writing `.obsidian` from non-plugin code.

### Verification

- [ ] `vp test` passes `apps/desktop/tests/obsidian-host-*.test.ts`.
- [ ] `sh e2e/fixtures/copilot-fake-claude/run.sh` (from `apps/desktop`) loads, enables and disables Copilot.
- [ ] `grep -rn "\.obsidian" apps/desktop/src-tauri/src` shows writes only in `plugins.rs` and `plugin_store.rs`.

## More Information

- Open risks and gaps are tracked in the spec ("Open risks") and `TODOS.md`.
