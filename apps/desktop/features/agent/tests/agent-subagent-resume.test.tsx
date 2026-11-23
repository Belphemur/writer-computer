// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { Transcript } from "@features/agent/web/components/transcript";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import {
  applySubagentEvent,
  callsOfRun,
  foldAssistantEvents,
  parseChatNote,
  serializeChatNote,
  emptyMeta,
  type ChatNoteDoc,
} from "@features/agent/web/lib/chat-note";
import type { AgentEvent } from "@features/agent/web/lib/events";
import { appendUserTurn, createChat, reduceEvent } from "@features/agent/web/lib/reduce";
import {
  runParts,
  splitRuns,
  subagentElapsed,
  subagentModel,
  subagentState,
  subagentSummary,
  trayRuns,
} from "@features/agent/web/lib/subagents";
import type { Chat } from "@features/agent/web/lib/transcript";
import { useSettingsStore } from "@/stores/settings-store";
import { newNoteState, recordEvents, recordSend } from "@features/agent/web/lib/chat-persist";
import { goldens } from "./helpers/agent-goldens";
import { withRunnerStarts } from "./helpers/agent-subagents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const call = (id: string, tool: string, parent: string | null): AgentEvent => ({
  type: "tool-call-started",
  toolCallId: id,
  messageId: `m-${id}`,
  tool,
  parentToolCallId: parent,
});
const status = (
  s: "running" | "completed" | "interrupted",
  report: string | null = null,
): AgentEvent => ({ type: "subagent-status", toolCallId: "a1", status: s, report });

/** Launch, one call, end (report one), resume, one call, end (report two): the clock in seconds. */
const STEPS: [AgentEvent, number][] = [
  [call("a1", "Agent", null), 0],
  [{ type: "tool-call-input", toolCallId: "a1", input: { subagent_type: "general-purpose" } }, 0],
  [
    {
      type: "subagent-started",
      toolCallId: "a1",
      role: null,
      name: "general-purpose",
      model: null,
    },
    0,
  ],
  [status("running"), 1000],
  [call("r1", "Read", "a1"), 1500],
  [status("completed", "report one"), 5000],
  [status("running"), 9000],
  [call("r2", "Read", "a1"), 9100],
  [status("completed", "report two"), 12000],
];

function replay(upTo = STEPS.length): Chat {
  let chat = appendUserTurn(createChat("c"), { messageId: "u", text: "go", context: [] }, 0, true);
  for (const [ev, now] of STEPS.slice(0, upTo)) chat = reduceEvent(chat, ev, now);
  return chat;
}
const runOf = (chat: Chat) => splitRuns(chat.turns[0]!).runs.get("a1")!;

