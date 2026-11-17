import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_COMMANDS,
  AGENT_EVENT_TYPES,
  isAgentEvent,
  type AgentCommand,
  type AgentEvent,
  type AgentEventEnvelope,
} from "../src/lib/agent/events";

// Written by the Rust mapper (`WRITER_UPDATE_GOLDEN=1 cargo test golden`) from anonymised real
// claude 2.1.325 captures; this test reads the same files so the two sides cannot drift.
const golden = import.meta.glob("../shared/agent-golden/*.events.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown[]>;

function* walkKeys(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    for (const v of value) yield* walkKeys(v);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      yield k;
      yield* walkKeys(v);
    }
  }
}

describe("agent event contract", () => {
  it("has golden streams from the Rust mapper", () => {
    expect(Object.keys(golden).length).toBeGreaterThanOrEqual(6);
  });

  it("every golden event is a known kebab-case type with camelCase fields", () => {
    for (const [file, events] of Object.entries(golden)) {
      expect(events.length, file).toBeGreaterThan(0);
      for (const ev of events) {
        expect(isAgentEvent(ev), `${file}: ${JSON.stringify(ev).slice(0, 120)}`).toBe(true);
      }
      // tool inputs are free-form JSON from the CLI (file_path, ...): only check envelope keys
      for (const ev of events as AgentEvent[]) {
        const { input: _input, suggestions: _suggestions, ...rest } = ev as Record<string, unknown>;
        for (const key of walkKeys(rest)) expect(key, `${file}: ${key}`).not.toContain("_");
      }
    }
  });

  it("covers most event types across the golden files", () => {
    const seen = new Set<string>();
    for (const events of Object.values(golden))
      for (const e of events as AgentEvent[]) seen.add(e.type);
    // session-ended, error and model-refused are produced by the runner, not by the mapper
    const runnerOnly = new Set(["session-ended", "error", "permission-resolved", "model-refused"]);
    for (const t of AGENT_EVENT_TYPES) {
      if (!runnerOnly.has(t)) expect(seen.has(t), t).toBe(true);
    }
    expect(seen.has("permission-resolved")).toBe(true); // from control_cancel_request
  });

  it("narrows on the discriminant (compile-time exhaustiveness)", () => {
    const describeEvent = (e: AgentEvent): string => {
      switch (e.type) {
        case "session-started":
          return e.sessionId;
        case "text-delta":
        case "text":
          return e.text;
        case "thinking":
          return e.phase;
        case "tool-call-started":
          return e.tool;
        case "tool-call-input-delta":
          return e.partialJson;
        case "tool-call-input":
          return String(e.toolCallId);
        case "tool-call-finished":
          return e.outcome;
        case "permission-request":
          return e.requestId;
        case "permission-resolved":
          return e.resolution;
        case "usage":
          return e.scope;
        case "model-refused":
          return e.requested ?? "";
        case "rate-limit":
          return e.status;
        case "turn-finished":
          return e.reason;
        case "error":
          return e.kind;
        case "session-ended":
          return e.reason;
        default: {
          const never: never = e;
          return never;
        }
      }
    };
    for (const events of Object.values(golden)) {
      for (const e of events as AgentEvent[]) expect(typeof describeEvent(e)).toBe("string");
    }
  });

  it("builds envelopes and commands with the documented shapes", () => {
    const env: AgentEventEnvelope = {
      chatId: "c",
      seq: 1,
      event: { type: "text", messageId: "m", blockIndex: 0, text: "x" },
    };
    expect(JSON.parse(JSON.stringify(env))).toEqual(env);
    const cmds: AgentCommand[] = [
      {
        type: "send-message",
        messageId: "m",
        text: "hi",
        context: [{ kind: "note", path: "a.md" }],
      },
      { type: "cancel" },
      { type: "permission-decision", requestId: "r", decision: "allow", persist: "project" },
      { type: "resume", sessionId: "s" },
      { type: "set-permission-mode", mode: "acceptEdits" },
      { type: "close" },
    ];
    expect(cmds.map((c) => c.type)).toEqual([
      "send-message",
      "cancel",
      "permission-decision",
      "resume",
      "set-permission-mode",
      "close",
    ]);
    expect(new Set(AGENT_COMMANDS).size).toBe(AGENT_COMMANDS.length);
  });

  it("rejects non-events", () => {
    expect(isAgentEvent(null)).toBe(false);
    expect(isAgentEvent({ type: "nope" })).toBe(false);
    expect(isAgentEvent("text")).toBe(false);
  });
});
