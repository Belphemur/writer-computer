// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { contextRefLabel, estimateTokens } from "@features/agent/web/lib/context-text";
import { createEventPump } from "@features/agent/web/lib/client";
import type { AgentEvent, AgentEventEnvelope } from "@features/agent/web/lib/events";
import { renderAgentMarkdown, wikilinkTarget } from "@features/agent/web/lib/markdown";
import { candidatesFromResults } from "@features/agent/web/lib/mentions";
import {
  createMockAgentClient,
  pickScenario,
  splitTurns,
  type Goldens,
} from "@features/agent/web/lib/mock-client";
import {
  permissionChoices,
  permissionSummary,
  primaryArg,
  toolKind,
  toolLabel,
} from "@features/agent/web/lib/tool-kinds";
import { agentSettingsFrom } from "@features/agent/web/lib/agent-settings";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

describe("tool kinds", () => {
  it("maps tools to kinds", () => {
    expect(
      ["Bash", "Edit", "Write", "Read", "WebFetch", "Task", "mcp__x__y"].map(toolKind),
    ).toEqual(["execute", "edit", "edit", "read", "fetch", "agent", "other"]);
  });
  it("labels rows with the verb and the primary argument", () => {
    expect(toolLabel("Bash", { command: "ls -la\nmore" }, false)).toBe("Ran ls -la");
    expect(toolLabel("Read", { file_path: "/v/a/note.md" }, true)).toBe("Reading note.md");
    expect(primaryArg("Grep", { pattern: "todo" })).toBe("todo");
    expect(toolLabel("Weird", {}, false)).toBe("Used Weird");
  });
  it("derives always-allow choices only from the suggestions the CLI sent", () => {
    const rules = permissionChoices([
      {
        type: "addRules",
        behavior: "allow",
        destination: "localSettings",
        rules: [{ toolName: "Bash", ruleContent: "python3 -c 'print(1)'" }],
      },
    ]);
    expect(rules.map((c) => c.persist)).toEqual(["project", "session"]);
    expect(rules[0]!.rule).toBe("Bash(python3 -c 'print(1)')");
    expect(
      permissionChoices([{ type: "setMode", mode: "acceptEdits", destination: "session" }]).map(
        (c) => c.persist,
      ),
    ).toEqual(["accept-edits"]);
    expect(permissionChoices([])).toEqual([]);
    expect(permissionChoices([{ type: "addRules", behavior: "deny", rules: [] }])).toEqual([]);
  });
  it("words the card body per tool kind", () => {
    const base = {
      requestId: "r",
      toolCallId: null,
      displayName: null,
      description: null,
      decisionReason: null,
      suggestions: [],
    };
    expect(permissionSummary({ ...base, tool: "Bash", input: { command: "rm x" } })).toBe(
      "The agent wants to run Bash: rm x",
    );
    expect(permissionSummary({ ...base, tool: "Write", input: { file_path: "a.md" } })).toBe(
      "The agent wants to write a.md",
    );
    expect(permissionSummary({ ...base, tool: "Edit", input: { file_path: "a.md" } })).toBe(
      "The agent wants to edit a.md",
    );
    expect(permissionSummary({ ...base, tool: "WebFetch", input: { url: "https://x.test" } })).toBe(
      "The agent wants to use WebFetch: https://x.test",
    );
  });
});

describe("context text", () => {
  it("labels refs and estimates tokens (the prompt itself: agent-prompt.test.ts)", () => {
    expect(
      contextRefLabel({ kind: "selection", path: "a.md", text: "", fromLine: 1, toLine: 2 }),
    ).toBe("a.md:1-2");
    expect(estimateTokens(9)).toBe(3);
  });
});

describe("markdown", () => {
  it("renders prose and strips anything active", () => {
    const html = renderAgentMarkdown(
      "**bold** <script>alert(1)</script> [x](javascript:alert(1)) ![i](http://a/b.png)",
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });
  it("opens http links safely and turns wikilinks into resolvable anchors", () => {
    const html = renderAgentMarkdown("[a](https://example.com) and [[My Note|alias]]");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    const href = /href="(#wikilink:[^"]+)"/.exec(html)![1]!;
    expect(wikilinkTarget(href)).toBe("My Note");
    expect(html).toContain(">alias</a>");
  });
});

