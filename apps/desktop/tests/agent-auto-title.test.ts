// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import {
  AUTO_TITLE_LONG_FIRST_MESSAGE_CHARS,
  applyTitleSummary,
  completedExchanges,
  shouldAutoTitle,
  type TitleTriggerInput,
} from "../src/lib/agent/auto-title";
import type { ChatHistoryClient } from "../src/lib/agent/chat-history-client";
import { emptyMeta, titleSourceOf, type ChatNoteMessage } from "../src/lib/agent/chat-note";
import type { ChatSummary } from "../src/lib/agent/events";
import { createMockAgentClient, type Goldens } from "../src/lib/agent/mock-client";
import { createChat } from "../src/lib/agent/reduce";
import {
  configureAgentRuntimeForTests,
  configureChatPersistenceForTests,
  regenerateChatTitle,
  useAgentStore,
} from "../src/stores/agent-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { goldens } from "./helpers/agent-goldens";

const user = (text: string, id = "u"): ChatNoteMessage => ({ role: "user", id, at: 1, text });
const reply = (text = "ok", reason: ChatNoteMessage["reason"] = "completed"): ChatNoteMessage => ({
  role: "assistant",
  id: "a",
  at: 2,
  text,
  reason,
});
const meta = (over: Partial<TitleTriggerInput["meta"]> = {}) => ({
  titleRenamed: false,
  titleAuto: false,
  ...over,
});
const input = (over: Partial<TitleTriggerInput> = {}): TitleTriggerInput => ({
  enabled: true,
  meta: meta(),
  messages: [user("a"), reply(), user("b"), reply()],
  attempted: false,
  ...over,
});

describe("auto title: the trigger rule", () => {
  it("fires after the second completed exchange, not the first", () => {
    expect(shouldAutoTitle(input())).toBe(true);
    expect(shouldAutoTitle(input({ messages: [user("a"), reply()] }))).toBe(false);
    expect(shouldAutoTitle(input({ messages: [user("a")] }))).toBe(false);
  });

  it("fires after the first exchange when the first message is long", () => {
    const long = "x".repeat(AUTO_TITLE_LONG_FIRST_MESSAGE_CHARS);
    expect(shouldAutoTitle(input({ messages: [user(long), reply()] }))).toBe(true);
    expect(shouldAutoTitle(input({ messages: [user(long)] }))).toBe(false);
  });

  it("an interrupted or failed turn is not an exchange", () => {
    const msgs = [user("a"), reply("x", "interrupted"), user("b"), reply("y", "error")];
    expect(completedExchanges(msgs)).toBe(0);
    expect(shouldAutoTitle(input({ messages: msgs }))).toBe(false);
  });

  it("never when the user renamed, when one was applied, when tried, or when the setting is off", () => {
    expect(shouldAutoTitle(input({ meta: meta({ titleRenamed: true }) }))).toBe(false);
    expect(shouldAutoTitle(input({ meta: meta({ titleAuto: true }) }))).toBe(false);
    expect(shouldAutoTitle(input({ attempted: true }))).toBe(false);
    expect(shouldAutoTitle(input({ enabled: false }))).toBe(false);
  });

  it("a rename wins over an automatic title in the derived source", () => {
    expect(titleSourceOf(meta())).toBe("none");
    expect(titleSourceOf(meta({ titleAuto: true }))).toBe("auto");
    expect(titleSourceOf(meta({ titleAuto: true, titleRenamed: true }))).toBe("user");
  });
});

