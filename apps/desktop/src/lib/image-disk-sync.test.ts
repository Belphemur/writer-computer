import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IMAGE_SYNC_DEBOUNCE_MS, syncImageFromDisk } from "./image-disk-sync";
import { useImageViewerStore } from "@/stores/image-viewer-store";
import { IMAGE_ZOOM_FIT } from "@/lib/image-zoom";
import { imageKind } from "@/components/editor-area/page-kinds/image";

const store = () => useImageViewerStore.getState();
const flush = () => vi.advanceTimersByTime(IMAGE_SYNC_DEBOUNCE_MS);

beforeEach(() => {
  vi.useFakeTimers();
  useImageViewerStore.setState({ views: {} });
  store().track("/v/a.png");
});
afterEach(() => vi.useRealTimers());

describe("syncImageFromDisk", () => {
  it("reloads with a new cache key after the debounce, once per burst", () => {
    syncImageFromDisk("/v/a.png", "modified");
    syncImageFromDisk("/v/a.png", "modified");
    expect(store().views["/v/a.png"].version).toBe(0);
    flush();
    expect(store().views["/v/a.png"].version).toBe(1);
  });

  it("keeps zoom when the size is unchanged and resets it when it changed", () => {
    store().setSize("/v/a.png", 100, 50);
    store().setZoom("/v/a.png", 2);
    syncImageFromDisk("/v/a.png", "modified");
    flush();
    expect(store().setSize("/v/a.png", 100, 50)).toBe(false);
    expect(store().views["/v/a.png"].zoom).toBe(2);
    expect(store().setSize("/v/a.png", 200, 50)).toBe(true);
    expect(store().views["/v/a.png"].zoom).toBe(IMAGE_ZOOM_FIT);
  });

  it("shows the deleted state, and a later create brings the image back", () => {
    syncImageFromDisk("/v/a.png", "deleted");
    flush();
    expect(store().views["/v/a.png"].deleted).toBe(true);
    syncImageFromDisk("/v/a.png", "created");
    flush();
    expect(store().views["/v/a.png"]).toMatchObject({ deleted: false, version: 1 });
  });

  it("treats delete followed by create in one burst as a reload", () => {
    syncImageFromDisk("/v/a.png", "deleted");
    syncImageFromDisk("/v/a.png", "created");
    flush();
    expect(store().views["/v/a.png"]).toMatchObject({ deleted: false, version: 1 });
  });

  it("ignores unrelated and untracked files", () => {
    syncImageFromDisk("/v/b.png", "modified");
    flush();
    expect(store().views["/v/b.png"]).toBeUndefined();
    expect(store().views["/v/a.png"].version).toBe(0);
  });

  it("follows an in-app rename through the page kind", () => {
    expect(
      imageKind.rewritePath({ kind: "image", path: "/v/a.png" }, "/v/a.png", "/v/c.png"),
    ).toEqual({ kind: "image", path: "/v/c.png" });
  });
});
