// The keybinding registry: chord parsing and matching, conflict detection, the dispatch quirks the
// old `if` chain had (kept exactly), docs/keyboard-shortcuts.md vs the registry, and the palette
// showing the registry's key.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import "../src/lib/features/builtin";
import { useKeyboardShortcuts } from "../src/hooks/use-keyboard-shortcuts";
import {
  chordMatches,
  formatChord,
  normalizeChord,
  parseChord,
} from "../src/lib/keybindings/chord";
import { CORE_BINDINGS } from "../src/lib/keybindings/core-bindings";
import {
  KeybindingConflictError,
  KeybindingRegistry,
  keybindings,
  resolveKeys,
  type Keybinding,
} from "../src/lib/keybindings/registry";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const key = (init: KeyboardEventInit & { code?: string }) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
const always = {
  "not-compact": () => true,
  "editor-not-focused": () => true,
  "outside-agent-pane": () => true,
  "image-viewer": () => true,
  "no-image-viewer": () => true,
};
const binding = (id: string, keys: string[], over: Partial<Keybinding> = {}): Keybinding => ({
  id,
  keys,
  description: id,
  category: "Feature",
  run: () => {},
  ...over,
});

describe("chords", () => {
  it("normalizes equal chords to one spelling", () => {
    expect(normalizeChord("Shift+Mod+t")).toBe("Mod+Shift+T");
    expect(normalizeChord("Mod++")).toBe("Mod++");
    expect(normalizeChord("Alt+ArrowLeft")).toBe("Alt+ArrowLeft");
  });

  it("rejects malformed chords", () => {
    expect(() => parseChord("Cmd+P")).toThrow(/Invalid key chord/);
    expect(() => parseChord("")).toThrow();
  });

  it("formats per platform", () => {
    expect(formatChord("Mod+Shift+T", "macos")).toBe("⇧⌘T");
    expect(formatChord("Mod+Shift+T", "linux")).toBe("Ctrl+Shift+T");
    expect(formatChord("Alt+ArrowLeft", "macos")).toBe("⌥Left");
  });

  it("matches modifiers exactly, Mod as Cmd or Ctrl", () => {
    const t = parseChord("Mod+T");
    expect(chordMatches(t, key({ key: "t", metaKey: true }))).toBe(true);
    expect(chordMatches(t, key({ key: "t", ctrlKey: true }))).toBe(true);
    expect(chordMatches(t, key({ key: "t" }))).toBe(false);
    expect(chordMatches(t, key({ key: "T", metaKey: true, shiftKey: true }))).toBe(false);
    expect(chordMatches(t, key({ key: "t", metaKey: true, altKey: true }))).toBe(false);
  });

  it("matches the physical key only when asked and the layout is non-Latin", () => {
    const t = parseChord("Mod+Shift+T");
    const cyr = key({ key: "е", code: "KeyT", metaKey: true, shiftKey: true });
    expect(chordMatches(t, cyr)).toBe(false);
    expect(chordMatches(t, cyr, { layoutIndependent: true })).toBe(true);
    // a Latin key on another physical position is not matched
    expect(
      chordMatches(t, key({ key: "y", code: "KeyT", metaKey: true, shiftKey: true }), {
        layoutIndependent: true,
      }),
    ).toBe(false);
  });
});

describe("conflict detection", () => {
  const reg = () => new KeybindingRegistry(always, () => "macos");

  it("refuses a chord that is already bound and names both owners and the key", () => {
    const r = reg();
    r.add("core", binding("new-tab", ["Mod+T"]));
    expect(() => r.add("builtin:tables", binding("tables.new", ["Mod+t"]))).toThrow(
      /⌘T is already bound to "new-tab" \(core\); cannot bind it to "tables.new" \(builtin:tables\)/,
    );
    expect(r.list().map((b) => b.id)).toEqual(["new-tab"]);
  });

  it("refuses a duplicate id, a repeated chord and a reserved system chord", () => {
    const r = reg();
    r.add("core", binding("a", ["Mod+1"]));
    expect(() => r.add("x", binding("a", ["Mod+2"]))).toThrow(KeybindingConflictError);
    expect(() => r.add("x", binding("b", ["Mod+3", "Mod+3"]))).toThrow(/listed twice/);
    expect(() => r.add("x", binding("c", ["Mod+Q"]))).toThrow(/reserved/);
  });

  it("allows one chord under two different named contexts, not under none", () => {
    const r = reg();
    r.add("core", binding("a", ["Mod+K"], { when: "editor-not-focused" }));
    r.add("core", binding("b", ["Mod+K"], { when: "not-compact" }));
    expect(() => r.add("core", binding("c", ["Mod+K"]))).toThrow(/already bound/);
  });

  it("frees the chord when the owner is removed", () => {
    const r = reg();
    r.add("builtin:x", binding("x.a", ["Mod+J"]));
    r.removeOwner("builtin:x");
    r.add("core", binding("y", ["Mod+J"]));
    expect(r.list()).toHaveLength(1);
  });

  it("the app's core bindings have no conflict (they were registered at import)", () => {
    const ids = new Set(keybindings.list().map((b) => b.id));
    expect(CORE_BINDINGS.every((b) => ids.has(b.id))).toBe(true);
    const chords = CORE_BINDINGS.flatMap((b) =>
      resolveKeys(b.keys, "mac").map(
        (k) => `${b.when ?? ""}|${b.phase ?? ""}|${normalizeChord(k)}`,
      ),
    );
    expect(new Set(chords).size).toBe(chords.length);
  });
});

