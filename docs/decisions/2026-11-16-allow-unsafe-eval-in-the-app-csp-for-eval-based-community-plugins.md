---
status: accepted
date: 2026-11-16
decision-makers: Writer maintainers
---

# Allow unsafe-eval in the app CSP for eval-based community plugins

## Context and Problem Statement

[Serve plugin code over the writer-plugin scheme](2026-11-13-serve-plugin-code-over-the-writer-plugin-scheme.md) kept `'unsafe-eval'` out of the page CSP, and the spec reserved it "for a trusted vault only". The release build then failed two popular community plugins, while dev builds (whose dev server sends no CSP) did not:

- Excalidraw calls `window.eval` on a string to boot its bundled `ExcalidrawLib` (and again for locale packs): `EvalError: Refused to evaluate a string as JavaScript`.
- Templater loads a WebAssembly template engine (`CompileError: Refused to create a WebAssembly object`) whose glue also calls `new Function(...)` to run templates.

Can the page CSP allow evaluation only while a vault is trusted?

## Decision Drivers

- Running unmodified community plugins is the point of the host; the host adapts, plugins are never patched.
- Plugins already run arbitrary JavaScript in the webview once the user trusts a vault, with Node-like shims (`fs`, `child_process`) behind it.
- A narrow CSP still matters for restricted mode and for markdown/HTML rendered from notes.

## Considered Options

- Add `'unsafe-eval' 'wasm-unsafe-eval'` to the static `script-src` (chosen).
- Add only `'wasm-unsafe-eval'`: fixes the Templater compile error but not Excalidraw, and Templater still needs `new Function` once its engine runs.
- Toggle the CSP per vault trust at runtime.
- Run eval-needing plugins in a separate webview or iframe with its own CSP.
- Rewrite `eval` / `new Function` / `WebAssembly` inside the host (shim the globals).

## Decision Outcome

Chosen option: the static `script-src` gains `'unsafe-eval'` and `'wasm-unsafe-eval'` (`'unsafe-eval'` already implies WebAssembly compilation; the second token documents intent and survives a later removal of the first for a WASM-only need).

A per-vault toggle is not possible: Tauri applies `app.security.csp` as a fixed header (with computed hashes and nonces) on the app protocol's responses and offers no runtime API to change it for an existing webview. A second webview or an iframe for plugins would need every plugin API (DOM, editor, workspace) bridged across a boundary, a rewrite of the host. Shimming the globals cannot work: evaluation without the engine's permission is exactly what the CSP forbids, and a userland JS interpreter would not run Excalidraw or WASM-generated `new Function` glue.

### Consequences

- Good, because Excalidraw and Templater can run in release builds like in dev.
- Bad, because the allowance is app-wide and permanent, including restricted mode: `'unsafe-eval'` removes CSP's protection against string-to-code sinks. Restricted mode still loads no plugin code (the `writer-plugin` scheme serves nothing for an untrusted vault), so the exposure is a script-injection bug elsewhere in the page (for example unsanitized rendered note HTML), which previously needed `'unsafe-inline'` or a gadget, and now also has `eval`.
- Bad, because the plugin trust boundary is unchanged but not narrowed by the CSP: trusting a vault already grants arbitrary JS.
- Neutral, because `'unsafe-inline'` was already present in `script-src`, so inline script injection was not blocked either; `connect-src` stays `'self' ipc:`, so eval'd code cannot reach other origins with `fetch`.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/tauri.conf.json` (`app.security.csp`), `apps/desktop/tests/csp-config.test.ts`, comments in `apps/desktop/src/lib/obsidian-host/loader.ts`.
- **Patterns to avoid**: adding `blob:` or `data:` to `script-src`; broadening `connect-src`; using `eval` in Writer's own code.
- **Migration steps**: none; the CSP is baked at build time.

### Verification

- [ ] `tests/csp-config.test.ts` asserts the exact `script-src` tokens.
- [ ] Manual in a release build: enable Excalidraw and Templater in a trusted vault, no `EvalError` / `CompileError` in the local log.

## More Information

Revisit if Tauri gains per-window runtime CSP, or if plugin code moves to its own webview. Excalidraw's blob Web Worker helper probes `new Worker(blob:)` and falls back when refused; `blob:` is deliberately not added.
