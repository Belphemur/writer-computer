import { useEffect, useId, useState } from "react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { segmentBlocks, formatDuration, type Segment } from "@features/agent/web/lib/timeline";
import { shortModelName } from "@features/agent/web/lib/model-label";
import {
  subagentCounts,
  subagentElapsed,
  subagentIcon,
  subagentLabel,
  subagentState,
  subagentSummary,
  subagentTask,
  subagentWaiting,
  type SubagentSegmentData,
  type SubagentState,
} from "@features/agent/web/lib/subagents";
import { Ico, Spinner } from "./agent-icon";
import { AssistantText } from "./assistant-text";
import { roleIcon } from "./role-icons";
import { TimelineGroup } from "./timeline-group";
import { UserTurnCard } from "./user-turn-card";

/** Renders the segments of a turn or of a sub-agent run: text, tool/thinking groups, steer cards
 *  and sub-agent cards. One mapping for both, so a run's inside reads like the turn around it. */
export function SegmentList({
  segments,
  running,
}: {
  segments: readonly Segment[];
  running: boolean;
}) {
  return (
    <>
      {segments.map((seg) =>
        seg.kind === "steer" ? (
          <UserTurnCard
            key={seg.block.id}
            message={seg.block.message}
            steer
            undelivered={seg.block.undelivered}
          />
        ) : seg.kind === "text" ? (
          <AssistantText key={seg.block.id} block={seg.block} />
        ) : seg.kind === "subagent" ? (
          <SubagentCard key={seg.run.id} run={seg.run} turnRunning={running} />
        ) : (
          <TimelineGroup key={seg.id} blocks={seg.blocks} running={running} />
        ),
      )}
    </>
  );
}

/** Scrolls the card of a sub-agent run into view and focuses its header (the Changes card's link to
 *  the run that made an edit). Does nothing when the card is not on screen (a restored chat that
 *  kept no runs). */
export function revealSubagentCard(callId: string): void {
  const card = [...document.querySelectorAll<HTMLElement>("[data-agent-subagent]")].find(
    (el) => el.dataset.agentSubagent === callId,
  );
  if (!card) return;
  card.scrollIntoView?.({ block: "center", behavior: "smooth" });
  card.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

const STATE_TEXT: Record<SubagentState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The clock of a running card: one tick a second while it runs, none once it ended. */
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

/**
 * One delegated run (spec "Sub-agent cards"): the header says who (the role's name and icon from
 * the registry), which model, what task, how it is going and what it did; the sub-agent's own
 * rows, thinking and text are inside. Expanded while it runs or a tool of it waits for
 * permission, collapsed once it is done; a click overrides. Its final answer is the summary.
 */
export function SubagentCard({
  run,
  turnRunning,
}: {
  run: SubagentSegmentData;
  turnRunning: boolean;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const bodyId = useId();
  const state = subagentState(run);
  const waiting = subagentWaiting(run);
  const live = state === "running";
  const open = override ?? (live || waiting);
  const now = useNow(live);
  const elapsed = subagentElapsed(run, now);
  const counts = subagentCounts(run.children);
  const label = subagentLabel(run);
  const task = subagentTask(run);
  const summary = subagentSummary(run);
  const model = run.meta?.model;
  // the sub-agent's closing text is the summary: not shown twice
  const children = run.children.filter(
    (b) => !(b.kind === "text" && summary !== "" && b.text.trim() === summary),
  );
  return (
    <section
      data-agent-subagent={run.id}
      data-state={state}
      data-role={run.meta?.role ?? undefined}
      aria-label={`${label} sub-agent${task ? `: ${task}` : ""}`}
      className="rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-card)]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOverride(!open)}
        className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--item-hover-bg)]"
      >
        <span className="flex w-full items-center gap-1.5 text-[12.5px]">
          <Ico
            icon={roleIcon(subagentIcon(run))}
            size={14}
            className="shrink-0 text-text-icon-muted"
          />
          <span data-agent-subagent-role className="font-medium text-text-primary">
            {label}
          </span>
          {model && (
            <span
              data-agent-subagent-model
              title={model}
              className="rounded-full bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[11px] text-text-muted"
            >
              {shortModelName(model)}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
            {live ? (
              <Spinner />
            ) : (
              <Ico
                icon={state === "done" ? Tick02Icon : Alert02Icon}
                className={
                  state === "failed" ? "text-[var(--agent-error)]" : "text-text-icon-muted"
                }
              />
            )}
            <span data-agent-subagent-status>
              {waiting && live ? "Waiting for permission" : STATE_TEXT[state]}
            </span>
            {elapsed !== null && (
              <span data-agent-subagent-elapsed>· {formatDuration(elapsed)}</span>
            )}
            <Ico icon={open ? ArrowDown01Icon : ArrowRight01Icon} />
          </span>
        </span>
        {task && (
          <span
            data-agent-subagent-task
            className="truncate text-[12.5px] text-text-secondary"
            title={task}
          >
            {task}
          </span>
        )}
        <span data-agent-subagent-counts className="text-[11px] text-text-muted">
          {plural(counts.toolCalls, "tool call", "tool calls")} ·{" "}
          {plural(counts.filesRead, "file read", "files read")} ·{" "}
          {plural(counts.edits, "edit", "edits")}
        </span>
      </button>
      {summary && !live && (
        <p
          data-agent-subagent-summary
          className={`px-2 pb-1.5 text-[12.5px] whitespace-pre-wrap text-text-secondary ${open ? "" : "line-clamp-2"}`}
        >
          {summary}
        </p>
      )}
      {open && (
        <div id={bodyId} className="space-y-1 border-t border-[var(--line-subtler)] px-2 py-1.5">
          {children.length > 0 ? (
            <SegmentList segments={segmentBlocks(children)} running={turnRunning && live} />
          ) : (
            <p className="text-[12px] text-text-muted">
              {live ? "Starting…" : "No activity recorded."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
