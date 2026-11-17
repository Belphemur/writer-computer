import { describe, expect, it } from "vite-plus/test";
import {
  createChat,
  appendUserTurn,
  markCancelling,
  reduceEvent,
  reduceEvents,
  titleFromText,
} from "../src/lib/agent/reduce";
import type { AgentEvent } from "../src/lib/agent/events";
import type { TextBlock, ThinkingBlock, ToolBlock } from "../src/lib/agent/transcript";
import { groupHeader, segmentTurn } from "../src/lib/agent/timeline";
import { contextTokensOf } from "../src/lib/agent/context-usage";
import { goldens } from "./helpers/agent-goldens";

const run = (name: string, now = 1000) => {
  let chat = createChat("c1");
  chat = appendUserTurn(chat, { messageId: "u1", text: "hi", context: [] }, 0, false);
  return reduceEvents(chat, goldens[name]!, now);
};
describe("reducer over the golden streams", () => {
  it("has all six goldens", () => {
    expect(Object.keys(goldens).sort()).toEqual([
      "interrupt",
      "multi-turn-rule",
      "ok-turn",
      "permission-allow",
      "permission-deny",
      "tool-auto-allowed",
    ]);
  });

  it("ok-turn: the final text replaces the deltas and the turn completes with usage", () => {
    const chat = run("ok-turn");
    const turn = chat.turns[0]!;
    const text = turn.blocks.filter((b): b is TextBlock => b.kind === "text");
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ text: "ok", final: true });
    expect(turn.status).toBe("completed");
    expect(turn.durationMs).toBe(1614);
    expect(turn.usage?.costUsd).toBeCloseTo(0.0255343);
    expect(chat.state).toBe("idle");
    expect(chat.contextWindow).toBe(1_000_000);
    expect(contextTokensOf(chat.contextUsage!)).toBe(2 + 11863 + 6076);
    expect(chat.totalCostUsd).toBeCloseTo(0.0255343);
    expect(chat.session?.model).toBe("claude-sonnet-5-5");
    expect(chat.rateLimit).toEqual({ status: "allowed", resetsAt: 1800000000 });
  });

  it("a delta stream accumulates and a later text event replaces it", () => {
    let chat = appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
    const ev = (e: Partial<AgentEvent> & { type: string }) => e as AgentEvent;
    chat = reduceEvent(
      chat,
      ev({ type: "text-delta", messageId: "m", blockIndex: 0, text: "Hel" }),
    );
    chat = reduceEvent(chat, ev({ type: "text-delta", messageId: "m", blockIndex: 0, text: "lo" }));
    const live = chat.turns[0]!.blocks[0] as TextBlock;
    expect(live).toMatchObject({ text: "Hello", final: false });
    chat = reduceEvent(chat, ev({ type: "text", messageId: "m", blockIndex: 0, text: "Hello!" }));
    expect(chat.turns[0]!.blocks[0]).toMatchObject({ text: "Hello!", final: true });
    // a stray delta after the final text is ignored
    chat = reduceEvent(chat, ev({ type: "text-delta", messageId: "m", blockIndex: 0, text: "x" }));
    expect((chat.turns[0]!.blocks[0] as TextBlock).text).toBe("Hello!");
  });

  it("tool lifecycle: started, streamed input, parsed input, finished", () => {
    const chat = run("tool-auto-allowed");
    const tool = chat.turns[0]!.blocks.find((b): b is ToolBlock => b.kind === "tool")!;
    expect(tool.hasInput).toBe(true);
    expect(tool.inputText).toBe("");
    expect(tool.status).toBe("ok");
    expect(tool.output).not.toBeNull();
    expect(chat.pendingPermissions).toEqual([]);
  });

  it("input deltas show as partial text until the parsed input arrives", () => {
    const events = goldens["permission-allow"]!;
    const cut = events.findIndex((e) => e.type === "tool-call-input");
    let chat = appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
    chat = reduceEvents(chat, events.slice(0, cut));
    const tool = chat.turns[0]!.blocks.find((b): b is ToolBlock => b.kind === "tool")!;
    expect(tool.hasInput).toBe(false);
    expect(tool.inputText).toMatch(/^\{"file_path"/);
  });

  it("permission request pauses the turn on the tool row, with the card pending", () => {
    const events = goldens["permission-allow"]!;
    const at = events.findIndex((e) => e.type === "permission-request");
    let chat = appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
    chat = reduceEvents(chat, events.slice(0, at + 1));
    expect(chat.state).toBe("awaiting-permission");
    expect(chat.pendingPermissions).toHaveLength(1);
    expect(chat.pendingPermissions[0]!.tool).toBe("Write");
    const tool = chat.turns[0]!.blocks.find((b): b is ToolBlock => b.kind === "tool")!;
    expect(tool).toMatchObject({ status: "waiting", permission: "pending" });
  });

  it("an allowed request resumes running, a cancelled one marks the row interrupted", () => {
    const events = goldens["permission-allow"]!;
    const at = events.findIndex((e) => e.type === "permission-request");
    const req = events[at] as Extract<AgentEvent, { type: "permission-request" }>;
    let chat = appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
    chat = reduceEvents(chat, events.slice(0, at + 1));
    const allowed = reduceEvent(chat, {
      type: "permission-resolved",
      requestId: req.requestId,
      resolution: "allowed",
    });
    expect(allowed.state).toBe("running");
    expect(allowed.pendingPermissions).toEqual([]);
    expect((allowed.turns[0]!.blocks.find((b) => b.kind === "tool") as ToolBlock).status).toBe(
      "running",
    );
    const cancelled = reduceEvent(chat, {
      type: "permission-resolved",
      requestId: req.requestId,
      resolution: "cancelled",
    });
    expect(cancelled.turns[0]!.blocks.find((b) => b.kind === "tool") as ToolBlock).toMatchObject({
      status: "interrupted",
      permission: "cancelled",
    });
  });

  it("permission-deny: the rejected tool result clears a card nobody resolved", () => {
    const chat = run("permission-deny");
    expect(chat.pendingPermissions).toEqual([]);
    const tool = chat.turns[0]!.blocks.find((b): b is ToolBlock => b.kind === "tool")!;
    expect(tool.status).toBe("rejected");
    expect(tool.permission).toBe("denied");
    expect(chat.turns[0]!.status).toBe("completed");
    expect(chat.state).toBe("idle");
  });

  it("interrupt: pending cards cancelled, row interrupted, turn stopped", () => {
    const chat = run("interrupt");
    const tool = chat.turns[0]!.blocks.find((b): b is ToolBlock => b.kind === "tool")!;
    expect(tool.status).toBe("interrupted");
    expect(tool.permission).toBe("cancelled");
    expect(chat.turns[0]!.status).toBe("interrupted");
    expect(chat.pendingPermissions).toEqual([]);
    expect(chat.state).toBe("idle");
  });

  it("multi-turn-rule: the repeated session-started is idempotent and the second turn is its own", () => {
    let chat = createChat("c");
    const events = goldens["multi-turn-rule"]!;
    const split = events.findIndex((e) => e.type === "turn-finished") + 1;
    chat = appendUserTurn(chat, { messageId: "u1", text: "one", context: [] }, 0, false);
    chat = reduceEvents(chat, events.slice(0, split));
    const afterFirst = chat.session;
    chat = appendUserTurn(chat, { messageId: "u2", text: "two", context: [] }, 5, true);
    chat = reduceEvents(chat, events.slice(split));
    expect(chat.turns).toHaveLength(2);
    expect(chat.turns.map((t) => t.status)).toEqual(["completed", "completed"]);
    expect(chat.turns[0]!.blocks.filter((b) => b.kind === "tool")).toHaveLength(1);
    expect(chat.turns[1]!.blocks.filter((b) => b.kind === "tool")).toHaveLength(1);
    expect(chat.session).toEqual(afterFirst);
    expect(chat.title).toBe("one");
    expect(chat.totalCostUsd).toBeCloseTo(0.0440622 + 0.1126204);
  });

  it("replaying a golden twice never duplicates blocks (idempotent session-started, tool started)", () => {
    const once = run("tool-auto-allowed");
    const twice = reduceEvents(
      once,
      goldens["tool-auto-allowed"]!.filter((e) => e.type === "tool-call-started"),
    );
    expect(twice.turns.flatMap((t) => t.blocks).filter((b) => b.kind === "tool")).toHaveLength(
      once.turns.flatMap((t) => t.blocks).filter((b) => b.kind === "tool").length,
    );
  });

  it("ignores event types it does not know", () => {
    const chat = createChat("c");
    expect(reduceEvent(chat, { type: "from-the-future" } as unknown as AgentEvent)).toBe(chat);
  });
});

