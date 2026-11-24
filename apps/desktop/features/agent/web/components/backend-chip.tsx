import { setAgentChatBackend, startNewAgentChat } from "@features/agent/web/hooks/agent-api";
import { useChatBackendLock } from "@features/agent/web/hooks/use-agent";
import { backendOrDefault } from "@features/agent/web/lib/backends";
import type { ChatId } from "@features/agent/web/lib/events";
import { useUsableBackends } from "@features/agent/web/stores/backend-usability";
import { ChipMenu, ChipMenuItem, ChipMenuRadio } from "./chip-menu";

/**
 * The harness chip next to the model chip: which agent the chat talks to. Drawn only while two or
 * more backends are usable (feature on, program found), so a Claude-only window has none. Before
 * the first message the menu switches the chat's backend; after it the chat keeps its backend (the
 * chip names it, locked) and the menu offers a new chat on another one. Names are the descriptor's.
 */
export function BackendChip({ chatId }: { chatId: ChatId }) {
  const { exists, backendId, projectPath, locked } = useChatBackendLock(chatId);
  const usable = useUsableBackends();
  if (!exists || usable.length < 2) return null;
  const current = backendOrDefault(backendId);
  return (
    <ChipMenu
      menuLabel="Harness"
      width={192}
      buttonProps={{
        "aria-label": `Harness: ${current.label}${locked ? " (locked)" : ""}`,
        "data-agent-backend-chip": true,
        "data-locked": locked || undefined,
        children: `${current.label} ▾`,
      }}
    >
      {(close) =>
        usable.map((b) => {
          const here = b.id === current.id;
          if (!locked || here) {
            return (
              <ChipMenuRadio
                key={b.id}
                checked={here}
                data-agent-backend-option={b.id}
                disabled={locked}
                className="disabled:opacity-100"
                onSelect={() => {
                  close();
                  setAgentChatBackend(chatId, b.id);
                }}
              >
                {b.label}
              </ChipMenuRadio>
            );
          }
          return (
            <ChipMenuItem
              key={b.id}
              data-agent-backend-new={b.id}
              onSelect={() => {
                close();
                startNewAgentChat(projectPath, b.id);
              }}
            >
              New chat with {b.product}
            </ChipMenuItem>
          );
        })
      }
    </ChipMenu>
  );
}
