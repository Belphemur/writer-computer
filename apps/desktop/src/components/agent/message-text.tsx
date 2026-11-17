import type { ContextRef } from "@/lib/agent/events";
import { isActiveNoteToken } from "@/lib/agent/mentions";
import { tokenizeMessage } from "@/lib/agent/trigger";
import { openVaultPath } from "./agent-links";

const TOKEN =
  "rounded bg-[var(--surface-subtle)] px-1 py-px font-medium text-text-secondary [overflow-wrap:anywhere]";

/**
 * The user's message with its `@refs` and `/skills` as inline tokens, found by the composer's own
 * tokenizer (`tokenizeMessage`). The text is shown as typed (`@activenote` stays); a note token
 * opens the note, `@activenote` the note that was active when the message was sent (the chat
 * note's `active-note` ref). A folder or a token without a note to open is not a button.
 */
export function MessageText({ text, context }: { text: string; context: readonly ContextRef[] }) {
  return (
    <>
      {tokenizeMessage(text).map((seg, i) => {
        if (seg.kind === "text") return seg.text;
        if (seg.kind === "slash")
          return (
            <span key={i} data-agent-token="skill" className={TOKEN}>
              {seg.raw}
            </span>
          );
        const active = isActiveNoteToken(seg);
        const ref = active
          ? context.find((r) => r.kind === "active-note")
          : context.find(
              (r) =>
                (r.kind === "note" || r.kind === "folder") &&
                (r.label === seg.path || r.path === seg.path),
            );
        const full = ref && "path" in ref ? ref.path : undefined;
        const target =
          ref?.kind === "folder" ? undefined : (full ?? (ref || active ? undefined : seg.path));
        if (!target)
          return (
            <span key={i} data-agent-token="mention" title={full} className={TOKEN}>
              {seg.raw}
            </span>
          );
        return (
          <button
            key={i}
            type="button"
            data-agent-token="mention"
            title={target}
            onClick={() => openVaultPath(target)}
            className={`${TOKEN} cursor-pointer hover:underline`}
          >
            {seg.raw}
          </button>
        );
      })}
    </>
  );
}
