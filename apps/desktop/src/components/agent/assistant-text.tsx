import { memo, useMemo } from "react";
import { renderAgentMarkdown } from "@/lib/agent/markdown";
import type { TextBlock } from "@/lib/agent/transcript";
import { handleMarkdownClick } from "./agent-links";

const THROTTLE_MS = 120;
/** Live blocks: last markdown pass per block id (spec 3.5: at most one pass per 120 ms). */
const live = new Map<string, { at: number; len: number; html: string }>();

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The pass for a streaming block: markdown up to the last pass, plain pre-wrapped tail after. */
export function liveHtml(block: TextBlock, now: number): string {
  let entry = live.get(block.id);
  if (!entry || (now - entry.at >= THROTTLE_MS && entry.len !== block.text.length)) {
    entry = { at: now, len: block.text.length, html: renderAgentMarkdown(block.text) };
    live.set(block.id, entry);
  }
  const tail = block.text.slice(entry.len);
  return tail
    ? `${entry.html}<span style="white-space:pre-wrap">${escapeText(tail)}</span>`
    : entry.html;
}

/** Finished blocks render once and are memoised by (id, final text) through `memo`. */
export const AssistantText = memo(function AssistantText({ block }: { block: TextBlock }) {
  const html = useMemo(() => {
    if (block.final) {
      live.delete(block.id);
      return renderAgentMarkdown(block.text);
    }
    return liveHtml(block, Date.now());
  }, [block]);
  return (
    <div
      data-agent-text
      data-streaming={!block.final || undefined}
      className="agent-markdown px-1 text-[14px] leading-relaxed text-text-primary"
      onClick={handleMarkdownClick}
      // Sanitised by renderAgentMarkdown (shared strict DOMPurify allowlist).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
