import { copyText } from "@/lib/copy-text";
import { toPortableMarkdown } from "@/lib/portable-markdown";

/** The agent pane's selection copy (Cmd/Ctrl+C aside): the Markdown without vault-only links,
 *  through the app's one copy path. */
export async function copyMarkdown(markdown: string): Promise<void> {
  await copyText(toPortableMarkdown(markdown));
}
