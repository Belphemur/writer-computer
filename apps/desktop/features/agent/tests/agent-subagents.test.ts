import { describe, expect, it } from "vite-plus/test";
import {
  emptyMeta,
  foldAssistantEvents,
  parseChatNote,
  serializeChatNote,
} from "@features/agent/web/lib/chat-note";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import { newNoteState, recordEvents, recordSend } from "@features/agent/web/lib/chat-persist";
import {
  appendUserTurn,
  createChat,
  reduceEvent,
  reduceEvents,
} from "@features/agent/web/lib/reduce";
import {
  splitRuns,
  subagentCounts,
  subagentElapsed,
  subagentIcon,
  subagentLabel,
  subagentState,
  subagentSummary,
  subagentTask,
  trayRuns,
} from "@features/agent/web/lib/subagents";
import { segmentTurn } from "@features/agent/web/lib/timeline";
import type { AgentEvent } from "@features/agent/web/lib/events";
import { goldens } from "./helpers/agent-goldens";
import { chatAfter, withRunnerStarts } from "./helpers/agent-subagents";
import { AGENT_ROLES, roleLabelOf } from "@features/agent/web/lib/agent-roles";

const turnOf = (chat: ReturnType<typeof chatAfter>) => chat.turns[0]!;

describe("sub-agent runs in the reducer (golden: subagent-parallel)", () => {
  const chat = chatAfter("subagent-parallel");
  const { main, runs } = splitRuns(turnOf(chat));

  it("makes one run per launch call, each holding only its own blocks", () => {
    expect([...runs.keys()]).toEqual(["toolu_ex", "toolu_wk"]);
    const kinds = (id: string) =>
      runs.get(id)!.children.map((b) => (b.kind === "tool" ? b.tool : b.kind));
    expect(kinds("toolu_ex")).toEqual(["thinking", "Grep", "Read", "text"]);
    expect(kinds("toolu_wk")).toEqual(["Read", "Edit", "text"]);
  });

  it("keeps the main agent's rows and text in the main timeline", () => {
    expect(main.map((b) => (b.kind === "tool" ? b.tool : b.kind))).toEqual([
      "text",
      "Agent",
      "Agent",
      "text",
    ]);
    const segs = segmentTurn(turnOf(chat));
    expect(segs.map((s) => s.kind)).toEqual(["text", "subagent", "subagent", "text"]);
  });

  it("stamps a sub-agent's text and thinking with its run, never the main agent's", () => {
    const texts = turnOf(chat).blocks.flatMap((b) => (b.kind === "text" ? [b] : []));
    expect(texts.map((t) => [t.text, t.parentToolCallId])).toEqual([
      ["I will hand the search and the fix to two helpers.", null],
      ["Found 2 notes: Plan.md and Pricing.md.", "toolu_ex"],
      ["Plan.md: fixed teh to the.", "toolu_wk"],
      ["Both helpers are done.", null],
    ]);
  });

  it("says who runs (role, model) from the event and how the run went", () => {
    const ex = runs.get("toolu_ex")!;
    const wk = runs.get("toolu_wk")!;
    expect([subagentLabel(ex), subagentLabel(wk)]).toEqual(["Explorer", "Worker"]);
    expect([ex.meta?.model, wk.meta?.model]).toEqual(["haiku", "sonnet"]);
    expect([subagentIcon(ex), subagentIcon(wk)]).toEqual(["search", "edit"]);
    expect([subagentState(ex), subagentState(wk)]).toEqual(["done", "done"]);
    expect(subagentTask(ex)).toBe("Find notes about pricing");
    expect(subagentSummary(wk)).toBe("Plan.md: fixed teh to the.");
  });

  it("counts tool calls, files read and edits per run", () => {
    expect(subagentCounts(runs.get("toolu_ex")!.children)).toEqual({
      toolCalls: 2,
      filesRead: 1,
      edits: 0,
    });
    expect(subagentCounts(runs.get("toolu_wk")!.children)).toEqual({
      toolCalls: 2,
      filesRead: 1,
      edits: 1,
    });
  });

  it("times a run from its start to its end", () => {
    let c = appendUserTurn(createChat("c"), { messageId: "u", text: "go", context: [] }, 0, true);
    const events = withRunnerStarts(goldens["subagent-parallel"]!);
    const at = (pred: (e: AgentEvent) => boolean) => events.findIndex(pred);
    const started = at((e) => e.type === "subagent-started" && e.toolCallId === "toolu_ex");
    const done = at((e) => e.type === "tool-call-finished" && e.toolCallId === "toolu_ex");
    c = reduceEvents(c, events.slice(0, started + 1), 1_000);
    c = reduceEvents(c, events.slice(started + 1, done + 1), 4_500);
    const ex = splitRuns(c.turns[0]!).runs.get("toolu_ex")!;
    expect(subagentElapsed(ex, 99_999)).toBe(3_500);
  });

  it("leaves a turn with no sub-agent exactly as it was", () => {
    const plain = chatAfter("tool-auto-allowed");
    expect(segmentTurn(plain.turns[0]!).every((s) => s.kind !== "subagent")).toBe(true);
    expect(plain.turns[0]!.subagents).toBeUndefined();
  });
});

