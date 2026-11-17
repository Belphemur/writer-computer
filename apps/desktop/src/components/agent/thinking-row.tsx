import { useId, useState } from "react";
import { BrainIcon } from "@hugeicons/core-free-icons";
import type { ThinkingBlock } from "@/lib/agent/transcript";
import { formatDuration } from "@/lib/agent/timeline";
import { Ico, Spinner } from "./agent-icon";

/** "Thought for 4s": the duration is timed in the UI between `start` and `end` (the CLI sends
 *  no thinking text, only a token estimate). */
export function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const done = block.endedAt !== null;
  const label = done
    ? `Thought for ${formatDuration(block.endedAt! - block.startedAt)}`
    : "Thinking…";
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
          {block.text ? (
            <p className="whitespace-pre-wrap">{block.text}</p>
          ) : (
            <p>
              {block.estimatedTokens
                ? `~${block.estimatedTokens} tokens of reasoning`
                : "Reasoning is not shown."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
