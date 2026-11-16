---
title: AGENTS
---

Writer is a Tauri v2 desktop markdown editor: React frontend + Rust backend. It targets writers who use local-first plain-text workflows (Obsidian vaults, docs repos, personal wikis).

## This File

This is an **agent router**: concise context loaded every session. It routes the agent to relevant docs based on task intent. Deep guidelines, system rules, and review rubrics live in linked docs — not here.

## Architecture (Brief)

Stack: Tauri v2 (React + Rust)
Frontend: `apps/desktop/src/` — React, Zustand stores, CodeMirror/Prosemark editor
Backend: `apps/desktop/src-tauri/src/` — Rust IPC commands, file watcher, workspace state
Toolchain: Vite+ (`vp`) — see [docs/vite-plus.md](./docs/vite-plus.md)

Rust source structure:

- `lib.rs` — app setup, plugin registration, command registration
- `state.rs` — global app state (workspace root, name mirror of the index, watcher handle)
- `error.rs` — error types serialized over IPC
- `watcher.rs` — file system watcher with debounce and self-write detection
- `index/` — vault SQLite index (properties, tags, links, headings, tasks; `names.rs` serves file-name search, recents and folder checks from its `files` table); Tauri-free so the `writer` CLI shares it; Tauri wrappers in `commands/index.rs`
- `bases/` — pure Obsidian Bases engine (`.base` model, expression language, query executor); no `tauri` types, see `bases/README.md`
- `cli/` — Obsidian-parity `writer` commands (key=value grammar, command registry, formatters, vault resolution, link rewrite for move/rename); the launcher stays in `writer_cli.rs`; spec: `SPECs/writer-cli-spec.md`
- `managed_skills/` — Writer-managed agent skills (`writer-cli`, `writer-search`, `writer-bases`, sources in `src-tauri/skills/`, compiled in with `include_str!`) installed into every workspace's `.agents/skills/` and `.claude/skills/` on open and startup, versioned by marker and overwritten when stale; Tauri-free, glue in `commands/skills.rs`, CLI `writer skills:sync`, setting `workspace.managed-agent-skills`; changing a skill means bumping `BUNDLE_VERSION` (a test says so); spec: `SPECs/managed-vault-skills-spec.md`
- `vault_ops.rs` — Tauri-free path confinement and the one write path for property edits (frontmatter patcher in `index/patch.rs`), shared by `commands/bases.rs` and `cli/`
- `commands/` — Tauri IPC handlers: `fs.rs`, `workspace.rs`, `search.rs` (`fuzzy_search`, `find_file_by_name`, both read the index), `images.rs`, `bases.rs` (`base_list/read/query/query_text/parse_text/eval/functions`, `note_property*`), `index.rs` (`index_status/query_files/get_metadata/properties/search`)

## Docs Index

All docs except CLAUDE.md, AGENTS.md, TODOS.md, and CHANGELOG.md live in `./docs/`. Feature specs live in `./SPECs/`.

**Workflow**

- [docs/workflows/agent-loop.md](./docs/workflows/agent-loop.md) — repeatable autonomous task execution loop
- [docs/workflows/agent-review.md](./docs/workflows/agent-review.md) — review personas, findings format, quality checklist, escalation rules
- [docs/workflows/worktrees.md](./docs/workflows/worktrees.md) — creating and managing parallel worktrees

**Guidelines**

- [docs/consolidation.md](./docs/consolidation.md) — if adding the next case touches more than one file, the structure is wrong: single source of truth, side-effect ownership, registry over per-case branches, one write path
- [docs/react-guidelines.md](./docs/react-guidelines.md) — imports, state, side effects, component structure, persistence
- [docs/zustand.md](./docs/zustand.md) — side effect timing, selectors, bail-out patterns
- [docs/editor.md](./docs/editor.md) — CodeMirror layout-model APIs, scroll-handler ownership, block-widget patterns (decoration shape, range-select to enter edit mode, posAtDOM boundary handling, button focus race, scrollSnapshot for heightmap shifts)
- [docs/vite-plus.md](./docs/vite-plus.md) — `vp` CLI usage and common pitfalls
- [docs/keyboard-shortcuts.md](./docs/keyboard-shortcuts.md) — canonical shortcut map, also published as the website's shortcuts page (user-facing prose; implementation notes go in HTML comments)

**Infra**