describe("thinking, errors and session end", () => {
  const base = () =>
    appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
  it("times Thought for from start to end in UI time", () => {
    let chat = reduceEvent(
      base(),
      {
        type: "thinking",
        messageId: "m",
        blockIndex: 0,
        phase: "start",
        text: "",
        estimatedTokens: null,
      },
      1000,
    );
    expect((chat.turns[0]!.blocks[0] as ThinkingBlock).endedAt).toBeNull();
    chat = reduceEvent(
      chat,
      {
        type: "thinking",
        messageId: "m",
        blockIndex: 0,
        phase: "end",
        text: "",
        estimatedTokens: 42,
      },
      5200,
    );
    expect(chat.turns[0]!.blocks[0]).toMatchObject({
      startedAt: 1000,
      endedAt: 5200,
      estimatedTokens: 42,
    });
  });

  it("error kinds drive the state machine", () => {
    const err = (kind: never, retryable: boolean) =>
      reduceEvent(base(), { type: "error", kind, message: "m", retryable });
    expect(err("auth" as never, false).state).toBe("error");
    expect(err("process-exited" as never, true).state).toBe("reconnecting");
    expect(err("api" as never, true).state).toBe("running");
    expect(err("process-exited" as never, true).banner).toBe("Connection lost, resuming");
  });

  it("session-ended mid-turn after an exit reconnects; a closed session ends", () => {
    const exit = reduceEvent(base(), {
      type: "session-ended",
      reason: "exit",
      exitCode: 1,
      signal: null,
    });
    expect(exit.state).toBe("reconnecting");
    expect(exit.turns[0]!.status).toBe("error");
    const closed = reduceEvent(base(), {
      type: "session-ended",
      reason: "closed",
      exitCode: null,
      signal: null,
    });
    expect(closed.state).toBe("ended");
  });

  it("stop moves a running chat to cancelling and turn-finished returns it to idle", () => {
    const cancelling = markCancelling(base());
    expect(cancelling.state).toBe("cancelling");
    const done = reduceEvent(cancelling, {
      type: "turn-finished",
      reason: "interrupted",
      durationMs: 1,
      apiDurationMs: null,
      numTurns: 1,
      isError: true,
      result: null,
      sessionId: null,
      errors: [],
    });
    expect(done.state).toBe("idle");
    expect(done.turns[0]!.status).toBe("interrupted");
  });

  it("titles come from the first line, truncated", () => {
    expect(titleFromText("  Hello   world\nsecond")).toBe("Hello world");
    expect(titleFromText("x".repeat(60))).toHaveLength(40);
  });
});

describe("timeline grouping", () => {
  it("groups consecutive tool rows and keeps text apart", () => {
    const chat = run("tool-auto-allowed");
    const segs = segmentTurn(chat.turns[0]!);
    expect(segs.map((s) => s.kind)).toEqual(["group", "text"]);
    const g = segs[0]!;
    if (g.kind !== "group") throw new Error();
    expect(groupHeader(g.blocks, false)).toMatch(/^(Read|Ran|Listed|Searched|Used)/);
  });

  it("headers: one kind is counted, mixed kinds say Used N tools", () => {
    const mk = (tool: string) => ({ kind: "tool", tool }) as ToolBlock;
    expect(groupHeader([mk("Bash"), mk("Bash"), mk("Bash")], false)).toBe("Ran 3 commands");
    expect(groupHeader([mk("Read"), mk("Read"), mk("Read")], false)).toBe("Read 3 notes");
    expect(groupHeader([mk("Edit"), mk("Write")], false)).toBe("Edited 2 notes");
    expect(groupHeader([mk("Bash"), mk("Read")], false)).toBe("Used 2 tools");
    expect(groupHeader([mk("Bash")], true)).toBe("Running 1 command");
  });
});
