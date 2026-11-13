import { useMemo, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { classifyLink } from "./link-action";
import { renderReadme } from "./render-readme";
import "./readme-view.css";

/** Sanitized README HTML. The webview never navigates: every link click is intercepted. */
export function ReadmeView({ markdown, repo }: { markdown: string; repo: string }) {
  const html = useMemo(() => renderReadme(markdown, { repo }), [markdown, repo]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest("a");
    if (!link || !event.currentTarget.contains(link)) return;
    event.preventDefault();
    const action = classifyLink(link.getAttribute("href"));
    if (action.kind === "open") void openUrl(action.url);
    else if (action.kind === "anchor") {
      // Ids are only ever set by renderReadme (`readme-<slug>`); compare, never CSS-escape.
      const wanted = `readme-${action.id.toLowerCase()}`;
      const el = Array.from(event.currentTarget.querySelectorAll("[id]")).find(
        (n) => n.id === wanted,
      );
      el?.scrollIntoView?.({ block: "start" });
    }
  };

  return (
    <div
      role="document"
      tabIndex={0}
      aria-label="README"
      className="plugin-readme"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