/** Chords in the "Global" table of docs/keyboard-shortcuts.md, as registry spellings. */
function documentedGlobalChords(): string[] {
  const md = readFileSync(join(import.meta.dirname, "../../../docs/keyboard-shortcuts.md"), "utf8");
  const section = md.split("\n## ")[1]!; // "Global" is the first section
  expect(section.startsWith("Global")).toBe(true);
  const rows = section.split("\n").filter((l: string) => /^\| (Cmd|Ctrl|Alt)/.test(l));
  const chords: string[] = [];
  for (const row of rows) {
    const cell = row.split("|")[1]!.trim().replace(/\\\\/g, "\\");
    if (/^Cmd\+1 \.\.\. Cmd\+9$/.test(cell)) {
      for (let i = 1; i <= 9; i++) chords.push(`Mod+${i}`);
      continue;
    }
    for (const part of cell.split(" / ")) chords.push(part.replace(/^Cmd/, "Mod"));
  }
  return chords.map(normalizeChord);
}

describe("docs/keyboard-shortcuts.md Global table", () => {
  // Core bindings plus what the built-in features contribute (Cmd+Shift+A is the agent's).
  const registryChords = () =>
    new Set(keybindings.list().flatMap((b) => keybindings.defaultKeys(b.id)));

  it("has a registry entry for every documented shortcut", () => {
    const docs = documentedGlobalChords();
    expect(docs.length).toBeGreaterThanOrEqual(20);
    // `Cmd+[` / `Cmd+]` are Meta-only in the registry; docs say Cmd.
    const known = new Set([...registryChords()].map((c) => c.replace("Meta+", "Mod+")));
    const missing = docs.filter((c) => !known.has(c));
    expect(missing).toEqual([]);
  });

  it("documents every registry shortcut", () => {
    const docs = new Set(documentedGlobalChords());
    const undocumented = [...registryChords()]
      .map((c) => c.replace("Meta+", "Mod+"))
      .filter((c) => !docs.has(c));
    expect(undocumented).toEqual([]);
  });
});

describe("the palette shows the registry's shortcut", () => {
  it("never types a key of its own", async () => {
    const { BUILTIN_COMMANDS, resolveCommands } =
      await import("../src/components/command-palette/commands");
    const noop = () => {};
    const ctx = new Proxy(
      {
        hasWorkspace: true,
        isCompactFileMode: false,
        activeFilePath: "/a.md",
        hasActiveTab: true,
        unpinnedTabCount: 1,
        activeTabPin: "unpinned",
        hasClosedTabs: true,
        close: noop,
      },
      { get: (t, k) => (k in t ? (t as never)[k] : noop) },
    ) as never;
    const list = resolveCommands(ctx);
    const bound = new Set(CORE_BINDINGS.map((b) => b.id));
    for (const c of list) {
      expect(c.shortcut, c.id).toBe(keybindings.shortcutFor(c.id));
      if (bound.has(c.id)) expect(c.shortcut, c.id).toBeTruthy();
    }
    const sidebar = list.find((c) => c.id === "toggle-sidebar")!;
    expect(sidebar.shortcut).toBe(keybindings.shortcutFor("toggle-sidebar"));
    expect(list.find((c) => c.id === "pin-tab")!.shortcut).toBeUndefined();
    expect(BUILTIN_COMMANDS.some((c) => c.id === "toggle-sidebar")).toBe(true);
  });
});

describe("dispatch keeps the old handler behaviour", () => {
  let root: Root;
  function Harness() {
    useKeyboardShortcuts();
    return null;
  }
  const press = (e: KeyboardEvent, target: EventTarget = window) => {
    act(() => void target.dispatchEvent(e));
    return e;
  };
  const back = vi.fn(async () => {});
  const forward = vi.fn(async () => {});

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    back.mockClear();
    forward.mockClear();
    useEditorStore.setState({ navigateBack: back, navigateForward: forward });
    useWorkspaceStore.setState({ root: "/ws", chromeMode: "workspace" });
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("Cmd+[ and Cmd+] go back and forward in the capture phase, ignoring repeats", () => {
    const seenByBubble = vi.fn();
    window.addEventListener("keydown", seenByBubble);
    const e = press(key({ key: "[", metaKey: true }), document.body);
    expect(e.defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(seenByBubble).not.toHaveBeenCalled(); // stopPropagation in capture
    press(key({ key: "]", metaKey: true }), document.body);
    expect(forward).toHaveBeenCalledTimes(1);
    const rep = press(key({ key: "[", metaKey: true, repeat: true }), document.body);
    expect(rep.defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", seenByBubble);
  });

  it("Cmd+[ is left to the agent pane inside it, and Ctrl+[ or Cmd+Shift+[ are not history", () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-agent-pane", "");
    document.body.append(pane);
    expect(press(key({ key: "[", metaKey: true }), pane).defaultPrevented).toBe(false);
    expect(press(key({ key: "[", ctrlKey: true }), document.body).defaultPrevented).toBe(false);
    expect(
      press(key({ key: "[", metaKey: true, shiftKey: true }), document.body).defaultPrevented,
    ).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it("Alt+Arrow navigates outside the editor and is left to CodeMirror inside it", () => {
    expect(press(key({ key: "ArrowLeft", altKey: true })).defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(press(key({ key: "ArrowRight", altKey: true })).defaultPrevented).toBe(false);
    expect(forward).not.toHaveBeenCalled();
  });

  it("Cmd+W falls through untouched in the compact window", () => {
    useWorkspaceStore.setState({ root: null, chromeMode: "compact-file" });
    expect(press(key({ key: "w", metaKey: true })).defaultPrevented).toBe(false);
    // other chords still swallow the key in compact mode and do nothing
    expect(press(key({ key: "t", metaKey: true })).defaultPrevented).toBe(true);
  });

  it("an unbound chord is not touched", () => {
    expect(press(key({ key: "b", metaKey: true })).defaultPrevented).toBe(false);
  });
});
