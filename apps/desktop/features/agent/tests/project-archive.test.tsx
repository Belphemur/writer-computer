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
import { ArchiveProjectDialog } from "@features/agent/web/components/archive-project-dialog";
import { ProjectSwitcher } from "@features/agent/web/components/project-switcher";
import { isArchivedProject, splitProjects } from "@features/agent/web/lib/project-archive";
import type { ProjectClient, ProjectDetail } from "@features/agent/web/lib/project-client";
import {
  openArchivedProjects,
  openArchiveProject,
  openProjectsList,
} from "@features/agent/web/lib/project-actions";
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
  useProjectsStore.setState({ archiveTarget: null, archivedExpanded: false, detailPath: null });
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

const button = (text: string, label?: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    label ? b.getAttribute("aria-label") === label : b.textContent?.trim().includes(text),
  )!;

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
    (b) => b.textContent === label,
  )!;
const menuLabels = () =>
  [...document.querySelectorAll("[role=menuitem]")].map((b) => b.textContent);

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
    // Acme is in the active list above, not in the Archived group.
    expect(container.querySelector("[data-agent-archived-projects]")!.textContent).not.toContain(
      "Acme",
    );
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
    await act(async () => button("", "Actions for Old").click());
    await act(async () => menuItem("Unarchive").click());
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
    await act(async () => button("", "Actions for Old").click());
    await act(async () => menuItem("Unarchive").click());
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