describe("mentions", () => {
  it("offers matching folders first, then notes", () => {
    const out = candidatesFromResults("proj", [
      { relative_path: "Projects/Alpha/plan.md" },
      { relative_path: "Other/project-x.md" },
    ]);
    expect(out[0]).toMatchObject({ kind: "folder", path: "Projects" });
    expect(out.some((c) => c.kind === "note" && c.path === "Other/project-x.md")).toBe(true);
  });

  it("shows a title override first with the file path behind it, else the file name", () => {
    const out = candidatesFromResults("quarterly", [
      { relative_path: "Notes/Spec.md", title: "Quarterly Plan" },
      { relative_path: "Notes/Plain.md", title: null },
    ]);
    expect(out).toContainEqual({
      kind: "note",
      path: "Notes/Spec.md",
      label: "Quarterly Plan",
      detail: "Notes/Spec.md",
    });
    expect(out).toContainEqual({
      kind: "note",
      path: "Notes/Plain.md",
      label: "Plain",
      detail: "Notes",
    });
  });
});

describe("settings", () => {
  it("falls back to the spec defaults", () => {
    expect(agentSettingsFrom({})).toEqual({
      binaryPath: null,
      model: null,
      effort: null,
      permissionMode: "manual",
      allowedTools: expect.arrayContaining(["Bash(writer search *)"]),
      disallowedTools: [],
      orchestrate: true,
      showThinking: true,
      autoReload: true,
      memory: "vault",
      tierModels: { cheap: "haiku", standard: "sonnet", strong: "default" },
    });
    expect(
      agentSettingsFrom({
        "agent.permission-mode": "plan",
        "agent.allowed-tools": "Bash(ls)\n\nRead",
      }),
    ).toMatchObject({ permissionMode: "plan", allowedTools: ["Bash(ls)", "Read"] });
    expect(agentSettingsFrom({ "agent.permission-mode": "bypassPermissions" }).permissionMode).toBe(
      "manual",
    );
  });
});

const env = (chatId: string, seq: number, text = String(seq)): AgentEventEnvelope => ({
  chatId,
  seq,
  event: { type: "text-delta", messageId: "m", blockIndex: 0, text },
});
const texts = (batches: AgentEvent[][]) => batches.flat().map((e) => (e as { text: string }).text);

