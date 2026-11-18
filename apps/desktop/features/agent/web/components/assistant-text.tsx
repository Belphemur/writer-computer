import { memo, useMemo, useRef } from "react";
import { MD_RANGE_ATTR, mdRange, renderAgentMarkdown } from "@features/agent/web/lib/markdown";
import type { TextBlock } from "@features/agent/web/lib/transcript";
import { useMarkdownHost } from "./markdown-host";

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
  if (!tail) return entry.html;
  const span = `<span ${MD_RANGE_ATTR}="${mdRange(entry.len, block.text.length)}" style="white-space:pre-wrap">${escapeText(tail)}</span>`;
  return withTail(entry.html, tail, span);
}

const OPEN_PARAGRAPH = /<\/p>\s*$/;
const OPEN_ITEM = /(<\/p>)?\s*<\/li>\s*<\/(?:ul|ol)>\s*$/;

/** Puts the plain tail inside the block it continues (the last paragraph or list item) instead
 *  of after it. `.agent-markdown > :last-child` has no bottom margin, so a tail placed after the
 *  block made that margin appear and vanish at every markdown pass: the stream bounced by 0.6em
 *  each 120 ms. Any other shape (a new block starts, a heading, a fence) keeps the tail after. */
function withTail(html: string, tail: string, span: string): string {
  const startsBlock = /^[ \t]*\n[ \t]*\n/.test(tail);
  if (!startsBlock) {
    const p = OPEN_PARAGRAPH.exec(html);
    if (p) return html.slice(0, p.index) + span + html.slice(p.index);
    const li = !tail.includes("\n") && OPEN_ITEM.exec(html);
    if (li) return html.slice(0, li.index) + span + html.slice(li.index);
  }
  return html + span;
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
  const buttons = useMarkdownHost(host, block.text, html);
  return (
    <>
      <div
        ref={host}
        data-agent-text
        data-streaming={!block.final || undefined}
        className="agent-markdown px-1 text-[14px] leading-relaxed text-text-primary"
        // Sanitised by renderAgentMarkdown (shared strict DOMPurify allowlist).
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {buttons}
    </>
  );
});
