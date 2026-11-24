---
name: writer-decisions
description: How the Writer maintainer answers design and UX questions, so an agent can decide the way they would when they are away (auto mode, overnight runs), and ask well when they are present. Use before any AskUserQuestion, before choosing between real alternatives in an ADR, and whenever you are about to decide something on the user's behalf.
---

# Deciding like the Writer maintainer

Use this skill when you are about to choose between real alternatives in Writer: product behaviour, UX, storage, protocol, process. It sums up how the maintainer has answered such questions (2026-11 sessions). When they are present, still ask, with the option this skill predicts listed first and marked "(Recommended)". When they are away (they said "full auto mode"), decide with it, record the decision and keep going. The hard limits at the end are never decided alone.

Apply `.agents/skills/engineering-philosophy/SKILL.md` (DRY > SOLID > KISS) first. This skill decides product and UX questions; that one decides code structure.

## How they answer

1. **They take the recommended option** when it is well argued: well over nine answers in ten. So a good recommendation is the job. Make it the option that follows the rules below, with the trade-off stated in one line.
2. **When they pick another option, they want more of the real thing, not less.** Examples:
   - a full models table like OpenCode's (tabs, search, costs, switches) instead of a plain list;
   - parity with the Claude backend "basically the same";
   - real diffs from git for shell changes;
   - signed commits following git's own config.

   If the recommended option is a reduced version of something, offer the complete one, or plan it as a later phase.
3. **They follow up rather than fight.** A refinement after a decision ("also…", "keep in mind…") is an addition to fold in, not a reversal. Update the ADR with a dated note.

## Defaults that predict their answers

- **Use what the user already has, never a copy of it.** Use their CLI logins (`gh`, `fj`, OpenCode's own logins), git's config for signing, `~/.cargo` and Homebrew tools. Read the secret at the moment of use; never store a second copy.
- **"Config decides, the rest suggests."** When a system has an explicit setting (git `commit.gpgsign`), follow it. Signals (signed commits in history, a forge that rejects unsigned pushes) only suggest, in the UI.
- **Fail closed, retry later.** If a step can't be done safely (signing fails, a baseline can't be vouched for), don't do a weaker version: say so and retry or degrade visibly ("listed without a diff", "Signing failed: unlock your key").
- **Automatic over manual.** One action that does every step ("Sign in with Forgejo" sets up the remote, the login, tracking and the first push), with step-by-step progress and a stop at the first failure.
- **Make failures visible in the app.** Show logs where the error is (Settings > Git > Logs, "Show logs" beside errors), with errors in the danger colour and warnings in amber. Keep it redacted.
- **Write as little as possible, and only in Writer's own places.** Never write `.obsidian`, never write another tool's config (`~/.config/opencode`, `.claude` settings files). Put no Writer files in the vault unless the vault is the point (chat notes, memory). Writer's own files go in the app data dir.
- **One owner, clean removal.** Deleting a Writer object deletes what Writer created for it elsewhere (a chat's OpenCode session); archiving keeps it.
- **Shared over per-backend.** One memory (`.writer/memory/`), one pane, one note format, one Changes card for every agent backend.
- **Per item, with a default in Settings.** For example a backend per chat, defaulting to the Settings value.
- **Prefer the fast, predictable path,** and switch off what slows it if the user's environment would. Example: an empty OpenCode global config, because the user's 30 MCP servers stalled the first prompt for over a minute.
- **Experimental upstream APIs are fine** when they buy something concrete. Pin the version and add a contract test.
- **Token and cost economy matter.** Use OpenCode's codemode for MCP tools, cheap models for titles, free models for test runs.
- **Obsidian parity** for anything Obsidian users know (tags as pills, Bases, Excalidraw, file-name links), unless it breaks Writer's rules.
- **Browser-like links everywhere:** middle click and Cmd/Ctrl+click open a background tab.
- **Terse UI.** Short labels, no prose in settings, they/them in text.
- **Release.** Release from CI on a tag, as a draft first, from `writer-computer-agents`. Telemetry is off unless they say otherwise. Ad-hoc macOS signing until Developer ID secrets exist.

## Process they expect

- **Decide the UX with them first**, then write an ADR with the adr-skill, a dated `YYYY-MM-DD-slug.md` in the index, and `node scripts/check-adr.cjs`. Then delegate.
- **Implementation goes to `writer-engineer` sub-agents in worktrees.** Run several in parallel lanes when independent. The lead commits signed, rebases, validates, pushes and lands. Sub-agents never commit.
- **"Don't forget to use the reviewer":** every lane gets an independent `writer-reviewer` before it lands, then a fix pass, then a short verification review of the fix commit.
- **One phase at a time.** Validate and review before the next phase.
- **Real CLIs only in fresh temp dirs** with synthetic data, and fixtures scrubbed. Tests use fakes. Probing scripts are Python, written and run by the agent, kept in the scratchpad.
- **Keep them informed briefly** while they are present: what landed, what is running, what needs them.

## When they are away (auto mode)

- Decide with the rules above. Record each decision where it belongs: an ADR addendum dated today, marked "decided in auto mode, review", or the spec. Also add it to a short morning list in `TODOS.md` under "Up Next" ("Review: …").
- Keep going through the phases: implement, review, fix, land and push. Watch CI.
- At the end: build and restart the app with the build command from memory (they're not using it while away), then stop the keep-awake and signing-probe loops and put the Mac to sleep if they asked for that.

## Never decide alone (wait for them, note it in TODOS)

- A new dependency, crate or npm package.
- Anything outward that is hard to undo:
  - publishing or deleting a release or tag;
  - force-pushing;
  - changing repo secrets or settings, unless they said so for that thing;
  - spending money beyond free tiers or plans they already pay for;
  - contacting a real remote in tests.
- Reading private data: their notes, `~/.claude`, `~/.ssh`, other tools' credential files, the Obsidian app.
- Weakening a rule in this skill, the engineering philosophy, CLAUDE.md or the ADRs.
