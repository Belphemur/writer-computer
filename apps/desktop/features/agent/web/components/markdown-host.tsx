import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { copyMarkdown } from "@features/agent/web/lib/copy-markdown";
import { MD_SKIP_ATTR, setMarkdownSource } from "@features/agent/web/lib/selection-markdown";
import { Ico } from "./agent-icon";
import { useMarkdownLinks } from "./agent-links";

/** The text between a code block's fences: what is drawn (marked ends it with one newline). */
const codeText = (pre: HTMLElement) =>
  (pre.querySelector("code") ?? pre).textContent?.replace(/\n$/, "") ?? "";

function CodeCopyButton({ pre }: { pre: HTMLElement }) {
  return (
    <button
      type="button"
      {...{ [MD_SKIP_ATTR]: "" }}
      data-agent-copy-code
      aria-label="Copy code"
      title="Copy"
      onClick={() => void copyMarkdown(codeText(pre))}
      className="agent-code-copy"
    >
      <Ico icon={Copy01Icon} size={14} />
    </button>
  );
}

/**
 * What every rendered Markdown of the transcript shares: link activation, the source the
 * selection copy reads (`selection-markdown.ts`), and a copy button in each code block. Returns
 * the buttons (portals into the code blocks); render them next to the host element. `html` is
 * what the host shows, so the buttons are found again whenever it changes.
 */
export function useMarkdownHost(
  host: RefObject<HTMLElement | null>,
  source: string,
  html?: string,
): ReactNode {
  useMarkdownLinks(host);
  const [blocks, setBlocks] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    setMarkdownSource(el, source);
    const found = [...el.querySelectorAll<HTMLElement>("pre")];
    setBlocks((prev) => (prev.length === 0 && found.length === 0 ? prev : found));
  }, [host, source, html]);
  return blocks.map((pre, i) => createPortal(<CodeCopyButton pre={pre} />, pre, String(i)));
}
