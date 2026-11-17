---
status: superseded
date: 2026-11-17
decision-makers: Antoine
---

# Deliver mouse side buttons with a native NSEvent monitor

## Context and Problem Statement

Mouse back/forward buttons (`NSEvent` `otherMouseDown`, `buttonNumber` 3 and 4) did nothing in the release app, and the diagnostics added to the page (`mouseup`, `auxclick`, `mousedown`, `pointerdown`) logged nothing. wry 0.57.2 only forwards these buttons by running JavaScript (`evaluateJavaScript`) that dispatches synthetic `mousedown`/`mouseup` events, so whether a page sees them depends on that path working in the user's setup. Navigation must not depend on it.

## Decision

On macOS, install a process-wide local `NSEvent` monitor (`src-tauri/src/macos_mouse.rs`) for `OtherMouseDown | OtherMouseUp`. For buttons 3 and 4 over a Writer window (`main`, `w-*`) it emits the Tauri event `writer://mouse-navigate` (`{ direction: "back" | "forward" }`) to that window on press and swallows press and release. The frontend hook `use-mouse-navigation.ts` calls the editor store's `navigateBack`/`navigateForward`, with the DOM `mouseup` listener kept as a deduplicated fallback for other webviews. Middle button is not touched. Non-goal: Windows/Linux native handling.

## Amendment (2026-11-17, crash)

The first version resolved the window inside the monitor (`ns_window()` compared with `event.window`) and aborted the app once (`panic in a function that cannot unwind` under `_NSSendEventToObservers`; with `panic = "abort"` the missing Rust panic line means a foreign Objective-C exception crossed the `extern "C"` block). The monitor now does only exception-caught AppKit reads and a channel send; a worker thread does logging, the focused-window lookup and `emit_to`. The `objc2` dependency gains its `exception` feature (its helper crate was already in `Cargo.lock`). Details and diagnostics: `SPECs/mouse-side-buttons-spec.md`.

## Consequences

- Good, because the buttons work whatever the webview does with them, and only for the window under the pointer.
- Good, because the monitor logs the first presses of every extra button, so unusual mice are diagnosable.
- Bad, because the AppKit glue (`NSEvent` monitor, block) cannot be unit tested; only the mapping is.
- Bad, because a monitor sees every other-mouse event of the process.

## Implementation Plan

- **Affected paths**: `src-tauri/src/macos_mouse.rs`, `src-tauri/src/lib.rs`, `src/hooks/use-mouse-navigation.ts`, `src/App.tsx`.
- **Dependencies**: `objc2` feature `exception` (no new crate), `block2 = "0.6.2"` (macOS only), already in `Cargo.lock` through `objc2` and wry; no new crate is downloaded.
- **Patterns to follow**: raw `objc2` helpers as in `macos.rs` and `dock_menu.rs`.
- **Patterns to avoid**: patching wry; per-window gesture recognizers.

### Verification

- [ ] Press the mouse back/forward buttons in a window with tab history; `writer.*.log` shows `mouse back (native)`.

## Alternatives Considered

- Patch or fork wry: rejected, hard to maintain and does not help if its JS path is the problem.
- Subclass the webview and add `otherMouseDown:`: rejected, wry owns that class.
- Rely on the DOM events alone: that was the state that did not work for the user.

2026-11-17: superseded by [Remove the mouse buttons feature and its native NSEvent monitor](2026-11-17-remove-the-mouse-buttons-feature-and-its-native-monitor.md): the monitor aborted the app a third time and the webview delivers the side buttons itself.
