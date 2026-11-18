import { useEffect, useId, useMemo, useState } from "react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Edit02Icon,
  File02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { openSessionChangesTab } from "@/hooks/editor-api";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import {
  changedNotesLabel,
  noteParts,
  selectSessionChanges,
  statusMark,
  type SessionChangesView,
} from "@features/agent/web/lib/session-changes";
import { formatDuration, segmentBlocks } from "@features/agent/web/lib/timeline";
import { shortModelName } from "@features/agent/web/lib/model-label";
import {
  subagentActivity,
  subagentCounts,
  subagentElapsed,
  subagentIcon,
  subagentLabel,
  subagentTask,
  subagentWaiting,
  trayRuns,
  type SubagentState,
  type TrayRun,
} from "@features/agent/web/lib/subagents";
import type { Chat } from "@features/agent/web/lib/transcript";
import { Ico, Spinner } from "./agent-icon";
import { vaultLinkHandlers } from "./agent-links";
import { Counts, OriginMarker } from "./change-parts";
import { roleIcon } from "./role-icons";
import { SegmentList, STATE_TEXT } from "./subagent-card";

/** From this many runs on, the tray folds into one summary line. */
const FOLD_AT = 3;

/** The clock of the tray: one tick a second while a run is going, none otherwise. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summaryText(runs: readonly TrayRun[]): string {
  const going = runs.filter((r) => r.state === "running").length;
  const ended = runs.length - going;
  if (going === 0) return plural(ended, "agent finished", "agents finished");
  const head = `${going} ${going === 1 ? "agent" : "agents"} running`;
  return ended > 0 ? `${head} · ${ended} finished` : head;
}

function StateGlyph({ state }: { state: SubagentState }) {
  if (state === "running") return <Spinner size={12} />;
  if (state === "done") return <Ico icon={Tick02Icon} size={12} className="text-text-icon-muted" />;
  if (state === "failed")
    return <Ico icon={Alert02Icon} size={12} className="text-[var(--agent-error)]" />;
  return <Ico icon={Cancel01Icon} size={12} className="text-text-icon-muted" />;
}

/** One compact line of a run: who, what, model, time and tool count, its latest activity faded
 *  beneath; a click (or Enter) opens its live activity in place, capped, with its own scroll. */
function TrayLine({
  run,
  now,
  open,
  onToggle,
}: {
  run: TrayRun;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const running = run.state === "running";
  const label = subagentLabel(run);
  const task = subagentTask(run) || label;
  const elapsed = subagentElapsed(run, now);
  const tools = subagentCounts(run.children).toolCalls;
  const model = run.meta?.model;
  const waiting = running && subagentWaiting(run);
  const activity = waiting ? "Waiting for permission" : running ? subagentActivity(run) : "";
  return (
    <li data-agent-tray-run={run.id} data-state={run.state} className="rounded-md">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full flex-col gap-0 rounded-md px-1.5 py-1 text-left hover:bg-[var(--item-hover-bg)]"
      >
        <span className="flex w-full items-center gap-1.5 text-[12px]">
          <Ico
            icon={roleIcon(subagentIcon(run))}
            size={13}
            className="shrink-0 text-text-icon-muted"
          />
          <span data-agent-tray-task className="min-w-0 flex-1 truncate text-text-primary">
            {task}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
            <StateGlyph state={run.state} />
            {running ? (
              <>
                {model && <span data-agent-tray-model>{shortModelName(model)} ·</span>}
                {elapsed !== null && (
                  <span data-agent-tray-elapsed>{formatDuration(elapsed)} ·</span>
                )}
                <span data-agent-tray-tools>{plural(tools, "tool", "tools")}</span>
              </>
            ) : (
              <span data-agent-tray-status>
                {STATE_TEXT[run.state]}
                {elapsed !== null ? ` · ${formatDuration(elapsed)}` : ""}
              </span>
            )}
            <Ico icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
          </span>
        </span>
        {activity && (
          <span
            data-agent-tray-activity
            className="truncate pl-[19px] text-[11px] text-text-muted opacity-80"
          >
            {activity}
          </span>
        )}
      </button>
      {open && (
        <div
          id={bodyId}
          data-agent-tray-body
          className="mx-1.5 mb-1 max-h-48 space-y-1 overflow-y-auto rounded-md border border-[var(--line-subtler)] px-2 py-1.5"
        >
          {run.children.length > 0 ? (
            <SegmentList segments={segmentBlocks(run.children)} running={running} />
          ) : (
            <p className="text-[12px] text-text-muted">{running ? "Starting…" : "No activity."}</p>
          )}
        </div>
      )}
    </li>
  );
}

/** One note of the changed-notes row: its name opens it like a link (middle and Cmd/Ctrl+click
 *  open a new tab), "Diff" opens the Session changes tab scrolled to it. */
function ChangedNote({ chatId, f }: { chatId: string; f: SessionChangesView["files"][number] }) {
  const { name, folder } = noteParts(f.path);
  const mark = statusMark(f);
  const deleted = f.status === "deleted";
  return (
    <li
      data-agent-changed-note={f.path}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-[var(--item-hover-bg)]"
    >
      <Ico icon={File02Icon} size={13} className="shrink-0 text-text-icon-muted" />
      {deleted ? (
        <span className="min-w-0 truncate text-text-muted line-through" title={f.path}>
          {name}
        </span>
      ) : (
        <button
          type="button"
          title={f.path}
          aria-label={`Open ${f.path}`}
          {...vaultLinkHandlers(f.path)}
          className="min-w-0 truncate text-left text-text-primary underline-offset-2 hover:underline"
        >
          {name}
        </button>
      )}
      {folder && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{folder}</span>
      )}
      {mark && (
        <span data-agent-changed-mark={mark} className="shrink-0 text-[11px] text-text-muted">
          {mark}
        </span>
      )}
      <OriginMarker f={f} />
      {!f.noDiff && <Counts added={f.added} removed={f.removed} />}
      <button
        type="button"
        aria-label={`Diff of ${f.path}`}
        onClick={() => openSessionChangesTab({ chatId, focus: f.path })}
        className="ml-auto shrink-0 rounded-md border border-border px-1.5 py-0 text-[11px] text-text-secondary hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
      >
        Diff
      </button>
    </li>
  );
}

