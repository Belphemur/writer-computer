import { Cancel01Icon, File02Icon, Folder01Icon, Pdf02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { setAgentDraft } from "@features/agent/web/hooks/agent-api";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { relativeInVault } from "@/lib/paths";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { useAttachActiveNoteSetting, type Draft } from "@features/agent/web/hooks/use-agent";
import { contextRefLabel } from "@features/agent/web/lib/context-text";
import { IMAGE_TOKEN_ESTIMATE } from "@features/agent/web/lib/chat-files";
import { pageCountOf } from "@features/agent/web/lib/pdf-pages";
import type { ChatId, ContextRef } from "@features/agent/web/lib/events";
import { Ico } from "./agent-icon";
import { vaultLinkHandlers } from "./agent-links";
import { ChatImageThumb } from "./chat-image-thumb";

function Chip({
  label,
  title,
  folder,
  pdf,
  imagePath,
  openPath,
  onRemove,
}: {
  label: string;
  title: string;
  folder?: boolean;
  /** A PDF chip: the PDF icon instead of the file icon. */
  pdf?: boolean;
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
      data-agent-chip-pdf={pdf ? "" : undefined}
      className="inline-flex max-w-[14rem] items-center gap-1 rounded-md bg-[var(--surface-subtle)] py-0.5 pr-0.5 pl-1.5 text-[11.5px] text-text-secondary"
    >
      {imagePath ? (
        <ChatImageThumb path={imagePath} className="size-5 shrink-0 rounded-[3px]" />
      ) : (
        <Ico
          icon={folder ? Folder01Icon : pdf ? Pdf02Icon : File02Icon}
          size={12}
          className="shrink-0"
        />
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

/** `paper.pdf, 12 pages`: the name with the page count once the PDF feature has counted it. */
function usePdfLabel(root: string | null, path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const [pages, setPages] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void pageCountOf(root, path).then((n) => live && setPages(n));
    return () => {
      live = false;
    };
  }, [root, path]);
  return pages === null ? name : `${name} · ${pages} ${pages === 1 ? "page" : "pages"}`;
}

/** A chip for a PDF in the draft. */
function PdfChip({
  root,
  path,
  onRemove,
}: {
  root: string | null;
  path: string;
  onRemove: () => void;
}) {
  return (
    <Chip
      label={usePdfLabel(root, path)}
      title={`${path} (PDF)`}
      pdf
      openPath={path}
      onRemove={onRemove}
    />
  );
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** What will be sent with the next message: the active note (removable per chat) and the
 *  `@` mentions. Nothing sticky is invisible (spec 5). Sizes come with the ledger (lane 3). */
export function ContextChips({ chatId, draft }: { chatId: ChatId; draft: Draft }) {
  const root = useWorkspaceRoot();
  const allowed = useAttachActiveNoteSetting();
  const activePath = useActiveFilePath();
  const activeRel = activePath && root ? relativeInVault(activePath, root) : null;
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
      {draft.mentions.map((ref, i) =>
        ref.kind === "document" ? (
          <PdfChip
            key={`document:${ref.path}:${i}`}
            root={root}
            path={ref.path}
            onRemove={() => remove(ref)}
          />
        ) : (
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
        ),
      )}
    </div>
  );
}
