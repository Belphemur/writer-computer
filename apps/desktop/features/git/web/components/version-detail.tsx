// The selected version of the History tab: its header (date, time, who, message), the actions
// (Restore, Copy, Open, Open chat) and what it changed, through the one diff component.
import { useEffect, useState } from "react";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { TextDiffView } from "@/components/diff/text-diff-view";
import { openGitHistoryTab } from "@/hooks/editor-api";
import { copyText } from "@/lib/copy-text";
import { getService } from "@/lib/features/services";
import { reloadOpenNoteAfterWrite } from "@/lib/open-note-sync";
import { flushSave } from "@/lib/save";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { describeError, logger } from "@/lib/logger";
import type { AgentChatsService } from "@features/agent/web/api";
import {
  restore,
  versionDiff,
  versionText,
  type FileDiff,
  type Preview,
  type VersionRow,
} from "../ipc";
import { countsLabel, fileTitle, labelOf, timeLabel } from "../lib/history";

const AGENT_CHATS = "agent.chats";
const BUTTON =
  "rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none disabled:opacity-50";

/** What to compare the selected version with: its previous version, the file now, or another version. */
export type Against = { kind: "parent" } | { kind: "current" } | { kind: "version"; rev: string };

/** The vault-relative form of a tab's absolute `path`, what the engine reports paths as. */
function relativeTo(path: string): string {
  const root = useWorkspaceStore.getState().root?.replace(/\/$/, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export const againstArg = (a: Against) => (a.kind === "version" ? a.rev : a.kind);

export function useVersionDiff(path: string, rev: string, against: Against) {
  const [state, setState] = useState<{ diff: FileDiff | null; error: string | null }>({
    diff: null,
    error: null,
  });
  const arg = againstArg(against);
  useEffect(() => {
    let current = true;
    setState({ diff: null, error: null });
    versionDiff(path, rev, arg).then(
      (diff) => current && setState({ diff, error: null }),
      (e) => current && setState({ diff: null, error: describeError(e).message }),
    );
    return () => {
      current = false;
    };
  }, [path, rev, arg]);
  return state;
}

const bytes = (n: number | null) => (n === null ? "none" : `${n.toLocaleString()} bytes`);

function Side({ title, preview }: { title: string; preview: Preview | null }) {
  return (
    <figure data-diff-image={title.toLowerCase()} className="min-w-0 flex-1 space-y-1">
      <figcaption className="text-[11px] text-[var(--text-muted)]">{title}</figcaption>
      {preview === null ? (
        <p className="text-[12px] text-[var(--text-muted)]">None</p>
      ) : preview.data ? (
        <img
          alt={title}
          src={`data:${preview.mime};base64,${preview.data}`}
          className="max-h-80 max-w-full rounded-md border border-[var(--border-color)] object-contain"
        />
      ) : (
        <p className="text-[12px] text-[var(--text-muted)]">{bytes(preview.size)}</p>
      )}
    </figure>
  );
}

export function DiffBody({ diff, label }: { diff: FileDiff; label: string }) {
  if (diff.kind === "text") return <TextDiffView diff={diff.diff} label={label} className="" />;
  if (diff.kind === "image")
    return (
      <div className="flex gap-4">
        <Side title="Before" preview={diff.before} />
        <Side title="After" preview={diff.after} />
      </div>
    );
  return (
    <p data-diff-binary className="text-[12px] text-[var(--text-muted)]">
      Before: {bytes(diff.beforeSize)}. After: {bytes(diff.afterSize)}.
    </p>
  );
}

export function VersionDetail({
  path,
  version,
  against,
  onAgainst,
  onRestored,
}: {
  path: string;
  version: VersionRow;
  against: Against;
  onAgainst: (a: Against) => void;
  /** After a restore: the vault-relative path that holds the content now. */
  onRestored: (relPath: string) => void;
}) {
  const { diff, error } = useVersionDiff(path, version.rev, against);
  const [busy, setBusy] = useState(false);
  const label = labelOf(version);
  const when = new Date((version.time ?? 0) * 1000);
  const chats = getService<AgentChatsService>(AGENT_CHATS);
  const counts = countsLabel(version);

  const doRestore = async () => {
    setBusy(true);
    try {
      // an open, edited tab goes to disk first (so the restore keeps it as a version), and shows
      // the restored text afterwards through the same reload the file watcher uses
      await flushSave(path);
      const done = await restore(path, version.rev);
      showEditorNotice(
        done.path === relativeTo(path) ? "Restored" : `Restored as ${fileTitle(done.path)}`,
      );
      if (done.path === relativeTo(path)) await reloadOpenNoteAfterWrite(path);
      onRestored(done.path);
    } catch (e) {
      logger.warn("git", "restore failed");
      showEditorNotice(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const doCopy = async () => {
    try {
      const text = await versionText(path, version.rev);
      if (text === null) return showEditorNotice("Nothing to copy");
      await copyText(text);
    } catch (e) {
      showEditorNotice(describeError(e).message);
    }
  };

  return (
    <section data-git-version={version.rev} className="min-w-0 space-y-3">
      <header className="sticky top-0 z-10 space-y-2 bg-[var(--bg-base)] pb-2">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className="font-medium text-[var(--text-primary)]">
            {when.toLocaleDateString(undefined, { dateStyle: "medium" })},{" "}
            {timeLabel(version.time ?? 0)}
          </span>
          {label.badge && (
            <span
              data-git-badge={label.badge}
              className="rounded-full bg-[var(--surface-subtle)] px-1.5 text-[10.5px] leading-4 text-[var(--text-muted)]"
            >
              {label.agent ?? (label.badge === "device" ? "Device" : "Writer")}
            </span>
          )}
          {label.models.length > 0 && (
            <span className="text-[11.5px] text-[var(--text-muted)]">
              {label.models.join(", ")}
            </span>
          )}
          {counts && <span className="text-[11.5px] text-[var(--text-muted)]">{counts}</span>}
        </div>
        <p className="text-[13px] text-[var(--text-primary)]">{version.subject}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void doRestore()}>
            Restore
          </button>
          <button type="button" className={BUTTON} onClick={() => void doCopy()}>
            Copy
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => openGitHistoryTab({ path, rev: version.rev, version: true })}
          >
            Open
          </button>
          {version.type === "agent" && version.chat && chats && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => void chats.openChat(version.chat!)}
            >
              Open chat
            </button>
          )}
          <button
            type="button"
            className={BUTTON}
            aria-pressed={against.kind === "current"}
            onClick={() =>
              onAgainst(against.kind === "current" ? { kind: "parent" } : { kind: "current" })
            }
          >
            Compare with current
          </button>
        </div>
        {against.kind === "version" && (
          <p className="text-[11.5px] text-[var(--text-muted)]">
            Compared with another version.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => onAgainst({ kind: "parent" })}
            >
              Clear
            </button>
          </p>
        )}
      </header>
      {error ? (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </p>
      ) : diff ? (
        <DiffBody diff={diff} label={`Changes in ${fileTitle(version.path)}`} />
      ) : (
        <p className="text-[12px] text-[var(--text-muted)]">Loading</p>
      )}
    </section>
  );
}
