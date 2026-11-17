// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("@/lib/tauri", () => ({
  fuzzySearch: vi.fn(async (q: string) =>
    q.startsWith("cli")
      ? [{ relative_path: "Clients/Acme/brief.md" }, { relative_path: "Clients/Acme/notes.md" }]
      : [],
  ),
}));

import { NewProjectDialog } from "@features/agent/web/components/new-project-dialog";
import type { ProjectClient, ProjectDetail } from "@features/agent/web/lib/project-client";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function detail(path: string, over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    path,
    id: "id-1",
    name: path.split("/").pop()!,
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
    ...over,
  };
}

function fakeClient(over: Partial<ProjectClient> = {}) {
  const client = {
    list: vi.fn(async () => []),
    read: vi.fn(async (p: string) => detail(p)),
    create: vi.fn(async (r) => detail(`${r.parent}/${r.name}`)),
    make: vi.fn(async (a) => detail(a.path)),
    update: vi.fn(async (p: string) => detail(p)),
    archive: vi.fn(async (p: string) => detail(p)),
    inspectFolder: vi.fn(async (p: string) => ({
      path: p,
      name: p.split("/").pop()!,
      isProject: false,
      hasProjectMd: false,
      hasAgentsMd: false,
      hasClaudeMd: false,
    })),
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
    ...over,
  } satisfies ProjectClient;
  return client;
}

let container: HTMLElement;
let root: Root;

async function mount(client: ProjectClient) {
  await act(async () => root.render(<NewProjectDialog client={client} />));
}
async function open(folder: string | null) {
  await act(async () => useAgentStore.getState().openNewProjectDialog({ folder }));
  await act(async () => {});
}
function type(el: Element, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const input = (label: string) =>
  container.ownerDocument.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
const byText = (tag: string, text: string) =>
  [...document.querySelectorAll(tag)].find((e) => e.textContent?.trim() === text) as
    | HTMLElement
    | undefined;
const submitButton = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;
const nameInput = () => document.querySelector('input[placeholder="Client X"]') as HTMLInputElement;

beforeEach(() => {
  useWorkspaceStore.setState({ root: "/vault" });
  usePaneStore.setState({ open: false, width: AGENT_PANE_DEFAULT_WIDTH });
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    view: "chat",
    currentProjectPath: null,
    newProjectDialog: { open: false, folder: null },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("New project dialog (create)", () => {
  it("renders nothing until opened and closes on Escape", async () => {
    await mount(fakeClient());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await open(null);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("New project");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useAgentStore.getState().newProjectDialog.open).toBe(false);
  });

  it("defaults the location to Projects, blocks an invalid name, and previews the folder", async () => {
    await mount(fakeClient());
    await open(null);
    expect(input("Location").value).toBe("Projects");
    expect(submitButton().disabled).toBe(true);
    await act(async () => type(nameInput(), "a/b"));
    expect(submitButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("cannot contain /");
    await act(async () => type(nameInput(), "Client X"));
    expect(submitButton().disabled).toBe(false);
    expect(document.body.textContent).toContain("Creates Projects/Client X/");
  });

  it("creates one project from one dialog and opens a chat in it", async () => {
    const client = fakeClient();
    await mount(client);
    await open(null);
    await act(async () => type(nameInput(), "  Client X "));
    await act(async () =>
      type(
        document.querySelector('input[type="text"]:not([aria-label]):not([placeholder])')!,
        "Weekly status",
      ),
    );
    await act(async () => type(document.querySelector("textarea")!, "Reply in French."));
    // a tag source and a picked folder source
    const tag = input("Add a tag");
    await act(async () => type(tag, "#client"));
    await act(async () => {
      tag.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const picker = input("Add a folder or note");
    await act(async () => {
      picker.focus();
      type(picker, "cli");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.length).toBeGreaterThan(0);
    await act(async () => {
      options
        .find((o) => o.textContent?.includes("Folder"))!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await act(async () => submitButton().click());
    await act(async () => {});

    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledWith({
      name: "Client X",
      parent: "Projects",
      description: "Weekly status",
      inclusions: ["#client", "Clients/"],
      instructions: "Reply in French.",
    });
    const s = useAgentStore.getState();
    expect(s.newProjectDialog.open).toBe(false);
    expect(s.currentProjectPath).toBe("Projects/Client X");
    expect(usePaneStore.getState().open).toBe(true);
    expect(s.chats[s.activeChatId!]!.projectPath).toBe("Projects/Client X");
  });

  it("shows a duplicate-name error and stays open", async () => {
    const client = fakeClient({
      create: vi.fn(async () => {
        throw "Already exists: Projects/Dup already exists; pick another name";
      }),
    });
    await mount(client);
    await open(null);
    await act(async () => type(nameInput(), "Dup"));
    await act(async () => submitButton().click());
    await act(async () => {});
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Already exists");
    expect(useAgentStore.getState().newProjectDialog.open).toBe(true);
    expect(submitButton().disabled).toBe(false);
  });
});

describe("New project dialog (make project from a folder)", () => {
  it("converts a plain folder: offers Create AGENTS.md checked, no name or location fields", async () => {
    const client = fakeClient();
    await mount(client);
    await open("Research/Topic");
    await act(async () => {});
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Make project");
    expect(nameInput()).toBeNull();
    expect(input("Location")).toBeNull();
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => submitButton().click());
    await act(async () => {});
    expect(client.inspectFolder).toHaveBeenCalledWith("Research/Topic");
    expect(client.make).toHaveBeenCalledWith({
      path: "Research/Topic",
      createAgentsMd: true,
      instructions: "",
      description: "",
      inclusions: [],
    });
    expect(useAgentStore.getState().currentProjectPath).toBe("Research/Topic");
  });

  it("never offers to overwrite an existing AGENTS.md", async () => {
    const client = fakeClient({
      inspectFolder: vi.fn(async (p: string) => ({
        path: p,
        name: "Topic",
        isProject: false,
        hasProjectMd: false,
        hasAgentsMd: true,
        hasClaudeMd: true,
      })),
    });
    await mount(client);
    await open("Research/Topic");
    await act(async () => {});
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).toContain("already has an AGENTS.md");
    await act(async () => submitButton().click());
    await act(async () => {});
    expect(client.make).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "Research/Topic",
        createAgentsMd: false,
        instructions: undefined,
      }),
    );
  });

  it("says when the folder is already a project", async () => {
    const client = fakeClient({
      inspectFolder: vi.fn(async (p: string) => ({
        path: p,
        name: "Topic",
        isProject: true,
        hasProjectMd: true,
        hasAgentsMd: true,
        hasClaudeMd: false,
      })),
    });
    await mount(client);
    await open("Research/Topic");
    await act(async () => {});
    expect(document.body.textContent).toContain("already a project");
    expect(byText("button", "Make project")).toBeDefined();
  });
});
