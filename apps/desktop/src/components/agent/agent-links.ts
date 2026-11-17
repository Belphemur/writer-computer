import { openUrl } from "@tauri-apps/plugin-opener";
import { getActiveFilePath, navigateToFile } from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { wikilinkTarget } from "@/lib/agent/markdown";
import { resolveWikiLinkTarget } from "@/lib/tauri";

/** Opens a vault-relative path in the editor (tool rows, context chips). */
export function openVaultPath(relative: string) {
  const root = getWorkspaceRoot();
  if (!root || relative.startsWith("/") || relative.split("/").includes("..")) return;
  void navigateToFile(`${root.replace(/\/$/, "")}/${relative}`);
}

/** Click handler for rendered assistant markdown: `[[wikilinks]]` resolve through the vault
 *  index, `http(s)`/`mailto` links go to the system browser, nothing else navigates. */
export function handleMarkdownClick(event: React.MouseEvent<HTMLElement>) {
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("href");
  const wiki = wikilinkTarget(href);
  if (wiki) {
    void resolveWikiLinkTarget(wiki, getActiveFilePath()).then((path) => {
      if (path) void navigateToFile(path);
    });
    return;
  }
  if (href && /^(https?:|mailto:)/i.test(href)) void openUrl(href);
}
