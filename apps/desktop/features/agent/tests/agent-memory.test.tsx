// Settings > Agent > Memory: the mode, the folders and their files, delete, Forget all with a
// confirmation, the import button and its report. Every command goes through the plugin route;
// no path is built in the UI.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invokeMock = vi.hoisted(() => vi.fn());
const openTab = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/hooks/editor-api", () => ({ openFileInNewTab: openTab }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { useAgentStore } from "@/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { AgentMemory } from "../web/agent-memory";
import type { ImportReport, MemoryOverview } from "../web/bindings";
import {
  MEMORY_PROJECT_DIR as PROJECT,
  MEMORY_VAULT_DIR as VAULT,
  memoryOverview,
} from "./memory-fixture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Settings > Agent > Memory", () => {
  let container: HTMLElement;
  let root: Root;
  let current: MemoryOverview;
  let importReport: ImportReport;
  const calls: [string, Record<string, unknown>][] = [];

  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const all = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const button = (text: string, within: ParentNode = container) =>
    [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  const flush = () => act(async () => {});
  const click = async (el: Element | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  async function mount() {
    await act(async () => {
      root.render(<AgentMemory />);
    });
    await flush();
  }
  const memoryCalls = (cmd: string) => calls.filter(([c]) => c === `plugin:agent|${cmd}`);

  beforeEach(() => {
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    calls.length = 0;
    current = memoryOverview();
    importReport = { foldersFound: 2, imported: 3, skipped: 1 };
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      if (cmd === "plugin:agent|agent_memory_list") return current;
      if (cmd === "plugin:agent|agent_memory_delete") {
        const name = args.name as string;
        current = {
          ...current,
          vault: { ...current.vault, files: current.vault.files.filter((f) => f.name !== name) },
        };
        return null;
      }
      if (cmd === "plugin:agent|agent_memory_forget_all") {
        current = { ...current, vault: { ...current.vault, files: [] } };
        return 2;
      }
      if (cmd === "plugin:agent|agent_memory_import_claude") return importReport;
      if (cmd === "set_setting") return args.value;
      return null;
    });
    openTab.mockClear();
    useSettingsStore.setState({
      settings: Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default])),
      isLoaded: true,
    });
    useAgentStore.setState({ currentProjectPath: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the mode, the plain-text warning and the vault memory path and files", async () => {
    await mount();
    expect(container.textContent).toMatch(/plain Markdown/);
    expect(container.textContent).toMatch(/do not ask the agent to remember secrets/);
    expect(container.textContent).toMatch(/Agent memory/);
    expect(q("[data-agent-memory-folder=vault] [data-agent-memory-path]")?.textContent).toBe(VAULT);
    expect(all("[data-agent-memory-file]").map((e) => e.dataset.agentMemoryFile)).toEqual([
      "MEMORY.md",
      "user-cat.md",
    ]);
    expect(q("[data-agent-memory-folder=project]")).toBeNull();
    expect(memoryCalls("agent_memory_list")[0]![1]).toEqual({ projectPath: null });
  });

  it("lists the current project's memory next to the vault's", async () => {
    useAgentStore.setState({ currentProjectPath: "Projects/P" });
    current = memoryOverview({ project: true });
    await mount();
    expect(memoryCalls("agent_memory_list")[0]![1]).toEqual({ projectPath: "Projects/P" });
    expect(q("[data-agent-memory-folder=project] [data-agent-memory-path]")?.textContent).toBe(
      PROJECT,
    );
  });

  it("opens a memory file as a note tab and reveals the folder", async () => {
    await mount();
    await click(q("button[aria-label='Open user-cat.md']") ?? undefined);
    expect(openTab).toHaveBeenCalledWith(`${VAULT}/user-cat.md`);
    await click(button("Open folder", q("[data-agent-memory-folder=vault]")!));
    expect(calls.some(([c, a]) => c === "reveal_in_file_manager" && a.path === VAULT)).toBe(true);
  });

  it("deletes one file by name and refreshes the list", async () => {
    await mount();
    await click(q("button[aria-label='Delete user-cat.md']") ?? undefined);
    expect(memoryCalls("agent_memory_delete")[0]![1]).toEqual({
      scope: "vault",
      projectPath: null,
      name: "user-cat.md",
    });
    expect(all("[data-agent-memory-file]").map((e) => e.dataset.agentMemoryFile)).toEqual([
      "MEMORY.md",
    ]);
  });

  it("Forget all asks first, and Cancel forgets nothing", async () => {
    await mount();
    await click(button("Forget all…"));
    expect(memoryCalls("agent_memory_forget_all")).toHaveLength(0);
    await click(button("Cancel"));
    expect(memoryCalls("agent_memory_forget_all")).toHaveLength(0);
    expect(button("Forget all…")).toBeTruthy();

    await click(button("Forget all…"));
    await click(button("Forget all", q("[role=group]")!));
    expect(memoryCalls("agent_memory_forget_all")[0]![1]).toEqual({
      scope: "vault",
      projectPath: null,
    });
    expect(container.textContent).toMatch(/Nothing saved yet/);
    expect(button("Forget all…")?.disabled).toBe(true);
  });

  it("Import from Claude Code runs only on click and reports the counts", async () => {
    await mount();
    expect(memoryCalls("agent_memory_import_claude")).toHaveLength(0);
    await click(button("Import"));
    expect(memoryCalls("agent_memory_import_claude")).toHaveLength(1);
    expect(q("[data-agent-memory-import-result]")?.textContent).toBe(
      "Imported 3 files, 1 skipped.",
    );
    // the list is reloaded afterwards
    expect(memoryCalls("agent_memory_list").length).toBeGreaterThanOrEqual(2);

    importReport = { foldersFound: 0, imported: 0, skipped: 0 };
    await click(button("Import"));
    expect(q("[data-agent-memory-import-result]")?.textContent).toMatch(/No Claude Code memory/);
  });

  it("shows a failed command instead of swallowing it", async () => {
    await mount();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:agent|agent_memory_delete") throw new Error("Invalid path: nope");
      if (cmd === "plugin:agent|agent_memory_list") return current;
      return null;
    });
    await click(q("button[aria-label='Delete MEMORY.md']") ?? undefined);
    expect(q("[role=alert]")?.textContent).toMatch(/nope/);
  });
});
