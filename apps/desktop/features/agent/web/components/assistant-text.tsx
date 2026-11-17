import { memo, useMemo, useRef } from "react";
import { renderAgentMarkdown } from "@features/agent/web/lib/markdown";
import type { TextBlock } from "@features/agent/web/lib/transcript";
import { useMarkdownLinks } from "./agent-links";

const THROTTLE_MS = 120;
/** Live blocks: last markdown pass per block id (spec 3.5: at most one pass per 120 ms). */
const live = new Map<string, { at: number; len: number; html: string }>();

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The pass for a streaming block: markdown up to the last pass, plain pre-wrapped tail after. */
export function liveHtml(block: Pick<TextBlock, "id" | "text">, now: number): string {
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

/** The one markdown pass for a block of streamed text (assistant text, reasoning): throttled
 *  while it streams, rendered once and forgotten when it is final. */
export function renderBlockHtml(block: Pick<TextBlock, "id" | "text">, final: boolean): string {
  if (!final) return liveHtml(block, Date.now());
  live.delete(block.id);
  return renderAgentMarkdown(block.text);
}

/** Finished blocks render once and are memoised by (id, final text) through `memo`. */
export const AssistantText = memo(function AssistantText({ block }: { block: TextBlock }) {
  const html = useMemo(() => renderBlockHtml(block, block.final), [block]);
  const host = useRef<HTMLDivElement>(null);
  useMarkdownLinks(host);
  return (
    <div
      ref={host}
      data-agent-text
      data-streaming={!block.final || undefined}
      className="agent-markdown px-1 text-[14px] leading-relaxed text-text-primary"
      // Sanitised by renderAgentMarkdown (shared strict DOMPurify allowlist).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
