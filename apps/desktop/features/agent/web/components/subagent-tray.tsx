import { useEffect, useId, useMemo, useState } from "react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
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

/**
 * The sub-agent tray, just above the composer (spec "Sub-agent tray", ADR 2026-11-18): one line
 * per run still going or ended since the user's last message (they clear at the next send). From
 * three runs on it folds into one summary line that expands. Reads the chat's own sub-agent state,
 * the same the transcript reads. A list; status changes are announced politely.
 */
export function SubagentTray({ chat }: { chat: Chat }) {
  const runs = useMemo(() => trayRuns(chat), [chat]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState(false);
  const now = useNow(runs.some((r) => r.state === "running"));
  const listId = useId();
  const announce = runs
    .filter((r) => r.state !== "running")
    .map((r) => `${subagentTask(r) || subagentLabel(r)}: ${STATE_TEXT[r.state]}`)
    .join(". ");
  if (runs.length === 0) return null;
  const folded = runs.length >= FOLD_AT && !unfolded;
  return (
    <section data-agent-tray aria-label="Sub-agents" className="px-3 pt-1.5">
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
    </section>
  );
}
