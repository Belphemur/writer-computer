// @vitest-environment jsdom
// The one modal keyboard model: initial focus, Escape, the Tab trap (both directions) and focus
// restore. Every modal in the app renders through `ModalShell`, so this covers them all.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ModalShell } from "@/components/modal-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let opener: HTMLButtonElement;
beforeEach(() => {
  opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  opener.remove();
});

const press = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
};
const card = () => document.querySelector<HTMLElement>("[role=dialog]")!;
const field = (id: string) => document.getElementById(id) as HTMLElement;

function Body() {
  return (
    <>
      <button id="a">A</button>
      <input id="b" />
      <button id="c">C</button>
    </>
  );
}

function render(props: Partial<React.ComponentProps<typeof ModalShell>> = {}) {
  const onClose = vi.fn();
  act(() =>
    root.render(
      <ModalShell labelledBy="t" onClose={onClose} className="x" {...props}>
        <h2 id="t">Title</h2>
        <Body />
      </ModalShell>,
    ),
  );
  return onClose;
}

describe("ModalShell", () => {
  it("renders a labelled modal dialog", () => {
    render({ describedBy: "t" });
    expect(card().getAttribute("aria-modal")).toBe("true");
    expect(card().getAttribute("aria-labelledby")).toBe("t");
    expect(card().getAttribute("aria-describedby")).toBe("t");
  });

  it("focuses the card by default, a given element, or nothing", () => {
    render();
    expect(document.activeElement).toBe(card());
    act(() => root.render(null));
    opener.focus();
    const ref = { current: null as HTMLElement | null };
    function Focused() {
      return (
        <ModalShell labelledBy="t" onClose={() => {}} className="x" initialFocus={ref}>
          <input id="b" ref={(el) => void (ref.current = el)} />
        </ModalShell>
      );
    }
    act(() => root.render(<Focused />));
    expect(document.activeElement).toBe(field("b"));
    act(() => root.render(null));
    opener.focus();
    render({ initialFocus: false });
    expect(document.activeElement).toBe(opener);
  });

  it("Escape closes, is swallowed, and can be ignored per event", () => {
    const onClose = render({ ignoreEscape: (e) => e.target === field("b") });
    field("b").focus();
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    field("a").focus();
    const event = press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab wraps from the last element to the first and Shift+Tab the other way", () => {
    render();
    field("c").focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field("a"));
    expect(press("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field("c"));
    // Shift+Tab from the card itself also wraps to the end.
    card().focus();
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(field("c"));
  });

  it("Tab in the middle is left to the browser, and focus outside is pulled in", () => {
    render();
    field("b").focus();
    expect(press("Tab").defaultPrevented).toBe(false);
    opener.focus();
    press("Tab");
    expect(document.activeElement).toBe(field("a"));
    opener.focus();
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(field("c"));
  });

  it("closes on a backdrop press unless told not to; a card press never closes", () => {
    const onClose = render();
    const backdrop = card().parentElement!;
    act(() => {
      card().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    const sticky = render({ dismissOnBackdrop: false });
    act(() => {
      card().parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(sticky).not.toHaveBeenCalled();
  });

  it("hands other keys to onKeyDown, but not Tab or Escape", () => {
    const onKeyDown = vi.fn();
    render({ onKeyDown });
    press("Enter");
    press("Tab");
    press("Escape");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the opener on close, and a new onClose identity does not refocus", () => {
    function Host() {
      const [n, setN] = useState(0);
      return (
        <ModalShell labelledBy="t" onClose={() => setN(n + 1)} className="x">
          <input id="b" />
          <span id="n">{n}</span>
        </ModalShell>
      );
    }
    act(() => root.render(<Host />));
    field("b").focus();
    press("Escape");
    expect(document.activeElement).toBe(field("b"));
    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });
});
