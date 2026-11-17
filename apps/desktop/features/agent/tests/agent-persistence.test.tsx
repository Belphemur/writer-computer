// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => hoisted.invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { AgentPane } from "@features/agent/web/components/agent-pane";
import { ProjectRecentChats } from "@features/agent/web/components/project-recent-chats";
import { agentSettingDefault, agentSettingsFrom } from "@features/agent/web/lib/agent-settings";
import type { AgentClient } from "@features/agent/web/lib/client";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import type { ChatHistoryClient } from "@features/agent/web/lib/chat-history-client";
import {
  parseChatNote,
  serializeChatNote,
  type ChatNoteDoc,
} from "@features/agent/web/lib/chat-note";
import {
  buildNote,
  eventErrorTexts,
  isSessionMissing,
  newNoteState,
  recordEvents,
  recordSend,
  recordSteer,
} from "@features/agent/web/lib/chat-persist";
import { createChatSaver } from "@features/agent/web/lib/chat-saver";
import type { AgentEvent, ChatSummary } from "@features/agent/web/lib/events";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  configureAgentRuntimeForTests,
  configureChatPersistenceForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import {
  closeAgentPane,
  openAgentHistory,
  startNewAgentChat,
} from "@features/agent/web/hooks/agent-api";
import { useSettingsStore } from "@/stores/settings-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const g = goldens as unknown as Goldens;
const get = () => useAgentStore.getState();
const chat = () => get().chats[get().activeChatId!]!;