describe("auto title: applying the answer", () => {
  const chat = { ...createChat("c1", { projectPath: null }), title: "first words" };
  const note = {
    meta: emptyMeta("c1", 0),
    messages: [],
    trimmed: 0,
    extraFrontmatter: "",
    pending: [],
  };

  it("adopts an automatic title in the tab and the note flags", () => {
    const r = applyTitleSummary(chat, note, { title: "Q4 plan", titleSource: "auto" })!;
    expect(r.chat.title).toBe("Q4 plan");
    expect(r.note!.meta).toMatchObject({ title: "Q4 plan", titleAuto: true, titleRenamed: false });
  });

  it("adopts the user's title when a rename happened meanwhile", () => {
    const r = applyTitleSummary(chat, note, { title: "Mine", titleSource: "user" })!;
    expect(r.chat.title).toBe("Mine");
    expect(r.note!.meta).toMatchObject({ titleRenamed: true, titleAuto: false });
  });

  it("ignores a summary that carries no chosen title", () => {
    expect(applyTitleSummary(chat, note, { title: "x", titleSource: "none" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
const g = goldens as unknown as Goldens;
const get = () => useAgentStore.getState();
const SUMMARY: ChatSummary = {
  chatId: "c",
  path: ".writer/chats/c.md",
  title: "First words",
  projectPath: null,
  sessionId: null,
  createdAt: 1,
  updatedAt: 2,
  turnCount: 2,
  archived: false,
  pinned: false,
  titleSource: "none",
};

function history(over: Partial<ChatHistoryClient> = {}) {
  const client: ChatHistoryClient = {
    list: vi.fn(async () => []),
    load: vi.fn(),
    save: vi.fn(async (a) => ({ ...SUMMARY, chatId: a.chatId })),
    action: vi.fn(async () => null),
    autoTitle: vi.fn(async (a) => ({
      ...SUMMARY,
      chatId: a.chatId,
      title: "Planning the review",
      titleSource: "auto" as const,
    })),
    regenerateTitle: vi.fn(),
    replay: vi.fn(),
    saveImage: vi.fn(),
    importImageFile: vi.fn(),
    permissionRules: vi.fn(async () => ({ allow: [], deny: [] })),
    removePermissionRule: vi.fn(async () => {}),
    ...over,
  };
  return client;
}

async function exchange(mock: ReturnType<typeof createMockAgentClient>, id: string, text: string) {
  await get().sendMessage(text);
  await mock.idle(id);
}

async function chatWithExchanges(client: ChatHistoryClient, n: number) {
  configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
  const mock = createMockAgentClient({ goldens: g });
  configureAgentRuntimeForTests(mock);
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    queued: {},
    notes: {},
    chatModels: {},
    paneOpen: false,
    backend: "tauri",
    binary: { found: true, path: "/x", version: "1", source: "path" },
    currentProjectPath: null,
  });
  get().openPane();
  const id = get().activeChatId!;
  for (let i = 0; i < n; i++) await exchange(mock, id, `question number ${i + 1}`);
  return { id, mock };
}

describe("auto title in the store", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: {} });
  });

  it("asks once after the second exchange and swaps the tab title", async () => {
    const client = history();
    const { id, mock } = await chatWithExchanges(client, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.autoTitle).not.toHaveBeenCalled();
    await exchange(mock, id, "question number 2");
    await vi.waitFor(() => expect(client.autoTitle).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(get().chats[id]!.title).toBe("Planning the review"));
    expect(get().notes[id]!.meta.titleAuto).toBe(true);
    const args = vi.mocked(client.autoTitle).mock.calls[0]![0];
    expect(args.chatId).toBe(id);
    expect(args.titleModel).toBeNull();
    // the title input is the saved note: the pane flushed before asking
    expect(Object.keys(args).sort()).toEqual(["chatId", "chatModel", "titleModel"]);
    expect(Math.min(...vi.mocked(client.save).mock.invocationCallOrder)).toBeLessThan(
      vi.mocked(client.autoTitle).mock.invocationCallOrder[0]!,
    );
    // a third exchange never asks again, and a later save keeps the title
    await exchange(mock, id, "question number 3");
    await new Promise((r) => setTimeout(r, 30));
    expect(client.autoTitle).toHaveBeenCalledTimes(1);
    const lastSave = vi.mocked(client.save).mock.calls.at(-1)![0].markdown;
    expect(lastSave).toContain("writer-chat-title: Planning the review");
    expect(lastSave).toContain("writer-chat-title-auto: true");
  });

  it("regenerates an open chat's title: flush first, then the tab and flags change live", async () => {
    const order: string[] = [];
    const client = history({
      save: vi.fn(async (a) => {
        order.push("save");
        return { ...SUMMARY, chatId: a.chatId };
      }),
      regenerateTitle: vi.fn(async (chatId) => {
        order.push("regenerate");
        return {
          status: "done" as const,
          summary: { ...SUMMARY, chatId, title: "Fresh words", titleSource: "auto" as const },
        };
      }),
    });
    const { id, mock } = await chatWithExchanges(client, 1);
    // a user rename is in the note; a new message leaves a save pending
    useAgentStore.setState((s) => ({
      chats: { ...s.chats, [id]: { ...s.chats[id]!, title: "Mine" } },
      notes: {
        ...s.notes,
        [id]: { ...s.notes[id]!, meta: { ...s.notes[id]!.meta, titleRenamed: true } },
      },
    }));
    await get().sendMessage("one more");
    await mock.idle(id);
    order.length = 0;
    await get().sendMessage("and another");
    const out = await regenerateChatTitle(id);
    expect(out.status).toBe("done");
    expect(order).toEqual(["save", "regenerate"]);
    expect(get().chats[id]!.title).toBe("Fresh words");
    expect(get().notes[id]!.meta).toMatchObject({ titleAuto: true, titleRenamed: false });
    expect(get().activeChatId).toBe(id);
    expect(vi.mocked(client.regenerateTitle).mock.calls[0]).toEqual([id, null]);
  });

  it("a refusal or a closed chat changes nothing in the store", async () => {
    const client = history({
      regenerateTitle: vi.fn(async () => ({
        status: "refused" as const,
        reason: "failed" as const,
      })),
    });
    const { id } = await chatWithExchanges(client, 1);
    const before = get().chats[id]!.title;
    expect((await regenerateChatTitle(id)).status).toBe("refused");
    expect(get().chats[id]!.title).toBe(before);
    vi.mocked(client.regenerateTitle).mockResolvedValueOnce({
      status: "done",
      summary: { ...SUMMARY, chatId: "not-open", title: "Elsewhere", titleSource: "auto" },
    });
    await regenerateChatTitle("not-open");
    expect(Object.keys(get().chats)).toEqual([id]);
  });

  it("saves the note before asking, so the title has a file to land in", async () => {
    const order: string[] = [];
    const client = history({
      save: vi.fn(async (a) => {
        order.push("save");
        return { ...SUMMARY, chatId: a.chatId };
      }),
      autoTitle: vi.fn(async () => {
        order.push("title");
        return null;
      }),
    });
    await chatWithExchanges(client, 2);
    await vi.waitFor(() => expect(order).toContain("title"));
    expect(order.lastIndexOf("save")).toBeLessThan(order.indexOf("title"));
  });

  it("does nothing when the setting is off", async () => {
    useSettingsStore.setState({ settings: { "agent.auto-title-chats": false } });
    const client = history();
    await chatWithExchanges(client, 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(client.autoTitle).not.toHaveBeenCalled();
  });

  it("passes the cheap tier model setting and the chat model", async () => {
    useSettingsStore.setState({ settings: { "agent.claude.model-cheap": "claude-haiku-4-5" } });
    const client = history();
    const { id } = await chatWithExchanges(client, 1);
    useAgentStore.setState((s) => ({
      chatModels: { ...s.chatModels, [id]: { model: "sonnet", effort: null } },
    }));
    const mock = createMockAgentClient({ goldens: g });
    configureAgentRuntimeForTests(mock);
    await get().sendMessage("question number 2");
    await mock.idle(id);
    await vi.waitFor(() => expect(client.autoTitle).toHaveBeenCalled());
    const args = vi.mocked(client.autoTitle).mock.calls[0]![0];
    expect(args.titleModel).toBe("claude-haiku-4-5");
    expect(args.chatModel).toBe("sonnet");
  });

  it("a manual rename wins: the answer carries the user's title and the tab shows it", async () => {
    const client = history({
      autoTitle: vi.fn(async (a) => ({
        ...SUMMARY,
        chatId: a.chatId,
        title: "My own name",
        titleSource: "user" as const,
      })),
    });
    const { id } = await chatWithExchanges(client, 2);
    await vi.waitFor(() => expect(get().chats[id]!.title).toBe("My own name"));
    expect(get().notes[id]!.meta).toMatchObject({ titleRenamed: true, titleAuto: false });
  });

  it("a note already renamed or auto-titled is never asked again", async () => {
    const client = history();
    const { id, mock } = await chatWithExchanges(client, 1);
    useAgentStore.setState((s) => ({
      notes: {
        ...s.notes,
        [id]: { ...s.notes[id]!, meta: { ...s.notes[id]!.meta, titleRenamed: true } },
      },
    }));
    await exchange(mock, id, "question number 2");
    await new Promise((r) => setTimeout(r, 30));
    expect(client.autoTitle).not.toHaveBeenCalled();
  });

  it("a failure keeps the placeholder, tries once, and a closed chat is left alone", async () => {
    const failing = history({
      autoTitle: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const a = await chatWithExchanges(failing, 2);
    await vi.waitFor(() => expect(failing.autoTitle).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(get().chats[a.id]!.title).toBe("question number 1");
    await exchange(a.mock, a.id, "question number 3");
    await new Promise((r) => setTimeout(r, 30));
    expect(failing.autoTitle).toHaveBeenCalledTimes(1);

    let release: (s: ChatSummary | null) => void = () => {};
    const slow = history({
      autoTitle: vi.fn(() => new Promise<ChatSummary | null>((r) => (release = r))),
    });
    const b = await chatWithExchanges(slow, 2);
    await vi.waitFor(() => expect(slow.autoTitle).toHaveBeenCalled());
    useAgentStore.setState((s) => {
      const { [b.id]: _gone, ...chats } = s.chats;
      return { chats, order: s.order.filter((x) => x !== b.id) };
    });
    release({ ...SUMMARY, chatId: b.id, title: "Late title", titleSource: "auto" });
    await new Promise((r) => setTimeout(r, 10));
    expect(get().chats[b.id]).toBeUndefined();
  });
});