- [docs/releasing.md](./docs/releasing.md) — how to cut a signed, notarized macOS release
- [docs/telemetry.md](./docs/telemetry.md) — opt-in usage telemetry: the full event/property disclosure, the three off-switches, and the rule that adding an event touches the call site, the doc, and the consent dialog together
- [docs/website-deploy.md](./docs/website-deploy.md) — how to deploy the marketing website to Cloudflare Workers, plus its search/AI-crawler surface (JSON-LD, `robots.txt`, `sitemap.xml`, `llms.txt`) and the `/docs/` pages (comparisons under `/docs/compare/`) built from markdown
- [docs/website-analytics.md](./docs/website-analytics.md) — the marketing website's PostHog events, the two build-time env vars, and the rule that a missing key makes the site inert
- [apps/playground/README.md](./apps/playground/README.md) — browser playground that mounts the editor core with the app theme next to a live markdown source view; use it to reproduce, QA and record editor behaviour without building the Tauri app

**Cross-cutting**

- [docs/decisions/README.md](./docs/decisions/README.md) — architecture decision records (ADRs): why the stack, plugin trust model, vault index, Bases engine and CLI are the way they are, ordered by date with status and links to specs
- [TODOS.md](./TODOS.md) — task backlog and work-in-progress tracking
- [CHANGELOG.md](./CHANGELOG.md) — user-visible changes log
- [SPECs/](./SPECs/) — human-written feature and bug specs

## Hard Rules

- Check [`TODOS.md`](./TODOS.md) before starting work to see current tasks.
- Move tasks between sections (Up Next → In Progress → Done) as you work.
- For non-trivial work, create a spec in [`SPECs/`](./SPECs/) and link it from the task.
- Update [`CHANGELOG.md`](./CHANGELOG.md) when completing work.
- Write an ADR in [`docs/decisions/`](./docs/decisions/README.md) for a decision that changes how the system is built or operated, is hard to reverse, affects later contributors, and had real alternatives (new dependency, new architectural pattern, trust or storage model). Use the `adr-skill` (`.agents/skills/adr-skill/`): the filename is `YYYY-MM-DD-<slug>.md` with the decision date (never a sequence number), the `date` front matter matches it, and the index (`docs/decisions/README.md`) is updated in the same change. Link the ADR from the spec or `TODOS.md` item that motivated it, and check consistency with `node .agents/skills/adr-skill/scripts/check_adr.js --dir docs/decisions`. Consult the ADRs before changing an area they govern; supersede an accepted ADR with a new one instead of editing it.
- Load only docs relevant to the current task and scope.
- If a behavior or rule changes in practice, update the owning doc in the same task.
- In autonomous/loop mode, complete exactly one task at a time and commit immediately. Do not batch unless the user explicitly asks.
- When coding or reviewing, follow the Engineering Guardrails below and the guidelines in linked docs.

## Engineering Guardrails

- Prefer the smallest change that is correct, robust, and easy to reason about.
- Avoid fragile logic, hidden coupling, edge-case traps, and assumptions about incidental execution order.
- Keep async flows and shared state race-safe. Use explicit sequencing, cancellation, idempotency, or clear ownership where needed.
- Tauri runs a plain `fn` command on the main thread (the webview event loop). Any command that touches disk, SQLite, a keychain, a process or a lock held across IO must be `async` and do its work through `commands::blocking(...)` (one helper, `commands/mod.rs`); `commands::tests::sync_commands_are_allowlisted` fails on a new non-async command. The plugin host's per-call timing: `localStorage["writer.hostIpcTrace"] = "1"`.
- Do not introduce unnecessary performance regressions. Avoid extra renders, allocations, subscriptions, scans, blocking work, or I/O unless clearly justified.
- Fail explicitly. Surface invalid states and unexpected errors clearly instead of silently swallowing them or masking them with fallback behavior.
- Preserve testability. Keep side effects at the boundaries, make dependencies explicit, and structure logic so it can be exercised in isolation when practical.
- Maintain clear boundaries, but prefer minimal designs. Split functions, hooks, or modules when responsibilities meaningfully diverge, not as a reflex.
- If a tradeoff is unavoidable, call it out explicitly and choose the option with the lowest long-term correctness and maintenance risk.
- When a fix doesn't work after one iteration, add a debug log before changing the approach again. Don't iterate on guesses — let the runtime tell you which term in the math is wrong.

## Validation

Frontend:

- `vp check` — format, lint, and TypeScript type checks
- `vp test` — JavaScript/TypeScript tests

Rust (from `apps/desktop/src-tauri/`):

- `cargo test`
- `cargo clippy`
- `cargo fmt --check`

## Session Wrap

Wrap per [agent-loop.md](./docs/workflows/agent-loop.md). One commit per completed task with a clear message. See the existing commit history for style.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