/** "Changed N notes +A −D": every note this chat changed (all turns, sub-agents included),
 *  one line that expands into one row per note; the x hides it until the list changes again.
 *  Reads the chat's one session-changes selector, the same the Session changes tab reads. */
function ChangedNotesRow({ chat, view }: { chat: Chat; view: SessionChangesView }) {
  const [open, setOpen] = useState(false);
  const hide = useAgentStore((s) => s.hideSessionChanges);
  const listId = useId();
  return (
    <div data-agent-changed-notes className="rounded-md">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-text-secondary hover:bg-[var(--item-hover-bg)]"
        >
          <Ico icon={Edit02Icon} size={13} className="shrink-0 text-text-icon-muted" />
          <span data-agent-changed-label className="min-w-0 truncate">
            {changedNotesLabel(view.files.length)}
          </span>
          <Counts added={view.added} removed={view.removed} />
          <Ico icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} className="ml-auto" />
        </button>
        <button
          type="button"
          aria-label="Hide changed notes"
          onClick={() => hide(chat.chatId)}
          className="shrink-0 rounded-md p-1 text-text-icon-muted hover:bg-[var(--item-hover-bg)] hover:text-text-primary"
        >
          <Ico icon={Cancel01Icon} size={12} />
        </button>
      </div>
      {open && (
        <ul id={listId} aria-label="Changed notes" className="max-h-48 space-y-0.5 overflow-y-auto">
          {view.files.map((f) => (
            <ChangedNote key={f.path} chatId={chat.chatId} f={f} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The tray just above the composer (spec "Sub-agent tray" and "Changed notes row", ADRs
 * 2026-11-18): one line per sub-agent run still going or ended since the user's last message
 * (they clear at the next send; from three runs on they fold into one summary line that
 * expands), and below them the changed-notes row. Reads the chat's own state, the same the
 * transcript and the Session changes tab read. A list; status changes are announced politely.
 */
export function SubagentTray({ chat }: { chat: Chat }) {
  const runs = useMemo(() => trayRuns(chat), [chat]);
  const sessionChanges = chat.sessionChanges;
  const changes = useMemo(() => selectSessionChanges({ sessionChanges }), [sessionChanges]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState(false);
  const now = useNow(runs.some((r) => r.state === "running"));
  const listId = useId();
  const announce = runs
    .filter((r) => r.state !== "running")
    .map((r) => `${subagentTask(r) || subagentLabel(r)}: ${STATE_TEXT[r.state]}`)
    .join(". ");
  const row = changes && !changes.hidden ? changes : null;
  if (runs.length === 0 && !row) return null;
  const folded = runs.length >= FOLD_AT && !unfolded;
  return (
    <section data-agent-tray className="px-3 pt-1.5">
      {runs.length > 0 && (
        <div aria-label="Sub-agents" role="group">
          <div role="status" aria-live="polite" className="sr-only" data-agent-tray-live>
            {announce}
          </div>
          {runs.length >= FOLD_AT && (
            <button
              type="button"
              aria-expanded={!folded}
              aria-controls={folded ? undefined : listId}
              data-agent-tray-summary
              onClick={() => setUnfolded(folded)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-text-secondary hover:bg-[var(--item-hover-bg)]"
            >
              {runs.some((r) => r.state === "running") && <Spinner size={12} />}
              <span className="min-w-0 flex-1 truncate">{summaryText(runs)}</span>
              <Ico icon={folded ? ArrowRight01Icon : ArrowDown01Icon} size={12} />
            </button>
          )}
          {!folded && (
            <ul id={listId} className="space-y-0.5" aria-label="Sub-agent runs">
              {runs.map((run) => (
                <TrayLine
                  key={run.id}
                  run={run}
                  now={now}
                  open={openId === run.id}
                  onToggle={() => setOpenId(openId === run.id ? null : run.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {row && <ChangedNotesRow chat={chat} view={row} />}
    </section>
  );
}
