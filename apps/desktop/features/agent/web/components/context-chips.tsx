import { Cancel01Icon, File02Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { setAgentDraft } from "@features/agent/web/hooks/agent-api";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { useAttachActiveNoteSetting, type Draft } from "@features/agent/web/hooks/use-agent";
import { contextRefLabel } from "@features/agent/web/lib/context-text";
import { IMAGE_TOKEN_ESTIMATE } from "@features/agent/web/lib/chat-images";
import type { ChatId, ContextRef } from "@features/agent/web/lib/events";
import { Ico } from "./agent-icon";
import { vaultLinkHandlers } from "./agent-links";
import { ChatImageThumb } from "./chat-image-thumb";

function relativeTo(path: string | null, root: string | null): string | null {
  if (!path || !root) return null;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

function Chip({
  label,
  title,
  folder,
  imagePath,
  openPath,
  onRemove,
}: {
  label: string;
  title: string;
  folder?: boolean;
  /** An image chip: a thumbnail instead of the file icon. */
  imagePath?: string;
  /** Vault-relative path a click opens (a link: left, middle and modifier clicks). */
  openPath?: string;
  onRemove: () => void;
}) {
  return (
    <span
      data-agent-chip
      data-agent-chip-image={imagePath ? "" : undefined}
      className="inline-flex max-w-[14rem] items-center gap-1 rounded-md bg-[var(--surface-subtle)] py-0.5 pr-0.5 pl-1.5 text-[11.5px] text-text-secondary"
    >
      {imagePath ? (
        <ChatImageThumb path={imagePath} className="size-5 shrink-0 rounded-[3px]" />
      ) : (
        <Ico icon={folder ? Folder01Icon : File02Icon} size={12} className="shrink-0" />
      )}
      <button
        type="button"
        title={title}
        {...(openPath ? vaultLinkHandlers(openPath) : {})}
        disabled={!openPath}
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
          openPath={activeRel}
          onRemove={() => setAgentDraft(chatId, { activeNote: false })}
        />
      )}
      {draft.mentions.map((ref, i) => (
        <Chip
          key={`${ref.kind}:${contextRefLabel(ref)}:${i}`}
          label={"label" in ref && ref.label ? ref.label : nameOf(contextRefLabel(ref))}
          title={
            ref.kind === "image"
              ? `${ref.path} (image, about ${IMAGE_TOKEN_ESTIMATE.toLocaleString("en-US")} tokens)`
              : contextRefLabel(ref)
          }
          folder={ref.kind === "folder"}
          imagePath={ref.kind === "image" ? ref.path : undefined}
          openPath={ref.kind === "note" || ref.kind === "image" ? ref.path : undefined}
          onRemove={() => remove(ref)}
        />
      ))}
    </div>
  );
}
