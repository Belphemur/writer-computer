/** Splits a turn's blocks into render segments: runs of tool/thinking rows become one
 *  collapsible group, text blocks stand alone (spec 3.2 `timeline-group`). Pure. */
import type { Block, SteerBlock, TextBlock, ThinkingBlock, ToolBlock, Turn } from "./transcript";
import { splitRuns, type SubagentSegmentData } from "./subagents";
import { groupTitle } from "./tool-kinds";

export type Segment =
  | { kind: "text"; block: TextBlock }
  | { kind: "steer"; block: SteerBlock }
  | { kind: "subagent"; run: SubagentSegmentData }
  | { kind: "question"; block: ToolBlock }
  | { kind: "group"; id: string; blocks: (ToolBlock | ThinkingBlock)[] };

/** Render segments of a list of blocks; a launch call that has a run in `runs` becomes the
 *  sub-agent's card instead of a tool row. */
export function segmentBlocks(
  blocks: readonly Block[],
  runs?: ReadonlyMap<string, SubagentSegmentData>,
): Segment[] {
  const out: Segment[] = [];
  for (const block of blocks) {
    if (block.kind === "text" || block.kind === "steer") {
      out.push({ kind: block.kind, block } as Segment);
      continue;
    }
    // a question to the user is its own card, always in view (never inside a collapsed group)
    if (block.kind === "tool" && block.question) {
      out.push({ kind: "question", block });
      continue;
    }
    const run = block.kind === "tool" ? runs?.get(block.id) : undefined;
    if (run) {
      out.push({ kind: "subagent", run });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "group") last.blocks.push(block);
    else out.push({ kind: "group", id: `group:${block.id}`, blocks: [block] });
  }
  return out;
}

/** A turn's segments: the main agent's own rows and text in order, each delegated run as one card
 *  at the place its launch call sits (the sub-agent's blocks are inside the card, not here). */
export function segmentTurn(turn: Turn): Segment[] {
  const { main, runs } = splitRuns(turn);
  return segmentBlocks(main, runs);
}

export function groupHeader(blocks: readonly Block[], running: boolean): string {
  const tools = blocks.filter((b): b is ToolBlock => b.kind === "tool").map((b) => b.tool);
  return groupTitle(tools, running);
}

/** "<1s", "45s", "1m 32s" for "Worked for ..." and "Thought for ...". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