describe("event pump", () => {
  function pump(snapshot = vi.fn()) {
    const batches: AgentEvent[][] = [];
    const queue: (() => void)[] = [];
    const p = createEventPump({
      snapshot,
      onBatch: (_id, events) => batches.push(events),
      schedule: (f) => queue.push(f),
    });
    return { p, batches, queue, snapshot, frame: () => queue.splice(0).forEach((f) => f()) };
  }

  it("batches one frame of events into one delivery, in order", () => {
    const { p, batches, frame } = pump();
    [1, 2, 3].forEach((n) => p.push(env("c", n)));
    expect(batches).toEqual([]);
    frame();
    expect(batches).toHaveLength(1);
    expect(texts(batches)).toEqual(["1", "2", "3"]);
  });

  it("drops duplicates and stale replays", () => {
    const { p, batches, frame } = pump();
    [1, 2, 2, 1, 3].forEach((n) => p.push(env("c", n)));
    frame();
    expect(texts(batches)).toEqual(["1", "2", "3"]);
  });

  it("a gap resynchronises through agent_snapshot, then continues without loss or repeats", async () => {
    const snapshot = vi.fn(async ({ afterSeq }: { afterSeq: number }) => ({
      state: "running" as const,
      events: [env("c", 2), env("c", 3)].filter((e) => e.seq > afterSeq),
    }));
    const { p, batches, frame } = pump(snapshot);
    p.push(env("c", 1));
    p.push(env("c", 4)); // 2 and 3 missed
    p.push(env("c", 5)); // buffered while resyncing
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    frame();
    expect(snapshot).toHaveBeenCalledWith({ chatId: "c", afterSeq: 1 });
    expect(texts(batches)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("a failed snapshot does not stall the stream", async () => {
    const onResyncError = vi.fn();
    const batches: AgentEvent[][] = [];
    const queue: (() => void)[] = [];
    const p = createEventPump({
      snapshot: async () => {
        throw new Error("gone");
      },
      onBatch: (_i, e) => batches.push(e),
      onResyncError,
      schedule: (f) => queue.push(f),
    });
    p.push(env("c", 1));
    p.push(env("c", 9));
    await vi.waitFor(() => expect(onResyncError).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    queue.splice(0).forEach((f) => f());
    expect(texts(batches)).toEqual(["1", "9"]);
  });

  it("a stream starting above seq 1 is a gap; setLastSeq declares what is already applied", async () => {
    const a = pump(vi.fn(async () => ({ state: "idle" as const, events: [] })));
    a.p.push(env("c", 3));
    await vi.waitFor(() => expect(a.snapshot).toHaveBeenCalled());
    const b = pump();
    b.p.setLastSeq("c", 10);
    b.p.push(env("c", 11));
    b.frame();
    expect(b.snapshot).not.toHaveBeenCalled();
    expect(texts(b.batches)).toEqual(["11"]);
  });
});

describe("mock client", () => {
  const g = goldens as unknown as Goldens;
  it("routes message text to a scenario", () => {
    expect(pickScenario("please write a file")).toBe("permission-allow");
    expect(pickScenario("deny it")).toBe("permission-deny");
    expect(pickScenario("stop")).toBe("interrupt");
    expect(pickScenario("again")).toBe("multi-turn-rule");
    expect(pickScenario("read my notes")).toBe("tool-auto-allowed");
    expect(pickScenario("hello")).toBe("ok-turn");
    expect(splitTurns(g["multi-turn-rule"]!)).toHaveLength(2);
  });

  it("replays a turn with increasing seq and pauses on a permission until answered", async () => {
    const client = createMockAgentClient({ goldens: g });
    const got: AgentEventEnvelope[] = [];
    await client.subscribe((e) => got.push(e));
    await client.send({ chatId: "c", messageId: "m", text: "write", context: [] });
    await vi.waitFor(() =>
      expect(got.some((e) => e.event.type === "permission-request")).toBe(true),
    );
    const before = got.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(before); // paused
    const req = got.find((e) => e.event.type === "permission-request")!.event as Extract<
      AgentEvent,
      { type: "permission-request" }
    >;
    await client.permission({ chatId: "c", requestId: req.requestId, decision: "allow" });
    // the capture holds a second request (a Bash command): answer it too
    await vi.waitFor(() =>
      expect(got.filter((e) => e.event.type === "permission-request")).toHaveLength(2),
    );
    const second = got.filter((e) => e.event.type === "permission-request")[1]!.event as Extract<
      AgentEvent,
      { type: "permission-request" }
    >;
    await client.permission({ chatId: "c", requestId: second.requestId, decision: "deny" });
    await client.idle("c");
    expect(got.map((e) => e.seq)).toEqual(got.map((_, i) => i + 1));
    expect(
      got.some((e) => e.event.type === "permission-resolved" && e.event.resolution === "allowed"),
    ).toBe(true);
    expect(
      got.some((e) => e.event.type === "permission-resolved" && e.event.resolution === "denied"),
    ).toBe(true);
    expect(got[got.length - 1]!.event.type).toBe("turn-finished");
    await expect(
      client.permission({ chatId: "c", requestId: req.requestId, decision: "allow" }),
    ).rejects.toThrow();
  });

  it("cancel answers a pending card with cancelled and finishes interrupted", async () => {
    const client = createMockAgentClient({ goldens: g });
    const got: AgentEventEnvelope[] = [];
    await client.subscribe((e) => got.push(e));
    await client.send({ chatId: "c", messageId: "m", text: "stop", context: [] });
    await vi.waitFor(() =>
      expect(got.some((e) => e.event.type === "permission-request")).toBe(true),
    );
    await client.cancel({ chatId: "c" });
    await client.idle("c");
    expect(got.filter((e) => e.event.type === "permission-resolved")).toHaveLength(1);
    const last = got[got.length - 1]!.event;
    expect(last).toMatchObject({ type: "turn-finished", reason: "interrupted" });
  });

  it("serves snapshots after a seq", async () => {
    const client = createMockAgentClient({ goldens: g });
    await client.send({ chatId: "c", messageId: "m", text: "hi", context: [] });
    await client.idle("c");
    const snap = await client.snapshot({ chatId: "c", afterSeq: 3 });
    expect(snap.events[0]!.seq).toBe(4);
    expect(snap.state).toBe("idle");
  });
});
