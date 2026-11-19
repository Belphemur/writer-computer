// The one full-screen shell (docs/design.md, overlays): the Mermaid, table and drawing full
// screens are content in it. It owns what they shared and must not drift on: an opaque panel over a
// dimmed backdrop, a header (title, the caller's actions, a close button), Esc and a backdrop press
// to close, the focus captured on open and restored on close, one overlay at a time, and closing
// with the editor that opened it. A plain div, not a `<dialog>`, so layering and events stay ours.
// Imperative on purpose: the CodeMirror widgets that open it are not React.
import { ViewPlugin, type EditorView } from "@codemirror/view";
import "./fullscreen-overlay.css";

export interface FullscreenOptions {
  /** The dialog's accessible name. */
  label: string;
  /** What the header shows on the left (`panel` only). */
  title?: string;
  /** `panel` (default): a panel with a header. `bare`: the body fills the window and the caller
   *  draws its own controls and close (it gets `close` back). */
  variant?: "panel" | "bare";
  /** An extra class on the overlay, for the surface's own rules. */
  className?: string;
  /** The editor that opened it: closing it (`closeFullscreenOwnedBy`, `closeFullscreenWithEditor`)
   *  closes the overlay, and it takes focus back if the previous focus is gone. */
  owner?: EditorView;
  /** Milliseconds the exit animation takes: the overlay leaves the DOM after them. 0: at once. */
  exitMs?: number;
  /** Asked on Esc: false leaves that key to the content (a menu or a text box handles it first). */
  allowEscape?: (e: KeyboardEvent) => boolean;
  /** Runs first when it closes, the content still mounted (commit, flush, unmount). */
  onClose?: () => void;
}

export interface FullscreenHandle {
  overlay: HTMLElement;
  /** Where the content goes. */
  body: HTMLElement;
  /** The header's slot for buttons (`panel` only; null in `bare`). Style them `writer-fullscreen-action`. */
  actions: HTMLElement | null;
  close: () => void;
}

interface Open extends FullscreenHandle {
  owner: EditorView | undefined;
}

let current: Open | null = null;

export function isFullscreenOpen(): boolean {
  return current !== null;
}

export function closeFullscreen(): void {
  current?.close();
}

/** Close the overlay if `owner` opened it. */
export function closeFullscreenOwnedBy(owner: EditorView): void {
  if (current?.owner === owner) current.close();
}

/** An editor extension: the overlay it opened closes when the editor is destroyed (its note or tab
 *  closes). */
export function closeFullscreenWithEditor() {
  return ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {}
      destroy() {
        closeFullscreenOwnedBy(this.view);
      }
    },
  );
}

export function openFullscreen(options: FullscreenOptions): FullscreenHandle {
  closeFullscreen();
  const bare = options.variant === "bare";
  const exitMs = options.exitMs ?? 0;

  const overlay = document.createElement("div");
  overlay.className = ["writer-fullscreen", options.className].filter(Boolean).join(" ");
  overlay.dataset.variant = bare ? "bare" : "panel";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", options.label);
  overlay.tabIndex = -1;

  const body = document.createElement("div");
  body.className = "writer-fullscreen-body";
  let actions: HTMLElement | null = null;
  let closeButton: HTMLButtonElement | null = null;
  if (bare) {
    overlay.append(body);
  } else {
    const panel = overlay.appendChild(document.createElement("div"));
    panel.className = "writer-fullscreen-panel";
    const bar = panel.appendChild(document.createElement("div"));
    bar.className = "writer-fullscreen-bar";
    const title = bar.appendChild(document.createElement("span"));
    title.className = "writer-fullscreen-title";
    title.textContent = options.title ?? "";
    actions = bar.appendChild(document.createElement("div"));
    actions.className = "writer-fullscreen-actions";
    closeButton = bar.appendChild(document.createElement("button"));
    closeButton.type = "button";
    closeButton.className = "writer-fullscreen-close";
    closeButton.textContent = "Close";
    closeButton.setAttribute("aria-label", `Close ${options.label.toLowerCase()}`);
    panel.append(body);
  }

  // Whatever had focus, so the editor is not left blurred (a blurred contentDOM makes the next
  // click race CodeMirror's selection sync).
  const restoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let closed = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || options.allowEscape?.(e) === false) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  function close() {
    if (closed) return;
    closed = true;
    if (current === handle) current = null;
    document.removeEventListener("keydown", onKey, true);
    options.onClose?.();
    const finish = () => overlay.remove();
    if (exitMs > 0) {
      overlay.classList.remove("is-open");
      setTimeout(finish, exitMs);
    } else {
      finish();
    }
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    else if (options.owner?.dom.isConnected) options.owner.focus();
  }

  closeButton?.addEventListener("click", close);
  // Capture phase: Esc dismisses before any inner handler (CodeMirror, Excalidraw) sees it.
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  const handle: Open = { overlay, body, actions, close, owner: options.owner };
  current = handle;
  document.body.append(overlay);
  overlay.focus({ preventScroll: true });
  // The browser commits the closed state first, so the fade has a start.
  if (typeof requestAnimationFrame === "function")
    requestAnimationFrame(() => overlay.classList.add("is-open"));
  else overlay.classList.add("is-open");
  return handle;
}
