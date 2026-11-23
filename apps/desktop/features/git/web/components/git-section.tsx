// Settings > Git, the short layout of the spec: a status line, the Remote rows (`remote-rows.tsx`),
// Save versions, Sync (with a remote), Agent turns, the rest folded under Advanced, and Logs. Before setup it
// offers the setup choices instead. Text stays terse.
import { useEffect, useState } from "react";
import { SettingRows } from "@/components/settings-panel/setting-rows";
import { openFileAsTextInNewTab } from "@/hooks/editor-api";
import { useAllSettings } from "@/hooks/use-settings";
import { describeError, logger } from "@/lib/logger";
import { formatRelativeTime } from "@/lib/relative-time";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { commitNow, setPaused, setup, stop, type SetupMode } from "../ipc";
import { LfsRow } from "./lfs-row";
import { FailureLine, LogsSection, ShowLogs } from "./logs-section";
import { CARD, defsFor, KEYS, MUTED, ROW } from "./section-parts";
import { RemoteRows } from "./remote-rows";
import { SigningRow } from "./signing-row";
import { BUTTON, ErrorLine } from "./sync-parts";
import { IDENTITY_COMMANDS, summarize } from "../lib/state";
import { useGitStatus } from "../lib/status-store";

function IdentityHelp() {
  return (
    <div role="alert" className="px-1 text-[13px]">
      <p className="text-[var(--text-primary)]">Set your git name and email</p>
      <pre className={`mt-1 whitespace-pre-wrap text-xs ${MUTED}`}>
        {IDENTITY_COMMANDS.join("\n")}
      </pre>
    </div>
  );
}

export function GitSection() {
  const status = useGitStatus((s) => s.status);
  const unavailable = useGitStatus((s) => s.unavailable);
  const apply = useGitStatus((s) => s.apply);
  const settings = useAllSettings();
  const root = useWorkspaceStore((s) => s.root);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // opening the page asks git for the commit identity again: the user may have just set it
  useEffect(() => {
    void useGitStatus.getState().refresh(true);
  }, []);

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

  if (!root || unavailable || !status) {
    return <p className={`px-1 text-[13px] ${MUTED}`}>Open a vault to set up version history.</p>;
  }

  if (!status.setUp) {
    const choose = (mode: SetupMode) => void run(() => setup(mode));
    return (
      <div className="space-y-4" data-git-setup>
        {(status.stopped || status.parentRepo) && (
          <p className={`px-1 text-[13px] ${MUTED}`}>
            {status.stopped
              ? "Version history is off for this vault."
              : "This vault is inside another repository. Nothing is saved until you choose."}
          </p>
        )}
        <div className={CARD}>
          <div className={ROW}>
            <span>Local history only</span>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => choose("local")}
            >
              Set up
            </button>
          </div>
          <div className={`${ROW} border-t border-[var(--line-subtler)]`}>
            <span>Use existing repository</span>
            <button
              type="button"
              className={BUTTON}
              disabled={busy || !status.hasRepo}
              onClick={() => choose("existing")}
            >
              Use
            </button>
          </div>
        </div>
        {failure && failure.startsWith("Set your git name and email") ? (
          <IdentityHelp />
        ) : (
          failure && (
            <p role="alert" className="px-1 text-[13px]">
              {failure}
            </p>
          )
        )}
      </div>
    );
  }

  const summary = summarize(status);
  const last = status.lastCommit ? formatRelativeTime(status.lastCommit) : null;
  const gitignore = () => {
    if (root) void openFileAsTextInNewTab(`${root.replace(/\/$/, "")}/.gitignore`);
  };
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between px-1 text-[13px]">
        <span className="flex items-baseline gap-2">
          <span className="font-medium text-[var(--text-primary)]" data-git-state={summary?.tone}>
            {summary?.label}
          </span>
          {summary?.tone === "error" && !failure && !status.error && !status.syncError && (
            <ShowLogs />
          )}
        </span>
        {last && <span className={MUTED}>Saved {last}</span>}
      </div>
      {status.identityError && <IdentityHelp />}
      {failure ? (
        <FailureLine message={failure} />
      ) : (
        status.error &&
        !status.identityError && (
          <div className="px-1">
            <ErrorLine line={status.error} details={status.errorDetails} showLogs />
          </div>
        )
      )}
      <RemoteRows status={status} syncDefs={defsFor(KEYS.syncInterval)} />
      <div className={CARD}>
        <div className={ROW}>
          <span />
          <span className="flex gap-2">
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
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(stop)}>
              Stop version history
            </button>
          </span>
        </div>
      </div>
      <SettingRows defs={defsFor(KEYS.commitAfter, KEYS.agentCommits)} />
      {(status.signing.on || status.signing.suggested) && <SigningRow signing={status.signing} />}
      <details className="group" data-git-advanced>
        <summary className="cursor-pointer px-1 pb-2 text-[13px] text-[var(--text-primary)]">
          Advanced
        </summary>
        <div className="space-y-3">
          <SettingRows defs={defsFor(KEYS.commitMessage)} />
          {!status.signing.on && !status.signing.suggested && (
            <SigningRow signing={status.signing} />
          )}
          <LfsRow lfs={status.lfs} />
          <div className={CARD}>
            <div className={ROW}>
              <span>Ignored</span>
              <button type="button" className={BUTTON} onClick={gitignore}>
                Edit .gitignore
              </button>
            </div>
          </div>
        </div>
      </details>
      <LogsSection />
      {/* the page re-renders when a setting changes */}
      <span hidden>{String(settings[KEYS.commitAfter])}</span>
    </div>
  );
}
