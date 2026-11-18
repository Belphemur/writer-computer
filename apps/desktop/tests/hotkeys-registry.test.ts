// The keybinding registry's user layer (SPECs/hotkeys-spec.md): per-OS defaults, command entries,
// overrides (replace, remove, reset), who wins a chord, conflict and refusal rules, the recorder's
// chord from a key press, and `hotkeys.json` handling in `HotkeyOverrides` (current OS only, other
// OS sections kept, failed save changes nothing, bad file reported).
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import vectors from "@shared/chord-vectors.json";
import {
  eventToChord,
  isBindableChord,
  parseChord,
  formatChord,
} from "../src/lib/keybindings/chord";
import { chordToObsidian, obsidianToChord } from "../src/lib/keybindings/obsidian";
import { HotkeyOverrides } from "../src/lib/keybindings/overrides";
import {
  KeybindingConflictError,
  KeybindingRegistry,
  resolveKeys,
  type Keybinding,
} from "../src/lib/keybindings/registry";
import type { Platform } from "../src/lib/platform";

const always = {
  "not-compact": () => true,
  "editor-not-focused": () => true,
  "outside-agent-pane": () => true,
};
const key = (init: KeyboardEventInit & { code?: string }) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
const binding = (
  id: string,
  keys: Keybinding["keys"],
  over: Partial<Keybinding> = {},
): Keybinding => ({
  id,
  keys,
  description: id,
  category: "Feature",
  run: () => {},
  ...over,
});
const reg = (platform: Platform = "macos") => new KeybindingRegistry(always, () => platform);

describe("chord syntax", () => {
  it("is the shared vectors (the Rust validation reads the same file)", () => {
    for (const c of vectors.valid) expect(() => parseChord(c), c).not.toThrow();
    for (const c of vectors.invalid) expect(() => parseChord(c), c).toThrow();
  });
});

describe("per-OS defaults", () => {
  const spec = { mac: ["Mod+Shift+K"], windows: ["Ctrl+Alt+K"], other: ["Alt+K"] };

  it("resolves the list for the OS, then `other`, else nothing", () => {
    expect(resolveKeys(spec, "mac")).toEqual(["Mod+Shift+K"]);
    expect(resolveKeys(spec, "windows")).toEqual(["Ctrl+Alt+K"]);
    expect(resolveKeys(spec, "linux")).toEqual(["Alt+K"]);
    expect(resolveKeys({ mac: ["Mod+K"] }, "linux")).toEqual([]);
    expect(resolveKeys(["Mod+K"], "windows")).toEqual(["Mod+K"]);
  });

  it("binds the chord of the current OS and shows it in that OS's spelling", () => {
    for (const [platform, shown, pressed] of [
      ["macos", "⇧⌘K", { metaKey: true, shiftKey: true, key: "K" }],
      ["windows", "Ctrl+Alt+K", { ctrlKey: true, altKey: true, key: "k" }],
      ["linux", "Alt+K", { altKey: true, key: "k" }],
    ] as const) {
      const r = reg(platform);
      r.add("core", binding("x.k", spec));
      expect(r.shortcutFor("x.k"), platform).toBe(shown);
      expect(r.find(key(pressed), "bubble")?.id, platform).toBe("x.k");
    }
  });

  it("formats Mod as Cmd on macOS and Ctrl elsewhere", () => {
    expect(formatChord("Mod+Shift+T", "macos")).toBe("⇧⌘T");
    expect(formatChord("Mod+Shift+T", "windows")).toBe("Ctrl+Shift+T");
    expect(formatChord("Mod+ ", "linux")).toBe("Ctrl+Space");
  });
});