const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]");
const dialogButton = (text: string) =>
  [...dialog()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const key = (target: Element | Document, k: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
const BUSY = "1 chat of this project is busy: stop or finish it first";

describe("Archive confirmation modal", () => {
  async function renderDialog(c = client()) {
    await useProjectsStore.getState().refresh();
    useAgentStore.setState({ currentProjectPath: "Projects/Acme" });
    await act(async () => root.render(<ArchiveProjectDialog client={c} />));
    return c;
  }
  const ask = (path = "Projects/Acme") => act(async () => openArchiveProject(path));

  it("is closed until asked, then names the project and the archive folder", async () => {
    await renderDialog();
    expect(dialog()).toBeNull();
    await ask();
    expect(dialog()!.textContent).toContain("Archive project?");
    expect(dialog()!.textContent).toContain("Acme");
    expect(dialog()!.textContent).toContain("Archive/Projects");
    expect(dialog()!.querySelector("button[aria-busy]")).toBe(document.activeElement);
  });

  it("Cancel and Escape close it and do nothing", async () => {
    const c = await renderDialog();
    await ask();
    await act(async () => dialogButton("Cancel").click());
    expect(dialog()).toBeNull();
    await ask();
    await key(document, "Escape");
    expect(dialog()).toBeNull();
    expect(c.archive).not.toHaveBeenCalled();
  });

  it("Archive archives once, refreshes, closes and leaves the pane where it was", async () => {
    const c = await renderDialog();
    useAgentStore.setState({ view: "chat" });
    await ask("Projects/Other");
    invokeMock.mockClear();
    await act(async () => dialogButton("Archive").click());
    expect(c.archive).toHaveBeenCalledTimes(1);
    expect(c.archive).toHaveBeenCalledWith("Projects/Other", true);
    expect(invokeMock).toHaveBeenCalledWith("plugin:agent|agent_list_projects", {
      includeArchived: true,
    });
    expect(dialog()).toBeNull();
    const a = useAgentStore.getState();
    expect(a.view).toBe("chat");
    expect(a.currentProjectPath).toBe("Projects/Acme");
    expect(a.order).toEqual([]);
  });

  it("Enter confirms", async () => {
    const c = await renderDialog();
    await ask();
    await key(dialog()!, "Enter");
    expect(c.archive).toHaveBeenCalledTimes(1);
  });

  it("shows the busy refusal inside the dialog and stays open", async () => {
    const c = await renderDialog(
      client({
        archive: vi.fn(async () => {
          throw new Error(BUSY);
        }),
      }),
    );
    await ask();
    await act(async () => dialogButton("Archive").click());
    expect(dialog()!.querySelector("[role=alert]")!.textContent).toContain("busy");
    expect(c.archive).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().currentProjectPath).toBe("Projects/Acme");
  });

  it("archiving the current project falls back to no project; its detail returns to the list", async () => {
    await renderDialog();
    useProjectsStore.setState({ detailPath: "Projects/Acme" });
    useAgentStore.setState({ view: "project" });
    await ask();
    await act(async () => dialogButton("Archive").click());
    expect(useAgentStore.getState().currentProjectPath).toBeNull();
    expect(useAgentStore.getState().view).toBe("projects");
    expect(useProjectsStore.getState().detailPath).toBeNull();
  });
});

describe("palette commands", () => {
  it("Archive project opens the modal for the current project and navigates nowhere", () => {
    useAgentStore.setState({ currentProjectPath: "Projects/Acme", view: "chat" });
    openArchiveProject();
    expect(useProjectsStore.getState().archiveTarget).toBe("Projects/Acme");
    expect(useAgentStore.getState().view).toBe("chat");
    expect(usePaneStore.getState().open).toBe(false);
  });

  it("Archive project without a project does nothing", () => {
    openArchiveProject();
    expect(useProjectsStore.getState().archiveTarget).toBeNull();
  });

  it("Projects opens the pane on the Projects list", () => {
    openProjectsList();
    expect(usePaneStore.getState().open).toBe(true);
    expect(useAgentStore.getState().view).toBe("projects");
  });

  it("Unarchive project... opens the list with the Archived group expanded", () => {
    openArchivedProjects();
    expect(usePaneStore.getState().open).toBe(true);
    expect(useAgentStore.getState().view).toBe("projects");
    expect(useProjectsStore.getState().archivedExpanded).toBe(true);
  });
});

describe("Project menus (switcher rows and Projects list rows)", () => {
  const pickerOpen = () => document.querySelector("input[aria-label='Search icons']") !== null;

  async function openSwitcherMenu(viaRightClick = false) {
    await useProjectsStore.getState().refresh();
    await act(async () => root.render(<ProjectSwitcher projectPath={null} />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!.click(),
    );
    if (viaRightClick) {
      const row = [...container.querySelectorAll("[role=option]")].find((o) =>
        o.textContent?.includes("Acme"),
      )!;
      await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
    } else {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>("button[aria-label='Actions for Acme']")!
          .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })),
      );
    }
  }

  it("a switcher row's … offers Change icon… and a danger Archive project…", async () => {
    await openSwitcherMenu();
    expect(menuLabels()).toEqual(["Change icon…", "Archive project…"]);
    expect(menuItem("Archive project…").className).toContain("--danger");
    expect(menuItem("Change icon…").className).not.toContain("--danger");
  });

  it("keyboard: the first item has focus, arrows wrap, Esc closes", async () => {
    await openSwitcherMenu();
    expect(document.activeElement).toBe(menuItem("Change icon…"));
    const menu = document.querySelector("[role=menu]")!;
    await key(menu, "ArrowDown");
    expect(document.activeElement).toBe(menuItem("Archive project…"));
    await key(menu, "ArrowDown");
    expect(document.activeElement).toBe(menuItem("Change icon…"));
    await key(menu, "ArrowUp");
    expect(document.activeElement).toBe(menuItem("Archive project…"));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector("[role=menu]")).toBeNull();
  });

  it("Change icon… from a switcher row opens the picker", async () => {
    await openSwitcherMenu();
    await act(async () => menuItem("Change icon…").click());
    await act(async () => {});
    expect(pickerOpen()).toBe(true);
  });

  it("a right click on a switcher row opens the same menu", async () => {
    await openSwitcherMenu(true);
    expect(menuLabels()).toEqual(["Change icon…", "Archive project…"]);
  });

  it("Archive project… from the switcher opens the modal in place: no switch, no chat", async () => {
    useAgentStore.setState({ view: "chat", currentProjectPath: null });
    await openSwitcherMenu();
    await act(async () => menuItem("Archive project…").click());
    expect(useProjectsStore.getState().archiveTarget).toBe("Projects/Acme");
    const a = useAgentStore.getState();
    expect(a.view).toBe("chat");
    expect(a.currentProjectPath).toBeNull();
    expect(a.order).toEqual([]);
    expect(usePaneStore.getState().open).toBe(false);
  });

  it("the switcher's Show all projects opens the list", async () => {
    await useProjectsStore.getState().refresh();
    await act(async () => root.render(<ProjectSwitcher projectPath={null} />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!.click(),
    );
    await act(async () => button("Show all projects").click());
    expect(useAgentStore.getState().view).toBe("projects");
  });

  async function renderList(c = client()) {
    await useProjectsStore.getState().refresh();
    await act(async () => root.render(<ProjectHome projectPath={null} client={c} />));
  }

  it("a Projects list row opens that project; its … has Open details, Change icon… and Archive", async () => {
    await renderList();
    expect(container.querySelector("[data-agent-slot=projects-list]")).not.toBeNull();
    await act(async () => button("", "Actions for Acme").click());
    expect(menuLabels()).toEqual(["Open details", "Change icon…", "Archive project…"]);
    await act(async () => menuItem("Archive project…").click());
    expect(useProjectsStore.getState().archiveTarget).toBe("Projects/Acme");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => button("", "Actions for Acme").click());
    await act(async () => menuItem("Open details").click());
    expect(useAgentStore.getState().view).toBe("project");
    expect(useProjectsStore.getState().detailPath).toBe("Projects/Acme");
    expect(useAgentStore.getState().currentProjectPath).toBeNull();
  });

  it("clicking a list row picks the project and starts a chat in it", async () => {
    await renderList();
    const row = [...container.querySelectorAll("li button")].find((b) =>
      b.textContent?.includes("Projects/Acme"),
    ) as HTMLButtonElement;
    await act(async () => row.click());
    const s = useAgentStore.getState();
    expect(s.view).toBe("chat");
    expect(s.currentProjectPath).toBe("Projects/Acme");
    expect(s.chats[s.activeChatId!]!.projectPath).toBe("Projects/Acme");
  });

  it("the filter narrows the list", async () => {
    await renderList();
    const input = container.querySelector<HTMLInputElement>("input[aria-label='Filter projects']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No matching project");
  });
});
