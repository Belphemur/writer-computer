/**
 * The plain-text `<writer-context>` block that precedes the user's text (spec section 5,
 * "What Writer sends"). Pure and golden-tested; "Preview exact text" shows this string.
 *
 * Ownership note: the Rust `agent_send` builds the text that is actually written to the CLI. This
 * module is the UI's pure twin for the preview and must be kept equal to it; if Rust becomes the
 * only builder, `agent_context_preview` replaces this file.
 */
import type { ContextRef } from "./events";

export function contextRefLabel(ref: ContextRef): string {
  switch (ref.kind) {
    case "active-note":
    case "note":
    case "folder":
      return ref.path;
    case "selection":
      return `${ref.path}:${ref.fromLine}-${ref.toLine}`;
    case "tag":
      return `#${ref.tag.replace(/^#/, "")}`;
    case "property":
      return ref.value === null ? ref.name : `${ref.name}: ${ref.value}`;
    case "project-instructions":
      return ref.path;
    case "project-source":
      return ref.source.raw;
  }
}

/** Rough size estimate: ceil(chars / 4), shown with "~", never as exact. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/** Returns "" when there is nothing to say (no block is sent then). */
export function buildContextText(refs: readonly ContextRef[]): string {
  const lines: string[] = [];
  for (const ref of refs) {
    switch (ref.kind) {
      case "active-note":
        lines.push(`active note: ${ref.path}${ref.inline ? " (content included)" : ""}`);
        break;
      case "selection":
        lines.push(`selection in ${ref.path} lines ${ref.fromLine}-${ref.toLine}:`, ref.text);
        break;
      case "note":
        lines.push(`mentioned note: ${ref.path}`);
        break;
      case "folder":
        lines.push(`mentioned folder: ${ref.path}`);
        break;
      case "tag":
        lines.push(`notes tagged: #${ref.tag.replace(/^#/, "")}`);
        break;
      case "property":
        lines.push(`notes with property: ${contextRefLabel(ref)}`);
        break;
      default:
        break; // project instructions and sources are attached by the system, not per message
    }
  }
  return lines.length === 0 ? "" : `<writer-context>\n${lines.join("\n")}\n</writer-context>\n\n`;
}
