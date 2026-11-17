# Local logging

Decision: [ADR 2026-11-16](../docs/decisions/2026-11-16-always-write-local-error-logs.md). Code: `apps/desktop/src-tauri/src/logging.rs`, `commands/logs.rs`, `apps/desktop/src/lib/logger.ts`.

## Goal

Every run of Writer and of the `writer` CLI writes errors and warnings to local files, so a problem reported from the real app can be diagnosed afterwards. Logs never leave the machine.

## Where and how long

- Directory: the OS log dir of the app identifier (`~/Library/Logs/com.writer-computer/` on macOS; `$XDG_DATA_HOME/<id>/logs` on Linux; `%LOCALAPPDATA%\<id>\logs` on Windows).
- `writer.<YYYY-MM-DD>.log` for the app, `cli.<YYYY-MM-DD>.log` for the CLI. Daily rotation (UTC), at most 3 files per prefix, older ones deleted at startup and on rotation.

## Line format

One JSON object per line:

```json
{
  "pid": 4242,
  "timestamp": "2026-11-16T10:00:00.123456Z",
  "level": "ERROR",
  "fields": {
    "message": "TypeError: x is not a function",
    "source": "plugin",
    "window": "main",
    "plugin": "copilot",
    "phase": "load",
    "version": "4.0.20",
    "stack": "...",
    "repeats": 0
  },
  "target": "frontend"
}
```

Targets: `frontend` (all webview events), `app`, `panic`, `cli`, `plugin_proc` (plugin child process stderr head, 2 KB, and non-zero exits at info), and each Rust module path (`log::` macros).

## Levels

`error`, `warn` and `info` by default. Setting `diagnostics.log-level` (`error|warn|info|debug`, default `info`) applies at runtime; `WRITER_LOG=<level|off>` overrides it. Debug adds the file watcher's diagnostics (`target: "watcher"`) that used to need `WRITER_WATCHER_LOG`.

## Sources

- Rust: `log::` and `tracing` macros, one subscriber; `eprintln!` calls were replaced. A panic hook logs message, location, thread and a backtrace, then flushes before abort.
- Frontend: `installGlobalLogging()` (called first in `main.tsx`) forwards `window.onerror`, `unhandledrejection`, `console.error`/`console.warn` (originals still run), failed IPC commands (command name and error text, never arguments), React error boundary catches, plugin errors (`recordPluginError`: plugin id, phase, version, message, stack) and the missing-API diagnostic (warn, phase `missing-api`; only when `writer.plugins.debug` is on or in dev). Plugin phases in use: `load`, `unload`, `seed`, `prime-agent-paths`, `command:run|check`, `event:<name>`, `ribbon`, `modal-open`, `view-close`, `settings-tab`, `bases-view:*`, `missing-api`.
- Plugin processes: stderr head and non-zero exit, with plugin id and program name.
- CLI: a failed command logs its name, exit code and the first 500 characters of stderr (never its arguments).
- Batching: entries are buffered for 1 s or 50 entries, identical messages (same level, source, plugin, phase, first 300 chars) are sent once per 60 s with a `repeats` count later, 100 entries per 10 s per window at most (Rust caps 300 per 10 s overall), message 4000 and stack 8000 characters.

## Privacy rules

Applied by `logging::sanitize_line` on the writer thread to every line:

- Vault roots become `<vault>`, the home directory (and any `/Users/<x>`, `/home/<x>`) becomes `~`.
- `sk-...`, GitHub and Slack tokens, AWS key ids, `Bearer ...`, `Authorization: ...`, `api_key=`, `token=`, `password=`, `secret=` style pairs (also inside JSON) and URL userinfo become `[redacted]`; URL query strings become `?[redacted]`.
- Lines over 16 KB have their strings truncated.
- Nothing logs note contents, `secretStorage` values or clipboard text; callers pass error text, not data. A plugin that prints a note in its own `console.error` would have that text capped but not recognized: this is a known limit.

## UX

- Command palette: "Open log folder" and "Copy recent errors" (last 200 error/warn lines, redacted, one line each).
- Settings > Logs: the log folder path, the same two buttons, and the level setting. Failed plugins in Settings > Manage plugins say "details: Settings, Logs".
- No new capability permission: opening the folder uses the opener plugin from Rust.

## Tests

Rust (`logging::tests`, `commands::logs::tests`): path and secret redaction, JSON validity after truncation, level resolution and runtime reload, file naming, retention of 3 files per prefix, concurrent writers (8 threads) produce whole lines, 50k events do not block with a dead disk, `log` crate bridge, recent-errors merge, panic description, frontend entry shape and rate limiter. Frontend (`tests/logger.test.ts`, `plugin-error-logging.test.ts`, `logs-section.test.tsx`, `command-registry.test.ts`): batching, dedupe, caps, rate limit, handler wiring, IPC failure logging, plugin phases, the Settings block and palette commands.

## Not verified

Not run in a real window: the log folder opening in Finder, real file rotation across midnight, the panic flush under `panic = "abort"`, the `writer` symlink path writing `cli.*.log`.

## Lifecycle and crash lines

- `writer started` on launch, `writer exiting` (`stage=exit-requested`, then `stage=exit`) on quit. Panics are logged by the panic hook (message, location, backtrace, flushed before abort).
- Native crashes, force quits, `kill -9` and power loss leave no line, so a `writer.running` file in the log directory holds the pid while the app runs and is removed on a clean exit. If the next launch finds it with a dead pid it logs a warn: `previous run did not exit cleanly`.
