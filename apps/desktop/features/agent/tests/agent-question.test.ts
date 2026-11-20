// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import {
  emptyMeta,
  foldAssistantEvents,
  parseChatNote,
  serializeChatNote,
} from "@features/agent/web/lib/chat-note";
import type { AgentEvent, Question } from "@features/agent/web/lib/events";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  answerOf,
  emptyDraft,
  isComplete,
  nextOpen,
  setOther,
  toAnswers,
  toggleOption,
  toggleOther,
} from "@features/agent/web/lib/question-answers";
import {
  appendSteer,
  appendUserTurn,
  createChat,
  reduceEvent,
  reduceEvents,
} from "@features/agent/web/lib/reduce";
import { segmentTurn } from "@features/agent/web/lib/timeline";
import type { ToolBlock } from "@features/agent/web/lib/transcript";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

const Q: Question[] = [
  {
    question: "Color?",
    header: "Color",
    multiSelect: false,
    options: [
      { label: "Red", description: "warm" },
      { label: "Blue", description: "cool", preview: "#00f" },
    ],
  },
  {
    question: "Fruit?",
    header: "Fruit",
    multiSelect: true,
    options: [
      { label: "Apple", description: "" },
      { label: "Fig", description: "" },
    ],
  },
];

const ev = (e: unknown) => e as AgentEvent;
const started = ev({
  type: "tool-call-started",
  messageId: "m",
  toolCallId: "t1",
  tool: "AskUserQuestion",
  parentToolCallId: null,
});
const request = ev({ type: "question-request", requestId: "q1", toolCallId: "t1", questions: Q });
const resolved = (resolution: string, answers: unknown[] = []) =>
  ev({ type: "question-resolved", requestId: "q1", toolCallId: "t1", resolution, answers });

const asking = () =>
  reduceEvents(
    appendUserTurn(createChat("c"), { messageId: "u", text: "ask", context: [] }, 0, true),
    [started, request],
    1,
  );
const block = (chat: ReturnType<typeof createChat>) =>
  chat.turns[0]!.blocks.find((b): b is ToolBlock => b.kind === "tool")!;

describe("question answers (pure)", () => {
  it("a single choice replaces, a multi-select toggles, Other is one more answer", () => {
    let d = toggleOption(Q[0]!, emptyDraft(), 0);
    d = toggleOption(Q[0]!, d, 1);
    expect(answerOf(Q[0]!, d)).toEqual(["Blue"]);
    d = setOther(Q[0]!, d, " mine ");
    expect(answerOf(Q[0]!, d)).toEqual(["mine"]);

    let m = toggleOption(Q[1]!, emptyDraft(), 1);
    m = toggleOption(Q[1]!, m, 0);
    m = setOther(Q[1]!, m, "pear");
    expect(answerOf(Q[1]!, m)).toEqual(["Apple", "Fig", "pear"]);
    m = toggleOption(Q[1]!, m, 0);
    expect(answerOf(Q[1]!, m)).toEqual(["Fig", "pear"]);
    m = setOther(Q[1]!, m, "");
    expect(answerOf(Q[1]!, m)).toEqual(["Fig"]);
    expect(answerOf(Q[1]!, toggleOther(Q[1]!, emptyDraft()))).toEqual([]);
  });

  it("is complete only when every question has an answer, and finds the next open one", () => {
    const a = toggleOption(Q[0]!, emptyDraft(), 0);
    expect(isComplete(Q, [a, emptyDraft()])).toBe(false);
    expect(nextOpen(Q, [a, emptyDraft()], 0)).toBe(1);
    const b = toggleOption(Q[1]!, emptyDraft(), 0);
    expect(isComplete(Q, [a, b])).toBe(true);
    expect(nextOpen(Q, [a, b], 0)).toBeNull();
    expect(toAnswers(Q, [a, b])).toEqual([
      { question: "Color?", answers: ["Red"] },
      { question: "Fruit?", answers: ["Apple"] },
    ]);
  });
});

