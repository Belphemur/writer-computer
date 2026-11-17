---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Projects are vault folders with project.md and AGENTS.md, compatible with Copilot's format

Spec: [`SPECs/native-agent-spec.md`](../../SPECs/native-agent-spec.md) ("Projects"). Related: [build a first-party agent pane](2026-11-17-build-a-first-party-agent-pane-over-the-claude-clis-stream-json-protocol.md).

## Context and Problem Statement

The agent pane needs a unit that carries instructions, context sources and chats. Obsidian Copilot v4 already defines one on disk: a folder `copilot/projects/<name>/` holding `project.md` (frontmatter with `copilot-project-id`, `-name`, `-description`, `-created`, `-last-used`, `-archived-at`, `-inclusions`, `-exclusions`, `-web-urls`, `-youtube-urls`) and an `AGENTS.md` with the instructions. Users who run Copilot in the same vault already have such folders and expect them to work in both tools. What is a Writer project?

## Decision Drivers

- Existing Copilot projects must open in Writer unchanged, and Writer-made projects must open in Copilot.
- Plain files only: no registry, no hidden app data, discoverable by the vault index.
- Creating a project must be one dialog; any existing folder can become one.
- The agent's working directory should be the project folder so it sees the project's `AGENTS.md`.
- Clean-room: the format was read from behaviour (key names), not from Copilot's code or prompts.

## Considered Options

- A folder containing `project.md` (Copilot's keys) plus `AGENTS.md`, anywhere in the vault (chosen).
- Any note carrying a property such as `writer-project: true`.
- Projects kept in hidden app data (per-vault JSON).

## Decision Outcome

Chosen option: the folder form. A project is a vault folder containing `project.md` whose frontmatter uses Copilot's `copilot-project-*` keys verbatim (Writer reads and writes them; unknown keys are preserved byte-for-byte by the frontmatter patcher in `index/patch.rs`; Writer-only keys use the `writer-` prefix, for example `writer-agent-mode`). Instructions live in a sibling `AGENTS.md` (the body of `project.md` is free notes). Context sources are the comma-separated strings in `copilot-project-inclusions` / `-exclusions` (folders, `[[notes]]`, `#tags`, `property:value` entries), plus web URLs, resolved live from the vault index into a manifest, never pre-loaded. Projects are found by scanning the index for files named `project.md` that carry `copilot-project-id`, in any folder (the default creation location is `Projects/`, and Copilot's own `copilot/projects/` is found too). Creating a project (dialog, palette, or "Make project" on a folder) writes `project.md` and, when absent, a seeded `AGENTS.md`; an existing `AGENTS.md` or `CLAUDE.md` is never touched. The CLI's working directory is the project folder.

Instruction layering: the claude CLI 2.1.325 loads `CLAUDE.md` from the working directory and every parent up to the vault root and, verified in a capture, falls back to `AGENTS.md` in a directory that has no `CLAUDE.md`. Writer therefore relies on that native loading (vault level first, project last, so the project wins) and injects an `AGENTS.md` through `--append-system-prompt` only when the audit finds it shadowed by a `CLAUDE.md` in the same directory that does not import it, or the installed CLI is older than the verified version. Writer never creates or edits a `CLAUDE.md`.

### Consequences

- Good, because existing Copilot projects work in both tools and Writer needs no registry.
- Good, because everything is a plain note the user can edit, sync and query (a Base can list projects).
- Good, because no file is written that the user did not ask for.
- Bad, because Writer must tolerate Copilot-specific key shapes and keep them stable if Copilot changes them (a shape check plus fixtures; unknown shapes surface as "unsupported source" rows, not errors).
- Bad, because `AGENTS.md` loading is a CLI behaviour that could change; the audit and version guard exist for that and the ledger shows what is injected.
- Neutral, because Copilot-only fields (web and YouTube URLs) are shown but fetched only if the agent has a tool for it.

## Implementation Plan

- **Affected paths**: `src-tauri/src/agent/project.rs` (read/write/discover, Tauri-free), `commands/agent.rs`, `src/lib/agent/project-*.ts`, `src/components/agent/new-project-dialog.tsx`, sidebar `folder-context-menu.ts`, `components/command-palette/commands.ts`.
- **Patterns to follow**: `vault_ops.rs` confinement; `index/patch.rs` for byte-minimal frontmatter edits; `relocate/` for renames.
- **Patterns to avoid**: pre-loading source bodies; writing `CLAUDE.md`; a separate project registry; reading Copilot's code or prompts.

### Verification

- [ ] Tests parse a synthetic project in Copilot's shape and round-trip it unchanged (unknown keys preserved).
- [ ] "Make project" on a folder with an existing `AGENTS.md` leaves it byte-identical.
- [ ] Manual: a project created by Writer opens in Copilot, and one made by Copilot lists in Writer.

## Pros and Cons of the Options

### Folder with project.md and AGENTS.md

- Good, because it is Copilot's shape, and cwd = project gives natural scoping for instructions, chats and the CLI's local permission rules (`.claude/settings.local.json`).
- Bad, because it constrains the key names.

### Any note with a property

- Good, because any existing note becomes a project.
- Bad, because there is no folder for instructions, outputs or chats, no interop, and cwd would be ambiguous.

### Hidden app data

- Good, because it is invisible and cannot be damaged by editing.
- Bad, because it does not sync with the vault, is invisible to Copilot, other agents and Bases, and breaks "everything is a file".
