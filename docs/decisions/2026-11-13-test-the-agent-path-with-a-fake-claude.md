---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Test the plugin agent path against a fake `claude`; check the real CLI by hand

> Backfilled on 2026-11-16. Date = `4da420b` "Run unmodified Copilot with a fake claude in the e2e harness". Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), "Status (Copilot e2e)"; harness notes `apps/desktop/e2e/README.md`.

## Context and Problem Statement

The plugin host must be proven against unmodified Copilot without depending on a signed-in Claude account, network access, API cost or nondeterministic model output, and without modifying the plugin.

## Considered Options

- A fake `claude` CLI script on the e2e PATH, with unmodified Copilot running in the built Tauri app under WebDriver (chosen).
- The real `claude` CLI in automated tests: needs credentials and network, and is nondeterministic.
- Mocking at the unit level only: does not catch host bugs that surface only in the real webview (the run found seven, among them the missing `app.secretStorage`, `Element.onWindowMigrated` and a CSS sanitiser that deleted Copilot's whole minified stylesheet).

## Decision Outcome

Chosen option: fixtures in `apps/desktop/e2e/fixtures/copilot-fake-claude/` (`fake-claude.js`, `fake-agent.sh`, `setup.sh`, `run.sh`); Copilot's release assets are downloaded to a gitignored cache and never committed. Specs: `copilot-fake-claude.spec.js` (7 tests), `copilot-history-and-tabs.spec.js`, `copilot-popups.spec.js`, `copilot-agents-config.spec.js`, `copilot-settings-tab.spec.js`. The e2e build uses its own app identifier, so it never touches the real keychain; spawn consent is pre-approved through `plugins_proc_consent.json`.

It proves load, enable, disable, re-enable, palette commands, load-time probes, a streamed turn rendered in the DOM, graceful stop on disable and no orphan after quit. It does not prove the real CLI (versions, auth, `~/.claude`), BYOK chat, permission cards, Stop/interrupt, SIGKILL escalation, consent dialog UX or keychain persistence. The real `claude` CLI is a manual check by the maintainer after automated work.

### Consequences

- Good, because the agent path is deterministic and runs without accounts.
- Bad, because the fake can drift from the real CLI's stream format; the manual check is the backstop.
- Bad, because the harness needs the built app and WebDriver (`tauri-plugin-webdriver`, optional feature), so it is slower than unit tests.

## Implementation Plan

- **Affected paths**: `apps/desktop/e2e/fixtures/copilot-fake-claude/`, `apps/desktop/e2e/specs/copilot-*.spec.js`, `apps/desktop/e2e/wdio.conf.js`, `apps/desktop/e2e/README.md`.
- **Patterns to follow**: reproduce a plugin bug in an e2e spec first, then fix the host; never edit the plugin.
- **Patterns to avoid**: committing Copilot assets; pointing tests at the real keychain or a real `claude`.

### Verification

- [ ] `sh e2e/fixtures/copilot-fake-claude/run.sh` is green from `apps/desktop`.
- [ ] `git ls-files` shows no Copilot `main.js`.
