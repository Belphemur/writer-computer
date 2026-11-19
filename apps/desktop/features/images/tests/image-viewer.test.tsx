// The viewer component: fits and upscales, zooms toward the pointer, pans, toggles Fit / 100%,
// the footer control, the fallback, disk sync, and the keep-alive contract (an inactive tab hides
// the image, switching back keeps the zoom, closing removes it).
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const host = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  calls: [] as [string, unknown][],
  fail: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string }) => {
    host.calls.push([cmd, args]);
    if (cmd === "read_file") return { path: args.path, content: host.files[args.path!] ?? "" };
    if (cmd === "open_image_in_default_app" && host.fail) throw new Error("no");
    return undefined;
  }),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { DISK_SYNC_DEBOUNCE_MS, diskSyncListener, useDiskStore } from "../web/disk-sync";
import { ImageViewer } from "../web/components/image-viewer";
import { activeViewer } from "../web/lib/viewer-controller";
import { FIT_MARGIN } from "../web/lib/view-transform";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE = { width: 800, height: 600 };
const proto = HTMLElement.prototype;
const saved = {
  w: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
  h: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
};

let el: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => PAGE.width });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => PAGE.height });
  host.files = {};
  host.calls = [];
  host.fail = false;
  useDiskStore.setState({ views: {} });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  for (const [key, d] of [
    ["clientWidth", saved.w],
    ["clientHeight", saved.h],
  ] as const) {
    if (d) Object.defineProperty(proto, key, d);
    else delete (proto as unknown as Record<string, unknown>)[key];
  }
});

const loc = (path: string) => ({ kind: "image" as const, path });
const mount = async (path: string, isActive = true, natural?: [number, number]) => {
  await act(async () => {
    root.render(createElement(ImageViewer, { location: loc(path), isActive, tabId: "t" }));
  });
  if (natural) await decode(natural);
};
const img = () => el.querySelector("img")!;
const stage = () => el.querySelector<HTMLElement>("[data-testid=image-viewer-stage]")!;
const decode = async ([w, h]: [number, number]) => {
  Object.defineProperty(img(), "naturalWidth", { configurable: true, value: w });
  Object.defineProperty(img(), "naturalHeight", { configurable: true, value: h });
  await act(async () => {
    img().dispatchEvent(new Event("load"));
  });
};
const drawn = () => ({ w: parseFloat(img().style.width), h: parseFloat(img().style.height) });
// jsdom drops a zero second argument: "translate(-565px)".
const at = () => {
  const m = /translate\((-?\d+)px(?:, (-?\d+)px)?\)/.exec(img().style.transform)!;
  return { x: Number(m[1]), y: Number(m[2] ?? 0) };
};
const zoomText = () => el.querySelector("[data-testid=image-zoom-fit]")?.textContent;
const wheel = (init: WheelEventInit) =>
  act(() => {
    stage().dispatchEvent(new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init }));
  });

describe("fit by default", () => {
  it("loads through the asset protocol, read-only, with the file name as alt", async () => {
    await mount("/v/shot.png", true, [640, 480]);
    expect(img().getAttribute("src")).toBe("asset:///v/shot.png");
    expect(img().getAttribute("alt")).toBe("shot.png");
    expect(el.querySelector("textarea, [contenteditable]")).toBeNull();
  });

  it("scales a small raster up to fill the page and keeps its aspect", async () => {
    await mount("/v/small.png", true, [100, 150]);
    const { w, h } = drawn();
    expect(h).toBeCloseTo(PAGE.height - 2 * FIT_MARGIN, 3);
    expect(w / h).toBeCloseTo(100 / 150, 4);
  });

  it("scales a big raster down", async () => {
    await mount("/v/big.png", true, [4000, 3000]);
    const { w } = drawn();
    expect(w).toBeLessThanOrEqual(PAGE.width - 2 * FIT_MARGIN + 0.001);
    expect(w).toBeLessThan(4000);
  });

  it("sizes an SVG from its source, not from the webview's 300 x 150 default", async () => {
    host.files["/v/a.svg"] = '<svg viewBox="0 0 103 150"/>';
    await mount("/v/a.svg");
    await decode([300, 150]); // what a viewBox-only SVG reports in some webviews
    const { w, h } = drawn();
    expect(w / h).toBeCloseTo(103 / 150, 4);
    expect(h).toBeCloseTo(PAGE.height - 2 * FIT_MARGIN, 3);
    expect(el.textContent).toContain("103 × 150 px");
  });

  it("is laid out at the zoomed size (never a CSS scale), so an SVG stays a vector", async () => {
    host.files["/v/a.svg"] = '<svg width="103" height="150"/>';
    await mount("/v/a.svg");
    await decode([103, 150]);
    expect(img().style.transform).not.toContain("scale");
    const before = drawn().w;
    act(() => (el.querySelector("[data-testid=image-zoom-in]") as HTMLElement).click());
    expect(drawn().w).toBeCloseTo(before * 1.25, 1);
    expect(img().style.transform).not.toContain("scale");
  });
});

