// Settings > Hotkeys in a DOM: every palette command listed by owner with its key, recording
// (Enter saves, Esc cancels, lone modifiers ignored, reserved refused, conflict -> Reassign),
// search by name and by pressed keys, remove / reset / reset all, import from Obsidian.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ipc = vi.hoisted(() => ({
  stored: null as string | null,
  obsidian: null as string | null,
  writes: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(async (cmd: string, args?: { content?: string }) => {
    if (cmd === "hotkeys_read") return ipc.stored;
    if (cmd === "hotkeys_write") {
      ipc.stored = args!.content!;
      ipc.writes.push(args!.content!);
      return undefined;
    }
    if (cmd === "hotkeys_read_obsidian") return ipc.obsidian;
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/platform", () => ({ detectPlatform: () => "macos" }));

import { hotkeyOverrides } from "@/lib/keybindings/overrides";
import { isKeyRecording } from "@/lib/keybindings/recording";
import { keybindings } from "@/lib/keybindings/registry";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { HotkeysSection } from "../web/hotkeys-section";

let root: Root;
let host: HTMLElement;

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const row = (id: string) => q(`[data-hotkey-row="${id}"]`)!;
const byLabel = (label: string) => q<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const flush = () => act(async () => {});
const click = (el: Element) =>
  act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, init: KeyboardEventInit & { code?: string }) =>
  act(
    () =>
      void el.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      ),
  );
const type = (el: HTMLInputElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const recorder = () => q("[data-key-recorder]")!;
const stored = () => (ipc.stored ? (JSON.parse(ipc.stored).mac as Record<string, string[]>) : {});

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ipc.stored = null;
  ipc.obsidian = null;
  ipc.writes = [];
  await hotkeyOverrides.load();
  useWorkspaceStore.setState({ root: "/ws" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(HotkeysSection)));
  await flush();
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  ipc.stored = null;
  await hotkeyOverrides.load();
});

describe("the list", () => {
  it("lists every palette command, grouped by owner, with its effective key", () => {
    expect(q('[data-hotkey-group="Writer"]')).not.toBeNull();
    const reopen = row("reopen-closed-tab");
    expect(reopen.textContent).toContain("Reopen Closed Tab");
    expect(reopen.textContent).toContain("⇧⌘T");
    expect(row("toggle-theme").textContent).toContain("—"); // a command with no key
    expect(row("toggle-theme").querySelector("[data-hotkey-modified]")).toBeNull();
    // every palette command of the registry has a row
    const commandIds = keybindings.list().map((b) => b.id);
    for (const id of commandIds) expect(q(`[data-hotkey-row="${id}"]`), id).not.toBeNull();
  });

  it("shows keys it cannot change without controls", () => {
    expect(row("jump-to-tab").querySelector('[aria-label^="Change the key"]')).toBeNull();
  });
});

describe("recording a key", () => {
  it("captures a chord, Enter saves it for this OS, and it works at once", async () => {
    await click(byLabel("Change the key of Toggle Dark Mode"));
    expect(isKeyRecording()).toBe(true);
    expect(recorder().textContent).toContain("Press keys");
    await press(recorder(), { key: "Meta", metaKey: true }); // a lone modifier is ignored
    expect(recorder().textContent).toContain("Press keys");
    await press(recorder(), { key: "d", metaKey: true, shiftKey: true });
    expect(q("[data-recorder-keys]")!.textContent).toBe("⇧⌘D");
    expect(ipc.writes).toHaveLength(0);
    await press(recorder(), { key: "Enter" });
    await flush();
    expect(stored()).toEqual({ "toggle-theme": ["Mod+Shift+D"] });
    expect(JSON.parse(ipc.stored!).windows).toEqual({});
    expect(q("[data-key-recorder]")).toBeNull();
    expect(isKeyRecording()).toBe(false);
    expect(row("toggle-theme").textContent).toContain("⇧⌘D");
    expect(row("toggle-theme").textContent).toContain("modified");
    expect(keybindings.effectiveKeys("toggle-theme")).toEqual(["Mod+Shift+D"]);
  });

  it("Escape cancels and Backspace clears what was pressed, writing nothing", async () => {
    await click(byLabel("Change the key of Toggle Dark Mode"));
    await press(recorder(), { key: "d", metaKey: true, shiftKey: true });
    await press(recorder(), { key: "Backspace" });
    expect(recorder().textContent).toContain("Press keys");
    await press(recorder(), { key: "d", metaKey: true, shiftKey: true });
    await press(recorder(), { key: "Escape" });
    expect(q("[data-key-recorder]")).toBeNull();
    expect(ipc.writes).toHaveLength(0);
    expect(isKeyRecording()).toBe(false);
  });

  it("refuses a reserved chord and a bare key with a one-line reason, and Enter does nothing", async () => {
    await click(byLabel("Change the key of Toggle Dark Mode"));
    await press(recorder(), { key: "q", metaKey: true });
    expect(q("[data-recorder-note]")!.textContent).toBe("Reserved by the system");
    await press(recorder(), { key: "Enter" });
    expect(ipc.writes).toHaveLength(0);
    await press(recorder(), { key: "k" });
    expect(q("[data-recorder-note]")!.textContent).toBe("Needs Cmd, Ctrl or Alt");
  });

  it("offers Reassign on a key another command has, and Reassign moves it", async () => {
    await click(byLabel("Change the key of Toggle Dark Mode"));
    await press(recorder(), { key: "t", metaKey: true, shiftKey: true });
    expect(q("[data-recorder-note]")!.textContent).toBe("Used by Reopen Closed Tab");
    await press(recorder(), { key: "Enter" });
    expect(ipc.writes).toHaveLength(0); // Enter does not resolve a conflict
    const reassign = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Reassign",
    )!;
    await click(reassign);
    await flush();
    expect(stored()).toEqual({ "reopen-closed-tab": [], "toggle-theme": ["Mod+Shift+T"] });
    expect(row("reopen-closed-tab").textContent).toContain("—");
    expect(row("toggle-theme").textContent).toContain("⇧⌘T");
  });

  it("Cancel on a conflict leaves everything as it was", async () => {
    await click(byLabel("Change the key of Toggle Dark Mode"));
    await press(recorder(), { key: "t", metaKey: true, shiftKey: true });
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
    expect(q("[data-key-recorder]")).toBeNull();
    expect(ipc.writes).toHaveLength(0);
  });

  it("+ adds a second key next to the first", async () => {
    await click(byLabel("Add a key to Reopen Closed Tab"));
    await press(recorder(), { key: "r", altKey: true, code: "KeyR" });
    await press(recorder(), { key: "Enter" });
    await flush();
    expect(stored()["reopen-closed-tab"]).toEqual(["Mod+Shift+T", "Alt+R"]);
    expect(row("reopen-closed-tab").textContent).toContain("⇧⌘T");
    expect(row("reopen-closed-tab").textContent).toContain("+⌥R");
  });
});

