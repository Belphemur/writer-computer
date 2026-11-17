import type { ContextRef } from "@/lib/agent/events";
import { pillFor } from "@/lib/agent/pill";
import { tokenizeMessage } from "@/lib/agent/trigger";
import { openVaultPath } from "./agent-links";
import { PillView } from "./pill-view";

/**
 * The user's message with its `@refs` and `/skills` as inline pills, found by the composer's own
 * tokenizer (`tokenizeMessage`) and drawn by the composer's own pill (`pillFor` +
 * `createPillElement`), so the sent message looks like the draft did. A note pill opens the note,
 * `@activenote` the note that was active when the message was sent (the chat note's `active-note`
 * ref). A folder or a token without a note to open is not a button.
 */
export function MessageText({ text, context }: { text: string; context: readonly ContextRef[] }) {
  return (
    <>
      {tokenizeMessage(text).map((seg, i) =>
        seg.kind === "text" ? (
          seg.text
        ) : (
          <PillView key={i} model={pillFor(seg, { refs: context })} onOpen={openVaultPath} />
        ),
      )}
    </>
  );
}
