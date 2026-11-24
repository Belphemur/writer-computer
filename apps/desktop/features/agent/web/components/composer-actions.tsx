import { Add01Icon, Clock01Icon, SentIcon, StopIcon } from "@hugeicons/core-free-icons";
import {
  openAgentHistory,
  setAgentPermissionMode,
  startNewAgentChat,
  stopAgent,
} from "@features/agent/web/hooks/agent-api";
import { useChatPermissionMode, type Chat } from "@features/agent/web/hooks/use-agent";
import { PERMISSION_MODE_LABEL } from "@features/agent/web/lib/agent-settings";
import type { AgentPermissionMode, ChatId } from "@features/agent/web/lib/events";
import { Ico } from "./agent-icon";
import { ContextRing } from "./context-ring";
import { BackendChip } from "./backend-chip";
import { ChipMenu, ChipMenuRadio } from "./chip-menu";
import { ModelChip } from "./model-chip";
import { SkillsChip } from "./skills-chip";

const MODES = Object.keys(PERMISSION_MODE_LABEL) as AgentPermissionMode[];

/** The mode chip: a menu button listing the CLI's permission modes (never bypass). */
export function ModeChip({ chatId }: { chatId: ChatId }) {
  const mode = useChatPermissionMode(chatId);
  return (
    <ChipMenu
      menuLabel="Permission mode"
      width={176}
      buttonProps={{
        "aria-label": `Permission mode: ${PERMISSION_MODE_LABEL[mode]}`,
        "data-agent-mode-chip": true,
        children: `${PERMISSION_MODE_LABEL[mode]} ▾`,
      }}
    >
      {(close) =>
        MODES.map((m) => (
          <ChipMenuRadio
            key={m}
            checked={m === mode}
            onSelect={() => {
              close();
              void setAgentPermissionMode(m);
            }}
          >
            {PERMISSION_MODE_LABEL[m]}
          </ChipMenuRadio>
        ))
      }
    </ChipMenu>
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
      <BackendChip chatId={chatId} />
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
          title={
            busy && chat.pendingPermissions.length === 0
              ? "Enter sends at the next step, Cmd+Enter sends now (stops the current step)"
              : "Send"
          }
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
