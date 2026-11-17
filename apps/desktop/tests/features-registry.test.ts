// The built-in feature host: lifecycle, lazy activation, teardown, contributions and failure.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { resolveCommands } from "../src/components/command-palette/commands";
import { closeDocks, openDock, subscribeDocks } from "../src/lib/features/docks";
import { featurePaletteCommands } from "../src/lib/features/palette";
import { createFeatureHost, defineFeature } from "../src/lib/features/registry";
import { keybindings } from "../src/lib/keybindings/registry";

const errors: Array<[string, string]> = [];
const listens: Array<{ name: string; un: ReturnType<typeof vi.fn> }> = [];
const host = createFeatureHost({
  onError: (id, phase) => void errors.push([id, phase]),
  listen: (async (name: string) => {
    const un = vi.fn();
    listens.push({ name, un });
    return un;
  }) as never,
});

const ctx = new Proxy(
  { hasWorkspace: true, isCompactFileMode: false, close: () => {} },
  { get: (t, k) => (k in t ? (t as never)[k] : () => {}) },
) as never;
const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { cancelable: true, ...init });
const flush = () => new Promise((r) => setTimeout(r, 0));
const boom = () => {
  throw new Error("boom");
};

afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
  errors.length = 0;
  listens.length = 0;
});

function demo(over: Partial<Parameters<typeof defineFeature>[0]> = {}) {
  const activate = vi.fn();
  const ran = vi.fn();
  const def = defineFeature({
    id: "demo",
    activate,
    contributes: {
      commands: [{ id: "demo.run", label: "Demo: Run", run: (_c, f) => ran("cmd", f.id) }],
      keybindings: [
        {
          id: "demo.key",
          keys: ["Mod+Alt+D"],
          description: "Demo key",
          run: (f) => ran("key", f.id),
        },
      ],
    },
    ...over,
  });
  return { def, activate, ran };
}

describe("defineFeature", () => {
  it("rejects a bad id, a foreign contribution id and a point with no host", () => {
    expect(() => defineFeature({ id: "Bad_Id" })).toThrow(/invalid feature id/);
    expect(() =>
      defineFeature({
        id: "a",
        contributes: { commands: [{ id: "b.x", label: "x", run: () => {} }] },
      }),
    ).toThrow(/must start with "a\."/);
    expect(() => defineFeature({ id: "a", contributes: { sidebar: [] } })).toThrow(/no host yet/);
  });
});

