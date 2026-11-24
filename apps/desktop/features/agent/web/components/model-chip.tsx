import { useEffect, useRef, useState } from "react";
import { EFFORT_LEVELS } from "@/lib/features/agent-backends";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import { setAgentChatModel, setAgentDefaultModel } from "@features/agent/web/hooks/agent-api";
import { useChatModel } from "@features/agent/web/hooks/use-agent";
import { useChatModelChoices } from "@features/agent/web/hooks/use-enabled-agent-models";
import type { ChatId } from "@features/agent/web/lib/events";
import { reportedMatches, shortModelName } from "@features/agent/web/lib/model-label";
import { DEFAULT_MODEL_ID } from "@features/agent/web/lib/model-catalog";
import { backendOrDefault } from "@features/agent/web/lib/backends";

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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(wrapRef, wrapRef, () => setOpen(false), open);
  const placement = usePopoverPlacement(wrapRef, open, { width: 224, maxHeight: 480 });
  const requestedId = choice.model ?? DEFAULT_MODEL_ID;
  const current = models.find((m) => m.id === requestedId);
  const matches = reportedMatches(choice.model, reported);
  // Pending: the selection, at once. Applied: what the CLI says it runs (it wins over the request).
  const label = nameOf(pending ? requestedId : (reported ?? requestedId));

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]");
    const checked = menuRef.current?.querySelector<HTMLElement>("[aria-checked=true]");
    (checked ?? items?.[0])?.focus();
  }, [open]);

  const move = (delta: 1 | -1) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + delta + items.length) % items.length]?.focus();
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        title={
          pending
            ? `Switching to ${nameOf(requestedId)}`
            : reported && !matches
              ? `Requested ${nameOf(requestedId)}, running ${nameOf(reported)}`
              : undefined
        }
        data-agent-model-chip
        data-pending={pending || undefined}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] text-text-secondary hover:bg-[var(--item-hover-bg)] data-[pending]:italic data-[pending]:opacity-70"
      >
        {label}
        {pending ? "…" : ""} ▾
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Model"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            }
          }}
          style={placement}
          className="absolute bottom-full left-0 z-30 mb-1 overflow-y-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-1 shadow-lg"
        >
          {models.map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={m.id === requestedId}
              type="button"
              onClick={() => {
                setOpen(false);
                void setAgentChatModel(m.value, m.supportsEffort ? undefined : null);
              }}
              className="block w-full rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--item-hover-bg)] aria-checked:font-medium"
            >
              {m.id === requestedId ? "✓ " : ""}
              {m.label}
            </button>
          ))}
          {current?.supportsEffort !== false && (
            <>
              <div className="mt-1 border-t border-[var(--line-subtle)] px-2 pt-1.5 text-[10.5px] text-text-muted">
                {backend.effortRestarts ? "Effort (restarts the session)" : "Effort"}
              </div>
              {CHIP_EFFORTS.filter(
                (e) => e === null || !current?.efforts || current.efforts.includes(e),
              ).map((e) => (
                <button
                  key={e ?? "default"}
                  role="menuitemradio"
                  aria-label={`Effort ${effortLabel(e)}`}
                  aria-checked={e === choice.effort}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void setAgentChatModel(choice.model, e);
                  }}
                  className="block w-full rounded-md px-2 py-1 text-left text-[12px] hover:bg-[var(--item-hover-bg)] aria-checked:font-medium"
                >
                  {e === choice.effort ? "✓ " : ""}
                  {effortLabel(e)}
                </button>
              ))}
            </>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              void setAgentDefaultModel(choice, backendId);
            }}
            className="mt-1 block w-full rounded-md border-t border-[var(--line-subtle)] px-2 py-1.5 text-left text-[12px] text-text-secondary hover:bg-[var(--item-hover-bg)]"
          >
            Set as default
          </button>
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
        </div>
      )}
    </div>
  );
}
