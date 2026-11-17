---
status: accepted
date: 2026-11-17
decision-makers: Antoine
---

# Remove the mouse buttons feature and its native NSEvent monitor

Supersedes [Deliver mouse side buttons with a native NSEvent monitor](2026-11-17-deliver-mouse-side-buttons-with-a-native-nsevent-monitor.md).

## Context and Problem Statement

The native monitor was added because the page seemed not to receive the mouse side buttons. It then aborted the app three times (2026-11-17 02:42Z, 02:57Z and 15:40Z, each `panic in a function that cannot unwind` on the main thread under AppKit's event observers), after the third despite every defence in the previous amendment. A native abort cannot be caught in process under any panic setting. With the feature switched off the side buttons work: the webview delivers them itself.

## Decision

Remove the `mouse-buttons` built-in feature completely: the native monitor (`macos_mouse.rs`), the Rust half, the web handlers for buttons 3 and 4, the setting `features.mouse-buttons.enabled`, the `mouse-buttons:navigate` event and their tests. The side buttons are handled by the webview, with no Writer code. Middle-click behaviours (close a tab, open a link or sidebar file in a new tab) were never part of the feature: they live in core (`editor-tabs.tsx`, `wiki-link-extension.ts`, the sidebar) and stay there. A leftover `features.mouse-buttons.enabled` line in a user's config is an unknown key: it is ignored without a warning and left in place (a test says so).

## Consequences

- Good, because the one crash source is gone; no native event monitor remains in the app.
- Good, because Writer has one feature less to carry, and `block2` and the `exception` feature of `objc2` (used only by the monitor) leave `Cargo.toml`.
- Neutral, because the crash markers and safe mode of the [failure containment ADR](2026-11-17-contain-feature-failures-with-unwinding-panics-and-recover-from-native-crashes-on-next-launch.md) stay: `features::native` is the API for a future native feature, tested with a fixture, and no feature uses it today.
- Bad, because if a platform stops delivering the side buttons to the page, the fix is a new decision, not this feature.

## Alternatives Considered

- Keep the monitor opt-in behind a setting, with crash markers: rejected, the buttons work without it and a monitor that aborts the app has no value to carry.
- Keep only the DOM handlers as a feature: rejected, the webview already navigates, and a handler that duplicates it is dead weight.
- Move the monitor into a helper process: rejected for the same reason as option C of the failure containment ADR.

## More Information

Spec: [`SPECs/mouse-side-buttons-spec.md`](../../SPECs/mouse-side-buttons-spec.md) (marked superseded).
