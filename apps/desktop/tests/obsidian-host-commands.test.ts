import { describe, expect, it, vi } from "vite-plus/test";
import { CommandRegistry, Events, Scope, Keymap } from "../src/lib/obsidian-host/api/core";
import { OwnedRegistry } from "../src/lib/owned-registry";

describe("CommandRegistry", () => {
  it("prefixes the id and name with the plugin like Obsidian does", () => {
    const reg = new CommandRegistry();
    const cmd = reg.addForPlugin("copilot", "Copilot", {
      id: "chat",
      name: "Open chat",
      callback: () => {},
    });
    expect(cmd.id).toBe("copilot:chat");
    expect(cmd.name).toBe("Copilot: Open chat");
    expect(reg.get("copilot:chat")?.owner).toBe("copilot");
    // Already-prefixed ids and names are not prefixed twice.
    reg.addForPlugin("copilot", "Copilot", {
      id: "copilot:x",
      name: "Copilot: X",
      callback: () => {},
    });
    expect(reg.get("copilot:x")?.name).toBe("Copilot: X");
  });

  it("runs callbacks and reports availability from checkCallback", () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    let allowed = false;
    reg.addForPlugin("p", "P", {
      id: "c",
      name: "C",
      checkCallback: (checking) => {
        if (!allowed) return false;
        if (!checking) run();
        return true;
      },
    });
    expect(reg.get("p:c")?.isAvailable()).toBe(false);
    expect(reg.execute("p:c")).toBe(false);
    allowed = true;
    expect(reg.get("p:c")?.isAvailable()).toBe(true);
    expect(reg.execute("p:c")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("editor commands need an active editor and receive it", () => {
    const reg = new CommandRegistry();
    const seen: unknown[] = [];
    reg.addForPlugin("p", "P", {
      id: "e",
      name: "E",
      editorCallback: (editor, view) => void seen.push(editor, view),
    });
    expect(reg.execute("p:e")).toBe(false);
    const ctx = { editor: { id: "ed" }, view: { id: "view" } };
    reg.setEditorProvider(() => ctx);
    expect(reg.execute("p:e")).toBe(true);
    expect(seen).toEqual([ctx.editor, ctx.view]);
  });

  it("a throwing command is contained", () => {
    const reg = new CommandRegistry();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reg.addForPlugin("p", "P", {
      id: "t",
      name: "T",
      callback: () => {
        throw new Error("nope");
      },
    });
    expect(() => reg.execute("p:t")).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("removeOwner removes only that owner's commands and notifies once", () => {
    const reg = new CommandRegistry();
    reg.addForPlugin("a", "A", { id: "1", name: "1", callback: () => {} });
    reg.addForPlugin("a", "A", { id: "2", name: "2", callback: () => {} });
    reg.addForPlugin("b", "B", { id: "1", name: "1", callback: () => {} });
    const listener = vi.fn();
    reg.subscribe(listener);
    expect(reg.removeOwner("a")).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.list().map((c) => c.id)).toEqual(["b:1"]);
  });

  it("re-adding the same id replaces the command", () => {
    const reg = new CommandRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.addForPlugin("p", "P", { id: "x", name: "x", callback: a });
    reg.addForPlugin("p", "P", { id: "x", name: "x", callback: b });
    reg.execute("p:x");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(1);
  });
});

describe("OwnedRegistry", () => {
  it("dispose runs for removed items and the returned remover is a no-op once replaced", () => {
    const disposed: string[] = [];
    const reg = new OwnedRegistry<{ owner: string; n: string }>((i) => void disposed.push(i.n));
    const rm1 = reg.add("k", { owner: "o", n: "first" });
    reg.add("k", { owner: "o", n: "second" });
    expect(disposed).toEqual(["first"]);
    rm1();
    expect(reg.get("k")?.n).toBe("second");
  });
});

describe("Events", () => {
  it("on/off/offref/trigger and a throwing handler does not block the others", () => {
    const ev = new Events();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = vi.fn(() => {
      throw new Error("x");
    });
    const b = vi.fn();
    ev.on("e", a);
    const ref = ev.on("e", b);
    ev.trigger("e", 1, 2);
    expect(b).toHaveBeenCalledWith(1, 2);
    ev.offref(ref);
    ev.off("e", a);
    ev.trigger("e");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("Scope", () => {
  const key = (key: string, init: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
      ...init,
    }) as KeyboardEvent;

  it("matches key and modifiers, falls back to the parent scope", () => {
    const parent = new Scope();
    const child = new Scope(parent);
    const hit = vi.fn();
    parent.register(["Shift"], "k", hit);
    expect(child.handleKey(key("k"))).toBe(false);
    expect(child.handleKey(key("K", { shiftKey: true }))).toBe(true);
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it("a handler returning false does not consume the event", () => {
    const s = new Scope();
    s.register([], "a", () => false);
    expect(s.handleKey(key("a"))).toBe(false);
  });

  it("Keymap keeps a scope stack", () => {
    const km = new Keymap();
    const s1 = new Scope();
    const s2 = new Scope();
    km.pushScope(s1);
    km.pushScope(s2);
    expect(km.activeScope).toBe(s2);
    km.popScope(s2);
    expect(km.activeScope).toBe(s1);
  });
});
