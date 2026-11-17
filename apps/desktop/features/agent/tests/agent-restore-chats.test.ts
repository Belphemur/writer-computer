// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { invoke } from "@tauri-apps/api/core";
import { loadAgentChats, saveAgentChats } from "@/lib/session";
import { buildNote, newNoteState, recordSend } from "@features/agent/web/lib/chat-persist";
import type { ChatHistoryClient } from "@features/agent/web/lib/chat-history-client";
import type { ChatSummary } from "@features/agent/web/lib/events";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import type { AgentChatsSession } from "@/lib/session";
import {
  configureAgentRuntimeForTests,
  configureChatPersistenceForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

const g = goldens as unknown as Goldens;
const get = () => useAgentStore.getState();
const ROOT = "/vault";

function noteMarkdown(chatId: string, text: string, sessionId: string | null) {
  const note = recordSend(newNoteState(chatId, null, 0), {
    messageId: `${chatId}-u`,
    text,
    context: [],
    ts: 1,
  });
  return buildNote(
    { chatId, title: text, projectPath: null, session: null, resumeSessionId: sessionId },
    note,
    2,
  ).markdown;
}

const summaryOf = (chatId: string): ChatSummary => ({
  chatId,
  path: `.chats/${chatId}.md`,
  title: chatId,
  projectPath: null,
  sessionId: null,
  createdAt: 1,
  updatedAt: 2,
  turnCount: 1,
  archived: false,
  pinned: false,
  titleSource: "none",
});

/** Chat notes that "exist on disk" by id. */
function fakeHistory(notes: Record<string, string>) {
  const client = {
    load: vi.fn(async (chatId: string) => {
      const markdown = notes[chatId];
      if (!markdown) throw new Error("chat not found");
      return { summary: summaryOf(chatId), markdown };
    }),
    save: vi.fn(async (a: { chatId: string }) => summaryOf(a.chatId)),
    list: vi.fn(async () => []),
  } as unknown as ChatHistoryClient;
  return client;
}

function fakeIo(initial: AgentChatsSession | null = null) {
  let stored = initial;
  const io = {
    load: vi.fn(async () => stored),
    save: vi.fn(async (_root: string, s: AgentChatsSession) => {
      stored = s;
    }),
  };
  return { io, saved: () => stored };
}

function resetStore() {
  usePaneStore.setState({ open: false, width: AGENT_PANE_DEFAULT_WIDTH });
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    queued: {},
    modes: {},
    chatModels: {},
    notes: {},
    resuming: {},
    view: "chat",
    backend: "tauri",
    currentProjectPath: null,
  });
}

let mock: ReturnType<typeof createMockAgentClient>;
beforeEach(() => {
  mock = createMockAgentClient({ goldens: g });
  configureAgentRuntimeForTests(mock);
  resetStore();
  useWorkspaceStore.setState({ root: ROOT } as never);
  useSettingsStore.setState({ settings: { "agent.restore-chats": true } } as never);
});

