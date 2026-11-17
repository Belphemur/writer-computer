# Native agent pane: a first-party chat over the `claude` CLI

Status: design (contract and mapper implemented; runner, UI, projects and history to build). Date: 2026-11-17.
Decisions: [first-party pane over stream-json](../docs/decisions/2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md), [projects as folders with project.md and AGENTS.md](../docs/decisions/2026-11-17-projects-are-vault-folders-with-project-md-and-agents-md-compatible-with-copilots-format.md), [chats as hidden markdown notes](../docs/decisions/2026-11-17-store-agent-chats-as-markdown-notes-in-a-hidden-chats-folder-under-the-project.md).
Research and the 11 questions this answers: [`native-assistant-research.md`](native-assistant-research.md).
Contract code (already in the tree): `apps/desktop/src/lib/agent/events.ts`, `apps/desktop/src-tauri/src/agent/{events,claude_stream,mod}.rs`, fixtures `src-tauri/src/agent/fixtures/*.jsonl`, golden `apps/desktop/shared/agent-golden/*.events.json`, tests `cargo test agent::` and `tests/agent-events.test.ts`.

> **Clean-room.** Obsidian Copilot is AGPL-3.0. Its UX was studied from the user's screenshots, the public repo and docs, and (read-only) key names in the installed bundle. No code, prompts, text, CSS or assets are copied. All strings, icons and styles below are Writer's own.

## 1. What this is

A right-hand pane, "Agent", that drives the user's own `claude` CLI (Claude Code) in the vault or in a project folder, with the same UX class as Copilot's agent chat: tabs of chats, a transcript with the user's turns as cards and the agent's work as a collapsible timeline, a "Permission required" card, a composer with `@` and `/`, projects, and a visible record of what context is attached. The Copilot plugin keeps working alongside (the plugin host is untouched).

