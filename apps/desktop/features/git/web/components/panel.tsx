// The sidebar panel: the files changed since the last version, when the last version was saved,
// "Commit now" and "Pause". Local mode only (no remote yet). Terse: no prose.
import { useState } from "react";
import { describeError, logger } from "@/lib/logger";
import { formatRelativeTime } from "@/lib/relative-time";
import { commitNow, setPaused } from "../ipc";
import { fileLabel, IDENTITY_COMMANDS, KIND_LABEL, summarize } from "../lib/state";
import { useGitStatus } from "../lib/status-store";

const BUTTON =
  "rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none disabled:opacity-50";

export default function GitPanel() {
  const status = useGitStatus((s) => s.status);
  const apply = useGitStatus((s) => s.apply);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: () => ReturnType<typeof commitNow>) => {
    setBusy(true);
    setFailure(null);
    try {
      apply(await action());
    } catch (e) {
      logger.warn("git", "an action failed");
      setFailure(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const summary = summarize(status);
  if (!status || !summary) {
    return (
      <div data-git-panel className="p-3 text-[13px] text-[var(--text-muted)]">
        Not set up. Choose it in Settings, Git.
      </div>
    );
  }
  const last = status.lastCommit ? formatRelativeTime(status.lastCommit) : null;
  return (
    <div data-git-panel className="flex min-h-0 flex-col gap-3 p-3 text-[13px]">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-[var(--text-primary)]">{summary.label}</span>
        {last && <span className="text-xs text-[var(--text-muted)]">Saved {last}</span>}
      </div>
      {summary.tone === "error" && (
        <div role="alert" className="text-xs text-[var(--text-primary)]">
          <p>{summary.detail}</p>
          {status.identityError && (
            <pre className="mt-1 whitespace-pre-wrap text-[var(--text-muted)]">
              {IDENTITY_COMMANDS.join("\n")}
            </pre>
          )}
        </div>
      )}
      {failure && (
        <p role="alert" className="text-xs text-[var(--text-primary)]">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={busy || status.changes.length === 0 || status.identityError}
          onClick={() => void run(commitNow)}
        >
          Commit now
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => void run(() => setPaused(!status.paused))}
        >
          {status.paused ? "Resume" : "Pause"}
        </button>
      </div>
      {status.changes.length > 0 && (
        <ul className="min-h-0 overflow-auto" aria-label="Changed files">
          {status.changes.map((c) => (
            <li
              key={`${c.kind}:${c.path}`}
              data-git-change={c.kind}
              className="flex items-baseline justify-between gap-2 py-0.5"
              title={c.from ? `${c.from} → ${c.path}` : c.path}
            >
              <span className="truncate text-[var(--text-primary)]">{fileLabel(c.path)}</span>
              <span className="shrink-0 text-xs text-[var(--text-muted)]">
                {KIND_LABEL[c.kind] ?? c.kind}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