describe("zoom and pan", () => {
  it("Cmd/Ctrl + wheel zooms toward the pointer; a plain wheel does not zoom", async () => {
    await mount("/v/p.png", true, [1000, 800]);
    const fitW = drawn().w;
    const out = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -20,
      clientX: 100,
      clientY: 100,
      cancelable: true,
    });
    act(() => {
      stage().dispatchEvent(out);
    });
    expect(out.defaultPrevented).toBe(true);
    const zoomed = drawn().w;
    expect(zoomed).toBeGreaterThan(fitW);
    // the image point under the pointer stayed under it
    const before = { x: (100 - (PAGE.width - fitW) / 2) / fitW };
    const x = at().x;
    expect((100 - x) / zoomed).toBeCloseTo(before.x, 1);
    wheel({ metaKey: true, deltaY: 20, clientX: 100, clientY: 100 });
    expect(drawn().w).toBeLessThan(zoomed);
  });

  it("a plain wheel pans a zoomed image and stops at the edge", async () => {
    await mount("/v/p.png", true, [1000, 800]);
    wheel({ ctrlKey: true, deltaY: -50, clientX: 400, clientY: 300 });
    wheel({ ctrlKey: true, deltaY: -50, clientX: 400, clientY: 300 });
    const ty = () => at().y;
    const start = ty();
    wheel({ deltaY: 40, deltaX: 0 });
    expect(ty()).toBe(start - 40);
    wheel({ deltaY: -100000 });
    expect(ty()).toBe(0);
  });

  it("dragging pans a zoomed image and does nothing at Fit", async () => {
    await mount("/v/p.png", true, [1000, 800]);
    const tx = () => at().x;
    const fitX = tx();
    const down = (x: number, y: number, type: string) =>
      act(() => {
        stage().dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }),
        );
      });
    down(10, 10, "pointerdown");
    down(60, 10, "pointermove");
    down(60, 10, "pointerup");
    expect(tx()).toBe(fitX);
    wheel({ ctrlKey: true, deltaY: -50, clientX: 400, clientY: 300 });
    wheel({ ctrlKey: true, deltaY: -50, clientX: 400, clientY: 300 });
    const zoomedX = tx();
    down(100, 100, "pointerdown");
    down(130, 100, "pointermove");
    down(130, 100, "pointerup");
    expect(tx()).toBe(Math.min(0, zoomedX + 30));
  });

  it("a double-click toggles Fit and 100%", async () => {
    await mount("/v/p.png", true, [1000, 800]);
    expect(zoomText()).toBe("Fit");
    const dbl = () =>
      act(() => {
        stage().dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true, clientX: 400, clientY: 300 }),
        );
      });
    dbl();
    expect(zoomText()).toBe("100%");
    expect(drawn().w).toBe(1000);
    dbl();
    expect(zoomText()).toBe("Fit");
  });

  it("the footer shows name, size and zoom; − and + step, the percent returns to Fit", async () => {
    await mount("/v/shot.png", true, [1000, 800]);
    const footer = el.querySelector("[data-testid=image-viewer-footer]")!.textContent!;
    expect(footer).toContain("shot.png");
    expect(footer).toContain("1000 × 800 px");
    const fit = zoomText();
    const click = (id: string) =>
      act(() => (el.querySelector(`[data-testid=${id}]`) as HTMLElement).click());
    click("image-zoom-in");
    expect(zoomText()).not.toBe(fit);
    click("image-zoom-out");
    expect(zoomText()).toBe(fit);
    click("image-zoom-in");
    click("image-zoom-in");
    click("image-zoom-fit");
    expect(zoomText()).toBe(fit);
  });

  it("registers its controller only while active, for the keybinding commands", async () => {
    await mount("/v/p.png", true, [1000, 800]);
    const fit = zoomText();
    act(() => activeViewer()!.zoomIn());
    expect(zoomText()).not.toBe(fit);
    act(() => activeViewer()!.fit());
    expect(zoomText()).toBe(fit);
    await mount("/v/p.png", false);
    expect(activeViewer()).toBeNull();
  });

  it("a new size resets to Fit; the same size after a reload keeps the zoom", async () => {
    await mount("/v/p.png", true, [1000, 800]);
    act(() => activeViewer()!.zoomIn());
    const zoomed = zoomText();
    await decode([1000, 800]);
    expect(zoomText()).toBe(zoomed);
    await decode([500, 400]);
    expect(zoomText()).not.toBe(zoomed);
  });
});

