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
    unpinnedTabCount: 2,
    activeTabPin: "unpinned",
    hasClosedTabs: false,
    hasPluginLeaves: false,
    close: fn(),
    toggleSidebar: fn(),
    openCreateFile: fn(),
    openSearchNotes: fn(),
    openFileInCompactWindow: fn(),
    pinActiveTab: fn(),
    unpinActiveTab: fn(),
    closeActiveTab: fn(),
    closeAllTabs: fn(),
    reopenClosedTab: fn(),
    openWorkspace: vi.fn(async () => {}),
    closeWorkspace: fn(),
    toggleTheme: fn(),
    zoomIn: fn(),
    zoomOut: fn(),
    resetZoom: fn(),
    openSettings: fn(),
    togglePluginPane: fn(),
    openPluginBrowser: fn(),
    openLogFolder: fn(),
    copyRecentErrors: fn(),
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
      "pin-tab",
      "close-tab",
      "close-all",
      "open-workspace",
      "close-workspace",
      "toggle-theme",
      "zoom-in",
      "zoom-out",
      "zoom-reset",
      "browse-community-plugins",
      "open-log-folder",
      "copy-recent-errors",
      "open-settings",
      "agent-toggle-pane",
      "agent-new-chat",
      "agent-history",
      // development builds only (`import.meta.env.DEV`, true under vitest)
      "agent-use-demo-backend",
      "agent-new-project",
      "note-set-display-title",
    ]);
  });

  it("offers Clear display title only for a note that has a title override", async () => {
    const editorApi = await import("../src/hooks/editor-api");
    const spy = vi.spyOn(editorApi, "getOpenFile");
    spy.mockReturnValue({ title: "" } as never);
    expect(ids(resolveCommands(ctx(), []))).not.toContain("note-clear-display-title");
    spy.mockReturnValue({ title: "Pretty" } as never);
    expect(ids(resolveCommands(ctx(), []))).toContain("note-clear-display-title");
    expect(ids(resolveCommands(ctx({ activeFilePath: "/ws/pic.png" }), []))).not.toContain(
      "note-set-display-title",
    );
    spy.mockRestore();
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
      "open-log-folder",
      "copy-recent-errors",
    ]);
  });

  it("offers Reopen Closed Tab only when a tab was closed and not in a compact window", () => {
    expect(ids(resolveCommands(ctx(), []))).not.toContain("reopen-closed-tab");
    const c = ctx({ hasClosedTabs: true });
    const cmd = resolveCommands(c, []).find((x) => x.id === "reopen-closed-tab")!;
    expect(cmd.label).toBe("Reopen Closed Tab");
    cmd.run();
    expect(c.reopenClosedTab).toHaveBeenCalledTimes(1);
    expect(
      ids(resolveCommands(ctx({ hasClosedTabs: true, isCompactFileMode: true }), [])),
    ).not.toContain("reopen-closed-tab");
  });

  it("offers Pin Tab or Unpin Tab for the active tab, never on the new-tab page or in compact mode", () => {
    const pin = ctx({ activeTabPin: "unpinned" });
    expect(ids(resolveCommands(pin, []))).toContain("pin-tab");
    expect(ids(resolveCommands(pin, []))).not.toContain("unpin-tab");
    resolveCommands(pin, [])
      .find((x) => x.id === "pin-tab")!
      .run();
    expect(pin.pinActiveTab).toHaveBeenCalledTimes(1);

    const unpin = ctx({ activeTabPin: "pinned" });
    expect(ids(resolveCommands(unpin, []))).toContain("unpin-tab");
    expect(ids(resolveCommands(unpin, []))).not.toContain("pin-tab");
    resolveCommands(unpin, [])
      .find((x) => x.id === "unpin-tab")!
      .run();
    expect(unpin.unpinActiveTab).toHaveBeenCalledTimes(1);

    const none = ids(resolveCommands(ctx({ activeTabPin: null }), []));
    expect(none).not.toContain("pin-tab");
    expect(none).not.toContain("unpin-tab");
    expect(ids(resolveCommands(ctx({ isCompactFileMode: true }), []))).not.toContain("pin-tab");
  });

  it("offers Close All Tabs only while an unpinned tab remains", () => {
    expect(ids(resolveCommands(ctx({ unpinnedTabCount: 0 }), []))).not.toContain("close-all");
    expect(ids(resolveCommands(ctx({ unpinnedTabCount: 1 }), []))).toContain("close-all");
  });

  it("offers the log commands in every window and runs them", () => {
    const c = ctx({ hasWorkspace: false, isCompactFileMode: true });
    const list = resolveCommands(c, []);
    list.find((x) => x.id === "open-log-folder")!.run();
    list.find((x) => x.id === "copy-recent-errors")!.run();
    expect(c.openLogFolder).toHaveBeenCalledTimes(1);
    expect(c.copyRecentErrors).toHaveBeenCalledTimes(1);
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
