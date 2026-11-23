import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { useNow } from "@features/agent/web/hooks/use-now";
import { scrollIntoScroller } from "@/lib/scroll-into";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { segmentBlocks, formatDuration, type Segment } from "@features/agent/web/lib/timeline";
import { setMarkdownSource } from "@features/agent/web/lib/selection-markdown";
import { shortModelName } from "@features/agent/web/lib/model-label";
import {
  subagentCounts,
  subagentElapsed,
  subagentIcon,
  subagentLabel,
  subagentModel,
  runParts,
  subagentState,
  subagentSummary,
  subagentTask,
  type SubagentSegmentData,
  type SubagentState,
} from "@features/agent/web/lib/subagents";
import { Ico } from "./agent-icon";
import { AssistantText } from "./assistant-text";
import { roleIcon } from "./role-icons";
import { QuestionCard } from "./question-card";
import { TimelineGroup } from "./timeline-group";
import { UserTurnCard } from "./user-turn-card";

/** Renders the segments of a turn or of a sub-agent run: text, tool/thinking groups, steer cards
 *  and sub-agent runs (a start line, and a result card once finished). One mapping for both, so a run's inside reads like the turn around it. */
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
            steer={!seg.block.injected}
            undelivered={seg.block.undelivered}
          />
        ) : seg.kind === "text" ? (
          <AssistantText key={seg.block.id} block={seg.block} />
        ) : seg.kind === "question" ? (
          <QuestionCard key={seg.block.id} block={seg.block} />
        ) : seg.kind === "subagent" ? (
          <SubagentRun key={seg.run.id} run={seg.run} />
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
  scrollIntoScroller(card, { block: "center", behavior: "smooth" });
  card.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

export const STATE_TEXT: Record<SubagentState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One delegated run in the transcript (spec "Sub-agent tray"): a quiet line where it started, and
 *  once it ended its result card. While it runs the tray above the composer shows it, never a
 *  live card here. */
function SubagentRun({ run }: { run: SubagentSegmentData }) {
  const label = subagentLabel(run);
  const task = subagentTask(run);
  return (
    <>
      <p data-agent-subagent-start className="px-1 text-[12px] text-text-muted">
        Started {label}
        {task ? `: ${task}` : ""}
      </p>
      {/* a run that works for the first time is in the tray; a resumed one keeps its card, which
          reads Running with its earlier calls above the divider (spec 3.14) */}
      {(subagentState(run) !== "running" || (run.meta?.resumes?.length ?? 0) > 0) && (
        <SubagentCard run={run} />
      )}
    </>
  );
}

/** A sub-agent's report: Markdown shown as written, a selection of it copies its own text. The one
 *  rendering of a run's report, its summary and an earlier run's alike. */
function ReportText({
  text,
  dataAttr,
  className,
  id,
}: {
  text: string;
  dataAttr: string;
  className: string;
  id?: string;
}) {
  const el = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (el.current) setMarkdownSource(el.current, text);
  }, [text]);
  return (
    <p ref={el} id={id} {...{ [dataAttr]: "" }} className={className}>
      {text}
    </p>
  );
}

/** Where a run was resumed (the orchestrator sent it a message): a quiet line in its call list. The
 *  report of the run before stays readable here. */
function ResumedDivider({ report }: { report?: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div data-agent-subagent-resumed className="space-y-1 py-0.5">
      <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
        <span aria-hidden className="h-px flex-1 bg-[var(--line-subtler)]" />
        {report ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 rounded-md hover:text-text-primary"
          >
            Resumed
            <Ico icon={open ? ArrowDown01Icon : ArrowRight01Icon} />
          </button>
        ) : (
          <span>Resumed</span>
        )}
        <span aria-hidden className="h-px flex-1 bg-[var(--line-subtler)]" />
      </div>
      {report && open && (
        <ReportText
          id={bodyId}
          text={report}
          dataAttr="data-agent-subagent-earlier-report"
          className="px-1 text-[12.5px] whitespace-pre-wrap text-text-secondary"
        />
      )}
    </div>
  );
}

/**
 * The result card of a finished run (spec "Sub-agent tray"): the header says who (the role's name
 * and icon from the registry), which model, what task, how it ended and what it did; its final
 * report is the summary and its own rows, thinking and text are inside. Collapsed; a click opens
 * it.
 */
export function SubagentCard({ run }: { run: SubagentSegmentData }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const state = subagentState(run);
  const running = state === "running";
  // a running card (a resumed run) shows its live, summed time
  const now = useNow(running);
  const elapsed = subagentElapsed(run, now);
  const counts = subagentCounts(run.children);
  const label = subagentLabel(run);
  const task = subagentTask(run);
  // the report of the latest run; while it works again the earlier ones are at their dividers
  const summary = running ? "" : subagentSummary(run);
  const model = subagentModel(run);
  // the sub-agent's closing text is the summary: not shown twice
  // and so is an earlier run's report: it is readable at its divider
  const shown = new Set([summary, ...(run.meta?.resumes ?? []).map((r) => r.report?.trim() ?? "")]);
  shown.delete("");
  const parts = runParts({
    ...run,
    children: run.children.filter((b) => !(b.kind === "text" && shown.has(b.text.trim()))),
  });
  const empty = parts.every((p) => p.blocks.length === 0);
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
        onClick={() => setOpen(!open)}
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
            {!running && (
              <Ico
                icon={state === "done" ? Tick02Icon : Alert02Icon}
                className={
                  state === "failed" ? "text-[var(--agent-error)]" : "text-text-icon-muted"
                }
              />
            )}
            <span data-agent-subagent-status>{STATE_TEXT[state]}</span>
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
      {summary && (
        <ReportText
          text={summary}
          dataAttr="data-agent-subagent-summary"
          className={`px-2 pb-1.5 text-[12.5px] whitespace-pre-wrap text-text-secondary ${open ? "" : "line-clamp-2"}`}
        />
      )}
      {open && (
        <div id={bodyId} className="space-y-1 border-t border-[var(--line-subtler)] px-2 py-1.5">
          {empty ? (
            <p className="text-[12px] text-text-muted">No activity recorded.</p>
          ) : (
            parts.map((part, i) => (
              <Fragment key={i}>
                {part.resume && <ResumedDivider report={part.resume.report} />}
                <SegmentList segments={segmentBlocks(part.blocks)} running={false} />
              </Fragment>
            ))
          )}
        </div>
      )}
    </section>
  );
}
