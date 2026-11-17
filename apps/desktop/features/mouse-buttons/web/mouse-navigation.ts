import { useEditorStore } from "@/stores/editor-store";
import type { Dispose, FeatureContext } from "@/lib/features/types";
import { logger } from "@/lib/logger";

// Mouse side buttons (3 = back, 4 = forward) drive the editor's navigation history; the webview has
// no page history of its own to walk. On macOS WKWebView does not hand the side buttons to the page,
// so Rust (`features/mouse-buttons/rust/macos_mouse.rs`) catches them in an NSEvent monitor and
// emits `mouse-buttons:navigate` to this window. Other webviews deliver them as DOM `mouseup`,
// which is kept as a fallback. Spec: SPECs/mouse-side-buttons-spec.md
/** The event name as the feature context spells it (`mouse-buttons:navigate` on the wire). */
export const NAVIGATE_EVENT = "navigate";
/** A DOM side-button event this soon after a native one is the same press. */
export const NATIVE_DEDUPE_MS = 250;
/** Diagnostics: only the first few events of each kind are logged. */
const LOG_LIMIT = 5;
/** Diagnostics: navigation chords a mouse driver might send instead of button events. */
const CHORD_LOG_LIMIT = 30;
const CHORD_KEYS = new Set(["[", "]", "ArrowLeft", "ArrowRight"]);

type Direction = "back" | "forward";
interface NavigatePayload {
  direction?: string;
}

const logged: Record<string, number> = {};
function logFirst(kind: string, message: string) {
  logged[kind] = (logged[kind] ?? 0) + 1;
  if (logged[kind]! <= LOG_LIMIT) logger.log("info", "app", message);
}

function go(direction: Direction) {
  const { navigateBack, navigateForward } = useEditorStore.getState();
  void (direction === "back" ? navigateBack() : navigateForward());
}

/** Registers the native event listener and the DOM handlers; the returned function removes the DOM ones. */
export function startMouseNavigation(ctx: FeatureContext): Dispose {
  let lastNativeAt = Number.NEGATIVE_INFINITY;

  ctx.listen<NavigatePayload>(NAVIGATE_EVENT, (payload) => {
    const direction = payload?.direction;
    if (direction !== "back" && direction !== "forward") return;
    lastNativeAt = performance.now();
    logFirst(`native-${direction}`, `mouse ${direction} (native)`);
    go(direction);
  });

  function fromDom(e: MouseEvent) {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.type !== "mouseup") return;
    if (performance.now() - lastNativeAt < NATIVE_DEDUPE_MS) return;
    const direction: Direction = e.button === 3 ? "back" : "forward";
    logFirst(`dom-${direction}`, `mouse ${direction} (DOM)`);
    go(direction);
  }
  // Middle button diagnostics: confirms in the log that the DOM sees it (tab close, open in new tab).
  function logMiddle(e: MouseEvent) {
    if (e.button === 1) logFirst("middle", `mouse middle button reached the page (${e.type})`);
  }

  // Does the mouse driver send keystrokes instead of button events? Logs the first few
  // Cmd/Ctrl/Alt + [ ] ArrowLeft ArrowRight presses with their modifiers (never other keys).
  let chordsLogged = 0;
  function logChord(e: KeyboardEvent) {
    if (!CHORD_KEYS.has(e.key) || !(e.metaKey || e.ctrlKey || e.altKey)) return;
    if (chordsLogged++ >= CHORD_LOG_LIMIT) return;
    logger.log(
      "info",
      "app",
      `nav key chord ${e.key} (meta ${e.metaKey}, ctrl ${e.ctrlKey}, alt ${e.altKey}, shift ${e.shiftKey}, repeat ${e.repeat})`,
    );
  }

  window.addEventListener("keydown", logChord, true);
  window.addEventListener("mouseup", fromDom);
  window.addEventListener("auxclick", fromDom);
  window.addEventListener("mousedown", logMiddle);
  return () => {
    window.removeEventListener("keydown", logChord, true);
    window.removeEventListener("mouseup", fromDom);
    window.removeEventListener("auxclick", fromDom);
    window.removeEventListener("mousedown", logMiddle);
  };
}
