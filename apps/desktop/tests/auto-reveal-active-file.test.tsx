// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const reveal = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/reveal-in-sidebar", () => ({ revealPathInSidebar: reveal }));

import {
  AUTO_REVEAL_DEBOUNCE_MS,
  AUTO_REVEAL_POINTER_PAUSE_MS,
  isRevealablePath,
  useAutoRevealActiveFile,
} from "../src/hooks/use-auto-reveal-active-file";
import { SETTINGS_SCHEMA } from "../src/lib/settings-schema";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "/synthetic-vault";
let container: HTMLElement;
let root: Root;
let props: { renamingPath: string | null; everythingCollapsed: boolean };

function Harness() {
  useAutoRevealActiveFile(props);
  return (
    <div data-sidebar-surface>
      <input id="editor" />
    </div>
  );
}

const render = () => act(async () => root.render(<Harness />));
const setActive = (path: string | null) =>
  act(async () => useEditorStore.setState({ activeFilePath: path }));
const setSettings = (settings: Record<string, unknown>) =>
  act(async () => useSettingsStore.setState({ settings }));
const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

beforeEach(async () => {
  vi.useFakeTimers();
  reveal.mockClear();
  props = { renamingPath: null, everythingCollapsed: false };
  useWorkspaceStore.setState({ root: ROOT });
  useEditorStore.setState({ activeFilePath: null });
  useSettingsStore.setState({ settings: {} }); // fresh settings file: key missing
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.classList.remove("tree-dragging");
  vi.useRealTimers();
});

describe("auto-reveal setting", () => {
  it("is declared once, global, default on", () => {
    const def = SETTINGS_SCHEMA.find((d) => d.key === "sidebar.auto-reveal-active-file")!;
    expect(def.default).toBe(true);
    expect(def.type).toBe("boolean");
    expect(def.label).toBe("Auto-reveal current file");
  });
});

describe("useAutoRevealActiveFile", () => {
  it("reveals on a fresh settings file (missing key = on), centered", async () => {
    await setActive(`${ROOT}/a/b/note.md`);
    await tick(AUTO_REVEAL_DEBOUNCE_MS);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(`${ROOT}/a/b/note.md`, { center: true });
  });

  it("does nothing when turned off, and resumes when turned back on", async () => {
    await setSettings({ "sidebar.auto-reveal-active-file": false });
    await setActive(`${ROOT}/a/note.md`);
    await tick(1000);
    expect(reveal).not.toHaveBeenCalled();
    await setSettings({ "sidebar.auto-reveal-active-file": true });
    await tick(AUTO_REVEAL_DEBOUNCE_MS);
    expect(reveal).toHaveBeenCalledWith(`${ROOT}/a/note.md`, { center: true });
  });

  it("debounces rapid changes to the last file", async () => {
    await setActive(`${ROOT}/one.md`);
    await tick(50);
    await setActive(`${ROOT}/two.md`);
    await tick(50);
    await setActive(`${ROOT}/three.md`);
    await tick(AUTO_REVEAL_DEBOUNCE_MS);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(`${ROOT}/three.md`, { center: true });
  });

  it("ignores null, outside-root and hidden-folder paths", async () => {
    for (const p of [null, "/elsewhere/x.md", `${ROOT}/.obsidian/x.md`, `${ROOT}/a/.git/x.md`]) {
      await setActive(p);
      await tick(1000);
    }
    expect(reveal).not.toHaveBeenCalled();
    expect(isRevealablePath(ROOT, `${ROOT}/.hidden.md`)).toBe(false);
    expect(isRevealablePath(ROOT, `${ROOT}/ok/x.md`)).toBe(true);
  });

  it("defers while the sidebar is collapsed and reveals when it opens", async () => {
    await setSettings({ "appearance.sidebar-visible": false });
    await setActive(`${ROOT}/a/note.md`);
    await tick(1000);
    expect(reveal).not.toHaveBeenCalled();
    await setSettings({ "appearance.sidebar-visible": true });
    await tick(AUTO_REVEAL_DEBOUNCE_MS);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("does not reveal into a collapsed Everything section", async () => {
    props = { renamingPath: null, everythingCollapsed: true };
    await render();
    await setActive(`${ROOT}/a/note.md`);
    await tick(1000);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("waits out an active rename", async () => {
    props = { renamingPath: `${ROOT}/x.md`, everythingCollapsed: false };
    await render();
    await setActive(`${ROOT}/a/note.md`);
    await tick(2000);
    expect(reveal).not.toHaveBeenCalled();
    props = { renamingPath: null, everythingCollapsed: false };
    await render();
    await tick(500);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("waits out a drag", async () => {
    document.body.classList.add("tree-dragging");
    await setActive(`${ROOT}/a/note.md`);
    await tick(1000);
    expect(reveal).not.toHaveBeenCalled();
    document.body.classList.remove("tree-dragging");
    await tick(500);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("pauses briefly after pointer use in the sidebar", async () => {
    await act(async () => {
      container
        .querySelector("[data-sidebar-surface]")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await setActive(`${ROOT}/a/note.md`);
    await tick(AUTO_REVEAL_DEBOUNCE_MS + 100);
    expect(reveal).not.toHaveBeenCalled();
    await tick(AUTO_REVEAL_POINTER_PAUSE_MS + 300);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("never moves keyboard focus", async () => {
    const input = container.querySelector<HTMLInputElement>("#editor")!;
    input.focus();
    await setActive(`${ROOT}/a/note.md`);
    await tick(1000);
    expect(reveal).toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
