import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { logger } from "@/lib/logger";
import { toPortableMarkdown } from "@/lib/portable-markdown";

/** The one copy path of the agent pane (selection, Cmd/Ctrl+C aside, and the code-block button):
 *  the Markdown without vault-only links, on the clipboard, with the one toast. */
export async function copyMarkdown(markdown: string): Promise<void> {
  try {
    await writeText(toPortableMarkdown(markdown));
    showEditorNotice("Copied to clipboard");
  } catch (e) {
    logger.warn("app", `agent copy failed: ${e instanceof Error ? e.message : String(e)}`);
    showEditorNotice("Could not copy");
  }
}
