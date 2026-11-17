// @vitest-environment jsdom
// Mouse side buttons (3 = back, 4 = forward) drive the editor's navigation history: natively on
// macOS (Tauri event `mouse-buttons:navigate` from the NSEvent monitor) and as DOM events
// elsewhere. The feature runs through the real host: registered and activated like the loader does
// at startup, switched off by `features.mouse-buttons.enabled`. The editor store's two navigation
// actions, Tauri and the logger are faked; nothing here touches a real window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Handler = (e: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
const unlisten = vi.fn();
const listen = vi.fn(async (name: string, h: Handler) => {
  listeners.set(name, h);
  return unlisten;
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, h: Handler) => listen(name, h),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
const logs: string[] = [];
vi.mock("@/lib/logger", () => ({
  logger: {
    log: (_l: string, _s: string, m: string) => logs.push(m),
    error: (_s: string, m: string) => logs.push(`error: ${m}`),
  },
}));

const back = vi.fn(async () => {});
const forward = vi.fn(async () => {});

import { useEditorStore } from "../../../src/stores/editor-store";
import { createFeatureHost } from "../../../src/lib/features/registry";
import { syncBuiltinFeatures } from "../../../src/lib/features/builtin";
import schema from "../../../shared/settings.schema.json";
import manifest from "../feature.json";
import mouseButtons from "../web/index";
import { NATIVE_DEDUPE_MS } from "../web/mouse-navigation";

const EVENT = "mouse-buttons:navigate";
const features = [{ manifest, definition: mouseButtons }];
let host: ReturnType<typeof createFeatureHost>;

/** What the loader does: register while enabled; `onStartup` features activate at once. */
async function start(settings: Record<string, unknown> = {}) {
  syncBuiltinFeatures(host, features, settings);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  vi.useFakeTimers();
  useEditorStore.setState({ navigateBack: back, navigateForward: forward });
  host = createFeatureHost({ listen: listen as never });
  await start();
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
  vi.useRealTimers();
  for (const m of [back, forward, unlisten, listen]) m.mockClear();
  listeners.clear();
  logs.length = 0;
});

const dom = (button: number, type = "mouseup") => {
  const e = new MouseEvent(type, { button, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};
const native = (direction: string) => listeners.get(EVENT)!({ payload: { direction } });

describe("registration and the kill switch", () => {
  it("activates at startup and listens for exactly the manifest's event", () => {
    expect(host.isActive("mouse-buttons")).toBe(true);
    expect(manifest.activation).toEqual(["onStartup"]);
    expect(manifest.rust.events).toEqual([EVENT]);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listeners.has(EVENT)).toBe(true);
  });

  it("its kill switch is in the shared settings schema, on by default", () => {
    const entry = schema.settings.find((s) => s.key === "features.mouse-buttons.enabled");
    expect(entry).toMatchObject({ type: "boolean", default: true, scope: "global" });
  });

  it("switched off, nothing is registered: no listener, no DOM handler", async () => {
    await host.unregister("mouse-buttons");
    for (const m of [listen, unlisten]) m.mockClear();
    listeners.clear();
    await start({ "features.mouse-buttons.enabled": false });
    expect(host.list()).toEqual([]);
    expect(listen).not.toHaveBeenCalled();
    dom(3);
    expect(back).not.toHaveBeenCalled();
  });

  it("switching it off live removes the handlers; on again restores them", async () => {
    await start({ "features.mouse-buttons.enabled": false });
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(1);
    dom(3);
    expect(back).not.toHaveBeenCalled();
    await start({ "features.mouse-buttons.enabled": true });
    dom(3);
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("native side buttons", () => {
  it("back and forward call the matching store action once", () => {
    native("back");
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    native("forward");
    expect(forward).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["mouse back (native)", "mouse forward (native)"]);
  });

  it("ignores an unknown direction", () => {
    native("sideways");
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("a DOM event right after a native one is the same press", () => {
    native("back");
    dom(3);
    expect(back).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NATIVE_DEDUPE_MS + 50);
    dom(3);
    expect(back).toHaveBeenCalledTimes(2);
  });
});

describe("DOM fallback", () => {
  it("button 3 goes back and button 4 goes forward on mouseup", () => {
    expect(dom(3).defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(dom(4).defaultPrevented).toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("a mousedown or auxclick of a side button does not navigate", () => {
    dom(3, "mousedown");
    dom(3, "auxclick");
    expect(back).not.toHaveBeenCalled();
  });

  it("left, middle and right buttons do not navigate", () => {
    for (const b of [0, 1, 2]) expect(dom(b).defaultPrevented).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("logs the middle button once it reaches the page", () => {
    dom(1, "mousedown");
    expect(logs).toEqual(["mouse middle button reached the page (mousedown)"]);
  });

  it("stops listening after deactivation", async () => {
    await host.deactivate("mouse-buttons");
    dom(3);
    expect(back).not.toHaveBeenCalled();
  });
});