describe("running, waiting and parallel runs", () => {
  it("shows both runs running at once, each with its own rows, before either finishes", () => {
    const chat = chatAfter("subagent-parallel", {
      until: (e) => e.type === "tool-call-finished" && e.toolCallId === "toolu_e_grep",
    });
    const { runs } = splitRuns(turnOf(chat));
    expect([...runs.values()].map(subagentState)).toEqual(["running", "running"]);
    expect(runs.get("toolu_ex")!.children).toHaveLength(2); // thinking + Grep so far
    expect(runs.get("toolu_wk")!.children).toHaveLength(1); // Read
  });

  it("ends a background run by its notification and its own report, not by its launch result", () => {
    const events = withRunnerStarts(goldens["subagent-background"]!);
    const launchResult = events.findIndex(
      (e) => e.type === "tool-call-finished" && e.toolCallId === "toolu_agent1",
    );
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    chat = reduceEvents(chat, events.slice(0, launchResult + 1), 100);
    let run = splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!;
    expect(run.launch.status).toBe("ok");
    expect(run.launch.output).toBe(""); // the launch boilerplate never reaches the transcript
    expect(subagentState(run)).toBe("running");
    expect(subagentSummary(run)).toBe("");
    chat = reduceEvents(chat, events.slice(launchResult + 1), 900);
    run = splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!;
    expect(subagentState(run)).toBe("done");
    expect(subagentElapsed(run, 5_000)).toBe(800);
    expect(subagentSummary(run)).toBe("The note now says new line added.");
    expect(JSON.stringify(chat)).not.toMatch(/Async agent|agentId|output_file/);
    // the late edit joined the run, not the main timeline
    expect(run.children.map((b) => b.kind === "tool" && b.tool)).toContain("Write");
  });

  it("applies a late status after its turn closed, without opening a turn", () => {
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    const events = withRunnerStarts(goldens["subagent-background"]!);
    const finished = events.findIndex((e) => e.type === "turn-finished");
    chat = reduceEvents(chat, events.slice(0, finished + 1), 100);
    expect(splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!.meta?.status).toBe("running");
    const turns = chat.turns.length;
    chat = reduceEvent(chat, {
      type: "subagent-status",
      toolCallId: "toolu_agent1",
      status: "completed",
      report: null,
    });
    expect(chat.turns).toHaveLength(turns);
    expect(subagentState(splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!)).toBe("done");
  });

  it("marks a run that never reported its end interrupted when the process goes away", () => {
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    const events = withRunnerStarts(goldens["subagent-background"]!);
    chat = reduceEvents(
      chat,
      events.slice(0, events.findIndex((e) => e.type === "turn-finished") + 1),
      100,
    );
    chat = reduceEvent(
      chat,
      { type: "session-ended", reason: "killed", exitCode: null, signal: null },
      200,
    );
    expect(subagentState(splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!)).toBe("interrupted");
  });

  it("keeps the chat's own model after a turn whose sub-agents ran on another one", () => {
    // Rust names the main agent's model on the turn's usage (a sub-agent's never decides it);
    // a sub-agent's model stays on its card
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    const events = withRunnerStarts(goldens["subagent-parallel"]!).map((e) =>
      e.type === "usage" && e.scope === "turn" ? { ...e, model: "claude-opus-5-5" } : e,
    );
    chat = reduceEvents(chat, events, 100);
    expect(chat.reportedModel).toBe("claude-opus-5-5");
  });

  it("shows a run cut off by a restart as interrupted, running again when resumed, done on its end", () => {
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    const events = withRunnerStarts(goldens["subagent-background"]!);
    chat = reduceEvents(
      chat,
      events.slice(0, events.findIndex((e) => e.type === "turn-finished") + 1),
      100,
    );
    const status = (s: "running" | "interrupted" | "completed"): AgentEvent => ({
      type: "subagent-status",
      toolCallId: "toolu_agent1",
      status: s,
      report: null,
    });
    const state = () => subagentState(splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!);
    chat = reduceEvent(chat, status("interrupted"), 200);
    expect(state()).toBe("interrupted");
    chat = reduceEvent(chat, status("running"), 300);
    expect(state()).toBe("running");
    chat = reduceEvent(chat, status("completed"), 400);
    expect(state()).toBe("done");
    // a finished run works again when Rust says so (a child event after its end, a resume)
    chat = reduceEvent(chat, status("running"), 500);
    expect(state()).toBe("running");
  });

  it("keeps a background run running when its turn ends, and the next send does not end it", () => {
    const events = withRunnerStarts(goldens["subagent-background"]!);
    const finished = events.findIndex((e) => e.type === "turn-finished");
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    chat = reduceEvents(chat, events.slice(0, finished + 1), 100);
    const run = () => splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!;
    expect(subagentState(run())).toBe("running");
    chat = appendUserTurn(chat, { messageId: "u2", text: "meanwhile", context: [] }, 500, true);
    expect(subagentState(run())).toBe("running");
    expect(trayRuns(chat).map((r) => r.id)).toEqual(["toolu_agent1"]);
  });

  it("follows a run the CLI moved to the background by itself (no flag in the call)", () => {
    const events = withRunnerStarts(goldens["subagent-auto-background"]!);
    const launchResult = events.findIndex(
      (e) => e.type === "tool-call-finished" && e.toolCallId === "toolu_agent1",
    );
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    chat = reduceEvents(chat, events.slice(0, launchResult + 1), 100);
    let run = splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!;
    expect(subagentState(run)).toBe("running");
    expect(subagentCounts(run.children).toolCalls).toBe(1);
    chat = reduceEvents(chat, events.slice(launchResult + 1), 900);
    run = splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!;
    expect(subagentState(run)).toBe("done");
    expect(subagentCounts(run.children).toolCalls).toBe(3); // calls after the launch result counted
    expect(subagentSummary(run)).toBe("Both notes read: one, two.");
    expect(JSON.stringify(chat)).not.toMatch(/Async agent|agentId|a1b2c3|output_file/);
  });

  it("starts a run again on a running word after its end (a resume, Rust's word only)", () => {
    let chat = chatAfter("subagent-parallel");
    chat = reduceEvent(chat, {
      type: "subagent-status",
      toolCallId: "toolu_ex",
      status: "running",
      report: null,
    });
    expect(subagentState(splitRuns(chat.turns[0]!).runs.get("toolu_ex")!)).toBe("running");
  });

  it("marks a run failed from its launch call's error", () => {
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    chat = reduceEvents(chat, [
      {
        type: "tool-call-started",
        toolCallId: "a",
        messageId: "m",
        tool: "Agent",
        parentToolCallId: null,
      },
      {
        type: "tool-call-input",
        toolCallId: "a",
        input: { subagent_type: "writer-worker", description: "x" },
      },
      {
        type: "subagent-started",
        toolCallId: "a",
        role: "worker",
        name: "writer-worker",
        model: "sonnet",
      },
      {
        type: "tool-call-finished",
        toolCallId: "a",
        output: "boom",
        isError: true,
        outcome: "error",
        truncated: false,
      },
    ]);
    expect(subagentState(splitRuns(chat.turns[0]!).runs.get("a")!)).toBe("failed");
  });
});

