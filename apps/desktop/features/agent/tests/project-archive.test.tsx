// @vitest-environment jsdom
// Archived projects on the web side (spec 4.6, ADR "archive agent projects by moving their
// folder"): one filter (`splitProjects`) feeds the switcher, the tree badge and the Archived
// section; Archive and Unarchive call the one command and refresh the projects store.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invokeMock = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => []),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
const opened = vi.hoisted(() => [] as string[]);
const navigated = vi.hoisted(() => [] as string[]);
vi.mock("@/hooks/editor-api", () => ({
  openFileInNewTab: vi.fn((p: string) => void opened.push(p)),
  navigateToFile: vi.fn((p: string) => void navigated.push(p)),
}));

import { ProjectHome } from "@features/agent/web/components/project-home";
import { ProjectSwitcher } from "@features/agent/web/components/project-switcher";
import { isArchivedProject, splitProjects } from "@features/agent/web/lib/project-archive";
import type { ProjectClient, ProjectDetail } from "@features/agent/web/lib/project-client";
import { openArchivedProjects, openArchiveProject } from "@features/agent/web/lib/project-actions";
import { useProjectBadge } from "@features/agent/web/project-badge";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
import { usePaneStore } from "@features/agent/web/stores/pane-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { DirEntry } from "@/types/fs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: ProjectDetail = {
  path: "Projects/Acme",
  id: "p1",
  name: "Acme",
  description: "",
  createdAt: 1,
  lastUsedAt: 1,
  archivedAt: null,
  inclusions: [],
  exclusions: [],
  hasAgentsMd: true,
  hasClaudeMd: false,
  unsupported: [],
  webUrls: [],
  youtubeUrls: [],
  agentMode: null,
  icon: null,
  color: null,
  warnings: [],
};
const active = base;
const archived: ProjectDetail = {
  ...base,
  path: "Archive/Projects/Old",
  id: "p2",
  name: "Old",
  archivedAt: 5,
};

function client(over: Partial<ProjectClient> = {}): ProjectClient {
  return {
    list: vi.fn(async () => []),
    read: vi.fn(async () => active),
    manifest: vi.fn(async () => ({
      manifest: {
        entries: [],
        more: 0,
        exclusions: [],
        unsupported: [],
        webUrls: [],
        youtubeUrls: [],
      },
      text: "",
    })),
    archive: vi.fn(async () => archived),
    ...over,
  } as unknown as ProjectClient;
}

/** What the backend returns for `agent_list_projects` with archived included. */
function backendHas(...projects: ProjectDetail[]) {
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "plugin:agent|agent_list_projects" ? projects : [],
  );
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  invokeMock.mockReset();
  backendHas(active, archived);
  opened.length = 0;
  navigated.length = 0;
  useWorkspaceStore.setState({ root: "/vault" });
  useProjectsStore.getState().clear();
  useProjectsStore.setState({ archiveRequested: false, archivedExpanded: false });
  usePaneStore.setState({ open: false });
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    view: "project",
    currentProjectPath: null,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(text))!;

