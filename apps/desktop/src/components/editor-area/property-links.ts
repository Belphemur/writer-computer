import { openUrl } from "@tauri-apps/plugin-opener";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { openPath, type LinkIntent } from "@/lib/link-activation";
import * as tauri from "@/lib/tauri";
import { resolveWikiLink } from "@/lib/wiki-links";
import { showEditorNotice } from "./editor-notice-store";

/** Open a `[[wikilink]]` property value for a gesture (`lib/link-activation.ts`); report what
 *  could not be resolved. */
export async function openPropertyWikilink(value: string, intent: LinkIntent): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    showEditorNotice("No workspace is open");
    return;
  }
  const target = value.trim().replace(/^\[\[|\]\]$/g, "");
  try {
    const result = await resolveWikiLink(target, null, tauri.resolveWikiLinkTarget);
    if (result.kind === "internal") await openPath(result.path, intent);
    else showEditorNotice(`"${target}" was not found in the vault`);
  } catch (e) {
    showEditorNotice(`Could not open "${target}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function openPropertyUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    showEditorNotice(`Could not open the link: ${e instanceof Error ? e.message : String(e)}`);
  }
}
