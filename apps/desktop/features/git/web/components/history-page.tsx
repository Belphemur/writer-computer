// The History tab (page kind `git-history`, spec `SPECs/git-sync-spec.md` "History"): the file's
// versions grouped by day with bursts folded on the left, the selected version and its diff on
// the right. One scroller, the root. Shift-click a second version to compare any two; a click with
// Cmd/Ctrl or the middle button opens that version in its own tab (`link-activation.ts`).
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { openGitHistoryTab } from "@/hooks/editor-api";
import { linkHandlers } from "@/lib/link-activation";
import { describeError, logger } from "@/lib/logger";
import type { PageViewProps } from "@/lib/features/slots";
import type { GitHistoryLocation } from "@/components/editor-area/page-kinds";
import { history, versionText, type VersionRow } from "../ipc";
import {
  burstLabel,
  countsLabel,
  fileTitle,
  groupVersions,
  labelOf,
  timeLabel,
  type Burst,
} from "../lib/history";
import { useGitStatus } from "../lib/status-store";
import { VersionDetail, type Against } from "./version-detail";

function useVersions(path: string) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a new commit (the status store follows the `git:changed` event) reloads the list
  const stamp = useGitStatus((s) => s.status?.lastCommit ?? 0);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    history(path).then(
      (r) => {
        if (!current) return;
        setRows(r);
        setError(null);
      },
      (e) => {
        if (!current) return;
        logger.warn("git", "could not read the history");
        setError(describeError(e).message);
      },
    );
    return () => {
      current = false;
    };
  }, [path, stamp, reload]);
  return { rows, error, refresh: useCallback(() => setReload((n) => n + 1), []) };
}