describe("keep-alive: an inactive tab hides its image", () => {
  const Tabs = ({ active }: { active: "image" | "note" | "none" }) =>
    createElement(
      "div",
      { "data-testid": "page-body" },
      active === "none"
        ? null
        : createElement(ImageViewer, {
            location: loc("/v/p.png"),
            isActive: active === "image",
            tabId: "t",
          }),
      createElement("div", { "data-testid": "note" }, "note"),
    );
  const render = (active: "image" | "note" | "none") =>
    act(async () => {
      root.render(createElement(Tabs, { active }));
    });
  const view = () => el.querySelector<HTMLElement>("[data-testid=image-viewer]");

  it("switching to a note hides it, switching back shows it with the same zoom, closing removes it", async () => {
    await render("image");
    await decode([1000, 800]);
    act(() => activeViewer()!.zoomIn());
    const zoomed = zoomText();
    expect(view()!.className).not.toContain("invisible");

    await render("note");
    expect(view()!.className).toMatch(/\binvisible\b/);
    expect(view()!.className).toContain("pointer-events-none");
    expect(view()!.className).toContain("absolute");
    expect(activeViewer()).toBeNull();

    await render("image");
    expect(view()!.className).not.toContain("invisible");
    expect(zoomText()).toBe(zoomed);

    await render("none");
    expect(view()).toBeNull();
    expect(el.querySelector("img")).toBeNull();
  });

  it("stays inside the page body: no fixed positioning, no portal", async () => {
    await render("image");
    expect(el.querySelector("[data-testid=page-body] [data-testid=image-viewer]")).not.toBeNull();
    expect(document.body.querySelectorAll("img")).toHaveLength(1);
    expect(el.querySelector("[style*='position: fixed']")).toBeNull();
  });
});

describe("failures", () => {
  it("an undecodable image shows the fallback with Open in default app, never a broken icon", async () => {
    await mount("/v/a.heic");
    await act(async () => {
      img().dispatchEvent(new Event("error"));
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("Can't display this image here");
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((b) => b.textContent === "Open in default app")!
        .click();
    });
    expect(host.calls).toContainEqual(["open_image_in_default_app", { path: "/v/a.heic" }]);
  });

  it("says so when opening in the default app fails", async () => {
    host.fail = true;
    await mount("/v/a.heic");
    await act(async () => {
      img().dispatchEvent(new Event("error"));
    });
    await act(async () => {
      [...el.querySelectorAll("button")][0]!.click();
    });
    expect(el.textContent).toContain("Couldn't open it");
  });
});

describe("disk sync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reloads with a new cache key once per burst, and shows the deleted state", async () => {
    await mount("/v/a.png", true, [100, 100]);
    expect(img().getAttribute("src")).toBe("asset:///v/a.png");
    diskSyncListener.onFileChanged!("modify", "/v/a.png");
    diskSyncListener.onFileChanged!("modify", "/v/a.png");
    diskSyncListener.onFileChanged!("modify", "/v/other.png"); // not open: ignored
    await act(async () => {
      vi.advanceTimersByTime(DISK_SYNC_DEBOUNCE_MS);
    });
    expect(useDiskStore.getState().views["/v/a.png"]!.version).toBe(1);
    expect(img().getAttribute("src")).toBe("asset:///v/a.png?v=1");
    diskSyncListener.onFileChanged!("delete", "/v/a.png");
    await act(async () => {
      vi.advanceTimersByTime(DISK_SYNC_DEBOUNCE_MS);
    });
    expect(el.querySelector("[data-testid=image-viewer-deleted]")).not.toBeNull();
    diskSyncListener.onFileChanged!("create", "/v/a.png");
    await act(async () => {
      vi.advanceTimersByTime(DISK_SYNC_DEBOUNCE_MS);
    });
    expect(el.querySelector("[data-testid=image-viewer-deleted]")).toBeNull();
  });

  it("forgets the path when the tab closes", async () => {
    await mount("/v/a.png");
    expect(useDiskStore.getState().views["/v/a.png"]).toBeDefined();
    await act(async () => root.render(createElement("div")));
    expect(useDiskStore.getState().views["/v/a.png"]).toBeUndefined();
  });
});