describe("a resumed sub-agent run in the reducer", () => {
  it("goes back to running after any final state, then to its next end", () => {
    expect(subagentState(runOf(replay(6)))).toBe("done");
    expect(subagentState(runOf(replay(7)))).toBe("running");
    expect(subagentState(runOf(replay()))).toBe("done");
    for (const end of ["failed", "stopped", "interrupted"] as const) {
      let chat = replay(5);
      chat = reduceEvent(
        chat,
        { ...(status("completed") as object), status: end } as AgentEvent,
        5000,
      );
      expect(subagentState(runOf(chat))).toBe(end);
      chat = reduceEvent(chat, status("running"), 6000);
      expect(subagentState(runOf(chat))).toBe("running");
    }
  });

  it("sums the time of every run and keeps each run's report", () => {
    const run = runOf(replay());
    // 0 (the launch) -> 5000, then 9000 -> 12000
    expect(subagentElapsed(run, 99999)).toBe(5000 + 3000);
    expect(subagentSummary(run)).toBe("report two");
    expect(run.meta!.resumes).toEqual([{ at: 1, report: "report one", ms: 5000 }]);
    // while it runs again the time goes on from the resume
    expect(subagentElapsed(runOf(replay(7)), 10000)).toBe(5000 + 1000);
  });

  it("puts the divider where the run restarted, with the earlier report at it", () => {
    const parts = runParts(runOf(replay()));
    expect(parts).toHaveLength(2);
    expect(parts[0]!.resume).toBeNull();
    expect(parts[0]!.blocks.map((b) => b.id)).toEqual(["r1"]);
    expect(parts[1]!.resume?.report).toBe("report one");
    expect(parts[1]!.blocks.map((b) => b.id)).toEqual(["r2"]);
    expect(runParts({ ...runOf(replay(6)) })).toHaveLength(1);
  });

  it("is in the tray again while it works", () => {
    expect(trayRuns(replay(6)).map((r) => r.state)).toEqual(["done"]);
    expect(trayRuns(replay(7)).map((r) => r.state)).toEqual(["running"]);
  });

  it("replays the golden resumed background run: running, done, running, done", () => {
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    const seen: string[] = [];
    for (const [i, ev] of withRunnerStarts(goldens["subagent-resume"]!).entries()) {
      chat = reduceEvent(chat, ev, 1000 + i * 10);
      const run = splitRuns(chat.turns[0]!).runs.get("toolu_real1");
      const s = run && subagentState(run);
      if (s && seen[seen.length - 1] !== s) seen.push(s);
    }
    expect(seen).toEqual(["running", "done", "running", "done"]);
    const run = splitRuns(chat.turns[0]!).runs.get("toolu_real1")!;
    expect(run.meta!.resumes).toHaveLength(1);
    expect(runParts(run)[1]!.blocks[0]).toMatchObject({ id: "toolu_resume2" });
  });
});

describe("the model a sub-agent really ran on", () => {
  it("is stored by the reducer and wins over the tier, the latest one after a resume", () => {
    let chat = replay(4);
    expect(subagentModel(runOf(chat))).toBeNull();
    chat = reduceEvent(
      chat,
      { type: "subagent-model", toolCallId: "a1", model: "claude-haiku-5-5" },
      2000,
    );
    expect(subagentModel(runOf(chat))).toBe("claude-haiku-5-5");
    chat = reduceEvent(
      chat,
      { type: "subagent-model", toolCallId: "a1", model: "claude-opus-5-5" },
      3000,
    );
    expect(subagentModel(runOf(chat))).toBe("claude-opus-5-5");
    // a tier is what was asked for: the real model is preferred
    chat.turns[0]!.subagents!.a1!.model = "sonnet";
    expect(subagentModel(runOf(chat))).toBe("claude-opus-5-5");
  });
});

describe("the chat note keeps the resumes, the reports and the model", () => {
  const events: AgentEvent[] = [
    ...STEPS.slice(0, 3).map(([e]) => e),
    { type: "subagent-model", toolCallId: "a1", model: "claude-haiku-5-5" },
    ...STEPS.slice(3).map(([e]) => e),
    { type: "subagent-model", toolCallId: "a1", model: "claude-opus-5-5" },
  ];
  const doc = (tools: ReturnType<typeof foldAssistantEvents>["tools"]): ChatNoteDoc => ({
    meta: { ...emptyMeta("c1", 0), title: "t" },
    trimmed: 0,
    extraFrontmatter: "",
    messages: [
      { role: "user", id: "u", at: 1, text: "go" },
      { role: "assistant", id: "a", at: 2, text: "", reason: "completed", tools },
    ],
  });

  it("round-trips through the note text and restores the divider and both reports", () => {
    const fold = foldAssistantEvents(events);
    const sub = fold.tools.find((t) => t.id === "a1")!.sub!;
    expect(sub).toMatchObject({
      status: "completed",
      summary: "report two",
      ranOn: "claude-opus-5-5",
      resumes: [{ at: 1, summary: "report one" }],
    });
    const parsed = parseChatNote(serializeChatNote(doc(fold.tools)))!;
    const chat = chatFromNote(parsed, { projectPath: null });
    const run = splitRuns(chat.turns[chat.turns.length - 1]!).runs.get("a1")!;
    expect(subagentState(run)).toBe("done");
    expect(subagentSummary(run)).toBe("report two");
    expect(subagentModel(run)).toBe("claude-opus-5-5");
    const parts = runParts(run);
    expect(parts[1]!.resume).toMatchObject({ at: 1, report: "report one", ms: null });
    expect(parts.map((p) => p.blocks.map((b) => b.id))).toEqual([["r1"], ["r2"]]);
  });

  it("reads an older note, with no resumes and no model, as before", () => {
    const old = doc([
      {
        id: "a1",
        tool: "Agent",
        input: {},
        outcome: "ok",
        sub: { role: "worker", name: "w", model: "sonnet", status: "completed", summary: "done" },
      },
      { id: "r1", tool: "Read", input: {}, outcome: "ok", parent: "a1" },
    ]);
    const chat = chatFromNote(parseChatNote(serializeChatNote(old))!, { projectPath: null });
    const run = splitRuns(chat.turns[chat.turns.length - 1]!).runs.get("a1")!;
    expect(subagentState(run)).toBe("done");
    expect(subagentModel(run)).toBe("sonnet");
    expect(runParts(run)).toHaveLength(1);
    expect(run.meta!.resumes).toBeUndefined();
  });
});

