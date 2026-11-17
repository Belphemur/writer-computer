---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Store agent chats as markdown notes in a hidden chats folder under the project

Spec: [`SPECs/native-agent-spec.md`](../../SPECs/native-agent-spec.md) ("Chat history"). Related: [first-party agent pane](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md), [projects](2026-11-17-projects-are-vault-folders-with-project-md-and-agents-md-compatible-with-copilots-format.md), [vault index in app data](2026-11-15-sqlite-vault-index-in-app-data.md).

## Context and Problem Statement

Chats must survive restarts, be reopenable without the CLI's session, be listable per project, and stay local-first. Copilot stores chats as visible markdown notes, which then show up in search, quick open, graph and every other agent's reads. Where should Writer's chats live, and how do they avoid polluting the vault?

## Decision Drivers

- Plain markdown, user-owned, syncable, greppable on purpose.
- Must not appear in Writer's search, Quick Open, sidebar, recents, Bases or `writer search` by default.
- Must not make the agent itself read old chats while grepping the vault.
- Zero changes to the vault index: `index::paths::is_indexable_rel` already skips every hidden path segment.
- Identity must survive renames; the CLI session id is not portable between machines (Copilot lost sessions that way).

## Considered Options

- Hidden `.chats/` folder under the project (`<project>/.chats/`, and `<vault>/.writer/chats/` for chats without a project), chosen.
- A visible `chats/` or `Chats/` folder with a frontmatter flag and a new index exclusion rule.
- Hidden app data outside the vault (JSON or SQLite).

## Decision Outcome

Chosen option: hidden dot folders inside the vault. A chat is `<project>/.chats/YYYY-MM-DD-HHmm-<slug>-<id8>.md` with frontmatter (`writer-chat-id`, `writer-chat-session-id`, `writer-chat-title`, `writer-chat-project`, created/updated epoch milliseconds, pinned/archived, model, usage) and a body of labelled turns plus a per-message line recording what was attached (paths, not contents) and a collapsed tool trail. The chat id (a uuid, also the claude `--session-id` on first spawn) is the identity, never the filename. Reopening works from the note alone; `--resume <session-id>` is an optimisation, and when the CLI no longer has the session Writer starts a new one seeded with a capped replay of the note. Dot folders are skipped by the index, file watcher, sidebar tree and Quick Open already, and by `rg` and the CLI's own searches; so no index or watcher code changes. The pane lists chats through dedicated commands (`agent_list_chats`, ...) and opens a chat note in an editor tab on request.

### Consequences

- Good, because chats are real markdown files in the vault (backup, git, Syncthing) yet invisible to search and to the agent's greps.
- Good, because no index change and no new exclusion rule to maintain.
- Bad, because hidden folders are skipped by Obsidian Sync and by some tools; users who sync that way will not get chat history on other machines. Mitigation: documented, and the setting `agent.chats-folder-visible` (later) can move chats to a visible folder with the same format.
- Bad, because chats are not browsable in the sidebar; the pane's history list and "Reveal chat note" are the entry points.
- Neutral, because the CLI keeps its own transcript in `~/.claude/projects/...`; Writer never reads it.

## Implementation Plan

- **Affected paths**: `src-tauri/src/agent/chat_store.rs` (read/write/list/rename, Tauri-free, atomic write via temp and rename), `commands/agent.rs`, `src/lib/agent/chat-note.ts` (serialise/parse), `src/stores/agent-store.ts`.
- **Patterns to follow**: `vault_ops.rs` confinement; debounced autosave after each turn; preserve unknown user properties on rewrite (`index/patch.rs`).
- **Patterns to avoid**: indexing chats; storing note contents or tool output beyond the capped trail; using the filename as identity; reading `~/.claude`.

### Verification

- [ ] Round-trip, rename, and unknown-property-preservation tests on synthetic chat notes.
- [ ] A test asserts `is_indexable_rel("Projects/Demo/.chats/x.md")` is false and the vault index lists no chat.
- [ ] Reopen test: delete the CLI session, reopen, send, and a new session starts with a replay.

## Pros and Cons of the Options

### Hidden `.chats/` folder

- Good, because search/index/watcher exclusion is free and already tested.
- Bad, because of the Obsidian Sync and browsability caveats above.

### Visible `chats/` folder with a flag

- Good, because chats are browsable and sync everywhere.
- Bad, because it needs a new exclusion rule in the index, FTS, Quick Open, recents, Bases and the CLI (touching many call sites, against `docs/consolidation.md`), and the agent's greps would read old chats.

### App data outside the vault

- Good, because no vault pollution at all.
- Bad, because chats do not travel with the vault, cannot be edited or committed, and per-project history is detached from the project folder.
