---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Let a consented agent plugin read and replace Claude's settings file

Refines the plugin trust model in [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md) ("Trust model", "Home files"): the `fs` shim stays vault-confined, with one explicit, narrow exception.

## Context and Problem Statement

Copilot's agent settings screen lists "Approved rules": the `permissions.allow` entries of Claude Code's user settings, `~/.claude/settings.json`. It reads that file, and when the user picks an "always allow" option or removes a rule it read-modify-writes it. The real `claude` CLI reads the same file, so the file must be the real one. The `fs` shim refuses everything outside the vault (`EACCES ... (outside the vault)`), so the screen showed "Couldn't read Claude's approved rules" and "always allow" never persisted: the user was prompted for every Bash command.

The save sequence, read from Copilot's bundle (analysis only, never patched): `realpath`, `access(W_OK)`, `stat` (mode), `mkdtemp(<dir>/.copilot-rules-)`, `open(<tmp>/settings.json, "wx", mode)`, write, `chmod`, `sync`, `close`, `readFileSync(target)` compared with the text it read, `renameSync(<tmp file>, target)`, then `rm(<tmp dir>, {recursive})`. Writer's sync `fs` cannot do IPC, so `renameSync` cannot perform a real rename.

## Decision

Add an explicit allowlist `HOME_FILES` of exact home-relative files (TS `node/home-files.ts`, Rust `plugin_home_files.rs`, kept equal). Today one entry: `.claude/settings.json`, plugin id `copilot`. An entry is a file, never a directory or glob. Not on the list and refused: `~/.claude.json` (credentials, MCP servers), `~/.claude/.credentials.json`, `~/.claude/projects` (transcripts), `~/.claude/settings.local.json` (the vault-local `.claude/settings*.json` are inside the vault and use the vault `fs`).

Two Tauri commands, both `async` through `blocking`: `plugin_home_file_read` and `plugin_home_file_write`. Every call passes four gates, all enforced in Rust:

1. The vault is trusted (restricted mode refuses).
2. The path is exactly `<home>/<entry>` for a plugin id named by the entry (a `..` or any other spelling is refused).
3. The plugin holds the remembered wildcard spawn consent ("always allow", every program) for this vault (`ConsentStore::has_wildcard`; a consent for one named program does not count).
4. The file operation passes the checks below.

File rules: `<home>` and the entry's directory are canonicalized and must resolve inside the canonical home; a symlinked file is followed only to a target inside home (a dotfiles repo works, the link is kept because the rename replaces the resolved target); the target must be a regular file; UTF-8 text, at most 1 MiB. Writes use a temp file in the target's directory, fsync, and rename, so the CLI never sees a partial file; an existing file's mode is kept, a new file is 0600, and a missing `~/.claude` is created 0700 (only that directory, directly under home). Every write logs `plugin <id>: wrote ~/.claude/settings.json (<n> bytes)` at info level, never contents.

Concurrency: `read` returns a SHA-256 `version`; the shim remembers it per file and `write` sends it as `expectedVersion`, so a change by the CLI between Copilot's read and write fails with `ESTALE` instead of being overwritten. The remaining window (between that check and the rename, microseconds) is not closed: the CLI takes no lock either, so a lock would protect against nothing. Copilot's own check (`readFileSync(target)` against what it read) cannot see disk changes in Writer, because sync reads are served from a cache; the Rust check replaces it.

Shim behaviour for Copilot's sequence: `mkdtemp(<dir>/.copilot-rules-)`, `open(<tmp>/settings.json, "wx")` and the handle are served from memory (the temp file never exists on disk), the ONE atomic write is sent when the handle is closed (errors, including `ESTALE`, reject `close()` before the plugin believes anything was saved), and `renameSync(tmp, target)` only validates that a closed staged file goes to its own entry and refreshes the sync cache. Anything else (another name in the temp dir, another prefix, another target) stays `ENOSYS`/`EACCES`. `realpath` of the file answers the logical path, so a plugin never moves its temp directory to a symlink target outside the allowlisted directory. Sync variants keep their policy (cache only).

Security argument: a plugin that holds the wildcard spawn consent can already run any program as the user, so it can already edit `~/.claude/settings.json` and far more. Editing Claude's approval rules does not widen its power. The danger is only a plugin WITHOUT that consent gaining the ability, which the gate forbids, as it forbids restricted mode. Residual: the plugin id is supplied by the plugin runtime (taken from the call stack, like `plugin_proc_spawn`'s `plugin_id`), so a malicious plugin in the same webview can name itself `copilot`, exactly as it can for spawn consent; the same-webview boundary is the one documented in the trust model. Writing permissive rules also affects Claude Code in other projects (it is the user-level file); the settings screen shows these rules, and every write is logged.

### Consequences

- Good, because "always allow" persists and the Approved rules screen works with an unmodified Copilot.
- Good, because the exception is one exact file with its own tests, Rust gates, and a stale-write check.
- Bad, because there is a second kind of outside-vault access to reason about; adding an entry is a security decision.
- Bad, because a staged write is committed at `close()`, not at `renameSync` (a plugin that closes and then never renames still changed the file).
- Bad, because the real CLI interplay (CLI and Writer saving at once, the real `claude` re-reading the file) cannot be tested here.

## Implementation Plan

- **Affected paths**: `src-tauri/src/plugin_home_files.rs`, `src-tauri/src/plugin_consent.rs` (`has_wildcard`), `src-tauri/src/commands/plugins.rs`, `src-tauri/src/lib.rs`, `src/lib/obsidian-host/node/{home-files,fs,ipc,registry,errors,testing}.ts`, `tests/obsidian-node-home-files.test.ts`.
- **Dependencies**: none (`sha2` was already present).
- **Patterns to follow**: Rust gates before IO, `blocking`, atomic temp-and-rename, errors prefixed with a POSIX code that the shim maps to `err.code`.
- **Patterns to avoid**: listing a directory or glob; listing credentials or transcripts; a TS-only check; logging contents; widening to plugins without wildcard spawn consent.

### Verification

- [ ] `cargo test plugin_home_files plugin_consent` passes (exact path, `..`, symlink escapes, directory, oversize, non-UTF-8, missing home, stale version, mode, no contents in the log, consent matrix).
- [ ] `vp test tests/obsidian-node-home-files.test.ts` passes (Copilot's exact sequence; other paths and plugin ids stay EACCES).
- [ ] Manual with the real Copilot and `claude`: Approved rules lists the rules, "always allow" persists, removing a rule works, Undo restores it.

## Alternatives Considered

- Virtual home mount (like `~/.obsidian-copilot`): rejected, the real `claude` CLI must read the same bytes.
- Copy the rules into the vault and sync: rejected, two sources of truth and the CLI would not honour the copy.
- A native dialog for each write: considered. It would add friction to the very flow ("allow once and for all") this fixes, and the user already granted far more by choosing "always allow" for spawning; the write log and the stale check give traceability instead. Revisit if the allowlist grows to files that are not covered by the spawn capability.
- Make the whole `~/.claude` directory writable: rejected, it holds credentials and transcripts.
- Emulate sync `renameSync` as a fire-and-forget IPC: rejected, a failed save would look successful; committing at `close()` lets errors reach the plugin.

## More Information

Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), "Home files". Host notes: `apps/desktop/src/lib/obsidian-host/README.md`.
