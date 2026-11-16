---
status: accepted
date: 2026-11-16
decision-makers: Writer maintainers
---

# Always write local error logs with tracing, rotated to three days

## Context and Problem Statement

Problems reported from the real app (plugin load failures, freezes, missing plugin API members) were hard to diagnose after the fact. The app wrote nothing to disk: Rust used `eprintln!` (invisible when launched from the Dock) and `log::` macros with no logger installed, and the frontend used `console.error` (gone when the window closes) and a 100-entry `window.__writerPluginErrors` buffer that only a developer's console can read. How does the app keep enough error history, locally, to diagnose a report without becoming a privacy or performance problem?

## Decision Drivers

- Errors and warnings must always be written, with no setting to turn on first.
- Writing must never block the UI thread or IPC (`AGENTS.md`: disk IO rule).
- Retention is bounded: at most three days of files.
- Local only: logs are never uploaded (telemetry is separate and opt-in, `docs/telemetry.md`); no note content, secrets, URL query strings or clipboard in them; home and vault paths shortened.
- One source of truth for destination, format, level and redaction (`docs/consolidation.md`): Rust, the `writer` CLI, plugin processes and the frontend all feed the same pipeline.
- Prefer maintained libraries over a hand-rolled rotating writer (maintainer decision).

## Considered Options

- `tracing` + `tracing-subscriber` + `tracing-appender` (daily rolling, non-blocking worker, `max_log_files`).
- `tauri-plugin-log`.
- `log` + `fern` (or `flexi_logger`).
- A hand-rolled rotating file writer behind a channel and thread (std only).

## Decision Outcome

Chosen option: `tracing` + `tracing-subscriber` + `tracing-appender`, because it is the only option that gives daily files, exact retention by file count (`RollingFileAppender::builder().max_log_files(3)`, pruned when the appender starts and at each rotation), a lossy non-blocking writer thread, runtime level reload and a `log` bridge from one maintained family. `tracing` and `tracing-core` were already in the lock file through Tauri, so the added graph is small.

- Files: `<log dir>/writer.<YYYY-MM-DD>.log` (app) and `cli.<YYYY-MM-DD>.log` (the `writer` command), same directory, three files per prefix. The directory is the OS log dir for the identifier in `tauri.conf.json` (`~/Library/Logs/com.writer-computer/` on macOS), the same one Tauri's `app_log_dir` resolves to.
- Format: one JSON object per line (greppable and parseable, so "Copy recent errors" and bug-report tooling read it without a second parser). UTC timestamps with a `Z` offset, `level`, `target`, `fields` (`message`, and for frontend events `source`, `window`, `plugin`, `phase`, `version`, `stack`, `repeats`), and `pid`.
- Levels: `info` and above by default (changed from `warn`: plugin lifecycle and file deletes need to be visible when diagnosing reports). Setting `diagnostics.log-level` (`shared/settings.schema.json`, default `info`) raises it at runtime; env `WRITER_LOG` wins over the setting.
- Redaction and size caps run on the writer thread in one place (`logging::sanitize_line`), so every source gets them and the caller never pays for them.
- Frontend: `src/lib/logger.ts` is the only module calling the `log_event` command (buffered, deduplicated per message for 60 s, rate limited, size capped); Rust applies a second rate limit.
- Failed Tauri commands are logged centrally on the frontend by wrapping `__TAURI_INTERNALS__.invoke` (command name and error text only, never arguments). Tauri exposes no hook for command results on the Rust side, so a per-command wrapper was the alternative.
- Panics: a hook logs message, location, thread and backtrace, and flushes the writer before the release profile's `panic = "abort"`.
- "Open log folder" is a Rust command using the opener plugin's Rust API, so **no new capability permission** is added (the `opener:allow-open-path` question in `2026-11-13-scope-the-opener-open-path-permission.md` stays open and unaffected).

### Consequences

- Good, because reports can be diagnosed from files that exist without any prior setup; three days of warn-level files stay small.
- Good, because existing `log::warn!`/`log::error!` calls (index, managed skills, plugin consent) are captured without edits, and `eprintln!` calls became `log::` calls.
- Good, because the whole pipeline is covered by tests (rotation and retention, redaction, concurrency, non-blocking behavior, level reload).
- Bad, because the lossy queue drops lines instead of blocking when the disk stalls, and a crash can lose up to the unflushed tail (the panic hook and normal exit flush; a hard kill does not).
- Bad, because nine crates join the lock file (`tracing-subscriber` 1.2 MB of source is the largest), and `tracing-subscriber` has no local-time offset without extra dependencies, so timestamps are UTC.
- Neutral, because plugin console output that is not an error or warning is not logged.

## Alternatives Considered

- `tauri-plugin-log`: wraps `fern`; rotates by size (`RotationStrategy::KeepAll`/`KeepOne`, `max_file_size`), not by day, cannot cap by age or file count, and would still need its own redaction and a JSON format. Rejected.
- `log` + `fern`/`flexi_logger`: capable, but a second logging facade next to Tauri's own `tracing` use, no structured fields for the frontend bridge, and no built-in non-blocking writer for `fern`. Rejected.
- Hand-rolled rotating writer: roughly 150 lines, but retention, midnight rotation and shutdown flushing are exactly the code that goes wrong in production. Rejected by the maintainer in favor of a maintained library.

## Implementation Plan

- `apps/desktop/src-tauri/src/logging.rs`: location, level, redaction, sanitizing worker-side writer, subscriber build, global install, panic hook, `recent_errors`. Called from `lib.rs::run` (`init_app`, `shutdown` on `RunEvent::Exit`) and `main.rs` (`init_cli`).
- `commands/logs.rs`: `log_event`, `log_info`, `open_log_folder`, `recent_log_errors`.
- `apps/desktop/src/lib/logger.ts` (the one frontend sink), `lib/log-actions.ts` (palette and Settings actions), `components/settings-panel/logs-section.tsx` (registry entry `logs` in `settings-sections.ts`).
- Verify: `cargo test`, `pnpm exec vp test`, and `WRITER_LOG=debug` then inspect the folder in a real window (not done in an automated run).

## More Information

Spec: [SPECs/local-logging-spec.md](../../SPECs/local-logging-spec.md). Disclosure: [docs/telemetry.md](../telemetry.md) ("Local logs").
