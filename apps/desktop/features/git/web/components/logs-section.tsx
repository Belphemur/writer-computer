// The collapsed "Logs" section of Settings > Git (ADR 2026-11-23) and the "Show logs" link that
// every error beside it carries. The view itself is core's `LogView` for target `git`.
import { useEffect, useRef } from "react";
import { LogView } from "@/components/log-view";
import { scrollIntoScroller } from "@/lib/scroll-into";
import { useLogsSection } from "../lib/logs-section";

/** The Rust target of git's lines (`target: "git"`), one of the core allowlist. */
const TARGET = "git";

export function LogsSection() {
  const open = useLogsSection((s) => s.open);
  const reveal = useLogsSection((s) => s.reveal);
  const box = useRef<HTMLDetailsElement>(null);

  // the section is closed again when the page goes away, so coming back opens no feed
  useEffect(() => () => useLogsSection.getState().setOpen(false), []);

  // "Show logs" brings the section into view; the view scrolls its own lines
  useEffect(() => {
    if (reveal > 0 && box.current) scrollIntoScroller(box.current, { block: "nearest" });
  }, [reveal]);

  return (
    <details
      ref={box}
      open={open}
      data-git-logs
      onToggle={(e) => useLogsSection.getState().setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer px-1 pb-2 text-[13px] text-[var(--text-primary)]">
        Logs
      </summary>
      {open && <LogView target={TARGET} revealToken={reveal} />}
    </details>
  );
}

/** Opens the Logs section at the latest error. */
export function ShowLogs() {
  return (
    <button
      type="button"
      data-show-logs
      className="text-[var(--text-muted)] underline hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:text-[var(--text-primary)]"
      onClick={() => useLogsSection.getState().show()}
    >
      Show logs
    </button>
  );
}

/** An action's failure as a line, with "Show logs". */
export function FailureLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-baseline gap-2 px-1 text-[13px]">
      <span>{message}</span>
      <ShowLogs />
    </p>
  );
}
