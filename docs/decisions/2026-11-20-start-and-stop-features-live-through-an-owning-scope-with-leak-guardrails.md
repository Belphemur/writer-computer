---
status: accepted
date: 2026-11-20
decision-makers: Writer maintainers
---

# Start and stop features live through an owning scope, with leak guardrails

## Context and Problem Statement

A feature's web half registers and unregisters live, but its Rust half is set up once at launch (`features/mod.rs` `start_features`, `run_hooks` only for features on at launch). The audit of 2026-11-20 found the consequences: a feature switched on at runtime or "turned back on" after a crash shows its UI while every `plugin:<id>|*` call fails; a feature switched off keeps running (agent chats and the `agent:event` pump, Obsidian plugin processes and streams whose kill commands are refused once gated, watcher observers, lint and spellcheck engines). The user asked (2026-11-20) that features "can actually be turned on or off properly with unloading and reloading when toggling", with guardrails that prove everything is unloaded.

This changes the "restart to apply" rule of `2026-11-17-build-first-party-features-as-built-in-plugins-...` for the Rust half.

## Decision Drivers

- Off frees CPU fully and the feature's memory (state, engines, caches, processes); on works without a restart.
- Cleanup is structural, not hand-written per feature: a feature cannot own a resource its stop does not release.
- One start path for launch, toggle, crash recovery and safe mode.
- Work in progress is never silently lost.

## Considered Options

- A. Register every feature's command plugin at launch, gated live; a `start`/`stop` lifecycle per toggle; all resources owned by a per-start scope.
- B. Add and remove Tauri plugins at runtime on toggle.

B frees only a command table (compiled code is never unloaded either way), relies on little-used Tauri removal APIs and ACL churn, races with in-flight calls ("command not found"), and still needs A's stop logic for processes and state. **A** chosen with the user.

## Decision Outcome

### Lifecycle

- Every feature's plugin is added at launch; its commands go through the existing live gate (`features::gate`, `is_live`) and answer `FeatureUnavailable` while off, as `obsidian-host` does today.
- The `Feature` trait gains `start(&self, app, scope: &FeatureScope) -> Result<(), String>` and `stop(&self, app)` (optional, for flushing); `setup` folds into `start`. Workspace hooks run for every started feature, including ones started after launch (a started feature receives `on_workspace_open` for every open window).
- A settings change of `features.<id>.enabled` calls `start` or `stop` live; launch, safe mode and crash recovery call the same functions. The web half registers only once the Rust half reports `started` (`features_status` gains `started` ids and a `features:started` / `features:stopped` event), so the UI never appears ahead of its backend.
- CLI and MCP tools, managed skills and the agent prompt's tool list read liveness at use time (the skills of a stopped feature are removed from the vault on the next sync, keeping hand-edited files; see the audit's gap list in `SPECs/builtin-plugins-spec.md`).

### The owning scope (Rust and TypeScript)

Each `start` receives a fresh scope; stop drops it. Every resource a feature holds goes through it:

