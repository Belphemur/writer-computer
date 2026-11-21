// The pieces of the panel and of Settings > Git that exist only with a remote: the last sync, the
// one-line error with "Details" (the sanitized git output), the files a sync could not settle, the
// plugin settings held back by the token scan and the notices (a binary kept beside the remote's,
// a file restored). Terse: no prose.
import { useState } from "react";
import { describeError, logger } from "@/lib/logger";
import { formatRelativeTime } from "@/lib/relative-time";
import { dismissNotices, pluginDecision } from "../ipc";
import { fileLabel } from "../lib/state";
import { useGitStatus } from "../lib/status-store";

export const BUTTON =
  "rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none disabled:opacity-50";

/** "Push rejected: authentication failed" with "Details", which copies the sanitized output. */
export function SyncError() {
  const failure = useGitStatus((s) => s.status?.syncError ?? null);
  const [copied, setCopied] = useState(false);
  if (!failure) return null;
  return (
    <div role="alert" data-git-sync-error className="flex items-baseline gap-2 text-xs">
      <span className="text-[var(--text-primary)]">{failure.line}</span>
      {failure.details && (
        <button
          type="button"
          className="text-[var(--text-muted)] underline hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:text-[var(--text-primary)]"
          onClick={() =>
            void navigator.clipboard
              .writeText(failure.details)
              .then(() => setCopied(true))
              .catch(() => logger.warn("git", "could not copy the details"))
          }
        >
          {copied ? "Copied" : "Details"}
        </button>
      )}
    </div>
  );
}

/** The last sync: "Synced 2 min ago". */
export function lastSyncLabel(lastSync: number | null): string | null {
  return lastSync ? `Synced ${formatRelativeTime(lastSync)}` : null;
}

/** Files the last sync could not settle. Their version stays as it is on disk. */
export function Conflicts() {
  const conflicts = useGitStatus((s) => s.status?.conflicts ?? []);
  if (conflicts.length === 0) return null;
  return (
    <section data-git-conflicts aria-label="Conflicts">
      <h3 className="pb-1 text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
        Conflicts
      </h3>
      <ul>
        {conflicts.map((c) => (
          <li
            key={c.path}
            data-git-conflict={c.path}
            className="flex items-baseline justify-between gap-2 py-0.5"
            title={c.path}
          >
            <span className="truncate text-[var(--text-primary)]">{fileLabel(c.path)}</span>
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              {c.properties.length > 0 ? c.properties.join(", ") : `${c.hunks} overlap`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Plugin settings that look like they hold a token: not synced, until the user says. */
export function HeldPlugins() {
  const held = useGitStatus((s) => s.status?.held ?? []);
  const apply = useGitStatus((s) => s.apply);
  const [failure, setFailure] = useState<string | null>(null);
  if (held.length === 0) return null;
  const decide = async (id: string, choice: "allow" | "never") => {
    setFailure(null);
    try {
      apply(await pluginDecision(id, choice));
    } catch (e) {
      logger.warn("git", "a plugin decision failed");
      setFailure(describeError(e).message);
    }
  };
  return (
    <section data-git-held aria-label="Held back" className="space-y-2">
      {held.map((h) => (
        <div key={h.id} data-git-held-plugin={h.id} className="text-xs">
          <p className="text-[var(--text-primary)]">
            Plugin {h.name}&apos;s settings look like they contain a token — not synced
          </p>
          <div className="mt-1 flex gap-2">
            <button type="button" className={BUTTON} onClick={() => void decide(h.id, "allow")}>
              Sync anyway
            </button>
            <button type="button" className={BUTTON} onClick={() => void decide(h.id, "never")}>
              Never sync this plugin
            </button>
          </div>
        </div>
      ))}
      {failure && (
        <p role="alert" className="text-xs text-[var(--text-primary)]">
          {failure}
        </p>
      )}
    </section>
  );
}

/** A binary kept beside the remote's version, a file brought back: told once, then dismissed. */
export function Notices() {
  const copies = useGitStatus((s) => s.status?.copies ?? []);
  const restored = useGitStatus((s) => s.status?.restored ?? []);
  const apply = useGitStatus((s) => s.apply);
  if (copies.length === 0 && restored.length === 0) return null;
  return (
    <section data-git-notices className="space-y-1 text-xs text-[var(--text-muted)]">
      {copies.map((c) => (
        <p key={c.copy} title={c.copy}>
          Kept both: {fileLabel(c.path)} and its copy
        </p>
      ))}
      {restored.map((p) => (
        <p key={p} title={p}>
          Restored {fileLabel(p)}: it was deleted on one side and edited on the other
        </p>
      ))}
      <button
        type="button"
        className="underline hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:text-[var(--text-primary)]"
        onClick={() =>
          void dismissNotices().then(apply, () => logger.warn("git", "could not dismiss"))
        }
      >
        Dismiss
      </button>
    </section>
  );
}
