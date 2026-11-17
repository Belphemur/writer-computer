// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import schema from "../shared/settings.schema.json";
import shared from "../shared/attachments.json";
import {
  deserializeLocation,
  locationForPath,
  opensAsDocument,
  pageKind,
  serializeLocation,
} from "../src/components/editor-area/page-kinds";
import { pageKindView } from "../src/components/editor-area/page-kinds/views";
import { FileIcon } from "../src/components/sidebar/file-tree-icons";
import { ImageViewer, ImageViewerFooter } from "../src/components/image-viewer/image-viewer";
import { zoomIn, zoomOut, resetZoom } from "../src/hooks/zoom-api";
import {
  IMAGE_ZOOM_FIT,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  pinchImageZoom,
  wheelImageZoom,
  zoomImageIn,
  zoomImageOut,
} from "../src/lib/image-zoom";
import { noteLabel } from "../src/lib/note-title";
import { useImageViewerStore } from "../src/stores/image-viewer-store";
import { useSettingsStore } from "../src/stores/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("image page kind", () => {
  it("claims every renderable image extension, case-blind, and nothing else", () => {
    for (const ext of shared.renderExtensions) {
      expect(locationForPath(`/v/a.${ext}`)).toEqual({ kind: "image", path: `/v/a.${ext}` });
    }
    expect(locationForPath("/v/A.PNG").kind).toBe("image");
    for (const name of ["a.heic", "a.md", "a.py", "a.pdf", "png"]) {
      expect(locationForPath(`/v/${name}`).kind).not.toBe("image");
    }
    expect(opensAsDocument("/v/a.png")).toBe(false);
  });

  it("round-trips a session, follows renames and closes on delete", () => {
    const location = locationForPath("/v/a.png");
    const payload = serializeLocation(location);
    expect(payload).toEqual({ kind: "image", path: "/v/a.png" });
    expect(deserializeLocation(payload)).toEqual(location);
    const kind = pageKind(location);
    expect(kind.rewritePath(location, "/v/a.png", "/v/b.png")).toEqual({
      kind: "image",
      path: "/v/b.png",
    });
    expect(kind.removePath(location, "/v/a.png")).toBeNull();
    expect(kind.title(location)).toBe("a.png");
  });

  it("has a view and a footer registered", () => {
    const view = pageKindView(locationForPath("/v/a.png"));
    expect(view.Component).toBeTypeOf("function");
    expect(view.renderFooter).toBeTypeOf("function");
  });
});

describe("sidebar presentation", () => {
  it("shows an image glyph, different from notes and code, and keeps the extension in the label", () => {
    const svg = (name: string) => renderToStaticMarkup(createElement(FileIcon, { name }));
    expect(svg("shot.png")).not.toBe(svg("a.md"));
    expect(svg("shot.png")).not.toBe(svg("a.py"));
    expect(svg("shot.png")).toBe(svg("photo.JPG"));
    expect(noteLabel("/v/shot.png").text).toBe("shot.png");
  });

  it("files.show-images is a boolean setting that defaults to on", () => {
    const def = schema.settings.find((s) => s.key === "files.show-images");
    expect(def?.type).toBe("boolean");
    expect(def?.default).toBe(true);
    expect(def?.description).toBeTruthy();
  });
});

describe("zoom model", () => {
  it("steps by a quarter and clamps", () => {
    expect(zoomImageIn(1)).toBe(1.25);
    expect(zoomImageOut(1.25)).toBe(1);
    expect(zoomImageIn(IMAGE_ZOOM_MAX)).toBe(IMAGE_ZOOM_MAX);
    expect(zoomImageOut(IMAGE_ZOOM_MIN)).toBe(IMAGE_ZOOM_MIN);
    expect(pinchImageZoom(1, 2)).toBe(2);
    expect(wheelImageZoom(1, -10)).toBeGreaterThan(1);
    expect(wheelImageZoom(1, 10)).toBeLessThan(1);
  });
});

describe("the viewer", () => {
  let host: HTMLDivElement;
  let root: Root;
  const path = "/v/shot.png";

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    useImageViewerStore.setState({ views: {} });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (isActive = true) =>
    act(() =>
      root.render(createElement(ImageViewer, { location: { kind: "image", path }, isActive })),
    );

  it("opens the file through the asset protocol, read-only, with the file name as alt", () => {
    render();
    const img = host.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`asset://${path}`);
    expect(img.getAttribute("alt")).toBe("shot.png");
    expect(host.querySelector("textarea, [contenteditable]")).toBeNull();
  });

  it("reports its dimensions to the footer once loaded", () => {
    render();
    const img = host.querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    act(() => {
      img.dispatchEvent(new Event("load"));
    });
    const footer = document.createElement("div");
    document.body.append(footer);
    const footerRoot = createRoot(footer);
    act(() => footerRoot.render(createElement(ImageViewerFooter, { path })));
    expect(footer.textContent).toContain("shot.png");
    expect(footer.textContent).toContain("640 × 480 px");
    act(() => footerRoot.unmount());
    footer.remove();
  });

  it("Cmd+= / Cmd+- / Cmd+0 zoom the image, not the editor text, while it is active", () => {
    const setSetting = vi.fn();
    useSettingsStore.setState({ setSetting } as never);
    render(true);
    act(() => zoomIn());
    expect(useImageViewerStore.getState().views[path]?.zoom).toBe(1.25);
    act(() => zoomOut());
    act(() => zoomOut());
    expect(useImageViewerStore.getState().views[path]?.zoom).toBe(0.8);
    act(() => resetZoom());
    expect(useImageViewerStore.getState().views[path]?.zoom).toBe(IMAGE_ZOOM_FIT);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("an inactive viewer leaves the zoom chords to the editor", () => {
    const setSetting = vi.fn();
    useSettingsStore.setState({ setSetting } as never);
    render(false);
    act(() => zoomIn());
    expect(useImageViewerStore.getState().views[path]).toBeUndefined();
    expect(setSetting).toHaveBeenCalled();
  });

  it("a pinch (ctrl+wheel) zooms and does not let the page zoom", () => {
    render();
    const pane = host.querySelector<HTMLElement>("[data-testid=image-viewer]")!;
    const event = new WheelEvent("wheel", { ctrlKey: true, deltaY: -20, cancelable: true });
    act(() => {
      pane.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(useImageViewerStore.getState().views[path]!.zoom).toBeGreaterThan(1);
    const plain = new WheelEvent("wheel", { deltaY: 20, cancelable: true });
    act(() => {
      pane.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
  });

  it("shows a message when the image cannot be decoded", () => {
    render();
    act(() => {
      host.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(host.textContent).toContain("Can't show this image");
  });
});
