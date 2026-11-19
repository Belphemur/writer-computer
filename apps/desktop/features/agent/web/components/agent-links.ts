import { useEffect, type RefObject } from "react";
import { getActiveFilePath } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { wikilinkTarget } from "@features/agent/web/lib/markdown";
import { isExternalHref } from "@/lib/external-url";
import { watchLinkIcon } from "@/lib/file-icons";
import { fillIconElement } from "@/lib/icon-picker/icon-dom";
import { LINK_ICON_CLASS } from "@/lib/link-dom";
import {
  bindLinkActivation,
  linkHandlers,
  wikiLinkTarget,
  type LinkTarget,
} from "@/lib/link-activation";

/** The link target of a vault-relative path (tool rows, chips, pills, Changes card); null when
 *  there is no workspace or the path would leave it. */
export function vaultTarget(relative: string): LinkTarget | null {
  const root = getWorkspaceRoot();
  if (!root || relative.startsWith("/") || relative.split("/").includes("..")) return null;
  return { kind: "note", path: `${root.replace(/\/$/, "")}/${relative}` };
}

/** Event props that open a vault-relative path like a browser link; nothing for an unusable path. */
export function vaultLinkHandlers(relative: string) {
  const target = vaultTarget(relative);
  return target ? linkHandlers(target) : {};
}

const SWALLOW: LinkTarget = { kind: "custom", open: () => {} };

/** What an anchor in rendered agent markdown opens: `[[wikilinks]]` resolve through the vault
 *  index, `http(s)`/`mailto` go to the system browser, any other anchor is swallowed so the
 *  webview never navigates. */
function markdownLinkTarget(el: Element): LinkTarget | null {
  const anchor = el.closest("a");
  if (!anchor) return null;
  const href = anchor.getAttribute("href");
  const wiki = wikilinkTarget(href);
  if (wiki) return wikiLinkTarget(wiki, getActiveFilePath);
  return isExternalHref(href) ? { kind: "url", href } : SWALLOW;
}

/** The icon of the note each `[[wikilink]]` anchor inside `el` points to (`lib/file-icons.ts`),
 *  before its text; the markdown is re-rendered as a reply streams, so new anchors are picked up
 *  as they appear and the watches of removed ones are dropped. Returns the cleanup. */
function bindLinkIcons(el: HTMLElement): () => void {
  const watching = new Map<Element, () => void>();
  const scan = () => {
    for (const [anchor, stop] of watching) {
      if (!anchor.isConnected) {
        stop();
        watching.delete(anchor);
      }
    }
    for (const anchor of el.querySelectorAll("a[href^='#wikilink:']")) {
      if (watching.has(anchor)) continue;
      const target = wikilinkTarget(anchor.getAttribute("href"));
      if (!target) continue;
      const holder = document.createElement("span");
      holder.className = LINK_ICON_CLASS;
      holder.setAttribute("aria-hidden", "true");
      holder.style.display = "none";
      holder.style.marginRight = "0.3em";
      holder.style.verticalAlign = "-0.1em";
      anchor.prepend(holder);
      watching.set(
        anchor,
        watchLinkIcon(target, getActiveFilePath(), (entry) =>
          fillIconElement(holder, entry?.icon, { color: entry?.color }),
        ),
      );
    }
  };
  scan();
  const observer = new MutationObserver(scan);
  observer.observe(el, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const stop of watching.values()) stop();
  };
}

/** Link activation (left, middle, modifier clicks) and note icons for the rendered markdown inside
 *  `ref`. */
export function useMarkdownLinks(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const unbind = bindLinkActivation(el, markdownLinkTarget);
    const unicons = bindLinkIcons(el);
    return () => {
      unbind();
      unicons();
    };
  }, [ref]);
}
