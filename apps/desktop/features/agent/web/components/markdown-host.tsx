import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createCodeCopyButton } from "@/lib/code-copy-button";
import { MD_SKIP_ATTR, setMarkdownSource } from "@features/agent/web/lib/selection-markdown";
import { useMarkdownLinks } from "./agent-links";

/** The text between a code block's fences: what is drawn (marked ends it with one newline). */
const codeText = (pre: HTMLElement) =>
  (pre.querySelector("code") ?? pre).textContent?.replace(/\n$/, "") ?? "";

/** The shared copy button (`lib/code-copy-button.ts`), put into a rendered code block. */
function CodeCopyButton({ pre }: { pre: HTMLElement }) {
  useLayoutEffect(() => {
    const button = createCodeCopyButton(() => codeText(pre), "agent-code-copy");
    button.setAttribute(MD_SKIP_ATTR, "");
    button.setAttribute("data-agent-copy-code", "");
    pre.append(button);
    return () => button.remove();
  }, [pre]);
  return null;
}

/**
 * What every rendered Markdown of the transcript shares: link activation, the source the
 * selection copy reads (`selection-markdown.ts`), and a copy button in each code block. Returns
 * the buttons (each puts itself into its code block); render them next to the host element. `html` is
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
  return blocks.map((pre, i) => <CodeCopyButton key={i} pre={pre} />);
}
