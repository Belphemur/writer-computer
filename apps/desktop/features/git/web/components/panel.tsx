// The sidebar panel: the files changed since the last version, when the last version was saved,
// "Commit now" and "Pause". Local mode only (no remote yet). Terse: no prose.
import { useEffect, useState } from "react";
import { showNativeContextMenu } from "@/components/editor-area/editor-context-menu";
import { openGitHistoryTab, openSettings } from "@/hooks/editor-api";
import { linkHandlers } from "@/lib/link-activation";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { describeError, logger } from "@/lib/logger";
import { formatRelativeTime } from "@/lib/relative-time";
import { commitNow, deleted, setPaused, setSyncPaused, syncNow, type DeletedRow } from "../ipc";
import {
  BinaryConflicts,
  Conflicts,
  HeldPlugins,
  lastSyncLabel,
  Notices,
  BUTTON,
  SyncError,
} from "./sync-parts";
import { showHistoryItems } from "../menus";
import { fileLabel, IDENTITY_COMMANDS, KIND_LABEL, summarize } from "../lib/state";
import { useGitStatus } from "../lib/status-store";

/** The most Deleted rows shown at first; "Show more" lifts it. */
export const DELETED_CAP = 200;

/** The files removed from the vault, newest first: each opens its History tab, where the last
 *  version can be restored. A click with Cmd/Ctrl or the middle button opens it in the background. */
function DeletedFiles() {
  const root = useWorkspaceStore((s) => s.root);
  const stamp = useGitStatus((s) => s.status?.lastCommit ?? 0);
  const [rows, setRows] = useState<DeletedRow[]>([]);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let current = true;
    deleted().then(
      (r) => current && setRows(r),
      () => logger.warn("git", "could not list the deleted files"),
    );
    return () => {
      current = false;
    };
  }, [stamp]);
  if (!root || rows.length === 0) return null;
  const base = root.replace(/\/$/, "");
  const shown = all ? rows : rows.slice(0, DELETED_CAP);
  return (
    <section data-git-deleted aria-label="Deleted" className="min-h-0">
      <h3 className="pb-1 text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
        Deleted
      </h3>
      <ul className="min-h-0 overflow-auto">
        {shown.map((d) => {
          const path = `${base}/${d.path}`;
          const handlers = linkHandlers({
            kind: "custom",
            open: (intent) =>
              openGitHistoryTab({ path }, { activate: intent !== "new-tab-background" }),
          });
          return (
            <li key={d.path}>
              <button
                type="button"
                data-git-deleted-file={d.path}
                title={d.path}
                {...handlers}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void showNativeContextMenu(showHistoryItems(path));
                }}
                className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none"
              >
                <span className="truncate text-[var(--text-primary)]">{fileLabel(d.path)}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">
                  {d.time ? formatRelativeTime(d.time) : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {shown.length < rows.length && (
        <button
          type="button"
          data-git-deleted-more
          className="px-1 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:text-[var(--text-primary)]"
          onClick={() => setAll(true)}
        >
          Show more
        </button>
      )}
    </section>
  );
}

/** Files over the size limit, which Writer leaves out of the history: the count, the names on click. */
function TooLarge({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false);
  if (names.length === 0) return null;
  return (
    <section data-git-too-large className="text-xs text-[var(--text-muted)]">
      <button
        type="button"
        aria-expanded={open}
        className="hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:text-[var(--text-primary)]"
        onClick={() => setOpen(!open)}
      >
        Not versioned: too large ({names.length})
      </button>
      {open && (
        <ul className="mt-1">
          {names.map((n) => (
            <li key={n} className="truncate" title={n}>
              {n}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function GitPanel() {
  const status = useGitStatus((s) => s.status);
  const apply = useGitStatus((s) => s.apply);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: () => ReturnType<typeof commitNow>) => {
    setBusy(true);
    setFailure(null);
    try {
      apply(await action());
    } catch (e) {
      logger.warn("git", "an action failed");
      setFailure(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const summary = summarize(status);
  if (!status || !summary) {
    return (
      <div data-git-panel className="p-3 text-[13px] text-[var(--text-muted)]">
        Not set up. Choose it in Settings, Git.
      </div>
    );
  }
  const linked = status.remote !== null;
  const last = linked
    ? lastSyncLabel(status.lastSync)
    : status.lastCommit
      ? `Saved ${formatRelativeTime(status.lastCommit)}`
      : null;
  return (
    <div data-git-panel className="flex min-h-0 flex-col gap-3 p-3 text-[13px]">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-[var(--text-primary)]">{summary.label}</span>
        {last && <span className="text-xs text-[var(--text-muted)]">{last}</span>}
      </div>
      {linked && (
        <p
          data-git-remote
          className="truncate text-xs text-[var(--text-muted)]"
          title={status.remote ?? ""}
        >
          {status.remote}
        </p>
      )}
      <SyncError />
      {summary.tone === "error" && !status.syncError && status.conflicts.length === 0 && (
        <div role="alert" className="text-xs text-[var(--text-primary)]">
          <p>{summary.detail}</p>
          {status.identityError && (
            <pre className="mt-1 whitespace-pre-wrap text-[var(--text-muted)]">
              {IDENTITY_COMMANDS.join("\n")}
            </pre>
          )}
        </div>
      )}
      {status.operation && (
        <p data-git-operation className="text-xs text-[var(--text-muted)]">
          {summary.detail}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-xs text-[var(--text-primary)]">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {linked && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy || status.syncing || status.identityError}
            onClick={() => void run(syncNow)}
          >
            Sync now
          </button>
        )}
        <button
          type="button"
          className={BUTTON}
          disabled={busy || status.changes.length === 0 || status.identityError}
          onClick={() => void run(commitNow)}
        >
          Commit now
        </button>
        {linked ? (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void run(() => setSyncPaused(!status.syncPaused))}
          >
            {status.syncPaused ? "Resume sync" : "Pause sync"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void run(() => setPaused(!status.paused))}
            >
              {status.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className={BUTTON} onClick={() => openSettings("git")}>
              Add a remote
            </button>
          </>
        )}
      </div>
      <Conflicts />
      <BinaryConflicts />
      <HeldPlugins />
      <Notices />
      {status.changes.length > 0 && (
        <ul className="min-h-0 overflow-auto" aria-label="Changed files">
          {status.changes.map((c) => (
            <li
              key={`${c.kind}:${c.path}`}
              data-git-change={c.kind}
              className="flex items-baseline justify-between gap-2 py-0.5"
              title={c.from ? `${c.from} → ${c.path}` : c.path}
            >
              <span className="truncate text-[var(--text-primary)]">{fileLabel(c.path)}</span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">
                {KIND_LABEL[c.kind] ?? c.kind}
              </span>
            </li>
          ))}
        </ul>
      )}
      <TooLarge names={status.tooLarge} />
      <DeletedFiles />
    </div>
  );
}
