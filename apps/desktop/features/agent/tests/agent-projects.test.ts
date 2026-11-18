// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import {
  addChip,
  checkParent,
  checkProjectName,
  chipFromCandidate,
  folderOfFile,
  chipFromTag,
  normalizeParent,
  projectFolderPath,
} from "@features/agent/web/lib/project-sources";
import { openMakeProjectForFolder } from "@features/agent/web/lib/project-actions";
import { featurePaletteCommands } from "@/lib/features/palette";
import { createFeatureHost } from "@/lib/features/registry";
import agentFeature from "../web/index";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useProjectsStore, watchProjects } from "@features/agent/web/stores/projects-store";
import type { CommandContext } from "@/components/command-palette/commands";

describe("project name and location checks (mirror the Rust rules)", () => {
  it("trims, collapses spaces and replaces illegal characters", () => {
    expect(checkProjectName("  My   Project ")).toEqual({ ok: true, name: "My Project" });
    expect(checkProjectName("a:b*c?")).toEqual({ ok: true, name: "a-b-c-" });
    expect(checkProjectName("end.")).toEqual({ ok: true, name: "end" });
  });
  it("refuses empty names, separators, dot names and control characters", () => {
    for (const bad of ["", "   ", "a/b", "a\\b", ".hidden", "..", "x\ny"]) {
      expect(checkProjectName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("defaults and validates the location", () => {
    expect(normalizeParent("")).toBe("Projects");
    expect(normalizeParent(" /Work/Clients/ ")).toBe("Work/Clients");
    expect(projectFolderPath("", "X")).toBe("Projects/X");
    expect(checkParent("Work")).toBeNull();
    expect(checkParent("../x")).not.toBeNull();
    expect(checkParent(".obsidian/x")).not.toBeNull();
  });
});

describe("source chips", () => {
  it("writes folders with a trailing slash, notes by path and tags with #", () => {
    expect(chipFromCandidate({ kind: "folder", path: "A/B", label: "B", detail: "A" }).raw).toBe(
      "A/B/",
    );
    expect(chipFromCandidate({ kind: "note", path: "A/n.md", label: "n", detail: "A" }).raw).toBe(
      "A/n.md",
    );
    expect(chipFromTag("client")?.raw).toBe("#client");
    expect(chipFromTag("##client")?.raw).toBe("#client");
    expect(chipFromTag("two words")).toBeNull();
    expect(chipFromTag("a,b")).toBeNull();
  });
  it("does not add a chip twice", () => {
    const c = chipFromTag("x")!;
    expect(addChip(addChip([], c), c)).toHaveLength(1);
  });
});

describe("entry points all open the one dialog", () => {
  const host = createFeatureHost({ onError: () => {}, listen: (async () => () => {}) as never });
  beforeEach(() => {
    host.register(agentFeature);
    useWorkspaceStore.setState({ root: "/vault" });
    useAgentStore.setState({ newProjectDialog: { open: false, folder: null } });
  });
  afterEach(async () => {
    for (const id of host.list()) await host.unregister(id);
  });

  it("sidebar: Make project on an absolute folder opens convert mode with the relative path", () => {
    openMakeProjectForFolder("/vault/Research/Topic");
    expect(useAgentStore.getState().newProjectDialog).toEqual({
      open: true,
      folder: "Research/Topic",
    });
  });

  it("sidebar: ignores a path outside the vault", () => {
    openMakeProjectForFolder("/elsewhere/x");
    expect(useAgentStore.getState().newProjectDialog.open).toBe(false);
  });

  it("folderOfFile gives the vault-relative folder, null at the root", () => {
    expect(folderOfFile("/vault/A/B/n.md", "/vault")).toBe("A/B");
    expect(folderOfFile("/vault/n.md", "/vault")).toBeNull();
    expect(folderOfFile(null, "/vault")).toBeNull();
  });

  const ctx = (over: Partial<CommandContext>) =>
    ({
      hasWorkspace: true,
      isCompactFileMode: false,
      activeFilePath: null,
      ...over,
    }) as CommandContext;

  it("palette: New project and Make project from this folder", async () => {
    const create = featurePaletteCommands.get("agent.new-project")!;
    const make = featurePaletteCommands.get("agent.make-project-from-folder")!;
    expect(create.label).toBe("New project");
    expect(create.when!(ctx({}))).toBe(true);
    expect(create.when!(ctx({ hasWorkspace: false }))).toBe(false);
    create.run(ctx({}));
    // The command loads its module on first use (more modules than a tick).
    await vi.waitFor(() =>
      expect(useAgentStore.getState().newProjectDialog).toEqual({ open: true, folder: null }),
    );

    expect(make.label).toBe("Make project from this folder");
    expect(make.when!(ctx({ activeFilePath: "/vault/n.md" }))).toBe(false);
    expect(make.when!(ctx({ activeFilePath: null }))).toBe(false);
    expect(make.when!(ctx({ activeFilePath: "/vault/Docs/n.md" }))).toBe(true);
    make.run(ctx({ activeFilePath: "/vault/Docs/n.md" }));
    await vi.waitFor(() =>
      expect(useAgentStore.getState().newProjectDialog).toEqual({ open: true, folder: "Docs" }),
    );
  });
});

describe("projects store", () => {
  it("keeps absolute folder paths for the sidebar badge and clears on workspace close", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce([{ path: "Projects/A", name: "A" }]);
    useWorkspaceStore.setState({ root: "/vault" });
    await useProjectsStore.getState().refresh();
    expect(useProjectsStore.getState().folderPaths.has("/vault/Projects/A")).toBe(true);
    expect(useProjectsStore.getState().folderPaths.has("/vault/Projects")).toBe(false);
    useProjectsStore.getState().clear();
    expect(useProjectsStore.getState().folderPaths.size).toBe(0);
  });

  it("watchProjects loads on a workspace switch, clears on close and stops when disposed", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    useWorkspaceStore.setState({ root: null });
    useProjectsStore.getState().clear();
    vi.mocked(invoke).mockClear();
    const stop = watchProjects();
    expect(invoke).not.toHaveBeenCalled(); // no workspace yet, nothing to ask
    vi.mocked(invoke).mockResolvedValueOnce([{ path: "Projects/B", name: "B" }]);
    useWorkspaceStore.setState({ root: "/vault2" });
    await vi.waitFor(() =>
      expect(useProjectsStore.getState().folderPaths.has("/vault2/Projects/B")).toBe(true),
    );
    useWorkspaceStore.setState({ root: null });
    expect(useProjectsStore.getState().folderPaths.size).toBe(0);
    stop();
    vi.mocked(invoke).mockClear();
    useWorkspaceStore.setState({ root: "/vault3" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
