import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { logger } from "@/lib/logger";

/** The one plain-text copy path of the app's own surfaces (the agent pane's selection and the
 *  copy buttons of code blocks): the text on the clipboard, with the one toast. Resolves to
 *  whether it was copied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    showEditorNotice("Copied to clipboard");
    return true;
  } catch (e) {
    logger.warn("app", `copy failed: ${e instanceof Error ? e.message : String(e)}`);
    showEditorNotice("Could not copy");
    return false;
  }
}
