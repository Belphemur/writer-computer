---
status: accepted
date: 2026-11-23
decision-makers: Writer maintainers
---

# Show a feature's log lines live in its settings page, starting with Git

## Context and Problem Statement

When a git sync fails to authenticate, the user only sees a short error kind in Settings > Git ("Sign-in failed"). git's own message (for example "Authentication failed for …", "remote: invalid credentials") is reduced to that kind in `git/transport.rs` (`classify`), and the log lines Writer writes for git (target `git`) sit in `~/Library/Logs/<identifier>/writer.*.log`, which the user has to find and read as JSON. The user asked (2026-11-23): "For any auth error for git, we should be able to directly see the logs, actually in the setting we should have another collapse section called logs, and be able to see git logs streamed there and see clearly colored errors."

The log pipeline (`src-tauri/src/logging.rs`, ADR 2026-11-16 "always write local error logs", spec `SPECs/local-logging-spec.md`) already redacts every line before it is queued (tokens, URL userinfo and query strings, the home folder, vault roots) and writes JSON lines with `target`, `level`, `message`.

## Decision Drivers

- One log pipeline: the view reads what the pipeline wrote, never a second log or a second redaction.
- Privacy unchanged: what the view shows is exactly the redacted line already on disk; a token never reaches a log.
- Generic in core, used by a feature: the next feature with logs worth seeing (agent, lint) adds a target, not code.
- No unbounded work: bounded backlog, bounded live rate, nothing while the section is closed.

## Considered Options

- A. A core **log tail** by target: a command returns the last N redacted lines of a target from today's file, and a live subscription forwards new lines of that target from the pipeline's writer while a view is open. A core component renders them. Git's settings page mounts it for target `git`.
- B. A git-only in-memory ring of recent git events, shown by the git page.
- C. "Open log folder" only.

## Decision Outcome

Chosen: **A**, with the user's answers (2026-11-23): **Writer's git lines plus git's own output**, and **today's lines, then live**.

1. **Core tail (`logging.rs`, `commands/logs.rs`).**
   - `log_tail { target, limit ≤ 500 }` returns the last `limit` lines of that target from today's `writer.*.log` (read backwards, bounded to the last 4 MiB of the file) as `{ ts, level, target, message, fields? }`.
   - `log_watch { target }` / `log_unwatch { id }` open and close a live feed: the pipeline's writer thread, after redaction, sends matching lines to the subscribers (`log:line` event to the window that asked). Rate-capped at 50 lines/s per subscriber (excess dropped, with one "n lines skipped" line). The feed closes with the window.
   - The target set is an allowlist owned by core (`git` first).
2. **Git's own output is logged.**
   - On a failed `git`, `git-lfs`, `gh` or `fj` call, `git/transport.rs` logs one `warn`/`error` line on target `git` with the command name and subcommand (never full argv), the exit code and git's stderr (bounded to 4 KiB, through the pipeline's redaction).
   - The credential helper's answer and stdin are never logged.
   - Successful calls log one `info` line (command and subcommand, duration), no output.
3. **The view (core component `src/components/log-view.tsx`).**
   - One line per entry: time, level and message, monospace.
   - Errors in the danger token colour, warnings in the warning token, info in the text colour.
   - A filter All / Errors, Copy (the visible lines) and "Open log folder" (the existing `open_log_folder`).
   - The view scrolls to the end on open and stays pinned there unless the user scrolls up.
   - No feed while the section is collapsed.
4. **Settings > Git.**
   - A collapsed section "Logs" after Advanced mounts the view for target `git`.
   - An error in the status line (auth or any other) gets "Show logs", which expands the section and scrolls to the latest error.

### Non-goals

- A general log viewer page, or log views for other features (later, a target each).
- Older days' files (Open log folder covers them).
- Changing redaction, levels or the file format.

### Consequences

- Good: an auth failure shows git's real message in two clicks, already redacted.
- Good: any feature can get the same section by adding its target to the allowlist.
- Bad: git's stderr now reaches the log file. It is redacted, but it may hold remote host names and repository names (already in the remote URL that Writer logs). This is accepted, and the privacy rules in the spec say so.
- Bad: one more subscriber path on the log writer thread, kept cheap (a target compare and a channel send per line).

## Implementation Plan

- **Affected paths:**
  - `apps/desktop/src-tauri/src/logging.rs` (subscriber registry on the writer thread, after `sanitize_line`);
  - `src-tauri/src/commands/logs.rs` (`log_tail`, `log_watch`, `log_unwatch`, async through `commands::blocking`) and `lib.rs` registration plus capability;
  - `src-tauri/src/git/transport.rs` (log failed calls with bounded, redacted stderr);
  - `src/components/log-view.tsx` (new) and `src/lib/logs.ts` (IPC wrapper);
  - `features/git/web/` settings page (section and "Show logs");
  - `SPECs/local-logging-spec.md` ("UX", "Privacy rules"), `SPECs/git-sync-spec.md` (Settings page), `docs/design.md` if the colour tokens need a rule.
- **Patterns to follow:**
  - the one redaction (`sanitize_line`), so the view and the file can never differ;
  - `commands::blocking` for file reads;
  - the existing collapsed "Advanced" section of Settings > Git;
  - theme tokens for colours (no literals);
  - terse labels.
- **Patterns to avoid:**
  - a second log store;
  - logging the credential helper's stdin or stdout, tokens or full argv;
  - reading the log file on the main thread;
  - a feed left open when the section is closed;
  - git-specific code in the core view.
- **Dependencies and configuration:** none.
- **Tests:**
  - Rust: `log_tail` returns only the target and the newest last, and stays bounded on a large file. A subscriber gets redacted lines of its target only, is rate-capped and is removed on unwatch. A failed fake `git` call logs its stderr redacted (a token-shaped string and a URL with userinfo come out redacted). The helper's answer never appears in the log.
  - Web: the view colours by level, filters to errors, stays pinned to the end, and copies the visible lines. "Show logs" expands and scrolls. No `log_watch` while collapsed.

## Verification

- [ ] A push with a bad token shows "Show logs" in Settings > Git; the section shows git's authentication message in red with no token in it.
- [ ] `log_tail`/`log_watch` read only allowlisted targets; a grep of the log after a test sync finds no credential helper output.
- [ ] Closing the section or the window ends the feed (a test counts subscribers).
- [ ] `vp check`, `vp test`, `cargo test`, `cargo clippy`, `cargo fmt --check` green.

## More Information

- Related: `2026-11-16-always-write-local-error-logs.md`, `2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md`, spec `SPECs/local-logging-spec.md`.
