import { useEffect, type RefObject } from "react";
import { getActiveFilePath } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { wikilinkTarget } from "@features/agent/web/lib/markdown";
import {
  bindLinkActivation,
  isExternalHref,
  linkHandlers,
  openPath,
  type LinkTarget,
} from "@/lib/link-activation";
import { resolveWikiLinkTarget } from "@/lib/tauri";

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
  if (wiki)
    return {
      kind: "custom",
      open: (intent) =>
        void resolveWikiLinkTarget(wiki, getActiveFilePath()).then((path) => {
          if (path) void openPath(path, intent);
        }),
    };
  return isExternalHref(href) ? { kind: "url", href } : SWALLOW;
}

/** Link activation (left, middle, modifier clicks) for the rendered markdown inside `ref`. */
export function useMarkdownLinks(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    return el ? bindLinkActivation(el, markdownLinkTarget) : undefined;
  }, [ref]);
}
