/**
 * Sub-agent runs as the transcript shows them (spec `SPECs/native-agent-spec.md`, "Sub-agent
 * cards"): one card per `Agent`/`Task` launch call, holding the blocks that sub-agent made. Pure.
 *
 * What is known where: Rust says who the sub-agent is and which model it runs
 * (`subagent-started`, `SubagentMeta`), the CLI says how a run ended (`subagent-status`), the
 * stream says which blocks are the sub-agent's (`parentToolCallId`). This module only derives the
 * card's header (status, counts, elapsed time) from those; it never resolves a role or a model.
 */
import { roleLabelOf, roleOf } from "./agent-roles";
import type { AgentEvent } from "./events";
import { readsFile, toolKind, asRecord } from "./tool-kinds";
import type { Block, SubagentMeta, ToolBlock, Turn } from "./transcript";

/** A launch call: the tool that starts a sub-agent (`Agent`, `Task`), by the tools registry. */
export const isLaunchCall = (block: Block): block is ToolBlock =>
  block.kind === "tool" && toolKind(block.tool) === "agent";

/** The launch call asked for a background run: its result comes back at once ("launched") and the
 *  run goes on until the CLI says it ended. */
export const isBackgroundLaunch = (block: ToolBlock): boolean =>
  asRecord(block.input)?.run_in_background === true;

/** A foreground run ends with its launch call's result. */
export function launchEnd(
  meta: SubagentMeta,
  event: Extract<AgentEvent, { type: "tool-call-finished" }>,
  now: number,
): SubagentMeta {
  if (meta.status !== null && meta.status !== "running") return meta;
  return {
    ...meta,
    status: event.outcome === "ok" ? "completed" : event.outcome === "error" ? "failed" : "stopped",
    endedAt: meta.endedAt ?? now,
  };
}

export type SubagentState = "running" | "done" | "failed" | "stopped";

export type SubagentSegmentData = {
  /** The launch call id: what the card, the Changes card and the permission card key by. */
  id: string;
  launch: ToolBlock;
  meta: SubagentMeta | undefined;
  /** The blocks the sub-agent made, in stream order. */
  children: Block[];
};

/** Splits a turn's blocks into the main agent's blocks and one run per launch call. A block whose
 *  parent is not a launch call of this turn (a restored chat that kept no parents) stays with the
 *  main agent: the turn then reads flat, as before. */
export function splitRuns(turn: Pick<Turn, "blocks" | "subagents">): {
  main: Block[];
  runs: Map<string, SubagentSegmentData>;
} {
  const runs = new Map<string, SubagentSegmentData>();
  for (const b of turn.blocks)
    if (isLaunchCall(b))
      runs.set(b.id, { id: b.id, launch: b, meta: turn.subagents?.[b.id], children: [] });
  const main: Block[] = [];
  for (const b of turn.blocks) {
    const parent = b.kind === "steer" ? null : (b.parentToolCallId ?? null);
    const run = parent === null ? undefined : runs.get(parent);
    if (run) run.children.push(b);
    else main.push(b);
  }
  return { main, runs };
}

/** running / done / failed / stopped: the CLI's word when it gave one, else the launch call's
 *  state (a background run whose launch returned stays running until the CLI says it ended). */
export function subagentState(run: SubagentSegmentData): SubagentState {
  const { launch, meta } = run;
  if (meta?.status === "completed") return "done";
  if (meta?.status === "failed") return "failed";
  if (meta?.status === "stopped") return "stopped";
  if (launch.status === "running" || launch.status === "waiting") return "running";
  if (launch.status === "error") return "failed";
  if (launch.status === "rejected" || launch.status === "interrupted") return "stopped";
  return meta?.status === "running" ? "running" : "done";
}

/** A tool of the run waits for the user's permission. */
export const subagentWaiting = (run: SubagentSegmentData): boolean =>
  run.children.some((b) => b.kind === "tool" && b.status === "waiting");

export type SubagentCounts = { toolCalls: number; filesRead: number; edits: number };

/** Tool calls the sub-agent made, distinct files it read, edit-kind calls. */
export function subagentCounts(children: readonly Block[]): SubagentCounts {
  const tools = children.filter((b): b is ToolBlock => b.kind === "tool");
  const read = new Set<string>();
  for (const t of tools) {
    if (!readsFile(t.tool)) continue;
    const rec = asRecord(t.input);
    const path = rec?.file_path ?? rec?.path;
    read.add(typeof path === "string" ? path : t.id);
  }
  return {
    toolCalls: tools.length,
    filesRead: read.size,
    edits: tools.filter((t) => toolKind(t.tool) === "edit").length,
  };
}

/** The role's display name: the registry's label, else the type as the call named it, else
 *  "Sub-agent" (a launch without a type). */
export function subagentLabel(run: SubagentSegmentData): string {
  const name = run.meta?.name || stringOf(asRecord(run.launch.input)?.subagent_type);
  return name ? roleLabelOf(run.meta?.role ?? name) : "Sub-agent";
}

/** The registry's icon key of the run's role; null for a type Writer does not define. */
export const subagentIcon = (run: SubagentSegmentData): string | null =>
  roleOf(run.meta?.role ?? run.meta?.name)?.icon ?? null;

/** The short task label from the launch input (`description`), else its first prompt line. */
export function subagentTask(run: SubagentSegmentData): string {
  const rec = asRecord(run.launch.input);
  const description = stringOf(rec?.description);
  if (description) return description;
  return stringOf(rec?.prompt).split("\n", 1)[0]!.trim();
}

/** The run's final answer: the launch call's result, else what the chat note kept. */
export const subagentSummary = (run: SubagentSegmentData): string =>
  (run.launch.output || run.meta?.summary || "").trim();

/** Elapsed milliseconds: start to end, or to `now` while it runs; null when never timed (a
 *  restored chat). */
export function subagentElapsed(run: SubagentSegmentData, now: number): number | null {
  const m = run.meta;
  if (!m || m.startedAt === null) return null;
  return Math.max(0, (m.endedAt ?? now) - m.startedAt);
}

const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");
