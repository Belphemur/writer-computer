// The remote part of Settings > Git (spec "Setup" and "Credentials"): the Remote row, "Add a
// remote" (paste an SSH or HTTPS URL), "Sign in with GitHub" / "Sign in with Forgejo" (the forge
// CLIs of the Rust table), the token for HTTPS remotes (the secret `features.git.token`, write-only
// here) and where HTTPS passwords come from.
// A missing `git` says so with "Install Command Line Tools" on macOS. Terse: no prose.
import { useEffect, useState } from "react";
import { SettingRows } from "@/components/settings-panel/setting-rows";
import { installGitLabelForPlatform } from "@/lib/platform-labels";
import { describeError, logger } from "@/lib/logger";
import { detectPlatform } from "@/lib/platform";
import { useFeatureSecretsStore } from "@/stores/feature-secrets-store";
import {
  installGit,
  removeRemote,
  setCredentials,
  setRemote,
  setSyncPaused,
  signIn,
  syncNow,
  tools,
  type ForgeRow,
  type GitStatus,
  type SignInResult,
  type Tools,
} from "../ipc";
import { useGitStatus } from "../lib/status-store";
import { ForgeSignInRows, forgeUsable, SignInSteps } from "./forge-rows";
import { FailureLine } from "./logs-section";
import { BUTTON, lastSyncLabel, SyncError } from "./sync-parts";
import type { SettingDef } from "@/lib/settings-schema";

const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
const ROW = "flex items-center justify-between gap-4 px-4 py-3 text-[13px]";
const DIVIDER = "border-t border-[var(--line-subtler)]";
const MUTED = "text-[var(--text-muted)]";
const INPUT =
  "min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus-visible:outline-none focus-visible:border-[var(--accent)]";

export const TOKEN_KEY = "features.git.token";

export function RemoteRows({ status, syncDefs }: { status: GitStatus; syncDefs: SettingDef[] }) {
  const apply = useGitStatus((s) => s.apply);
  const tokenSet = useFeatureSecretsStore((s) => (s.keysSet.git ?? []).includes(TOKEN_KEY));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [machine, setMachine] = useState<Tools | null>(null);
  const [signedIn, setSignedIn] = useState<{
    result: SignInResult;
    forge: ForgeRow;
    host: string | null;
  } | null>(null);
  const linked = status.remote !== null;

  useEffect(() => {
    void useFeatureSecretsStore.getState().refresh("git");
    tools().then(setMachine, () => logger.warn("git", "could not look for git and the forge CLIs"));
  }, []);

  const run = async (action: () => Promise<GitStatus>) => {
    setBusy(true);
    setFailure(null);
    try {
      apply(await action());
      setEditing(false);
      setUrl("");
    } catch (e) {
      logger.warn("git", "a remote action failed");
      setFailure(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };

  /** The one sign-in action; its steps (and a taken name) are shown, never thrown. */
  const signInWith = async (
    forge: ForgeRow,
    host: string | null,
    name: string | null = null,
    link = false,
  ) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await signIn(forge.id, host, name, link);
      apply(result.status);
      setSignedIn({ result, forge, host });
    } catch (e) {
      logger.warn("git", "sign in could not start");
      setFailure(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const saveToken = async () => {
    if (!token.trim()) return;
    setBusy(true);
    const ok = await useFeatureSecretsStore.getState().save("git", TOKEN_KEY, token.trim());
    setToken("");
    setBusy(false);
    if (ok) void run(() => setCredentials("token"));
    else setFailure("Could not save the token");
  };

  const showForm = !linked || editing;
  const forges = machine?.forges ?? [];
  return (
    <>
      {machine && !machine.git && (
        <div role="alert" data-git-missing className={`${ROW} ${CARD}`}>
          <span>Git is not installed</span>
          {machine.canInstallGit ? (
            <button type="button" className={BUTTON} onClick={() => void installGit()}>
              Install Command Line Tools
            </button>
          ) : (
            <span className={MUTED}>{installGitLabelForPlatform(detectPlatform())}</span>
          )}
        </div>
      )}
      <div className={CARD}>
        <div className={ROW}>
          <span>Remote</span>
          <span className="flex items-center gap-2">
            <span className={MUTED} data-git-remote title={status.remote ?? undefined}>
              {status.remote ?? "None"}
            </span>
            {linked && (
              <>
                <button type="button" className={BUTTON} onClick={() => setEditing(!editing)}>
                  Change
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={() => void run(removeRemote)}
                >
                  Remove
                </button>
              </>
            )}
          </span>
        </div>
        {showForm && (
          <>
            <div className={`${ROW} ${DIVIDER}`}>
              <input
                aria-label="Remote URL"
                className={INPUT}
                placeholder="git@github.com:you/vault.git or https://…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button
                type="button"
                className={BUTTON}
                disabled={busy || !url.trim()}
                onClick={() => void run(() => setRemote(url))}
              >
                {linked ? "Change" : "Add a remote"}
              </button>
            </div>
            <ForgeSignInRows
              forges={forges}
              busy={busy}
              create={(forge, host) => void signInWith(forge, host)}
            />
          </>
        )}
        {signedIn && (
          <SignInSteps
            result={signedIn.result}
            busy={busy}
            retry={(name, link) => void signInWith(signedIn.forge, signedIn.host, name, link)}
          />
        )}
        {linked && (
          <>
            <div className={`${ROW} ${DIVIDER}`}>
              <span>HTTPS sign-in</span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className={BUTTON}
                  aria-pressed={status.credentials === "token"}
                  disabled={busy}
                  onClick={() => void run(() => setCredentials("token"))}
                >
                  Token
                </button>
                {forges.map((forge) => (
                  <button
                    key={forge.id}
                    type="button"
                    className={BUTTON}
                    aria-pressed={status.credentials === forge.id}
                    disabled={busy || !forgeUsable(forge, status)}
                    onClick={() => void run(() => setCredentials(forge.id))}
                  >
                    {forge.label}
                  </button>
                ))}
              </span>
            </div>
            {status.credentials === "token" && (
              <div className={`${ROW} ${DIVIDER}`}>
                <input
                  aria-label="Access token"
                  type="password"
                  autoComplete="off"
                  className={INPUT}
                  placeholder={
                    tokenSet ? "Token saved (paste to replace)" : "Personal access token"
                  }
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy || !token.trim()}
                  onClick={() => void saveToken()}
                >
                  Save
                </button>
              </div>
            )}
            <div className={`${ROW} ${DIVIDER}`}>
              <span className={MUTED}>{lastSyncLabel(status.lastSync) ?? "Not synced yet"}</span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy || status.syncing || status.identityError}
                  onClick={() => void run(syncNow)}
                >
                  Sync now
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={() => void run(() => setSyncPaused(!status.syncPaused))}
                >
                  {status.syncPaused ? "Resume sync" : "Pause sync"}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
      <SyncError showLogs />
      {failure && <FailureLine message={failure} />}
      {linked && <SettingRows defs={syncDefs} />}
    </>
  );
}
