# Architecture Decision Records (ADR)

An Architecture Decision Record (ADR) captures an important architecture decision along with its context and consequences.

## Conventions

- Directory: `docs/decisions`
- Naming: `YYYY-MM-DD-title-with-dashes.md`, the ISO date of the decision (also the `date` front matter)
- Status values: `proposed`, `accepted`, `rejected`, `deprecated`, `superseded`

## Workflow

- Create a new ADR as `proposed`.
- Discuss and iterate.
- When the team commits: mark it `accepted` (or `rejected`).
- If replaced later: create a new ADR and mark the old one `superseded` with a link.

## ADRs

| Date       | Decision                                                                                                                                                                 | Status   | Links                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| 2026-04-30 | [Use Vite+ (`vp`) as the single frontend toolchain](2026-04-30-adopt-vite-plus-toolchain.md)                                                                             | accepted | [vite-plus](../vite-plus.md)                                                                            |
| 2026-04-30 | [Build the app on Tauri v2 with a React, Zustand frontend and a Rust backend](2026-04-30-build-on-tauri-v2-react-zustand.md)                                             | accepted | [README](../../README.md), [react-guidelines](../react-guidelines.md), [zustand](../zustand.md)         |
| 2026-04-30 | [Edit markdown in CodeMirror 6 with a vendored Prosemark core](2026-04-30-codemirror-with-vendored-prosemark-editor.md)                                                  | accepted | [editor](../editor.md)                                                                                  |
| 2026-04-30 | [Declare settings once in a JSON schema read by Rust and TypeScript, with three layers](2026-04-30-one-settings-schema-shared-by-rust-and-typescript.md)                 | accepted | [consolidation](../consolidation.md)                                                                    |
| 2026-04-30 | [Keep workspace state per window, in one process](2026-04-30-per-window-workspace-state.md)                                                                              | accepted | [spec](../../SPECs/multi-window-spec.md)                                                                |
| 2026-05-08 | [Keep the `notify` watcher and fix its post-receive filter for external changes](2026-05-08-keep-notify-watcher-and-fix-the-filter.md)                                   | accepted | [spec](../../SPECs/external-file-watcher-spec.md)                                                       |
| 2026-08-28 | [Collect opt-in telemetry from a Rust client, off until the user consents](2026-08-28-opt-in-telemetry-from-a-rust-client.md)                                            | accepted | [spec](../../SPECs/opt-in-telemetry-spec.md), [doc](../telemetry.md)                                    |
| 2026-10-17 | [Render Mermaid diagrams with Pele instead of beautiful-mermaid](2026-10-17-render-mermaid-with-pele.md)                                                                 | accepted | [spec](../../SPECs/pele-diagrams-spec.md)                                                               |
| 2026-11-13 | [Let agent plugins drive the user's own CLI through a Node-compatible shim over Rust commands](2026-11-13-agent-plugins-use-the-real-cli-through-a-node-shim.md)         | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Confine file commands to the window's workspace root in Rust](2026-11-13-confine-file-commands-to-the-workspace-root.md)                                                | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Fetch and install marketplace plugins from Rust, against a GitHub-only host allowlist](2026-11-13-github-only-marketplace-fetched-by-rust.md)                           | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Narrow the app CSP `img-src` that currently allows any https host](2026-11-13-narrow-the-app-csp-img-src.md)                                                            | proposed | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Require native consent, remembered per plugin and vault, for plugin process spawns](2026-11-13-native-consent-for-plugin-process-spawn.md)                              | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Render plugin markdown with `marked` and one shared DOMPurify core](2026-11-13-render-plugin-markdown-with-marked-and-dompurify.md)                                     | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Run unmodified Obsidian community plugins through a host ported from opensidian](2026-11-13-run-unmodified-obsidian-plugins-through-a-ported-host.md)                   | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Scope the `opener:allow-open-path` permission for links to files outside the workspace](2026-11-13-scope-the-opener-open-path-permission.md)                            | proposed | [TODOS](../../TODOS.md)                                                                                 |
| 2026-11-13 | [Serve plugin code over a `writer-plugin://` URI scheme under a scoped CSP](2026-11-13-serve-plugin-code-over-the-writer-plugin-scheme.md)                               | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Store plugin secrets (`app.secretStorage`) in the OS credential store](2026-11-13-store-plugin-secrets-in-the-os-keychain.md)                                           | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Test the plugin agent path against a fake `claude`; check the real CLI by hand](2026-11-13-test-the-agent-path-with-a-fake-claude.md)                                   | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-13 | [Run plugins only in trusted vaults, with no in-page sandbox](2026-11-13-trust-vaults-before-running-plugins-no-in-page-sandbox.md)                                      | accepted | [spec](../../SPECs/obsidian-plugins-spec.md)                                                            |
| 2026-11-15 | [Implement the Bases engine in Rust, shared by the app and the CLI](2026-11-15-bases-engine-in-rust-shared-by-app-and-cli.md)                                            | accepted | [spec](../../SPECs/obsidian-bases-spec.md), [engine](../../apps/desktop/src-tauri/src/bases/README.md)  |
| 2026-11-15 | [Build the Bases UI on one view registry, virtualized lists and comment-preserving `.base` edits](2026-11-15-bases-ui-one-view-registry-and-comment-preserving-edits.md) | accepted | [spec](../../SPECs/obsidian-bases-spec.md), [UI](../../apps/desktop/src/components/base-view/README.md) |
| 2026-11-15 | [Index note content in a contentless FTS5 table with unicode61, CJK spacing and bm25 weights](2026-11-15-fts5-note-content-search-design.md)                             | accepted | [spec](../../SPECs/search-spec.md)                                                                      |
| 2026-11-15 | [Give the `writer` binary an Obsidian-style command grammar on the shared index](2026-11-15-obsidian-style-writer-cli.md)                                                | accepted | [spec](../../SPECs/writer-cli-spec.md)                                                                  |
| 2026-11-15 | [Edit note properties with a byte-minimal frontmatter line patcher in Rust](2026-11-15-patch-frontmatter-lines-not-the-whole-block.md)                                   | accepted | [spec](../../SPECs/obsidian-bases-spec.md)                                                              |
| 2026-11-15 | [Serve quick open, recents and folder checks from an in-memory mirror of the index](2026-11-15-quick-open-reads-the-index-name-cache.md)                                 | accepted | [spec](../../SPECs/obsidian-bases-spec.md)                                                              |
| 2026-11-15 | [Keep a SQLite vault index (rusqlite, bundled) in the app data directory](2026-11-15-sqlite-vault-index-in-app-data.md)                                                  | accepted | [spec](../../SPECs/obsidian-bases-spec.md)                                                              |
| 2026-11-16 | [Adopt architecture decision records with date-prefixed filenames](2026-11-16-adopt-architecture-decision-records.md)                                                    | accepted | [skill](../../.agents/skills/adr-skill/SKILL.md)                                                        |
| 2026-11-16 | [Always write local error logs with tracing, rotated to three days](2026-11-16-always-write-local-error-logs.md)                                                         | accepted | [spec](../../SPECs/local-logging-spec.md), [telemetry](../telemetry.md)                                 |

Dates are the day the decision was made. ADRs marked "Backfilled" in their first note were written on 2026-11-16 from specs, commits and code; their date is the first commit that introduced the decision (decisions older than the git history take 2026-04-30, the first commit). Specs hold behaviour, schemas and test matrices; ADRs link to them instead of copying them.

Check consistency with `node .agents/skills/adr-skill/scripts/check_adr.js --dir docs/decisions`. Write a new ADR when a decision changes how the system is built or operated, is hard to reverse, affects later contributors and had real alternatives (see `AGENTS.md` Hard Rules): `node .agents/skills/adr-skill/scripts/new_adr.js --title "..." --template madr --status proposed --update-index`.
