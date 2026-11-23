---
status: accepted
date: 2026-11-23
decision-makers: Writer maintainers
---

# Call the generated commands from each feature's web ipc.ts and guard it with tests

Supersedes the wrapper-mechanism sentence of [2026-11-17 Build first-party features as built-in plugins](2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md) ("features call the generated code only through a thin hand-written wrapper (`web/ipc.ts`, `featureInvoke`, ...) and never import the generated runtime directly"). Spec: [`SPECs/builtin-plugins-spec.md`](../../SPECs/builtin-plugins-spec.md) 6.4.

## Context and Problem Statement

`featureInvoke` took a hand-typed args map per command. Tauri reads command arguments by their camelCase names, so a snake_case key (`link_existing`, `chat_id`, `final_path` in the git feature) is dropped and the Rust command fails at runtime; types and review did not catch it. The tauri-specta bindings already carry the route, the argument names and the types, generated from the Rust signatures.

## Considered Options

- A. `web/ipc.ts` calls the generated `commands.*`; a shared test pins every wrapper to the bindings and the manifest; a guard test keeps `ipc.ts` the only way in.
- B. Keep `featureInvoke` and its maps, and test the keys against the bindings.
- C. Generate a typed object-argument client.

## Decision Outcome

Chosen: **A**.

1. A feature's web half reaches its commands only through `web/ipc.ts`, which calls the generated `commands.*` (no second args type, no hand-typed route or key).
2. The one exception is the agent's object-argument client (`callAgent`, `featureInvoke` over `AgentCommands`): about 45 commands and every call site pass an object, and the generated functions are positional. Its keys and values are pinned command by command against the bindings by the same helper.
3. Enforced by tests: `describeFeatureIpc` (`tests/helpers/feature-ipc.ts`) drives every wrapper through `mockIPC` and asserts the route, the command set against the manifest, the argument names against the bindings and the value of each argument (a distinct sentinel each, so swapped same-typed arguments fail); `tests/feature-ipc-guard.test.ts` fails when a feature with commands has no such test, when a file other than `ipc.ts` imports the bindings, `invoke` or `featureInvoke`, or when a plugin route is built by hand. `tests/core-ipc-keys.test.ts` does the same for core commands against the Rust parameter names.

### Consequences

- Good: a wrong key or a swapped argument fails a test; the Rust signature is the single source of truth.
- Bad: the call sites of the generated functions are positional; the exception for the agent stays hand-typed, pinned by tests.
- The generated runtime is now imported by `ipc.ts`; the exit cost to `ts-rs` types only stays bounded to those files.
