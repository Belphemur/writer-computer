// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/lib/obsidian-host/api/app";
import { createHostServices } from "../src/lib/obsidian-host/api/core";
import { installDomHelpers } from "../src/lib/obsidian-host/api/dom";
import { AbstractInputSuggest, EditorSuggest, Menu } from "../src/lib/obsidian-host/api/ui";
import { detachedBridge } from "../src/lib/obsidian-host/api/views";
import { installPopupGuard, NO_CLAMP_ATTR } from "../src/lib/obsidian-host/popup-guard";
import { POPUP_LAYER_ID } from "../src/lib/obsidian-host/popup-layer";
import { createMemoryVaultIo } from "../src/lib/obsidian-host/testing";

beforeAll(() => {
  installDomHelpers();
});

let current = { top: 0, left: 0, width: 0, height: 0 };
/** Every element reports `current` (the popup under test) unless it has its own rect. */
const rects = new WeakMap<Element, { top: number; left: number; width: number; height: number }>();

function rectFor(el: Element): DOMRect {
  const r =
    rects.get(el) ??
    (el.id === POPUP_LAYER_ID ? { top: 0, left: 0, width: 0, height: 0 } : current);
  return {
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

beforeEach(() => {
  setViewport(1000, 800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return rectFor(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const px = (v: string) => Number.parseFloat(v);

describe("Menu placement", () => {
  it("mounts in the host popup layer and flips above the pointer near the bottom", () => {
    current = { top: 0, left: 0, width: 200, height: 150 };
    const menu = new Menu().showAtPosition({ x: 100, y: 780 });
    expect(menu.dom.parentElement?.id).toBe(POPUP_LAYER_ID);
    expect(menu.dom.dataset.popupPlacement).toBe("above");
    expect(px(menu.dom.style.top)).toBe(630);
    menu.hide();
    expect(document.getElementById(POPUP_LAYER_ID)?.children.length).toBe(0);
  });

  it("shifts left near the right edge and opens below with room", () => {
    current = { top: 0, left: 0, width: 200, height: 150 };
    const menu = new Menu().showAtPosition({ x: 990, y: 100 });
    expect(menu.dom.dataset.popupPlacement).toBe("below");
    expect(px(menu.dom.style.left)).toBe(792);
    menu.hide();
  });

  it("caps max-height when taller than the window", () => {
    current = { top: 0, left: 0, width: 200, height: 2000 };
    const menu = new Menu().showAtPosition({ x: 10, y: 400 });
    expect(px(menu.dom.style.maxHeight)).toBeLessThanOrEqual(784);
    expect(menu.dom.style.overflowY).toBe("auto");
    menu.hide();
  });

  it("re-places on window resize", () => {
    current = { top: 0, left: 0, width: 200, height: 150 };
    const menu = new Menu().showAtPosition({ x: 100, y: 600 });
    expect(menu.dom.dataset.popupPlacement).toBe("below");
    setViewport(1000, 700);
    window.dispatchEvent(new Event("resize"));
    expect(menu.dom.dataset.popupPlacement).toBe("above");
    menu.hide();
  });
});

function makeApp() {
  return createApp({
    io: createMemoryVaultIo({}),
    services: createHostServices({ read: async () => null, write: async () => {} }),
    bridge: detachedBridge,
  } as never);
}

describe("AbstractInputSuggest placement", () => {
  it("opens up when the input sits at the bottom, keeping the side while typing", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    rects.set(input, { top: 760, left: 40, width: 300, height: 30 });
    current = { top: 0, left: 0, width: 300, height: 200 };
    class S extends AbstractInputSuggest<string> {
      getSuggestions(q: string) {
        return Array.from({ length: q.length + 1 }, (_, i) => `item ${i}`);
      }
      renderSuggestion(v: string, el: HTMLElement) {
        el.textContent = v;
      }
    }
    const s = new S(makeApp(), input);
    input.value = "ab";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(s.isOpen).toBe(true));
    expect(s.containerEl.parentElement?.id).toBe(POPUP_LAYER_ID);
    expect(s.containerEl.dataset.popupPlacement).toBe("above");
    expect(px(s.containerEl.style.top) + 200).toBeLessThanOrEqual(760);
    // list shrinks: still above (no jump)
    current = { top: 0, left: 0, width: 300, height: 40 };
    input.value = "";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(s.suggestEl.children.length).toBe(1));
    expect(s.containerEl.dataset.popupPlacement).toBe("above");
    s.close();
  });
});

describe("EditorSuggest placement", () => {
  it("anchors to the caret rect and opens above it near the bottom", () => {
    current = { top: 0, left: 0, width: 400, height: 250 };
    class S extends EditorSuggest<string> {
      onTrigger() {
        return null;
      }
      getSuggestions() {
        return [];
      }
      renderSuggestion(v: string, el: HTMLElement) {
        el.textContent = v;
      }
      selectSuggestion() {}
    }
    const s = new S(makeApp());
    s.showAt({ top: 770, bottom: 790, left: 900, right: 900 }, ["a", "b"]);
    expect(s.containerEl.dataset.popupPlacement).toBe("above");
    expect(px(s.containerEl.style.left)).toBe(592);
    expect(px(s.containerEl.style.top)).toBe(770 - 4 - 250);
    // caret moves to the top: flips below
    s.updateCaret({ top: 20, bottom: 40, left: 10, right: 10 });
    expect(s.containerEl.dataset.popupPlacement).toBe("below");
    s.close();
  });
});

describe("popup guard", () => {
  let stop: () => void;
  const flush = async () => {
    await Promise.resolve(); // mutation observer microtask
    await vi.advanceTimersByTimeAsync(20);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    stop = installPopupGuard();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  function floating(rect: { top: number; left: number; width: number; height: number }) {
    const el = document.createElement("div");
    el.style.position = "fixed";
    rects.set(el, rect);
    document.body.appendChild(el);
    return el;
  }

  it("never touches a popup that already fits", async () => {
    const el = floating({ top: 100, left: 100, width: 300, height: 200 });
    await flush();
    expect(el.style.translate).toBe("");
    expect(el.style.maxHeight).toBe("");
  });

  it("shifts a popup that sticks out of the bottom/right back inside", async () => {
    const el = floating({ top: 700, left: 800, width: 300, height: 200 });
    await flush();
    expect(el.style.translate).toBe("-108px -108px");
  });

  it("shifts a popup that sticks out of the top", async () => {
    const el = floating({ top: -40, left: 10, width: 300, height: 200 });
    await flush();
    expect(el.style.translate).toBe("0px 48px");
  });

  it("caps a popup taller than the window and scrolls it internally", async () => {
    const el = floating({ top: 50, left: 10, width: 300, height: 1200 });
    await flush();
    expect(el.style.maxHeight).toBe("784px");
    expect(el.style.overflowY).toBe("auto");
  });

  it("caps a bottom-anchored popup and re-measures before shifting (Copilot's typeahead)", async () => {
    const el = document.createElement("div");
    el.style.position = "absolute";
    // bottom edge fixed at y=140, height follows max-height (bottom: calc(100vh - top) anchoring)
    const live = {
      get height() {
        const cap = Number.parseFloat(el.style.maxHeight);
        return Number.isFinite(cap) ? Math.min(900, cap) : 900;
      },
      get top() {
        return (
          140 - this.height + (Number.parseFloat(el.style.translate.split(" ")[1] ?? "0") || 0)
        );
      },
      left: 10,
      width: 300,
    };
    rects.set(el, live);
    document.body.appendChild(el);
    await flush();
    expect(el.style.maxHeight).toBe("784px");
    const r = rectFor(el);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(800);
    setViewport(1000, 1200); // window grows: the cap is lifted
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(el.style.maxHeight).toBe("");
  });

  it("re-checks on window resize and removes the shift once it fits", async () => {
    const el = floating({ top: 600, left: 10, width: 300, height: 150 });
    await flush();
    expect(el.style.translate).toBe("");
    setViewport(1000, 700);
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(el.style.translate).toBe("0px -58px"); // bottom 750 -> 692
    setViewport(1000, 900);
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(el.style.translate).toBe("");
  });

  it("honors the opt-out attribute, the host layer and non-floating elements", async () => {
    const out = floating({ top: 900, left: 0, width: 100, height: 100 });
    out.setAttribute(NO_CLAMP_ATTR, "");
    const layer = document.createElement("div");
    layer.id = POPUP_LAYER_ID;
    layer.style.position = "fixed";
    rects.set(layer, { top: 900, left: 0, width: 100, height: 100 });
    document.body.appendChild(layer);
    const plain = document.createElement("div"); // static, no role
    rects.set(plain, { top: 900, left: 0, width: 100, height: 100 });
    document.body.appendChild(plain);
    await flush();
    expect(out.style.translate).toBe("");
    expect(layer.style.translate).toBe("");
    expect(plain.style.translate).toBe("");
  });

  it("tracks role=listbox popups and undoes every shift on uninstall", async () => {
    const el = document.createElement("div");
    el.setAttribute("role", "listbox");
    rects.set(el, { top: 760, left: 10, width: 100, height: 100 });
    document.body.appendChild(el);
    await flush();
    expect(el.style.translate).toBe("0px -68px");
    stop();
    expect(el.style.translate).toBe("");
    stop = installPopupGuard();
  });

  it("stops tracking removed popups", async () => {
    const el = floating({ top: 900, left: 0, width: 100, height: 100 });
    await flush();
    el.remove();
    await flush();
    expect(document.body.contains(el)).toBe(false);
  });
});