function VersionRowButton({
  v,
  selected,
  compared,
  onPick,
  onOpenTab,
}: {
  v: VersionRow;
  selected: boolean;
  compared: boolean;
  onPick: (e: { shiftKey: boolean }) => void;
  onOpenTab: (activate: boolean) => void;
}) {
  const label = labelOf(v);
  const counts = countsLabel(v);
  const handlers = linkHandlers({
    kind: "custom",
    open: (intent) => {
      if (intent === "current") return onPick({ shiftKey: false });
      onOpenTab(intent === "new-tab-active");
    },
  });
  return (
    <button
      type="button"
      data-git-entry={v.rev}
      aria-pressed={selected}
      {...handlers}
      onClick={(e) => (e.shiftKey ? onPick({ shiftKey: true }) : handlers.onClick?.(e))}
      className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none ${
        selected
          ? "bg-[var(--surface-subtle)]"
          : compared
            ? "outline outline-1 outline-[var(--accent)]"
            : ""
      }`}
    >
      <span className="flex items-baseline gap-1.5">
        {label.badge === "agent" && (
          <span
            data-git-badge="agent"
            className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-1.5 text-[10.5px] leading-4 text-[var(--text-muted)]"
          >
            {label.agent ?? "Agent"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{label.text}</span>
        {v.kind === "delete" && <span className="text-[11px] text-[var(--danger)]">Deleted</span>}
      </span>
      <span className="flex gap-2 text-[11px] text-[var(--text-muted)]">
        <span>{timeLabel(v.time ?? 0)}</span>
        {label.models.length > 0 && <span>{label.models.join(", ")}</span>}
        {v.kind === "move" && v.from && <span className="truncate">from {fileTitle(v.from)}</span>}
        {counts && <span className="ml-auto font-[var(--mono-font)]">{counts}</span>}
      </span>
    </button>
  );
}

function BurstView({
  burst,
  selected,
  compared,
  onPick,
  onOpenTab,
}: {
  burst: Burst;
  selected: string | null;
  compared: string | null;
  onPick: (v: VersionRow, e: { shiftKey: boolean }) => void;
  onOpenTab: (v: VersionRow, activate: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const single = burst.versions.length === 1;
  const holdsSelected = burst.versions.some((v) => v.rev === selected);
  if (single) {
    const v = burst.versions[0]!;
    return (
      <VersionRowButton
        v={v}
        selected={v.rev === selected}
        compared={v.rev === compared}
        onPick={(e) => onPick(v, e)}
        onOpenTab={(a) => onOpenTab(v, a)}
      />
    );
  }
  const expanded = open || holdsSelected;
  return (
    <div data-git-burst={burst.id}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none"
      >
        <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={12} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{labelOf(burst.versions[0]!).text}</span>
        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{burstLabel(burst)}</span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-[var(--line-subtler)] pl-1">
          {burst.versions.map((v) => (
            <VersionRowButton
              key={v.rev}
              v={v}
              selected={v.rev === selected}
              compared={v.rev === compared}
              onPick={(e) => onPick(v, e)}
              onOpenTab={(a) => onOpenTab(v, a)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryView({ path, initialRev }: { path: string; initialRev?: string }) {
  const { rows, error, refresh } = useVersions(path);
  const [rev, setRev] = useState<string | null>(initialRev ?? null);
  const [against, setAgainst] = useState<Against>({ kind: "parent" });
  const days = useMemo(() => groupVersions(rows ?? []), [rows]);
  useEffect(() => setRev(initialRev ?? null), [initialRev]);

  if (error)
    return (
      <p role="alert" className="p-6 text-[13px] text-[var(--text-primary)]">
        {error}
      </p>
    );
  if (!rows) return <p className="p-6 text-[13px] text-[var(--text-muted)]">Loading</p>;
  if (rows.length === 0)
    return <p className="p-6 text-[13px] text-[var(--text-muted)]">No versions yet</p>;

  const selected = rows.find((r) => r.rev === rev) ?? rows[0]!;
  const comparing = against.kind === "version" ? against.rev : null;
  const pick = (v: VersionRow, e: { shiftKey: boolean }) => {
    if (e.shiftKey && v.rev !== selected.rev) {
      setAgainst({ kind: "version", rev: v.rev });
      return;
    }
    setRev(v.rev);
    setAgainst({ kind: "parent" });
  };
  return (
    <div className="mx-auto grid w-full max-w-[1100px] grid-cols-1 gap-6 px-6 py-6 md:grid-cols-[300px_1fr]">
      <nav aria-label="Versions" data-git-versions className="min-w-0 space-y-3">
        {days.map((day) => (
          <div key={day.key} data-git-day={day.label} className="space-y-0.5">
            <h2 className="px-2 text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
              {day.label}
            </h2>
            {day.bursts.map((b) => (
              <BurstView
                key={b.id}
                burst={b}
                selected={selected.rev}
                compared={comparing}
                onPick={pick}
                onOpenTab={(v, activate) =>
                  openGitHistoryTab({ path, rev: v.rev, version: true }, { activate })
                }
              />
            ))}
          </div>
        ))}
      </nav>
      <VersionDetail
        path={path}
        version={selected}
        against={against}
        onAgainst={setAgainst}
        onRestored={() => {
          setAgainst({ kind: "parent" });
          refresh();
        }}
      />
    </div>
  );
}

/** One version, read-only: the text as it was. */
function VersionView({ path, rev }: { path: string; rev: string }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    versionText(path, rev).then(
      (t) => current && setText(t),
      (e) => current && setError(describeError(e).message),
    );
    return () => {
      current = false;
    };
  }, [path, rev]);
  return (
    <div className="mx-auto w-full max-w-[880px] space-y-3 px-6 py-6">
      <p className="text-[11.5px] text-[var(--text-muted)]">Read-only version</p>
      {error ? (
        <p role="alert" className="text-[13px]">
          {error}
        </p>
      ) : text === undefined ? (
        <p className="text-[13px] text-[var(--text-muted)]">Loading</p>
      ) : text === null ? (
        <p className="text-[13px] text-[var(--text-muted)]">This version has no text to show</p>
      ) : (
        <pre
          data-git-version-text
          className="font-[var(--editor-font)] text-[14px] leading-relaxed break-words whitespace-pre-wrap text-[var(--text-primary)]"
        >
          {text}
        </pre>
      )}
    </div>
  );
}

export default function HistoryPage({ location }: PageViewProps<GitHistoryLocation>) {
  return (
    <div data-testid="git-history-page" className="h-full overflow-y-auto">
      {location.version && location.rev ? (
        <VersionView path={location.path} rev={location.rev} />
      ) : (
        <HistoryView path={location.path} initialRev={location.rev} />
      )}
    </div>
  );
}