describe("registration is cheap and lazy", () => {
  it("registers contributions without activating", () => {
    const { def, activate } = demo();
    host.register(def);
    expect(host.state("demo")).toBe("registered");
    expect(activate).not.toHaveBeenCalled();
    expect(featurePaletteCommands.has("demo.run")).toBe(true);
    expect(keybindings.list().some((b) => b.id === "demo.key")).toBe(true);
  });

  it("activates on the first command from the palette, once", async () => {
    const { def, activate, ran } = demo();
    host.register(def);
    const cmd = resolveCommands(ctx, []).find((c) => c.id === "demo.run")!;
    cmd.run();
    cmd.run();
    await flush();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(ran.mock.calls).toEqual([
      ["cmd", "demo"],
      ["cmd", "demo"],
    ]);
    expect(host.isActive("demo")).toBe(true);
  });

  it("activates on the first keybinding", async () => {
    const { def, activate, ran } = demo();
    host.register(def);
    const b = keybindings.find(key({ key: "d", metaKey: true, altKey: true }), "bubble")!;
    expect(b.id).toBe("demo.key");
    b.run(key({ key: "d" }));
    await flush();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(ran).toHaveBeenCalledWith("key", "demo");
  });

  it("concurrent activations share one promise", async () => {
    let release!: () => void;
    const activate = vi.fn(() => new Promise<void>((r) => (release = r)));
    host.register(demo({ activate }).def);
    const a = host.activate("demo");
    const b = host.activate("demo");
    expect(host.state("demo")).toBe("activating");
    release();
    await Promise.all([a, b]);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe("deactivation frees what activation created", () => {
  it("disposes in reverse order and can activate again", async () => {
    const order: string[] = [];
    const { def } = demo({
      activate: (c) => {
        c.disposables.add(() => order.push("first"));
        c.disposables.add(() => order.push("second"));
        c.listen("pinged", () => {});
        return () => order.push("returned");
      },
      deactivate: () => void order.push("deactivate"),
    });
    host.register(def);
    await host.activate("demo");
    await flush();
    expect(listens.map((l) => l.name)).toEqual(["demo:pinged"]);
    await host.deactivate("demo");
    expect(order).toEqual(["deactivate", "returned", "second", "first"]);
    expect(listens[0]!.un).toHaveBeenCalledTimes(1);
    expect(host.state("demo")).toBe("registered");
    expect(featurePaletteCommands.has("demo.run")).toBe(true); // contributions stay for the next use
    await host.activate("demo");
    expect(host.isActive("demo")).toBe(true);
  });

  it("unregister drops every contribution and frees the key", async () => {
    host.register(demo().def);
    await host.activate("demo");
    await host.unregister("demo");
    expect(host.state("demo")).toBeUndefined();
    expect(featurePaletteCommands.has("demo.run")).toBe(false);
    expect(keybindings.list().some((b) => b.id === "demo.key")).toBe(false);
  });
});

describe("failures are isolated", () => {
  it("a throwing activate marks the feature failed, removes its contributions and logs once", async () => {
    host.register(demo({ activate: boom }).def);
    await expect(host.activate("demo")).rejects.toThrow("boom");
    expect(host.state("demo")).toBe("failed");
    expect(featurePaletteCommands.has("demo.run")).toBe(false);
    expect(errors).toEqual([["demo", "activate"]]);
    await expect(host.activate("demo")).rejects.toThrow("boom"); // terminal for the session
  });

  it("a key press on a failing feature logs and does not throw", async () => {
    host.register(demo({ activate: boom }).def);
    const b = keybindings.find(key({ key: "d", metaKey: true, altKey: true }), "bubble")!;
    expect(() => b.run(key({ key: "d" }))).not.toThrow();
    await flush();
    expect(errors.map((e) => e[1])).toContain("activate");
  });

  it("a key conflict registers nothing and throws a readable error", () => {
    const { def } = demo({
      contributes: {
        commands: [{ id: "demo.run", label: "Demo", run: () => {} }],
        keybindings: [{ id: "demo.new-tab", keys: ["Mod+T"], description: "x", run: () => {} }],
      },
    });
    expect(() => host.register(def)).toThrow(/already bound to "new-tab" \(core\)/);
    expect(host.list()).toEqual([]);
    expect(featurePaletteCommands.has("demo.run")).toBe(false);
  });

  it("a second feature with the same id is refused", () => {
    host.register(demo().def);
    expect(() => host.register(demo().def)).toThrow(/already registered/);
  });
});

describe("a feature's keybinding shows in the palette", () => {
  it("uses the registry's key for the command with the same id", () => {
    host.register(
      defineFeature({
        id: "shown",
        contributes: {
          commands: [{ id: "shown.go", label: "Shown: Go", run: () => {} }],
          keybindings: [{ id: "shown.go", keys: ["Mod+Alt+G"], description: "go", run: () => {} }],
        },
      }),
    );
    const cmd = resolveCommands(ctx, []).find((c) => c.id === "shown.go")!;
    expect(cmd.shortcut).toBe(keybindings.shortcutFor("shown.go"));
    expect(cmd.shortcut).toBeTruthy();
  });
});

describe("docks", () => {
  function dock(id: string, priority: number, open = false) {
    let isOpen = open;
    const listeners = new Set<() => void>();
    return {
      id,
      priority,
      isOpen: () => isOpen,
      width: () => 100 + priority,
      close: () => {
        isOpen = false;
        listeners.forEach((l) => l());
      },
      set: (v: boolean) => {
        isOpen = v;
        listeners.forEach((l) => l());
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      load: async () => () => null,
    };
  }

  it("shows the open dock with the highest priority and drops it with its feature", async () => {
    const low = dock("a.low", 1, true);
    const high = dock("b.high", 5, true);
    host.register({ id: "a", contributes: { docks: [low] } });
    host.register({ id: "b", contributes: { docks: [high] } });
    expect(openDock()?.id).toBe("b.high");
    expect(openDock()?.width()).toBe(105);
    await host.unregister("b");
    expect(openDock()?.id).toBe("a.low");
    low.set(false);
    expect(openDock()).toBeNull();
  });

  it("notifies on a dock's own change and on registration, and closeDocks closes the open ones", async () => {
    const d = dock("a.pane", 1);
    const seen = vi.fn();
    const un = subscribeDocks(seen);
    host.register({ id: "a", contributes: { docks: [d] } });
    expect(seen).toHaveBeenCalledTimes(1);
    d.set(true);
    expect(seen).toHaveBeenCalledTimes(2);
    closeDocks();
    expect(openDock()).toBeNull();
    un();
    d.set(true);
    expect(seen).toHaveBeenCalledTimes(3); // closeDocks notified once more; nothing after unsubscribe
    await host.unregister("a");
  });

  it("requires the feature id as the id prefix", () => {
    expect(() => defineFeature({ id: "a", contributes: { docks: [dock("b.pane", 1)] } })).toThrow(
      /must start with "a\."/,
    );
  });
});
