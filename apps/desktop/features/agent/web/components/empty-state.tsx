import {
  setAgentChatBackend,
  setAgentDraft,
  detectAgentBinary,
} from "@features/agent/web/hooks/agent-api";
import { useAgentBackend, useAgentBinary, useAgentChat } from "@features/agent/web/hooks/use-agent";
import { backendOrDefault } from "@features/agent/web/lib/backends";
import type { ChatId } from "@features/agent/web/lib/events";
import { useUsableBackends } from "@features/agent/web/stores/backend-usability";
import { openExternal } from "@/lib/link-activation";
import { Button, chooseBinary } from "./error-card";

/** Static, no AI: three starting points that only fill the composer. */
export const SUGGESTIONS = [
  "Summarize the note I have open",
  "Find notes related to this one and list them",
  "Draft an outline for a new note about…",
] as const;

export function BinaryMissingCard({ backendId }: { backendId: string }) {
  const backend = backendOrDefault(backendId);
  return (
    <div
      role="alert"
      data-agent-binary-missing
      className="rounded-xl border border-[var(--agent-warn)] bg-[var(--surface-card)] p-3 text-[13px]"
    >
      <p className="font-medium">{backend.product} was not found</p>
      <p className="mt-1 text-text-secondary">
        Writer looks for the <code>{backend.program}</code> program on your PATH, your login shell
        PATH and the usual install folders. Install {backend.product} or choose where it is.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button onClick={() => void chooseBinary(backend.id)}>Choose binary…</Button>
        {backend.installUrl && (
          <Button onClick={() => void openExternal(backend.installUrl!)}>
            Install {backend.product}
          </Button>
        )}
        <Button onClick={() => void detectAgentBinary(backend.id)}>Check again</Button>
      </div>
    </div>
  );
}

/** Which agent a new chat talks to: only offered while two or more are usable (feature on, program
 *  found), so a Claude-only window has no picker. */
export function BackendPicker({ chatId, active }: { chatId: ChatId; active: string }) {
  const usable = useUsableBackends();
  if (usable.length < 2) return null;
  return (
    <div
      role="radiogroup"
      aria-label="Choose agent"
      data-agent-backend-picker
      className="flex gap-1.5"
    >
      {usable.map((b) => (
        <button
          key={b.id}
          type="button"
          role="radio"
          aria-checked={b.id === active}
          data-agent-backend-option={b.id}
          onClick={() => setAgentChatBackend(chatId, b.id)}
          className="rounded-full border border-[var(--line-subtle)] px-3 py-1 text-[12.5px] text-text-secondary hover:bg-[var(--item-hover-bg)] aria-checked:border-transparent aria-checked:bg-[var(--accent)] aria-checked:text-white"
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ chatId }: { chatId: ChatId }) {
  const chat = useAgentChat(chatId);
  const backend = backendOrDefault(chat?.backendId);
  const binary = useAgentBinary(backend.id);
  const transport = useAgentBackend();
  return (
    <div
      data-agent-empty
      className="flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto px-5 py-6"
    >
      <div>
        <h2 className="text-[15px] font-medium text-text-primary">Ask your agent</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
          Chat with {backend.product} in this vault. It reads your notes, and asks before it changes
          anything. Use @ to add notes or folders as context.
        </p>
      </div>
      <BackendPicker chatId={chatId} active={backend.id} />
      {binary?.found === false && <BinaryMissingCard backendId={backend.id} />}
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
      {transport === "mock" && (
        <p data-agent-demo className="text-[12px] text-text-muted">
          Demo backend: replies are recorded sessions. Try the words <em>write</em> (permission),{" "}
          <em>deny</em>, <em>stop</em>, <em>read</em> (tools) or <em>again</em> (two turns).
        </p>
      )}
    </div>
  );
}
