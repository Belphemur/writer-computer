import { describe, expect, test, vi } from "vite-plus/test";
import { sealTauri, SealViolationError } from "../src/lib/obsidian-host/seal/seal";

function fakeGlobal() {
  const invoke = vi.fn(async (cmd: string, args?: unknown) => ({ cmd, args }));
  const unregisterListener = vi.fn();
  const g: Record<string, unknown> = {
    __TAURI_INTERNALS__: {
      invoke,
      transformCallback: vi.fn(() => 7),
      convertFileSrc: (p: string) => `asset://${p}`,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener },
    __TAURI__: { core: {} },
  };
  return { g, invoke, unregisterListener };
}

type Internals = {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  transformCallback: () => number;
  convertFileSrc: (p: string) => string;
  metadata: { currentWindow: { label: string } };
};

describe("sealTauri", () => {
  test("host calls still reach the real invoke with any command", async () => {
    const { g, invoke } = fakeGlobal();
    const { hostInvoke } = sealTauri({ target: g });
    await expect(hostInvoke("read_file", { path: "/a.md" })).resolves.toEqual({
      cmd: "read_file",
      args: { path: "/a.md" },
    });
    expect(invoke).toHaveBeenCalledWith("read_file", { path: "/a.md" }, undefined);
  });

  test("plugin-context invoke of an app command is rejected with a clear error", async () => {
    const { g, invoke } = fakeGlobal();
    sealTauri({ target: g });
    const internals = g.__TAURI_INTERNALS__ as Internals;
    const p = internals.invoke("read_file", { path: "/etc/passwd" });
    await expect(p).rejects.toBeInstanceOf(SealViolationError);
    await expect(p).rejects.toThrow(/"read_file" is not available to plugins/);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("dependency plugin commands pass through the stand-in", async () => {
    const { g, invoke } = fakeGlobal();
    sealTauri({ target: g });
    const internals = g.__TAURI_INTERNALS__ as Internals;
    await internals.invoke("plugin:event|listen", { event: "x" });
    await internals.invoke("plugin:menu|popup", {});
    await internals.invoke("plugin:store|load", { path: "preferences.json" });
    await internals.invoke("plugin:opener|open_url", { url: "https://example.com" });
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  test("argument checks and denied plugin commands", async () => {
    const { g, invoke } = fakeGlobal();
    sealTauri({ target: g });
    const internals = g.__TAURI_INTERNALS__ as Internals;
    await expect(internals.invoke("plugin:store|load", { path: "../../x.json" })).rejects.toThrow(
      /store path/,
    );
    await expect(
      internals.invoke("plugin:opener|open_url", { url: "file:///etc/passwd" }),
    ).rejects.toThrow(/http\(s\)/);
    await expect(internals.invoke("plugin:menu|set_as_app_menu", {})).rejects.toThrow(/sealed/);
    await expect(internals.invoke("plugin:fs|read_text_file", {})).rejects.toThrow(/sealed/);
    await expect(internals.invoke(42 as unknown as string)).rejects.toThrow(/must be a string/);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("helpers other than invoke keep working", () => {
    const { g } = fakeGlobal();
    sealTauri({ target: g });
    const internals = g.__TAURI_INTERNALS__ as Internals;
    expect(internals.convertFileSrc("/a.png")).toBe("asset:///a.png");
    expect(internals.transformCallback()).toBe(7);
    expect(internals.metadata.currentWindow.label).toBe("main");
  });

  test("__TAURI__ is removed and internals are frozen and non-configurable", () => {
    const { g } = fakeGlobal();
    sealTauri({ target: g });
    expect("__TAURI__" in g).toBe(false);
    for (const key of ["__TAURI_INTERNALS__", "__TAURI_EVENT_PLUGIN_INTERNALS__"]) {
      const d = Object.getOwnPropertyDescriptor(g, key)!;
      expect(d.configurable).toBe(false);
      expect(d.writable).toBe(false);
      expect(Object.isFrozen(d.value)).toBe(true);
    }
    expect(() => {
      "use strict";
      g.__TAURI_INTERNALS__ = {};
    }).toThrow(TypeError);
    expect(() => {
      "use strict";
      delete g.__TAURI_INTERNALS__;
    }).toThrow(TypeError);
    const internals = g.__TAURI_INTERNALS__ as Internals;
    expect(() => {
      "use strict";
      internals.invoke = async () => 1;
    }).toThrow(TypeError);
  });

  test("a non-deletable __TAURI__ fails closed, internals untouched", () => {
    const { g } = fakeGlobal();
    Object.defineProperty(g, "__TAURI__", { value: { core: {} }, configurable: false });
    const before = g.__TAURI_INTERNALS__;
    expect(() => sealTauri({ target: g })).toThrow();
    expect(g.__TAURI_INTERNALS__).toBe(before);
  });

  test("event unlisten still works through the stand-in", () => {
    const { g, unregisterListener } = fakeGlobal();
    sealTauri({ target: g });
    (
      g.__TAURI_EVENT_PLUGIN_INTERNALS__ as { unregisterListener: (e: string, i: number) => void }
    ).unregisterListener("menu", 3);
    expect(unregisterListener).toHaveBeenCalledWith("menu", 3);
  });

  test("sealing twice is idempotent and keeps the original captured", async () => {
    const { g, invoke } = fakeGlobal();
    const first = sealTauri({ target: g });
    const standIn = g.__TAURI_INTERNALS__;
    const second = sealTauri({ target: g });
    expect(second).toBe(first);
    expect(g.__TAURI_INTERNALS__).toBe(standIn);
    await first.hostInvoke("read_file", {});
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("fails closed when internals are missing", () => {
    expect(() => sealTauri({ target: {} })).toThrow(/missing/);
  });

  test("hostInvoke export is frozen and ignores later global tampering", async () => {
    const { g, invoke } = fakeGlobal();
    const { hostInvoke } = sealTauri({ target: g });
    expect(Object.isFrozen(hostInvoke)).toBe(true);
    await hostInvoke("x");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
