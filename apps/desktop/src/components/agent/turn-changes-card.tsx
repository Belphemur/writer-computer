import { useEffect, useId, useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { FileChange, FileChangeSummary } from "@/lib/agent/events";
import {
  defaultExpanded,
  filesChangedLabel,
  middleTruncate,
  STATUS_LABEL,
  totals,
} from "@/lib/agent/diff-rows";
import type { Turn } from "@/lib/agent/transcript";
import { changesKey, useTurnChangesStore } from "@/stores/turn-changes-store";
import { useSettingsStore } from "@/stores/settings-store";
import { Ico } from "./agent-icon";
import { openVaultPath } from "./agent-links";
import { DiffView } from "./diff-view";

const MINUS = "−";

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span
      className="shrink-0 font-[var(--mono-font)] text-[11.5px]"
      aria-label={`${added} added, ${removed} removed`}
    >
      <span className="text-[var(--success)]">+{added}</span>{" "}
      <span className="text-[var(--danger)]">
        {MINUS}
        {removed}
      </span>
    </span>
  );
}

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
                      <span className="text-[11px]">{STATUS_LABEL[f.status]}</span>
                    </button>
                    <FileName f={f} />
                    {f.by && (
                      <span
                        data-agent-change-by={f.by}
                        title={`Edited by the ${f.by} sub-agent`}
                        className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-1.5 text-[10.5px] leading-4 text-text-muted"
                      >
                        {f.by}
                      </span>
                    )}
                    {!f.noDiff && <Counts added={f.added} removed={f.removed} />}
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
          {summary.bash && (
            <p className="border-t border-border px-2 py-1.5 text-[11px] text-text-muted">
              A shell command ran in this turn. Files it changed are not tracked here.
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

function FileName({ f }: { f: FileChangeSummary }) {
  const shown = middleTruncate(f.path);
  const text = f.oldPath ? `${middleTruncate(f.oldPath, 28)} → ${shown}` : shown;
  const cls = "min-w-0 text-left font-[var(--mono-font)] text-[12px] break-all";
  if (f.status === "deleted")
    return (
      <span className={`${cls} text-text-muted line-through`} title={f.path}>
        {text}
      </span>
    );
  return (
    <button
      type="button"
      title={f.path}
      aria-label={`Open ${f.path}`}
      onClick={() => openVaultPath(f.path)}
      className={`${cls} text-text-primary underline-offset-2 hover:underline`}
    >
      {text}
    </button>
  );
}

function FileDiffBody({
  f,
  d,
  status,
  error,
}: {
  f: FileChangeSummary;
  d: FileChange | undefined;
  status: "loading" | "ready" | "unavailable" | "error" | undefined;
  error: string | null | undefined;
}) {
  if (status === "unavailable")
    return <p className="text-[11.5px] text-text-muted">Diff no longer available after restart</p>;
  if (status === "error")
    return (
      <p role="alert" className="text-[11.5px] text-[var(--danger)]">
        Could not load the diff: {error ?? "unknown error"}
      </p>
    );
  if (!d) return <p className="text-[11.5px] text-text-muted">Loading diff…</p>;
  if (f.noDiff)
    return (
      <p className="text-[11.5px] text-text-muted">
        Binary or very large file: listed without a diff
      </p>
    );
  if (f.status === "renamed")
    return <p className="text-[11.5px] text-text-muted">Renamed from {f.oldPath}, content equal</p>;
  return <DiffView rows={d.rows} truncated={d.truncated} label={`Diff of ${f.path}`} />;
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
