import { useEffect } from "react";
import "@/lib/keybindings/core-bindings";
import { startHotkeyOverrides } from "@/lib/keybindings/overrides";
import { isKeyRecording } from "@/lib/keybindings/recording";
import { mouseHistoryDirection } from "@/lib/keybindings/mouse-history";
import { keybindings } from "@/lib/keybindings/registry";
import { detectPlatform } from "@/lib/platform";

// One dispatcher over the keybinding registry (`lib/keybindings/core-bindings.ts` lists the app's
// shortcuts, features add theirs). A matched key is always `preventDefault`ed; a binding that must
// let the key through (the editor's Alt+Arrow, Cmd+W in the compact window) declares a `when`
// context instead, so it simply does not match.
function dispatch(phase: "bubble" | "capture") {
  return (e: KeyboardEvent) => {
    if (isKeyRecording()) return; // the Hotkeys page is capturing this key
    const binding = keybindings.find(e, phase);
    if (!binding) return;
    e.preventDefault();
    // Capture-phase bindings must also keep the key from reaching CodeMirror's own handlers.
    if (phase === "capture") e.stopPropagation();
    binding.run(e);
  };
}

/** The side buttons of a mouse, where the page receives them as buttons 3 and 4 (not macOS): they run
 *  the `history-back` / `history-forward` commands of the registry, context and handler included.
 *  The press is swallowed too, so the webview never runs its own history navigation. */
function mouseHistory(e: MouseEvent) {
  if (isKeyRecording()) return;
  const direction = mouseHistoryDirection(e.button, detectPlatform());
  if (!direction) return;
  const id = `history-${direction}`;
  if (!keybindings.holds(id, e)) return;
  e.preventDefault();
  if (e.type === "mouseup") keybindings.invoke(id, e);
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = dispatch("bubble");
    const onCaptureKeyDown = dispatch("capture");
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onCaptureKeyDown, true);
    window.addEventListener("mousedown", mouseHistory);
    window.addEventListener("mouseup", mouseHistory);
    // The user's own keys (`hotkeys.json`) apply on top of the defaults the registry holds.
    const stopOverrides = startHotkeyOverrides();
    return () => {
      stopOverrides();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onCaptureKeyDown, true);
      window.removeEventListener("mousedown", mouseHistory);
      window.removeEventListener("mouseup", mouseHistory);
    };
  }, []);
}
