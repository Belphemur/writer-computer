import { describe, expect, it, vi } from "vite-plus/test";
// The agent feature contributes its palette commands when the built-in features load.
import "../src/lib/features/builtin";
import { featurePaletteSources } from "../src/lib/features/palette";
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
    const list = resolveCommands(ctx());
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
      "open-log-folder",
      "copy-recent-errors",
      "open-settings",
      "note-set-display-title",
      // contributed by the agent feature (`features/agent`); development builds only for the demo
      "agent.toggle-pane",
      "agent.new-chat",
      "agent.history",
      "agent.use-demo-backend",
      "agent.new-project",
    ]);
  });

  it("offers Clear display title only for a note that has a title override", async () => {
    const editorApi = await import("../src/hooks/editor-api");
    const spy = vi.spyOn(editorApi, "getOpenFile");
    spy.mockReturnValue({ title: "" } as never);
    expect(ids(resolveCommands(ctx()))).not.toContain("note-clear-display-title");
    spy.mockReturnValue({ title: "Pretty" } as never);
    expect(ids(resolveCommands(ctx()))).toContain("note-clear-display-title");
    expect(ids(resolveCommands(ctx({ activeFilePath: "/ws/pic.png" })))).not.toContain(
      "note-set-display-title",
    );
    spy.mockRestore();
  });

  it("limits a standalone compact window", () => {
    const list = resolveCommands(
      ctx({ hasWorkspace: false, isCompactFileMode: true, hasActiveTab: true }),
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
    expect(ids(resolveCommands(ctx()))).not.toContain("reopen-closed-tab");
    const c = ctx({ hasClosedTabs: true });
    const cmd = resolveCommands(c).find((x) => x.id === "reopen-closed-tab")!;
    expect(cmd.label).toBe("Reopen Closed Tab");
    cmd.run();
    expect(c.reopenClosedTab).toHaveBeenCalledTimes(1);
    expect(
      ids(resolveCommands(ctx({ hasClosedTabs: true, isCompactFileMode: true }))),
    ).not.toContain("reopen-closed-tab");
  });

  it("offers Pin Tab or Unpin Tab for the active tab, never on the new-tab page or in compact mode", () => {
    const pin = ctx({ activeTabPin: "unpinned" });
    expect(ids(resolveCommands(pin))).toContain("pin-tab");
    expect(ids(resolveCommands(pin))).not.toContain("unpin-tab");
    resolveCommands(pin)
      .find((x) => x.id === "pin-tab")!
      .run();
    expect(pin.pinActiveTab).toHaveBeenCalledTimes(1);

    const unpin = ctx({ activeTabPin: "pinned" });
    expect(ids(resolveCommands(unpin))).toContain("unpin-tab");
    expect(ids(resolveCommands(unpin))).not.toContain("pin-tab");
    resolveCommands(unpin)
      .find((x) => x.id === "unpin-tab")!
      .run();
    expect(unpin.unpinActiveTab).toHaveBeenCalledTimes(1);

    const none = ids(resolveCommands(ctx({ activeTabPin: null })));
    expect(none).not.toContain("pin-tab");
    expect(none).not.toContain("unpin-tab");
    expect(ids(resolveCommands(ctx({ isCompactFileMode: true })))).not.toContain("pin-tab");
  });

  it("offers Close All Tabs only while an unpinned tab remains", () => {
    expect(ids(resolveCommands(ctx({ unpinnedTabCount: 0 })))).not.toContain("close-all");
    expect(ids(resolveCommands(ctx({ unpinnedTabCount: 1 })))).toContain("close-all");
  });

  it("offers the log commands in every window and runs them", () => {
    const c = ctx({ hasWorkspace: false, isCompactFileMode: true });
    const list = resolveCommands(c);
    list.find((x) => x.id === "open-log-folder")!.run();
    list.find((x) => x.id === "copy-recent-errors")!.run();
    expect(c.openLogFolder).toHaveBeenCalledTimes(1);
    expect(c.copyRecentErrors).toHaveBeenCalledTimes(1);
  });

  it("closes the palette after a command unless the command owns closing", () => {
    const c = ctx();
    const list = resolveCommands(c);
    list.find((x) => x.id === "toggle-theme")!.run();
    expect(c.toggleTheme).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalledTimes(1);
    list.find((x) => x.id === "new-file")!.run();
    expect(c.openCreateFile).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalledTimes(1);
  });
});

describe("palette command sources", () => {
  const source = (id: string, label: string, run = () => {}) =>
    featurePaletteSources.add(`t.${id}`, {
      owner: "t",
      id: `t.${id}`,
      list: () => [{ id, label, description: "Source command", run }],
    });

  it("lists a source's commands after the built-ins", () => {
    const off = source("p:go", "Plug: Go");
    try {
      const list = resolveCommands(ctx());
      expect(list[list.length - 1]).toMatchObject({ id: "p:go", label: "Plug: Go" });
    } finally {
      off();
    }
  });

  it("a source cannot shadow a built-in id", () => {
    const off = source("zoom-in", "Evil zoom");
    try {
      const list = resolveCommands(ctx());
      expect(list.filter((c) => c.id === "zoom-in")).toHaveLength(1);
      expect(list.find((c) => c.id === "zoom-in")!.label).toBe("Zoom In");
    } finally {
      off();
    }
  });

  it("closes the palette after a source command runs", () => {
    const run = vi.fn();
    const off = source("p:go", "Go", run);
    try {
      const c = ctx();
      resolveCommands(c)
        .find((x) => x.id === "p:go")!
        .run();
      expect(run).toHaveBeenCalled();
      expect(c.close).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});
