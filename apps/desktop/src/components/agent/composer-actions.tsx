import { useRef, useState } from "react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import { Add01Icon, Clock01Icon, SentIcon, StopIcon } from "@hugeicons/core-free-icons";
import {
  openAgentHistory,
  setAgentPermissionMode,
  startNewAgentChat,
  stopAgent,
} from "@/hooks/agent-api";
import { useChatPermissionMode, type Chat } from "@/hooks/use-agent";
import { PERMISSION_MODE_LABEL } from "@/lib/agent/agent-settings";
import type { AgentPermissionMode, ChatId } from "@/lib/agent/events";
import { Ico } from "./agent-icon";
import { ContextRing } from "./context-ring";
import { ModelChip } from "./model-chip";
import { SkillsChip } from "./skills-chip";

const MODES = Object.keys(PERMISSION_MODE_LABEL) as AgentPermissionMode[];

/** The mode chip: a menu button listing the CLI's permission modes (never bypass). */
export function ModeChip({ chatId }: { chatId: ChatId }) {
  const mode = useChatPermissionMode(chatId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(ref, ref, () => setOpen(false), open);
  const placement = usePopoverPlacement(ref, open, { width: 176 });
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission mode: ${PERMISSION_MODE_LABEL[mode]}`}
        data-agent-mode-chip
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] text-text-secondary hover:bg-[var(--item-hover-bg)]"
      >
        {PERMISSION_MODE_LABEL[mode]} ▾
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Permission mode"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          style={placement}
          className="absolute bottom-full left-0 z-30 mb-1 overflow-y-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-1 shadow-lg"
        >
          {MODES.map((m) => (
            <button
              key={m}
              role="menuitemradio"
              aria-checked={m === mode}
              type="button"
              onClick={() => {
                setOpen(false);
                void setAgentPermissionMode(m);
              }}
              className="block w-full rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--item-hover-bg)] aria-checked:font-medium"
            >
              {m === mode ? "✓ " : ""}
              {PERMISSION_MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: typeof Add01Icon;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md p-1.5 text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
    >
      <Ico icon={icon} size={15} />
    </button>
  );
}

/** Mode chip, new chat, history, and the send/stop toggle. */
export function ComposerActions({
  chat,
  chatId,
  busy,
  stopping,
  canSend,
  onSend,
}: {
  chat: Chat;
  chatId: ChatId;
  busy: boolean;
  stopping: boolean;
  canSend: boolean;
  onSend: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 pb-2">
      <ModeChip chatId={chatId} />
      <ModelChip chatId={chatId} />
      <ContextRing chatId={chatId} />
      <SkillsChip chat={chat} />
      <span className="flex-1" />
      <IconButton label="New chat" icon={Add01Icon} onClick={() => startNewAgentChat()} />
      <IconButton label="Chat history" icon={Clock01Icon} onClick={openAgentHistory} />
      {busy && !canSend ? (
        <button
          type="button"
          aria-label={stopping ? "Stopping" : "Stop"}
          disabled={stopping}
          onClick={() => void stopAgent()}
          className="rounded-md bg-[var(--surface-selected)] p-1.5 text-text-primary hover:bg-[var(--item-active-bg)] disabled:opacity-60"
        >
          <Ico icon={StopIcon} size={15} />
        </button>
      ) : (
        <button
          type="button"
          aria-label={busy ? "Queue message" : "Send"}
          disabled={!canSend}
          onClick={onSend}
          className="rounded-md bg-[var(--accent)] p-1.5 text-[var(--bg-base)] hover:opacity-90 disabled:opacity-40"
        >
          <Ico icon={SentIcon} size={15} />
        </button>
      )}
    </div>
  );
}
