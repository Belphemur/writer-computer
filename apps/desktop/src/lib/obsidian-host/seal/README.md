# Tauri seal

`sealTauri()` runs once, before the first plugin `<script>` is requested. It captures the real
`window.__TAURI_INTERNALS__` in a closure, installs a frozen, non-configurable stand-in, and
deletes `window.__TAURI__`. The stand-in's `invoke` forwards only an allowlist of `plugin:*`
commands that the app's dependencies (event, window, menu, dialog, opener, clipboard, store) issue
through the global; everything else rejects with `SealViolationError`. Writer's own commands go
through `hostInvoke`, which holds the captured original.

Why not "allow only when called from host code": app calls are async and arrive from arbitrary
stacks, and plugin calls can be laundered through `queueMicrotask(invoke.bind(...))` (no plugin
frame on the stack). A synchronous host flag cannot tell the two apart. Capability by reference
(only host code holds `hostInvoke`) is the one check that does not depend on the call stack.

## This is not a sandbox

Plugins share the page's realm. Known bypasses, none closed by this module:

- `fetch("ipc://localhost/<cmd>")` (or `http://ipc.localhost`) and, on macOS,
  `window.webkit.messageHandlers.ipc.postMessage(...)` reach the native IPC without the JS object.
  CSP `connect-src` must keep `ipc:` for the app itself. The real defence is Rust-side
  (`authorize_path`, per-command checks, native consent); treat every command as plugin-callable.
- A same-origin iframe or `window.open` gets a fresh realm without the seal, but Tauri's
  injected init script re-creates `__TAURI_INTERNALS__` there. Not blocked in JS.
- `import()` of the app's own hashed chunk URL returns the module namespace, including
  `hostInvoke`. Keep it out of the entry chunk's public exports where possible.
- Prototype pollution (`Promise.prototype.then`, `Array.prototype`, `JSON.parse`) can observe
  or alter host arguments and results.
- Allowlisted commands remain callable by plugins (clipboard, dialog, store `preferences.json`,
  opener). Narrowed by argument checks, not removed.

Plugin scripts are served only for a trusted vault; the seal limits accidents and casual abuse.
