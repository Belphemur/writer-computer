---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Let agent plugins drive the user's own CLI through a Node-compatible shim over Rust commands

> Backfilled on 2026-11-16. Date = `cdd64aa` "Extend plugin process spawn for agent sessions" and `76c567d` "Add Node module surface for agent-capable plugins"; detection and home mounts followed in `2cecacf` and `cd95f93` (all 2026-11-13). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), statuses "Copilot e2e", "agent configuration" and "history, tabs, open note, active note".

## Context and Problem Statement

Copilot 4.0.20's Agent Chat talks to coding agents by spawning their CLIs: `claude` (Claude Code), `codex-acp` and `opencode`. In Obsidian this relies on Electron's Node (`child_process`, `fs`, `os`, `path`, `readline`, sync `existsSync`/`realpathSync`) and on a home directory the plugin may write. Writer's webview has none of that, and the plugin must stay unmodified.

## Considered Options

- Provide a Node-compatible module surface (`require("child_process")`, `fs`, `os`, ...) in the host, backed by Rust commands (`plugin_proc_*`, `plugin_which`, `plugin_resolve_login_path`, `plugin_os_info`, `plugin_fs_probe`, `plugin_http_*`, `plugin_open_path`, `plugin_open_url`) (chosen).
- Embed Writer's own agent or call the Claude API directly: not what the plugin does; would not run the plugin.
- Patch Copilot to use Tauri APIs: forbidden by `2026-11-13-run-unmodified-obsidian-plugins-through-a-ported-host.md`.

## Decision Outcome

Chosen option: the shim in `apps/desktop/src/lib/obsidian-host/node/`, with these specific choices.

- **The user's own installed CLI is used**, found by `plugin_which` over the login PATH and well-known dirs; "Managed by Copilot" downloads that write outside the vault (Codex, OpenCode) are unsupported by design ("My own installation" only).
- **Sync detection over async I/O.** Copilot's resolvers are synchronous, so `node/agent-clis.ts` preloads one list of agents and candidate dirs at boot (existence, canonical paths, version-root listings, `provenance.json`/`package.json` content up to 64 KiB) from `plugin_fs_probe`, and the sync cache follows the async fs.
- **Home mounts.** Plugin writes outside the vault are refused, so `~/.obsidian-copilot` is served from `.obsidian/plugins/copilot/home/.obsidian-copilot` inside the vault (`node/home-mounts.ts`, one entry per plugin).
- **No new capability for a plugin**: spawn still needs consent (`2026-11-13-native-consent-for-plugin-process-spawn.md`); `plugin_open_path` opens only existing vault or agent-home entries, never launchable ones; `plugin_open_url` allows http, https and mailto; network goes through `plugin_http_*` (reqwest + rustls, trusted vault only, metadata addresses refused, size caps).

### Consequences

- Good, because the plugin runs unchanged and uses whatever agent version and login the user already has.
- Bad, because the Node surface is a growing compatibility layer (`XMLHttpRequest`, `WebSocket`, `EventSource` are gaps; resuming a native Claude chat needs `~/.claude/projects` reads, not done).
- Bad, because real Codex/OpenCode logins and the process cap under a slow real `claude` are unverified.

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/obsidian-host/node/` (`child-process.ts`, `fs.ts`, `agent-clis.ts`, `home-mounts.ts`, `http.ts`), `apps/desktop/src-tauri/src/plugin_proc.rs`, `plugin_http.rs`, `plugin_env.rs`.
- **Patterns to follow**: add an agent or a mount as one registry entry; keep `plugin_fs_probe` metadata-only.
- **Patterns to avoid**: giving plugins write access outside the vault; any command that launches by path.

### Verification

- [ ] `vp test` passes `tests/obsidian-node-*.test.ts` and `obsidian-network-*.test.ts`.
- [ ] `SPEC=copilot-agents-config.spec.js sh e2e/fixtures/copilot-fake-claude/run.sh` passes (9 tests) in `apps/desktop`.
- [ ] Manual: the real `claude` CLI signs in and completes a turn (not covered by automation).
