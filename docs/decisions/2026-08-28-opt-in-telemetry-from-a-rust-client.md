---
status: accepted
date: 2026-08-28
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Collect opt-in telemetry from a Rust client, off until the user consents

> Backfilled on 2026-11-16. Date = `bc37cda` "Add opt-in telemetry, off by default" (spec, doc and code). Spec: [`SPECs/opt-in-telemetry-spec.md`](../../SPECs/opt-in-telemetry-spec.md); full disclosure: [`docs/telemetry.md`](../telemetry.md).

## Context and Problem Statement

The maintainers want to know who the users are (optional email), how many are active (stable per-install id) and what they do (a few intent events), without compromising the local-first promise of an open-source editor.

## Considered Options

- A Rust-side PostHog client in one file, with a first-run consent dialog (chosen).
- `posthog-js` in the webview: rejected in the spec; it defaults to autocapture and would need explicit suppression to avoid capturing prose from the editor DOM, an opt-out posture inside an opt-in feature. It would also put the project key in the webview.
- No telemetry: leaves the three questions unanswerable.

## Decision Outcome

Chosen option: Rust client in `apps/desktop/src-tauri/src/telemetry.rs`, the only file in the app that talks to an analytics service.

- Off until the user answers the first-run dialog; effective switch is `telemetry.enabled && prompted`, so a copied config cannot enable it. `distinct_id` and `prompted` live in `telemetry.json` in the app data dir, not in settings.
- The email is a normal setting (`telemetry.email`, `shared/settings.schema.json`), independent of the usage switch; clearing it sends `$unset` even with usage off.
- Build-time key via `option_env!("WRITER_POSTHOG_KEY")`: with no key the module is inert, so forks and contributor builds cannot phone home. `WRITER_TELEMETRY_DISABLED` disables it at runtime.
- Four fixed events (`app_opened`, `workspace_opened`, `file_created`, `folder_created`) emitted from the shared inner functions (`fs::create_file_impl`, `create_directory_impl`, `workspace::prepare_workspace_state`), carrying no paths, names or content. No retry or disk buffer.

### Consequences

- Good, because the egress surface is auditable in one file and the key never reaches the webview.
- Bad, because adding an event touches the call site, `docs/telemetry.md` and the consent dialog together (rule recorded in the doc and `AGENTS.md`).
- Neutral, because the marketing website reports to PostHog separately (`docs/website-analytics.md`).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/telemetry.rs`, `apps/desktop/src/components/telemetry-consent-dialog.tsx`, `apps/desktop/shared/settings.schema.json`, `docs/telemetry.md`.
- **Patterns to avoid**: instrumenting the `#[tauri::command]` wrappers (misses the sidebar and restore paths); any analytics call outside `telemetry.rs`.

### Verification

- [ ] `cargo test` runs the 14 tests in `telemetry.rs`.
- [ ] `apps/desktop/e2e/specs/telemetry-consent.spec.js` passes against the built app.
- [ ] With `WRITER_POSTHOG_KEY` unset no network request is made.
