/** Splits a turn's blocks into render segments: runs of tool/thinking rows become one
 *  collapsible group, text blocks stand alone (spec 3.2 `timeline-group`). Pure. */
import type { Block, TextBlock, ThinkingBlock, ToolBlock, Turn } from "./transcript";
import { groupTitle } from "./tool-kinds";

export type Segment =
  | { kind: "text"; block: TextBlock }
  | { kind: "group"; id: string; blocks: (ToolBlock | ThinkingBlock)[] };

export function segmentTurn(turn: Turn): Segment[] {
  const out: Segment[] = [];
  for (const block of turn.blocks) {
    if (block.kind === "text") {
      out.push({ kind: "text", block });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "group") last.blocks.push(block);
    else out.push({ kind: "group", id: `group:${block.id}`, blocks: [block] });
  }
  return out;
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
