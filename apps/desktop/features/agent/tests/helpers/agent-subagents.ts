import type { AgentEvent } from "@features/agent/web/lib/events";
import { appendUserTurn, createChat, reduceEvents } from "@features/agent/web/lib/reduce";
import type { Chat } from "@features/agent/web/lib/transcript";
import { goldens } from "./agent-goldens";

/** What the Rust runner adds to the mapper's stream: `subagent-started` after the launch call's
 *  input, with the role and the model of its tier (`subagents::resolve_launch`). The models here
 *  are what the runner test pins for the default tier settings. */
const MODELS: Record<string, string> = { "writer-explorer": "haiku", "writer-worker": "sonnet" };

export function withRunnerStarts(events: readonly AgentEvent[]): AgentEvent[] {
  const launches = new Map<string, string>();
  const out: AgentEvent[] = [];
  for (const ev of events) {
    out.push(ev);
    if (ev.type === "tool-call-input" && ev.toolCallId.startsWith("toolu_") && isLaunch(ev.input)) {
      const name = (ev.input as { subagent_type: string }).subagent_type;
      launches.set(ev.toolCallId, name);
      out.push({
        type: "subagent-started",
        toolCallId: ev.toolCallId,
        role: name.replace(/^writer-/, ""),
        name,
        model: MODELS[name] ?? null,
      });
    }
  }
  return out;
}

const isLaunch = (input: unknown): boolean =>
  typeof input === "object" && input !== null && "subagent_type" in input;

/** A chat that replayed a golden stream (`subagent-parallel`, `subagent-background`, ...) the way
 *  the pane would: a user message, then the events, the runner's starts included. */
export function chatAfter(
  name: string,
  opts: { until?: (ev: AgentEvent) => boolean; now?: number } = {},
): Chat {
  const all = withRunnerStarts(goldens[name]!);
  const cut = opts.until ? all.findIndex(opts.until) : -1;
  const events = cut >= 0 ? all.slice(0, cut) : all;
  const chat = appendUserTurn(
    createChat("c"),
    { messageId: "u", text: "go", context: [] },
    0,
    true,
  );
  return reduceEvents(chat, events, opts.now ?? 1000);
}
