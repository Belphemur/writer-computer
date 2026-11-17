// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("../src/hooks/editor-api", () => ({
  openFileInNewTab: vi.fn((p: string) => void opened.push(p)),
}));

import { ProjectHome } from "../src/components/agent/project-home";
import type { ProjectClient, ProjectDetail } from "../src/lib/agent/project-client";
import { useAgentStore } from "../src/stores/agent-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: ProjectDetail = {
  path: "Projects/Acme",
  id: "p1",
  name: "Acme",
  description: "Client work",
  createdAt: 1,
  lastUsedAt: 1,
  archivedAt: null,
  inclusions: [{ kind: "folder", path: "Clients/Acme", raw: "Clients/Acme/" }],
  exclusions: [],
  hasAgentsMd: true,
  hasClaudeMd: false,
  unsupported: ["file.pdf"],
  webUrls: [],
  youtubeUrls: [],
  agentMode: null,
  warnings: [],
};

function client(over: Partial<ProjectClient> = {}): ProjectClient {
  return {
    list: vi.fn(async () => []),
    read: vi.fn(async () => project),
    create: vi.fn(),
    make: vi.fn(async () => project),
    update: vi.fn(async () => project),
    archive: vi.fn(async () => project),
    inspectFolder: vi.fn(),
    manifest: vi.fn(async () => ({
      manifest: {
        entries: [
          { kind: "folder", label: "Clients/Acme/", count: 12, samples: [], warning: null },
        ],
        more: 0,
        exclusions: [],
        unsupported: ["file.pdf"],
        webUrls: [],
        youtubeUrls: [],
      },
      text: "",
    })),
    ...over,
  } as ProjectClient;
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  opened.length = 0;
  useWorkspaceStore.setState({ root: "/vault" });
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    paneOpen: false,
    view: "project",
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
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

describe("ProjectHome", () => {
  it("shows description, resolved sources with warnings, and a recent-chats slot", async () => {
    await act(async () =>
      root.render(
        <ProjectHome
          projectPath="Projects/Acme"
          recentChats={<p>slot content</p>}
          client={client()}
        />,
      ),
    );
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("Acme");
    expect(text).toContain("Client work");
    expect(text).toContain("Clients/Acme/");
    expect(text).toContain("12 notes");
    expect(text).toContain("unsupported source");
    expect(text).toContain("slot content");
  });

  it("opens AGENTS.md as a note and starts a chat in the project", async () => {
    await act(async () =>
      root.render(<ProjectHome projectPath="Projects/Acme" client={client()} />),
    );
    await act(async () => {});
    await act(async () => button("Open").click());
    expect(opened).toEqual(["/vault/Projects/Acme/AGENTS.md"]);
    await act(async () => button("New chat in project").click());
    const s = useAgentStore.getState();
    expect(s.chats[s.activeChatId!]!.projectPath).toBe("Projects/Acme");
    expect(s.view).toBe("chat");
  });

  it("offers to create a missing AGENTS.md without overwriting (make is idempotent)", async () => {
    const c = client({ read: vi.fn(async () => ({ ...project, hasAgentsMd: false })) });
    await act(async () => root.render(<ProjectHome projectPath="Projects/Acme" client={c} />));
    await act(async () => {});
    await act(async () => button("Create AGENTS.md").click());
    expect(c.make).toHaveBeenCalledWith({ path: "Projects/Acme", createAgentsMd: true });
  });

  it("archives after a confirmation step", async () => {
    const c = client();
    await act(async () => root.render(<ProjectHome projectPath="Projects/Acme" client={c} />));
    await act(async () => {});
    await act(async () => button("Archive project").click());
    expect(c.archive).not.toHaveBeenCalled();
    await act(async () => button("Archive").click());
    expect(c.archive).toHaveBeenCalledWith("Projects/Acme", true);
  });

  it("with no project offers New project", async () => {
    await act(async () => root.render(<ProjectHome projectPath={null} client={client()} />));
    await act(async () => button("New project").click());
    expect(useAgentStore.getState().newProjectDialog.open).toBe(true);
  });
});
