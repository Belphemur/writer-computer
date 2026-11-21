// The pieces of the panel and of Settings > Git that exist only with a remote: the last sync, the
// one-line error with "Details" (the sanitized git output), the files a sync could not settle, the
// plugin settings held back by the token scan and the notices (a file restored). Terse: no prose.
import { useState } from "react";
import { linkHandlers } from "@/lib/link-activation";
import { describeError, logger } from "@/lib/logger";
import { formatRelativeTime } from "@/lib/relative-time";
import { conflictTake, dismissNotices, pluginDecision } from "../ipc";
import { openMerge } from "../lib/resolve-conflicts";
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

/** Files the last sync could not settle: each opens its merge view (a click with Cmd/Ctrl or the
 *  middle button opens it in the background). Their version stays as it is on disk. */
export function Conflicts() {
  const conflicts = useGitStatus((s) => s.status?.conflicts ?? []);
  if (conflicts.length === 0) return null;
  return (
    <section data-git-conflicts aria-label="Conflicts">
      <h3 className="pb-1 text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
        Conflicts
      </h3>
      <ul>
        {conflicts.map((c) => {
          const handlers = linkHandlers({
            kind: "custom",
            open: (intent) => openMerge(c.path, { activate: intent !== "new-tab-background" }),
          });
          return (
            <li key={c.path}>
              <button
                type="button"
                data-git-conflict={c.path}
                title={c.path}
                {...handlers}
                className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none"
              >
                <span className="truncate text-[var(--text-primary)]">{fileLabel(c.path)}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">
                  {c.theirsPath
                    ? "Renamed"
                    : c.properties.length > 0
                      ? c.properties.join(", ")
                      : `${c.hunks} overlap`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Binaries that changed on both sides: the other device's version is at the path, yours is the
 *  copy beside it. One choice settles it. */
export function BinaryConflicts() {
  const copies = useGitStatus((s) => s.status?.copies ?? []);
  const apply = useGitStatus((s) => s.apply);
  const [failure, setFailure] = useState<string | null>(null);
  if (copies.length === 0) return null;
  const keep = async (path: string, side: "mine" | "theirs" | "both") => {
    setFailure(null);
    try {
      apply(await conflictTake(path, side));
    } catch (e) {
      logger.warn("git", "could not settle a binary");
      setFailure(describeError(e).message);
    }
  };
  return (
    <section data-git-binaries aria-label="Binary conflicts" className="space-y-2">
      <h3 className="text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
        Both changed
      </h3>
      {copies.map((c) => (
        <div key={c.copy} data-git-binary={c.path} className="text-xs">
          <p className="truncate text-[var(--text-primary)]" title={c.path}>
            {fileLabel(c.path)}
          </p>
          <p className="truncate text-[var(--text-muted)]" title={c.copy}>
            {c.copy.split("/").pop()}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {(["mine", "theirs", "both"] as const).map((side) => (
              <button
                key={side}
                type="button"
                data-git-keep={side}
                className={BUTTON}
                onClick={() => void keep(c.path, side)}
              >
                Keep {side}
              </button>
            ))}
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

/** A file brought back because one side deleted what the other edited: told once, then dismissed. */
export function Notices() {
  const restored = useGitStatus((s) => s.status?.restored ?? []);
  const apply = useGitStatus((s) => s.apply);
  if (restored.length === 0) return null;
  return (
    <section data-git-notices className="space-y-1 text-xs text-[var(--text-muted)]">
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