describe("restoring the pane's open chats", () => {
  it("round trip: open, switch and close chats are saved, then a new window gets them back", async () => {
    const history = fakeHistory({
      a: noteMarkdown("a", "first", "sess-a"),
      b: noteMarkdown("b", "second", "sess-b"),
    });
    const first = fakeIo();
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: first.io });
    await get().restoreChats(ROOT);
    await get().openSavedChat("a");
    await get().openSavedChat("b");
    get().selectChat("a");
    await vi.waitFor(() =>
      expect(first.saved()).toEqual({
        chats: [
          { chatId: "a", sessionId: "sess-a" },
          { chatId: "b", sessionId: "sess-b" },
        ],
        activeChatId: "a",
      }),
    );

    // relaunch
    resetStore();
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: fakeIo(first.saved()).io });
    await get().restoreChats(ROOT);
    expect(get().order).toEqual(["a", "b"]);
    expect(get().activeChatId).toBe("a");
    expect(get().chats.a!.turns[0]!.user?.text).toBe("first");
    expect(get().chats.a!.resumeSessionId).toBe("sess-a");
    expect(get().chats.a!.state).toBe("idle");
    expect(get().chats.a!.pendingPermissions).toEqual([]);
  });

  it("drops a chat whose note is gone and rewrites the saved list; the active one is kept", async () => {
    const history = fakeHistory({
      a: noteMarkdown("a", "first", null),
      c: noteMarkdown("c", "third", null),
    });
    const { io, saved } = fakeIo({
      chats: [
        { chatId: "a", sessionId: null },
        { chatId: "gone", sessionId: "s" },
        { chatId: "c", sessionId: null },
      ],
      activeChatId: "a",
    });
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: io });
    await get().restoreChats(ROOT);
    expect(get().order).toEqual(["a", "c"]);
    expect(get().activeChatId).toBe("a");
    await vi.waitFor(() => expect(saved()!.chats.map((c) => c.chatId)).toEqual(["a", "c"]));
    expect(saved()!.activeChatId).toBe("a");
  });

  it("falls back to the last chat when the active one is gone", async () => {
    const history = fakeHistory({
      a: noteMarkdown("a", "first", null),
      c: noteMarkdown("c", "third", null),
    });
    const { io } = fakeIo({
      chats: [
        { chatId: "a", sessionId: null },
        { chatId: "c", sessionId: null },
      ],
      activeChatId: "gone",
    });
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: io });
    await get().restoreChats(ROOT);
    expect(get().activeChatId).toBe("c");
  });

  it("restores nothing with agent.restore-chats off", async () => {
    useSettingsStore.setState({ settings: { "agent.restore-chats": false } } as never);
    const history = fakeHistory({ a: noteMarkdown("a", "first", null) });
    // the real session helpers honour the setting; the fake mimics them
    const io = {
      load: vi.fn(async () =>
        useSettingsStore.getState().settings["agent.restore-chats"] === false
          ? null
          : { chats: [{ chatId: "a", sessionId: null }], activeChatId: "a" },
      ),
      save: vi.fn(async () => {}),
    };
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: io });
    await get().restoreChats(ROOT);
    expect(get().order).toEqual([]);
    expect(history.load).not.toHaveBeenCalled();
  });

  it("spawns no CLI process; the first send resumes the saved session", async () => {
    const history = fakeHistory({ a: noteMarkdown("a", "first", "sess-a") });
    const { io } = fakeIo({ chats: [{ chatId: "a", sessionId: "sess-a" }], activeChatId: "a" });
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: io });
    const start = vi.spyOn(mock, "start");
    const subscribe = vi.spyOn(mock, "subscribe");
    await get().restoreChats(ROOT);
    expect(start).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    await get().sendMessage("again");
    expect(start.mock.calls[0]![0]).toMatchObject({ chatId: "a", resumeSessionId: "sess-a" });
  });

  it("an empty fresh tab makes room, and the pane keeps its chats across close and reopen", async () => {
    const history = fakeHistory({ a: noteMarkdown("a", "first", null) });
    const { io } = fakeIo({ chats: [{ chatId: "a", sessionId: null }], activeChatId: "a" });
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: io });
    get().openPane();
    const fresh = get().activeChatId!;
    await get().restoreChats(ROOT);
    expect(get().order).toEqual(["a"]);
    expect(get().chats[fresh]).toBeUndefined();
    get().closePane();
    get().openPane();
    expect(get().order).toEqual(["a"]);
    expect(get().activeChatId).toBe("a");
    // restoring again for the same vault does nothing
    await get().restoreChats(ROOT);
    expect(history.load).toHaveBeenCalledTimes(1);
  });

  it("never saves before the restore ran, so a fresh empty chat cannot wipe the saved list", async () => {
    const history = fakeHistory({});
    const { io } = fakeIo({ chats: [{ chatId: "a", sessionId: null }], activeChatId: "a" });
    configureChatPersistenceForTests({ history, delayMs: 2, chatsIo: io });
    get().openPane();
    await new Promise((r) => setTimeout(r, 10));
    expect(io.save).not.toHaveBeenCalled();
  });
});

describe("agent chats in the editor session file", () => {
  it("go through the session commands, and are skipped entirely when the setting is off", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({
      tabs: [],
      agent_chats: { chats: [{ chat_id: "a", session_id: "s" }], active_chat_id: "a" },
    });
    expect(await loadAgentChats(ROOT)).toEqual({
      chats: [{ chatId: "a", sessionId: "s" }],
      activeChatId: "a",
    });
    await saveAgentChats(ROOT, { chats: [{ chatId: "a", sessionId: "s" }], activeChatId: "a" });
    expect(invoke).toHaveBeenLastCalledWith("save_agent_chats", {
      workspaceRoot: ROOT,
      chats: [{ chat_id: "a", session_id: "s" }],
      activeChatId: "a",
    });
    vi.mocked(invoke).mockClear();
    useSettingsStore.setState({ settings: { "agent.restore-chats": false } } as never);
    expect(await loadAgentChats(ROOT)).toBeNull();
    await saveAgentChats(ROOT, { chats: [], activeChatId: null });
    expect(invoke).not.toHaveBeenCalled();
  });
});
