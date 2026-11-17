import { useId, useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { ThinkingBlock, ToolBlock } from "@features/agent/web/lib/transcript";
import { groupHeader } from "@features/agent/web/lib/timeline";
import { Ico, Spinner } from "./agent-icon";
import { ThinkingRow } from "./thinking-row";
import { ToolRow } from "./tool-row";

/** A run of consecutive tool and thinking rows of one assistant turn. Expanded while running or
 *  while a tool waits for permission, collapsed once the turn finishes; a click overrides. */
export function TimelineGroup({
  blocks,
  running,
}: {
  blocks: (ToolBlock | ThinkingBlock)[];
  running: boolean;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const bodyId = useId();
  const waiting = blocks.some((b) => b.kind === "tool" && b.status === "waiting");
  const open = override ?? (running || waiting);
  const live =
    running &&
    blocks.some((b) => (b.kind === "tool" ? b.status === "running" : b.endedAt === null));
  return (
    <section data-agent-group aria-label={groupHeader(blocks, false)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[12.5px] font-medium text-text-muted hover:text-text-primary"
      >
        {live ? <Spinner /> : <Ico icon={open ? ArrowDown01Icon : ArrowRight01Icon} />}
        <span>{groupHeader(blocks, live)}</span>
      </button>
      {open && (
        <div id={bodyId} className="ml-2 border-l border-[var(--line-subtler)] pl-1.5">
          {blocks.map((b) =>
            b.kind === "thinking" ? (
              <ThinkingRow key={b.id} block={b} />
            ) : (
              <ToolRow key={b.id} block={b} nested={b.parentToolCallId !== null} />
            ),
          )}
        </div>
      )}
    </section>
  );
}
