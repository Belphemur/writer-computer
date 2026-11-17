# Mouse side buttons

Status: **superseded.** The built-in feature `mouse-buttons` and its native `NSEvent` monitor were removed on 2026-11-17: the monitor aborted the app three times (2026-11-17 02:42Z, 02:57Z and 15:40Z, `panic in a function that cannot unwind` on the main thread under `_NSSendEventToObservers`; an Objective-C exception crossing the `extern "C"` block, which no panic setting can catch), and with the feature switched off the webview delivers the side buttons itself. Decision: `docs/decisions/2026-11-17-remove-the-mouse-buttons-feature-and-its-native-monitor.md` (it supersedes the monitor ADR).

## What is left

- Back and forward on the mouse side buttons (3 and 4) are the webview's own; Writer has no code for them. Cmd+[ / Cmd+] navigate back and forward outside the note (`docs/keyboard-shortcuts.md`).
- A middle click closes a tab and opens a wiki link or sidebar file in a new tab (DOM `auxclick`, button 1). That was never part of the feature; it lives in core (`editor-tabs.tsx`, `wiki-link-extension.ts`, the sidebar).
- A leftover `features.mouse-buttons.enabled` line in a user's settings file is an unknown key: ignored without a warning and kept on disk (`features::tests::a_stale_line_of_a_removed_feature_is_harmless`).
- The crash markers and safe mode added with the removal (`SPECs/builtin-plugins-spec.md` "Failure containment and recovery") stay: `features::native` is the API for a future native feature; no feature uses it today.
