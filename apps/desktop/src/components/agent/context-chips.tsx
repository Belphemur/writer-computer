import { Cancel01Icon, File02Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { setAgentDraft } from "@/hooks/agent-api";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { useAttachActiveNoteSetting, type Draft } from "@/hooks/use-agent";
import { contextRefLabel } from "@/lib/agent/context-text";
import type { ChatId, ContextRef } from "@/lib/agent/events";
import { Ico } from "./agent-icon";
import { openVaultPath } from "./agent-links";

function relativeTo(path: string | null, root: string | null): string | null {
  if (!path || !root) return null;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

function Chip({
  label,
  title,
  folder,
  onOpen,
  onRemove,
}: {
  label: string;
  title: string;
  folder?: boolean;
  onOpen?: () => void;
  onRemove: () => void;
}) {
  return (
    <span
      data-agent-chip
      className="inline-flex max-w-[14rem] items-center gap-1 rounded-md bg-[var(--surface-subtle)] py-0.5 pr-0.5 pl-1.5 text-[11.5px] text-text-secondary"
    >
      <Ico icon={folder ? Folder01Icon : File02Icon} size={12} className="shrink-0" />
      <button
        type="button"
        title={title}
        onClick={onOpen}
        disabled={!onOpen}
        className="min-w-0 truncate hover:underline disabled:no-underline"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="rounded p-0.5 text-text-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
      >
        <Ico icon={Cancel01Icon} size={11} />
      </button>
    </span>
  );
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** What will be sent with the next message: the active note (removable per chat) and the
 *  `@` mentions. Nothing sticky is invisible (spec 5). Sizes come with the ledger (lane 3). */
export function ContextChips({ chatId, draft }: { chatId: ChatId; draft: Draft }) {
  const root = useWorkspaceRoot();
  const allowed = useAttachActiveNoteSetting();
  const activeRel = relativeTo(useActiveFilePath(), root);
  const showActive = allowed && draft.activeNote && activeRel !== null;
  if (!showActive && draft.mentions.length === 0) return null;
  const remove = (ref: ContextRef) =>
    setAgentDraft(chatId, { mentions: draft.mentions.filter((m) => m !== ref) });
  return (
    <div
      data-agent-chips
      aria-label="Attached context"
      className="flex flex-wrap gap-1.5 px-3 pt-2"
    >
      {showActive && (
        <Chip
          label={nameOf(activeRel)}
          title={`Active note: ${activeRel}`}
          onOpen={() => openVaultPath(activeRel)}
          onRemove={() => setAgentDraft(chatId, { activeNote: false })}
        />
      )}
      {draft.mentions.map((ref, i) => (
        <Chip
          key={`${ref.kind}:${contextRefLabel(ref)}:${i}`}
          label={"label" in ref && ref.label ? ref.label : nameOf(contextRefLabel(ref))}
          title={contextRefLabel(ref)}
          folder={ref.kind === "folder"}
          onOpen={ref.kind === "note" ? () => openVaultPath(ref.path) : undefined}
          onRemove={() => remove(ref)}
        />
      ))}
    </div>
  );
}
