# Built-in plugins (first-party feature modules): design spec

Status: **proposed, not implemented.** Decision record: [`docs/decisions/2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md`](../docs/decisions/2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md) (read it first: it has the touch-point audit, the options A-F, the scoring and the numbered open questions). This spec is the detailed design for the recommended option D. Everything below is a sketch to discuss, not final code; naming is settled (`feature` in code, "built-in plugin" only in design talk, "Features" in the UI). Decisions taken by the maintainers are in the ADR section "Decisions taken"; all eleven questions are resolved (crate split: no; shared types and typed commands and events: `tauri-specta`, decided 2026-11-17 by the user with the rc risk accepted, evidence and maintainer review in the ADR).

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

Rust mounts the folder with `#[path]` in one file (the only place a folder outside `src/` is named):

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
- Error isolation: the runner wraps `setup` and each hook in `std::panic::catch_unwind` (the release profile has `panic = "abort"`, so the isolation for panics is **only** effective in dev/test; release relies on `Result` plus keeping risky native code behind explicit flags, exactly as `macos_mouse` now does). This limit is real and is listed in the risks.

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

`lib.rs` then has one `features::runner::setup_all(app)` in `setup`, one `on_workspace_close` call in `attach_window_handlers` and one `on_exit` in the `RunEvent::Exit` arm. Order is by `dependsOn`; teardown is reversed.

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
    fn tauri_plugin(&self) -> Option<TauriPlugin<Wry>> {
        Some(tauri::plugin::Builder::new("word-count")
            .invoke_handler(tauri::generate_handler![commands::word_count_for_text])
            .build())
    }
}
```

### 5.2 `build.rs` (permissions from the manifest, DRY)

```rust
fn main() {
    let mut attrs = tauri_build::Attributes::new();
    for m in features_manifests("../features/*/feature.json") {          // serde_json as a build-dependency
        let cmds: &'static [&'static str] = leak(m.rust.commands);
        attrs = attrs.plugin(leak(m.id), tauri_build::InlinedPlugin::new().commands(cmds)
            .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands));
    }
    println!("cargo::rerun-if-changed=../features");
    tauri_build::try_build(attrs).unwrap();
}
```

Contract test: for each feature, the manifest's `rust.commands` equals the set of `#[tauri::command]` fns found by the same scanner as `sync_commands_are_allowlisted` (extend that scanner, do not copy it; the sync-allowlist test itself needs no change because it scans all of `src/`... and `features/` which is outside `src/`: its root list must add `features/`, one line).

### 5.3 Capabilities

Today `capabilities/default.json` grants `core:default`, opener, dialog, clipboard, store to windows `main` and `w-*`. A feature plugin needs `"<id>:default"` in a capability. Two ways: (a) each feature ships `capability.json` and the build includes it through `capabilities_path_pattern`; (b) `build.rs` generates one `features.json` capability from the manifests into the capability dir. Prefer (a) if the pattern accepts several folders, otherwise (b). Never grant a window set other than `main`/`w-*`.

### 5.4 Spike that decides this (Step 0)

Verified in source: plugin commands are ACL-checked and rejected without ACL (`tauri-2.12.5/src/webview/mod.rs` ~L2078); `InlinedPlugin` exists (`tauri-build-2.7.4`). Unverified: (i) the capability pattern for multiple folders; (ii) a plugin added by `app.plugin()` inside `setup` still resolving its inlined ACL (should, ACL is generated at build time); (iii) the frontend `invoke("plugin:word-count|word_count_for_text")` path with `Channel` args (agent streaming uses events, not channels today; check). Fallback if (i)-(iii) fail: keep option 1 (central handler) and still use the trait for everything else.

## 6. TypeScript design

### 6.1 Types

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

## 7. Cross-cutting

### 7.1 Settings schema ownership

