// Link activation: every clickable reference opens the way a browser link opens
// (SPECs/link-activation-spec.md). This module owns the gesture table (`linkIntent`), the
// actions (`activateLink`) and the three bindings (React, plain DOM, CodeMirror). No component
// hand-writes `button === 1` or `auxclick` for a link; tabs (middle-click closes) are the one
// exception, and `tests/link-activation-inventory.test.ts` enforces both.
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EditorView } from "@codemirror/view";
import { EditorView as CMEditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { MouseEvent as ReactMouseEvent } from "react";
import { navigateToFile, openFileInNewTab } from "@/hooks/editor-api";
import { detectPlatform, type Platform } from "@/lib/platform";

/** What a gesture asks for: the current tab, a new tab in the background, or a new active tab. */
export type LinkIntent = "current" | "new-tab-background" | "new-tab-active";

export type LinkTarget =
  | { kind: "note" | "file"; path: string }
  | { kind: "url"; href: string }
  /** A target that needs resolving first (a wiki link): it opens itself for the intent, using
   *  `openPath` once it knows the path. */
  | { kind: "custom"; open: (intent: LinkIntent) => void };

interface Gesture {
  button?: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

const MIDDLE = 1;

function modifierIntent(g: Gesture, platform: Platform): LinkIntent {
  // Ctrl+click is the context menu on macOS, so only Cmd counts there.
  const mod = platform === "macos" ? g.metaKey : g.ctrlKey;
  if (!mod) return "current";
  return g.shiftKey ? "new-tab-active" : "new-tab-background";
}

/** The one gesture table: left click, middle click and Cmd/Ctrl(+Shift)+click; null for any
 *  other button. */
export function linkIntent(g: Gesture, platform: Platform = detectPlatform()): LinkIntent | null {
  const button = g.button ?? 0;
  if (button === MIDDLE) return "new-tab-background";
  if (button !== 0) return null;
  return modifierIntent(g, platform);
}

/** The keyboard twin: `Enter` is a left click, `Cmd/Ctrl+Enter` a modifier click. */
export function keyIntent(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
  platform: Platform = detectPlatform(),
): LinkIntent | null {
  return e.key === "Enter" ? modifierIntent(e, platform) : null;
}

/** A note or file path through the editor store's one open path. */
export async function openPath(path: string, intent: LinkIntent): Promise<void> {
  if (intent === "current") await navigateToFile(path);
  else await openFileInNewTab(path, { activate: intent === "new-tab-active" });
}

/** An http(s)/mailto URL in the system browser, whatever the gesture. */
export function openExternal(href: string): void {
  void openUrl(href);
}

const EXTERNAL = /^(https?:|mailto:)/i;
export const isExternalHref = (href: string | null | undefined): href is string =>
  !!href && EXTERNAL.test(href);

export function activateLink(target: LinkTarget, intent: LinkIntent): void {
  switch (target.kind) {
    case "note":
    case "file":
      void openPath(target.path, intent);
      return;
    case "url":
      openExternal(target.href);
      return;
    case "custom":
      target.open(intent);
  }
}

// -- React ------------------------------------------------------------------

export interface LinkHandlerOptions {
  /** Only the middle button opens the link: for a row whose left and modifier clicks mean
   *  something else (the file tree selects on Cmd/Shift+click, a cmdk item selects on click). */
  middleOnly?: boolean;
}

/** Event props for a React element that is a link to `target`: spread them on it. A middle
 *  `mousedown` is claimed so the webview never autoscrolls or pastes. Enter on a focused button
 *  or anchor is a native click carrying its modifiers, so it needs no key handler. */
export function linkHandlers(target: LinkTarget, options: LinkHandlerOptions = {}) {
  const run = (e: ReactMouseEvent) => {
    const intent = linkIntent(e);
    if (!intent) return;
    if (options.middleOnly && e.button !== MIDDLE) return;
    e.preventDefault();
    e.stopPropagation();
    activateLink(target, intent);
  };
  return {
    onClick: run,
    onAuxClick: run,
    onMouseDown: (e: ReactMouseEvent) => {
      if (e.button === MIDDLE) e.preventDefault();
    },
  };
}

// -- Plain DOM ----------------------------------------------------------------

/** A delegated listener for rendered HTML: `resolve(el)` maps the clicked element to a target
 *  (or null to leave the event alone). Returns the disposer. */
export function bindLinkActivation(
  container: HTMLElement,
  resolve: (el: Element) => LinkTarget | null,
): () => void {
  const hit = (e: MouseEvent): LinkTarget | null => {
    const el = e.target instanceof Element ? e.target : null;
    return el && container.contains(el) ? resolve(el) : null;
  };
  const run = (e: MouseEvent) => {
    if (e.defaultPrevented) return; // something inside already handled it (a plugin's own UI)
    const target = hit(e);
    const intent = linkIntent(e);
    if (!target || !intent) return;
    e.preventDefault();
    activateLink(target, intent);
  };
  const down = (e: MouseEvent) => {
    if (e.button === MIDDLE && hit(e)) e.preventDefault();
  };
  container.addEventListener("click", run);
  container.addEventListener("auxclick", run);
  container.addEventListener("mousedown", down);
  return () => {
    container.removeEventListener("click", run);
    container.removeEventListener("auxclick", run);
    container.removeEventListener("mousedown", down);
  };
}

// -- CodeMirror ---------------------------------------------------------------

/** The CodeMirror binding: `resolve(event, view)` maps a pointer event to a target or null.
 *  Presses on a link are claimed on mousedown (the caret stays put, no autoscroll); the action
 *  runs on click and auxclick. */
export function linkActivationExtension(
  resolve: (event: MouseEvent, view: EditorView) => LinkTarget | null,
): Extension {
  const run = (event: MouseEvent, view: EditorView): boolean => {
    const intent = linkIntent(event);
    if (!intent) return false;
    const target = resolve(event, view);
    if (!target) return false;
    event.preventDefault();
    event.stopPropagation();
    activateLink(target, intent);
    return true;
  };
  return CMEditorView.domEventHandlers({
    mousedown(event, view) {
      if (!linkIntent(event) || !resolve(event, view)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    click: run,
    auxclick: run,
  });
}
