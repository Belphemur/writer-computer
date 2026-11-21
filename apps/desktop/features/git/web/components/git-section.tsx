// Settings > Git, the short layout of the spec: a status line, the Remote row ("None": nothing is
// synced yet), Save versions, Agent turns, and the rest folded under Advanced. Before setup it
// offers the setup choices instead. Text stays terse.
import { useEffect, useState } from "react";
import { SettingRows } from "@/components/settings-panel/setting-rows";
import { openFileAsTextInNewTab } from "@/hooks/editor-api";
import { useAllSettings } from "@/hooks/use-settings";
import { describeError, logger } from "@/lib/logger";
import { formatRelativeTime } from "@/lib/relative-time";
import { FEATURE_SETTINGS, type SettingDef } from "@/lib/settings-schema";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { commitNow, setPaused, setup, type SetupMode } from "../ipc";
import { IDENTITY_COMMANDS, summarize } from "../lib/state";
import { useGitStatus } from "../lib/status-store";

const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
const ROW = "flex items-center justify-between gap-4 px-4 py-3 text-[13px]";
const MUTED = "text-[var(--text-muted)]";
const BUTTON =
  "rounded-md border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none disabled:opacity-50";

export const KEYS = {
  commitAfter: "git.commit-after",
  agentCommits: "git.agent-commits",
  commitMessage: "git.commit-message",
} as const;

function defsFor(...keys: string[]): SettingDef[] {
  return ((FEATURE_SETTINGS.git ?? []) as readonly SettingDef[]).filter((d) =>
    keys.includes(d.key),
  );
}

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
        <span className="font-medium text-[var(--text-primary)]" data-git-state={summary?.tone}>
          {summary?.label}
        </span>
        {last && <span className={MUTED}>Saved {last}</span>}
      </div>
      {status.identityError && <IdentityHelp />}
      {failure && (
        <p role="alert" className="px-1 text-[13px]">
          {failure}
        </p>
      )}
      <div className={CARD}>
        <div className={ROW}>
          <span>Remote</span>
          <span className={MUTED}>None</span>
        </div>
        <div className={`${ROW} border-t border-[var(--line-subtler)]`}>
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
          </span>
        </div>
      </div>
      <SettingRows defs={defsFor(KEYS.commitAfter, KEYS.agentCommits)} />
      <details className="group" data-git-advanced>
        <summary className="cursor-pointer px-1 pb-2 text-[13px] text-[var(--text-primary)]">
          Advanced
        </summary>
        <div className="space-y-3">
          <SettingRows defs={defsFor(KEYS.commitMessage)} />
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
      {/* the page re-renders when a setting changes */}
      <span hidden>{String(settings[KEYS.commitAfter])}</span>
    </div>
  );
}
