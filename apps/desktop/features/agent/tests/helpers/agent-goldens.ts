import type { AgentEvent } from "@features/agent/web/lib/events";

const raw = import.meta.glob("@shared/agent-golden/*.events.json", {
  eager: true,
  import: "default",
}) as Record<string, AgentEvent[]>;

/** The Rust mapper's golden streams by scenario name ("ok-turn", "interrupt", ...). */
export const goldens: Record<string, AgentEvent[]> = Object.fromEntries(
  Object.entries(raw).map(([path, events]) => [
    path.split("/").pop()!.replace(".events.json", ""),
    events,
  ]),
);
