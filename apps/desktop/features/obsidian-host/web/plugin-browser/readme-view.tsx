import { useEffect, useMemo, useRef } from "react";
import { scrollIntoScroller } from "@/lib/scroll-into";
import { bindLinkActivation, type LinkTarget } from "@/lib/link-activation";
import { classifyLink } from "./link-action";
import { renderReadme } from "./render-readme";
import "./readme-view.css";

/** Sanitized README HTML. The webview never navigates: every link click is intercepted, and web
 *  links open the system browser on a left, middle or modifier click (`lib/link-activation.ts`). */
export function ReadmeView({ markdown, repo }: { markdown: string; repo: string }) {
  const html = useMemo(() => renderReadme(markdown, { repo }), [markdown, repo]);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    return bindLinkActivation(root, (target): LinkTarget | null => {
      const link = target.closest("a");
      if (!link) return null;
      const action = classifyLink(link.getAttribute("href"));
      if (action.kind === "open") return { kind: "url", href: action.url };
      if (action.kind !== "anchor") return { kind: "custom", open: () => {} };
      return {
        kind: "custom",
        open: () => {
          // Ids are only ever set by renderReadme (`readme-<slug>`); compare, never CSS-escape.
          const wanted = `readme-${action.id.toLowerCase()}`;
          const el = Array.from(root.querySelectorAll("[id]")).find((n) => n.id === wanted);
          if (el instanceof HTMLElement) scrollIntoScroller(el, { block: "start" });
        },
      };
    });
  }, [html]);

  return (
    <div
      ref={host}
      role="document"
      tabIndex={0}
      aria-label="README"
      className="plugin-readme"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
