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
import { getActiveFilePath, navigateToFile, openFileInNewTab } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { consumePendingAnchor, revealAnchorInPlace, setPendingAnchor } from "@/lib/pending-anchor";
import { detectPlatform, type Platform } from "@/lib/platform";
import * as tauri from "@/lib/tauri";
import { resolveWikiLink, type WikiLinkTarget } from "@/lib/wiki-links";

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

/** A note or file path with the anchor its link asked for (a heading slug, a base view name).
 *  The file showing in the current tab is revealed in place; otherwise the anchor is parked for
 *  the editor that loads the file, which takes it when the tab is shown (so a background tab
 *  scrolls when it is activated). */
export async function openPathAtAnchor(
  path: string,
  anchor: string | null | undefined,
  intent: LinkIntent,
): Promise<void> {
  if (!anchor) return openPath(path, intent);
  if (intent === "current" && getActiveFilePath() === path && revealAnchorInPlace(path, anchor)) {
    return;
  }
  setPendingAnchor(path, anchor);
  try {
    await openPath(path, intent);
  } catch (e) {
    consumePendingAnchor(path); // never leave a stale anchor for a later open
    throw e;
  }
}

/** A URL in the system browser, whatever the gesture: the one caller of the opener plugin's
 *  `openUrl`. Core links are not filtered to `EXTERNAL_PROTOCOLS` here (a document may link to
 *  `obsidian://` or `tel:`); the opener's capability scope is the gate. The Obsidian plugin host
 *  deliberately does not use this: its commands are trust-gated and Rust-validated
 *  (`plugin_open_url`, `lib/external-url.ts`). */
export function openExternal(href: string): Promise<void> {
  return openUrl(href);
}

/** Why a wiki link did not open: reported to the caller's UI (a notice, a log), never swallowed. */
export type WikiLinkProblem = "no-workspace" | "unresolved" | "resolve-failed" | "open-failed";

/** Where a problem goes: a notice, a log line. */
export type WikiLinkReport = (problem: WikiLinkProblem, raw: string, error?: unknown) => void;

/** Resolves a wiki link written in `sourcePath` (null: vault-wide) through the vault index; the
 *  one binding of [`resolveWikiLink`] to the backend. */
export function resolveVaultLink(raw: string, sourcePath: string | null): Promise<WikiLinkTarget> {
  return resolveWikiLink(raw, sourcePath, tauri.resolveWikiLinkTarget);
}

/** The target of a wiki link written as `raw` (`Note`, `Note#Heading`, `[[`-less): it resolves
 *  against the note, then opens it at the link's heading for the gesture. The one
 *  path for the editor, rendered cells, the agent pane, property values and Bases cells. */
export function wikiLinkTarget(
  raw: string,
  getSourcePath: () => string | null,
  /** True once the surface that asked is gone (an editor view): nothing is opened or reported. */
  isDisposed: () => boolean = () => false,
  report?: WikiLinkReport,
): LinkTarget {
  const fail = (problem: WikiLinkProblem, error?: unknown) => {
    if (!isDisposed()) report?.(problem, raw, error);
  };
  return {
    kind: "custom",
    open: (intent) => {
      if (!getWorkspaceRoot()) return fail("no-workspace");
      void resolveVaultLink(raw, getSourcePath()).then(
        (result) => {
          if (isDisposed()) return;
          if (result.kind !== "internal") return fail("unresolved");
          return openPathAtAnchor(result.path, result.fragment, intent).catch((e: unknown) =>
            fail("open-failed", e),
          );
        },
        (e: unknown) => fail("resolve-failed", e),
      );
    },
  };
}

export function activateLink(target: LinkTarget, intent: LinkIntent): void {
  switch (target.kind) {
    case "note":
    case "file":
      void openPath(target.path, intent);
      return;
    case "url":
      void openExternal(target.href);
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

export interface BindLinkOptions {
  /** Claim every press on a link on mousedown, not only the middle button: for a link inside
   *  editable content, where a left press would otherwise focus the text and replace the link. */
  claimPress?: boolean;
}

/** A delegated listener for rendered HTML: `resolve(el)` maps the clicked element to a target
 *  (or null to leave the event alone). Returns the disposer. */
export function bindLinkActivation(
  container: HTMLElement,
  resolve: (el: Element) => LinkTarget | null,
  options: BindLinkOptions = {},
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
    if ((e.button === MIDDLE || (options.claimPress && linkIntent(e))) && hit(e))
      e.preventDefault();
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