describe("command entries", () => {
  it("are keyless, replaced by a real binding of the same id, and removed with their owner", () => {
    const r = reg();
    const run = vi.fn();
    r.addCommand("builtin:g", { id: "graph.open", description: "Open graph", run });
    expect(r.get("graph.open")?.command).toBe(true);
    expect(r.effectiveKeys("graph.open")).toEqual([]);
    expect(r.shortcutFor("graph.open")).toBeUndefined();

    r.add("builtin:g", binding("graph.open", ["Mod+G"], { run }));
    expect(r.get("graph.open")?.command).toBeUndefined();
    expect(r.effectiveKeys("graph.open")).toEqual(["Mod+G"]);
    // the other way round: a command entry never replaces a real binding
    r.addCommand("core", { id: "graph.open", description: "x", run: vi.fn() });
    expect(r.get("graph.open")?.owner).toBe("builtin:g");

    r.addCommand("builtin:g", { id: "graph.other", description: "Other", run });
    r.removeOwner("builtin:g");
    expect(r.list()).toEqual([]);
  });

  it("run a key the user gives them", () => {
    const r = reg();
    const run = vi.fn();
    r.addCommand("core", { id: "toggle-theme", description: "Dark mode", run });
    r.setOverrides({ "toggle-theme": ["Mod+Shift+D"] });
    const hit = r.find(key({ key: "D", metaKey: true, shiftKey: true }), "bubble");
    expect(hit?.id).toBe("toggle-theme");
    hit?.run(key({}));
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("user overrides", () => {
  const setup = () => {
    const r = reg();
    r.add("core", binding("a", ["Mod+1"]));
    r.add("core", binding("b", ["Mod+2", "Alt+2"]));
    r.addCommand("core", { id: "c", description: "c", run: () => {} });
    return r;
  };

  it("a list replaces the defaults, [] removes them, an absent id keeps them", () => {
    const r = setup();
    r.setOverrides({ a: ["Mod+Shift+9"], b: [] });
    expect(r.effectiveKeys("a")).toEqual(["Mod+Shift+9"]);
    expect(r.effectiveKeys("b")).toEqual([]);
    expect(r.find(key({ key: "1", metaKey: true }), "bubble")).toBeUndefined();
    expect(r.find(key({ key: "2", metaKey: true }), "bubble")).toBeUndefined();
    expect(r.find(key({ key: "9", metaKey: true, shiftKey: true }), "bubble")?.id).toBe("a");
    expect(r.defaultKeys("a")).toEqual(["Mod+1"]);
    expect(r.isModified("a") && r.isModified("b") && !r.isModified("c")).toBe(true);
    expect(r.shortcutFor("a")).toBe("⇧⌘9");
  });

  it("resetting goes back to the defaults, and the registry tells its listeners", () => {
    const r = setup();
    const seen = vi.fn();
    r.subscribe(seen);
    r.setOverrides({ a: ["Mod+Shift+9"] });
    r.setOverrides({});
    expect(seen).toHaveBeenCalledTimes(2);
    expect(r.effectiveKeys("a")).toEqual(["Mod+1"]);
    expect(r.isModified("a")).toBe(false);
  });

  it("keeps overrides for commands that are not loaded and applies them when they appear", () => {
    const r = setup();
    r.setOverrides({ "plug:cmd": ["Mod+Shift+L"] });
    expect(r.overridesSnapshot()).toEqual({ "plug:cmd": ["Mod+Shift+L"] });
    r.add("plug", binding("plug:cmd", ["Mod+L"]), { strict: false });
    expect(r.effectiveKeys("plug:cmd")).toEqual(["Mod+Shift+L"]);
  });

  it("a user's key beats a default, whichever was registered first", () => {
    const r = setup();
    r.setOverrides({ c: ["Mod+1"] }); // a's default chord
    expect(r.effectiveKeys("c")).toEqual(["Mod+1"]);
    expect(r.effectiveKeys("a")).toEqual([]);
    expect(r.find(key({ key: "1", metaKey: true }), "bubble")?.id).toBe("c");
    // a plugin registered later with a default the user already took does not steal it
    r.add("plug", binding("plug:x", ["Mod+1"]), { strict: false });
    expect(r.effectiveKeys("plug:x")).toEqual([]);
    expect(r.find(key({ key: "1", metaKey: true }), "bubble")?.id).toBe("c");
  });

  it("never lets an override make a registration fail, but defaults still conflict", () => {
    const r = setup();
    r.setOverrides({ c: ["Mod+5"] });
    expect(() => r.add("x", binding("d", ["Mod+5"]))).not.toThrow();
    expect(() => r.add("x", binding("e", ["Mod+1"]))).toThrow(KeybindingConflictError);
  });

  it("ignores reserved, bare and unreadable stored keys instead of failing", () => {
    const r = setup();
    r.setOverrides({ a: ["Mod+Q", "K", "nonsense+", "Mod+Shift+8"] });
    expect(r.effectiveKeys("a")).toEqual(["Mod+Shift+8"]);
  });

  it("matches a recorded Option key on any layout (the physical key)", () => {
    const r = setup();
    r.setOverrides({ a: ["Alt+A", "Alt+1"] });
    expect(r.find(key({ key: "å", code: "KeyA", altKey: true }), "bubble")?.id).toBe("a");
    expect(r.find(key({ key: "¡", code: "Digit1", altKey: true }), "bubble")?.id).toBe("a");
  });
});

describe("conflicts and refusals", () => {
  it("names the command that has a chord, only in an overlapping context", () => {
    const r = reg();
    r.add("core", binding("a", ["Mod+K"], { when: "editor-not-focused" }));
    r.add("core", binding("b", ["Mod+J"], { when: "not-compact" }));
    r.add("core", binding("c", ["Mod+L"]));
    r.addCommand("core", { id: "free", description: "free", run: () => {} });
    expect(r.conflictFor("free", "Mod+K")?.id).toBe("a"); // `free` is unconditional: overlaps all
    expect(r.conflictFor("a", "Mod+K")).toBeUndefined(); // itself
    expect(r.conflictFor("b", "Mod+K")?.id).toBeUndefined(); // exclusive contexts
    expect(r.conflictFor("a", "Mod+L")?.id).toBe("c");
    expect(r.conflictFor("free", "Mod+Shift+Z")).toBeUndefined();
  });

  it("sees a user's key as taken and a removed default as free", () => {
    const r = reg();
    r.add("core", binding("a", ["Mod+K"]));
    r.addCommand("core", { id: "b", description: "b", run: () => {} });
    r.setOverrides({ a: [] });
    expect(r.conflictFor("b", "Mod+K")).toBeUndefined();
    r.setOverrides({ a: ["Mod+Shift+K"] });
    expect(r.conflictFor("b", "Mod+Shift+K")?.id).toBe("a");
  });

  it("refuses reserved system chords and a chord without a modifier", () => {
    const r = reg();
    for (const c of ["Mod+Q", "Mod+,", "Mod+H", "Mod+M"]) expect(r.refusal(c), c).toBe("reserved");
    expect(r.refusal("K")).toBe("needs-modifier");
    expect(r.refusal("Shift+K")).toBe("needs-modifier");
    expect(r.refusal("F5")).toBeUndefined();
    expect(r.refusal("Mod+K")).toBeUndefined();
    expect(r.refusal("Alt+ArrowLeft")).toBeUndefined();
  });
});

describe("availability", () => {
  it("lets a key through when the command is not available", () => {
    const r = reg();
    let ok = false;
    r.add("plug", binding("p:cmd", ["Mod+Shift+J"], { available: () => ok }), { strict: false });
    const e = key({ key: "J", metaKey: true, shiftKey: true });
    expect(r.find(e, "bubble")).toBeUndefined();
    ok = true;
    expect(r.find(e, "bubble")?.id).toBe("p:cmd");
  });
});

describe("tolerant registration (plugins)", () => {
  it("does not throw on a taken or reserved default; the key just has no effect", () => {
    const r = reg();
    r.add("core", binding("a", ["Mod+K"]));
    expect(() =>
      r.add("plug", binding("p:cmd", ["Mod+K", "Mod+Q", "Mod+Shift+K"]), { strict: false }),
    ).not.toThrow();
    expect(r.effectiveKeys("p:cmd")).toEqual(["Mod+Shift+K"]);
    expect(r.effectiveKeys("a")).toEqual(["Mod+K"]);
  });
});

describe("the recorder's chord from a key press", () => {
  const press = (init: KeyboardEventInit & { code?: string }) =>
    eventToChord(
      {
        key: "",
        code: "",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...init,
      },
      "macos",
    );

  it("ignores a lone modifier", () => {
    for (const k of ["Meta", "Control", "Alt", "Shift", "CapsLock", "Dead"])
      expect(press({ key: k, metaKey: true }), k).toBeNull();
  });

  it("is Mod for the platform key and Ctrl/Meta for the other", () => {
    expect(press({ key: "t", metaKey: true, shiftKey: true })).toBe("Mod+Shift+T");
    expect(press({ key: "Tab", ctrlKey: true })).toBe("Ctrl+Tab");
    expect(
      eventToChord(
        { key: "t", code: "KeyT", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        "windows",
      ),
    ).toBe("Mod+T");
    expect(
      eventToChord(
        { key: "t", code: "KeyT", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        "linux",
      ),
    ).toBe("Meta+T");
  });

  it("uses the physical key when Option changes the character", () => {
    expect(press({ key: "å", code: "KeyA", altKey: true })).toBe("Alt+A");
    expect(press({ key: "¡", code: "Digit1", altKey: true, metaKey: true })).toBe("Mod+Alt+1");
  });

  it("records arrows, function keys and symbols; a bare letter is not bindable", () => {
    expect(press({ key: "ArrowLeft", altKey: true })).toBe("Alt+ArrowLeft");
    expect(press({ key: "F5" })).toBe("F5");
    expect(press({ key: "+", metaKey: true, shiftKey: true })).toBe("Mod+Shift++");
    expect(isBindableChord(press({ key: "F5" })!)).toBe(true);
    expect(isBindableChord(press({ key: "a" })!)).toBe(false);
    expect(isBindableChord(press({ key: "A", shiftKey: true })!)).toBe(false);
  });
});

describe("Obsidian hotkeys <-> chords", () => {
  it("maps modifiers and keys both ways", () => {
    expect(obsidianToChord({ modifiers: ["Mod", "Shift"], key: "t" })).toBe("Mod+Shift+T");
    expect(obsidianToChord({ modifiers: ["Ctrl"], key: "s" })).toBe("Ctrl+S");
    expect(obsidianToChord({ modifiers: ["Meta", "Alt"], key: "ArrowLeft" })).toBe(
      "Meta+Alt+ArrowLeft",
    );
    expect(chordToObsidian("Mod+Shift+T")).toEqual({ modifiers: ["Mod", "Shift"], key: "t" });
    expect(chordToObsidian("Alt+ArrowLeft")).toEqual({ modifiers: ["Alt"], key: "ArrowLeft" });
  });

  it("returns null for an unknown modifier or a broken key", () => {
    expect(obsidianToChord({ modifiers: ["Super"], key: "t" })).toBeNull();
    expect(obsidianToChord({ modifiers: ["Mod"], key: "" })).toBeNull();
    expect(obsidianToChord({ modifiers: ["Mod"], key: "two words" })).toBeNull();
    expect(obsidianToChord({ modifiers: "Mod", key: "t" } as never)).toBeNull();
  });
});

describe("HotkeyOverrides (hotkeys.json)", () => {
  const setup = (text: string | null = null, os: "mac" | "windows" | "linux" = "mac") => {
    const r = reg();
    r.add("core", binding("a", ["Mod+1"]));
    r.addCommand("core", { id: "b", description: "b", run: () => {} });
    const writes: string[] = [];
    const io = {
      read: vi.fn(async () => text),
      write: vi.fn(async (t: string) => void writes.push(t)),
    };
    const o = new HotkeyOverrides(r, () => os, io);
    return { r, o, io, writes };
  };

  it("loads only the current OS's section", async () => {
    const file = JSON.stringify({
      version: 1,
      mac: { a: ["Mod+Shift+1"] },
      windows: { a: ["Ctrl+Alt+1"], b: ["Ctrl+B"] },
    });
    const { r, o } = setup(file, "windows");
    await o.load();
    expect(r.effectiveKeys("a")).toEqual(["Ctrl+Alt+1"]);
    expect(r.effectiveKeys("b")).toEqual(["Ctrl+B"]);
    const mac = setup(file, "mac");
    await mac.o.load();
    expect(mac.r.effectiveKeys("a")).toEqual(["Mod+Shift+1"]);
    expect(mac.r.effectiveKeys("b")).toEqual([]);
  });

  it("stores a new key under the current OS only and keeps the other sections", async () => {
    const { r, o, writes } = setup(
      JSON.stringify({ version: 1, windows: { a: ["Ctrl+Alt+1"] }, linux: { b: ["Ctrl+B"] } }),
    );
    await o.load();
    await o.setKeys("b", ["Mod+Shift+B"]);
    expect(r.effectiveKeys("b")).toEqual(["Mod+Shift+B"]);
    expect(JSON.parse(writes.at(-1)!)).toEqual({
      version: 1,
      mac: { b: ["Mod+Shift+B"] },
      windows: { a: ["Ctrl+Alt+1"] },
      linux: { b: ["Ctrl+B"] },
    });
  });

  it("resets one command, or all of this OS, and `[]` is stored as removal", async () => {
    const { r, o, writes } = setup();
    await o.load();
    await o.setKeys("a", []);
    expect(JSON.parse(writes.at(-1)!).mac).toEqual({ a: [] });
    expect(r.effectiveKeys("a")).toEqual([]);
    await o.setKeys("b", ["Mod+Shift+B"]);
    await o.setKeys("a", null);
    expect(JSON.parse(writes.at(-1)!).mac).toEqual({ b: ["Mod+Shift+B"] });
    await o.resetAll();
    expect(JSON.parse(writes.at(-1)!).mac).toEqual({});
    expect(r.isModified("b")).toBe(false);
  });

  it("applies changes in order and normalizes chords", async () => {
    const { r, o, writes } = setup();
    await o.load();
    await Promise.all([o.setKeys("b", ["shift+mod+x"]), o.setKeys("b", ["Mod+Shift+Y"])]);
    expect(writes).toHaveLength(2);
    expect(r.effectiveKeys("b")).toEqual(["Mod+Shift+Y"]);
  });

  it("a failed save rejects and changes nothing", async () => {
    const { r, o, io } = setup();
    await o.load();
    io.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(o.setKeys("b", ["Mod+Shift+B"])).rejects.toThrow("disk full");
    expect(r.effectiveKeys("b")).toEqual([]);
    // the queue keeps working after a failure
    await o.setKeys("b", ["Mod+Shift+C"]);
    expect(r.effectiveKeys("b")).toEqual(["Mod+Shift+C"]);
  });

  it("reports an unreadable file, keeps the defaults and says so to listeners", async () => {
    const { r, o, io } = setup();
    const seen = vi.fn();
    o.onLoaded(seen);
    io.read.mockRejectedValueOnce(new Error("hotkeys.json is not valid"));
    await o.load();
    expect(o.loadError).toContain("not valid");
    expect(r.effectiveKeys("a")).toEqual(["Mod+1"]);
    expect(seen).toHaveBeenCalled();
    await o.load();
    expect(o.loadError).toBeNull();
  });
});