describe("a sub-agent type Writer does not define", () => {
  it("keeps the name it was given, no icon, no model claim", () => {
    let chat = appendUserTurn(
      createChat("c"),
      { messageId: "u", text: "go", context: [] },
      0,
      true,
    );
    chat = reduceEvents(chat, [
      {
        type: "tool-call-started",
        toolCallId: "a",
        messageId: "m",
        tool: "Task",
        parentToolCallId: null,
      },
      {
        type: "tool-call-input",
        toolCallId: "a",
        input: { subagent_type: "my-agent", prompt: "do it\nmore" },
      },
      { type: "subagent-started", toolCallId: "a", role: null, name: "my-agent", model: null },
    ]);
    const run = splitRuns(chat.turns[0]!).runs.get("a")!;
    expect(subagentLabel(run)).toBe("my-agent");
    expect(subagentIcon(run)).toBeNull();
    expect(subagentTask(run)).toBe("do it");
  });
});

describe("restored chats", () => {
  const events = withRunnerStarts(goldens["subagent-parallel"]!);
  const fold = foldAssistantEvents(events);

  it("keeps the parent of each call, who ran and the closing answer, in the note", () => {
    const byId = Object.fromEntries(fold.tools.map((t) => [t.id, t]));
    expect(byId.toolu_e_grep!.parent).toBe("toolu_ex");
    expect(byId.toolu_ex!.parent).toBeUndefined();
    expect(byId.toolu_ex!.sub).toMatchObject({ role: "explorer", model: "haiku" });
    expect(byId.toolu_ex!.sub!.summary).toBe("Found 2 notes: Plan.md and Pricing.md.");
  });

  it("keeps a sub-agent's text out of the assistant's answer", () => {
    expect(fold.text).toBe(
      "I will hand the search and the fix to two helpers.\n\nBoth helpers are done.",
    );
  });

  it("regroups into the same cards after a note round trip", () => {
    const doc = parseChatNote(
      serializeChatNote({
        meta: emptyMeta("c", 0),
        trimmed: 0,
        extraFrontmatter: "",
        messages: [
          { role: "user", id: "u", at: 1, text: "go" },
          { role: "assistant", id: "u-a", at: 2, text: fold.text, tools: fold.tools },
        ],
      }),
    );
    const chat = chatFromNote(doc, { projectPath: null });
    const { runs, main } = splitRuns(chat.turns[0]!);
    expect([...runs.keys()]).toEqual(["toolu_ex", "toolu_wk"]);
    expect(runs.get("toolu_ex")!.children.map((b) => b.kind === "tool" && b.tool)).toEqual([
      "Grep",
      "Read",
    ]);
    expect(subagentLabel(runs.get("toolu_wk")!)).toBe("Worker");
    expect(subagentSummary(runs.get("toolu_ex")!)).toBe("Found 2 notes: Plan.md and Pricing.md.");
    expect(subagentElapsed(runs.get("toolu_ex")!, 10)).toBeNull();
    expect(subagentState(runs.get("toolu_ex")!)).toBe("done");
    expect(runs.get("toolu_ex")!.meta?.status).toBe("completed");
    expect(main.filter((b) => b.kind === "tool")).toHaveLength(2); // only the two launch calls
  });

  it("restores a run the note never saw end as interrupted, never done", () => {
    const events = withRunnerStarts(goldens["subagent-background"]!);
    const fold = foldAssistantEvents(
      events.slice(0, events.findIndex((e) => e.type === "turn-finished") + 1),
    );
    const sub = fold.tools.find((t) => t.id === "toolu_agent1")!.sub!;
    expect(sub.status).toBeUndefined();
    const doc = parseChatNote(
      serializeChatNote({
        meta: emptyMeta("c", 0),
        trimmed: 0,
        extraFrontmatter: "",
        messages: [
          { role: "user", id: "u", at: 1, text: "go" },
          { role: "assistant", id: "u-a", at: 2, text: fold.text, tools: fold.tools },
        ],
      }),
    );
    const chat = chatFromNote(doc, { projectPath: null });
    const run = splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!;
    expect(subagentState(run)).toBe("interrupted");
    expect(trayRuns(chat)).toEqual([]);
    expect(subagentSummary(run)).toBe("");
  });

  it("updates the note's run in place when a background run ends after its turn was written", () => {
    const events = withRunnerStarts(goldens["subagent-background"]!);
    const finished = events.findIndex((e) => e.type === "turn-finished");
    let note = recordSend(newNoteState("c", null, 0), {
      messageId: "u",
      text: "go",
      context: [],
      ts: 1,
    });
    note = recordEvents(note, events.slice(0, finished + 1), 2).note;
    const toolOf = () =>
      note.messages
        .find((m) => m.role === "assistant")!
        .tools!.find((t) => t.id === "toolu_agent1")!;
    expect(toolOf().sub!.status).toBeUndefined();
    const late = recordEvents(note, events.slice(finished + 1), 3);
    note = late.note;
    expect(late.finished).toBe(true);
    expect(toolOf().sub).toMatchObject({
      status: "completed",
      summary: "The note now says new line added.",
    });
    const chat = chatFromNote(
      { meta: note.meta, messages: note.messages, trimmed: 0, extraFrontmatter: "" },
      { projectPath: null },
    );
    expect(subagentState(splitRuns(chat.turns[0]!).runs.get("toolu_agent1")!)).toBe("done");
  });

  it("reads a note written before cards as a flat history", () => {
    const doc = parseChatNote(
      serializeChatNote({
        meta: emptyMeta("c", 0),
        trimmed: 0,
        extraFrontmatter: "",
        messages: [
          { role: "user", id: "u", at: 1, text: "go" },
          {
            role: "assistant",
            id: "u-a",
            at: 2,
            text: "ok",
            tools: [
              { id: "a", tool: "Agent", input: { subagent_type: "writer-worker" }, outcome: "ok" },
              { id: "w", tool: "Write", input: { file_path: "x.md" }, outcome: "ok" },
            ],
          },
        ],
      }),
    );
    const turn = chatFromNote(doc, { projectPath: null }).turns[0]!;
    const { runs } = splitRuns(turn);
    expect(runs.get("a")!.children).toEqual([]);
    expect(turn.subagents).toBeUndefined();
  });
});

describe("the roles registry names what a card shows", () => {
  // Cold dynamic import of the icon module (it pulls the icon set), slow when the machine is busy.
  it("has a label and a known icon key for every role", { timeout: 30_000 }, async () => {
    const { ROLE_ICONS } = await import("@features/agent/web/components/role-icons");
    for (const role of AGENT_ROLES) {
      expect(role.label, role.id).toMatch(/^[A-Z][a-z]+$/);
      expect(Object.keys(ROLE_ICONS), role.id).toContain(role.icon);
      expect(roleLabelOf(`writer-${role.id}`)).toBe(role.label);
    }
    expect(roleLabelOf("my-agent")).toBe("my-agent");
  });
});
