---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Require native consent, remembered per plugin and vault, for plugin process spawns

> Backfilled on 2026-11-16. Date = `24828ea` "Add plugin HTTP client, process spawn and wider path authorization" (`plugin_proc.rs`); consent grew in `cdd64aa` and was changed to per-plugin by `89edde4` "Remember plugin consent per plugin and vault, not per program" (same day). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), "Process and environment contract".

## Context and Problem Statement

Agent plugins such as Copilot start local programs (the agent CLI, login shells, version probes). A plugin in a trusted vault must not be able to start arbitrary programs silently, and the prompt must not be spoofable by page code. A per-program prompt made the dialog return constantly because Copilot starts several programs.

## Considered Options

- Native dialog drawn by Rust with three answers; "Always" remembered per plugin and vault (chosen).
- Per-program "always allow": first implementation; superseded the same day.
- No prompt in trusted vaults: rejected; trusting a vault should not mean every plugin may spawn anything unseen.

## Decision Outcome

Chosen option: `plugin_proc_spawn` (`apps/desktop/src-tauri/src/plugin_proc.rs`, `plugin_consent.rs`, `plugin_env.rs`) works for trusted vaults only and asks through a native dialog showing plugin id, resolved program, all args, cwd and env var names. Answers: run once, always allow this plugin in this vault, deny. "Always" stores `"*"` for the plugin in `<app_data>/plugins_proc_consent.json` (canonical vault path, plugin id, programs); older per-program entries still work; arguments are never part of the key. A remembered plugin skips the dialog but every spawn emits the window event `plugin-proc:spawned`. Revoking trust clears the vault's consents; `plugins_consent_revoke` removes one.

Limits: cwd confined to the vault, at most 8 live processes, process groups killed on window close, vault switch, trust revoke and app exit. Helpers without a plugin-chosen process need no dialog: `plugin_which`, `plugin_resolve_login_path`, `plugin_os_info` (env allow-list minus anything matching KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL), `plugin_fs_probe` (metadata only).

### Consequences

- Good, because the dialog is drawn by Rust and cannot be faked or auto-confirmed by plugin JavaScript.
- Bad, because "Always" with `"*"` lets that plugin run any program in that vault; that is the cost of making Copilot usable.
- Bad, because Windows is compile-only (no process groups beyond `CREATE_NO_WINDOW`), there is no PTY, and the 8-process cap counts helper processes like `claude --version`.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/plugin_proc.rs`, `plugin_consent.rs`, `plugin_env.rs`, `commands/plugins.rs`, `apps/desktop/src/lib/obsidian-host/node/child-process.ts`.
- **Patterns to avoid**: spawning from any plugin-facing command without the consent path; passing secrets through env allow-lists.

### Verification

- [ ] `cargo test` covers consent storage, env allow-list filtering and `plugin_fs_probe`/`plugin_open_path` in `plugin_env.rs`.
- [ ] `vp test` passes `tests/obsidian-node-child-process.test.ts`.
- [ ] In the e2e fixture, consent is pre-approved through `plugins_proc_consent.json`; the dialog UX itself is not covered (spec "Does NOT prove").

## Addendum (2026-11-17)

This consent governs community plugins only. The first-party agent pane no longer uses it (no `writer-agent` consent, no dialog): the agent feature's switch is its approval, see the addendum of [build a first-party agent pane](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md).

## Addendum (2026-11-17): the dialog text is bounded

A native alert does not scroll, so a long argv (an agent's `--agents` JSON, a system prompt) or many environment names pushed Allow and Deny off screen. The dialog stays native, and only its display changes: `ConsentRequest::message()` builds one bounded text (at most 1600 characters; arguments cut to 80 characters, JSON shown as `<JSON, N chars>`, at most 12 arguments and 900 characters of them; at most 8 environment names, never values) that points to the log. The full argv and environment names are logged once at info level (`log_full`, the system prompt reduced to its length). The consent identity is unchanged: it is still keyed by vault, plugin and program in `ConsentStore`, never by the displayed text.
