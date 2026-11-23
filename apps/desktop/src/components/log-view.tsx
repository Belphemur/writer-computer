// The log view (ADR 2026-11-23): the last lines of one log target from today's file, then the
// lines that follow, live. It knows no feature: a settings page mounts it with its target (the
// allowlist is Rust's, `logging/tail.rs`). Mounting opens the feed and unmounting closes it, so a
// page that renders it only while its section is open has no feed while it is collapsed.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SMALL_BUTTON as BUTTON } from "@/components/button-styles";
import * as logActions from "@/lib/log-actions";
import { describeError, logger } from "@/lib/logger";
import { logTail, watchLog, type LogLine } from "@/lib/logs";
import { scrollIntoScroller } from "@/lib/scroll-into";

/** Lines read back when the view opens. */
const BACKLOG = 200;
/** Lines kept; the oldest go first. */
const KEEP = 1000;
/** Pixels from the end that still count as "at the end". */
const PINNED_SLACK = 8;

/** Error in the danger token, warning in the warning token, the rest in the text colour. */
const LEVEL_COLOR: Record<string, string> = {
  error: "text-[var(--danger)]",
  warn: "text-[var(--warning)]",
};

type Filter = "all" | "errors";

/** What the "Errors" filter and "Show logs" are about: an error, or a warning (a failed call
 *  that is not a refused sign-in logs as one). Colours stay by level. */
export const isProblem = (l: LogLine) => l.level === "error" || l.level === "warn";

const keyOf = (l: LogLine) => `${l.ts}|${l.level}|${l.message}`;

/** "14:03:21", local; the raw stamp when it does not parse. */
export function formatLogTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour12: false });
}

/** The line as the view shows it and Copy writes it. */
export const formatLogLine = (l: LogLine) =>
  `${formatLogTime(l.ts)} ${l.level.toUpperCase()} ${l.message}`;

export function LogView({
  target,
  revealToken = 0,
}: {
  target: string;
  /** A new non-zero value scrolls to the latest error or warning (to the end when there is none). */
  revealToken?: number;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const revealed = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    const pending: LogLine[] = [];
    let ready = false;
    const append = (line: LogLine) => setLines((prev) => [...prev, line].slice(-KEEP));
    (async () => {
      // the feed first, so a line written while the backlog is read is not lost
      stop = await watchLog(target, (line) => (ready ? append(line) : pending.push(line)));
      if (cancelled) return stop();
      const tail = await logTail(target, BACKLOG);
      if (cancelled) return;
      const seen = new Set(tail.map(keyOf));
      ready = true;
      setLines([...tail, ...pending.filter((l) => !seen.has(keyOf(l)))].slice(-KEEP));
      setLoaded(true);
    })().catch((e) => {
      logger.warn("logs", "the log view could not open");
      if (!cancelled) setFailure(describeError(e).message);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [target]);

  const visible = useMemo(
    () => (filter === "errors" ? lines.filter(isProblem) : lines),
    [lines, filter],
  );

  // pinned to the end unless the user scrolled up
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [visible]);

  // "Show logs": to the latest error, once the lines are in
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !loaded || revealToken === 0 || revealed.current === revealToken) return;
    revealed.current = revealToken;
    const errors = box.querySelectorAll<HTMLElement>("[data-problem]");
    const last = errors[errors.length - 1];
    if (last) {
      pinned.current = false;
      scrollIntoScroller(last, { scroller: box, block: "center" });
    } else {
      pinned.current = true;
      box.scrollTop = box.scrollHeight;
    }
  }, [revealToken, loaded, visible]);

  const copy = () =>
    void navigator.clipboard
      .writeText(visible.map(formatLogLine).join("\n"))
      .then(() => setCopied(true))
      .catch(() => logger.warn("logs", "could not copy the log lines"));

  return (
    <div data-log-view={target} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex gap-1" role="group" aria-label="Filter">
          {(["all", "errors"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={BUTTON}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : "Errors"}
            </button>
          ))}
        </span>
        <span className="flex gap-1">
          <button type="button" className={BUTTON} disabled={visible.length === 0} onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              void logActions
                .openLogFolder()
                .catch(() => logger.warn("logs", "could not open the log folder"))
            }
          >
            Open log folder
          </button>
        </span>
      </div>
      <div
        ref={scroller}
        data-log-lines
        data-selectable
        role="log"
        aria-label={`${target} log`}
        className="max-h-72 overflow-y-auto rounded-lg border border-[var(--line-subtler)] bg-[var(--surface-card)] p-2 font-mono text-[11px] leading-5"
        onScroll={(e) => {
          const box = e.currentTarget;
          pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight <= PINNED_SLACK;
        }}
      >
        {failure ? (
          <p role="alert" className="text-[var(--danger)]">
            {failure}
          </p>
        ) : visible.length === 0 ? (
          <p className="text-[var(--text-muted)]">{loaded ? "No lines" : "Loading"}</p>
        ) : (
          visible.map((l, i) => (
            <div
              key={`${keyOf(l)}#${i}`}
              data-level={l.level}
              data-problem={isProblem(l) || undefined}
              className={`whitespace-pre-wrap break-words ${LEVEL_COLOR[l.level] ?? "text-[var(--text-primary)]"}`}
            >
              <span className="text-[var(--text-muted)]">{formatLogTime(l.ts)}</span>{" "}
              <span className="uppercase">{l.level}</span> {l.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
