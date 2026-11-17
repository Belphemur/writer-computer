import { openUrl } from "@tauri-apps/plugin-opener";
import * as editorApi from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import * as tauri from "@/lib/tauri";
import { resolveWikiLink } from "@/lib/wiki-links";
import { showEditorNotice } from "./editor-notice-store";

/** Open a `[[wikilink]]` property value in the tab; report what could not be resolved. */
export async function openPropertyWikilink(value: string): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    showEditorNotice("No workspace is open");
    return;
  }
  const target = value.trim().replace(/^\[\[|\]\]$/g, "");
  try {
    const result = await resolveWikiLink(target, null, tauri.resolveWikiLinkTarget);
    if (result.kind === "internal") await editorApi.navigateToFile(result.path);
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
