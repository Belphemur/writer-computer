// @vitest-environment jsdom
// The one keyboard behaviour of popover menus: first focus on the first enabled item (the checked
// one when enabled), arrows that skip disabled items and wrap, Esc and Tab closing, and focus
// back on the anchor when the menu goes away.
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useMenuKeyboard } from "@/hooks/use-menu-keyboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Menu({ checked }: { checked?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const onKeyDown = useMenuKeyboard(body, {
    onClose: () => setOpen(false),
    returnFocusTo: anchor,
    open,
  });
  return (
    <div onKeyDown={onKeyDown}>
      <button ref={anchor} data-anchor onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <div ref={body} role="menu">
          <button role="menuitem" disabled data-i="off0">
            off0
          </button>
          <button role="menuitemradio" aria-checked={checked === "a"} data-i="a">
            a
          </button>
          <button role="menuitem" disabled data-i="off1">
            off1
          </button>
          <button role="menuitemradio" aria-checked={checked === "b"} data-i="b">
            b
          </button>
          <button role="menuitemradio" aria-checked={checked === "off2"} disabled data-i="off2">
            off2
          </button>
        </div>
      )}
    </div>
  );
}

describe("useMenuKeyboard", () => {
  let container: HTMLElement;
  let root: Root;
  const q = (s: string) => container.querySelector<HTMLElement>(s)!;
  const at = () => (document.activeElement as HTMLElement).dataset.i;
  const key = (k: string) =>
    act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
      );
    });
  const open = async (checked?: string) => {
    await act(async () => root.render(<Menu checked={checked} />));
    q("[data-anchor]").focus();
    await act(async () => q("[data-anchor]").click());
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("focuses the first enabled item, or the checked one when it is enabled", async () => {
    await open();
    expect(at()).toBe("a");
    await act(async () => root.unmount());
    root = createRoot(container);
    await open("b");
    expect(at()).toBe("b");
    // a checked item that is disabled is not preferred
    await act(async () => root.unmount());
    root = createRoot(container);
    await open("off2");
    expect(at()).toBe("a");
  });

  it("arrows skip disabled items and wrap around", async () => {
    await open();
    await key("ArrowDown");
    expect(at()).toBe("b");
    await key("ArrowDown");
    expect(at()).toBe("a");
    await key("ArrowUp");
    expect(at()).toBe("b");
  });

  it("Esc closes the menu and focus returns to the anchor", async () => {
    await open();
    await key("Escape");
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(q("[data-anchor]"));
  });

  it("Tab closes it too", async () => {
    await open();
    await key("Tab");
    expect(container.querySelector("[role=menu]")).toBeNull();
  });
});
