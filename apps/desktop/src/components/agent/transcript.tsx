import type { Chat } from "@/lib/agent/transcript";
import { segmentTurn } from "@/lib/agent/timeline";
import { AssistantText } from "./assistant-text";
import { ErrorCard } from "./error-card";
import { TimelineGroup } from "./timeline-group";
import { TurnFooter } from "./turn-footer";
import { useStickToBottom } from "./use-stick-to-bottom";
import { UserTurnCard } from "./user-turn-card";

/** Many turns: finished ones skip layout and paint until near the viewport (spec 3.5). */
const WINDOW_AFTER_TURNS = 30;

function lastFinalText(chat: Chat): string {
  for (let t = chat.turns.length - 1; t >= 0; t--) {
    const blocks = chat.turns[t]!.blocks;
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b]!;
      if (block.kind === "text" && block.final) return block.text;
    }
  }
  return "";
}

export function Transcript({ chat }: { chat: Chat }) {
  const last = chat.turns[chat.turns.length - 1];
  const { ref, onScroll } = useStickToBottom(chat);
  const windowed = chat.turns.length > WINDOW_AFTER_TURNS;
  return (
    <>
      {/* Announced once per finished assistant text, never per delta (spec 3.7). */}
      <div className="sr-only" aria-live="polite" data-agent-live>
        {lastFinalText(chat)}
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label="Agent conversation"
        data-agent-transcript
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3"
      >
        {chat.turns.map((turn, i) => (
          <div
            key={turn.id}
            data-agent-turn
            className="space-y-2"
            style={
              windowed && i < chat.turns.length - 1
                ? { contentVisibility: "auto", containIntrinsicSize: "auto 240px" }
                : undefined
            }
          >
            {turn.user && <UserTurnCard message={turn.user} />}
            {segmentTurn(turn).map((seg) =>
              seg.kind === "text" ? (
                <AssistantText key={seg.block.id} block={seg.block} />
              ) : (
                <TimelineGroup
                  key={seg.id}
                  blocks={seg.blocks}
                  running={turn.status === "running"}
                />
              ),
            )}
            <TurnFooter turn={turn} />
          </div>
        ))}
        {chat.banner && (
          <p role="status" data-agent-banner className="px-1 text-[12.5px] text-text-muted">
            {chat.banner}
          </p>
        )}
        {chat.state === "starting" && !last?.blocks.length && (
          <p role="status" className="px-1 text-[12.5px] text-text-muted">
            Starting Claude…
          </p>
        )}
        <ErrorCard chat={chat} />
      </div>
    </>
  );
}