Each feature ships `settings.schema.json`, same entry shape as the global file. `config.rs` builds the schema as `core + features' fragments` (each `include_str!`ed by the feature trait via the manifest path); TS does `import.meta.glob("../../../features/*/settings.schema.json", { eager: true })` in `settings-schema.ts`. Both sides therefore read the same files; there is no build script and no second copy (DRY). Rules enforced by the contract test: keys are prefixed by the feature id (`word-count.show-in-status`), no duplicate keys across fragments, fragments cannot redefine core keys, the generated `features.<id>.enabled` key exists for every manifest. The hand count test (`config.rs` `agent.len() == 12`) is replaced by "every fragment parses and each key has type, default and label". The accepted settings ADR is refined: the contract is the merged schema (ADR Q11, decided: the ADR carries a "Supersedes" section; the old ADR's status is set to superseded when this ADR is accepted).

### 7.2 Commands, palette and keybinding collisions

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

| Event               | Fires when                                                 | Typical use                                                           |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `onStartup`         | app start, before first paint                              | only `mouse-buttons` (native hook must exist early) and nothing heavy |
| `onWorkspaceOpen`   | a window gets a workspace root                             | agent services, Obsidian host                                         |
| `onCommand:<id>`    | the command runs from palette, shortcut or menu            | agent toggle, table commands                                          |
| `onFileKind:<kind>` | a page of that kind is about to open (`base`, `code`, ...) | Bases views, code editor                                              |
| `onView:<id>`       | a dock, pane or settings block is about to render          | agent pane, Features settings group                                   |

Rules, all enforced by the host and checked by tests:

1. **Not activated means not loaded.** Static contributions (command labels, keybindings, menu entries, status item stubs) come from the manifest and cost a few bytes; the `load: () => import(...)` thunk is never called until needed, so no JS chunk, no store, no subscription, no `listen` exists. The host exposes `isActive(id)` and the Features section shows it.
2. **Not activated means no Rust background work.** `Feature::setup` registers state cheaply (an empty struct) and must not spawn threads, watchers, processes or open SQLite handles; those start in `on_workspace_open` or on the first command (a `start` the feature owns), and only when the feature is enabled. A disabled feature is never added as a Tauri plugin, so its commands and state do not exist (restart needed).
3. **Deactivation frees what activation created.** `ctx.disposables` (listeners, subscriptions, registry entries, timers, abort controllers) disposes in reverse order; the Rust side implements `on_workspace_close`/`on_exit` to stop what it started. The Zustand store a feature owns is reset on deactivate so its state is collectable. A fixture test activates then deactivates a feature and asserts the registry, listener and timer counts return to their baseline.
4. **Measurement.** `lib/startup-metrics.ts` gains `featureActivation` marks (activate duration, chunk load); a dev-only "Features" row shows RSS before and after activate/deactivate for the pilots so the claim is checked, not assumed.

### 7.8 The Features settings section

A new Settings section **Features** (group "General"), generated from the manifests: no per-feature code in `settings-sections.ts`. It is the one place where the merged-schema contract (section 7.1) is visible: every feature ships its own settings fragment and the UI renders it under that feature.

Contribution: the host appends `{ id: "features", label: "Features", group: "General", blocks: [{ type: "features" }] }` to `SETTINGS_SECTIONS` once (a single core entry) and registers one renderer in `settings-blocks.tsx`; the block lists `FeatureHost.list()`. A feature may also ask for its own dedicated section (`contributes.settingsSection`) for large settings (the agent section); the Features list then links to it instead of repeating it.

Per feature row:

- **Toggle** bound to the generated `features.<id>.enabled` setting (global scope). Core editing, tabs and the sidebar are not features and do not appear.
- **Status**: `active`, `inactive` (enabled, not yet activated: lazy), `disabled` (switched off), or `failed` with the logged error (from `logger`, never note contents) and a "Copy error" and "Retry" action.
- **Memory note**: from the manifest (`"memory": { "level": "low|medium|high", "note": "Loads the editor chunk on first table; no background work." }`) plus the live `active/inactive` state, so users see why disabling helps. The note is data in `feature.json` (a manifest field to add in section 2), not UI code.
- **Restart note**: shown when the feature has a Rust half (`rust.commands` or hooks non-empty) and its enabled state differs from the state the app started with: "Takes effect after restart. The interface part switched now."
- **Dependencies**: "Needs: agent" or "Required by: ..."; turning off a feature that others depend on lists the dependents that will be disabled too and asks for confirmation (one confirm dialog, the existing pattern).
- **Its own settings**, grouped under it: the fragment's entries rendered by the same `SettingControl` the other sections use, so no second renderer (DRY). Collapsed by default; disabled features show their settings greyed but readable.

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

- Built-ins call the contribution points directly. They never import `lib/obsidian-host/api/*` shims.
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

| Step | Commit(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Acceptance checks                                                                                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Spike branch: `InlinedPlugin` with one command, capability, `app.plugin()` in `setup`, capability glob. Notes in this spec. No product change.                                                                                                                                                                                                                                                                                                                                                                                                      | Written answers to section 5.4 (i)-(iii); decision recorded in the ADR (accept or fall back to C + trait).                                                                                                                                                                                                                                                   |
| 1a   | `src/lib/features/` (types, host, registry, lifecycle, error isolation), `features/` folder, glob loader, contract test with the failing fixture. Empty.                                                                                                                                                                                                                                                                                                                                                                                            | `vp check`, `vp test`; the fixture feature is disabled and logged; app boots unchanged.                                                                                                                                                                                                                                                                      |
| 1b   | Keybinding registry replaces the `if` chain in `use-keyboard-shortcuts.ts` (core bindings declared as data); conflict test; generated shortcut tables behind markers.                                                                                                                                                                                                                                                                                                                                                                               | Existing shortcut tests pass unchanged; `docs/keyboard-shortcuts.md` diff is zero apart from markers; conflict test catches an injected duplicate.                                                                                                                                                                                                           |
| 1c   | Features settings section (7.8) and `features.<id>.enabled` generation; open `Location` union (declaration merging) and lazy page-kind views; dock registry for the agent/plugin pane; editor-extension registry; palette registry fed by contributions while `BUILTIN_COMMANDS` stays as the core list.                                                                                                                                                                                                                                            | `command-registry.test.ts` unchanged and green; `app-layout.tsx` has no feature-specific import; the editor test suite passes.                                                                                                                                                                                                                               |
| 2    | **Pilot 1 `tables`** (TS-only): move `table-decorations`, `table-editing`, `table-commands`, context-menu items, settings keys into `features/tables/`.                                                                                                                                                                                                                                                                                                                                                                                             | `table-*` tests pass from the new folder; `createEditorExtensions` has no table import; startup chunk no longer contains table code (build chunk list).                                                                                                                                                                                                      |
| 3    | Rust: `Feature` trait, `features::ALL`, runner in `lib.rs`; merged index DDL, CLI table and skills from the trait. **Pilot 2 `mouse-buttons`**: `macos_mouse.rs`, `use-mouse-navigation.ts`, the setting/env, spec.                                                                                                                                                                                                                                                                                                                                 | `cargo test`, `sync_commands_are_allowlisted`; with `features.mouse-buttons.enabled=false` the monitor is never installed; a forced `setup` error is logged and the app starts; e2e smoke.                                                                                                                                                                   |
| 4    | `build.rs` reads manifests (`InlinedPlugin`), per-feature capability, `tauri-specta`, `specta` and `specta-typescript` dependencies added (needs the user's explicit go; `#[specta::specta]`, collected commands and events, and the `bindings` diff test per feature), `ipc.ts` clients, settings fragments merged. **Pilot 3 `agent`**: commands, `AgentSessions` state, exit hook, skills, 12 settings, dock, `Cmd+Shift+A`, palette commands. Done as sub-steps: settings fragment, then TS contributions, then Rust hooks, then commands last. | `agent_*` tests, `agent_fake_claude.rs`, goldens, e2e fake-claude spec pass; `lib.rs` no longer lists agent commands or state; `config.rs` count test replaced; `git diff --stat` for a scripted `word-count` add touches only `features/word-count/` and `features/mod.rs`; the agent appears in Settings > Features with its 12 settings grouped under it. |
| 5    | `obsidian-host` (decided, last, pure lifecycle wrapper), then by value: `bases`, `projects`, `code-files` (with a `code-files` service for sidebar/index/watcher), `docs/features.md` generator; slim-build flags; crate extraction of pure cores.                                                                                                                                                                                                                                                                                                  | Each is its own ADR-free move under this ADR unless it changes a boundary; verify with the feature's own tests plus the contract test.                                                                                                                                                                                                                       |

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
| `#[path]` mounts confuse rust-analyzer or tooling                                  | Check in the spike; fall back to colocated layout (ADR question 10)                                                                     |
| Two concepts named "plugin" confuse users and agents                               | Code name `feature`; never in user-facing text; AGENTS.md has one paragraph                                                             |
| Kill switch leaves Rust state alive until restart                                  | Decided: every feature is switchable; the Features section shows a restart note for the Rust half; lazy start keeps idle cost near zero |
| Settings ADR wording ("one file") superseded                                       | Open question 11; supersede in the acceptance PR                                                                                        |
| Index schema hash makes every feature toggle rebuild the index                     | Hash only the DDL of **registered** features regardless of the toggle, so toggling does not rebuild                                     |

## 14. Non-goals

A Cargo workspace or crate per feature (ADR Q1, decided no, including the `writer-core` extraction for now); a third-party or community plugin API for these features; sandboxing first-party code; WASM; runtime-loaded features; a visual marketplace for built-ins; moving `bases`, `index`, `relocate` into crates in this change; typed generation for features that have not migrated yet (adoption is per feature, `agent` first; revisit and exit triggers in the ADR); a generated runtime imported directly by feature code (only `ipc.ts` wrappers may import it); changing the Obsidian shim.

## 15. Status and next step

Proposed. Next: the maintainers answer the ADR's open questions; Step 0 spike (half a day) decides the Tauri plugin path. Tracked in [`TODOS.md`](../TODOS.md) ("Built-in plugins").