describe("the card of a resumed run", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useSettingsStore.setState({ settings: {} });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const mount = async (chat: Chat) => act(async () => root.render(<Transcript chat={chat} />));
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel);

  it("says Done with the summed time and the real model, and has a Resumed divider with the earlier report", async () => {
    let chat = replay();
    chat = reduceEvent(
      chat,
      { type: "subagent-model", toolCallId: "a1", model: "claude-opus-5-5" },
      12000,
    );
    await mount(chat);
    expect($("[data-agent-subagent-status]")!.textContent).toBe("Done");
    expect($("[data-agent-subagent-elapsed]")!.textContent).toBe("· 8s");
    expect($("[data-agent-subagent-model]")!.textContent).toBe("Opus 5.5");
    expect($("[data-agent-subagent-summary]")!.textContent).toBe("report two");
    expect($("[data-agent-subagent-resumed]")).toBeNull();
    act(() => $("button[aria-expanded]")!.click());
    const divider = $("[data-agent-subagent-resumed]")!;
    expect(divider.textContent).toContain("Resumed");
    expect($("[data-agent-subagent-earlier-report]")).toBeNull();
    act(() => divider.querySelector<HTMLButtonElement>("button")!.click());
    expect($("[data-agent-subagent-earlier-report]")!.textContent).toBe("report one");
  });

  it("keeps the card mounted while it works again: Running, live summed time, earlier calls, divider, then the new calls", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(11000);
      let chat = replay(7);
      chat = reduceEvent(chat, call("r2", "Read", "a1"), 9100);
      await mount(chat);
      expect($("[data-agent-subagent]")!.getAttribute("data-state")).toBe("running");
      expect($("[data-agent-subagent-status]")!.textContent).toBe("Running");
      // 0 -> 5000 before, 9000 -> now (11000) after
      expect($("[data-agent-subagent-elapsed]")!.textContent).toBe("· 7s");
      expect($("[data-agent-subagent-summary]")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect($("[data-agent-subagent-elapsed]")!.textContent).toBe("· 9s");
      act(() => $("button[aria-expanded]")!.click());
      expect($("[data-agent-subagent-resumed]")).not.toBeNull();
      expect(
        container.querySelectorAll("[data-agent-group], [data-agent-tool]").length,
      ).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shows a card for a first run that works (the tray has it)", async () => {
    await mount(replay(5));
    expect($("[data-agent-subagent]")).toBeNull();
  });

  it("says No activity recorded when every part is empty", async () => {
    const chat = replay();
    // a restored note that kept no calls of the run
    chat.turns[0]!.blocks = chat.turns[0]!.blocks.filter(
      (b) => !("parentToolCallId" in b && b.parentToolCallId === "a1"),
    );
    await mount(chat);
    act(() => $("button[aria-expanded]")!.click());
    expect(container.textContent).toContain("No activity recorded.");
  });
});

