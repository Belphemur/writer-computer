import { describe, expect, it, vi } from "vite-plus/test";
import { CommandRegistry } from "../src/lib/obsidian-host/api/core";
import {
  BUILTIN_COMMANDS,
  resolveCommands,
  type CommandContext,
} from "../src/components/command-palette/commands";

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  const fn = () => vi.fn();
  return {
    hasWorkspace: true,
    isCompactFileMode: false,
    activeFilePath: "/ws/a.md",
    hasActiveTab: true,
    tabCount: 2,
    hasPluginLeaves: false,
    close: fn(),
    toggleSidebar: fn(),
    openCreateFile: fn(),
    openSearchNotes: fn(),
    openFileInCompactWindow: fn(),
    closeActiveTab: fn(),
    closeAllTabs: fn(),
    openWorkspace: vi.fn(async () => {}),
    closeWorkspace: fn(),
    toggleTheme: fn(),
    zoomIn: fn(),
    zoomOut: fn(),
    resetZoom: fn(),
    openSettings: fn(),
    togglePluginPane: fn(),
    openPluginBrowser: fn(),
    ...over,
  };
}

const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe("palette built-in commands", () => {
  it("has unique ids", () => {
    expect(new Set(BUILTIN_COMMANDS.map((c) => c.id)).size).toBe(BUILTIN_COMMANDS.length);
  });

  it("offers the workspace commands in a workspace window", () => {
    const list = resolveCommands(ctx(), []);
    expect(ids(list)).toEqual([
      "toggle-sidebar",
      "new-file",
      "search-notes",
      "open-in-compact-window",
      "close-tab",
      "close-all",
      "open-workspace",
      "close-workspace",
      "toggle-theme",
      "zoom-in",
      "zoom-out",
      "zoom-reset",
      "browse-community-plugins",
      "open-settings",
    ]);
  });

  it("limits a standalone compact window", () => {
    const list = resolveCommands(
      ctx({ hasWorkspace: false, isCompactFileMode: true, hasActiveTab: true }),
      [],
    );
    expect(ids(list)).toEqual([
      "new-file",
      "open-workspace",
      "toggle-theme",
      "zoom-in",
      "zoom-out",
      "zoom-reset",
    ]);
  });

  it("shows the plugin pane toggle only when a plugin opened a leaf", () => {
    expect(ids(resolveCommands(ctx({ hasPluginLeaves: true }), []))).toContain(
      "toggle-plugin-pane",
    );
    expect(ids(resolveCommands(ctx(), []))).not.toContain("toggle-plugin-pane");
  });

  it("offers Browse community plugins only in a workspace window and opens the marketplace", () => {
    const c = ctx();
    const list = resolveCommands(c, []);
    const cmd = list.find((x) => x.id === "browse-community-plugins")!;
    expect(cmd.label).toBe("Browse community plugins");
    cmd.run();
    expect(c.openPluginBrowser).toHaveBeenCalledTimes(1);
    expect(c.close).toHaveBeenCalledTimes(1);
    for (const over of [{ hasWorkspace: false }, { isCompactFileMode: true }]) {
      expect(ids(resolveCommands(ctx(over), []))).not.toContain("browse-community-plugins");
    }
  });

  it("closes the palette after a command unless the command owns closing", () => {
    const c = ctx();
    const list = resolveCommands(c, []);
    list.find((x) => x.id === "toggle-theme")!.run();
    expect(c.toggleTheme).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalledTimes(1);
    list.find((x) => x.id === "new-file")!.run();
    expect(c.openCreateFile).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalledTimes(1);
  });
});

describe("palette plugin commands", () => {
  function registry() {
    const reg = new CommandRegistry();
    let editor: { editor: unknown; view: unknown } | null = null;
    reg.setEditorProvider(() => editor);
    return { reg, setEditor: (e: typeof editor) => void (editor = e) };
  }

  it("merges plugin commands after the built-ins, with plugin-prefixed names", () => {
    const { reg } = registry();
    reg.addForPlugin("p", "Plug", { id: "go", name: "Go", callback: () => {} });
    const list = resolveCommands(ctx(), reg.list());
    const last = list[list.length - 1];
    expect(last).toMatchObject({ id: "p:go", label: "Plug: Go" });
  });

  it("respects checkCallback and editor requirements", () => {
    const { reg, setEditor } = registry();
    let allowed = false;
    reg.addForPlugin("p", "Plug", { id: "check", name: "Check", checkCallback: () => allowed });
    reg.addForPlugin("p", "Plug", { id: "ed", name: "Ed", editorCallback: () => {} });
    reg.addForPlugin("p", "Plug", {
      id: "edcheck",
      name: "EdCheck",
      editorCheckCallback: (checking) => (checking ? true : undefined),
    });
    const pluginIds = () =>
      ids(resolveCommands(ctx(), reg.list())).filter((i) => i.startsWith("p:"));
    expect(pluginIds()).toEqual([]);
    allowed = true;
    expect(pluginIds()).toEqual(["p:check"]);
    setEditor({ editor: {}, view: {} });
    expect(pluginIds()).toEqual(["p:check", "p:ed", "p:edcheck"]);
  });

  it("a plugin cannot shadow a built-in id", () => {
    const { reg } = registry();
    reg.add("zoom-in", {
      id: "zoom-in",
      name: "Evil zoom",
      hotkeys: [],
      owner: "p",
      isAvailable: () => true,
      run: () => {},
    });
    const list = resolveCommands(ctx(), reg.list());
    expect(list.filter((c) => c.id === "zoom-in")).toHaveLength(1);
    expect(list.find((c) => c.id === "zoom-in")!.label).toBe("Zoom In");
  });

  it("closes the palette first, then runs the command on the next tick", () => {
    vi.useFakeTimers();
    try {
      const { reg } = registry();
      const cb = vi.fn();
      reg.addForPlugin("p", "Plug", { id: "go", name: "Go", callback: cb });
      const c = ctx();
      resolveCommands(c, reg.list())
        .find((x) => x.id === "p:go")!
        .run();
      expect(c.close).toHaveBeenCalled();
      expect(cb).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
