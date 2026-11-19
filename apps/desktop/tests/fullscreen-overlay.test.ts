// @vitest-environment jsdom
// The shared full-screen shell (`src/lib/fullscreen-overlay.ts`, docs/design.md overlays): open,
// each way to close, focus capture and restore, one at a time, the actions slot, the bare variant
// and closing with the owning editor. The Mermaid, table and drawing full screens are tested on
// top of it in their own suites.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  closeFullscreen,
  closeFullscreenOwnedBy,
  closeFullscreenWithEditor,
  isFullscreenOpen,
  openFullscreen,
} from "../src/lib/fullscreen-overlay";

const overlays = () => document.querySelectorAll(".writer-fullscreen");
const esc = (target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

afterEach(() => {
  closeFullscreen();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("openFullscreen", () => {
  it("is an opaque panel dialog with a title, an actions slot and a close button", () => {
    const h = openFullscreen({ label: "Drawing a", title: "a", className: "mine" });
    const o = overlays()[0]!;
    expect(o).toBe(h.overlay);
    expect(o.classList.contains("mine")).toBe(true);
    expect(o.getAttribute("role")).toBe("dialog");
    expect(o.getAttribute("aria-modal")).toBe("true");
    expect(o.getAttribute("aria-label")).toBe("Drawing a");
    expect(o.querySelector(".writer-fullscreen-title")!.textContent).toBe("a");
    expect(h.actions).not.toBeNull();
    expect(h.body.parentElement!.classList.contains("writer-fullscreen-panel")).toBe(true);
    expect(isFullscreenOpen()).toBe(true);
  });

  it("closes with Esc, the close button and a backdrop press, and not with a press inside", () => {
    const onClose = vi.fn();
    const h = openFullscreen({ label: "x", onClose });
    h.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(overlays()).toHaveLength(1);
    esc();
    expect(overlays()).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);

    openFullscreen({ label: "x" })
      .overlay.querySelector<HTMLButtonElement>(".writer-fullscreen-close")!
      .click();
    expect(overlays()).toHaveLength(0);

    openFullscreen({ label: "x" }).overlay.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    expect(overlays()).toHaveLength(0);
    expect(isFullscreenOpen()).toBe(false);
  });

  it("Esc is taken before inner handlers, unless allowEscape says the content has it", () => {
    let content = true;
    const inner = vi.fn();
    const h = openFullscreen({ label: "x", allowEscape: () => !content });
    h.body.addEventListener("keydown", inner);
    esc(h.body);
    expect(overlays()).toHaveLength(1);
    expect(inner).toHaveBeenCalledTimes(1);
    content = false;
    esc(h.body);
    expect(overlays()).toHaveLength(0);
    expect(inner).toHaveBeenCalledTimes(1); // stopped in the capture phase
  });

  it("captures the focus on open and restores it on close", () => {
    const before = document.body.appendChild(document.createElement("button"));
    before.focus();
    const h = openFullscreen({ label: "x" });
    expect(document.activeElement).toBe(h.overlay);
    h.close();
    expect(document.activeElement).toBe(before);
  });

  it("falls back to the owning editor when the previous focus is gone", () => {
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({ parent, state: EditorState.create({ doc: "x" }) });
    const gone = document.body.appendChild(document.createElement("button"));
    gone.focus();
    openFullscreen({ label: "x", owner: view });
    gone.remove();
    closeFullscreen();
    expect(document.activeElement).toBe(view.contentDOM);
    view.destroy();
  });

  it("is one at a time: opening a second closes the first (its onClose runs)", () => {
    const first = vi.fn();
    openFullscreen({ label: "one", onClose: first });
    openFullscreen({ label: "two" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]!.getAttribute("aria-label")).toBe("two");
  });

  it("closing twice runs onClose once", () => {
    const onClose = vi.fn();
    const h = openFullscreen({ label: "x", onClose });
    h.close();
    h.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("bare has no header: the body fills the window and the caller closes", () => {
    const h = openFullscreen({ label: "x", variant: "bare" });
    expect(h.actions).toBeNull();
    expect(h.overlay.querySelector(".writer-fullscreen-bar")).toBeNull();
    expect(h.body.parentElement).toBe(h.overlay);
    esc();
    expect(overlays()).toHaveLength(0);
  });

  it("an exit animation keeps the overlay until it ends", () => {
    vi.useFakeTimers();
    const h = openFullscreen({ label: "x", exitMs: 240 });
    h.close();
    expect(h.overlay.classList.contains("is-open")).toBe(false);
    expect(overlays()).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(overlays()).toHaveLength(0);
  });
});

describe("ownership", () => {
  function editor(extensions = [] as never[]) {
    const parent = document.body.appendChild(document.createElement("div"));
    return new EditorView({ parent, state: EditorState.create({ doc: "x", extensions }) });
  }

  it("closeFullscreenOwnedBy closes only its own editor's overlay", () => {
    const a = editor();
    const b = editor();
    openFullscreen({ label: "x", owner: a });
    closeFullscreenOwnedBy(b);
    expect(overlays()).toHaveLength(1);
    closeFullscreenOwnedBy(a);
    expect(overlays()).toHaveLength(0);
    a.destroy();
    b.destroy();
  });

  it("closeFullscreenWithEditor closes it when the editor is destroyed", () => {
    const view = editor([closeFullscreenWithEditor()] as never[]);
    openFullscreen({ label: "x", owner: view });
    view.destroy();
    expect(overlays()).toHaveLength(0);
  });
});
