import { useEffect, useId, useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { FileChange, FileChangeSummary } from "@features/agent/web/lib/events";
import {
  defaultExpanded,
  filesChangedLabel,
  commandWithoutBefore,
  statusLabel,
  totals,
} from "@features/agent/web/lib/diff-rows";
import type { Turn } from "@features/agent/web/lib/transcript";
import { changesKey, useTurnChangesStore } from "@features/agent/web/stores/turn-changes-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { useGitHistory, useTurnCommit } from "@features/agent/web/hooks/use-turn-commit";
import { revealSubagentCard } from "./subagent-card";
import { Ico } from "./agent-icon";
import { Counts, FileDiffBody, FileName, OriginMarker } from "./change-parts";

const btn =
  "rounded-md border border-border px-2 py-0.5 text-[11.5px] text-text-secondary hover:bg-[var(--item-hover-bg)] hover:text-text-primary disabled:opacity-50";

type Confirm = { paths: string[]; label: string } | null;

/** The "Changes" card at the end of a finished turn: what the agent changed in the vault, a diff
 *  per file and Undo. Spec: `SPECs/native-agent-spec.md` "Turn changes". The summary comes from
 *  the transcript (also stored in the chat note); diffs and Undo need the backend's in-memory
 *  snapshot and degrade to counts only without it. */
export function TurnChangesCard({ chatId, turn }: { chatId: string; turn: Turn }) {
  const enabled = useSettingsStore((s) => s.settings["agent.show-turn-changes"] !== false);
  const summary = turn.changes;
  const files = summary?.files ?? [];
  const initial = defaultExpanded(files.length);
  const [open, setOpen] = useState(initial.card);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(initial.firstFile && files[0] ? [files[0].path] : []),
  );
  const [confirm, setConfirm] = useState<Confirm>(null);
  const bodyId = useId();
  const key = summary ? changesKey(chatId, summary.turnId) : "";
  const entry = useTurnChangesStore((s) => s.entries[key]);
  const load = useTurnChangesStore((s) => s.load);
  const revert = useTurnChangesStore((s) => s.revert);
  const git = useGitHistory();
  const finished = turn.status !== "running" && turn.finishedAt !== null;
  const commit = useTurnCommit(
    git,
    finished && summary && summary.files.length > 0
      ? { chatId, turnId: summary.turnId, finishedAt: turn.finishedAt }
      : null,
  );
  const wantsDetail = open && summary !== undefined && turn.status !== "running";

  useEffect(() => {
    if (wantsDetail && summary) void load(chatId, summary.turnId);
  }, [wantsDetail, chatId, summary, load]);

  if (!enabled || !summary || files.length === 0 || turn.status === "running") return null;

  const { added, removed } = totals(files);
  const detail = new Map<string, FileChange>((entry?.data?.files ?? []).map((f) => [f.path, f]));
  const undoable = files.filter((f) => detail.get(f.path)?.undo === "available");
  const label = `${filesChangedLabel(files.length)}, ${added} added, ${removed} removed`;

  const toggleFile = (path: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const undoControl = (f: FileChangeSummary) => {
    const d = detail.get(f.path);
    const outcome = entry?.outcomes[f.path];
    if (confirm && confirm.paths.length === 1 && confirm.paths[0] === f.path)
      return (
        <ConfirmBar
          text={`Undo changes to ${f.path}?`}
          busy={entry?.busy ?? false}
          onConfirm={() => {
            setConfirm(null);
            void revert(chatId, summary.turnId, [f.path]);
          }}
          onCancel={() => setConfirm(null)}
        />
      );
    if (d?.undo === "available")
      return (
        <button
          type="button"
          className={btn}
          disabled={entry?.busy}
          aria-label={`Undo changes to ${f.path}`}
          onClick={() => setConfirm({ paths: [f.path], label: f.path })}
        >
          Undo
        </button>
      );
    if (d?.undo === "changed-since" || outcome?.result === "changed-since")
      return <span className="text-[11px] text-text-muted">File changed since</span>;
    if (d?.undo === "reverted") return <span className="text-[11px] text-text-muted">Undone</span>;
    return null;
  };

  return (
    <section
      role="region"
      aria-label={`Changes: ${label}`}
      data-agent-changes
      className="rounded-lg border border-border bg-[var(--surface-subtle)]/30 text-[12.5px]"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-text-primary"
        >
          <Ico icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="shrink-0" />
          <span className="font-medium">{filesChangedLabel(files.length)}</span>
          <Counts added={added} removed={removed} />
        </button>
        {open && undoable.length > 1 && !confirm && (
          <button
            type="button"
            className={btn}
            disabled={entry?.busy}
            onClick={() =>
              setConfirm({
                paths: undoable.map((f) => f.path),
                label: `${undoable.length} files`,
              })
            }
          >
            Undo all
          </button>
        )}
      </div>
      {confirm && confirm.paths.length > 1 && (
        <div className="px-2 pb-1.5">
          <ConfirmBar
            text={`Undo changes to ${confirm.label}?`}
            busy={entry?.busy ?? false}
            onConfirm={() => {
              const paths = confirm.paths;
              setConfirm(null);
              void revert(chatId, summary.turnId, paths);
            }}
            onCancel={() => setConfirm(null)}
          />
        </div>
      )}
      {open && (
        <div id={bodyId} className="border-t border-border">
          <ul className="divide-y divide-border">
            {files.map((f) => {
              const isOpen = expanded.has(f.path);
              const d = detail.get(f.path);
              const outcome = entry?.outcomes[f.path];
              const panelId = `${bodyId}-${f.path}`;
              return (
                <li key={f.path} data-agent-change-file={f.path} className="px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      aria-label={`${isOpen ? "Hide" : "Show"} diff of ${f.path}`}
                      onClick={() => toggleFile(f.path)}
                      className="flex shrink-0 items-center gap-1 rounded-md text-text-muted hover:text-text-primary"
                    >
                      <Ico icon={isOpen ? ArrowDown01Icon : ArrowRight01Icon} />
                      <span className="text-[11px]">{statusLabel(f)}</span>
                    </button>
                    <FileName f={f} />
                    <OriginMarker f={f} />
                    {f.by &&
                      (f.byCall ? (
                        <button
                          type="button"
                          data-agent-change-by={f.by}
                          title={`Edited by the ${f.by} sub-agent: show its card`}
                          onClick={() => revealSubagentCard(f.byCall!)}
                          className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-1.5 text-[10.5px] leading-4 text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
                        >
                          {f.by}
                        </button>
                      ) : (
                        <span
                          data-agent-change-by={f.by}
                          title={`Edited by the ${f.by} sub-agent`}
                          className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-1.5 text-[10.5px] leading-4 text-text-muted"
                        >
                          {f.by}
                        </span>
                      ))}
                    {!f.noDiff && <Counts added={f.added} removed={f.removed} />}
                    {git && commit && getWorkspaceRoot() && (
                      <button
                        type="button"
                        data-agent-view-history={f.path}
                        aria-label={`View history of ${f.path}`}
                        className={btn}
                        onClick={() =>
                          git.openHistory(`${getWorkspaceRoot()!.replace(/\/$/, "")}/${f.path}`, {
                            rev: commit,
                          })
                        }
                      >
                        View in history
                      </button>
                    )}
                    <span className="ml-auto flex items-center gap-2">{undoControl(f)}</span>
                  </div>
                  {outcome?.result === "failed" && (
                    <p role="alert" className="mt-1 text-[11.5px] text-[var(--danger)]">
                      Could not undo: {outcome.message ?? "unknown error"}
                    </p>
                  )}
                  {isOpen && (
                    <div id={panelId} className="mt-1.5">
                      <FileDiffBody f={f} d={d} status={entry?.status} error={entry?.error} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {summary.files.some(commandWithoutBefore) && (
            <p className="border-t border-border px-2 py-1.5 text-[11px] text-text-muted">
              A shell command ran in this turn. Files it changed are listed without a diff.
            </p>
          )}
          {entry?.status === "unavailable" && (
            <p className="border-t border-border px-2 py-1.5 text-[11px] text-text-muted">
              Diff no longer available after restart. Undo is not possible either.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ConfirmBar({
  text,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <span
      role="group"
      aria-label="Confirm undo"
      className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-text-secondary"
    >
      <span>{text}</span>
      <button type="button" className={btn} disabled={busy} onClick={onConfirm}>
        Confirm undo
      </button>
      <button type="button" className={btn} onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}
