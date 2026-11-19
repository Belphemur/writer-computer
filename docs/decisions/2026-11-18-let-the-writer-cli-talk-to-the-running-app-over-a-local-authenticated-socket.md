---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Let the writer CLI talk to the running app over a local, authenticated socket

## Context and Problem Statement

The `writer` CLI (`src-tauri/src/cli/`, spec `SPECs/writer-cli-spec.md`) works headless on the vault files and the shared index. It cannot reach the running app: `cli/registry.rs` `app_control` refuses Obsidian CLI commands such as `open` and `search:open`, and the single-instance argv path (`lib.rs` `handle_single_instance`) can only open a path. The Excalidraw ADR (`2026-11-18-draw-natively-with-a-built-in-excalidraw-feature-compatible-with-obsidian-drawings`) needs agents to ask the running app for an SVG export, and agents would benefit from opening notes in the user's window and knowing the active note. The user decided (2026-11-18) to add a CLI→app channel with these guardrails, as its own decision.

## Decision Drivers

- Only the same OS user can talk to the app; no network surface.
- A short, typed allowlist of commands; no code execution, no arbitrary file reads.
- Vault confinement as everywhere else (`vault_ops.rs`).
- Never log note contents, paths or the token.
- No new dependency (tokio `net` and `uuid` are present).
- Headless CLI commands keep working with the app closed.

## Considered Options

- A. A local socket (Unix domain socket / Windows named pipe) in the app data dir, owner-only, with a per-launch token, newline-delimited JSON, an allowlisted command registry that features extend.
- B. A localhost TCP port with a token.
- C. Marker files in `.writer/` watched by the app.

## Decision Outcome

Chosen option: **A**.

1. **Endpoint**: macOS and Linux: a Unix domain socket `ipc.sock` in Writer's app data dir (the dir `0700`, the socket `0600`); Windows: a named pipe `\\.\pipe\writer-<user-sid-hash>` with a security descriptor granting only the current user. Created at app startup by a Tauri-free module `src-tauri/src/ipc/` (server on tokio), removed on exit; a stale socket (connect fails) is unlinked at startup. One server per app process; all windows share it.
2. **Token**: a random token (`uuid` v4, 122 bits) generated per launch, written atomically to `ipc.token` (`0600`) beside the socket and rotated on every launch. Every request carries it; a wrong or missing token closes the connection after one generic error. The token is never logged.
3. **Protocol**: one JSON object per line, UTF-8, at most 64 KiB per message, 5 s read timeout per request. Request `{"v": 1, "id": "<n>", "token": "...", "cmd": "<name>", "vault": "<abs path>", "args": {...}}`; response `{"v": 1, "id": "<n>", "ok": true, "result": {...}}` or `{"ok": false, "error": {"code": "...", "message": "..."}}`. Unknown `v` or `cmd` is refused. Shared request/response vectors `apps/desktop/shared/ipc-vectors.json` pin the CLI client and the server.
4. **Allowlisted commands** (a registry, not a match per case; built-in features contribute through the `Feature` trait like CLI commands):
   - `status` → app version, open vaults (paths), whether the vault is open.
   - `open` → open a vault file in the vault's window (focus it; `newTab`, `line`, `anchor` options; opens the vault window if closed). Replaces the refusal of Obsidian's `open`.
   - `reveal` → reveal a file in the sidebar.
   - `active` → the active tab's vault-relative path, kind and cursor line of the vault's window. Never note text or the selection's text.
   - `excalidraw:export` (from the excalidraw feature) → render `<name>.svg` for a drawing and return its vault-relative path.
   Every path argument is vault-relative, resolved and confined by `vault_ops`, and must exist; requests for a vault the app does not have open are refused unless the command opens it (`open`).