describe("the one archived rule", () => {
  it("splits by archivedAt and treats a missing value as active", () => {
    expect(isArchivedProject(archived)).toBe(true);
    expect(isArchivedProject(active)).toBe(false);
    expect(isArchivedProject({ archivedAt: undefined } as never)).toBe(false);
    const { active: a, archived: z } = splitProjects([active, archived]);
    expect(a).toEqual([active]);
    expect(z).toEqual([archived]);
  });

  it("the store keeps archived projects out of `projects` and the badge map", async () => {
    await useProjectsStore.getState().refresh();
    const s = useProjectsStore.getState();
    expect(s.projects.map((p) => p.path)).toEqual(["Projects/Acme"]);
    expect(s.archived.map((p) => p.path)).toEqual(["Archive/Projects/Old"]);
    expect([...s.folderPaths.keys()]).toEqual(["/vault/Projects/Acme"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:agent|agent_list_projects", {
      includeArchived: true,
    });
  });

  it("the switcher offers active projects only", async () => {
    await useProjectsStore.getState().refresh();
    await act(async () => root.render(<ProjectSwitcher projectPath={null} />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!.click(),
    );
    const options = [...container.querySelectorAll("[role=option]")].map((o) => o.textContent);
    expect(options.some((t) => t?.includes("Acme"))).toBe(true);
    expect(options.some((t) => t?.includes("Old"))).toBe(false);
  });

  it("the tree badge marks active project folders and not archived ones", async () => {
    await useProjectsStore.getState().refresh();
    const entry = (path: string) => ({ name: "x", path, is_dir: true }) as DirEntry;
    function Probe({ path }: { path: string }) {
      const badge = useProjectBadge(entry(path));
      return <span data-badge={badge ? "yes" : "no"} />;
    }
    const badge = async (path: string) => {
      await act(async () => root.render(<Probe path={path} />));
      return container.querySelector("[data-badge]")!.getAttribute("data-badge");
    };
    expect(await badge("/vault/Projects/Acme")).toBe("yes");
    expect(await badge("/vault/Archive/Projects/Old")).toBe("no");
  });
});

describe("Archived section", () => {
  async function renderBrowser(c = client()) {
    await useProjectsStore.getState().refresh();
    await act(async () => root.render(<ProjectHome projectPath={null} client={c} />));
    return c;
  }

  it("is collapsed, then lists archived projects with Unarchive", async () => {
    await renderBrowser();
    expect(container.textContent).toContain("Archived (1)");
    expect(container.textContent).not.toContain("Old");
    await act(async () => button("Archived").click());
    expect(container.textContent).toContain("Old");
    expect(container.textContent).toContain("Archive/Projects/Old");
    expect(container.textContent).not.toContain("Acme");
  });

  it("a row opens the project note like a link (Cmd+click in a new tab)", async () => {
    useProjectsStore.setState({ archivedExpanded: true });
    await renderBrowser();
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Archive/Projects/Old"),
    )!;
    await act(async () => row.click());
    expect(navigated).toEqual(["/vault/Archive/Projects/Old/project.md"]);
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true, ctrlKey: true }));
    });
    expect(opened).toEqual(["/vault/Archive/Projects/Old/project.md"]);
  });

  it("Unarchive calls the command with archived=false and refreshes the store", async () => {
    useProjectsStore.setState({ archivedExpanded: true });
    const c = await renderBrowser();
    backendHas(active, { ...archived, path: "Projects/Old", archivedAt: null });
    invokeMock.mockClear();
    await act(async () => button("Unarchive").click());
    expect(c.archive).toHaveBeenCalledWith("Archive/Projects/Old", false);
    expect(invokeMock).toHaveBeenCalledWith("plugin:agent|agent_list_projects", {
      includeArchived: true,
    });
    expect(useProjectsStore.getState().archived).toEqual([]);
    expect(useProjectsStore.getState().projects.map((p) => p.path)).toEqual([
      "Projects/Acme",
      "Projects/Old",
    ]);
  });

  it("shows the backend's refusal and keeps the row", async () => {
    useProjectsStore.setState({ archivedExpanded: true });
    const c = client({
      archive: vi.fn(async () => {
        throw new Error("1 chat of this project is busy: stop or finish it first");
      }),
    });
    await renderBrowser(c);
    await act(async () => button("Unarchive").click());
    expect(container.querySelector("[role=alert]")!.textContent).toContain("busy");
    expect(container.textContent).toContain("Old");
  });

  it("is hidden with nothing archived, unless expanded by the palette", async () => {
    backendHas(active);
    await renderBrowser();
    expect(container.textContent).not.toContain("Archived");
    act(() => useProjectsStore.getState().setArchivedExpanded(true));
    expect(container.textContent).toContain("No archived projects.");
  });
});

describe("Archive from the project home", () => {
  it("says where the folder goes, archives, refreshes and leaves the project", async () => {
    const c = client();
    useAgentStore.setState({ currentProjectPath: "Projects/Acme" });
    await act(async () => root.render(<ProjectHome projectPath="Projects/Acme" client={c} />));
    await act(async () => {});
    await act(async () => button("Archive project").click());
    expect(container.textContent).toContain("Moves the folder to Archive/Projects");
    invokeMock.mockClear();
    await act(async () => button("Archive").click());
    expect(c.archive).toHaveBeenCalledWith("Projects/Acme", true);
    expect(invokeMock).toHaveBeenCalledWith("plugin:agent|agent_list_projects", {
      includeArchived: true,
    });
    expect(useAgentStore.getState().currentProjectPath).toBeNull();
    expect(useAgentStore.getState().view).toBe("chat");
  });

  it("shows a refusal (a busy chat) and keeps the project", async () => {
    const c = client({
      archive: vi.fn(async () => {
        throw new Error("1 chat of this project is busy: stop or finish it first");
      }),
    });
    useAgentStore.setState({ currentProjectPath: "Projects/Acme" });
    await act(async () => root.render(<ProjectHome projectPath="Projects/Acme" client={c} />));
    await act(async () => {});
    await act(async () => button("Archive project").click());
    await act(async () => button("Archive").click());
    expect(container.querySelector("[role=alert], p")!.textContent).toBeTruthy();
    expect(container.textContent).toContain("busy");
    expect(useAgentStore.getState().currentProjectPath).toBe("Projects/Acme");
  });
});

describe("palette commands", () => {
  it("Archive project opens the pane on the project home with the confirm step", async () => {
    useAgentStore.setState({ currentProjectPath: "Projects/Acme" });
    openArchiveProject();
    expect(usePaneStore.getState().open).toBe(true);
    expect(useAgentStore.getState().view).toBe("project");
    await act(async () =>
      root.render(<ProjectHome projectPath="Projects/Acme" client={client()} />),
    );
    await act(async () => {});
    expect(container.textContent).toContain("Moves the folder to");
    expect(useProjectsStore.getState().archiveRequested).toBe(false);
  });

  it("Unarchive project... opens the browser with the Archived section expanded", () => {
    openArchivedProjects();
    expect(usePaneStore.getState().open).toBe(true);
    expect(useAgentStore.getState().view).toBe("project");
    expect(useProjectsStore.getState().archivedExpanded).toBe(true);
  });
});