describe("removing and resetting", () => {
  it("Backspace on a focused key removes it; the reset arrow restores the default", async () => {
    await click(byLabel("Add a key to Reopen Closed Tab"));
    await press(recorder(), { key: "r", altKey: true, code: "KeyR" });
    await press(recorder(), { key: "Enter" });
    await flush();
    await press(q('[data-key-chip="Alt+R"]')!, { key: "Backspace" });
    await flush();
    expect(keybindings.effectiveKeys("reopen-closed-tab")).toEqual(["Mod+Shift+T"]);
    expect(stored()).toEqual({}); // back to the default: no override kept

    await click(byLabel("Change the key of Reopen Closed Tab"));
    await press(recorder(), { key: "k", metaKey: true, shiftKey: true });
    await press(recorder(), { key: "Enter" });
    await flush();
    await click(byLabel("Reset Reopen Closed Tab"));
    await flush();
    expect(keybindings.effectiveKeys("reopen-closed-tab")).toEqual(["Mod+Shift+T"]);
    expect(stored()).toEqual({});
  });

  it("Reset all asks first, then clears every key of this OS", async () => {
    await click(byLabel("Change the key of Toggle Dark Mode"));
    await press(recorder(), { key: "d", metaKey: true, shiftKey: true });
    await press(recorder(), { key: "Enter" });
    await flush();
    expect(Object.keys(stored())).toHaveLength(1);
    const resetAll = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Reset all",
    )!;
    await click(resetAll);
    expect(document.body.textContent).toContain("Reset all hotkeys?");
    const confirm = [...document.body.querySelectorAll("button")].filter(
      (b) => b.textContent === "Reset all",
    );
    await click(confirm.at(-1)!);
    await flush();
    expect(stored()).toEqual({});
    expect(keybindings.isModified("toggle-theme")).toBe(false);
  });
});

describe("search", () => {
  const search = () => q<HTMLInputElement>("[data-hotkeys-search]")!;

  it("filters by name", () => {
    type(search(), "dark mode");
    expect(q('[data-hotkey-row="toggle-theme"]')).not.toBeNull();
    expect(q('[data-hotkey-row="reopen-closed-tab"]')).toBeNull();
    type(search(), "zzzz");
    expect(q("[data-hotkeys-empty]")).not.toBeNull();
  });

  it("finds the command bound to the keys pressed in it, and the keys are not run", async () => {
    search().focus();
    await act(async () => void search().dispatchEvent(new FocusEvent("focus", { bubbles: false })));
    await act(
      async () => void search().dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
    );
    expect(isKeyRecording()).toBe(true); // the app's own shortcuts stand down while it is focused
    await press(search(), { key: "T", metaKey: true, shiftKey: true });
    expect(search().value).toBe("⇧⌘T");
    expect(q('[data-hotkey-row="reopen-closed-tab"]')).not.toBeNull();
    expect(q('[data-hotkey-row="toggle-theme"]')).toBeNull();
    // typing a plain character goes back to a name search
    await press(search(), { key: "x" });
    expect(search().value).toBe("");
  });
});

describe("import from Obsidian", () => {
  const importButton = () =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Import from Obsidian")!;

  it("applies the vault's keys as overrides and says what it did", async () => {
    ipc.obsidian = JSON.stringify({
      "reopen-closed-tab": [{ modifiers: ["Mod", "Shift"], key: "k" }],
      "app:go-back": [{ modifiers: ["Mod"], key: "[" }],
    });
    await click(importButton());
    await flush();
    expect(q("[data-hotkeys-status]")!.textContent).toBe("Imported 1, skipped 1");
    expect(stored()).toEqual({ "reopen-closed-tab": ["Mod+Shift+K"] });
  });

  it("says so when the vault has no hotkeys file, and when it cannot be read", async () => {
    await click(importButton());
    await flush();
    expect(q("[data-hotkeys-status]")!.textContent).toBe("No hotkeys.json in .obsidian");
    ipc.obsidian = "not json";
    await click(importButton());
    await flush();
    expect(q("[data-hotkeys-status]")!.textContent).toMatch(/not valid JSON/);
    expect(ipc.writes).toHaveLength(0);
  });

  it("is off when no workspace is open", async () => {
    useWorkspaceStore.setState({ root: null });
    await flush();
    expect(importButton().disabled).toBe(true);
  });
});