// ---------------------------------------------------------------------------------------------
describe("chat-persist: what the note holds", () => {
  it("send and a finished turn become a user and an assistant message that round-trip", () => {
    let note = newNoteState("c1", "Projects/Demo", 0);
    note = recordSend(note, {
      messageId: "m1",
      text: "write a file",
      context: [{ kind: "note", path: "Plan.md" }],
      ts: 1_000,
    });
    const r = recordEvents(note, goldens["permission-allow"]!, 2_000);
    expect(r.finished).toBe(true);
    note = r.note;
    expect(note.pending).toEqual([]);
    expect(note.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(note.messages[0]!.context).toBe("[[Plan]]");
    const a = note.messages[1]!;
    expect(a.id).toBe("m1-a");
    expect(a.reason).toBe("completed");
    expect(a.tools?.map((t) => t.tool)).toEqual(["Write", "Bash"]);
    expect(note.meta.usage?.costUsd).toBeGreaterThan(0);

    const chatLike = {
      chatId: "c1",
      title: "x",
      projectPath: "Projects/Demo",
      session: null,
      resumeSessionId: null,
    };
    const { markdown, titleHint } = buildNote(chatLike, note, 3_000);
    expect(titleHint).toBe("write a file");
    const doc = parseChatNote(markdown);
    expect(doc.meta).toMatchObject({
      chatId: "c1",
      title: "write a file",
      projectPath: "Projects/Demo",
      turns: 1,
      updatedAt: 3_000,
      preview: "write a file",
    });
    expect(doc.messages).toHaveLength(2);
  });

  it("streaming events alone write nothing: a partial turn stays pending", () => {
    const events = goldens["ok-turn"]!.filter(
      (e) => e.type === "text-delta" || e.type === "session-started",
    );
    const r = recordEvents(newNoteState("c", null, 0), events, 1);
    expect(r.finished).toBe(false);
    expect(r.note.messages).toEqual([]);
    expect(r.note.pending.length).toBe(events.length);
  });

  it("a steer is a marked user message placed after the assistant message of the turn it cut", () => {
    let note = newNoteState("c", null, 0);
    note = recordSend(note, { messageId: "m1", text: "go", context: [], ts: 1 });
    const events = goldens["steer-now-text"]!;
    const firstEnd = events.findIndex((e) => e.type === "turn-finished");
    note = recordEvents(note, events.slice(0, 2), 2).note;
    note = recordSteer(note, { messageId: "m2", text: "also this", context: [], ts: 3 });
    expect(note.pending).toHaveLength(2); // the events before the steer are not lost
    expect(note.messages).toHaveLength(1); // not yet: the cut turn's answer comes first
    note = recordEvents(note, events.slice(2), 4).note;
    expect(note.messages.map((m) => `${m.role}:${m.id}${m.steer ? ":steer" : ""}`)).toEqual([
      "user:m1",
      "assistant:m1-a",
      "user:m2:steer",
      "assistant:m2-a",
    ]);
    expect(note.messages[1]!.reason).toBe("interrupted");
    expect(firstEnd).toBeGreaterThan(1);
  });

  it("keeps a renamed title and the session id of a resumed chat", () => {
    let note = newNoteState("c", null, 0);
    note = { ...note, meta: { ...note.meta, title: "Mine", titleRenamed: true } };
    note = recordSend(note, { messageId: "m", text: "hello", context: [], ts: 1 });
    const { markdown } = buildNote(
      { chatId: "c", title: "t", projectPath: null, session: null, resumeSessionId: "sess-1" },
      note,
      2,
    );
    const doc = parseChatNote(markdown);
    expect(doc.meta.title).toBe("Mine");
    expect(doc.meta.sessionId).toBe("sess-1");
  });

  it("saves the chosen model, else the reported one, in writer-chat-model", () => {
    let note = newNoteState("c", null, 0);
    note = recordSend(note, { messageId: "m", text: "hello", context: [], ts: 1 });
    const chat = {
      chatId: "c",
      title: "t",
      projectPath: null,
      session: null,
      resumeSessionId: null,
    };
    const meta = (c: object, chosen?: string | null) =>
      parseChatNote(buildNote({ ...chat, ...c }, note, 2, chosen).markdown).meta.model;
    expect(meta({ reportedModel: "claude-haiku-5-5" })).toBe("claude-haiku-5-5");
    expect(meta({ reportedModel: "claude-haiku-5-5" }, "opus")).toBe("opus");
    expect(meta({})).toBeNull();
  });

  it("detects a lost CLI session like the Rust matcher", () => {
    expect(isSessionMissing("No conversation found with session ID: x")).toBe(true);
    expect(isSessionMissing("Session abc not found")).toBe(true);
    expect(isSessionMissing("rate limited")).toBe(false);
    const ev = [
      { type: "error", kind: "api", message: "No conversation found", retryable: false },
      { type: "turn-finished", reason: "error", isError: true, errors: ["boom"], result: null },
    ] as unknown as AgentEvent[];
    expect(eventErrorTexts(ev)).toEqual(["No conversation found", "boom", ""]);
  });
});

// ---------------------------------------------------------------------------------------------
const NOTE_DOC = (over: Partial<ChatNoteDoc["meta"]> = {}): ChatNoteDoc => ({
  meta: {
    chatId: "saved-1",
    title: "Plan the review",
    titleRenamed: false,
    titleAuto: false,
    backend: "claude",
    sessionId: "sess-9",
    project: null,
    projectPath: "Projects/Demo",
    cliVersion: "2.1.325",
    model: "claude-sonnet-5-5",
    createdAt: 1_000,
    updatedAt: 2_000,
    turns: 2,
    pinned: false,
    archivedAt: null,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
    preview: "first",
    ...over,
  },
  messages: [
    { role: "user", id: "u1", at: 1_000, text: "first question", context: "[[Plan]], #client" },
    {
      role: "assistant",
      id: "u1-a",
      at: 1_500,
      reason: "completed",
      text: "the answer",
      tools: [
        { id: "t1", tool: "Read", input: { file_path: "Plan.md" }, outcome: "ok" },
        { id: "t2", tool: "Bash", input: { command: "ls" }, outcome: "rejected" },
      ],
    },
    { role: "user", id: "u2", at: 2_000, text: "second" },
  ],
  trimmed: 0,
  extraFrontmatter: "",
});
const SUMMARY: ChatSummary = {
  chatId: "saved-1",
  path: "Projects/Demo/.chats/2026-11-17-0912-plan-saved-1.md",
  title: "Plan the review",
  projectPath: "Projects/Demo",
  sessionId: "sess-9",
  createdAt: 1_000,
  updatedAt: 2_000,
  turnCount: 2,
  archived: false,
  pinned: false,
  titleSource: "none",
};

describe("chat-from-note", () => {
  it("rebuilds the transcript: user cards, collapsed tool rows, final text, how turns ended", () => {
    const c = chatFromNote(NOTE_DOC(), SUMMARY);
    expect(c.title).toBe("Plan the review");
    expect(c.projectPath).toBe("Projects/Demo");
    expect(c.resumeSessionId).toBe("sess-9");
    expect(c.session).toBeNull();
    expect(c.state).toBe("idle");
    expect(c.turns).toHaveLength(2);
    const t = c.turns[0]!;
    expect(t.user).toMatchObject({
      messageId: "u1",
      text: "first question",
      contextLabel: "[[Plan]], #client",
    });
    expect(t.blocks.map((b) => b.kind)).toEqual(["tool", "tool", "text"]);
    expect(
      t.blocks.filter((b) => b.kind === "tool").map((b) => (b as { status: string }).status),
    ).toEqual(["ok", "rejected"]);
    expect(t.status).toBe("completed");
    expect(c.turns[1]!.user?.text).toBe("second");
    expect(c.totalCostUsd).toBe(0.5);
  });

  it("an assistant message without a user before it gets its own turn", () => {
    const doc = NOTE_DOC();
    doc.messages = [doc.messages[1]!];
    expect(chatFromNote(doc, SUMMARY).turns[0]!.user).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("chat saver", () => {
  const summary = SUMMARY;
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("coalesces a burst into one write after the debounce", async () => {
    const save = vi.fn(async () => summary);
    const saver = createChatSaver({ save, delayMs: 500 });
    let n = 0;
    for (let i = 0; i < 20; i++)
      saver.schedule("c", () => ({ markdown: `v${++n}`, titleHint: "t" }));
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("c", { markdown: "v1", titleHint: "t" });
  });

  it("never overlaps writes and runs exactly one more for changes made meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const save = vi.fn(async (_id: string, req: { markdown: string }) => {
      calls.push(req.markdown);
      if (calls.length === 1) await gate;
      return summary;
    });
    const saver = createChatSaver({ save, delayMs: 10 });
    let v = 0;
    const build = () => ({ markdown: `v${++v}`, titleHint: "t" });
    saver.schedule("c", build);
    await vi.advanceTimersByTimeAsync(11);
    saver.schedule("c", build);
    await vi.advanceTimersByTimeAsync(11);
    saver.schedule("c", build);
    await vi.advanceTimersByTimeAsync(11);
    expect(calls).toEqual(["v1"]); // first still in flight
    release();
    await vi.advanceTimersByTimeAsync(0);
    await saver.flush("c");
    expect(calls).toEqual(["v1", "v2"]);
  });

  it("reports failures and keeps going; null from build skips the write", async () => {
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(summary);
    const saver = createChatSaver({ save, onError, delayMs: 1 });
    saver.schedule("c", () => ({ markdown: "a", titleHint: "t" }));
    await vi.advanceTimersByTimeAsync(5);
    expect(onError).toHaveBeenCalledWith("c", expect.any(Error));
    saver.schedule("c", () => null);
    await vi.advanceTimersByTimeAsync(5);
    saver.schedule("c", () => ({ markdown: "b", titleHint: "t" }));
    await vi.advanceTimersByTimeAsync(5);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("flush writes at once", async () => {
    const save = vi.fn(async () => summary);
    const saver = createChatSaver({ save, delayMs: 10_000 });
    saver.schedule("c", () => ({ markdown: "x", titleHint: "t" }));
    await saver.flush("c");
    expect(save).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeHistory(over: Partial<ChatHistoryClient> = {}) {
  const saves: { chatId: string; markdown: string; titleHint?: string }[] = [];
  const client: ChatHistoryClient = {
    list: vi.fn(async () => [SUMMARY]),
    load: vi.fn(async () => ({ summary: SUMMARY, markdown: serializeChatNote(NOTE_DOC()) })),
    save: vi.fn(async (a) => {
      saves.push(a);
      return { ...SUMMARY, chatId: a.chatId };
    }),
    action: vi.fn(async () => null),
    autoTitle: vi.fn(async () => null),
    regenerateTitle: vi.fn(),
    replay: vi.fn(async () => ({
      text: "[Resumed from notes] earlier text",
      turnsIncluded: 2,
      turnsTotal: 2,
      estimatedTokens: 9,
    })),
    saveImage: vi.fn(),
    importImageFile: vi.fn(),
    permissionRules: vi.fn(async () => ({ allow: [], deny: [] })),
    removePermissionRule: vi.fn(async () => {}),
    ...over,
  };
  return { client, saves };
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
    historyError: null,
    view: "chat",
    backend: "tauri",
    binary: {
      found: true,
      path: "/x",
      version: "1",
      source: "path",
      searched: [],
      authenticated: true,
      account: null,
    },
    currentProjectPath: null,
  });
}

describe("autosave from the store", () => {
  it("saves after a send and after turn-finished, never per streaming delta", async () => {
    const { client, saves } = fakeHistory();
    const reload = vi.fn(async () => true);
    configureChatPersistenceForTests({ history: client, delayMs: 8, reload });
    const mock = createMockAgentClient({ goldens: g, delayMs: 3 });
    configureAgentRuntimeForTests(mock);
    resetStore();
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("multi word question about notes");
    await vi.waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(1));
    expect(saves[0]!.markdown).toContain("multi word question about notes");
    expect(saves[0]!.markdown).not.toContain("## assistant");
    expect(saves[0]!.chatId).toBe(id);
    expect(saves[0]!.titleHint).toBe("multi word question about notes");
    await mock.idle(id);
    await vi.waitFor(() => expect(saves[saves.length - 1]!.markdown).toContain("## assistant"));
    await settle(30);
    const last = parseChatNote(saves[saves.length - 1]!.markdown);
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(last.messages[1]!.text.trim()).toBe("ok");
    // the ok-turn capture has ~1 delta and a dozen events: far fewer writes than events
    expect(saves.length).toBeLessThanOrEqual(3);
    // the note is reloaded in an editor tab when open
    expect(reload).toHaveBeenCalledWith(SUMMARY.path);
  });

  it("a failed save is shown on the chat, not swallowed", async () => {
    const { client } = fakeHistory({
      save: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
    configureAgentRuntimeForTests(createMockAgentClient({ goldens: g }));
    resetStore();
    get().openPane();
    await get().sendMessage("hi");
    await vi.waitFor(() => expect(chat().saveError).toMatch(/disk full/));
  });
});

describe("openSavedChat", () => {
  beforeEach(() => {
    resetStore();
  });

  it("opens the note as a tab with its transcript, replacing an empty untouched tab", async () => {
    const { client } = fakeHistory();
    configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
    configureAgentRuntimeForTests(createMockAgentClient({ goldens: g }));
    get().openPane();
    const empty = get().activeChatId!;
    await get().openSavedChat("saved-1");
    expect(get().activeChatId).toBe("saved-1");
    expect(get().order).toEqual(["saved-1"]);
    expect(get().chats[empty]).toBeUndefined();
    expect(chat().turns).toHaveLength(2);
    expect(get().view).toBe("chat");
    // opening it again only selects it
    await get().openSavedChat("saved-1");
    expect(client.load).toHaveBeenCalledTimes(1);
  });

  it("a note that cannot be read sets an error and changes nothing", async () => {
    const { client } = fakeHistory({
      load: vi.fn(async () => ({ summary: SUMMARY, markdown: "not a chat note" })),
    });
    configureChatPersistenceForTests({ history: client, reload: async () => false });
    configureAgentRuntimeForTests(createMockAgentClient({ goldens: g }));
    get().openPane();
    await get().openSavedChat("saved-1");
    expect(get().historyError).toMatch(/Could not open this chat/);
    expect(get().chats["saved-1"]).toBeUndefined();
  });

  it("the next send resumes the saved CLI session", async () => {
    const { client } = fakeHistory();
    configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
    const mock = createMockAgentClient({ goldens: g });
    const start = vi.spyOn(mock, "start");
    configureAgentRuntimeForTests(mock);
    get().openPane();
    await get().openSavedChat("saved-1");
    await get().sendMessage("one more thing");
    expect(start.mock.calls[0]![0]).toMatchObject({
      chatId: "saved-1",
      resumeSessionId: "sess-9",
      projectPath: "Projects/Demo",
    });
    await mock.idle("saved-1");
    await settle(5);
    expect(chat().turns).toHaveLength(3);
    expect(get().resuming["saved-1"]).toBe(false);
  });

  it("restores the chat's saved model and starts the resumed session with it", async () => {
    const { client } = fakeHistory({
      load: vi.fn(async () => ({
        summary: SUMMARY,
        markdown: serializeChatNote(NOTE_DOC({ model: "claude-haiku-5-5" })),
      })),
    });
    configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
    const mock = createMockAgentClient({ goldens: g });
    const start = vi.spyOn(mock, "start");
    configureAgentRuntimeForTests(mock);
    get().openPane();
    await get().openSavedChat("saved-1");
    expect(get().chatModels["saved-1"]).toMatchObject({ model: "claude-haiku-5-5" });
    await get().sendMessage("go on");
    expect(start.mock.calls[0]![0].settings.model).toBe("claude-haiku-5-5");
  });

  it("session missing at start: replays the note into a new session, one exchange in the transcript", async () => {
    const { client, saves } = fakeHistory();
    configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
    const mock = createMockAgentClient({ goldens: g });
    const starts: (string | null)[] = [];
    const sends: string[] = [];
    const real = { start: mock.start, send: mock.send };
    configureAgentRuntimeForTests({
      ...mock,
      start: async (a: Parameters<AgentClient["start"]>[0]) => {
        starts.push(a.resumeSessionId);
        if (a.resumeSessionId) throw new Error("No conversation found with session ID");
        return real.start(a);
      },
      send: async (a: Parameters<AgentClient["send"]>[0]) => {
        sends.push(a.text);
        return real.send(a);
      },
    });
    get().openPane();
    await get().openSavedChat("saved-1");
    await get().sendMessage("continue please");
    expect(starts).toEqual(["sess-9", null]);
    expect(client.replay).toHaveBeenCalledWith("saved-1");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatch(/^\[Resumed from notes\] earlier text\n\ncontinue please$/);
    // the visible message and the note hold only what the user typed
    expect(chat().turns).toHaveLength(3);
    expect(chat().turns[2]!.user?.text).toBe("continue please");
    expect(chat().resumeSessionId).toBeNull();
    await mock.idle("saved-1");
    await vi.waitFor(() => expect(saves.length).toBeGreaterThan(0));
    await settle(10);
    const doc = parseChatNote(saves[saves.length - 1]!.markdown);
    expect(doc.messages.filter((m) => m.text === "continue please")).toHaveLength(1);
  });

  it("session missing reported by the CLI after start (error event) recovers the same way", async () => {
    const { client } = fakeHistory();
    configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
    const mock = createMockAgentClient({ goldens: g });
    const sends: string[] = [];
    configureAgentRuntimeForTests({
      ...mock,
      send: async (a: Parameters<AgentClient["send"]>[0]) => {
        sends.push(a.text);
      },
    });
    get().openPane();
    await get().openSavedChat("saved-1");
    await get().sendMessage("hello again");
    expect(get().resuming["saved-1"]).toBe(true);
    act(() =>
      get().ingest(
        "saved-1",
        [
          {
            type: "error",
            kind: "api",
            message: "No conversation found with session ID: sess-9",
            retryable: false,
          },
          {
            type: "turn-finished",
            reason: "error",
            durationMs: 1,
            apiDurationMs: null,
            numTurns: 0,
            isError: true,
            result: null,
            sessionId: null,
            errors: [],
          },
        ] as AgentEvent[],
        1,
      ),
    );
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[0]).toBe("hello again");
    expect(sends[1]).toMatch(/^\[Resumed from notes\] earlier text\n\nhello again$/);
    expect(
      chat().turns.filter(
        (t: ReturnType<typeof chat>["turns"][number]) => t.user?.text === "hello again",
      ),
    ).toHaveLength(1);
    expect(chat().error).toBeNull();
    expect(get().resuming["saved-1"]).toBe(false);
  });
});

describe("pane width setting and defaults", () => {
  it("the schema is the one source of defaults", () => {
    expect(agentSettingDefault("agent.permission-mode")).toBe("manual");
    expect(agentSettingDefault("agent.pane-width")).toBe(AGENT_PANE_DEFAULT_WIDTH);
    expect(agentSettingDefault("agent.chats-keep-days")).toBe(0);
    expect(agentSettingsFrom({}).permissionMode).toBe("manual");
    expect(agentSettingsFrom({ "agent.model": " opus " }).model).toBe("opus");
    expect(
      agentSettingsFrom({ "agent.effort": "high", "agent.disallowed-tools": ["Bash(rm:*)"] }),
    ).toMatchObject({
      effort: "high",
      disallowedTools: ["Bash(rm:*)"],
    });
  });

  it("adopts the setting, clamps it and saves a change through the settings store", () => {
    resetStore();
    const setSetting = vi
      .spyOn(useSettingsStore.getState(), "setSetting")
      .mockResolvedValue(undefined);
    useSettingsStore.setState({ setSetting });
    usePaneStore.getState().syncWidth(500);
    expect(usePaneStore.getState().width).toBe(500);
    usePaneStore.getState().syncWidth(5000);
    expect(usePaneStore.getState().width).toBe(900);
    usePaneStore.getState().syncWidth("wide");
    expect(usePaneStore.getState().width).toBe(900);
    usePaneStore.getState().setWidth(600, false);
    expect(setSetting).not.toHaveBeenCalled();
    usePaneStore.getState().persistWidth();
    expect(setSetting).toHaveBeenCalledWith("agent.pane-width", 600);
  });
});

describe("pane open/closed state", () => {
  const spySetting = () => {
    const setSetting = vi.fn(async () => undefined);
    useSettingsStore.setState({ setSetting });
    return setSetting;
  };

  it("persists on toggle, open and close, once per change", () => {
    resetStore();
    const setSetting = spySetting();
    get().togglePane();
    expect(setSetting).toHaveBeenLastCalledWith("agent.pane-open", true);
    get().openPane();
    expect(setSetting).toHaveBeenCalledTimes(1);
    get().closePane();
    expect(setSetting).toHaveBeenLastCalledWith("agent.pane-open", false);
    get().togglePane();
    get().togglePane();
    expect(setSetting).toHaveBeenLastCalledWith("agent.pane-open", false);
    expect(setSetting).toHaveBeenCalledTimes(4);
  });

  it("restores open (with a chat tab) and closed, without writing back or spawning", () => {
    resetStore();
    const setSetting = spySetting();
    const start = vi.fn();
    configureAgentRuntimeForTests({ ...createMockAgentClient({ goldens: g }), start });
    usePaneStore.getState().syncOpen(true);
    expect(usePaneStore.getState().open).toBe(true);
    expect(get().order).toHaveLength(1);
    usePaneStore.getState().syncOpen(false);
    expect(usePaneStore.getState().open).toBe(false);
    usePaneStore.getState().syncOpen("yes");
    expect(usePaneStore.getState().open).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("the imperative API calls go through the same write path", () => {
    resetStore();
    const setSetting = spySetting();
    startNewAgentChat();
    expect(usePaneStore.getState().open).toBe(true);
    expect(setSetting).toHaveBeenLastCalledWith("agent.pane-open", true);
    closeAgentPane();
    expect(setSetting).toHaveBeenLastCalledWith("agent.pane-open", false);
    openAgentHistory();
    expect(usePaneStore.getState().open).toBe(true);
    expect(get().view).toBe("history");
    expect(setSetting).toHaveBeenLastCalledWith("agent.pane-open", true);
    expect(setSetting).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------------------------
describe("history and project home in the pane", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
    hoisted.invoke.mockReset();
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:agent|agent_list_chats") return [SUMMARY];
      if (cmd === "plugin:agent|agent_load_chat")
        return { summary: SUMMARY, markdown: serializeChatNote(NOTE_DOC()) };
      return undefined;
    });
    configureChatPersistenceForTests({ reload: async () => false });
    configureAgentRuntimeForTests(createMockAgentClient({ goldens: g }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const flush = async (ms = 0) =>
    act(async () => void (await new Promise((r) => setTimeout(r, ms))));

  it("History shows the saved chats; choosing one opens its transcript in the chat view", async () => {
    act(() => get().openPane());
    act(() => get().setView("history"));
    await act(async () => root.render(<AgentPane />));
    await flush(10);
    expect(container.querySelector("[data-agent-slot=history]")).not.toBeNull();
    const row = [...container.querySelectorAll<HTMLElement>("button")].find((b) =>
      b.textContent?.includes("Plan the review"),
    );
    expect(row).toBeDefined();
    await act(async () => row!.click());
    await flush(10);
    expect(get().view).toBe("chat");
    expect(get().activeChatId).toBe("saved-1");
    expect(container.querySelectorAll("[data-agent-user-turn]")).toHaveLength(2);
    expect(container.textContent).toContain("the answer");
    expect(container.textContent).toContain("[[Plan]], #client");
  });

  it("the header History button switches to the history view", async () => {
    act(() => get().openPane());
    await act(async () => root.render(<AgentPane />));
    const btn = container.querySelector<HTMLElement>(
      "[data-agent-header] button[aria-label='Chat history']",
    )!;
    act(() => btn.click());
    expect(get().view).toBe("history");
    const pane = container.querySelector("[data-agent-pane]")!;
    act(
      () =>
        void pane.dispatchEvent(
          new KeyboardEvent("keydown", { key: "h", metaKey: true, shiftKey: true, bubbles: true }),
        ),
    );
    expect(get().view).toBe("history");
  });

  it("the project home lists the project's saved chats and opens one", async () => {
    const { client } = fakeHistory();
    await act(async () =>
      root.render(<ProjectRecentChats projectPath="Projects/Demo" client={client} />),
    );
    await flush();
    expect(client.list).toHaveBeenCalledWith({ projectPath: "Projects/Demo" });
    const row = container.querySelector<HTMLElement>("[data-agent-recent-chats] button")!;
    expect(row.textContent).toBe("Plan the review");
    act(() => get().openPane());
    await act(async () => row.click());
    await flush(10);
    expect(get().activeChatId).toBe("saved-1");
  });

  it("says so when there are none or the list fails", async () => {
    const empty = fakeHistory({ list: vi.fn(async () => []) }).client;
    await act(async () => root.render(<ProjectRecentChats projectPath="P" client={empty} />));
    await flush();
    expect(container.textContent).toContain("No chats yet.");
    const bad = fakeHistory({
      list: vi.fn(async () => {
        throw new Error("nope");
      }),
    }).client;
    await act(async () => root.render(<ProjectRecentChats projectPath="Q" client={bad} />));
    await flush();
    expect(container.querySelector("[role=alert]")!.textContent).toContain("nope");
  });
});
