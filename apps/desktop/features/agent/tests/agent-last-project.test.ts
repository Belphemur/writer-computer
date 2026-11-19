// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const prefs = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (key: string, fallback: unknown) =>
    prefs.values.has(key) ? prefs.values.get(key) : fallback,
  ),
  setPreference: vi.fn(async (key: string, value: unknown) => {
    prefs.values.set(key, value);
  }),
}));

import { setPreference } from "@/lib/preferences";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  configureAgentRuntimeForTests,
  configureChatPersistenceForTests,
  lastProjectPreferenceKey,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { chooseProject } from "@features/agent/web/lib/project-actions";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

const g = goldens as unknown as Goldens;
const get = () => useAgentStore.getState();
const A = "/vault-a";
const B = "/vault-b";
const keyA = lastProjectPreferenceKey(A);
const keyB = lastProjectPreferenceKey(B);

const newChatProject = () => {
  const id = get().newChat();
  return get().chats[id]!.projectPath;
};
const noChats = { load: async () => null, save: async () => {} };

function listed(...paths: string[]) {
  useProjectsStore.setState({
    projects: paths.map((path) => ({ path })) as never,
    loadedRoot: useWorkspaceStore.getState().root,
  });
}

async function open(root: string) {
  useWorkspaceStore.setState({ root } as never);
  await get().restoreChats(root);
}

beforeEach(() => {
  prefs.values.clear();
  vi.mocked(setPreference).mockClear();
  configureAgentRuntimeForTests(createMockAgentClient({ goldens: g }));
  configureChatPersistenceForTests({ chatsIo: noChats, delayMs: 2 });
  usePaneStore.setState({ open: false, width: AGENT_PANE_DEFAULT_WIDTH });
  useProjectsStore.setState({ projects: [], archived: [], loadedRoot: null });
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    notes: {},
    view: "chat",
    backend: "tauri",
    currentProjectPath: null,
  });
  useWorkspaceStore.setState({ root: null } as never);
});

describe("the last used project", () => {
  it("new chat uses the project of the chat last worked in", () => {
    const a = get().newChat("Projects/A");
    get().setDraft(a, { text: "x" });
    const b = get().newChat("Projects/B");
    get().setDraft(b, { text: "y" });
    get().selectChat(a);
    expect(get().currentProjectPath).toBe("Projects/A");
    expect(newChatProject()).toBe("Projects/A");
  });

  it("picking a project updates it and an explicit project wins", () => {
    chooseProject("Projects/P");
    expect(get().currentProjectPath).toBe("Projects/P");
    const id = get().newChat("Projects/Other");
    expect(get().chats[id]!.projectPath).toBe("Projects/Other");
    expect(get().currentProjectPath).toBe("Projects/Other");
    chooseProject(null);
    expect(get().currentProjectPath).toBeNull();
  });

  it("is saved under the vault's key and restored before the first chat is made", async () => {
    await open(A);
    chooseProject("Projects/P");
    await vi.waitFor(() => expect(prefs.values.get(keyA)).toBe("Projects/P"));

    // relaunch: empty store, the pane's empty first chat exists before the restore (the test
    // resets the store of the same process, so what the old run saved is put back)
    useAgentStore.setState({ chats: {}, order: [], activeChatId: null, currentProjectPath: null });
    prefs.values.set(keyA, "Projects/P");
    configureChatPersistenceForTests({ chatsIo: noChats, delayMs: 2 });
    get().newChat();
    await open(A);
    expect(get().currentProjectPath).toBe("Projects/P");
    expect(get().chats[get().activeChatId!]!.projectPath).toBe("Projects/P");
    expect(newChatProject()).toBe("Projects/P");
  });

  it("nothing is written before the vault's value is loaded", () => {
    chooseProject("Projects/P");
    expect(setPreference).not.toHaveBeenCalled();
  });

  it("a project that is gone falls back to the vault root", async () => {
    prefs.values.set(keyA, "Projects/Gone");
    await open(A);
    expect(get().currentProjectPath).toBe("Projects/Gone");
    listed("Projects/Other");
    expect(newChatProject()).toBeNull();
    listed("Projects/Gone");
    useAgentStore.setState({ currentProjectPath: "Projects/Gone" });
    expect(newChatProject()).toBe("Projects/Gone");
  });

  it("vault A and vault B are separate", async () => {
    prefs.values.set(keyA, "Projects/A");
    await open(A);
    expect(get().currentProjectPath).toBe("Projects/A");
    await open(B);
    expect(get().currentProjectPath).toBeNull();
    chooseProject("Projects/B");
    await vi.waitFor(() => expect(prefs.values.get(keyB)).toBe("Projects/B"));
    expect(prefs.values.get(keyA)).toBe("Projects/A");
  });
});