5. **Client**: the CLI uses a blocking client (std `UnixStream`; on Windows the pipe opened as a file), reads the token file, sends one request, waits for the reply (default 5 s, `excalidraw:export` up to 30 s). If the socket or token is missing, or the connection is refused, the command fails with "Writer is not running" (exit code distinct from usage errors); `open` offers `--launch` to start the app (through the single-instance path) and retry.
6. **Logging**: the server logs the command name, outcome and duration at `info`; never args, paths, contents or the token (`SPECs/local-logging-spec.md`).
7. **Excalidraw**: `writer excalidraw:export` uses `excalidraw:export` over the socket; the export marker file in the Excalidraw ADR is dropped (that ADR is updated in the same change). Auto-export on change stays.

### Consequences

- Good: agents and scripts can open notes in the user's window, see the active note and export drawings, with clear errors when the app is closed.
- Good: one registry for app-controlled commands; Obsidian CLI `open` works.
- Bad: a new local trust surface; the owner-only endpoint, token and allowlist bound it.
- Neutral: other OS users and remote machines cannot reach it by design.

### Non-goals

- Any command that runs code, evaluates scripts, reads note text, returns the selection's text, or writes notes (writes stay headless through `vault_ops`).
- A network or remote API; plugin access to the socket; streaming or subscriptions.

## Implementation Plan

- **Affected paths**: new `src-tauri/src/ipc/` (`mod.rs` endpoint and token, `protocol.rs` types, `server.rs` tokio accept loop, `registry.rs` command table, `client.rs` blocking client; Tauri-free core with a thin Tauri glue that routes to windows in `commands/` or `lib.rs` setup); `features/mod.rs` (`Feature` trait: `ipc_commands()` contribution); `cli/registry.rs` (`app_control` commands now dispatched over IPC where implemented; still refused where not); `cli/mod.rs` (client use, "Writer is not running" error, `--launch`); `lib.rs` (start and stop the server, exit hook); `shared/ipc-vectors.json`; Excalidraw ADR update (marker dropped); specs `SPECs/writer-cli-spec.md` (new "Talking to the running app" section) and `SPECs/local-logging-spec.md` (IPC lines); the managed `writer-cli` skill (document `open`, `active`, `status`; bump `BUNDLE_VERSION`); `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: `commands::blocking` for blocking work; `vault_ops` confinement; registries over per-case branches; shared vectors for twins; the `Feature` trait's contribution style; atomic writes.
- **Patterns to avoid**: a TCP port; logging args or the token; a command that returns note text; a second confinement check.
- **Tests**: endpoint permissions (`0700` dir, `0600` socket and token) and stale-socket cleanup; token rotation per launch; wrong/missing token refused without detail; oversized message and timeout refused; unknown `v`/`cmd` refused; each command's confinement (`../`, absolute paths, symlink out, missing file); `active` returns no text; the vectors in client and server; CLI "Writer is not running" exit code and message; `open --launch`; a feature-contributed command registered and removed with the feature; logs contain the command name and never the path or token.

### Verification

- [ ] `writer status` reports the running app; with the app closed it says "Writer is not running".
- [ ] `writer open path=Note.md` opens the note in the vault's window.
- [ ] `writer active` returns the active note's path and line, never its text.
- [ ] Another OS user cannot connect; a request without the current token is refused.
- [ ] `writer excalidraw:export` returns the SVG path while the app runs.
- [ ] Logs show command names only.

## Pros and Cons of the Options

### A. Local socket with token

- Good, because owner-only by the filesystem, no port, small allowlist.
- Bad, because two endpoint kinds (Unix socket, named pipe).

### B. Localhost TCP

- Good, because one code path on every OS.
- Bad, because any local user and browser-reachable surface; a port to manage.

### C. Marker files

- Good, because no endpoint.
- Bad, because no reply, polling delays, and it writes into the vault.

## More Information

Related: [writer CLI spec](../../SPECs/writer-cli-spec.md), the CLI ADR, the Excalidraw ADR of the same day, [local logging spec](../../SPECs/local-logging-spec.md).