describe("reducer: the question card", () => {
  it("opens on the tool call, the chat waits for the user, no permission card", () => {
    const chat = asking();
    expect(block(chat).question).toMatchObject({ requestId: "q1", status: "pending", answers: [] });
    expect(block(chat).status).toBe("waiting");
    expect(chat.state).toBe("awaiting-permission");
    expect(chat.pendingPermissions).toEqual([]);
  });

  it("answered: the card keeps the answers and the chat runs again", () => {
    const answers = [{ question: "Color?", answers: ["Red"] }];
    const chat = reduceEvent(asking(), resolved("answered", answers), 2);
    expect(block(chat).question).toMatchObject({ status: "answered", answers });
    expect(block(chat).status).toBe("running");
    expect(chat.state).toBe("running");
  });

  it("skipped and cancelled end the card; cancelled interrupts the call", () => {
    expect(block(reduceEvent(asking(), resolved("skipped"), 2)).question?.status).toBe("skipped");
    const c = reduceEvent(asking(), resolved("cancelled"), 2);
    expect(block(c).question?.status).toBe("cancelled");
    expect(block(c).status).toBe("interrupted");
    expect(c.state).toBe("running");
  });

  it("a steer, the turn's end or the CLI's own result clears an open card", () => {
    const steered = appendSteer(asking(), { messageId: "s", text: "x", context: [] }, 5);
    expect(block(steered).question?.status).toBe("cancelled");
    expect(steered.state).toBe("running");

    const ended = reduceEvent(
      asking(),
      ev({
        type: "turn-finished",
        reason: "interrupted",
        durationMs: 1,
        apiDurationMs: null,
        numTurns: 1,
        isError: false,
        result: null,
        sessionId: null,
        errors: [],
      }),
      3,
    );
    expect(block(ended).question?.status).toBe("cancelled");
    expect(ended.state).toBe("idle");

    const finished = reduceEvent(
      asking(),
      ev({
        type: "tool-call-finished",
        toolCallId: "t1",
        output: "done",
        isError: false,
        outcome: "ok",
        truncated: false,
      }),
      3,
    );
    expect(block(finished).question?.status).toBe("cancelled");
    expect(finished.state).toBe("running");
  });

  it("a question stays a question next to an open permission card", () => {
    let chat = asking();
    chat = reduceEvent(
      chat,
      ev({
        type: "permission-request",
        requestId: "p1",
        toolCallId: null,
        tool: "Bash",
        displayName: null,
        input: {},
        description: null,
        decisionReason: null,
        suggestions: [],
      }),
    );
    chat = reduceEvent(chat, resolved("answered", []), 2);
    expect(chat.state).toBe("awaiting-permission");
  });

  it("the captured stream (answered, skipped) opens the card and ends with the tool result", () => {
    for (const name of ["question-answered", "question-skipped"]) {
      const chat = reduceEvents(
        appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, false),
        goldens[name]!,
        10,
      );
      const b = chat.turns[0]!.blocks.find((x): x is ToolBlock => x.kind === "tool")!;
      expect(b.question?.questions).toHaveLength(name === "question-answered" ? 2 : 2);
      expect(b.question?.questions[1]?.multiSelect).toBe(true);
      expect(chat.state).toBe("idle");
    }
  });
});

describe("timeline and the chat note", () => {
  it("a question is its own segment, never inside a tool group", () => {
    const segments = segmentTurn(asking().turns[0]!);
    expect(segments.map((s) => s.kind)).toEqual(["question"]);
  });

  it("the answers are saved in the note and come back as the answered summary", () => {
    const answers = [{ question: "Color?", answers: ["Blue"] }];
    const fold = foldAssistantEvents([
      started,
      ev({ type: "tool-call-input", toolCallId: "t1", input: { questions: [] } }),
      request,
      resolved("answered", answers),
    ]);
    expect(fold.tools[0]!.ask).toEqual({ status: "answered", answers });

    const meta = emptyMeta("c", 0);
    const doc = {
      meta,
      messages: [
        { role: "user" as const, id: "u", at: 0, text: "ask" },
        {
          role: "assistant" as const,
          id: "a",
          at: 1,
          text: "",
          tools: fold.tools,
        },
      ],
      trimmed: 0,
      extraFrontmatter: "",
    };
    const back = parseChatNote(serializeChatNote(doc as never));
    const chat = chatFromNote(back, { projectPath: null });
    const b = chat.turns[0]!.blocks.find((x): x is ToolBlock => x.kind === "tool")!;
    expect(b.question).toMatchObject({ requestId: null, status: "answered", answers });
    expect(segmentTurn(chat.turns[0]!).some((s) => s.kind === "question")).toBe(true);
  });
});

describe("store: answering", () => {
  let mock: ReturnType<typeof createMockAgentClient>;
  beforeEach(() => {
    mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    configureAgentRuntimeForTests(mock);
    useAgentStore.setState({ chats: {}, order: [], activeChatId: null });
  });

  it("sends the answers (or null to skip) for the active chat", async () => {
    useAgentStore.getState().openPane();
    const chatId = useAgentStore.getState().activeChatId!;
    const spy = vi.spyOn(mock, "answerQuestion");
    const answers = [{ question: "Color?", answers: ["Red"] }];
    await useAgentStore.getState().answerQuestion("q1", answers);
    await useAgentStore.getState().answerQuestion("q2", null);
    expect(spy).toHaveBeenNthCalledWith(1, { chatId, requestId: "q1", answers });
    expect(spy).toHaveBeenNthCalledWith(2, { chatId, requestId: "q2", answers: null });
  });

  it("shows the error when the backend refuses (already resolved)", async () => {
    useAgentStore.getState().openPane();
    vi.spyOn(mock, "answerQuestion").mockRejectedValue(new Error("unknown or already resolved"));
    await useAgentStore.getState().answerQuestion("q1", null);
    const s = useAgentStore.getState();
    expect(s.chats[s.activeChatId!]!.error?.message).toContain("already resolved");
  });
});
