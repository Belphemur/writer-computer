import { useLayoutEffect, useMemo, useRef } from "react";
import type { ContextRef } from "@/lib/agent/events";
import { renderAgentMarkdown } from "@/lib/agent/markdown";
import { pillFor, type PillModel } from "@/lib/agent/pill";
import { tokenizeMessage } from "@/lib/agent/trigger";
import { useMarkdownLinks } from "./agent-links";
import { mountPill } from "./pill-view";

// Private-use characters carry a token through the Markdown pass (no Markdown meaning, not
// punctuation, so emphasis around a pill still pairs up).
const OPEN = "";
const CLOSE = "";
const MARKER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type UserMessageHtml = { html: string; pills: PillModel[] };

/**
 * The user's message as sanitised Markdown HTML with an empty `<span data-pill-slot="n">` where
 * each `@ref` / `/skill` token was (found by the composer's own tokenizer). The tokens never go
 * through Markdown, so a path with `_` or `*` stays intact; a token inside bold, a list item, a
 * quote or a code span is still a pill (the same textual rule the composer uses). A single newline
 * is a line break, as typed.
 */
export function renderUserMessage(text: string, context: readonly ContextRef[]): UserMessageHtml {
  const pills: PillModel[] = [];
  const raws: string[] = [];
  let source = "";
  for (const seg of tokenizeMessage(text)) {
    if (seg.kind === "text") source += seg.text;
    else {
      source += `${OPEN}${pills.length}${CLOSE}`;
      pills.push(pillFor(seg, { refs: context }));
      raws.push(seg.raw);
    }
  }
  const html = renderAgentMarkdown(source, { breaks: true })
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith("<")
        ? part.replace(MARKER, (_, i: string) => escapeHtml(raws[Number(i)] ?? ""))
        : part.replace(MARKER, (_, i: string) => `<span data-pill-slot="${i}"></span>`),
    )
    .join("");
  return { html, pills };
}

/**
 * The user's message with Markdown rendered in the transcript's typography (`.agent-markdown`,
 * the editor's heading scale, code, quote, list and link looks) and its `@refs` and `/skills` as
 * inline pills, drawn by the composer's own pill (`pillFor` + `createPillElement`), so the sent
 * message looks like the draft did. A note pill opens the note, `@activenote` the note that was
 * active when the message was sent (the chat note's `active-note` ref). A folder or a token
 * without a note to open is not a button.
 */
export function MessageText({ text, context }: { text: string; context: readonly ContextRef[] }) {
  const { html, pills } = useMemo(() => renderUserMessage(text, context), [text, context]);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host.current?.querySelectorAll<HTMLElement>("[data-pill-slot]").forEach((slot) => {
      const model = pills[Number(slot.dataset.pillSlot)];
      if (model) mountPill(slot, model, true);
    });
  }, [html, pills]);
  useMarkdownLinks(host);
  return (
    <div
      ref={host}
      className="agent-markdown"
      // Sanitised by renderAgentMarkdown; the only markup added after is the pill slots.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