- Rust `FeatureScope`: `spawn` (threads, with a cancellation token), `process` (child processes in their own process group), `timer`, `observe` (watcher observers), `listen` (app events), `state::<T>()` (the feature's state; replaces long-lived statics and `Lazy` for feature state), `on_stop(f)`.
- Web: the existing `ctx` gains `ctx.listen`, `ctx.setTimeout` / `ctx.setInterval`, `ctx.subscribe(store, fn)`, `ctx.onDispose(f)`; `OwnedRegistry` contributions are already owned.
- Dropping the scope cancels its token, kills each process group (grandchildren too), stops timers, removes observers and listeners, drops state, and joins threads with a bounded wait (5 s), then force-kills what is left.

### Guardrails

1. **No escape hatches**: a source-scan test fails when feature code (`features/*/rust`, `features/*/web`, and Rust modules a feature owns) calls `std::thread::spawn`, `Command::spawn`, `watcher::observe_paths`, `app.listen`, `setInterval`, `setTimeout`, `listen(` or a store `.subscribe(` outside its scope. Exceptions are listed by name with a reason.
2. **Cycle test for every feature**, generic over the registry: start, a smoke action, stop, start, stop; after each stop the scope reports zero live threads, processes, timers, observers, listeners and state handles (weak references to the state are dead). New features are covered automatically.
3. **Runtime check**: a few seconds after a stop, the scope verifies nothing it owned is alive. Debug builds log a warning naming the feature and the resource kind ("agent: 1 process still running after stop"). Release builds force-kill the leftovers, log it, and count a failure strike (three strikes switch the feature off for the session, as crashes do).
4. **What is not unloaded**, stated so nobody expects it: compiled Rust code and JavaScript modules already loaded stay in memory (no CPU, small); a feature never turned on in the session never loads its JavaScript. The Rust allocator may keep freed pages for reuse, so the OS's memory number can drop late.

### Turning off a busy feature (the user, 2026-11-20)

A feature reports "busy" through `scope.busy(reason)` (agent: running chats; git: a sync; obsidian-host: plugin processes). Idle features turn off at once. A busy one asks first:

> Agent has 2 running chats. **Stop now** · **Wait** · Cancel

- **Stop now**: stop as on quit (chats saved as when quitting; nothing lost that quitting would not lose).
- **Wait**: the toggle reads "Turning off after current work…"; the feature stops when it reports idle. If still busy after 60 s, the row offers "Still busy — **Stop now**" (the user can also cancel the wait, which leaves the feature on).
- **Cancel**: nothing changes.

### Recovery

"Turn back on" after a crash restarts the feature live through `start` and clears its strike count. A second crash in the same session switches it off for the session with "Crashed again — restart Writer to retry".

### Consequences

- Good: on and off work live and free the feature's CPU and memory; the audit's gaps 1–3 (half-started features, lingering agent chats, lingering plugin processes) are closed by construction.
- Good: leaks are caught by a test that covers every feature automatically, and by a runtime check.
- Bad: every feature is migrated onto the scope (statics and `Lazy` state, threads, processes, observers); mitigated by doing it feature by feature behind the escape-hatch test's allowlist, which shrinks to empty.
- Bad: all command plugins are added at launch even when off (a few KB each).

## Implementation Plan

- **Affected paths:** `apps/desktop/src-tauri/src/features/{mod.rs,scope.rs (new),recovery.rs,contract_tests.rs}`, `lib.rs` (plugin registration, settings-change hook), `watcher.rs` (observer handles), each `features/*/rust/` (start/stop, state into the scope), `src/lib/features/{builtin.ts,registry.ts,types.ts,health-bridge.ts}` (`ctx` helpers, register after `started`), the Features settings section (busy dialog, wait state, restart-live), `managed_skills/` (remove skills of stopped features), `agent/writer_prompt.rs` (tool list from live commands), `cli/registry.rs` (help from live commands), `SPECs/builtin-plugins-spec.md` (sections 4, 15, 16), `.agents/skills/writer-feature/SKILL.md`.
- **Order:** (1) scope + lifecycle + gate for all features + `started` handshake, with the escape-hatch allowlist holding today's offenders; (2) agent and obsidian-host onto the scope (the lingering cases); (3) the rest of the features, emptying the allowlist; (4) busy dialog and wait; (5) skills, prompt, help liveness.
- **Tests:** the cycle test for every feature; escape-hatch scan; on-at-runtime calls succeed; off at runtime with two fake chats kills both processes; obsidian-host off kills a fake plugin process; busy dialog paths (stop now, wait then idle, wait then 60 s then stop now, cancel); crash → turn back on → works; crash again → off for session.

## Verification

- [ ] Every feature passes the cycle test; the escape-hatch allowlist is empty.
- [ ] In the real app: turning the agent off with chats open asks, stops them, and Writer's CPU and memory drop; turning it back on works without a restart.
- [ ] `cargo test`, `cargo clippy`, `vp check` (0 errors), `vp test` pass.

## More Information

- Related: `2026-11-17-build-first-party-features-as-built-in-plugins-...` (Rust half no longer restart-only), `2026-11-17-contain-feature-failures-...` (strikes, safe mode), `2026-11-20-let-features-cooperate-through-owned-points-...` (points registered through the scope are removed with it).
- The audit of 2026-11-20 (read-only) listed the current gaps; its migration list is the order above.
