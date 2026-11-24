import { EFFORT_LEVELS } from "@/lib/features/agent-backends";
import { setAgentChatModel, setAgentDefaultModel } from "@features/agent/web/hooks/agent-api";
import { useChatModel } from "@features/agent/web/hooks/use-agent";
import { useChatModelChoices } from "@features/agent/web/hooks/use-enabled-agent-models";
import type { ChatId } from "@features/agent/web/lib/events";
import { reportedMatches, shortModelName } from "@features/agent/web/lib/model-label";
import { DEFAULT_MODEL_ID } from "@features/agent/web/lib/model-catalog";
import { backendOrDefault } from "@features/agent/web/lib/backends";
import { ChipMenu, ChipMenuItem, ChipMenuRadio } from "./chip-menu";
import { ModelList } from "./model-list";

const CHIP_EFFORTS = [null, ...EFFORT_LEVELS] as const;
const effortLabel = (e: (typeof CHIP_EFFORTS)[number]) => (e === null ? "Default" : e);

/** The model chip: the model the chat runs (the CLI's own report wins once a turn has finished),
 *  a menu of the enabled models, the effort when the model takes one, and "Set as default". */
export function ModelChip({ chatId }: { chatId: ChatId }) {
  const { choice, reported, sessionModel, pending, backendId } = useChatModel(chatId);
  const backend = backendOrDefault(backendId);
  const models = useChatModelChoices(backendId, { currentModel: choice.model, sessionModel });
  // a live list names its models; Claude's ids are shortened by `shortModelName`
  const nameOf = (id: string) =>
    backend.modelsSource === "live" && id !== DEFAULT_MODEL_ID
      ? (models.find((m) => m.id === id)?.label ?? shortModelName(id))
      : shortModelName(id);
  const requestedId = choice.model ?? DEFAULT_MODEL_ID;
  const current = models.find((m) => m.id === requestedId);
  const matches = reportedMatches(choice.model, reported);
  // Pending: the selection, at once. Applied: what the CLI says it runs (it wins over the request).
  const label = nameOf(pending ? requestedId : (reported ?? requestedId));

  return (
    <ChipMenu
      menuLabel="Model"
      width={224}
      maxHeight={480}
      buttonProps={{
        "aria-label": `Model: ${label}`,
        title: pending
          ? `Switching to ${nameOf(requestedId)}`
          : reported && !matches
            ? `Requested ${nameOf(requestedId)}, running ${nameOf(reported)}`
            : undefined,
        "data-agent-model-chip": true,
        "data-pending": pending || undefined,
        className: "data-[pending]:italic data-[pending]:opacity-70",
        children: `${label}${pending ? "…" : ""} ▾`,
      }}
    >
      {(close) => (
        <>
          <ModelList
            models={models}
            selectedId={requestedId}
            onPick={(m) => {
              close();
              void setAgentChatModel(m.value, m.supportsEffort ? undefined : null);
            }}
          />
          {current?.supportsEffort !== false && (
            <>
              <div className="mt-1 border-t border-[var(--line-subtle)] px-2 pt-1.5 text-[10.5px] text-text-muted">
                {backend.effortRestarts ? "Effort (restarts the session)" : "Effort"}
              </div>
              {CHIP_EFFORTS.filter(
                (e) => e === null || !current?.efforts || current.efforts.includes(e),
              ).map((e) => (
                <ChipMenuRadio
                  key={e ?? "default"}
                  size="sm"
                  aria-label={`Effort ${effortLabel(e)}`}
                  checked={e === choice.effort}
                  onSelect={() => {
                    close();
                    void setAgentChatModel(choice.model, e);
                  }}
                >
                  {effortLabel(e)}
                </ChipMenuRadio>
              ))}
            </>
          )}
          <ChipMenuItem
            size="sm"
            className="mt-1 border-t border-[var(--line-subtle)] text-text-secondary"
            onSelect={() => {
              close();
              void setAgentDefaultModel(choice, backendId);
            }}
          >
            Set as default
          </ChipMenuItem>
          {pending ? (
            <div data-agent-model-footer className="px-2 py-1 text-[10.5px] text-text-muted">
              Switching to {nameOf(requestedId)}…
            </div>
          ) : (
            reported &&
            !matches && (
              <div data-agent-model-footer className="px-2 py-1 text-[10.5px] text-text-muted">
                Running {nameOf(reported)}
              </div>
            )
          )}
        </>
      )}
    </ChipMenu>
  );
}
