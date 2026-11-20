import { useRef, useState } from "react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { usePopoverPlacement } from "@/hooks/use-popover-placement";
import { useChatContext } from "@features/agent/web/hooks/use-agent";
import type { ChatId } from "@features/agent/web/lib/events";
import type { ContextLevel, ContextStatus } from "@features/agent/web/lib/context-usage";
import { formatTokens } from "@features/agent/web/lib/timeline";
import { TokenBreakdown } from "./token-breakdown";

const SIZE = 16;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const LEVEL_COLOR: Record<ContextLevel, string> = {
  ok: "text-text-muted",
  warn: "text-[var(--warning)]",
  danger: "text-[var(--danger)]",
};

/** The one sentence for the ring: aria label and popover title. */
export function contextSummary({ used, window, percent }: ContextStatus): string {
  if (used === null) return "Context: no usage yet";
  if (window === null || percent === null) {
    return `Context: ${formatTokens(used)} tokens (window size unknown)`;
  }
  return `Context: ${formatTokens(used)} of ${formatTokens(window)} tokens (${percent}%)`;
}

/** A small ring in the composer footer that fills clockwise from 12 o'clock as the chat's context
 *  window fills. Muted below 60%, warning to 85%, danger above. Unknown window: a dashed ring,
 *  no percentage. Hover or click opens the breakdown of the last API call. */
export function ContextRing({ chatId }: { chatId: ChatId }) {
  const status = useChatContext(chatId);
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const open = pinned || hover;
  const close = () => {
    setPinned(false);
    setHover(false);
  };
  usePopoverDismiss(wrapRef, wrapRef, close, open);
  const placement = usePopoverPlacement(wrapRef, open, { width: 244, maxHeight: 260 });
  if (!status) return null;

  const summary = contextSummary(status);
  const known = status.fraction !== null;
  const b = status.breakdown;
  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        data-agent-context-ring
        data-level={status.level}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setPinned((v) => !v)}
        className={`flex items-center rounded-md p-1.5 hover:bg-[var(--item-hover-bg)] ${LEVEL_COLOR[status.level]}`}
      >
        <svg
          role="progressbar"
          aria-label="Context window"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(status.percent !== null ? { "aria-valuenow": status.percent } : {})}
          aria-valuetext={summary}
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          fill="none"
          strokeWidth={STROKE}
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke="currentColor"
            opacity={0.25}
            strokeDasharray={known || status.used === null ? undefined : "2 3"}
          />
          {known && (
            <circle
              data-agent-context-arc
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              stroke="currentColor"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - status.fraction!)}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              className="transition-[stroke-dashoffset,color] duration-300 motion-reduce:transition-none"
            />
          )}
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Context usage"
          data-agent-context-popover
          style={placement}
          className="absolute bottom-full left-0 z-30 mb-1 rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-primary)] p-3 text-[12px] shadow-lg"
        >
          <p className="font-medium text-text-primary">{summary}</p>
          {b && <TokenBreakdown usage={b} className="mt-2" />}
          <p className="mt-2 text-[10.5px] text-text-muted">
            {b ? "Last request to the model. " : ""}
            {status.window === null && b
              ? "The window size is reported after the first finished turn."
              : "Window size as reported by Claude Code."}
          </p>
          {status.level === "danger" && (
            <p role="note" className="mt-2 text-[var(--danger)]">
              Consider starting a new chat or compacting.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