describe("the golden resumed background run through the real persist path", () => {
  const events = () => withRunnerStarts(goldens["subagent-resume"]!);

  const live = () => {
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    for (const [i, e] of events().entries()) chat = reduceEvent(chat, e, 1000 + i * 10);
    return chat;
  };

  /** The events as the pane records them: a send, then every event, written at each turn end. */
  const restored = () => {
    let note = recordSend(newNoteState("c1", null, 0), {
      messageId: "u",
      text: "go",
      context: [],
      ts: 1,
    } as never);
    for (const e of events()) note = recordEvents(note, [e], 5).note;
    const doc = parseChatNote(
      serializeChatNote({
        meta: note.meta,
        trimmed: 0,
        extraFrontmatter: "",
        messages: note.messages,
      }),
    )!;
    return chatFromNote(doc, { projectPath: null });
  };

  const runOfChat = (chat: Chat) => {
    for (const t of chat.turns) {
      const r = splitRuns(t).runs.get("toolu_real1");
      if (r) return r;
    }
    throw new Error("no run");
  };
  const toolIds = (blocks: readonly { kind: string; id: string }[]) =>
    blocks.filter((b) => b.kind === "tool").map((b) => b.id);

  it("restores the run's divider where the live one is, and its calls with the run", () => {
    const liveParts = runParts(runOfChat(live()));
    const backParts = runParts(runOfChat(restored()));
    expect(liveParts).toHaveLength(2);
    expect(backParts.map((p) => toolIds(p.blocks))).toEqual(
      liveParts.map((p) => toolIds(p.blocks)),
    );
    expect(backParts[1]!.blocks.length).toBeGreaterThan(0);
    expect(backParts.map((p) => p.resume !== null)).toEqual([false, true]);
  });

  it("keeps no call of the run among the main agent's in the turns after", () => {
    const chat = restored();
    const runIds = new Set(toolIds(runOfChat(chat).children));
    for (const t of chat.turns)
      for (const b of splitRuns(t).main) expect(runIds.has(b.id)).toBe(false);
    expect(runIds.has("toolu_resume2")).toBe(true);
  });
});

describe("the note's view of a resume", () => {
  const sub = (extra = {}) => ({ role: null, name: "w", model: null, ...extra });

  it("marks the earlier run as interrupted and clears the end", () => {
    const run = sub();
    applySubagentEvent(
      run,
      { type: "subagent-status", toolCallId: "a1", status: "interrupted", report: null },
      0,
    );
    expect(run).toMatchObject({ interrupted: true });
    applySubagentEvent(
      run,
      { type: "subagent-status", toolCallId: "a1", status: "running", report: null },
      3,
    );
    expect(run).toEqual(sub({ resumes: [{ at: 3, interrupted: true }] }));
  });

  it("counts a run's calls over the written messages and the turn in flight", () => {
    const tool = (id: string, parent?: string) => ({
      id,
      tool: "Read",
      input: {},
      outcome: "ok" as const,
      ...(parent ? { parent } : {}),
    });
    expect(
      callsOfRun(
        [{ tools: [tool("x", "a1"), tool("y")] }, { tools: [tool("z", "a1")] }],
        [tool("w", "a1")],
        "a1",
      ),
    ).toBe(3);
  });

  it("ignores resumes of a note that are not the shape written", () => {
    const tools = [
      {
        id: "a1",
        tool: "Agent",
        input: {},
        outcome: "ok" as const,
        sub: sub({
          status: "completed",
          resumes: [{ at: "x" }, null, { at: 2, summary: "s" }, 7] as never,
        }),
      },
    ];
    const doc: ChatNoteDoc = {
      meta: { ...emptyMeta("c1", 0), title: "t" },
      trimmed: 0,
      extraFrontmatter: "",
      messages: [
        { role: "user", id: "u", at: 1, text: "go" },
        { role: "assistant", id: "a", at: 2, text: "", reason: "completed", tools },
      ],
    };
    const chat = chatFromNote(doc, { projectPath: null });
    expect(splitRuns(chat.turns[chat.turns.length - 1]!).runs.get("a1")!.meta!.resumes).toEqual([
      { at: 2, ms: null, report: "s" },
    ]);
  });
});
