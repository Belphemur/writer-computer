import { useId, useMemo, useState } from "react";
import { BrainIcon } from "@hugeicons/core-free-icons";
import type { ThinkingBlock } from "@features/agent/web/lib/transcript";
import { formatDuration } from "@features/agent/web/lib/timeline";
import { useSettingsStore } from "@/stores/settings-store";
import { Ico, Spinner } from "./agent-icon";
import { renderBlockHtml } from "./assistant-text";
import { useStickToBottom } from "./use-stick-to-bottom";

/** "Thought for 4s": the duration is timed in the UI between `start` and `end` (the CLI sends no
 *  duration). With `agent.show-thinking` on the row opens to the reasoning summary, streaming
 *  while it arrives; off, it keeps to the token estimate (the CLI sends no text then). */
export function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const showText = useSettingsStore((s) => s.settings["agent.show-thinking"] !== false);
  const done = block.endedAt !== null;
  const label = done
    ? `Thought for ${formatDuration(block.endedAt! - block.startedAt)}`
    : "Thinking…";
  const tokens = block.estimatedTokens ? `~${block.estimatedTokens} tokens of reasoning` : null;
  return (
    <div data-agent-thinking>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-text-muted hover:bg-[var(--item-hover-bg)]"
      >
        {done ? <Ico icon={BrainIcon} /> : <Spinner />}
        <span>{label}</span>
      </button>
      {open && (
        <div id={bodyId} className="px-2 pb-1 pl-8 text-[12px] text-text-muted">
          {showText && block.text ? (
            <ReasoningText block={block} done={done} />
          ) : (
            <p>
              {showText && done
                ? `The CLI sent no reasoning text for this step${tokens ? ` (${tokens})` : ""}.`
                : (tokens ?? (showText ? "Waiting for the reasoning…" : "Reasoning is not shown."))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The summary as light markdown in a capped box that follows the stream until the user
 *  scrolls up. */
function ReasoningText({ block, done }: { block: ThinkingBlock; done: boolean }) {
  const { ref, onScroll } = useStickToBottom(block.text);
  const html = useMemo(() => renderBlockHtml(block, done), [block, done]);
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      data-agent-thinking-text
      data-streaming={!done || undefined}
      className="agent-markdown max-h-48 overflow-y-auto italic opacity-90"
      // Sanitised by renderAgentMarkdown (shared strict DOMPurify allowlist).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