Non-goals (v1): other backends (the typed event layer keeps ACP open, see ADR), mobile, cloud sessions, MCP management UI (the CLI's own config applies), image attachments, inline diff/revoke of edits (phase "Edits" in the research, later), telemetry.

## 2. Product behaviour

1. **Open.** `Cmd+Shift+A` or the palette command "Agent: toggle pane" opens the pane in the right dock. The dock holds one view: opening the agent pane closes a plugin leaf and vice versa. No workspace open: the command is disabled.
2. **First run.** If no `claude` binary is found ("not found" state), the pane shows one card: what is missing, the searched places, "Choose binary…" and a link to Claude Code's install page (opened through the existing opener). Nothing is spawned.
3. **First spawn per vault.** The first time the pane would start the CLI in a vault, a native dialog (drawn by Rust, same mechanism as plugin spawn consent) shows the resolved program, version, cwd, the argument list and the env var names, with "Run once", "Always allow in this vault" and "Deny". "Always" is remembered per vault. Restricted (untrusted) vaults refuse. See section 8.
4. **New chat.** A chat belongs to the vault root or to a project. It starts lazily: the process is spawned on the first message, not when the tab opens. Chat id = new uuid, which is also the CLI `--session-id`.
5. **Send.** Enter sends, Shift+Enter inserts a newline. The user message becomes a card immediately (optimistic), then events stream into the timeline. While a turn runs the composer stays editable; Enter queues the next message (shown as a "Queued" chip, sent when the turn finishes; Esc on the chip removes it).
6. **Stop.** The stop button or Esc (composer focused, nothing else to dismiss) sends the CLI an `interrupt`; the turn ends "Stopped". Pending permission cards are cancelled by the CLI.
7. **Permission.** A tool that needs approval produces the pinned card (section 6). The turn is paused until answered.
8. **Reopen.** History lists the chat notes; opening one rebuilds the transcript from the note and, on the next send, resumes the CLI session or starts a seeded one (section 9).
9. **Close.** Closing a tab with a running turn asks to stop it. Closing the window, switching vault or quitting kills every agent process group.

### Chat and pane states (one state machine per chat, in the store)

`AgentSessionState`: `idle` (no process or process waiting for input), `starting` (spawning, no `session-started` yet), `running` (turn in flight), `awaiting-permission`, `cancelling` (interrupt sent, waiting for `turn-finished`), `reconnecting` (process died unexpectedly; auto-respawn with `--resume`, at most 2 tries), `error` (needs user action), `ended` (closed). Transitions are driven only by events and by the user's actions:

| State               | Entered by                                                                        | Composer                                                              | Header/tab indicator                    | Transcript                                                                     |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| idle                | `turn-finished`, `session-started` while no turn, new chat                        | enabled, placeholder "Ask anything, @ to add context, / for commands" | none                                    | last turn complete                                                             |
| starting            | send with no live process                                                         | enabled, Enter queues                                                 | tab spinner, "Starting Claude…" row     | user card, skeleton                                                            |
| running             | send while live, `text-delta`, `tool-call-started`, `thinking`                    | enabled (queues), stop button replaces send                           | tab spinner, "Working" footer animation | timeline streams                                                               |
| awaiting-permission | `permission-request`                                                              | enabled; card is pinned above it                                      | tab warning dot, header badge           | timeline paused on the tool row ("Waiting for permission")                     |
| cancelling          | user stop                                                                         | disabled, "Stopping…"                                                 | spinner                                 | rows keep their last state                                                     |
| reconnecting        | `session-ended` with exit not requested during a turn, or `error{process-exited}` | disabled                                                              | tab "Reconnecting…"                     | banner row "Connection lost, resuming"                                         |
| error               | `error{retryable:false}`, binary missing, spawn denied, auth                      | disabled for auth/binary/denied; enabled otherwise                    | tab error dot                           | error card with a fix action (below)                                           |
| cancelled           | `turn-finished{interrupted}`                                                      | enabled                                                               | none                                    | footer "Stopped", running rows marked "Interrupted", pending cards "Cancelled" |

Error cards: `binary-not-found` (choose binary), `spawn-denied` (ask again), `auth` ("Run `claude` in a terminal to sign in", copy command), `rate-limit` (resets-at time from the `rate-limit` event, Retry), `api` with `retryable` (Retry), `protocol` (Copy diagnostics, which copies the `recent_log_errors` text), `timeout` and `unknown` (Retry).

## 3. UX and component mapping

### 3.1 Layout

Right dock, default width 420 px, resizable 320–640 px, persisted in `agent.pane-width`. The dock is a column: header, chat-tabs row, transcript (scrolls), pinned stack (permission card, queued chip, context chips), composer. Same chrome tokens as the sidebar and editor; no new colours.

### 3.2 Element map (screenshot element to Writer component)

All files under `apps/desktop/src/components/agent/` unless noted; one component per file, kebab-case, named exports.

| Element (user screenshot)                                                                     | Component                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pane titled "Agent"                                                                           | `agent-pane.tsx`                                            | Right-dock host; replaces `PluginViewPane` when active; width from the store.                                                                                                                                                                                                                                                                                                                               |
| Header: back chevron, project name with folder icon                                           | `agent-header.tsx`                                          | Chevron returns from project home/history to the chat. Title = project name or the vault name. Icon buttons: settings (opens Settings > Agent), project/context browser, history, "New project" (palette command also).                                                                                                                                                                                     |
| Settings, project/context browser, history icons                                              | `agent-header.tsx` + `project-home.tsx`, `history-list.tsx` | The three open an in-pane view (not a modal).                                                                                                                                                                                                                                                                                                                                                               |
| Chat tabs row: sidebar-toggle icon, tabs with agent icon or spinner and truncated titles, "+" | `chat-tabs.tsx`                                             | The sidebar-toggle icon shows/hides the history column on narrow panes (collapsed by default). Tab states per section 2. Middle-click and Cmd+W (when the pane has focus) close.                                                                                                                                                                                                                            |
| User turn as a bordered card with timestamp                                                   | `user-turn-card.tsx`                                        | Card with the text, a relative timestamp (`lib/relative-time.ts`), and attached-context chips (read-only).                                                                                                                                                                                                                                                                                                  |
| "Ran N commands" group header with spinner/chevron                                            | `timeline-group.tsx`                                        | Groups consecutive tool/thinking rows of one assistant turn. Header text computed: "Ran N commands" for Bash runs; "Read 3 notes", "Edited 2 notes" for other tools; mixed: "Used N tools". Expanded while running, collapsed when the turn finishes.                                                                                                                                                       |
| "Thought for <1s" row (brain icon, expandable)                                                | `thinking-row.tsx`                                          | Duration = UI time from `thinking` `start` to `end` (the CLI does not send thinking text, only token estimates; the expanded view shows "~N tokens" and, if text ever arrives, the text).                                                                                                                                                                                                                   |
| "Ran `command…`" row (terminal icon, status check/spinner, expandable)                        | `tool-row.tsx`                                              | One component with a per-tool renderer registry (`tool-renderers.ts`: Bash, Read, Write, Edit, Grep, Glob, WebFetch, Task, default). Collapsed: icon, short label, truncated primary argument (command, path), status (spinner running, check ok, x error, slash rejected, clock waiting). Expanded: full input in a code block, then output in a code block (capped, "Output truncated" when `truncated`). |
| Final answer as prose                                                                         | `assistant-text.tsx`                                        | Markdown via the existing sanitised renderer (`lib/safe-html.ts`, marked + DOMPurify as the plugin host does), links open through the note-link handler (`[[wikilinks]]` resolve to notes). Streaming with a plain-text tail (section 3.5).                                                                                                                                                                 |
| "Worked for 1m 32s" footer with animated indicator                                            | `turn-footer.tsx`                                           | Elapsed time (live while running, then fixed from `turn-finished.durationMs`), token usage and approximate context fill from `usage`. Animated dots while running; respects `prefers-reduced-motion`.                                                                                                                                                                                                       |
| "Permission required" card above the composer                                                 | `permission-card.tsx`                                       | Section 6.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Composer "Ask anything • @ to add context • / for commands"                                   | `composer.tsx`                                              | A CodeMirror-free `contenteditable`-less design: a `textarea` that auto-grows (max 40% of the pane) plus a chip row; `@` and `/` open `mention-menu.tsx` / `slash-menu.tsx` (popover, reuses `use-popover-dismiss.ts` and `popup-position.ts`).                                                                                                                                                             |
| Action row under the composer (spinner/stop, new chat, history, more)                         | `composer-actions.tsx`                                      | Send/stop toggle, new chat, history, "more" menu (model, permission mode, effort, attach current note, clear queue).                                                                                                                                                                                                                                                                                        |
| Context transparency                                                                          | `context-ledger.tsx`, `context-chips.tsx`                   | Section 5.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Empty state                                                                                   | `empty-state.tsx`                                           | Short description, project picker, the three suggestions are static (no AI).                                                                                                                                                                                                                                                                                                                                |
| Project dialog                                                                                | `new-project-dialog.tsx`                                    | Section 4.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Settings section                                                                              | `components/settings-panel/agent-section.tsx`               | Section 7.                                                                                                                                                                                                                                                                                                                                                                                                  |

State: `src/stores/agent-store.ts` (Zustand; selectors per `docs/zustand.md`), events folded by `src/lib/agent/reduce.ts` (pure reducer `reduceEvent(chat, event) -> chat`, unit-tested against the golden files). Transport: `src/lib/agent/client.ts` (the only module that calls `invoke`/`listen`, typed by `AgentCommandMap`).

### 3.3 Transcript model

The reducer produces, per chat, `turns: Turn[]`; a turn is `{ user: {messageId, text, context, ts}, blocks: Block[], status, startedAt, durationMs? }`; a block is `text | thinking | tool` keyed by `(messageId, blockIndex)` or `toolCallId`. `text-delta` appends to the block's streaming buffer; `text` replaces it. `tool-call-input-delta` accumulates display text until `tool-call-input` replaces it with the parsed value. Duplicated `session-started` events (the CLI repeats `system/init` every turn) are idempotent. Unknown future event types are ignored by the reducer's default branch (the contract is forward compatible).

### 3.4 Tokens and styling

Use the existing CSS variables only (`App.css`): surfaces `--surface-card` (turn card, permission card), `--surface-subtle` (code blocks, chips), `--surface-input` (composer), `--surface-selected`; borders `--border-color`, `--line-subtle`, `--line-subtler`; text `--text-primary/secondary/muted`, icon `--text-icon-muted`; hover/active `--item-hover-bg`, `--item-active-bg`; accent `--accent` for the primary button, focus ring `--focus-border`; fonts `--ui-font` (chrome), `--editor-font` (assistant prose), `--mono-font` (code). Status colours: reuse the existing semantic classes used by the plugin strips; if none exist for warning/error, add `--agent-warn` and `--agent-error` to `App.css` derived with `color-mix` from `--accent` and a fixed red, never raw hex in components. Tailwind v4 utilities per `docs/react-guidelines.md`. Radius and spacing follow `surface-card.tsx`.

### 3.5 Streaming render budget and performance

- The reducer runs on batched events: the client collects events for one animation frame (`requestAnimationFrame`) and dispatches one store update per frame; a turn produces at most 60 renders per second per chat regardless of delta rate.
- Only the last text block of the running turn is "live": it renders as plain pre-wrapped text with a markdown pass at most every 120 ms (leading-edge throttle) and a final full markdown pass on `text`. Finished blocks are memoised by `(blockId, finalText)`.
- Transcripts are windowed after 200 blocks (`@tanstack/virtual` is NOT added; implement with a simple `content-visibility: auto` plus `contain-intrinsic-size` per turn; no new dependency).
- Tool output over 64 KiB is already cut by the mapper; code blocks over 2,000 lines render the first 500 with "Show all".
- No work on the UI thread other than reduce and render: all file, process and index work is in Rust behind `async` commands using `commands::blocking(...)`. The runner reads stdout on a dedicated blocking thread and emits `agent://event` with a bounded channel (capacity 1024); if the UI cannot keep up, `text-delta` events are coalesced by `(messageId, blockIndex)` in the runner before emitting (never drop `text`, `tool-*`, `permission-*`, `turn-finished`).
- Budget: first token render within 50 ms of the event; pane open with a 500-turn chat under 100 ms (lazy parse of the chat note, last 30 turns first).

### 3.6 Keyboard shortcuts

Added to `docs/keyboard-shortcuts.md` in the same change as the implementation (a new "Agent" section; implementation note in an HTML comment). Chosen to avoid the table in `docs/keyboard-shortcuts.md` (Cmd+K is link, Cmd+E inline code, Cmd+B/I, Cmd+N note, Cmd+T tab):

| Shortcut                     | Action                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cmd+Shift+A                  | Toggle the agent pane; when opening, focus the composer                                              |
| Enter / Shift+Enter          | Send / newline                                                                                       |
| Esc                          | In order: close an open menu, clear a queued chip, stop the running turn, return focus to the editor |
| Cmd+Enter                    | Allow once (when a permission card is showing; works from the composer)                              |
| Cmd+Shift+Enter              | Always allow in this project (when offered)                                                          |
| Cmd+Backspace                | Deny once                                                                                            |
| Cmd+Shift+N                  | New chat in the pane (only while the pane has focus; the existing Cmd+N stays "new note")            |
| Cmd+Shift+H                  | Open chat history                                                                                    |
| Cmd+[ / Cmd+]                | Previous / next chat tab (pane focused)                                                              |
| `@`, `/`                     | Open the mention / command menu                                                                      |
| ArrowUp in an empty composer | Recall the previous message                                                                          |

The implementer must verify no native menu accelerator or editor binding collides (`use-keyboard-shortcuts.ts`, Tauri menu in `lib.rs`).

### 3.7 Accessibility

- Pane is `role="complementary"` with `aria-label="Agent"`; tabs are `role="tablist"`/`tab` with arrow-key navigation; the transcript is `role="log"` with `aria-live="polite"` for assistant text only after `text` (final), never per delta; running status is announced once ("Working", "Finished in 1m 32s").
- The permission card is `role="alertdialog"`-like but non-modal: `role="alert"` on appearance (announced immediately), its buttons are reachable by Tab in order Allow once, Always, Deny, Show details; focus is NOT stolen from the composer while the user types, but pressing Tab from the composer reaches the card first (it precedes the composer in DOM order).
- Expand/collapse rows are buttons with `aria-expanded`/`aria-controls`; the spinner has `aria-hidden` with the status in text; icons are labelled by their row text.
- Contrast: only existing tokens; status is never colour alone (icon + text).
- `prefers-reduced-motion`: no spinner/pulse animations, a static "…" instead.
- All actions reachable by keyboard; focus ring uses `--focus-border`.

### 3.8 The `/` menu, skills and `@activenote`

**Sources, merged by name.** The `/` menu and the "Skills (N)" chip (next to the mode chip) list the same items. Precedence project, then vault, then global, then what the CLI reports:

1. Disk skills (`agent_list_skills`, core in `agent/skills.rs`): `.claude/skills/*/SKILL.md` and `.agents/skills/*/SKILL.md` in the project folder and the vault root (`vault_ops::confine`, symlinks resolved and required inside the vault), and **global** skills in exactly `~/.claude/skills` and `~/.agents/skills` (read-only, no other path under the home directory is ever opened, so never settings, credentials or plugins; a global skill may be a symlink but its `SKILL.md` must resolve to a regular file). Only the frontmatter (`name`, `description`, 64 KiB cap) is read; logs carry counts only. Source tags: `project | vault | global | cli-reported` (shown as "from Claude").
2. The CLI's own `system/init` lists, carried on `session-started` (`slashCommands`, plus `skills`: the skill names). They are primary once a chat has a session; they include plugin skills and built-ins (`compact`, `context`, `reload-skills`, ...). A cached copy from the newest session in the window feeds new chats (status unknown).
3. No static built-ins before the first message: none are verified before a session exists.

**Why disk is needed.** The CLI emits `system/init` only after the first user message (verified with 2.1.325: no output at all from a process that received no message), so eager listing is impossible; the disk scan is the pre-session source and the CLI's lists replace it as truth.

**What "loaded" means.** A skill is _loaded_ for a chat when its name is in that session's `init.skills` or `slash_commands`: Claude Code registered it for the session (its body is read on use). A skill that is only on disk is shown as "not loaded" once the chat has a session (for example one added after the session started: `/reload-skills`, or a new chat). Before a session the status is unknown and not shown. Commands have no loaded state.

**Menu behaviour.** It opens when the text is `/` plus a word at the start (leading spaces allowed), never mid-sentence or for a path. Rows show `/name`, a one-line description and the source. Filter: the vault fuzzy ranker (`search-rank.ts`) on the name, then description words. Arrows move, Enter or Tab insert `/name ` and the message is sent as typed. Empty text: "No skills found. Skills live in .claude/skills or .agents/skills." The chip's popover lists source, loaded status, description and "Open SKILL.md" (vault) or "Show in Finder" (global).

**`@activenote`.** The top row of the `@` menu while a note is open (filterable); picking it adds the active note chip, bringing it back if it was removed (and attaching it even when `agent.attach-active-note` is off). Typing `@activenote` verbatim also attaches the active note. `@selection` is not offered yet (no editor selection hook).

### 3.9 Model chip

A chip next to the mode chip shows the chat's model; its menu lists the models enabled in Settings > Agent (`agent.enabled-models`, catalog in `src/lib/agent/model-catalog.ts`), an effort choice (default, low, medium, high, xhigh, max) when the model takes `--effort`, and "Set as default" (writes `agent.model` and `agent.effort`). A chat starts from `agent.model` (empty is "Default": no `--model`). The chip shows the model the CLI reports after each turn (`usage{scope:"turn"}.model`, the `modelUsage` key with the most output tokens) as the truth, with a tooltip when it differs from the request (org default mapping). Arrows, Enter and Esc work in the menu.

Switching is live: `agent_set_model` writes a `set_model` control request (A.2) when the process runs; with no process it only sets the next spawn. A refused request restarts with `--resume --model X` after the turn, as for the permission mode. Effort is a spawn flag, so changing it restarts the same way. The chosen model is saved in the chat note (`writer-chat-model`, else the reported one) and restored when the chat is reopened.

## 4. Projects

(ADR: projects as folders.) A project is a vault folder containing `project.md` and an `AGENTS.md`.

### 4.1 On-disk format

```
<any vault folder>/            e.g. Projects/Client X/  (Copilot's own: copilot/projects/<name>/)
  project.md                   frontmatter below; the body is free notes
  AGENTS.md                    the project's agent instructions (plain markdown, editable like any note)
  sources/                     optional, files dragged in from outside the vault (Copilot's convention; Writer lists, never writes it in v1)
  .chats/                      Writer's chats (section 9), hidden
```

`project.md` frontmatter. Keys are Copilot's (read from behaviour; the shape of values is what Copilot writes):

| Key                                                        | Type                 | Meaning                                                                                                                                       |
| ---------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilot-project-id`                                       | string               | Stable id (Copilot uses a generated id; Writer generates a uuid v4 when it creates one). A folder is a project iff `project.md` has this key. |
| `copilot-project-name`                                     | string               | Display name. Falls back to the folder name.                                                                                                  |
| `copilot-project-description`                              | string               | One-line description.                                                                                                                         |
| `copilot-project-created`, `copilot-project-last-used`     | number (epoch ms)    | Writer updates `last-used` when a chat starts.                                                                                                |
| `copilot-project-archived-at`                              | number (epoch ms)    | Present = archived.                                                                                                                           |
| `copilot-project-inclusions`, `copilot-project-exclusions` | string               | Context sources, comma-separated (see 4.2).                                                                                                   |
| `copilot-project-web-urls`, `copilot-project-youtube-urls` | string               | Newline- or comma-separated URLs (shown, passed by reference only).                                                                           |
| `writer-agent-mode`                                        | string (Writer-only) | Optional per-project permission mode: `manual` (default) or `acceptEdits`. Copilot ignores it.                                                |

Rules: unknown keys are preserved byte-for-byte (writes go through the byte-minimal frontmatter patcher, `index/patch.rs`); a malformed value is surfaced as an "unsupported" row, never fixed silently or dropped; Writer never writes Copilot keys it did not need to change.

### 4.2 Context sources

`inclusions`/`exclusions` entries (split on commas, trimmed) are typed by shape: `#tag` (nested tags included), `[[Note]]` or a path ending in `.md`, `Folder/Path/` (a path that is a folder), `name:value` or `name:*` (property, shape per Copilot; any other string is an `unsupported` source shown as a warning row). Resolution is live and per message: folders by walking the index `files` table, notes by the existing name resolver (`index/resolve.rs`), tags and properties by the index queries behind `index_query_files`. `ProjectSource` (contract) carries the parsed form plus `raw`. A source is a focus aid, not a permission boundary (shown in the UI copy).

### 4.3 How project sources become context: manifest plus on-demand reads (decision)

The agent gets a **manifest**, not bodies: per source, the kind, the label, a count, and up to 20 sample paths; overall capped at 100 entries ("and N more"), with a one-line instruction to resolve tags/properties itself with the `writer` CLI skills already installed (`writer-search`, `writer-bases`) and read notes on demand. Rationale: it is what makes Copilot v4 projects tractable (v3's pre-loading was the source of its cost and staleness pain), it keeps the context ledger honest, and the CLI already has file tools. Optional "pinned source" (inline up to N tokens) is NOT in v1 (open question 3). The manifest is recomputed on every send; when it differs from the one last sent, a diff is prepended to that message and the ledger shows a "sources changed: +3 notes" chip (section 5).

### 4.4 Creating and converting projects

One dialog, `new-project-dialog.tsx` ("New project"), reachable from three places that all call the same function `openNewProjectDialog({ folder?: string })` in `agent-store`:

1. the agent pane header ("New project" button, and the empty state),
2. the command palette ("Agent: New project", `commands.ts` entry),
3. the sidebar folder context menu: "Make project" on any folder (`folder-context-menu.ts`), which opens the same dialog prefilled with that folder and in "convert" mode.

Fields: **Name** (required; becomes the folder name; validated like a new folder), **Location** (default `Projects/`, folder picker; hidden in convert mode), **Description** (optional), **Context sources** (optional: chips; add folder / note / tag via the same pickers as `@`; stored as `inclusions`), **Instructions** (optional multi-line; seeds `AGENTS.md`). Buttons: "Create project" / "Make project".

_New project_ creates the folder, `project.md` (new `copilot-project-id` uuid, name, description, created, last-used, inclusions), and `AGENTS.md`: the user's Instructions if given, else the short template:

```markdown
# <Project name>

Instructions for the agent working in this project. Edit freely.

- Goal:
- Where to put new notes:
- Conventions to follow:
```

then opens the project and a new chat in it. _Make project_ (convert) on an existing folder: writes `project.md` inside it (never overwriting one: if `project.md` exists without `copilot-project-id`, the dialog says so and offers to add the keys without touching the body). It leaves an existing `AGENTS.md` and `CLAUDE.md` untouched; if `AGENTS.md` is absent the dialog shows "Create AGENTS.md" as a checked option (so the user decides) and creates it from the same template. All writes go through `vault_ops.rs` confinement, create files atomically (temp + rename), refuse names with path separators, and are idempotent on retry.

**Lane 3 implementation notes (deviations, all additive).** (1) `agent_make_project` also takes optional `instructions`, `description` and `inclusions`, applied only to what the folder does not already have; convert mode of the dialog uses them. (2) The Tauri commands return `ProjectDetail` = `ProjectInfo` plus `unsupported[]`, `webUrls[]`, `youtubeUrls[]`, `agentMode`, `warnings[]` (a superset on the wire; the shared contract is untouched). (3) Extra commands: `agent_update_project`, `agent_archive_project`, `agent_inspect_folder` (what "Make project" would do to a folder), `agent_project_manifest` (manifest through the window's index, for the project home). `agent_context_preview` is not part of lane 3. (4) A leading `/` in the dialog's Location means "from the vault root". (5) New `project.md` gets a `# Name` heading as its body; a context source cannot contain a comma (the stored form is comma-separated). (6) Unrecognised source shapes (for example `file.pdf`) are kept in the file and listed as "unsupported source" rows; a bare word without an extension is read as a folder.

### 4.5 Working directory and instruction layers

The CLI's cwd is the project folder (vault root when no project). `--add-dir <vault root>` is added for projects so the agent can read other notes without "outside the working directory" prompts (edits still ask in `manual` mode). Instruction layering, in the order the model sees it:

1. Claude Code's own user memory (`~/.claude/CLAUDE.md`), loaded by the CLI.
2. Instruction files from the **vault root down to the project folder**, loaded natively by the CLI (cwd and every parent): in each directory `CLAUDE.md`, and **`AGENTS.md` as a fallback when that directory has no `CLAUDE.md`**. This was verified against claude 2.1.325 (appendix A.6): with only `AGENTS.md` in the cwd or a parent, the CLI follows it; with both files in one directory only `CLAUDE.md` is loaded. Vault level comes first, project last, so the project's instructions win on conflict.
3. Writer's appended block (`--append-system-prompt`), built per spawn by `project_context.rs` (text only, no note bodies): a "shadowed instructions" part (below), then the project header (name, description) and the source manifest (the manifest is also re-sent as a diff per message).

**Decision on AGENTS.md versus CLAUDE.md.** Recommended and chosen: rely on the CLI's native loading and **inject only when an `AGENTS.md` would be ignored**, via `--append-system-prompt`. An `AGENTS.md` is "shadowed" when its directory also holds a `CLAUDE.md` that does not import it (a text search for `@AGENTS.md` in that `CLAUDE.md`), or when the installed CLI is older than 2.1.325 (the version where the fallback was verified; the setting `agent.inject-agents-md` can force `always` or `never`, default `auto`). In `auto`, Writer audits the two directories that matter (vault root, project folder) at spawn time (two `exists` checks and at most one small read) and includes the shadowed files' text under a heading naming each file, vault first, project last, with one sentence "later instructions take precedence". The ledger shows each as "AGENTS.md (injected: shadowed by CLAUDE.md)" or "AGENTS.md (loaded by Claude Code)". Writer **never creates, edits or appends to a `CLAUDE.md`** and never writes the `@AGENTS.md` one-liner: it would be a hidden file written into the user's vault, could not apply when a `CLAUDE.md` already exists (the only case that needs help), and is not needed since the CLI follows `AGENTS.md` itself. The injection is inline text capped at 64 KiB (over it, the file is referenced by path with an instruction to read it) so argv stays small; the transient value is not logged.

### 4.6 Project home, switching, archive

`project-home.tsx` (header "project/context browser" icon) shows: description, `AGENTS.md` (opens as a note), sources with resolved counts and warnings, recent chats of the project, "Archive". Archive sets `copilot-project-archived-at` and hides the project and its chats from pickers (files stay). Opening a chat in a project sets its cwd. The project switcher is the header title (type to filter, "No project" = vault root).

### 4.7 Discovery

_Implemented as a bounded folder walk (`project::list`: visible folders only, depth 10, 20,000 folders, 500 projects, symlinks not followed) rather than an index query, so discovery needs no index handle and works the same in the app, the CLI and tests; the result is the same set (the index skips dot folders too). The spawn-time manifest (`ProjectLibrary`, which the runner calls through `ports.rs` with only the vault root) uses a folder-walk `FsSourceIndex`: folders and notes get counts and samples, tags and properties are listed as "not counted" for the agent to resolve with the `writer` skills. The project home's manifest uses the real index (`Index::query_files`) and counts tags and property names too._

`agent_list_projects` queries the vault index for files named `project.md` whose frontmatter has `copilot-project-id` (the index stores `fm_json`; no new table). No registry file. Copilot's `copilot/projects/*/` appear automatically because they are normal vault folders.

## 5. Context ledger

What the user sees and what is sent. Principle: nothing sticky is invisible; every attached item has a visible chip with its size and a way to remove it.

**Items** (`LedgerItem`, `ContextRef` in the contract):

| Origin               | Default                                               | Mode sent                                                                         | Lifetime                                                        | Notes                                                                                        |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Active note          | on (setting `agent.attach-active-note`)               | path (vault-relative and absolute); "inline" is opt-in per message                | message (re-evaluated each send; a chip shows the current note) | If the note has unsaved edits, Writer saves first (existing save path), then sends the path. |
| Selection            | auto when text is selected in the editor at send time | text with file and line range                                                     | message                                                         | Wins over the full note: the note stays attached as path.                                    |
| `@` mentions         | explicit                                              | notes and folders by path, tags/properties as queries (`ContextRef` tag/property) | message                                                         | Folder mention is a pointer, never "paste all files".                                        |
| Project instructions | auto in a project                                     | `AGENTS.md` handling per 4.5                                                      | chat                                                            | Shown as "AGENTS.md" source row, with the loaded/injected badge. Not removable per message.  |
| Project sources      | auto in a project                                     | manifest (4.3)                                                                    | chat, diffed per message                                        | Row per source with count; "Preview manifest" shows the exact text.                          |
| Vault instructions   | auto                                                  | `AGENTS.md`/`CLAUDE.md` at the vault root, as in 4.5                              | chat                                                            | Shown, not removable.                                                                        |

**UI.** `context-chips.tsx`: a chip row between the transcript and the composer (active note, selection, mentions; project sources collapse to one "Project: 4 sources" chip). Each chip: icon, label, approximate size ("~1.2k tokens"), a menu (open note, "just this message / whole chat", "send content instead of path", remove). `context-ledger.tsx`: a popover from a "Context ~N tokens" button in the composer actions listing every row grouped as **Sent by Writer (exact)**, **Declared to the agent (by reference)**, **After the turn (what the agent actually read)**. The third group is derived from `tool-call-started`/`tool-call-input` events of `Read`, `Grep`, `Glob`, `Edit`, `Write` (path, count), cleared at the next send. "Preview exact text" shows the exact text Writer prepends to the user message and the appended system block.

**Token estimates.** `ceil(chars / 4)` per item, always shown as "~" and never as exact; the total is compared to `contextWindow` from the last `usage{scope:"turn"}` event (default 200,000 until known) with a percentage; after each turn the reported `inputTokens + cacheReadTokens + cacheCreationTokens` replaces the estimate for the chat ("Context used ~N of M"). Items over 8,000 estimated tokens in `inline` mode ask once ("send the note path instead?"). The CLI's own loads (user memory, skills, MCP tool lists) are labelled "by Claude Code, not itemised".

**What Writer sends.** The user message text sent to the CLI is: a small `<writer-context>` block (only when something changed since the last message: active note path, selection, mentions, manifest diff) followed by the user's text; the chat note stores only the user's text and the `ContextRef` list (not the block). The block is plain text, built by `src/lib/agent/context-text.ts` (pure, golden-tested), and is exactly what "Preview exact text" shows.

## 6. Permissions

### 6.1 Modes and defaults

`agent.permission-mode` (default `manual`, "ask before edit"): the CLI's `manual` mode: reads and read-only commands are allowed by the CLI itself without a prompt (verified: `echo`, `touch` in the cwd, reads), writes/edits and other commands prompt. Other choices in the settings and the composer "more" menu: `acceptEdits` ("auto-edit files in the project"), `plan`, `dontAsk`, `auto`. `bypassPermissions` is never offered and `build_args` has no way to emit it. A project may set `writer-agent-mode: acceptEdits` in `project.md`; it applies only when the project's folder is the cwd and shows a persistent "Auto-edit on" chip in the header (a project opts in to more power, so it is visible every time). Changing the mode mid-chat uses `set_permission_mode` (a control request, captured in appendix A.2 (the CLI replies `success`), and the runner falls back to a respawn with `--resume` and the new `--permission-mode` if the CLI answers with an error).

### 6.2 The card

`permission-card.tsx`, pinned above the composer, one at a time (a queue badge "+2 more" when several wait; parallel tool calls produce several requests, seen in the captures).

- Title "Permission required"; body "The agent wants to run Bash: <command, one line, truncated>" or "…to edit `<path>`" / "…to write `<path>`" / "…to use <tool>" (from `permission-request.tool`, `displayName`, `input`, `description`).
- A "Type" line from a tool-kind map: `execute` (Bash), `edit` (Edit, Write, NotebookEdit), `read`, `fetch` (WebFetch, WebSearch), `agent` (Task), `other`.
- `decisionReason` shown under "Show details" ("This command requires approval"), with the full input in a code block (and for Edit/Write the old/new snippet or a content preview capped at 200 lines).
- Buttons: **Allow once** (primary), **Always allow** (a split button), **Deny once**. "Always allow" offers, from the CLI's own `suggestions`: "In this project" (the `addRules` suggestion; the rule text is shown, e.g. `Bash(python3 -c 'print(1)')`), "For this chat" (same rules with destination `session`), and, for Write/Edit when a `setMode` `acceptEdits` suggestion is present, "Auto-edit files this chat". Choices are a pure function of the suggestions the CLI sent; none is invented.
- Answer path: UI -> `agent_permission` -> runner writes the `control_response` (`encode_permission_allow` with `updatedPermissions` from `updated_permissions(suggestions, persist)`, or `encode_permission_deny`) -> emits `permission-resolved{allowed|denied}`. A deny sends a message to the model ("The user denied this action"); the optional free-text "Deny with reason" fills it.
- Stale cards: a `permission-resolved{cancelled}` (CLI's `control_cancel_request`, after an interrupt) removes the card and marks the row "Cancelled".

### 6.3 Where "always" persists (decision)

Decision: **the CLI persists the rule itself into the project-local file `<cwd>/.claude/settings.local.json`**, by Writer answering with `updatedPermissions` (verified, appendix A.5: the file was created with `{"permissions":{"allow":["Bash(python3 -c 'print\\(5\\)')"]}}` and a second turn did not prompt). Writer writes no Claude settings file and uses no home access. Justification:

- It is the CLI's own mechanism and file format, so rules are honoured identically in Writer, in a terminal `claude` run in that folder and by the Copilot agent in the same folder, with no second source of truth to keep in sync.
- It needs none of the existing consented home-file access (`plugin_home_files.rs`, restricted to a plugin that holds a wildcard spawn consent and reading `~/.claude/settings.json`); the native pane does not touch the user-level file at all, so a rule can never widen Claude Code's behaviour in other projects.
- The scope is the project (cwd). Vault-root chats scope to the vault root. "For this chat" uses the CLI's `session` destination and leaves no file.
- The file lives in a hidden folder inside the vault: not indexed, not shown in the sidebar, within `vault_ops.rs` confinement for the Settings screen that lists and removes rules.

Costs: the file is created inside the vault (git users may want it ignored; the settings screen says so and offers "Add `.claude/settings.local.json` to .gitignore" only if a `.gitignore` already exists); user-level rules in `~/.claude/settings.json` still apply (the CLI loads the `user` source) but are not editable from Writer: the settings screen shows a note with the file path. Writer-owned allowlist alternative rejected: it would duplicate the CLI's rule engine (Bash subcommand parsing, path patterns) and drift.

`agent_permission_rules` / `agent_remove_permission_rule` read and edit only `<cwd>/.claude/settings.local.json` through the vault fs (UTF-8, at most 1 MiB, a key-preserving JSON edit of `permissions.allow` and `permissions.deny`, atomic write). `allowedTools`/`disallowedTools` from settings are passed as flags and are separate from the persisted file.

### 6.4 Interaction with the native spawn consent

Two different questions, kept separate: (1) _May Writer start the `claude` program in this vault?_ is the native consent dialog (the same `ConsentStore`/dialog code path as `plugin_proc`, with the pseudo plugin id `writer-agent`, remembered per vault in `plugins_proc_consent.json`; revoking vault trust clears it). (2) _May the agent do this action?_ is the CLI permission system surfaced as the card. A remembered spawn consent never implies tool permissions and vice versa. The spawn consent dialog lists the full argv including `--permission-mode` and `--setting-sources` so a user can see that no bypass flag is used.

## 7. Settings

Section "Agent" in Settings (`agent-section.tsx`), keys in `shared/settings.schema.json` (one contract for Rust and TS; global scope unless noted):

| Key                                              | Type    | Default          | Notes                                                                                                                                                        |
| ------------------------------------------------ | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent.binary-path`                              | string  | "" (auto)        | Override. Validated: absolute, regular file, executable.                                                                                                     |
| `agent.model`                                    | string  | "" (CLI default) | Passed as `--model`; alias or full name; validated against `^[A-Za-z0-9._:\[\]/-]+$`, never starting with `-`. The composer "more" menu changes it per chat. |
| `agent.effort`                                   | list    | ""               | `low                                                                                                                                                         | medium      | high          | xhigh | max`->`--effort`.                                     |
| `agent.permission-mode`                          | list    | `manual`         | `manual                                                                                                                                                      | acceptEdits | plan          | auto  | dontAsk`; "Ask before edit" is the label of `manual`. |
| `agent.allowed-tools` / `agent.disallowed-tools` | list    | []               | CLI permission-rule syntax, e.g. `Bash(git status)`. One per line.                                                                                           |
| `agent.attach-active-note`                       | boolean | true             | Default for the active-note chip.                                                                                                                            |
| `agent.inject-agents-md`                         | list    | `auto`           | `auto                                                                                                                                                        | always      | never` (4.5). |
| `agent.max-concurrent-chats`                     | range   | 4                | 1 to 8; the per-window live process cap (section 8) read from the setting.                                                                                   |
| `agent.pane-width`                               | range   | 320-900, 420     |                                                                                                                                                              |
| `agent.chats-keep-days`                          | number  | 0                | 0 = keep forever; used by "clean up old chats".                                                                                                              |

Plus read-only rows: detected binary path and version with source (`override`, `path`, `login-path`, `known-dir`), "Re-detect", the spawn consent state for this vault with "Revoke", and the permission rules list (6.3).

Settings > Agent layout (same UX class as Copilot's agent settings, on Writer's own settings primitives; `agent-section.tsx`, `agent-models.tsx`, `agent-configure.tsx`):

1. **Backend pills** from the registry `AGENT_BACKENDS` (`lib/agent/backends.ts`: `AgentBackendDescriptor {id, label, glyph, status, detectCommand, modelsSource, installUrl, minVersion}`): OpenCode, Claude (active), Codex, Quick Chat; the three others are disabled "Coming soon" pills with a tooltip. Adding a backend is a registry entry plus a Rust mapper (the Rust `backend` field and `AgentBackendId` stay as they are).
2. **Header card:** glyph, name, status badge and the detected path and version in monospace. Badge from `deriveBackendStatus`: `Ready`, `Not found` (with "Install instructions" and "Locate…"), `Needs sign-in` (only when the detection result carries `authenticated: false`; `agent_detect_binary` does not report sign-in yet, so today this state is unreachable), `Unsupported version` (older than the verified 2.1.325: a warning, not a block), `Could not check`. Detection runs when the section opens and whenever `agent.binary-path` changes; "Re-detect" sits under "Configure". **Configure** is a dialog with the program path override (`agent.binary-path`, "Locate…" file picker) and the saved "Always allow" rules viewer; nothing else (no extra arguments, no environment list: only documented keys).
3. **Default model / Default effort** selects bound to `agent.model` / `agent.effort` ("Agent default" = empty / `default`); the effort select is disabled when the chosen model has no effort levels.
4. **Models catalog:** Claude's models cannot be discovered from stream-json, so `lib/agent/model-catalog.ts` is a static, versioned catalog (`MODEL_CATALOG_VERSION`): aliases `default`, `opus`, `sonnet`, `haiku` and pinned names (`claude-opus-5-5`, `claude-sonnet-5-5` seen in a real init event, `claude-haiku-5-5`, legacy `claude-haiku-4-5`; only the sonnet name is verified). Rows also appear for models the catalog does not know: enabled custom ids ("Add custom model…", validated like `--model`), the current `agent.model` and the active session's init `model`. A switch per row persists `agent.enabled-models` (list; default `default, opus, sonnet, haiku`; `default` is always present). **The composer's model chip lists only enabled models** (plus the chat's current one): wire it with `useEnabledAgentModels({currentModel, sessionModel})` from `hooks/use-enabled-agent-models.ts` (or the pure `enabledModelChoices`), which returns `{id, label, value, supportsEffort}`; `value` is what goes into `AgentSettings.model`.
5. **Auto mode permissions:** explains the permission modes and that `auto` is the CLI's own auto mode (a classifier approves routine actions, risky ones still ask), that Writer never offers a mode that skips permission checks, and edits `agent.permission-mode`, `agent.allowed-tools` and `agent.disallowed-tools` with the shared list editor (a deny rule wins). Remaining keys (`attach-active-note`, `inject-agents-md`, `max-concurrent-chats`, `chats-keep-days`, `pane-width`) follow in "Chats and context".

Implementation notes (lane 4): every `agent.*` key is `scope: global` (a vault's own `.writer/config` cannot choose the program or loosen permissions; a Rust test pins it). `agent.effort` has the explicit option `default` (no `--effort`) because an enum cannot hold an empty option. The section is its own block type (`{type: "agent"}`, category claimed through `AGENT_CATEGORY` like Themes) and renders the schema rows with the shared `SettingControl`. The spawn-consent "Revoke" row needs a command from lane 1 and is not built.

**Binary discovery** (`agent_detect_binary`, Rust, reuses `plugin_env`): (1) the override; (2) `plugin_env::which("claude")` which already searches the process PATH, then the **login-shell PATH** (`login_path()` runs the user's login shell once with markers, 10 s timeout, cached) and known install dirs including `~/.claude/local` and the version-manager bin dirs in `search_dirs`; (3) fail with the list of searched directories. Then `claude --version` with a 5 s timeout (counts toward the process cap, no consent dialog because it is Writer's own fixed command with no vault content; logged). The version is shown and recorded in `session-started`. A CLI older than 2.1.325 gets a one-time warning card ("tested with 2.1.325 and later") but is not blocked, with `agent.inject-agents-md` behaving as `always`.

## 8. Security and lifecycle

- **Confinement.** cwd is the vault root or a project folder canonicalised and verified inside the workspace root (`vault_ops.rs` rules, symlink escapes refused). `--add-dir` only the vault root. Context paths from the UI are re-validated in Rust; `ContextRef` paths outside the vault are refused. No access to `~/.claude` (no reads of transcripts, settings or credentials by Writer; the CLI uses them itself).
- **Spawn consent per vault.** Section 6.4. Untrusted/restricted vaults: the pane is disabled with an explanation. The consent dialog is native and cannot be answered by page code.
- **Flags.** Fixed (`build_args`): `-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompt-tool stdio --permission-mode <mode> --setting-sources user,project,local --session-id|--resume <uuid>` plus validated optionals. Never `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--bare`; user values cannot start with `-`; session ids must be uuids.
- **Environment allow-list.** The child gets the app environment minus anything whose name contains KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL, except the variables the CLI itself needs for auth and routing: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_*`, `AWS_*`/`GOOGLE_*`/`CLOUD_ML_REGION` Bedrock/Vertex settings, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, `HOME`, `USER`, `SHELL`, `LANG`/`LC_*`, `TERM=dumb`, and the login `PATH` (prepended). The filtering function is shared with `plugin_env.rs` (extend, do not fork). Writer's own secrets (the plugin keychain item) are never put in the env. Env var names, not values, are shown in the consent dialog.
- **Never log content.** Rust logs (`log::info!`/`warn!`/`error!` only, `logging.rs` redaction applies): spawn (program, argv with the system-prompt value replaced by its byte length, cwd as project-relative, pid), exit (code/signal), error kinds, counts of events and bytes, durations. Never: user text, assistant text, tool inputs/outputs, note paths beyond the project folder, the permission rule text, the system prompt, env values. The mapper's protocol error carries only a byte count. The frontend logs through `logger` the same way.
- **Process lifecycle.** Reuse `ProcManager` (process groups). One long-lived process per chat tab; at most 4 live agent processes per window (separate from the plugin cap of 8; helper `claude --version` does not count). Killed (SIGTERM then SIGKILL after 3 s, group kill): on window close, vault switch, trust revoke, app exit, tab close, and after 30 minutes of idle per chat (resumed transparently on the next message with `--resume`). A stdout reader and a stderr reader (stderr kept as a 2 KiB ring for error context, never emitted raw) run on blocking threads; stdin writes are serialised through one writer task per chat so JSON lines never interleave.
- **Mapper safety.** Unknown event types are ignored, a non-JSON stdout line becomes a content-free `protocol` error, an unsupported `control_request` gets an error response (`encode_control_error`) so the CLI never hangs, and tool output is capped at 64 KiB.
- **Prompt injection.** Text in notes can steer the agent like any agent. Mitigations are the permission card (default `manual`), visible context, and no auto-edit unless the user opts in per project; the card always shows the real command or path.

## 9. Chat history

(ADR: hidden markdown notes.) Chat notes are markdown files under the project: `<project>/.chats/`, and `<vault>/.writer/chats/` for chats without a project. The folders are hidden, so the vault index (`is_indexable_rel` skips any dot segment), the watcher, the sidebar tree, Quick Open, recents, Bases, FTS and `writer search` never see them, and neither do `rg`-style greps by the agent. The pane lists chats through `agent_list_chats`; "Reveal chat note" opens the file in an editor tab (the editor opens a path under a dot folder when the pane asks for it by absolute vault path; implementation must verify `fs` commands and the tab system accept it, else add an explicit allow in the open-file command for `.chats/`).

**File name.** `YYYY-MM-DD-HHmm-<slug>-<id8>.md` (slug from the title, ASCII, max 40 chars; `id8` = first 8 chars of the chat id so names are unique and sortable). Renames change only the title and (best effort) the slug; identity is the frontmatter id.

**Frontmatter.**

```yaml
writer-chat-id: 5328964b-5fe4-4e06-8843-5cf92bdc9e7c
writer-chat-title: Plan the Q4 review
writer-chat-renamed: true # only after a user rename: saves then keep the title
writer-chat-backend: claude
writer-chat-session-id: 5328964b-5fe4-4e06-8843-5cf92bdc9e7c
writer-chat-project: Demo # name or id, for humans
writer-chat-project-path: Projects/Demo # vault-relative folder; absent = vault chat; decides where the note lives
writer-chat-cli-version: "2.1.325"
writer-chat-model: claude-sonnet-5-5
writer-chat-created: 1796000000000
writer-chat-updated: 1796000500000
writer-chat-turns: 3
writer-chat-pinned: false
writer-chat-archived-at: 1796000600000 # absent when not archived
writer-chat-usage: # block map, written by the pane
  inputTokens: 120
  outputTokens: 45
  costUsd: 0.0123
writer-chat-preview: Summarise the notes tagged #client. # first user message, one line, for search
```

Implemented as `agent/chat_store.rs` (Rust, reads and patches) and `src/lib/agent/chat-note.ts` (TypeScript, writes), pinned by the golden notes in `apps/desktop/tests/fixtures/agent-chat-notes/` (`*.md` plus `*.parsed.json`, read by both test suites; regenerate with `WRITER_UPDATE_GOLDEN=1 vp test tests/agent-chat-note.test.ts`). The pane serialises a whole note and sends it to `agent_save_chat`; Rust keeps what the note's actions own (title after a rename, `pinned`, `archived-at`), patches the existing frontmatter byte-minimally, and writes atomically under one lock.

Unknown properties added by the user are preserved on every write. Titles: the first user message truncated to 60 chars until the user renames (no AI title in v1).

**Body.** One section per message. The header time is UTC (deterministic across machines); the exact time, the message id and how an assistant turn ended live in a `writer:msg` comment:

```markdown
## user · 2026-11-17 09:12

<!-- writer:msg {"id":"m1","at":1796000000000} -->

Summarise the notes tagged #client.

> context: [[Plan]], #client, project sources (4)

## assistant · 2026-11-17 09:13

<!-- writer:msg {"id":"m2","at":1796000060000,"reason":"completed"} -->

Final answer text, markdown.

<!-- writer:tools [{"id":"toolu_1","tool":"Bash","input":{"command":"ls"},"outcome":"ok"}] -->
```

The `context:` quote line records what was attached (paths/tags, never contents). The `writer:tools` comment is a one-line JSON list (tool, input as the JSON when at most 500 characters else a truncated string, outcome; no tool output; `<` and `>` escaped as `\u003c`/`\u003e`) so a reopened chat shows the timeline rows collapsed. A line that would read as structure (`## user ·`, `## assistant ·`, `> context:`, `<!-- writer:`) inside a message is stored with a leading zero-width space (U+200B) and unescaped on read, so the file splits on headers without a Markdown parser. Message text is stored without leading or trailing blank lines. **Bound:** a note never exceeds 1 MiB; the oldest messages are dropped first and counted in `<!-- writer:trimmed {"messages":N} -->` before the first section (a single oversized message is cut and marked `<!-- writer:truncated -->`). A hand-written note without `writer:msg` comments still parses (ids `m1`.., header time).

**Autosave.** After each `turn-finished` and each user send (debounced 500 ms; atomic temp + rename; never while a write is in flight). The file is written by Rust (`agent_save_chat`), not by the editor; if the file is open in an editor tab, the watcher's external-change path reloads it as for any note (hidden folders are not watched, so the pane emits the reload itself through the existing standalone-watch/external-change entry).

**CLI session id mapping and `--resume`.** The chat id is generated by Writer and passed as `--session-id <chat-id>` on the first spawn (verified: the CLI reports exactly that id). The note stores `writer-chat-session-id` separately so a future backend or a forked session can differ. Subsequent spawns use `--resume <session-id>`. The CLI keeps the transcript in its own store (`~/.claude/projects/...`, never read by Writer). Reopen rules: the transcript rendered in the pane comes from the note alone, always. On the next send: spawn with `--resume`; if the CLI reports that the conversation cannot be found (different machine, cleaned transcripts; detect by a `result` with `is_error` and a "No conversation found" style message or an immediate exit before `session-started`, matched loosely and logged by kind only) Writer starts a **new** session id (updates `writer-chat-session-id`, keeps `writer-chat-id`), seeds it with a capped replay (the last N turns of the note's user/assistant text, at most 8,000 estimated tokens, stated as "Resumed from notes" in the transcript and the ledger), and continues. `--fork-session` is used by "Branch from here" (later).

**List arguments (lane 4 additions to the contract).** `agent_list_chats` also takes `all?: boolean` (every project's chats, so the history view can group them) and `query?: string` (every word must occur in the title or the first message; the history view filters client-side with the same rule). `ChatSummary` gains optional `preview`. `projectPath` of a summary comes from the folder the note lives in, not from the frontmatter. Notes are found by chat id: a location cache, then the `-<id8>.md` suffix in the vault's own folder and in every `.chats` found by a bounded walk (hidden folders other than `.chats` and `node_modules` are not entered). "Reveal chat note" needs no backend change: `read_file`/`write_file` authorise any path under the workspace root (`WorkspaceState::authorize_path`, hidden or not, tested) and the editor's `openFile` has no dot-folder gate.

**History view.** `history-list.tsx`: search over titles and the first user message, sort (updated, created), per-project filter, rename, pin, archive, delete (to Trash through the existing trash command), "Copy chat as markdown". `agent.chats-keep-days` drives "clean up".

### Other backends (OpenCode, Codex, Quick Chat): future work

Settings > Agent already shows them as disabled "Coming soon" pills; none is implemented. Notes for whoever builds them (research only, nothing verified in this repo):

- **Shape of the work.** A backend is a registry entry (`lib/agent/backends.ts`) plus a Rust mapper from its wire protocol to `AgentEvent` and encoders for the commands (the same split as `claude_stream.rs`), plus a detect command and a model source. The pane, history and note format stay unchanged; `writer-chat-backend` in the note already records the backend.
- **OpenCode.** Two candidate transports to evaluate: (a) its local server mode, with a session API and an event stream (long-lived process per window, one session per chat); (b) the CLI's non-interactive `run` mode with JSON output, one process per turn, like a resumable `claude -p` without the control channel. Permission prompts and interrupt need the server mode or ACP (Agent Client Protocol, JSON-RPC over stdio), which Copilot's Agent Mode already uses for Codex and OpenCode adapters in this app's plugin host. Prefer ACP if the installed OpenCode speaks it: it is one mapper for several agents. Models come from the program (`opencode models` style listing) rather than a static catalog, so `modelsSource` would be `command`.
- **Codex.** Through an ACP adapter (the plugin host already detects `codex-acp`) or the Codex CLI's JSON event output; sign-in is the user's own `codex login`.
- **Quick Chat.** A no-project, no-tools single-purpose chat (a global hotkey window or a small composer in the pane header) on any available backend; needs a "read-only, no tools" start mode (`--permission-mode plan` or `dontAsk` with no allowed tools) and a lighter history entry. Design before building.
- **Common prerequisites.** A permission model per backend (the card is driven by the CLI's own suggestions today), the spawn consent extended to a per-backend program, `agent.binary-path` per backend (the schema key is Claude's), a mapper test per backend against recorded fixtures and a fake program like `e2e/fixtures/agent-fake-claude`.

## 10. Telemetry and mobile

No telemetry events are added (`docs/telemetry.md` is unchanged); nothing about the pane is sent anywhere by Writer. The only network traffic is the user's own `claude` CLI. Desktop only; no mobile or cloud story. Windows: compile-only like the plugin host (no process groups beyond what `plugin_proc` has).

## 11. Backend interface (Tauri)

All commands `async`, IO through `commands::blocking`, errors `AppError`; none added to `SYNC_ALLOWED` (the `plugin_proc_kill` style sync exceptions are not needed). Types are `AgentCommandMap` in `events.ts` and the serde structs in `events.rs`.

| Command                                                                                   | Args                                                | Returns                                              | Notes                                                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `agent_detect_binary`                                                                     | `{override?}`                                       | `AgentBinaryInfo`                                    | 7.                                                                                                                          |
| `agent_start`                                                                             | `StartSessionRequest`                               | `{chatId, sessionId}`                                | Consent, spawn, returns before `session-started` arrives (emitted as an event). Idempotent per chat.                        |
| `agent_send`                                                                              | `{chatId, messageId, text, context}`                | void                                                 | Builds the `<writer-context>` text, writes the user line. Queues if a turn is running.                                      |
| `agent_cancel`                                                                            | `{chatId}`                                          | void                                                 | Writes `interrupt`; if no `turn-finished` within 5 s, kills the process group and emits `session-ended{killed}`.            |
| `agent_permission`                                                                        | `{chatId, requestId, decision, persist?, message?}` | void                                                 | 6.2. Unknown or already-resolved ids are a no-op error.                                                                     |
| `agent_set_permission_mode`                                                               | `{chatId, mode}`                                    | void                                                 | 6.1.                                                                                                                        |
| `agent_set_model`                                                                         | `{chatId, model\|null, effort\|null}`               | void                                                 | 3.9. Live `set_model`; a changed effort or a refused model restarts with `--resume`.                                        |
| `agent_list_skills`                                                                       | `{projectPath\|null}`                               | `DiskSkill[]`                                        | 3.8. Frontmatter-only scan of the skill folders; vault-confined, global read-only.                                          |
| `agent_close`                                                                             | `{chatId}`                                          | void                                                 | Graceful close (stdin end, then kill after 3 s).                                                                            |
| `agent_snapshot`                                                                          | `{chatId, afterSeq}`                                | `{state, events}`                                    | Ring buffer of the last 2,000 events per chat for window reload and seq gaps.                                               |
| `agent_list_chats`, `agent_load_chat`, `agent_save_chat`, `agent_chat_action`             | see `AgentCommandMap`                               |                                                      | 9.                                                                                                                          |
| `agent_chat_replay`                                                                       | `{chatId, maxTokens?}`                              | `{text, turnsIncluded, turnsTotal, estimatedTokens}` | 9: capped replay text for a new session when the CLI's is gone (added in lane 4; not in `AgentCommandMap` of the contract). |
| `agent_list_projects`, `agent_read_project`, `agent_create_project`, `agent_make_project` |                                                     |                                                      | 4.                                                                                                                          |
| `agent_context_preview`                                                                   | `{projectPath, context, text}`                      | `{items, totalEstimatedTokens, manifest}`            | 5; pure computation over the index.                                                                                         |
| `agent_permission_rules`, `agent_remove_permission_rule`                                  |                                                     |                                                      | 6.3.                                                                                                                        |

**Event.** `agent://event` emitted to the owning window only (`emit_to(label, ...)`), payload `AgentEventEnvelope {chatId, seq, event}`, `seq` per chat from 1. Runner-originated events (not produced by the mapper): `error`, `session-ended`, user-answered `permission-resolved`. The runner emits `session-started` from the CLI's `system/init` (repeated each turn; idempotent).

## 12. Testing

Per the memory rule and [test the agent path with a fake claude](../docs/decisions/2026-11-13-test-the-agent-path-with-a-fake-claude.md): automated tests use a **fake `claude`**; the real CLI is a manual check.

- Unit: `cargo test agent::` (mapper over six real captures, encoders, argv, serde round trips, golden files) and `vp test tests/agent-events.test.ts`; reducer tests replay the golden files through `reduceEvent` and assert the transcript.
- Fake `claude`: `apps/desktop/e2e/fixtures/agent-fake-claude/fake-claude.js` (lane 4). It speaks stream-json on stdio: reads user lines, replays a scenario file (`fixtures/*.jsonl` converted: `//WAIT permission` markers pause until the matching `control_response` arrives on stdin), echoes the `session_id` it was given by `--session-id`/`--resume`, honours `interrupt` (emits the `control_cancel_request` and an aborted `result`), `updatedPermissions` (writes `.claude/settings.local.json` in its cwd like the real CLI), and fails like the real one on a missing `--resume` session. Scenarios: `plain`, `tool-auto`, `permission-allow`, `permission-deny`, `interrupt`, `multi-turn`, `resume-missing`, `crash-mid-turn`, `auth-error`. The existing `copilot-fake-claude` is NOT reused (it emulates Copilot's ACP-adjacent calls), but shares `setup.sh`/`run.sh` conventions and is placed on the e2e PATH the same way (the login-PATH override env used by `plugin_env`).
- E2E (WebDriver harness): open pane, send, see timeline, answer a permission, stop, new project via dialog, "Make project" from the folder menu, reopen a chat after restart.
- Manual real-CLI checklist (maintainer, recorded in `TODOS.md`): signed-in turn, a Bash permission with "Always in this project" then check `.claude/settings.local.json`, interrupt mid-turn, resume after restart, an `AGENTS.md`-only project and a `CLAUDE.md`+`AGENTS.md` project (ledger badges), vault switch kills the process.

## 13. Implementation plan

Four lanes, parallel after one prerequisite already done (the contract: `events.ts`, `events.rs`, `claude_stream.rs`, fixtures, goldens). Nobody edits another lane's files; shared files are touched through the small, named seams below. Do not touch `src/components/**/bases*` or the Bases page kinds (another agent). Order of merge: lanes 1 and 3-Rust can land independently; 2 builds against the contract and a mock client; 4 last for e2e.

### Lane 1: Rust runner (`src-tauri/src/agent/`, `commands/agent.rs`)

Owns: `agent/runner.rs` (process, stdin writer task, stdout/stderr readers, state machine), `agent/session.rs` (registry: chat id -> session, caps, seq counter, 2,000-event ring, idle timer), `agent/binary.rs` (discovery, version probe), `agent/consent.rs` (glue to `plugin_consent::ConsentStore` and the native dialog with plugin id `writer-agent`), `agent/env.rs` (env filter built on `plugin_env`), `commands/agent.rs` (the thin Tauri commands for `agent_detect_binary|start|send|cancel|permission|set_permission_mode|close|snapshot`), `lib.rs` registration (command list, `AppState` field, window-destroy and vault-switch hooks calling `kill_window`/`kill_root` equivalents), `docs/keyboard-shortcuts.md` is NOT owned (lane 2). Allowed shared edits: `plugin_proc.rs` (factor out `prepare`, process-group spawn and `kill` into functions both modules call, behaviour unchanged, tests green), `plugin_env.rs` (export the env filter), `commands/mod.rs` (add `pub mod agent;`).

Interface: consumes `claude_stream::{ClaudeStreamMapper, encode_*, updated_permissions, build_args}` and `events::*` unchanged (change them only by editing the contract with the TS side and regenerating goldens in the same change). Provides the Tauri commands and the `agent://event` emitter (`emit_to(window)`, coalescing of `text-delta`, bounded channel). It also needs, from lane 3, `project::resolve_cwd(root, project_path) -> PathBuf` and `project_context::append_system_prompt(...) -> Option<String>` (trait objects or function pointers injected through `StartSessionRequest` handling; define `agent/ports.rs` with the two traits and let lane 3 implement them).

Rules: every command `async` with `blocking` for IO; reader threads via `spawn_blocking`/`std::thread`; logging per section 8; kill on window destroy, vault switch, trust revoke, app exit; `session-ended`/`error` events produced here; permission round trip: keep `pending: HashMap<request_id, suggestions>`, call `mapper.permission_answered`, write response, emit `permission-resolved`; cancel: `encode_interrupt`, 5 s watchdog; reconnect: up to 2 respawns with `--resume`; unsupported control requests answered with `encode_control_error`. Tests: runner against a fake `claude` shell script in a temp dir (spawn, multi-turn, permission, interrupt, crash, kill on close, orphan check), `commands::tests::sync_commands_are_allowlisted` stays green.

### Lane 2: Frontend state and pane UI (`src/lib/agent/`, `src/stores/agent-store.ts`, `src/components/agent/`)

Owns: `lib/agent/client.ts` (invoke/listen, rAF batching, seq-gap resync via `agent_snapshot`), `lib/agent/reduce.ts` (pure reducer), `lib/agent/transcript.ts` (types), `lib/agent/context-text.ts`, `lib/agent/tool-kinds.ts` (permission "Type" map), `stores/agent-store.ts`, every file in `components/agent/` listed in 3.2 except `new-project-dialog.tsx` (lane 3) and `agent-section.tsx` (lane 4), `hooks/use-agent.ts`, the `AppLayout` dock integration (`components/app-layout.tsx`: render `AgentPane` in the right dock, mutually exclusive with `PluginViewPane`; owned by lane 2, smallest possible diff), `docs/keyboard-shortcuts.md` (Agent section), palette entries "Agent: toggle pane", "Agent: new chat", "Agent: history" in `command-palette/commands.ts` (lane 3 adds "Agent: New project" in the same file; coordinate by adding separate array entries, no reordering), shortcut binding in `use-keyboard-shortcuts.ts`.

Interface: depends only on `events.ts` (`AgentCommandMap`) through `client.ts`; builds against a `MockAgentClient` that replays `shared/agent-golden/*.events.json`, so it needs no backend. Provides `openNewProjectDialog` call sites (lane 3 exports the dialog component and the function signature `openNewProjectDialog(opts?: {folder?: string})` via `agent-store` actions that lane 2 defines and lane 3 fills: lane 2 defines `useAgentStore.getState().openNewProjectDialog` as a stub setting `newProjectDialog: {open, folder}`; lane 3 renders the dialog from that state).

Component tree: `AgentPane > AgentHeader, ChatTabs, (Transcript | ProjectHome | HistoryList | EmptyState), PinnedStack(PermissionCard, QueuedChip, ContextChips), Composer(ComposerActions, MentionMenu, SlashMenu)`; `Transcript > UserTurnCard, TimelineGroup > (ThinkingRow | ToolRow), AssistantText, TurnFooter`. Tests (`tests/agent-*.test.tsx`): reducer over the six goldens (text replaced by final, tool lifecycle, permission and cancel, interrupt, multi-turn), card choice derivation from suggestions, queue behaviour, composer `@`/`/` menus, a11y roles, reduced-motion.

### Lane 3: Projects (`src-tauri/src/agent/project*.rs`, `commands/agent_projects.rs`, `src/lib/agent/project-*.ts`, dialog, menu, palette)

Owns: `agent/project.rs` (Tauri-free: parse `project.md` frontmatter into `ProjectInfo`, source parsing into `ProjectSource`, write via the byte-minimal patcher, create/convert, `AGENTS.md` seeding, discovery over the index, name validation), `agent/project_context.rs` (manifest assembly with caps, shadowed-instructions audit, `append_system_prompt`, diff between manifests, implements the `agent/ports.rs` traits), `commands/agent_projects.rs` (`agent_list_projects|read_project|create_project|make_project|context_preview`), `src/lib/agent/project-*.ts` (source chip parsing for the dialog, `@` pickers adapter), `src/components/agent/new-project-dialog.tsx`, `project-home.tsx`, the sidebar "Make project" entry (`components/sidebar/folder-context-menu.ts`: one entry added to the registry), the palette entry "Agent: New project". Tests: Copilot-shape fixtures written as synthetic text in the test (NOT copied from any vault), round trip with unknown keys, "Make project" leaves `AGENTS.md`/`CLAUDE.md` byte-identical, creation atomicity and name validation, manifest caps and diff, shadow audit matrix (AGENTS only; CLAUDE only; both without import; both with `@AGENTS.md`; old CLI), confinement (symlink escape, `..`).

Interface: pure Rust API (`project::read(root, rel) -> Result<ProjectInfo>`, `project::create(root, req)`, `project::make(root, rel, create_agents_md)`, `project_context::build(root, index, &ProjectInfo, &[ContextRef]) -> ContextBundle{ append_system_prompt, preamble, ledger_items }`) used by lane 1 through `ports.rs` and by lane 2 through the Tauri commands.

### Lane 4: History, settings, fake claude, e2e (`agent/chat_store.rs`, settings, fixtures)

Owns: `agent/chat_store.rs` (Tauri-free: path layout, frontmatter and body serialise/parse, escape rules, atomic write, list with summaries, rename, pin, archive, delete-to-trash, resume decision helper and replay seeding), `commands/agent_chats.rs` (`agent_list_chats|load_chat|save_chat|chat_action|permission_rules|remove_permission_rule`), `src/lib/agent/chat-note.ts` (TS parse/serialise mirror used by the history view and tests), `src/components/agent/history-list.tsx`, `components/settings-panel/agent-section.tsx` and the `agent.*` keys in `shared/settings.schema.json` (+ `settings-sections.ts` entry), the index-exclusion test (`is_indexable_rel` for `.chats`), `apps/desktop/e2e/fixtures/agent-fake-claude/` (script, scenarios generated from `src-tauri/src/agent/fixtures`), `apps/desktop/e2e/specs/agent-*.spec.js`, `tests/agent-chat-note.test.ts`, the `TODOS.md`/`CHANGELOG.md` rows for the release. Chat-store autosave glue in the store is lane 2's call into `agent_save_chat`; lane 4 defines the markdown format and owns round trips.

Interface: `chat_store::{list(root, project_rel, include_archived) -> Vec<ChatSummary>, load(root, chat_id), save(root, &ChatDoc), action(...)}`; the TS `chat-note.ts` must produce and read byte-identical documents (shared golden note fixtures in `tests/fixtures/agent-chat-notes/`). Settings keys flow into `StartSessionRequest.settings` built by lane 2 from the settings store.

### Shared rules for all lanes

Follow `docs/consolidation.md` (one registry for tool renderers, one write path per file kind), `docs/react-guidelines.md`, `docs/zustand.md`, `AGENTS.md` guardrails (`blocking`, no `eprintln!`, never log content); every behaviour change updates this spec, `CHANGELOG.md`, `TODOS.md`; changing the wire contract means editing `events.ts` and `events.rs` together and running `WRITER_UPDATE_GOLDEN=1 cargo test golden` (the golden diff is part of the review); ADRs only for new decisions.

## 14. Open questions

1. Is `Cmd+Shift+A` free in the native menu and acceptable, or does the user prefer another binding? (Chosen to avoid the documented table.)
2. `.chats/` is hidden, so Obsidian Sync users will not sync history. Accept for v1 with the later visible-folder setting, or make the folder visible with an index exclusion now? (ADR chooses hidden.)
3. Pinned sources (inline bodies up to N tokens) are out of v1; revisit after the manifest is used.
4. `set_permission_mode`: captured against claude 2.1.325 (appendix A.2): the CLI accepts it live; the respawn fallback stays for an error reply.
5. Should the project default location be `Projects/` or a user setting? (Default `Projects/`, editable in the dialog.)
6. Reading Copilot's `copilot/projects/*` as projects means two tools write the same `project.md`; confirm Copilot tolerates the `writer-agent-mode` key (unverified; read-only behaviour analysis says unknown keys are preserved for chats, not proven for projects).
7. How the pane should treat a CLI that prints `Warning: ... MCP servers blocked by enterprise policy` on stderr (seen on this machine): currently stderr is never shown; a managed-policy hint row may be useful.

## Appendix A: claude CLI protocol, verified

CLI: `claude --version` printed `2.1.325 (Claude Code)`; captures on macOS 2026-11-17 with a signed-in account, in empty temp directories, trivial prompts. Anonymised fixtures: `src-tauri/src/agent/fixtures/{ok-turn,tool-auto-allowed,permission-allow,permission-deny,interrupt,multi-turn-rule}.jsonl` (stdout lines only; ids, paths, signatures replaced; `commands_changed` and the full tool/skill/plugin lists trimmed). Public docs: <https://code.claude.com/docs> (headless, SDK streaming input/output, permissions). Where this CLI differs from the public docs it is noted.

### A.1 Invocation

```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose \
  --permission-prompt-tool stdio --permission-mode manual --setting-sources user,project,local \
  --session-id <uuid> | --resume <uuid>  [--model m] [--effort e] [--append-system-prompt t] \
  [--allowedTools r...] [--disallowedTools r...] [--add-dir d]
```

`--verbose` is required with `stream-json` output. `--permission-mode` choices in this build: `acceptEdits auto bypassPermissions manual dontAsk plan` (`manual` = the `default` reported in `init.permissionMode`). `--permission-prompts host|none` exists (`host` default: the stdio tool answers). `--session-id <uuid>` was honoured (`init.session_id` equalled it) and `--resume <same id>` restored context ("remember pineapple" -> "Pineapple."). `--setting-sources ""` (empty) loads no setting file. Process stays alive across turns while stdin is open; closing stdin ends it after the current turn (exit 0 after a success result, 1 after an error result). `--append-system-prompt-file <path>` works in this build (not listed in `--help`); Writer uses the inline flag.

### A.2 stdin (one JSON object per line)

User message (verified): `{"type":"user","message":{"role":"user","content":"<text>"}}`. Multi-turn: a second user line sent after the first `result` produced a second turn in the same process.

Interrupt (verified): `{"type":"control_request","request_id":"req_int_1","request":{"subtype":"interrupt"}}`.

Permission answer (verified):
`{"type":"control_response","response":{"subtype":"success","request_id":"<id from the request>","response":{"behavior":"allow","updatedInput":{...input...},"updatedPermissions":[<suggestion with destination>]}}}` or `...,"response":{"behavior":"deny","message":"User denied"}}}`.

Error answer for a request Writer does not implement (the shape is the CLI's own, seen in its reply to an unsupported request, see below): `{"type":"control_response","response":{"subtype":"error","request_id":"<id>","error":"unsupported"}}`.

`set_permission_mode` (captured with claude 2.1.325, lane 1 smoke run in an empty temp dir): request `{"type":"control_request","request_id":"req_mode_1","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}`; the CLI answered on stdout `{"type":"control_response","response":{"subtype":"success","request_id":"req_mode_1","response":{"mode":"acceptEdits"}}}`, so the live change works and the respawn fallback only runs on a `subtype:"error"` reply.

`set_model` (captured with claude 2.1.325 in an empty temp dir, haiku alias, trivial prompt): request `{"type":"control_request","request_id":"r1","request":{"subtype":"set_model","model":"haiku"}}` is answered `{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"model":"claude-haiku-5-5"}}}` (the resolved id); the next assistant message carried `model: claude-haiku-5-5`. A model the org restricts is answered `{"subtype":"error","request_id":"r2","error":"Model \"...\" is restricted by your organization's settings. Using claude-haiku-5-5 instead.","error_code":"restricted_by_org","model":"claude-haiku-5-5"}` (the CLI kept its current model). A request with no `model` is a success that resets to the default (`response.model` is the default's id). The request may be sent before the first user message. Effort has no control request (`--effort` is a flag), so it needs a respawn.

Error control_response (captured): the CLI's own answer to a control request it does not know, `{"type":"control_response","response":{"subtype":"error","request_id":"req_bogus_1","error":"Unsupported control request subtype: writer_bogus_subtype","error_code":"unsupported_request"}}`. Writer sends the same `subtype:"error"` shape (`error` text only) to the CLI's requests it does not implement; the CLI side of that exchange (how it reacts to our error) was not observed.

### A.3 stdout line types seen

`system/init`, `system/status` (`status:"requesting"`), `system/commands_changed` (large; ignored), `system/thinking_tokens` (`estimated_tokens`, `estimated_tokens_delta`), `stream_event` (wraps the Messages API stream), `assistant`, `user`, `rate_limit_event`, `control_request`, `control_cancel_request`, `control_response` (reply to an interrupt), `result`. Every line has `session_id` and (except `control_*`) a `uuid`.

**`system/init`** (repeated at the start of EVERY turn): `cwd`, `session_id`, `tools[]`, `mcp_servers[]`, `model`, `permissionMode` (`default`), `slash_commands[]`, `apiKeySource`, `claude_code_version`, `output_style`, `agents[]`, `skills[]`, `plugins[]`, `capabilities[]`, `memory_paths`, `analytics_disabled`, ... Writer reads `session_id, model, cwd, permissionMode, tools, slash_commands, skills, claude_code_version`. `slash_commands` holds the skills plus the built-ins; `skills` the skill names only. The event appears only after the first user message.

**Partial stream** (with `--include-partial-messages`): `stream_event.event` is one of `message_start` (`message.id`, `message.usage`), `content_block_start` (`index`, `content_block` of type `text`, `thinking` or `tool_use` with empty `input`, `id`, `name`), `content_block_delta` (`text_delta{text}`, `thinking_delta{thinking:"",estimated_tokens}`, `signature_delta`, `input_json_delta{partial_json}`), `content_block_stop`, `message_delta` (`delta.stop_reason` `end_turn|tool_use`, cumulative `usage` incl. `output_tokens`, `cache_*`), `message_stop`. Top-level fields beside `event`: `session_id`, `parent_tool_use_id` (null for the main agent), `uuid`, `api_message_id`, `ttft_ms` (on `message_start`), `thinking_display:"updates"`.

**`assistant`**: one line per completed content block (NOT per message): `message{id, model, content:[<that block>], stop_reason:null, usage}`, `parent_tool_use_id`, `session_id`, `timestamp`; it arrives after the block's last delta and before its `content_block_stop`. Text blocks carry the final `text`; `tool_use` blocks carry the parsed `input` (also in `wire_tool_inputs`); `thinking` blocks carry `thinking:""` and a `signature` (the CLI does not expose thinking text, only token estimates).

**`user`** (tool results): `message.content:[{"type":"tool_result","tool_use_id","content":"hi","is_error":false}]`, plus `tool_use_result` (structured, e.g. `{stdout,stderr,interrupted}` or `{type:"create",filePath,content,...}`; large, ignored by Writer) and `tool_result_meta:[{id, permission_decision:{decision:"accept",source:"config"|"user_temporary"}}]`. A denied or interrupted tool: `is_error:true`, `content:"User denied"` (or the rejection sentence), `tool_result_meta[].non_execution_kind` (`permission-rule` when denied by us, `user-rejected` after an interrupt) and `permission_decision.source:"user_reject"`.

**`control_request`** (permission): `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"python3 -c 'print(1)'","description":"..."},"description":"...","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"python3 -c 'print(1)'"}],"behavior":"allow","destination":"localSettings"}],"decision_reason":"This command requires approval","decision_reason_type":"other","tool_use_id":"toolu_...","server_policy_ask_only":false}}`. For `Write`: `permission_suggestions:[{"type":"setMode","mode":"acceptEdits","destination":"session"}]` and no `decision_reason`. Parallel tool calls produced two requests in one turn (the `assistant` lines for both preceded the first answer).

**`control_cancel_request`**: `{"type":"control_cancel_request","request_id":"<the pending permission id>"}` after an interrupt.

**`rate_limit_event`**: `rate_limit_info{status:"allowed", resetsAt, rateLimitType, overageStatus, ...}`.

**`result`** (ends every turn): `type:"result"`, `subtype` (`success`, `error_during_execution`; documented: `error_max_turns`, `error_max_budget_usd`), `is_error`, `stop_reason`, `terminal_reason` (`completed`, `aborted_tools`), `duration_ms`, `duration_api_ms`, `num_turns`, `result` (final text), `session_id`, `total_cost_usd`, `usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,...}`, `modelUsage{<model>:{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,costUSD,contextWindow,maxOutputTokens,...}}`, `permission_denials[{tool_name,tool_use_id,tool_input}]`, `api_error_status` (on API errors), `errors[]`, `uuid`. The sample reported `contextWindow: 1000000`.

### A.4 Sequences observed

- Plain: `system/init`, `status`, `message_start`, `content_block_start(text)`, `text_delta`, `assistant(text)`, `content_block_stop`, `message_delta`, `message_stop`, `rate_limit_event`, `result`.
- Tool without prompt (`echo hi`): `message_start`, `content_block_start(tool_use)`, `input_json_delta`..., `assistant(tool_use)`, `stop`, `message_delta(tool_use)`, `message_stop`, `user(tool_result)`, a new `status`/`message_start`, `content_block_start(thinking)` (+ `thinking_tokens`), `assistant(thinking)`, `stop`, `content_block_start(text)`, ..., `result`. Read-only commands and `touch` in the cwd needed no permission in `manual` mode.
- Permission (two parallel tools): both `tool_use` blocks stream, then a `control_request` per tool, the `user` tool_result after each answer.
- Deny: `control_response behavior:deny` -> `user(tool_result, is_error, "User denied", non_execution_kind:"permission-rule")` -> the model replies; `result.subtype:"success"` with `permission_denials` filled.
- Interrupt while a permission is pending: stdout `control_cancel_request`, `control_response{subtype:"success",request_id:"req_int_1",response:{still_queued:[]}}`, a `user` tool_result (`is_error`, "The user doesn't want to proceed...", `non_execution_kind:"user-rejected"`), a `user` text "[Request interrupted by user for tool use]", then `result{subtype:"error_during_execution", is_error:true, terminal_reason:"aborted_tools"}`.

### A.5 Persisted "always allow"

Answering with `updatedPermissions:[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"python3 -c 'print(5)'"}],"behavior":"allow","destination":"localSettings"}]` made the CLI write `<cwd>/.claude/settings.local.json` = `{"permissions":{"allow":["Bash(python3 -c 'print\\(5\\)')"]}}`, and the identical command in the next turn of the same process (and, by construction, later processes with `--setting-sources` including `local`) was not prompted.

### A.6 Instruction files

`AGENTS.md`: with `--setting-sources project`, a cwd containing only `AGENTS.md` followed it; a subdirectory cwd followed the parent's `AGENTS.md`; with `--setting-sources ""` it was ignored; with both `CLAUDE.md` and `AGENTS.md` in one directory only `CLAUDE.md` was applied; `CLAUDE.md` containing `@AGENTS.md` pulled it in. With `user,project,local` the parent `AGENTS.md` was followed from a subdirectory.

### A.7 Sign-in state (claude 2.1.325, captured in empty temp dirs; values redacted)

`claude auth --help` lists `login`, `logout`, `status`. `claude auth status [--json|--text]` is local (no network, no browser, no prompt) and returns in about 0.1 s. JSON is the default:

- Signed in, exit 0: `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"<path>","configDirectory":"<path>","loginExpiresAt":"<iso time>","consoleProfileSignInOffered":true,"email":"<email>","orgId":"<id>","orgName":"<name>","subscriptionType":"enterprise","storedClaudeAiLogin":true,"planTier":"other"}`.
- Signed out (an empty `CLAUDE_CONFIG_DIR`), exit 1: `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"<path>","configDirectory":"<path>","loginExpiresAt":null,"consoleProfileSignInOffered":true}`; `--text` prints `Not logged in. Run claude auth login to authenticate.`

`agent_detect_binary` runs `claude auth status --json` (same filtered env, 5 s timeout, 10 s cache per binary) and reads only `loggedIn` (so a non-zero exit still parses), `authMethod` and `subscriptionType`: `authenticated` is `true`/`false` from `loggedIn`, anything unparseable, a timeout or a failure to start is `null` (unknown, never `false`), and `account` is `"<authMethod>, <subscriptionType>"` (for example `claude.ai, enterprise`) when both are short plain labels. Email, organisation, ids, paths and expiry are never read, returned or logged (the log records only whether the state was known and whether signed in).

A signed-out CLI answering a prompt in stream-json mode does not exit with an HTTP status: the turn ends with `result{subtype:"success", is_error:true, terminal_reason:"api_error", api_error_status:null, result:"Not logged in · Please run /login"}` after one synthetic `assistant` line with the same text (zero usage), and the process exits 1 when stdin closes. The mapper classifies that text (`not logged in`, `please run /login`, `invalid api key`) as `error{kind:"auth", retryable:false}`; a 401/403 status is classified by status.

### A.8 Things that would invalidate this spec if they change

The per-block `assistant` lines and their order relative to `content_block_stop`; the `control_request` field names; `updatedPermissions` persistence; `AGENTS.md` fallback loading; `--session-id` semantics; `result.terminal_reason` values. Each is covered by a fixture or a runner test, and the version is recorded in `session-started.cliVersion` and the chat note.
