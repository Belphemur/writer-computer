/**
 * Sub-agent runs as the transcript shows them (spec `SPECs/native-agent-spec.md`, "Sub-agent
 * cards"): one card per `Agent`/`Task` launch call, holding the blocks that sub-agent made. Pure.
 *
 * What is known where: Rust says who the sub-agent is and which model it runs
 * (`subagent-started`, `SubagentMeta`), the CLI says how a run ended (`subagent-status`), the
 * stream says which blocks are the sub-agent's (`parentToolCallId`). This module only derives the
 * card's header (status, counts, elapsed time) from those; it never resolves a role or a model.
 *
 * One state per chat feeds every view: `Turn.subagents` (the metas) and the turns' blocks. The tray
 * above the composer (running and just-finished runs, [`trayRuns`]) and the transcript (a start
 * line and, once finished, a result card) both read it. Whether a run is done is Rust's decision
 * (`sub-agent` lifecycle, ADR 2026-11-18); nothing here infers it from a launch call's result.
 */
import { roleLabelOf, roleOf } from "./agent-roles";
import { readsFile, toolKind, toolLabel, asRecord, firstLine, truncate } from "./tool-kinds";
import type { Block, Chat, SubagentMeta, ToolBlock, Turn } from "./transcript";

/** A launch call: the tool that starts a sub-agent (`Agent`, `Task`), by the tools registry. */
export const isLaunchCall = (block: Block): block is ToolBlock =>
  block.kind === "tool" && toolKind(block.tool) === "agent";

export type SubagentState = "running" | "done" | "failed" | "stopped" | "interrupted";

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

/** The run's state: the backend's word (`subagent-status`). Without one yet, the launch call's own
 *  state while it runs; a launch that finished with no word at all (an old chat note that kept no
 *  state) never reported an end, so it is `interrupted`, not done. */
export function subagentState(run: SubagentSegmentData): SubagentState {
  const { launch, meta } = run;
  switch (meta?.status) {
    case "completed":
      return "done";
    case "failed":
    case "stopped":
    case "interrupted":
      return meta.status;
    case "running":
      return "running";
    default:
      break;
  }
  if (launch.status === "running" || launch.status === "waiting") return "running";
  if (launch.status === "error") return "failed";
  if (launch.status === "rejected" || launch.status === "interrupted") return "stopped";
  // the launch result came but the status word has not yet (same batch), or never will
  return meta ? "running" : "interrupted";
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

/** The run's final report: what the CLI's completion carried (or the foreground result), else
 *  what the chat note kept, else the sub-agent's own closing text. Never a launch's result text. */
export function subagentSummary(run: SubagentSegmentData): string {
  if (run.meta?.summary?.trim()) return run.meta.summary.trim();
  for (let i = run.children.length - 1; i >= 0; i--) {
    const b = run.children[i]!;
    if (b.kind === "text" && b.text.trim()) return b.text.trim();
  }
  return "";
}

/** The run's latest activity as one line: its last tool row, thinking or text. Empty before it did
 *  anything. */
export function subagentActivity(run: SubagentSegmentData): string {
  const last = run.children[run.children.length - 1];
  if (!last) return "";
  if (last.kind === "tool") return toolLabel(last.tool, last.input, last.status === "running");
  if (last.kind === "thinking") return "Thinking…";
  if (last.kind === "text") return truncate(firstLine(last.text), 120);
  return "";
}

/** Elapsed milliseconds: start to end, or to `now` while it runs; null when never timed (a
 *  restored chat). */
export function subagentElapsed(run: SubagentSegmentData, now: number): number | null {
  const m = run.meta;
  if (!m || m.startedAt === null) return null;
  return Math.max(0, (m.endedAt ?? now) - m.startedAt);
}

const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** A run of the tray: the run and the turn that launched it. */
export type TrayRun = SubagentSegmentData & { state: SubagentState };

/** The runs the tray shows (spec "Sub-agent tray"): every run still going, in any turn, and every
 *  run that ended since the user's last send (it goes at their next one). A run with no end time
 *  (a restored chat) is never shown. Pure, in launch order. */
export function trayRuns(chat: Pick<Chat, "turns">): TrayRun[] {
  let lastSend = 0;
  for (const t of chat.turns) if (t.user) lastSend = t.startedAt;
  const out: TrayRun[] = [];
  for (const turn of chat.turns) {
    if (!turn.subagents) continue;
    for (const run of splitRuns(turn).runs.values()) {
      const state = subagentState(run);
      const endedAt = run.meta?.endedAt ?? null;
      if (state === "running" || (endedAt !== null && endedAt >= lastSend))
        out.push({ ...run, state });
    }
  }
  return out;
}
