import { setAgentDraft, detectAgentBinary } from "@features/agent/web/hooks/agent-api";
import { useAgentBackend, useAgentBinary } from "@features/agent/web/hooks/use-agent";
import type { ChatId } from "@features/agent/web/lib/events";
import { openExternal } from "@/lib/link-activation";
import { Button, chooseBinary, INSTALL_URL } from "./error-card";

/** Static, no AI: three starting points that only fill the composer. */
export const SUGGESTIONS = [
  "Summarize the note I have open",
  "Find notes related to this one and list them",
  "Draft an outline for a new note about…",
] as const;

export function BinaryMissingCard() {
  return (
    <div
      role="alert"
      data-agent-binary-missing
      className="rounded-xl border border-[var(--agent-warn)] bg-[var(--surface-card)] p-3 text-[13px]"
    >
      <p className="font-medium">Claude Code was not found</p>
      <p className="mt-1 text-text-secondary">
        Writer looks for the <code>claude</code> program on your PATH, your login shell PATH and the
        usual install folders. Install Claude Code or choose where it is.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button onClick={() => void chooseBinary()}>Choose binary…</Button>
        <Button onClick={() => void openExternal(INSTALL_URL)}>Install Claude Code</Button>
        <Button onClick={() => void detectAgentBinary()}>Check again</Button>
      </div>
    </div>
  );
}

export function EmptyState({ chatId }: { chatId: ChatId }) {
  const binary = useAgentBinary();
  const backend = useAgentBackend();
  return (
    <div
      data-agent-empty
      className="flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto px-5 py-6"
    >
      <div>
        <h2 className="text-[15px] font-medium text-text-primary">Ask your agent</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
          Chat with Claude Code in this vault. It reads your notes, and asks before it changes
          anything. Use @ to add notes or folders as context.
        </p>
      </div>
      {binary?.found === false && <BinaryMissingCard />}
      <ul className="space-y-1.5" aria-label="Suggestions">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setAgentDraft(chatId, { text: s })}
              className="w-full rounded-lg border border-[var(--line-subtler)] px-3 py-2 text-left text-[13px] text-text-secondary hover:bg-[var(--item-hover-bg)]"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
      {backend === "mock" && (
        <p data-agent-demo className="text-[12px] text-text-muted">
          Demo backend: replies are recorded sessions. Try the words <em>write</em> (permission),{" "}
          <em>deny</em>, <em>stop</em>, <em>read</em> (tools) or <em>again</em> (two turns).
        </p>
      )}
    </div>
  );
}
