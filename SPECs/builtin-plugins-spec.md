# Built-in plugins (first-party feature modules): design spec

Status: **proposed; Step 0 spike done (GO, [report](./builtin-plugins-spike-report.md)); Step 1 infrastructure implemented; Step 2 (pilot `tables`), Step 3 (`Feature` trait, runner; its pilot `mouse-buttons` was removed 2026-11-17, the fixture feature and `agent` exercise the trait) and Step 4 (per-feature plugin, settings fragments, `tauri-specta`, pilot `agent`) and the first Step 5 items (`obsidian-host`, its web code now in the feature folder; `bases`; `projects`, with the agent's web half) done** (section 15 lists what exists; section 16 is failure containment and recovery). Decision record: [`docs/decisions/2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md`](../docs/decisions/2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md) (read it first: it has the touch-point audit, the options A-F, the scoring and the numbered open questions). This spec is the detailed design for the recommended option D. Everything below is a sketch to discuss, not final code; naming is settled (`feature` in code, "built-in plugin" only in design talk, "Features" in the UI). Decisions taken by the maintainers are in the ADR section "Decisions taken"; all eleven questions are resolved (crate split: no; shared types and typed commands and events: `tauri-specta`, decided 2026-11-17 by the user with the rc risk accepted, evidence and maintainer review in the ADR).

Goal: a feature is **one self-contained unit** with a Rust part and a React part, registered in one place. Adding it edits its own folder plus one line in `src-tauri/src/features/mod.rs`; the TypeScript side is auto-collected.

## 1. Vocabulary and boundaries

- **Core**: editor, tabs, sidebar, workspace and window state, settings engine, index, watcher, logging, the Obsidian host's API shim. Not a feature; features depend on core, core never imports a feature.
- **Built-in plugin / feature**: first-party, trusted, in-process code that contributes to core through declared contribution points. Compiled into the app. Switchable (`features.<id>.enabled`).
- **Community plugin**: Obsidian plugin from a vault, untrusted until the vault is trusted, runs through the Obsidian API shim ([trust ADR](../docs/decisions/2026-11-13-trust-vaults-before-running-plugins-no-in-page-sandbox.md)). Unchanged by this spec. A built-in never goes through the shim and the shim never sees built-in registrations except through the same read-only registries (e.g. the palette lists both).
- **Service**: a typed capability a feature offers to core or to another feature (e.g. code files' visibility policy). Declared in the manifest (`provides`), consumed through a registry lookup, so core depends on an interface, not on the feature (dependency inversion).

## 2. Manifest: `features/<id>/feature.json`

Static, language-neutral facts. JSON (not TOML): `serde_json` is already a dependency, Vite imports JSON natively, `toml` would be a new dependency. Behaviour stays in code; the manifest only names things so that docs, tests, ACL and conflict checks can derive from it.

```jsonc
{
  "id": "word-count", // kebab-case, unique, equals the folder name
  "name": "Word count",
  "version": "1.0.0", // bumped when contracts change (events, commands, settings)
  "description": "Live word count in the status bar.",
  "dependsOn": [], // other feature ids; activation and teardown follow the DAG
  "provides": [], // service ids this feature registers
  "enabledByDefault": true, // the kill-switch default (features.<id>.enabled)
  "activation": ["onWorkspaceOpen"], // onStartup | onWorkspaceOpen | onCommand:<id> | onFileKind:<kind> | onView:<id>
  "capabilities": ["read-active-document"], // declarative self-limits, see section 9
  "memory": { "level": "low", "note": "Loads on first status render; no background work." }, // shown in Settings > Features (7.8)
  "rust": {
    "commands": ["word_count_for_text"], // must equal the #[tauri::command] fns in rust/ (contract test)
    "events": ["word-count:changed"], // emitted by Rust, namespaced "<id>:<name>"
    "indexDdl": null, // path to a DDL fragment, or null
    "skills": [], // managed agent skills shipped by this feature
    "cliCommands": [], // names registered in the CLI table (informational, cross-checked)
  },
  "contributes": {
    "settings": "settings.schema.json", // fragment merged into the global schema
    "commands": [
      {
        "id": "word-count.toggle",
        "label": "Toggle Word Count",
        "description": "Command",
        "keybinding": "Mod+Alt+W", // default, optional
        "when": "hasWorkspace",
      },
    ],
    "pageKinds": [], // kind ids, cross-checked with the TS definePageKind
    "docks": [],
    "statusItems": ["word-count.status"],
    "menus": {}, // surface -> item ids, e.g. "editor-body": ["word-count.copy"]
    "menuEvents": [], // native menu events this feature listens to
  },
}
```

The TS and Rust definitions must agree with the manifest; the **contract test** (section 11) fails when they do not. That replaces three hand-kept things today: the exact palette-command list in `tests/command-registry.test.ts`, per-category counts in `config.rs`, and the shortcut table in `docs/keyboard-shortcuts.md`.

**Naming rules** (verified in the spike, enforced by tests):

- Feature id: kebab-case, equals the folder name, the Tauri plugin name and the prefix of every command, setting key and event the feature owns (`FEATURE_ID` in `src/lib/features/id.ts`).
- Events: `<id>:<name>`, **never a dot**. Tauri accepts only alphanumerics, `-`, `/`, `:` and `_` in an event name and rejects the rest (`tauri` `event/event_name.rs`, identical in 2.11.2 and 2.12.5). Command ids use a dot (`word-count.toggle`), events use a colon (`word-count:changed`): never reuse one as the other. `<name>` is limited to letters, digits, `-` and `_`. `src/lib/features/events.ts` throws on anything else and the Rust contract test checks every `rust.events` entry.
- `tauri-specta` convention (decide once, when the dependency lands): with `Builder::plugin_name("<id>")` its commands route as `plugin:<id>|<cmd>` (matches ours) but its events default to `plugin:<id>:<NAME>`. Keep our convention by giving every event an explicit name `<id>:<name>` (preferred, so `rust.events`, `ctx.listen` and the generated bindings agree); if the generated prefix is accepted instead, change `featureEventName` and the manifests in the same commit. Never mix the two.

## 3. Directory layout

Decided (ADR Q10): one physical folder per feature.

```
apps/desktop/features/word-count/
  feature.json            manifest (section 2)
  settings.schema.json    settings fragment (same entry shape as shared/settings.schema.json)
  capability.json         Tauri permissions for this feature's plugin (or generated, section 5.4)
  SPEC.md                 pointer to the spec in SPECs/ (or the spec itself when small)
  skills/<name>/SKILL.md  managed agent skills, if any
  rust/
    mod.rs                `pub struct WordCount; impl Feature for WordCount`
    core.rs               pure logic, no tauri types (testable, CLI-shareable)
    commands.rs           #[tauri::command] fns (thin wrappers over core)
    bindings.rs           tauri-specta collection (commands, events, types) + the test that diffs web/bindings.ts (ADR Q7)
    tests.rs
  web/
    index.ts              export default defineFeature({...})
    bindings.ts           GENERATED by tauri-specta (commands, events, types), committed, never edited, imported only by ipc.ts
    ipc.ts                typed client for the feature's commands and events
    status-item.tsx       React parts; heavy ones imported lazily
    word-count-store.ts   Zustand store, owned by the feature
  tests/
    word-count.test.ts    vp test picks it up (vite.config include glob)
```

Rust mounts the folder with `#[path]` in one file (shape implemented in `src-tauri/src/features/mod.rs`, empty until the first pilot; the `#[path]` mount itself is untested until then, revisit the colocated layout if rust-analyzer or tooling objects) (the only place a folder outside `src/` is named):

```rust
// src-tauri/src/features/mod.rs  (the ONE Rust registration file)
#[path = "../../../features/word-count/rust/mod.rs"]
pub mod word_count;
// one line per feature, in dependency order is NOT required (the registry sorts by dependsOn)
pub static ALL: &[&dyn Feature] = &[&word_count::WordCount /* , &tables::Tables, ... */];
```

Two adjacent lines in one file (the `mod` and the list entry). A `macro_rules!` could collapse them into one, and a `build.rs` scan into zero; both rejected for now (hidden registration, KISS, greppable list). The TS side has zero lines:

```ts
// src/lib/features/registry.ts
const modules = import.meta.glob("../../../features/*/web/index.ts", { eager: true });
// eager only loads the tiny manifest + defineFeature call; heavy parts are lazy imports inside contributions.
```

The colocated alternative (`src/features/<id>/` plus `src-tauri/src/features/<id>/`) was rejected: a feature would be two folders again. If the Step 0 spike shows `#[path]` mounts break tooling, revisit.

## 4. Rust design

### 4.1 The trait

> Implemented in Step 3 as `Feature<R: Runtime>` in `src-tauri/src/features/mod.rs` (the Step 1 `FeatureDef` struct is gone, replaced by the trait, not kept beside it). Differences from the sketch below: generic over the runtime (spike correction: `TauriPlugin<Wry>` cannot run under the mock runtime), so `registry::<R>() -> Vec<&'static dyn Feature<R>>` replaces the `ALL` static (a `static` cannot be generic; the entry is still `&mouse_buttons::MouseButtons` in one list, next to one `#[path]` line); `manifest_source()` returns the `include_str!` and `manifest()` parses it (no `id()`; the id is in the manifest); `tauri_plugin()` returns `Option<TauriPlugin<R>>`; `setup` returns `Result<(), String>` (`AppError` is the IPC error type and has no variant for this); `on_workspace_open` takes `&WindowCtx`. The pure contributions are read through `features::cli_commands()`, `skills()`, `index_ddl()` and `index_schema_suffix()`, which name `Wry` only because a runtime must be named. The sketch below keeps `Wry` for readability.

```rust
// src-tauri/src/features/mod.rs
use tauri::{AppHandle, Wry, plugin::TauriPlugin};

pub struct WindowCtx<'a> { pub label: &'a str, pub root: Option<&'a std::path::Path> }

pub trait Feature: Send + Sync {
    /// Same string as feature.json "id" (contract test).
    fn id(&self) -> &'static str;
    /// Parsed once from `include_str!("../../feature.json")` by the implementor.
    fn manifest(&self) -> &'static Manifest;

    /// Commands live in a per-feature Tauri plugin (section 5). None for features with no commands.
    fn tauri_plugin(&self) -> Option<TauriPlugin<Wry>> { None }

    /// Once, at app setup, after settings exist. Register managed state, spawn services.
    /// An `Err` or a panic is caught by the runner: the feature is disabled and logged.
    fn setup(&self, _app: &AppHandle) -> Result<(), AppError> { Ok(()) }
    /// A window now has a workspace root (open or switch). Replaces ad hoc calls such as the
    /// sync of managed skills and index start in commands/workspace.rs.
    fn on_workspace_open(&self, _app: &AppHandle, _w: WindowCtx) {}
    /// Window destroyed or workspace closed. Replaces `stop_window_work` / `index::stop_window` in lib.rs L107-111.
    fn on_workspace_close(&self, _app: &AppHandle, _label: &str) {}
    /// RunEvent::Exit. Replaces `ProcManager::kill_all` / `AgentSessions::kill_all` (lib.rs L774-778).
    fn on_exit(&self, _app: &AppHandle) {}

    // Pure contributions (no tauri types), also used by the CLI path:
    fn cli_commands(&self) -> &'static [CommandSpec] { &[] }          // cli/registry.rs concatenates
    fn skills(&self) -> &'static [BundledSkill] { &[] }               // managed_skills SKILLS concatenates
    fn index_ddl(&self) -> Option<&'static str> { None }              // index/schema.rs appends
}
```

Rules:

- Default no-op methods keep a TS-only feature at zero Rust lines (no `rust/` folder, no entry in `ALL`).
- Pure cores (`bases/`, `index/`, `managed_skills/`, `relocate/`, `code_files.rs`) stay Tauri-free and are **not** moved into features in the first waves; a feature's `rust/mod.rs` is the glue that owns the Tauri-facing parts (state, commands, hooks). When a feature moves, its pure module moves into `rust/core.rs` only if nothing else imports it (otherwise it stays in core and the feature depends on it).
- `cli_commands`, `skills`, `index_ddl` replace the three leaf registries' hand-listed arrays by `ALL.iter().flat_map(...)`: the existing tables (`COMMANDS`, `SKILLS`, `schema.rs`) keep being the single place that **runs** them; only where entries come from changes. `BUNDLE_VERSION` bump rule stays (a test already enforces it).
- Index migrations: the index is a rebuildable cache (`SCHEMA_VERSION` mismatch triggers a rebuild). `SCHEMA_VERSION` becomes a hash of the core DDL plus every enabled feature's DDL and its manifest `version`, so a feature adding a table is one change in its folder.
- Error isolation: the runner wraps `setup` and each hook in `std::panic::catch_unwind` (the release profile has `panic = "abort"`, so the isolation for panics is **only** effective in dev/test; release relied on `Result` plus keeping risky native code behind explicit flags). **Superseded by section 16: the release profile now unwinds and every boundary goes through `features::guard`.** Implemented (Step 3): `guard` in `features/mod.rs` turns an `Err` (works in release) or a panic (dev and test only) from `setup`, the plugin add and every hook into one `log::error!`; a feature whose `setup` or plugin failed is not in the `Running` list, so it gets no hook and no plugin. The index schema version is `SCHEMA_VERSION` plus `features::index_schema_suffix()`: empty while no feature has DDL (existing indexes do not rebuild), else an FNV-1a hash of each DDL feature's id, manifest `version` and DDL, over every registered feature whatever its toggle.

### 4.2 Runner in `lib.rs`

```rust
// features/runner.rs, called from lib.rs
pub fn enabled(app: &AppHandle) -> Vec<&'static dyn Feature>;   // settings + env + dependsOn topological order
pub fn setup_all(app: &AppHandle) {
    for f in enabled(app) {
        guard(f.id(), "setup", || f.setup(app));
        if let Some(p) = f.tauri_plugin() { guard(f.id(), "plugin", || app.plugin(p)); } // runtime add, as the updater does (lib.rs L604)
    }
}
// window destroyed / workspace open / exit: same loop over the same list, one site each.
```

`lib.rs` then has one `features::install(app, settings)` in `setup` (replaces `runner::setup_all`; it runs `setup`, then adds the plugin), one `features::workspace_close` in `attach_window_handlers` (`WindowEvent::Destroyed`) and one `features::exit` in the `RunEvent::Exit` arm; `commands/workspace.rs` calls `features::workspace_open` after the workspace bootstrap is spawned. The runner lives in `features/mod.rs`, not a separate `runner.rs`. Order is the registry order (`dependsOn` ordering is still deferred); teardown is reversed.

## 5. Tauri commands: three ways to compose, judged

`generate_handler!` is a compile-time proc macro; an `invoke_handler` is set once per `Builder`. It cannot be composed at runtime.

| Option                                                                                                             | Typed args, `State`, `Window` injection | ACL                                                                         | Cost                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Central `generate_handler!` (today)                                                                             | yes                                     | none for app commands (no `AppManifest`)                                    | every feature edits `lib.rs` (45 lines for the agent); no kill switch                                 |
| 2. One dispatcher `feature_invoke(feature, command, args: Value)`                                                  | no: hand-rolled deserialisation         | one permission for everything                                               | re-implements Tauri's dispatch, loses `State`/`Window` extraction and static checks. **Rejected.**    |
| 3. **Per-feature `tauri::plugin::Builder` + `tauri_build::InlinedPlugin`** (idiomatic Tauri v2, no separate crate) | yes                                     | per-feature permissions `<id>:allow-<cmd>`, capability lists `<id>:default` | calls become `plugin:<id>\|<cmd>`; manifest command list feeds `build.rs`; spike needed (section 5.4) |

### 5.1 Per-feature plugin

```rust
// features/word-count/rust/mod.rs
pub struct WordCount;
impl Feature for WordCount {
    fn id(&self) -> &'static str { "word-count" }
    fn manifest(&self) -> &'static Manifest { manifest!("../../feature.json") /* include_str! + parse once */ }
    fn tauri_plugin<R: Runtime>(&self) -> Option<TauriPlugin<R>> {   // generic over the runtime (spike correction 1)
        Some(tauri::plugin::Builder::new("word-count")
            .invoke_handler(tauri::generate_handler![commands::word_count_for_text])
            .build())
    }
}
```

### 5.2 `build.rs` (permissions from the manifest, DRY)

Implemented (about 25 lines, `serde_json` as a build-dependency, ADR-approved): `build.rs` scans `apps/desktop/features/*/feature.json` and registers one `tauri_build::InlinedPlugin` per manifest (`id`, `rust.commands`, `DefaultPermissionRule::AllowAllCommands`), then calls `tauri_build::try_build`. Permissions are named `<id>:allow-<command>` with the command kebab-cased (`word_count_for_text` is `allow-word-count-for-text`) plus `<id>:default`. `cargo::rerun-if-changed` covers the folder and each manifest. With no feature folder it changes nothing. It contains no capability code (section 5.3).

Contract test (mandatory, implemented as plain Rust in `src-tauri/src/features/contract_tests.rs`): for each registered feature, the manifest's `rust.commands` equals the set of `#[tauri::command]` fns under `features/<id>/rust/`, and the plugin name equals the id. Why mandatory: a manifest command missing from the handler list is not a compile error (it is "not found" at runtime) and a handler command missing from the manifest is "not allowed" at runtime. `sync_commands_are_allowlisted` now also scans `../features` (done: one loop over two roots).

### 5.3 Capabilities (resolved)

Today `capabilities/default.json` grants `core:default`, opener, dialog, clipboard, store to windows `main` and `w-*`; it needs no edit. A feature plugin needs `"<id>:default"` in a capability, and plugin commands are always ACL-checked, so without one the call is rejected. Each feature ships `src-tauri/capabilities/features/<id>.json` (identifier `feature-<id>`, windows exactly `["main", "w-*"]`, permissions `["<id>:default"]`). **No `build.rs` code**: tauri-build's default pattern `./capabilities/**/*` includes every `.json` or `.toml` below `capabilities/` (read in `tauri-build` 2.7.4 `acl.rs` and checked with a probe file on this repo: it appeared in `gen/schemas/capabilities.json` and vanished when removed). Correction from the spike: `Attributes::capabilities_path_pattern` takes exactly ONE glob and replaces the default (it would drop `default.json`), so "several folders" (the former option (a)) is impossible; a pattern change or a `build.rs` copy-merge is only needed if a capability must live inside `features/<id>/`, which is not worth it. The contract test checks that the file exists, names the right identifier and windows, and grants `<id>:default` or every `<id>:allow-<command>`. Never grant a window set other than `main`/`w-*`.

### 5.4 Spike that decides this (Step 0, done: GO)

Results are in the [spike report](./builtin-plugins-spike-report.md) and the ADR section "Spike result": (i) one capability glob only, the default glob is enough; (ii) a plugin added by `app.plugin()` inside `setup` resolves its inlined ACL; (iii) `Channel` arguments are still untested (listed for Step 4). `generate_context!` can expand once per crate, so the mock-runtime test needs one shared `pub(crate) fn context<R: Runtime>() -> tauri::Context<R>` in `lib.rs`; it arrives with that test (pending the user's go on the `tauri` `test` dev-feature) and is not needed before. The original text follows.

Verified in source: plugin commands are ACL-checked and rejected without ACL (`tauri-2.12.5/src/webview/mod.rs` ~L2078); `InlinedPlugin` exists (`tauri-build-2.7.4`). Unverified: (i) the capability pattern for multiple folders; (ii) a plugin added by `app.plugin()` inside `setup` still resolving its inlined ACL (should, ACL is generated at build time); (iii) the frontend `invoke("plugin:word-count|word_count_for_text")` path with `Channel` args (agent streaming uses events, not channels today; check). Fallback if (i)-(iii) fail: keep option 1 (central handler) and still use the trait for everything else.

## 6. TypeScript design

### 6.1 Types

> Implemented in Step 1 (`src/lib/features/types.ts`, `registry.ts`): `defineFeature({ id, activate, deactivate, contributes })` with `contributes.commands` and `contributes.keybindings` hosted (palette registry and keybinding registry); `settingsBlocks` is accepted by the type but `defineFeature` throws "has no host yet" until its registry lands with the first pilot that needs it (docks, sidebar panels, sidebar actions, status items, menus and settings sections have hosts: section 6.5). The manifest is not a field of the definition yet: the id equals `feature.json`'s and the contract tests tie them. The sketch below is the target shape.

```ts
// src/lib/features/types.ts
import type manifestSchema from "../../../features/_schema"; // generated or hand type, see contract test
export interface FeatureManifest {
  id: string;
  name: string;
  version: string;
  dependsOn: string[] /* ... as section 2 */;
}

export type ActivationEvent =
  | "onStartup"
  | "onWorkspaceOpen"
  | `onCommand:${string}`
  | `onFileKind:${string}`
  | `onView:${string}`;

export interface FeatureContext {
  readonly id: string;
  readonly settings: { get<T>(key: string): T; subscribe(key: string, fn: () => void): Dispose };
  readonly workspace: {
    root(): string | null;
    onChange(fn: (root: string | null) => void): Dispose;
  };
  readonly ipc: <C extends string>(command: C, args?: object) => Promise<unknown>; // typed per feature in ipc.ts
  readonly events: { listen<T>(name: string, fn: (p: T) => void): Dispose }; // auto-namespaced "<id>:<name>"
  readonly services: ServiceRegistry; // provide / require
  readonly log: typeof logger; // src/lib/logger.ts
  readonly disposables: DisposableStore; // everything registered is torn down on deactivate
}

export interface Contributions {
  commands?: CommandContribution[]; // -> palette registry (BUILTIN_COMMANDS source)
  keybindings?: KeybindingContribution[]; // -> new keybinding registry
  settingsBlocks?: Record<string, ComponentType>; // -> settings-blocks.tsx renderer table
  pageKinds?: PageKindContribution[]; // -> page-kinds registry (behavior) + views registry (React body)
  docks?: DockContribution[]; // -> new dock registry replacing app-layout ternaries
  sidebar?: SidebarContribution[]; // sections and file-tree badges
  menus?: Partial<Record<MenuSurface, MenuItemContribution[]>>; // file, folder, tab, editor-body, footer, sidebar-surface
  editorExtensions?: EditorExtensionContribution[]; // -> createEditorExtensions
  statusItems?: StatusItemContribution[]; // -> document footer / status strip
  menuEvents?: Record<string, () => void>; // -> MENU_EVENT_HANDLERS
  stores?: StoreContribution[]; // reset/persist hooks on workspace change
}

export interface FeatureDefinition {
  manifest: FeatureManifest; // `import manifest from "../feature.json"`
  contributes?: Contributions; // static, cheap, light imports only
  /** Runs when an activation event fires. May dynamic-import heavy modules. Return a Dispose or nothing. */
  activate?(ctx: FeatureContext): void | Dispose | Promise<void | Dispose>;
  deactivate?(): void; // rarely needed: ctx.disposables covers it
}
export const defineFeature = <T extends FeatureDefinition>(def: T): T => def;
```

Lazy contributions, so a heavy feature costs nothing until needed:

```ts
editorExtensions: [{ id: "tables", when: "always", load: () => import("./table-extension").then(m => m.tableExtension()) }],
pageKinds: [{ kind: "base", load: () => import("./base-kind"), view: () => import("./base-view") }],
docks: [{ id: "agent", side: "right", priority: 20, load: () => import("./agent-pane") }],
```

### 6.2 Contribution points and the registry each feeds

| Point             | Today (audit row)                                 | After                                                                                                                                   |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| commands          | `BUILTIN_COMMANDS` spreads (11)                   | registry fed by contributions; `when` is a named predicate over a narrow `FeatureContext`/core ports, not `CommandContext`              |
| keybindings       | `use-keyboard-shortcuts.ts` `if` chain (12)       | **new** keybinding registry: `Mod+Shift+A` -> command id, `when`, focus rules (`isEditableTargetFocused`) in one dispatcher             |
| settings          | one schema file, section list, block renderer (9) | fragment merged (section 7); section entry + block renderer from the contribution                                                       |
| page kinds        | `kinds` array + `Location` union (10)             | `definePageKind` unchanged; the union opens by declaration merging (`interface LocationMap`), views by `load`                           |
| docks             | `app-layout.tsx` (13)                             | **new** dock registry (side, priority, width setting, mutually exclusive groups); the "agent over plugin pane" ternary becomes priority |
| menus             | six builders (14)                                 | each surface builder appends `contributes.menus[surface]` items, ordered by `group` and `order`                                         |
| editor extensions | `createEditorExtensions` list (15)                | **new** extension registry with lazy `load` and a Compartment per contribution so enable/disable is live                                |
| status items      | plugin-only registry (17)                         | the existing `OwnedRegistry<StatusBarItem>` shape, shared by built-ins                                                                  |
| menu events       | `MENU_EVENT_HANDLERS` (5)                         | merged from contributions                                                                                                               |
| Tauri events      | one hook per feature (6)                          | `ctx.events.listen`, disposed with the feature                                                                                          |
| stores            | ad hoc (16)                                       | `stores: [{ store, onWorkspaceChange: "reset" \| fn, persist }]`; replaces literal resets in `workspace-store.ts`                       |

Every registration goes through one `FeatureHost.register(featureId, point, entry)` that records the owner (like `OwnedRegistry`), so deactivating a feature removes exactly its entries. This is the same teardown model the Obsidian host already uses; reuse the `OwnedRegistry` class (move it from `lib/obsidian-host/api/core.ts` to `src/lib/owned-registry.ts` when first needed, an extraction not a copy).

### 6.3 Lifecycle

```
 app start
    |
    v
 import.meta.glob (eager, manifest + defineFeature only)  -- cheap
    |
    v
 resolve: filter by features.<id>.enabled and WRITER_DISABLE_FEATURES; topo-sort by dependsOn;
          unknown dependency or cycle => both ends disabled + logged
    |
    v
 register static `contributes` (commands, keybindings, menus, docks, page kinds, status items)
    |                                        (lazy `load` thunks are stored, not called)
    +--- onStartup ------------------------------------> activate()
    |
 workspace opens (workspace store root changes)
    +--- onWorkspaceOpen ------------------------------> activate()      Rust: Feature::on_workspace_open
    |
 user runs a command / opens a file kind / shows a view
    +--- onCommand:<id> | onFileKind:<kind> | onView:<id> -> activate()  (first time only; idempotent, concurrent calls share one promise)
    |
 activate():  try { dispose = await def.activate(ctx) } catch (e) { log; mark FAILED; remove all entries owned by id; toast once }
    |
 workspace changes / closes ----------------------------> stores.onWorkspaceChange hooks run; Rust on_workspace_close
    |
 user disables feature in Settings (features.<id>.enabled=false)
    +--> deactivate(): disposables.dispose() in reverse order; registries drop owner entries   (Rust part: effective after restart)
    |
 app exit ----------------------------------------------> Rust Feature::on_exit (reverse topo order)
```

States: `registered -> activating -> active -> deactivating -> inactive`, plus `failed` (terminal for the session, shown in Settings > Features with the logged error).

### 6.4 Typed IPC and shared types

```ts
// features/word-count/web/ipc.ts  (wraps the generated `bindings.ts`, hand-written, one file per feature; features import only this wrapper, never the generated runtime)
import { featureInvoke } from "@/lib/features/ipc";
export interface WordCountCommands {
  word_count_for_text: { args: { text: string }; result: number };
}
export const wordCount = featureInvoke<WordCountCommands>("word-count"); // wraps invoke(`plugin:word-count|${cmd}`)
export const countText = (text: string) => wordCount("word_count_for_text", { text });
```

Rust/TS types (ADR Q7, decided 2026-11-17): **`tauri-specta`** (with `specta` and `specta-typescript`) generates the TypeScript for commands, events and types, adopted per feature as features migrate, starting with pilot `agent`. Each command carries `#[specta::specta]`; each feature has `rust/bindings.rs` collecting its commands, events and types and a test that regenerates `features/<id>/web/bindings.ts` and fails on a diff (`WRITER_UPDATE_BINDINGS=1 cargo test bindings` rewrites it, mirroring `WRITER_UPDATE_GOLDEN=1`). The exporter is configured once: one global bigint-to-number cast (u64 fields are counters, durations and timestamps below 2^53; anything larger is a `String`, enforced by a guard test), `#[specta(type = Unknown)]` where a field is free-form `serde_json::Value`, and `disable_serde_phases()`. The wrapper `ipc.ts` (`featureInvoke`, `ctx.events.listen`) is the only importer of the generated runtime, so features stay decoupled from it and a fallback to `ts-rs` types only stays cheap. The generated event name (`plugin:agent:agent-event-envelope`) differs from today's `agent://event`: an override or a one-time rename is an open implementation detail. Goldens stay for behaviour (stream mapper), not for shapes. Dependencies (exact pins, reviewed lockfile diff on every bump): `tauri-specta =2.0.0-rc.29`, `specta =2.0.0-rc.28`, `specta-typescript =0.0.15`; the user approved the direction, the `Cargo.toml` edit still needs his explicit go at implementation time. Risk, mitigations and the revisit and exit triggers (no release for 12 months, Tauri 3 migration, advisory, two consecutive rc bumps breaking the build; fallback `ts-rs`) are in the ADR, with the review in [`typegen-maintainer-review.md`](typegen-maintainer-review.md).

## 6.5 Contribution points: the one table

Every way a feature adds to core, as implemented. Web registrations are `defineFeature({ id, contributes })` (`src/lib/features/registry.ts`); each goes into one `OwnedRegistry` keyed by owner `builtin:<id>`, so **kill-switch behaviour is the same for all web points**: the loader (`builtin.ts`) registers the feature while `features.<id>.enabled` is on and not off for the session, and `unregister` (switched off, safe mode, third failure, `features:failed`) deactivates it and removes every entry at once. Every contributed `id` starts with `<feature id>.` (`defineFeature` throws; the Rust contract test checks the id lists of the manifest, `tests/features-contract.test.ts` ties each list to the definition). Contributed UI renders through `FeaturePane` (lazy, inside `FeatureBoundary`: a render error is a placeholder plus a health strike); a throwing menu item, action, command or extension load is logged, counted and skipped.

| Point                              | `feature.json` key                                                                            | Registration (`contributes.*`)                                                                                                                                                                                             | Registry / host                                                                                                                                                     | Kill switch                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Palette commands                   | `commands: [{ id, label, description, when }]`                                                | `commands: [{ id, label, when, run(ctx, feature) }]`                                                                                                                                                                       | `lib/features/palette.ts`, read by `command-palette/commands.ts`                                                                                                    | entries removed; the first run activates the feature                                               |
| Keybindings                        | `keybindings: [{ id, keys, ... }]`                                                            | `keybindings: [{ id, keys, description, run(feature, e) }]`                                                                                                                                                                | `lib/keybindings/registry.ts` (conflict-checked, all-or-nothing)                                                                                                    | owner's bindings removed                                                                           |
| Editor extensions                  | none                                                                                          | `editorExtensions: [{ id, when?, load }]`                                                                                                                                                                                  | `lib/features/editor-extensions.ts` (one Compartment, live reconfigure)                                                                                             | extension dropped from every open editor                                                           |
| Menus                              | `menus: { "<surface>": [ids] }`                                                               | `menus: { "<surface>": [{ id, items(...target) }] }`, surfaces `editor-body` (view, event), `sidebar-file` (DirEntry), `sidebar-folder` (DirEntry), `sidebar-bulk` (paths), `editor-tab` (absolute path of the tab's file) | `lib/features/menus.ts`, one registry keyed `surface:id`; surface builders call `contributedMenuItems(surface, ...target)` and append after a separator             | items disappear from the next right-click                                                          |
| Docks                              | `docks: [ids]`                                                                                | `docks: [{ id, priority, isOpen, width, close, subscribe, load }]`                                                                                                                                                         | `lib/features/docks.ts`, `app-layout.tsx`                                                                                                                           | dock removed; the plugin pane is the fallback                                                      |
| Sidebar panels                     | `sidebarPanels: [ids]`                                                                        | `sidebarPanels: [{ id, label, icon, order, load }]`                                                                                                                                                                        | `lib/features/sidebar.ts`, `components/sidebar/sidebar-body.tsx` (Files is core, first, stays mounted)                                                              | tab removed; a selected panel falls back to Files                                                  |
| Sidebar actions                    | `sidebarActions: [ids]`                                                                       | `sidebarActions: [{ id, label, icon, order, run(feature) }]`                                                                                                                                                               | `lib/features/sidebar.ts`, `sidebar-header.tsx` (first click activates)                                                                                             | button removed                                                                                     |
| Status items                       | `statusItems: [ids]`                                                                          | `statusItems: [{ id, order, load }]` (component gets `{ filePath }`)                                                                                                                                                       | `lib/features/status-items.ts`, `editor-area/document-footer.tsx`                                                                                                   | item removed                                                                                       |
| Settings page                      | `settings.schema.json` fragment next to the manifest (no key), plus the generated kill switch | `settingsSection: { id, label, order, load }`                                                                                                                                                                              | `lib/features/settings-sections.ts`, `settings-panel`                                                                                                               | page removed; the fragment stays in the merged schema                                              |
| Secrets                            | `secrets: [{ key, label, description }]`                                                      | `ctx.secrets.get/set/delete`                                                                                                                                                                                               | `features/secrets.rs` + `stores/feature-secrets-store.ts`                                                                                                           | stored values stay in the Keychain; the declaration and UI go with the feature                     |
| Rust commands                      | `rust.commands`                                                                               | `Feature::invoke_handler` (plugin named after the id)                                                                                                                                                                      | `features/mod.rs` runner, `build.rs` ACL, `capabilities/features/<id>.json`                                                                                         | plugin never added; commands answer `FeatureUnavailable` once failed (restart to apply the switch) |
| Overlays                           | `overlays: [ids]`                                                                             | `overlays: [{ id, load }]`                                                                                                                                                                                                 | `lib/features/overlays.ts`, `components/feature-overlays.tsx` (mounted once in `App.tsx`, inside `FeaturePane`)                                                     | overlay unmounted (the plugin browser)                                                             |
| File tree decorations              | `fileTreeDecorations: [ids]`                                                                  | `fileTreeDecorations: [{ id, useBadge(entry) }]`                                                                                                                                                                           | `lib/features/file-tree.ts`, drawn by `components/sidebar/file-tree-decorations.tsx` (one component per contribution per row, in a null-fallback `FeatureBoundary`) | the badge is gone (the agent's project badge)                                                      |
| Slots                              | none                                                                                          | `slots: [{ id, slot, load }]`, `slot` is `sidebar-ribbon`, `editor-status` or `page-view:<kind>`                                                                                                                           | `lib/features/slots.ts`, `components/feature-slot.tsx` (sidebar bottom, `app-layout.tsx`, `page-kinds/views.tsx`)                                                   |
| Command sources                    | none                                                                                          | `commandSources: [{ id, list(ctx) }]`                                                                                                                                                                                      | `lib/features/palette.ts`, `command-palette/commands.ts` (`resolveCommands`)                                                                                        |
| Workspace listeners                | none                                                                                          | `workspaceListeners: [{ id, onFileChanged?, onSecretChanged?, onSecretsReady? }]`                                                                                                                                          | `lib/features/workspace-events.ts` (emitted by `use-file-watcher.ts` and `secrets-store.ts`)                                                                        |
| Rust gated commands                | `rust.gatedCommands`                                                                          | none (commands stay registered by the app)                                                                                                                                                                                 | `features::gate` wraps the app's invoke handler (`lib.rs`), `features::is_live`                                                                                     | commands answer `FeatureUnavailable` at once (the switch is read live)                             |
| Rust events                        | `rust.events`                                                                                 | `<id>:<name>` emitted by Rust, `ctx.listen` in the web half                                                                                                                                                                | `lib/features/events.ts`                                                                                                                                            | listener disposed with the feature                                                                 |
| Rust hooks, skills, CLI, index DDL | `rust.hooks`, `rust.skills`, `rust.cliCommands`, `rust.indexDdl`                              | `Feature::setup / on_workspace_open / on_workspace_close / on_exit`, `skills`, `cli_commands`, `index_ddl`                                                                                                                 | `features::install`, `guard`                                                                                                                                        | a disabled feature gets no hooks and contributes nothing (restart)                                 |
| File kinds (listing and search)    | `rust.fileKinds`                                                                              | `Feature::file_kinds` (`FileKind`: suffixes, gate, text source, optional extractor; `index/kinds.rs`, `search-spec.md` "File kinds")                                                                                       |

Feature items are always grouped after core items behind a separator (one rule, `lib/features/origin.ts` `withFeatureDivider`): a native separator in menus, a vertical divider in the sidebar panel row and the footer, a "Features" group in the Settings sidebar (after the core "General" group, before "Community plugins"; a page may name the "Community plugins" group instead (`settingsSection.group`), as the Obsidian host's pages do, and then no Features group appears for it; every settings group is labelled, labels come from `SETTINGS_GROUPS`, a group without items shows neither label nor divider); none when no feature contributes.

A new web point is one registry file in `lib/features/`, one `removeOwner` line and one `add` loop in `registry.ts`, one id list in the type `ContributionIdPoint`, and one row here; the host component reads the registry through `useRegistryItems` and renders contributions through `FeaturePane`. Not hosted yet: page kinds, settings blocks, `tab`, `footer` and `sidebar-surface` menus, stores.

## 7. Cross-cutting

### 7.1 Settings schema ownership

> Step 1 decision (keeps the step small; nothing is merged at runtime yet): `shared/settings.schema.json` stays the one file Rust and TypeScript read. A feature's `settings.schema.json` fragment and the generated `features.<id>.enabled` entry (boolean, global, default from `enabledByDefault`, category "Features") must appear in it **verbatim**; `features::contract_tests` computes the expected entries from each registered feature and fails with the exact JSON to add when one is missing or has drifted, rejects keys outside the `<id>.` prefix and duplicate keys, and rejects any `features.*.enabled` key in the shared file that no registered feature owns. Enablement reads `features.<id>.enabled` at the global scope (`features::is_enabled`; the manifest default when absent; a setting for an unknown id is never read). The runtime merge described below, and an auto-rewrite of the shared file (skipped: rewriting would reformat the hand-formatted JSON), are Step 4, when the first fragment ships.

Each feature ships `settings.schema.json`, same entry shape as the global file. `config.rs` builds the schema as `core + features' fragments` (each `include_str!`ed by the feature trait via the manifest path); TS does `import.meta.glob("../../../features/*/settings.schema.json", { eager: true })` in `settings-schema.ts`. Both sides therefore read the same files; there is no build script and no second copy (DRY). Rules enforced by the contract test: keys are prefixed by the feature id (`word-count.show-in-status`), no duplicate keys across fragments, fragments cannot redefine core keys, the generated `features.<id>.enabled` key exists for every manifest. The hand count test (`config.rs` `agent.len() == 12`) is replaced by "every fragment parses and each key has type, default and label". The accepted settings ADR is refined: the contract is the merged schema (ADR Q11, decided: the ADR carries a "Supersedes" section; the old ADR's status is set to superseded when this ADR is accepted).

### 7.2 Commands, palette and keybinding collisions

> Implemented for keybindings (Step 1b): `KeybindingRegistry.add` throws `KeybindingConflictError` naming the chord (in the user's platform spelling) and both owners when a chord is already bound under the same or an unconditional context, when an id is reused, when a binding lists a chord twice, or when the chord is system-reserved (`Mod+Q`, `Mod+,`, `Mod+H`, `Mod+M`). Core bindings register at import (a test fails if they conflict) and feature registration is all-or-nothing. The command id prefix check is in `defineFeature`; the rest of this paragraph is the target.

One contract test collects `contributes.commands` from all manifests plus core commands: ids unique, `<id>.` prefix for feature commands, keybindings parse (`Mod`, `Shift`, `Alt`, key), no two bindings equal under the same `when` (macOS and non-macOS variants checked separately), and no collision with a reserved list (CodeMirror defaults, `Cmd+W`, `Cmd+Q`, system shortcuts). This is the missing conflict detector (audit row 12).

### 7.3 Docs generation

`docs/keyboard-shortcuts.md` keeps its prose (it is published), but the **tables** gain generated blocks between markers (`<!-- features:shortcuts:start -->`); `vp run docs:features` rewrites them from manifests and a test fails when the checked-in output is stale. Same script writes `docs/features.md` (index: id, name, version, dependsOn, settings, commands, spec link). Per-feature conventions: `CHANGELOG.md` stays global and user-visible (one line per user-visible change, prefixed by the feature name); `TODOS.md` items name the feature id; each feature has one spec in `SPECs/` linked from `feature.json` (`"spec": "SPECs/word-count-spec.md"`); ADRs stay in `docs/decisions/` and name the feature id in the title.

### 7.4 Testing

- Per feature: `features/<id>/tests/` (TS) and `rust/tests.rs` (Rust), run by the existing `vp test` and `cargo test` (add the glob to the Vite+ test include and the `#[path]` mount already compiles `tests.rs`).
- A **fixture feature** (`tests/fixtures/features/failing/`) with a throwing `activate` and a failing `setup` proves isolation.
- A **contract test** (`tests/features-contract.test.ts` plus one Rust test) covers sections 2, 5.2, 7.1 and 7.2.
- Fakes follow the real contract: a `FeatureContext` test double (`tests/helpers/feature-context.ts`) like the existing `mock-client.ts` for the agent client.

### 7.5 Performance and lazy activation

Eager `import.meta.glob` loads only each `web/index.ts`, which must stay import-light (manifest JSON, `defineFeature`, thunks). Budget: all manifests plus registration under 5 ms and no heavy library in the initial chunk (check with the Vite build chunk list). `onStartup` features are limited to those needed before first paint (none today). Excalidraw hosting, tables, agent pane and Bases views are `load` thunks: the agent chunk loads on `onWorkspaceOpen` (or the first `agent.toggle` if the setting says lazy), tables when the first table decoration is needed (`onFileKind:markdown` is too broad; use the extension's own `when`). Measure with `lib/startup-metrics.ts` before and after each pilot.

### 7.6 Versioning, ordering, dependencies

`version` is a contract version (events, commands, settings), not a release number; a dependent declares `dependsOn: ["agent"]` and optionally a minimum version (`"agent@>=2"`). Activation and teardown order are topological; a missing, disabled or failed dependency disables dependents with a log line. No optional or circular dependencies (cycle = both disabled).

### 7.7 Activation events and memory

Memory is a first-class driver: laziness is the default for **every** feature (ADR "Decisions taken", Q6).

| Event               | Fires when                                                 | Typical use                                    |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `onStartup`         | app start, before first paint                              | `tables`-style startup state and nothing heavy |
| `onWorkspaceOpen`   | a window gets a workspace root                             | agent services, Obsidian host                  |
| `onCommand:<id>`    | the command runs from palette, shortcut or menu            | agent toggle, table commands                   |
| `onFileKind:<kind>` | a page of that kind is about to open (`base`, `code`, ...) | Bases views, code editor                       |
| `onView:<id>`       | a dock, pane or settings block is about to render          | agent pane, Features settings group            |

Rules, all enforced by the host and checked by tests:

1. **Not activated means not loaded.** Static contributions (command labels, keybindings, menu entries, status item stubs) come from the manifest and cost a few bytes; the `load: () => import(...)` thunk is never called until needed, so no JS chunk, no store, no subscription, no `listen` exists. The host exposes `isActive(id)` and the Features section shows it.
2. **Not activated means no Rust background work.** `Feature::setup` registers state cheaply (an empty struct) and must not spawn threads, watchers, processes or open SQLite handles; those start in `on_workspace_open` or on the first command (a `start` the feature owns), and only when the feature is enabled. A disabled feature is never added as a Tauri plugin, so its commands and state do not exist (restart needed).
3. **Deactivation frees what activation created.** `ctx.disposables` (listeners, subscriptions, registry entries, timers, abort controllers) disposes in reverse order; the Rust side implements `on_workspace_close`/`on_exit` to stop what it started. The Zustand store a feature owns is reset on deactivate so its state is collectable. A fixture test activates then deactivates a feature and asserts the registry, listener and timer counts return to their baseline.
4. **Measurement.** `lib/startup-metrics.ts` gains `featureActivation` marks (activate duration, chunk load); a dev-only "Features" row shows RSS before and after activate/deactivate for the pilots so the claim is checked, not assumed.

### 7.8 The Features settings section

A new Settings section **Features** (group "General"), generated from the manifests: no per-feature code in `settings-sections.ts`. It is the one place where the merged-schema contract (section 7.1) is visible: every feature ships its own settings fragment and the UI renders it under that feature.

Contribution: the host appends `{ id: "features", label: "Features", group: "General", blocks: [{ type: "features" }] }` to `SETTINGS_SECTIONS` once (a single core entry) and registers one renderer in `settings-blocks.tsx`; the block lists `FeatureHost.list()`. A feature contributes its own sidebar page through `contributes.settingsSection` (the Agent page); see "Feature settings and secrets".

Per feature row:

- **Toggle** bound to the generated `features.<id>.enabled` setting (global scope). Core editing, tabs and the sidebar are not features and do not appear.
- **Status**: `active`, `inactive` (enabled, not yet activated: lazy), `disabled` (switched off), or `failed` with the logged error (from `logger`, never note contents) and a "Copy error" and "Retry" action.
- **Memory note**: from the manifest (`"memory": { "level": "low|medium|high", "note": "Loads the editor chunk on first table; no background work." }`) plus the live `active/inactive` state, so users see why disabling helps. The note is data in `feature.json` (a manifest field to add in section 2), not UI code.
- **Restart note**: shown when the feature has a Rust half (`rust.commands` or hooks non-empty) and its enabled state differs from the state the app started with: "Takes effect after restart. The interface part switched now."
- **Dependencies**: "Needs: agent" or "Required by: ..."; turning off a feature that others depend on lists the dependents that will be disabled too and asks for confirmation (one confirm dialog, the existing pattern).
- **No settings here.** A feature's settings and secrets live on its own page in the Settings sidebar ("Feature settings and secrets" below), never under its row: the row is name, version, description, memory note, restart note, failure info and the toggle.

Mock layout:

```
Settings > Features
+--------------------------------------------------------------------------------+
| Features                                                  [ Search features  ] |
| Turn features off to save memory. Core editing, tabs and the sidebar always run.|
+--------------------------------------------------------------------------------+
| Agent                                           v1.0.0   [ON ]  * active       |
|   Chat with Claude over your notes. Memory: medium. Starts a Claude process    |
|   per open chat and loads the chat UI when you open the pane.                  |
|   Needs: (none)   Restart: required to fully stop background services          |
|   > Agent settings (12)                                                        |
|       Binary path ........ [ /usr/local/bin/claude ]                          |
|       Permission mode .... [ Ask every time v ]                                |
|       Chats keep days .... [ 30 ]                                              |
+--------------------------------------------------------------------------------+
| Tables                                          v1.0.0   [ON ]  o inactive     |
|   Table editing and palette commands. Memory: low. Loads when you open a note  |
|   with a table. No background work.                                            |
|   > Table settings (2)                                                         |
+--------------------------------------------------------------------------------+
| Bases                                           v1.0.0   [OFF]  - disabled     |
|   Obsidian Bases tables for .base files. Memory: medium.                       |
|   Needs: (none)   Required by: (none)                                          |
+--------------------------------------------------------------------------------+
| Mouse buttons                                   v1.0.0   [ON ]  x failed       |
|   Back and forward with side buttons.                                          |
|   Error: native monitor setup returned an error (see Logs)  [Copy] [Retry]     |
|   Restart: required                                                            |
+--------------------------------------------------------------------------------+
| Obsidian plugins                                v1.0.0   [ON ]  * active       |
|   Runs community plugins from trusted vaults. Memory: high when plugins run.   |
|   Turning it off stops all community plugins in this window.   Restart: req.   |
+--------------------------------------------------------------------------------+
```

Tests: a jsdom test renders the section from fixture manifests (rows, statuses incl. `failed` with error, restart note, dependents confirm); a contract-test entry asserts every manifest has `memory.level` and `memory.note`; the existing `settings-sections.test.ts` stays green because the section is one core entry.

## 8. Relationship to community plugins

- Built-ins call the contribution points directly. They never import the host's shims (`features/obsidian-host/web/host/api/*`) or anything else of the `obsidian-host` feature; what a built-in needs to know of the host goes through core (`lib/community-plugins.ts`).
- The palette, status bar, settings nav and menus **merge** built-in and community entries (they already merge community ones today); the owner id distinguishes them (`builtin:<id>` versus the plugin id) so teardown and the "disable" UI stay separate.
- The Obsidian host can become the built-in feature `obsidian-host`: it owns `plugins-store` activation, the `writer-plugin://` scheme registration, `ProcManager`/`PluginEnv` state and their window-close and exit hooks (today scattered in `lib.rs` L550-555, L107-110, L774-778). Its API shim, trust gate and consent flows do not change (ADRs stay). Decided: it becomes a feature, last (Step 5), because it has the most state; it stays a pure lifecycle wrapper.
- Trust: built-ins are trusted code compiled into the app; community plugins are not. There is no isolation between them in the webview (same as today). A built-in must not write `.obsidian`: the existing grep check in the host ADR stays (`.obsidian` writes only in `plugins.rs` and `plugin_store.rs`), now also run over `features/`.

## 9. Security: capabilities versus grants

`capabilities` in the manifest are **declarations the review and the tests can check, not a sandbox**: built-in code is in-process and trusted. They are used for (a) generating the Tauri permission list per feature (`<id>:default`), (b) a contract test that refuses certain combinations (for example a feature declaring `write-workspace-files` must route writes through `vault_ops`; none may declare `write-obsidian-dir`), (c) a static grep test over `features/` for `.obsidian`, `std::process::Command`, `reqwest` outside allowed features (process spawn must go through the consent flow in `plugin_proc.rs`/`agent/consent.rs`). Granted by the maintainers by code review, not at runtime. Window scope stays `main` and `w-*`.

Vocabulary (initial): `read-active-document`, `read-workspace-files`, `write-workspace-files`, `spawn-process` (needs consent flow), `network`, `read-settings`, `write-settings`, `keychain`, `native-ui` (menus, dock).

## 10. Worked example: add `word-count` (Rust command + React status-bar item)

Files to create (all under `apps/desktop/features/word-count/` unless noted) and the one registry line.

1. `feature.json`

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "description": "Live word count in the status bar.",
  "dependsOn": [],
  "provides": [],
  "enabledByDefault": true,
  "activation": ["onWorkspaceOpen"],
  "capabilities": ["read-active-document"],
  "rust": {
    "commands": ["word_count_for_text"],
    "events": [],
    "indexDdl": null,
    "skills": [],
    "cliCommands": []
  },
  "contributes": {
    "settings": "settings.schema.json",
    "commands": [
      {
        "id": "word-count.toggle",
        "label": "Toggle Word Count",
        "description": "Command",
        "keybinding": "Mod+Alt+W",
        "when": "hasWorkspace"
      }
    ],
    "statusItems": ["word-count.status"]
  }
}
```

2. `settings.schema.json`: one entry `word-count.visible` (boolean, default true, label "Show word count in the status bar", category "Status Bar"). Nothing else declares the default.

3. `rust/core.rs`

```rust
/// Words as the status bar counts them: whitespace-separated, markdown syntax ignored.
pub fn count_words(text: &str) -> usize { text.split_whitespace().count() }
#[cfg(test)] mod tests { use super::*; #[test] fn counts() { assert_eq!(count_words("a b\nc"), 3); } }
```

4. `rust/commands.rs`

```rust
#[tauri::command]
pub async fn word_count_for_text(text: String) -> Result<usize, AppError> {
    crate::commands::blocking(move || Ok(super::core::count_words(&text))).await
}
```

5. `rust/mod.rs` (the trait impl from section 5.1: `id`, `manifest`, `tauri_plugin`; no other hooks), plus `mod core; mod commands;`.

6. `web/ipc.ts` (typed client from section 6.4).

7. `web/status-item.tsx`

```tsx
export function WordCountStatus() {
  const text = useActiveDocumentText(); // core hook, not a store read from the feature
  const n = useAsync(() => countText(text), [text]);
  return <span data-testid="word-count">{n ?? 0} words</span>;
}
```

8. `web/index.ts`

```ts
import manifest from "../feature.json";
import { defineFeature } from "@/lib/features";
export default defineFeature({
  manifest,
  contributes: {
    statusItems: [
      {
        id: "word-count.status",
        side: "right",
        order: 30,
        load: () => import("./status-item").then((m) => m.WordCountStatus),
        visibleWhen: (ctx) => ctx.settings.get<boolean>("word-count.visible"),
      },
    ],
    commands: [
      {
        id: "word-count.toggle",
        run: (ctx) =>
          ctx.settings.set("word-count.visible", !ctx.settings.get("word-count.visible")),
      },
    ],
  },
});
```

9. `tests/word-count.test.ts` (renders the item with the context test double) and `rust/tests.rs` (command test).
10. `SPECs/word-count-spec.md` (the spec; linked from `feature.json` `"spec"`).

**The one registry line** (Rust; TS needs none), in `apps/desktop/src-tauri/src/features/mod.rs`:

```rust
#[path = "../../../features/word-count/rust/mod.rs"] pub mod word_count;   // 1 (mod)
pub static ALL: &[&dyn Feature] = &[ /* ... */ &word_count::WordCount ];   // 2 (list entry)
```

Not edited: `lib.rs`, `commands/mod.rs`, `capabilities/default.json` (when capability.json is picked up), `settings.schema.json` (global), `settings-sections.ts` (status bar category already exists; a new section would come from `contributes.settingsSection`), `use-keyboard-shortcuts.ts`, `commands.ts`, `command-registry.test.ts`, `app-layout.tsx`, `config.rs`. Generated: shortcut table rows and `docs/features.md` through `vp run docs:features`. A user-visible feature still adds one `CHANGELOG.md` line.

If the TS-only variant is enough (a count done in JS), drop `rust/`, the `ipc.ts` and the Rust list entry: **zero** shared-file edits.

## 11. Contract test (what "well-formed" means)

`apps/desktop/tests/features-contract.test.ts` loads every manifest and definition and asserts: unique ids equal to folder names; `dependsOn` exist and form a DAG; every manifest command id has a definition and vice versa; command ids prefixed with the feature id; keybindings parse and do not collide (section 7.2); every `statusItems`/`pageKinds`/`docks` id exists in code; settings keys prefixed and present in the merged schema; `features.<id>.enabled` exists; `rust.commands` equals the scanned `#[tauri::command]` fns (Rust test shares a JSON dump written by `cargo test`, or both read the sources through one scanner); `skills` and `cliCommands` exist; no forbidden imports (`obsidian-host/api` from a feature, a feature importing another's internals, core importing `features/`): enforced with an import-graph check over the source.

## 12. Migration plan (each step shippable, nothing big-bang)

Principle: new code first, then move one feature at a time; the old registries keep working during the whole migration, and a moved feature keeps behaviour and tests.

| Step | Commit(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Acceptance checks                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Spike branch: `InlinedPlugin` with one command, capability, `app.plugin()` in `setup`, capability glob. Notes in this spec. No product change.                                                                                                                                                                                                                                                                                                                                                                                                                                             | Written answers to section 5.4 (i)-(iii); decision recorded in the ADR (accept or fall back to C + trait).                                                                                                                                                                                                                                                   |
| 1a   | **Done (infrastructure, no feature).** `src/lib/features/` (types, host, registry, lifecycle, error isolation, `ipc.ts`, `events.ts`), `src/lib/owned-registry.ts` (extracted), Rust `features/` registry, `install`, `Lazy<T>`, `build.rs` manifest ACL, the capability convention, the contract test with a test-only fixture. Not yet: the `features/` folder, the `import.meta.glob` loader (nothing to load); the failing-`activate` case is a unit test of the host.                                                                                                                 | `vp check`, `vp test`; the fixture feature is disabled and logged; app boots unchanged.                                                                                                                                                                                                                                                                      |
| 1b   | **Done (tables not generated).** Keybinding registry replaces the `if` chain in `use-keyboard-shortcuts.ts` (core bindings are data in `lib/keybindings/core-bindings.ts`); conflict test; a test ties the Global table of docs/keyboard-shortcuts.md to the registry both ways; the palette and the new-tab page read their shortcuts from the registry. Generated shortcut tables behind markers stay deferred.                                                                                                                                                                          | Existing shortcut tests pass unchanged; `docs/keyboard-shortcuts.md` diff is zero apart from markers; conflict test catches an injected duplicate.                                                                                                                                                                                                           |
| 1c   | Features settings section (7.8) and `features.<id>.enabled` generation; open `Location` union (declaration merging) and lazy page-kind views; dock registry for the agent/plugin pane; editor-extension registry; palette registry fed by contributions while `BUILTIN_COMMANDS` stays as the core list.                                                                                                                                                                                                                                                                                   | `command-registry.test.ts` unchanged and green; `app-layout.tsx` has no feature-specific import; the editor test suite passes.                                                                                                                                                                                                                               |
| 2    | **Done (Pilot 1 `tables`, TS-only; measured numbers in section 15).** Moved `table-decorations`, `table-editing`, `table-commands`, context-menu items, settings keys into `features/tables/` (`feature.json`, `web/index.ts`); the editor-extension, editor-body menu and settings-section hosts and the `features/*/web/index.ts` loader landed with it (the parts of 1c it needed).                                                                                                                                                                                                     | `table-*` tests pass from the new folder; `createEditorExtensions` has no table import; startup chunk no longer contains table code (build chunk list).                                                                                                                                                                                                      |
| 3    | **Done (section 15).** Rust: `Feature` trait, `features::registry` (the `ALL` list), runner in `lib.rs`; merged index DDL, CLI table and skills from the trait. Pilot 2 `mouse-buttons` (removed 2026-11-17, see below): the fixture feature and `agent` now exercise the trait.                                                                                                                                                                                                                                                                                                           | `cargo test`, `sync_commands_are_allowlisted`; with `features.mouse-buttons.enabled=false` the monitor is never installed; a forced `setup` error is logged and the app starts; e2e smoke.                                                                                                                                                                   |
| 4    | **Done (section 15, four sub-steps).** `build.rs` reads manifests (`InlinedPlugin`), per-feature capability, `tauri-specta`, `specta` and `specta-typescript` dependencies added (needs the user's explicit go; `#[specta::specta]`, collected commands and events, and the `bindings` diff test per feature), `ipc.ts` clients, settings fragments merged. **Pilot 3 `agent`**: commands, `AgentSessions` state, exit hook, skills, 12 settings, dock, `Cmd+Shift+A`, palette commands. Done as sub-steps: settings fragment, then TS contributions, then Rust hooks, then commands last. | `agent_*` tests, `agent_fake_claude.rs`, goldens, e2e fake-claude spec pass; `lib.rs` no longer lists agent commands or state; `config.rs` count test replaced; `git diff --stat` for a scripted `word-count` add touches only `features/word-count/` and `features/mod.rs`; the agent appears in Settings > Features with its 12 settings grouped under it. |
| 5    | **`obsidian-host` done (section 15, "Step 5: obsidian-host")**, `bases` done (section 15, "Step 5: bases"), `projects` done as part of `agent` (section 15, "Step 5: projects"), `code-files` done (section 15, "Step 5: code-files"), `images` done (section 15, "Step 5: images"), `pdf` done (section 15, "Step 5: pdf"), then by value: `docs/features.md` generator; slim-build flags; crate extraction of pure cores.                                                                                                                                                                | Each is its own ADR-free move under this ADR unless it changes a boundary; verify with the feature's own tests plus the contract test.                                                                                                                                                                                                                       |

Why this order: step 1 has no risk and unlocks every later step; the TS pilot proves contribution points before Rust is touched; the small Rust pilot proves hooks, kill switch and isolation on the feature that actually crashed the app; the agent is last because it exercises every contribution kind at scale and is where the pain is (45 handler lines, state, exit hook, 12 settings).

## 13. Risks

| Risk                                                                               | Mitigation                                                                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ACL path for inlined plugins fails or needs per-window capabilities                | Step 0 spike; fallback to central `generate_handler!` plus trait for everything else                                                    |
| `panic = "abort"` in release: a panic in a feature still kills the app             | Catch `Result` errors; keep native code behind flags; panics are tests/dev only; document that `catch_unwind` does not help in release  |
| Renaming commands to `plugin:<id>\|<cmd>` breaks callers, `tauri-ipc.test.ts`, e2e | Typed `featureInvoke` is the only caller; migrate one feature at a time; keep an alias test per moved command                           |
| Manifest drifts from code                                                          | Contract test; manifest-derived docs fail when stale                                                                                    |
| Eager `import.meta.glob` grows startup                                             | Import-light rule, lint on heavy imports in `web/index.ts`, budget in the plan                                                          |
| Hidden coupling between features (feature A imports B's store)                     | Import-graph test; services registry; `dependsOn`                                                                                       |
| Over-engineering for a team of few features                                        | Staged plan: step 1-2 are valuable alone; stop after any step; C is the fallback                                                        |
| `#[path]` mounts confuse rust-analyzer or tooling                                  | Not exercised yet (the registry is empty); check with the first pilot; fall back to colocated layout (ADR question 10)                  |
| Mock-runtime IPC/ACL test needs the `tauri` `test` dev-feature                     | Approved and added (dev-dependency `tauri` with `features = ["test"]`, lockfile unchanged); section 15 says what it covers              |
| Two concepts named "plugin" confuse users and agents                               | Code name `feature`; never in user-facing text; AGENTS.md has one paragraph                                                             |
| Kill switch leaves Rust state alive until restart                                  | Decided: every feature is switchable; the Features section shows a restart note for the Rust half; lazy start keeps idle cost near zero |
| Settings ADR wording ("one file") superseded                                       | Open question 11; supersede in the acceptance PR                                                                                        |
| Index schema hash makes every feature toggle rebuild the index                     | Hash only the DDL of **registered** features regardless of the toggle, so toggling does not rebuild                                     |

## 14. Non-goals

A Cargo workspace or crate per feature (ADR Q1, decided no, including the `writer-core` extraction for now); a third-party or community plugin API for these features; sandboxing first-party code; WASM; runtime-loaded features; a visual marketplace for built-ins; moving `bases`, `index`, `relocate` into crates in this change; typed generation for features that have not migrated yet (adoption is per feature, `agent` first; revisit and exit triggers in the ADR); a generated runtime imported directly by feature code (only `ipc.ts` wrappers may import it); changing the Obsidian shim.

## 15. Status and next step

Proposed. Step 0 (spike) is done with verdict GO, see the [report](./builtin-plugins-spike-report.md) and the ADR section "Spike result (2026-11-17)". **Step 1 is implemented as infrastructure only: no existing feature moved and no demo feature ships.** What exists:

- Rust (`apps/desktop/src-tauri`): `src/features/mod.rs` (`Manifest`, `FeatureDef<R: Runtime>`, `registry::<R>()` empty, `is_enabled`, `plan`, `install` called once from `setup` right after the settings layer exists; a disabled feature is never passed to `app.plugin`, a failing one is logged and skipped), `src/features/lazy.rs` (`Lazy<T>`, tokio `OnceCell`, documented pattern, built once under concurrent first calls, retried after an error), `build.rs` (manifest to `InlinedPlugin`), the capability convention (`capabilities/features/<id>.json`, no code), `serde_json` as a build-dependency.
- Rust tests: registry empty today; `install` plans enabled features only and ignores settings for unknown ids and unreadable manifests; `Lazy` exactly-once; the contract test (`contract_tests.rs`: manifest vs `#[tauri::command]` fns vs plugin name vs capability file with exact windows, the event-name rule, the settings fragment present verbatim in the shared schema, a feature folder without a registry entry); a test-only `fixture-hello` feature (`src/features/fixture.rs`, data in `src-tauri/tests/fixtures/features/fixture-hello/`) registered, with its commands called through the plain function path; negative tests that a stale manifest, a dotted event, wide windows or a missing permission fail.
- TypeScript: `src/lib/features/` (`id.ts`, `events.ts` and `ipc.ts` promoted from the spike with the rules enforced, `types.ts` with `FeatureManifest`, `registry.ts` with `defineFeature` and the lazy host, `palette.ts`), `src/lib/owned-registry.ts` (moved out of the Obsidian host, which imports it), `src/lib/keybindings/` (`chord.ts`, `registry.ts`, `when.ts`, `core-bindings.ts`). `use-keyboard-shortcuts.ts` is a small dispatcher over the registry; the capture-phase Cmd+[ / Cmd+] behaviour (agent pane excluded, repeats ignored, propagation stopped) is the two `phase: "capture"` bindings. The palette shows `shortcut` from the registry for any command whose id equals a binding id, and feature commands join `BUILTIN_COMMANDS` through `featurePaletteCommands`.
- TS tests: `tests/features-registry.test.ts` (lifecycle, lazy activation on the first command and the first key press, concurrent activation, reverse disposal, unregister, failure isolation, key conflict atomicity), `tests/features-ipc.test.ts` (route, manifest guard, event naming rule), `tests/keybindings.test.ts` (chords, conflicts, the docs Global table both ways, palette shortcut, dispatch quirks).
- Intentional matching changes versus the old chain, all tightenings: modifiers match exactly (Cmd+Alt+P no longer opens the palette, Ctrl+Alt+1 no longer jumps to tab 1), letter chords ignore CapsLock, and the non-Latin physical-key fallback stays only for Cmd+Shift+T and Cmd+Shift+A, as before.

Deferred: generated shortcut tables, the sidebar and settings-block registries, `dependsOn` ordering, the editor-extension registry for more than tables. Tracked in [`TODOS.md`](../TODOS.md) ("Built-in plugins"). Steps 2, 3 and 4 are done (below). Step 5 is done for `obsidian-host`, `bases`, `projects`, `code-files`, `images` and `pdf`; next: the `docs/features.md` generator, slim-build flags and crate extraction.

**Step 5, `spellcheck` (2026-11-18).** The built-in feature `spellcheck` ([`spellcheck-spec.md`](./spellcheck-spec.md)) exercises most contribution points at once: `editorExtensions` (the lazy lint source), `statusItems` (the language of the paragraph), `overlays` (the LanguageTool question), `settingsSection`, `commands`, a `cli_commands` entry (`writer check`), a settings fragment and `tauri-specta` bindings. Its engine is Tauri-free in `src-tauri/src/spellcheck/`, and Harper's non-`Send` linters live on a thread started through the `Spawner` the feature passes (`features::spawn`). The takeover prompt of Excalidraw became the shared core mechanism `src/lib/plugin-takeover.ts`, which the LanguageTool choice reuses; core gained `subscribeCommunityPlugins` and `chooseAction` for it.

**Step 2 (pilot `tables`, TypeScript only) is done.** What changed:

- Folder `apps/desktop/features/tables/`: `feature.json` (id, 24 palette commands as data, `memory`, no Rust half), `web/index.ts` (`defineFeature`; import-light: the manifest, `active.ts` and thunks), `web/active.ts` (the light state palette `when` predicates read), and the moved code `web/table-decorations.ts`, `table-editing.ts`, `table-commands.ts` (now only the actions behind the manifest's commands), `markdown-table.ts` (only table code used it, so it moved out of `src/lib/`), new `context-menu.ts` and `extension.ts`; tests in `tests/` (the three moved files plus `tables-feature.test.ts`). `vite.config.ts` test include and `tsconfig.json` (`features/*/web`) pick the folder up.
- Hosts added to `src/lib/features/`: `editor-extensions.ts` (registry plus one Compartment; `load` is called when the first editor asks, every live editor is reconfigured when a contribution loads or is removed, `when` is re-evaluated then), `menus.ts` (`editor-body` surface; `buildEditorBodyMenuItemsSpec` takes the contributed items and has no table parameter), and `builtin.ts` (the `import.meta.glob` loader: registers a feature while `features.<id>.enabled` is on and watches the setting, so the switch is live in the TS half). `createEditorExtensions`, `editor-body-menu.ts`, `editor-context-menu.ts` and `commands.ts` have no table import (import-graph test).
- Settings: the table feature has no settings of its own today; its kill switch `features.tables.enabled` is in `shared/settings.schema.json` verbatim (category "Features", shown in a new "Features" section as a plain category block until the generated Features section of 1c). The Rust contract test now accepts a TypeScript-only feature (no `rust.commands`/`events`): no registry entry, no ACL (`build.rs` skips it), only the kill switch is checked against the shared schema; its description has no restart sentence.
- Palette command ids changed from `table-*` to `tables.<name>` (feature prefix rule); nothing else referenced them.
- Measured with `vp build` (before to after): the startup entry chunk is shared out differently by the bundler, so compare the static startup closure (entry plus every chunk it imports statically): 3287.0 kB to 3263.3 kB (the table code, 32.6 kB / 12.2 kB gzip, left it and the host code added about 9 kB). New lazy chunks: `extension` 7.75 kB, `table-editing` 23.98 kB, `table-commands` 0.85 kB (3.09 + 8.62 + 0.47 kB gzip). The raw `index-*.js` file went from 2960.9 kB to 2529.1 kB, but 158 kB of that moved into a shared chunk (`error-log`) that the entry imports statically, so it is not a saving.
- Deviations from the sketch: the extension needs no activation (`load` is the lazy point, `activate` is not involved, so the feature's state stays `registered`); an editor created before the table chunk has loaded shows the table source for one tick and folds it when the chunk arrives (later editors get the extension synchronously); `FeatureManifest` is still not a field of the definition (the loader reads `feature.json` by glob for `enabledByDefault`).

**Step 3 (`Feature` trait, runner, pilot `mouse-buttons`) is done.** Note 2026-11-17: the pilot `mouse-buttons` and its native monitor were removed afterwards (the monitor aborted the app three times; ADR `2026-11-17-remove-the-mouse-buttons-feature-and-its-native-monitor`), so the Rust trait is exercised by the test-only fixture feature and by `agent`; the bullets on the pilot below are history. What changed:

- `src-tauri/src/features/mod.rs`: the `Feature<R>` trait (hooks `setup`, `on_workspace_open`, `on_workspace_close`, `on_exit`; pure contributions `cli_commands`, `skills`, `index_ddl`), `registry::<R>()` (one `#[path]` mount line plus one list entry for `mouse-buttons`), `install` (setup, then plugin, per enabled feature; failures logged and skipped; `Running` managed state), the hook entry points `workspace_open`, `workspace_close`, `exit` (teardown reversed) and the contribution readers. `lib.rs` calls them from `setup`, `attach_window_handlers` and the exit arm, `commands/workspace.rs` from the workspace open path, and has `pub(crate) fn context<R>()`, the one `generate_context!` expansion.
- The three tables stay the single place that runs the entries: `cli::registry::commands()` chains `COMMANDS` and the features' commands (`find` and `help` read it), `managed_skills::all_skills()` chains `SKILLS` and the features' skills (sync, obsolete cleanup, fingerprint, `claude_skills_installed`), `index::schema` runs each feature's DDL after the core and FTS DDL and stores `schema_version()`. No feature contributes any of the three yet; tests pin that the core tables and the version `"2"` are unchanged.
- Pilot: `apps/desktop/features/mouse-buttons/` with `feature.json` (activation `onStartup`, event `mouse-buttons:navigate`, no commands, so no plugin, ACL or capability file), `rust/mod.rs` (the feature; `setup` installs the native monitor whenever the feature is enabled; the `WRITER_NATIVE_MOUSE` opt-in was removed afterwards), `rust/macos_mouse.rs` (moved from `src/macos_mouse.rs`; `install` now returns a `Result`, `is_installed()` is new), `web/index.ts` and `web/mouse-navigation.ts` (the former `src/hooks/use-mouse-navigation.ts`, no longer mounted in `App.tsx`) and `tests/mouse-buttons.test.tsx`. The kill switch `features.mouse-buttons.enabled` is in the shared schema. The loader (`src/lib/features/builtin.ts`) now activates features that list `onStartup` as it registers them. Spec: [`mouse-side-buttons-spec.md`](./mouse-side-buttons-spec.md).
- The `#[path]` mount works: the nested `mod macos_mouse;` resolves next to the mounted `mod.rs`, and `cargo test`, `cargo clippy` and `cargo fmt` need nothing special. rust-analyzer was not run (no editor session), so editor behaviour is unchecked.
- Tests: the runner (a disabled feature is never set up and gets no hooks, hook order and reversed teardown, `Err` and panic isolation), the contributions (DDL collected, hash stable and version-sensitive, empty suffix without DDL, core tables unchanged), mock-runtime tests with the real `crate::context()` (a failing `setup` does not stop the app or the other features; a plugin with no build-time permissions is rejected by the ACL; plain app commands are not gated) and, for `mouse-buttons`, that switched off means not planned and `macos_mouse::is_installed()` stays false. The helper in `ipc_tests.rs` clears the configured window: its vibrancy effect calls AppKit on the mock runtime's fake `NSWindow` and segfaults (the spike did not hit it); the `main` window is created by hand so the ACL sees the label it grants.
- Not covered yet: a positive ACL call (an allowed `plugin:<id>|<cmd>` from `main` and `w-*`) needs a real feature with commands, so it lands with the `agent` pilot. Installing the native monitor needs a real `NSApplication` and is verified by hand.

**Step 4 (per-feature plugin, settings fragments, `tauri-specta`, pilot `agent`) is done**, in four sub-steps that each leave the suite green:

- **(a) Settings fragment.** The 20 `agent.*` entries moved out of `shared/settings.schema.json` into `features/agent/settings.schema.json`; `config::load_schema` appends every registered feature's fragment (`features::settings_fragments()`, whatever the toggle) and `lib/settings-schema.ts` globs the same files (`FEATURE_SETTINGS`), so both sides read one merged schema. The generated `features.agent.enabled` kill switch stays in the shared file (the 7.1 rule for kill switches is unchanged). The contract test now checks a fragment's shape (prefix, label, type, default, description, category, no duplicate), that no fragment key also sits in the shared file and that each is in the merged schema; the `agent.len() == 20` count in `config.rs` is gone. Settings > Features is generated from the manifests (`FEATURE_MANIFESTS`): a toggle, description, memory note and restart note per feature, (a first version listed the fragment under the row behind a "Show settings (n)" button; that was replaced, see "Feature settings and secrets"). The dedicated Settings > Agent page (custom model catalog, binary detection) uses `SettingRows` for its generic rows.
- **(b) TypeScript contributions.** `features/agent/feature.json` carries the four palette commands (ids `agent.toggle-pane`, `agent.new-chat`, `agent.history`, `agent.use-demo-backend`), the `Mod+Shift+A` binding and the dock; `web/index.ts` is the `defineFeature`, `web/dock-sync.ts` (activated `onStartup`) replaces `useAgentPaneDock` (saved width and open state from the settings, restoring the vault's chats). New dock host: `src/lib/features/docks.ts` (registry, `openDock`, `subscribeDocks`), `hooks/use-docks.ts`, `components/dock-pane.tsx` (lazy pane); `app-layout.tsx` has no agent import and keeps the "whichever opened last wins" rule between the open dock and the plugin pane. The agent pane chunk loads when the dock first opens. `command-registry`, `keybindings` and the e2e spec use the new ids; the keybindings docs test reads the registry's feature bindings too.
- **(c) Rust hooks.** `features/agent/rust/mod.rs`: `setup` manages `AgentSessions` and installs the project port (was `lib.rs`), `on_workspace_close` kills the window's CLI processes (`stop_window_work` now calls `features::workspace_close`, which also runs when a window leaves its vault, not only at destroy), `on_exit` kills all (was `lib.rs`). Manifest `rust.hooks` documents them (`has_rust()` counts hooks). The feature contributes no bundled skills: `writer-cli`, `writer-search` and `writer-bases` are for any agent in a vault and belong to the CLI and Bases, not to this pane. `stop_vault_work` (trust revoked) still kills by vault root through `try_state`, because the trait has no vault-level hook.
- **(d) Commands and `tauri-specta`.** The 30 `agent_*` commands moved from `commands/agent*.rs` to `features/agent/rust/commands/{session,chats,projects,skills}.rs`, generic over the runtime, and left `lib.rs` (which no longer names the agent). They are one `plugin:agent|<cmd>` plugin (`Feature::tauri_plugin`), with `<id>:allow-<cmd>` permissions from `build.rs` and `capabilities/features/agent.json`. The three `commands/plugins.rs` and `index.rs` helpers they share (`trusted_root`, `consent_store`, `dialog_consent`, `window_index`...) became generic over the runtime. `agent_detect_binary` takes `binaryOverride` instead of reading the raw body for `override`. `rust/bindings.rs` is the one list of commands (plugin handler and bindings), with `plugin_name("agent")`, the global bigint-to-number cast and `disable_serde_phases()`; `WRITER_UPDATE_BINDINGS=1 cargo test bindings` rewrites `web/bindings.ts` and the plain test fails when it is stale. The wire types derive `specta::Type` in `crate::agent` (core stays Tauri-free), free-form `serde_json::Value` fields are `#[specta(type = Unknown)]`, and `AppError` is a string for specta. `web/ipc.ts` is the only importer of `bindings.ts` (types only) and the typed client (`agentCommand`, `callAgent`, `agentEvents`); `src/lib/agent/client.ts`, `chat-history-client.ts` and `project-client.ts` call through it.
- **Event name.** tauri-specta names a typed event `plugin:<id>:<NAME>`, which cannot be `<id>:<name>` without also renaming `mouse-buttons:navigate`, so the agent's event is emitted with a plain `emit_to` as **`agent:event`** (was `agent://event`) and exported to the bindings only as the type `AgentEventEnvelope` (`Builder::typ`); `ipc.ts` listens through `featureEvents`. The `<id>:<name>` rule and its tests are unchanged.
- **Dependencies.** `tauri-specta =2.0.0-rc.29` (`derive`, `typescript`), `specta =2.0.0-rc.28` (`derive`, `function`), `specta-typescript =0.0.15`; `Cargo.lock` gained exactly nine crates (Inflector 0.11.4, paste 1.0.15, specta, specta-macros, specta-serde, specta-util, specta-typescript, tauri-specta, tauri-specta-macros) and `tauri` stays 2.12.5. Generated `bindings.ts` is excluded from the formatter and the linter in the root `vite.config.ts`.
- **Tests.** TS: `features/agent/tests/agent-feature.test.ts` (registration, kill switch, commands, the key, dock sync), `agent-ipc.test.ts` (an alias test per moved command: `plugin:agent|<cmd>`, manifest = generated = 30 commands), `tests/features-section.test.tsx`, dock cases in `features-registry.test.ts`. Rust: hooks and state (`features::agent::tests`), every command allowed from `main` and `w-*` and refused from another label under the REAL ACL (the positive ACL case section 15 listed as missing), the commands absent when the feature is off, the bindings diff test, the contract test for hooks and fragments.
- **UI types on the generated ones (done 2026-11-17).** The agent pane's wire types are no longer hand-written: `src/lib/agent/events.ts` re-exports the generated types (through `features/agent/web/ipc.ts`, the one importer of `bindings.ts`) and adds only what is UI-only (`ContextRef.label`, the typed view of `PermissionSuggestion`, `LedgerItem`); every command result in `ipc.ts` is the generated one, and the hand `AgentCommandMap`, `AgentCommand` and `AGENT_COMMANDS` are gone. The drift the bindings exposed is fixed at the call sites: `ChatSummary.preview` nullable (`?? ""`), an absent `titleSource` read as `none` (`applyTitleSummary`), every `AgentBinaryInfo` field required on the wire (test fixtures build it whole), `DiskSkill.scope` a plain string (narrowed once in `slash-commands.ts`), `null` results mapped to `void` in `client.ts`. The Rust idle reaper thread of `AgentSessions` still starts with the state (one sleeping thread), against rule 7.7.2; making it lazy touches the runner tests.

**`graph` (web half) is done.** `apps/desktop/features/graph/`: kill switch `features.graph.enabled`, a settings fragment (`graph.*`), the page kind `graph` (core, like `base`) with the lazy slot `page-view:graph`, a sidebar action (a "Local graph" sidebar panel was removed 2026-11-18) and the palette command "Open graph"; sigma, graphology and ForceAtlas2 are imported only there and stay out of the entry chunk (tested). The agent feature gained the service `agent.context` for "Attach to agent chat". Details: [`SPECs/graph-view-spec.md`](graph-view-spec.md) section 11.

**Step 5, `bases` (Obsidian Bases as a feature), is done.** `apps/desktop/features/bases/`: kill switch `features.bases.enabled` (default on). Rust: the pure engine stays in `src/bases/` (plus `wire.rs`, the one description of the query result's JSON shape that specta reads); `rust/commands.rs` holds the ten `base_*` and `note_property*` commands as the per-feature plugin `bases` (`plugin:bases|<cmd>`, `#[specta::specta]`, `features::contain`), `rust/bindings.rs` and `web/bindings.ts` the generated typed client with a stale-bindings test, `web/ipc.ts` the only importer of it. The feature contributes the CLI commands `bases`, `base:views`, `base:create`, `base:query` (`CommandSpec.feature`; off, `writer` answers that Bases is turned off) and the `writer-bases` skill through the trait (`features/bases/skills/`); off, the skill is not newly installed and an installed copy is left alone (`managed_skills::sync_except`, `Action::SkippedFeatureOff`). Web: the base view, view registry, embeds and their tests moved to `features/bases/web/` and `tests/`; the `.base` page kind stays in core (`Location` is a closed union and session restore needs it at startup) with `feature: "bases"`, so `locationForPath` does not claim `.base` while the feature is off (the file opens as text) and a restored `base` tab shows a "Bases is turned off" page with Turn on and Open as text; the tab body is the lazy slot `page-view:base`; embeds are the editor extension `bases.embeds` (off, `![[x.base]]` renders as the plain link). The Obsidian shim reaches the view registry through a new contribution point, **`services`** (`lib/features/services.ts`: `provides` in the manifest, `getService(id)` in code, typed by `import type` from the provider's public entry `@features/bases/web/api` only, never its internals); `registerBasesView` returns `false` when no `bases.views` service exists. The Rust half takes effect after a restart; the web half applies at once. Build: the bases UI is out of the entry chunk (numbers in the CHANGELOG). Imports: `@/` and `@features/` (and `@tests/`) resolve in vite, `vp check` and the tests; a boundary test (`tests/import-boundaries.test.ts`) fails on a `../..` import that leaves its own folder and on one feature importing another's internals.

**Step 5, `excalidraw` (native Excalidraw drawings as a feature), is done.** `apps/desktop/features/excalidraw/`: kill switch `features.excalidraw.enabled` (default on), a settings fragment (`excalidraw.handle-files`, `excalidraw.auto-export-svg`). Rust (`rust/`): codec, lz-string, layout and element building, six `excalidraw:*` CLI commands (`create`, `add`, `update`, `read`, `export`, `preview`), the `excalidraw:export` and `excalidraw:preview` socket commands, the `writer-excalidraw` skill via the `Feature` trait; no Tauri commands, events or hooks, so no plugin or capability file (`has_rust()` is false). Web: lazy `page-view:drawing` slot, embed editor extension, disk-sync workspace listener, `ipcRequests` answer for the export, `excalidraw.files` service. Core keeps the `drawing` page kind (`claimsWhenOff`) and `lib/drawing-files.ts`. Spec: [`excalidraw-spec.md`](./excalidraw-spec.md).

**Step 5, `obsidian-host` (the Obsidian community plugin host as a feature), is done.** The feature owns the host's whole web half (`apps/desktop/features/obsidian-host/`, activation `onWorkspaceOpen`, now acted on by the loader): the API shim and Node shims (`web/host/`, README there), the plugins store and the update and catalog stores (`web/stores/`), the plugin pane, strips, tab bodies and Settings components (`web/components/`), the plugin browser (`web/plugin-browser/`), `use-plugins.ts`, the editor extension and the markdown decorations. Community plugins run through the same shim, unmodified. The trust gate, consent and per-plugin secrets are unchanged. What the feature owns and how core reaches it:

- **Lifecycle** (`web/lifecycle.ts`, was the `usePluginHostLifecycle` hook in `App.tsx`): follows the workspace store, `attach` when a workspace window has resolved startup, detach on change, close or switch-off, plus the update scheduler; `attach` still loads plugins only when the vault is trusted. A host that fails to boot (`bootError`) fails the feature for the session at once (`failFeature`, the health store's `failNow`), with the usual notice.
- **Palette**: `obsidian-host.toggle-pane` and `obsidian-host.browse-plugins` (were `toggle-plugin-pane` and `browse-community-plugins` in core). Plugin-registered commands still merge in from the host's registry (empty while off).
- **Settings** (`web/settings-pages.ts`): Manage plugins (order 200, update badge, the "Browse plugins..." footer) and one page per plugin settings tab (201+), contributed to the one settings-section registry while the feature is active and kept in step with the plugins store. New optional fields of `settingsSection`: `group` ("Community plugins", so the sidebar keeps "General", "Features", "Community plugins" in this order and no "Features" group appears for the host), `requiresWorkspace`, `badge`, `footer`. The `plugins.auto-check-updates` setting stays in the shared schema (category "Community plugins", rendered by the Manage plugins page).
- **Dock**: the plugin side pane is the dock `obsidian-host.pane` (priority 10, below the agent's 20). Docks are one column: the dock opened last closes the others (`useExclusiveDocks`), replacing the two effects in `app-layout.tsx`.
- **Overlay**: the plugin browser dialog is the new `overlays` point (table above), mounted once while the feature is on.
- **Rust** (`features/obsidian-host/rust/mod.rs`): not a `Feature` in `registry()`. The 30 plugin commands keep their plain names because the shim and its tests call them by name and `plugin:obsidian-host|*` would rename every caller; they stay registered in `lib.rs` and `features::gate` wraps the app's invoke handler: a command listed in `rust.gatedCommands` (the one list; a test ties it to `commands/plugins.rs` and `lib.rs`) answers `FeatureUnavailable` when the switch is off, in safe mode or after a failure, and runs under `contain` otherwise. The `writer-plugin://` scheme handler checks the same `is_live` first and refuses with 403. The three `secrets_*` commands (Settings > Secrets) stay ungated. The switch is read live from the global settings, so it applies at once (no restart sentence on the kill switch). `ProcManager`, `StreamRegistry` and `PluginEnv` stay managed by the app and their window-close and exit cleanup stays in `commands::plugins::stop_window_work` and the exit arm: a user can switch the feature on mid-session, and a process the host started must still die with its window and the app, which a hook that only runs for a feature that was on at launch cannot promise.
- **Core seams (the host is out of core, 2026-11-17).** Core imports nothing of the feature (a boundary test scans `src/` for import specifiers). Three new contribution points, registered through `defineFeature` and not listed in the manifest (like `editorExtensions`): `slots` (`lib/features/slots.ts`, rendered by `<FeatureSlot slot=.../>` inside `FeaturePane`: `sidebar-ribbon` above the workspace switcher, `editor-status` at the bottom right of the editor column, and `page-view:<kind>` for the tab body of a page kind; the host fills the ribbon, the status strip and `page-view:plugin-file` / `page-view:plugin-view`), `commandSources` (`lib/features/palette.ts`: commands computed each time the palette opens, listed after the built-ins and never shadowing one; the host lists the plugin commands that can run now, which runs plugin availability code) and `workspaceListeners` (`lib/features/workspace-events.ts`: core's `emitFileChanged`, `emitSecretChanged`, `emitSecretsReady`, called by the file watcher and the secrets store; the host forwards them to its vault and `SecretStorage`). Every one is removed with the feature (`removeContributions`). The plugin browser's open state moved from the core `ui-store` into `web/stores/plugin-browser-store.ts`.
- **Editor**: the plugin extension compartment, its validation guard and the markdown-processor widgets are one `editorExtensions` contribution (`obsidian-host.editor`, `web/editor-extension.ts`, `Prec.low` so the core fenced-block decorations still claim a fence first), loaded when the first editor needs it and removed from live editors with the feature. `createEditorExtensions` provides the `editorNotePath` facet and `lib/editor-views.ts` holds the live-editor registry (`registerEditorView`, `findEditorView`), the only editor-bridge part core uses. Reconfiguring the compartment before its first load is safe (CodeMirror keeps the value for the compartment).
- **Still in core, and why**: the page kinds' behaviour modules (`page-kinds/plugin-view.ts`, `plugin-file.ts`: session restore and path routing need them synchronously at startup, and `Location` is a closed union) with `lib/file-views.ts`, the generic resolver the host installs; `lib/owned-registry.ts`, `lib/popup-layer.ts` (used by the Bases expression input), `isValidSecretId` in `lib/secrets-client.ts` (Settings > Secrets), `lib/community-plugins.ts` (the set of running plugins, so the tables feature yields to Advanced Tables without importing the host) and the Rust commands (gated, below).
- **Startup bundle** (`vp build`, measured when the move landed): entry chunk 2,309.85 kB to 2,221.89 kB (gzip 746.67 to 717.53) and the shared shim chunk that the entry loaded at startup 157.47 kB to 4.04 kB, so JavaScript loaded at startup went from about 2,467 kB to 2,226 kB (gzip about 797 to 719). The shim itself is the lazy `host` chunk (239 kB). The plugins store and the feature's `index.ts` stay in the entry chunk because the dock, the palette and `when` answer synchronously. A variant that lazy-loaded the store made the entry chunk larger (2,251 kB, the bundler hoisted shared modules into it), so it was not kept.
- Tests: `features/obsidian-host/tests/obsidian-host-feature.test.tsx` (registration through the registries and teardown to zero, lifecycle, activation on workspace open, kill switch, failing boot, Settings order, boundaries), Rust `features::obsidian_host::tests` (gated list, off and failed refuse, ungated commands pass, the switch applies live), `tests/settings-sections.test.ts`, `tests/settings-panel.test.tsx`, dock exclusivity in `tests/features-registry.test.ts`; the host's own suites (`obsidian-host-*`, `obsidian-node-*`, `obsidian-network-*`, `plugin-*`, `plugins-store`, `workspace-bridge`) moved to `features/obsidian-host/tests/` (fixtures in `tests/fixtures/`, excluded from the formatter in `vite.config.ts`).

**Step 5, `projects` (done as part of the `agent` feature: the user agreed that projects belong to the agent), is done.** The agent pane's whole web half moved from core into `apps/desktop/features/agent/web/` with its tests in `features/agent/tests/`: `components/` (the pane, composer, transcript, project home, switcher, dialog, recent chats, ...), `lib/` (events, reducer, client, chat notes, project client/actions/sources, ...), `stores/` (`agent-store`, `projects-store`, `turn-changes-store`, and the new `pane-store`) and `hooks/` (`agent-api`, `use-agent`, `use-enabled-agent-models`). Imports use `@features/agent/...`; `tests/import-boundaries.test.ts` stays green and a test asserts no file of `src/` imports the feature. What core used to import, and how it reaches the feature now:

- **Project badge on the sidebar tree**: the new contribution point **`fileTreeDecorations`** (table 6.5; `lib/features/file-tree.ts`, `FileTreeDecorations` in `components/sidebar/`). A contribution is `{ id, useBadge(entry) }`, a React hook returning `{ label, icon, testId? }` or `null`; core draws the one badge look (`FileTreeBadgeIcon`), calls each hook from its own component (so the hook count of a row never changes when a feature toggles) inside a `FeatureBoundary` with a null fallback (a throwing hook costs a strike and draws nothing). The agent contributes `agent.project-badge` (`web/project-badge.ts`, over the projects store); with the agent off there is no badge and no `agent_list_projects` call (the project list is started by the feature's activation, `watchProjects`, and stopped with it). The agent skills and symlink badges (`AgentFolderBadge`) stay in core: they are about the code-files and managed-skills rules, not the agent pane.
- **New project dialog**: the overlay `agent.new-project-dialog` (was mounted in `App.tsx`). **Palette**: `agent.new-project` and `agent.make-project-from-folder` are feature commands (were `agent-new-project` and `agent-make-project-from-folder` in core's `project-commands.ts`). **Folder context menu**: "Make project" is the `sidebar-folder` item `agent.make-project`, so it now follows the core items behind the feature separator (it was between New Folder and Copy path).
- **Dragging a vault image from the sidebar onto the composer**: core's `lib/vault-drop-target.ts` is a tiny registry (`registerVaultDropTarget`, `dropVaultFilesOnTarget`) the mounted composer registers into (through `lib/chat-image-target.ts`, which also serves the OS drop); the tree's pointer drag asks it by screen position and names no feature.
- **The pane's visibility and width are their own store** (`stores/pane-store.ts`: `open`, `width`, `setOpen`, `setWidth`, `persistWidth`, `syncOpen`, `syncWidth`, persisted in `agent.pane-open` / `agent.pane-width`). The dock contribution reads it, and it was split out of `agent-store` because everything else in that store (chats, reducer, client, notes) is not needed to draw an empty dock. `openPane`, `closePane` and `togglePane` stay on the chat store as composite actions (an open pane always has a chat tab; the store makes one through a subscription, so the Settings page and the saved state keep the invariant). `Cmd+Shift+A` closes through the pane store and opens through a dynamic import of `hooks/agent-api`, so the first press loads the chat store; the saved open state applies before the first paint from `dock-sync.ts`, which no longer touches the chat store. **Restored chats** (`agent.restore-chats`) now come back when the pane first mounts (`AgentPane` calls `restoreAgentChats` for the open vault and on a vault switch, once per vault) instead of at startup; nothing else reads the chats while the pane is closed.
- **Startup bundle** (`vp build`, measured when the move landed): entry chunk 2,038.83 kB to 1,997.19 kB (gzip 662.18 to 646.65); the chat store (58 kB) and the pane (113 kB) are lazy chunks. JavaScript loaded at startup (entry plus its preloaded chunks) 2,863 kB to 2,804 kB after the contribution points and the pane store (the first number is with the pane code already lazy but the store in the entry). The startup graph of `web/index.ts` is pinned by `features/agent/tests/agent-feature.test.ts` (it must not reach `stores/agent-store.ts`, `components/`, `hooks/` or the reducer).
- Tests: the existing agent tests moved (imports to `@features/agent/...`, pane state in `usePaneStore`), plus `agent-feature.test.ts` (project points registered and removed by the kill switch, no `src/` import, startup graph, dock sync), `project-badge.test.tsx`, `agent-chat-image-target.test.ts`, `agent-projects.test.ts` (palette commands through the feature, `watchProjects`), and in core `features-file-tree-decorations.test.tsx` (the point: draws, per entry, removed with the feature, id prefix, a throwing hook contained) and `vault-drop-target.test.ts`.

## 16. Failure containment and recovery

Decision: [`docs/decisions/2026-11-17-contain-feature-failures-with-unwinding-panics-and-recover-from-native-crashes-on-next-launch.md`](../docs/decisions/2026-11-17-contain-feature-failures-with-unwinding-panics-and-recover-from-native-crashes-on-next-launch.md). Requirement: no feature can take Writer down or leave it in a state the user cannot recover from.

**Rust, in-process (a panic).** `[profile.release]` is `panic = "unwind"`. One guard, `features::guard(app, id, boundary, f)`, runs `f` under `catch_unwind`; a panic is logged once at `error` (feature id and boundary only; the redacting panic hook logs the payload), the feature is `failed` for the session (`Containment` managed state), and `features:failed { id, boundary }` is emitted. Every boundary goes through it: `setup` (and the plugin add), `on_workspace_open`, `on_workspace_close`, `on_exit` (a failed feature's later hooks are skipped), every command and every feature thread. Commands: a feature declares a plain `Feature::invoke_handler`; the runner builds the plugin named after the id and wraps the handler once in `features::contain`, so a failed feature's commands answer `AppError::FeatureUnavailable` and a panic in the synchronous part of a handler fails the feature and rejects the call. Threads: `features::spawn(app, id, name, f)` (the agent's idle reaper uses it). Limits: a panic inside an `async` command body runs on the async runtime, which catches it itself (the call then never resolves unless the work went through `commands::blocking`, which returns the panic as an error); the agent's per-chat event pump threads start inside the Tauri-free `agent::session` and are not guarded. Not resumed: a failed feature stays off until restart.

**Rust, next launch (what cannot unwind).** Tauri-free `features/recovery.rs`, files in `<app data dir>/features/`: `inside.json` (`{ id, boundary, pid, at, setting? }`) is written atomically before `setup`, a hook or a declared native call and removed after (nested boundaries restore the outer marker; never per command or per IPC call); `active-native.json` lists native code that stays live, written by `features::native(app, id, setting, f)` after a successful install and cleared on a clean exit; `startup.json` counts launches that never reached "ready". `lib.rs` calls `features::boot` before `install`: the pure `recover(found, own_pid, is_on)` turns a marker or active entry left by another process into the narrowest setting to switch off (the marker's `setting`, else `features.<id>.enabled`), applied through `Settings::set_global`, logged, and shown by the webview as a notice ("<Feature> was turned off after a crash. Turn it back on in Settings > Features."). `startup.json` is set to the previous count plus one at launch and to 0 by `features::mark_ready` (first finished page load, `on_page_load`); two in a row start **safe mode**: no feature starts (Rust) or registers (web), a banner explains it and "Restart normally" (`features_restart_normally`) resets the counter and restarts. Safe mode never rewrites settings. A corrupt marker file is ignored with a warning. A force quit while native code is live also leaves `active-native.json` (only a clean exit clears it) and so costs that feature its setting; accepted, the setting is narrow and one click turns it back on. No feature declares native code today (the mouse monitor that did was removed), so `native` is covered by the fixture tests only.

**Webview.** The one store is `stores/feature-health-store.ts`: failures per feature, session-off set, safe mode, crash-disabled list. Every host path reports through it: command, keybinding and palette runs and `activate` (in the feature host), menu items, editor-extension loads (a load that throws, or an extension that cannot build an editor state, is dropped), and render errors (`FeatureBoundary`, the one error-boundary component, wraps every contributed pane; it shows "This feature failed" and a "Turn off" action; docks use it today, new hosts for page kinds and settings blocks must too). The third failure of one feature in a session, or a `features:failed` event from Rust, switches the feature off for the session (the loader unregisters it) and shows a notice. Runtime exceptions in a CodeMirror view plugin are dropped by CodeMirror itself and cannot be attributed to a feature, so they do not count. Settings > Features shows a failed or crash-disabled feature with its last failure (boundary, time) and a "Turn back on" toggle (web half at once, Rust half after a restart, as for any toggle).

**Tests.** Rust (`features/containment_tests.rs`, `recovery.rs`, mock runtime): a test-only feature panics in `setup`, each hook, a command and a spawned thread: the app keeps running, only that feature is failed, the other still gets its hooks, one error line without the payload, one `features:failed`; a failed feature's command answers `FeatureUnavailable` without running; markers exist only around risky boundaries; `native` records and clears; pure `recover` cases; `boot` plus `install` for a stale marker and for safe mode; `cargo test --release` runs these under the unwinding profile. TS: `tests/feature-containment.test.tsx`.

**Step 5, `code-files` (code and text files, the agent skill folders and the code editor as a feature), is done.** `apps/desktop/features/code-files/`: kill switch `features.code-files.enabled` (default on), activation `onFileKind:code`. Spec: [`code-files-spec.md`](./code-files-spec.md).

- **Rust seam, one entry point.** The pure rules stay in core, `src-tauri/src/code_files.rs` (Tauri-free; the `writer` CLI, the index and the watcher use them, and with the feature off they still need an answer). That module holds the process-wide `Policy` and is the only thing the sidebar listing (`commands/fs.rs`, `fs_entry`), the index walker and `NameCache` (`index/`), the watcher filter, `relocate` (a code file's links are not rewritten) and the agent's change snapshots ask (`rel_is_visible`, `is_listed_*`, `is_code_path`, `listed_sql_predicate`); none reads a setting or the feature id. The feature's Rust half (`rust/mod.rs`, in `registry()` for its settings fragment, no command, no hook, no thread) is the **one place that turns the settings and the switch into a policy**: `apply(settings)` (called by `commands::settings` at startup and after every global write, replacing the old `apply_code_files_policy`) and `apply_for_cli(data_dir)` (the CLI reads the switch from the global config file; the rest uses defaults). Off, the policy is `Policy::notes_only()`: no code extension or name, no `.agents/skills` or `.claude/skills`, no ignored-folder list (dot-folders and `node_modules` stay hidden), images still follow their own core setting `files.show-images`. The index scan takes one policy snapshot per scan (`walk_builder_with`).
- **Web seam.** The `code-files.rules` service (`provides` in the manifest, `contributes.services`; the interface `CodeFilesRules` is defined in core, `lib/code-files.ts`, so core imports nothing of the feature): core's `isCodeName` / `isCodePath` (tab and tree labels, the open-file parser, the sidebar glyph, the `code` page kind) ask `getService`, so with the feature off nothing counts as code. The `code` page kind stays in core (closed `Location` union, session restore) with `feature: "code-files"`: `locationForPath` does not claim a code file while the feature is off (it opens as text) and a restored `code` tab shows "Code files is turned off" with Turn on and Open as text (the `featureView` helper shared with `base`, `graph` and `session-changes`). The tab body is the lazy slot `page-view:code` (`code-files.code-tab`): `CodeEditorPane`, the CodeMirror setup, the language data and `lib/code-language.ts` (language, indentation, size limits) left the entry chunk. The rules module (`web/rules.ts`) reads `code-files.extensions` from the settings store, shares `shared/code-files.json` with Rust, and takes its defaults from the feature's settings fragment, which Rust reads too (`include_str!`), one file for both sides.
- **Settings.** `code-files.extensions`, `code-files.ignored-folders`, `code-files.show-agent-folders` and `code-files.word-wrap` moved from the shared schema into the fragment (category "Code files", a generated page); they were `files.code-extensions`, `files.ignored-folders`, `files.show-agent-folders` and `editor.code-word-wrap`. `Settings::migrate_code_files_keys` renames the global values once at startup (a new key already set wins; a workspace override of the word wrap is not renamed). `files.show-images` stays in the shared schema: attachments belong to core (the viewer is the `images` feature, below).
- **Toggling.** Rust applies at once, no restart: the next folder listing, the watcher, rename and move, the open guards follow the switch. The index and quick open (`NameCache`) read the policy when a workspace opens, so they follow at the next workspace open (the rule the extension list already had), and folders already shown in the sidebar re-list when they are reopened. Safe mode and a web failure switch only the web half off. The memory note on the Features page says so.
- **Stays in core, and why.** `lib/code-files.ts` (the lookup, `agentSkillDir`, `isAgentFolderPath`, the glyph families: used by the sidebar, the agent folder badge and the managed-skill banner, which also serves the note tab), `page-kinds/code.ts`, `ManagedSkillBanner` (moved to `components/editor-area/`), `fs_entry` and the `.gitignore` handling.
- Tests: `features/code-files/tests/code-files-feature.test.tsx` (register and unregister, kill switch, throwing activation, the rules service, off behaviour for routing, labels, glyph and the off page, manifest and fragment contract, startup chunk), `code-files.test.ts` (moved: rules, kind, language, editor, tree, store), Rust `code_files_tests::feature_off` (sidebar, quick-open predicates, relocate, open guard), `index::tests` (walker), `watcher` (filter), `features::code_files::tests` (policy from settings and the switch), `config::tests::test_code_files_keys_migration`, the contract tests (manifest, fragment, kill switch).

**Step 5, `images` (the image viewer as a feature), is done.** `apps/desktop/features/images/`: kill switch `features.images.enabled` (default on), activation `onFileKind:image`, TypeScript only. Decision: [ADR](../docs/decisions/2026-11-18-make-images-a-built-in-feature-with-a-rebuilt-zoomable-viewer.md).

- **Feature.** `web/index.ts` (startup chunk: the manifest, `disk-sync.ts`, `lib/viewer-controller.ts` and an `import()` thunk) contributes the slot `page-view:image` (the viewer, lazy), the three commands and keybindings `images.zoom-in` / `images.zoom-out` / `images.fit` and the workspace listener `images.disk-sync`. The viewer is rebuilt: `lib/view-transform.ts` (pure: fit up and down, zoom about a point, clamps 5%..3200%, pan bounds, Fit and 100% toggle), `lib/svg-size.ts` (an SVG's size from `width`/`height`, else `viewBox`), and one component, `components/image-viewer.tsx` (one `<img>` laid out at the zoomed size, never a CSS scale, so SVG redraws as a vector and animations run; the footer with the zoom control is part of it; it hides with `invisible` when its tab is not active, the keep-alive rule of `docs/design.md`). The old `src/components/image-viewer/`, `lib/image-zoom.ts`, `lib/zoom-target.ts`, `stores/image-viewer-store.ts` and `lib/image-disk-sync.ts` are gone.
- **Keys.** The zoom chords are registry bindings in two exclusive contexts (`when.ts`): core's `zoom-in`/`zoom-out`/`zoom-reset` apply under `no-image-viewer`, the feature's under `image-viewer` (the active tab is an image and the feature is active), so both show in Settings > Hotkeys with the same chords and no raw key listener exists.
- **Core keeps.** The `image` page kind (`feature: "images"`, and `claimsWhenOff: true`: an image is not text, so off it still claims its path and the tab shows the shared off page with Turn on and Open in default app, through the core command `open_attachment_in_default_app`, which only opens the image types), inline images in notes, paste/insert/import, attachment folders, asset grants, chat image chips, and the sidebar listing with its setting `files.show-images` (the sidebar, quick open and the index use it; it did not move, so no migration).
- **One format list.** `renderExtensions` in `shared/attachments.json` (png jpg jpeg gif webp svg avif bmp ico apng tif tiff heic heif jxl; `importExtensions` equals it and `mimeExtensions` covers them) is read by the viewer, the sidebar listing, quick open and inline rendering through `attachments::render_extensions()` and `lib/attachments.ts`; the system webview decodes what it can and the viewer shows a fallback for the rest.
- Tests: `features/images/tests/` (`view-transform`, `svg-size`, `image-viewer` incl. the keep-alive and fallback cases, `images-feature`: registration, kill switch, keys only in an image tab, routing of every format, the off page, manifest and schema contract, startup chunk), `tests/page-body-contract.test.tsx` ("kept-alive page bodies hide when inactive"), Rust `attachments::tests`, `code_files` image tests, `commands::fs`.

**Step 5, `pdf` (the PDF reader as a feature), is done.** `apps/desktop/features/pdf/`: kill switch `features.pdf.enabled` (default on), activation `onFileKind:pdf`, TypeScript only (the Rust side is core: listing, `read_document`, the agent's `document` block). Decision: [ADR](../docs/decisions/2026-11-18-read-pdfs-in-a-built-in-pdf-feature-rendered-with-pdf-js.md); spec [`pdf-spec.md`](pdf-spec.md) ("Implementation notes").

- **Feature.** `web/index.ts` (startup chunk: the manifest, `api.ts`, `lib/viewer-controller.ts` and `import()` thunks) contributes the slot `page-view:pdf` (the reader, lazy), the editor extension `pdf.embeds` (`![[x.pdf#page=3&height=600]]` as a block widget through `lib/react-block-widget.ts`, the Bases and Excalidraw embeds' shape), the commands and keybindings `pdf.zoom-in` / `pdf.zoom-out` / `pdf.fit` / `pdf.find`, and the service `pdf.info` (`provides`: page counts for the agent composer, typed through `import type` from `web/api.ts`). `web/lib/pdf-lib.ts` is the only importer of `pdfjs-dist` (a test pins that and that the startup graph and the entry chunk never reach it; the worker is `pdfjs-dist/build/pdf.worker.min.mjs?url`, an asset of the bundle).
- **Core keeps.** The `pdf` page kind (`feature: "pdf"`, `claimsWhenOff: true`), `documentExtensions` and `documentMaxBytes` in `shared/attachments.json`, the listing (`code_files::Policy.show_pdfs`, setting `files.show-pdfs`), `read_document` and `open_attachment_in_default_app` (`commands/fs.rs`), `#page=N` (`lib/pdf-anchor.ts`, `pending-anchor.ts`), the PDF file icon and label, and PDFs in the agent composer. What it shares with `images` moved to core instead of being copied: `lib/viewer-zoom.ts`, `hooks/use-zoom-gestures.ts`, `hooks/use-element-size.ts`, `components/zoom-control.tsx`; the key contexts are `image-viewer`, `pdf-viewer` and `no-viewer` (`when.ts`).
- Tests: `features/pdf/tests/` (`page-layout`, `find`, `embeds`, `pdf-viewer` with a fake pdf.js document, `pdf-embed`, `pdf-feature`: registration, kill switch, keys only in a PDF tab, routing, the off page, manifest and schema contract, the pdf.info service, startup chunk and a real bundle build), `tests/page-body-contract.test.tsx` and `tests/text-selection-contract.test.ts` (the reader), Rust `attachments`, `code_files`, `commands::fs`, `agent::files` and the `claude_stream` document golden.

## 17. Feature settings and secrets

A feature can have its own settings (a fragment, section 7.1) and its own secrets. Both appear in one place: the feature's page in the Settings sidebar. Settings > Features shows only the feature's name, version, description, memory note, toggle and failure info, with no setting rows and no expander (the agent used to appear twice, under Features and in its own section; the generated duplicate is gone).

**Pages (registry, no per-feature branch).**

- A feature contributes a page with `contributes.settingsSection: { id, label, order, load }` in its `defineFeature` (`load` is a dynamic import of the component, so the chunk loads when the page opens). `register` adds it to `settingsSectionContributions` (`src/lib/features/settings-sections.ts`, an `OwnedRegistry`) and `unregister` removes it, so the page exists exactly while the feature is on (switched off, in safe mode or off for the session after failures: no page, and a remembered selection falls back to the first page). The Agent page is `features/agent/web/agent-section.tsx` (with `agent-configure.tsx` and `agent-models.tsx`), `id: "agent"` (the remembered selection and `openSettings("agent")` keep working), `order: 40`. No `icon` field: the sidebar has no icons.
- `buildSettingsNav` merges the core sections and the feature pages sorted by `order` (core: Editor 10, Appearance 20, Files 30, Features 100, Privacy 110, Secrets 120, Logs 130; generated pages 90). A page whose id equals a core id is ignored. `FeatureSectionContent` mounts a page lazily inside a small error boundary ("This page could not be loaded"), never the app-wide error screen.
- **Fallback.** A feature that declares a settings fragment or `contributes.secrets` and contributes no page gets a generated page, `feature:<id>`, labelled with the feature name, order 90 (`generatedFeatureSection`): the fragment's rows with the shared `SettingRows`, then the "Secrets" group. A feature with neither has no sidebar item (Tables). A custom page embeds the same `FeatureSecretRows` component for its secrets.

**Secrets.** Declared in `feature.json` as `contributes.secrets: [{ key, label, description }]`, the key spelled `features.<id>.<name>` (`name`: lowercase letters, digits, dashes). The contract test checks the prefix, the name shape, uniqueness and a non-empty label.

- Storage is the existing secrets module only (`plugin_secrets.rs`), the same single Keychain item (account `secrets:v2`, ADR `2026-11-17-keep-all-plugin-secrets-in-one-keychain-item-...`): no second store. The `features.` id prefix is reserved there: `load_all` and `list_ids` (what plugins and Settings > Secrets see) omit those entries and `set`/`delete` refuse them, so a plugin cannot read, list or overwrite a feature secret; only the `feature_*` methods reach them. Values are never in a settings file (a secret key is not a schema entry), a log line (`features/secrets.rs` writes none; a test guards it), an event or a bindings snapshot.
- The scope rule lives once, in `features/secrets.rs`: every call names the feature id and the key and is refused unless that feature's manifest declares that key (so feature A cannot reach B's secret and an undeclared key is an error). Manifests come from every `feature.json` (`build.rs` writes `feature_manifests.rs`, so a TypeScript-only feature is covered too). Rust API: `features::secrets::{secret, set_secret, delete_secret, secret_keys_set}`; a read returns a `SecretValue` (no `Display`, no `Serialize`, redacted `Debug`). They touch the Keychain: call them through `commands::blocking`.
- TypeScript: `ctx.secrets.get/set/delete(key)` on the `FeatureContext`, through the commands `feature_secret_get/set/delete/keys_set` (`commands/features.rs`, the id check enforced in Rust) and the one write path `stores/feature-secrets-store.ts`. Limit worth knowing: the feature id is an argument, and every built-in feature runs in the same webview, so this protects against mistakes and against the plugin host, not against hostile first-party code.
- UI (`FeatureSecretRows`, on the feature's page): one row per declared secret with "Set" / "Not set" (the store only knows which keys are set, never a value), Set or Replace through the write-only `SecretForm` shared with Settings > Secrets, and Clear after a confirmation.
- No shipped feature declares a secret yet. The test-only `tests/fixtures/features/fixture-secrets/feature.json` declares one and covers the contract, the scoping, the redaction and the UI.

Tests: Rust `features::secrets::tests` (scoping, plugin isolation, one Keychain item, no value in errors or logs), `plugin_secrets::tests` (reserved prefix), contract tests (declarations); TypeScript `tests/feature-secrets.test.tsx`, `tests/feature-settings-sections.test.tsx` (sidebar with the Agent page only while the feature is on, no duplicate, generated page for a feature with settings and a secret, none for a feature with neither), `tests/features-section.test.tsx` (no rows on the Features page), `tests/settings-sections.test.ts` (merge by order).

## 18. Sidebar and footer contributions

Four new points (table in 6.5): **sidebar panels** (a feature's own view next to Files; the sidebar shows a tab row only while a feature added a panel or a toolbar button, so the core sidebar is unchanged without features), **sidebar actions** (toolbar buttons in that row), **sidebar menus** (the `sidebar-file`, `sidebar-folder` and `sidebar-bulk` surfaces of the right-click menus, including the Pinned and Recents rows; the old `editorBodyMenuContributions` registry became the one `menuContributions` keyed by surface) and **status items** (the document footer, after the word and character counts; the footer shows when it has a count or an item). The selected panel is `ui-store.sidebarPanel` (session only, `files` by default); a selection whose feature is off resolves to Files. `show{File,Folder,Bulk}ContextMenu` now take their target and pop the menu through the shared `showNativeContextMenu`. Manifest `menus` and the id lists are checked by `features::contract_tests` (prefix, uniqueness) and `tests/features-contract.test.ts` (manifest equals definition, for the shipped features and the test-only `tests/fixtures/features/fixture-sidebar`); behaviour is in `tests/features-sidebar-contributions.test.tsx` (registered only while on, removed on disable, order, a throwing panel contained, menus per surface, actions activate the feature, footer items). No shipped feature uses the new points yet.

## 19. Icons

The `icons` feature ([`icons-spec.md`](./icons-spec.md)) adds no new point of its own kind: it uses `menus` (the new `editor-tab` surface, with the sidebar ones), `overlays` (the picker), `editorExtensions` (the note icon before the first H1, and shortcodes) and a `settingsSection`. Two things are new in core and feature-neutral: the `completionSources` facet (`src/lib/editor-completion-sources.ts`: the editor's one `autocompletion({ override })` also asks the sources an extension adds through it, because CodeMirror refuses two overrides) and the core icon store and hook (`src/lib/file-icons.ts`, which the feature is the only writer of, so core surfaces draw icons without importing the feature). Its Rust half also uses `watcher::observe_paths` and a process-wide flag that `features::icons::apply` keeps equal to the kill switch, for the core paths (`relocate`, delete) that must do nothing while it is off.
