// "Sign in with GitHub" / "Sign in with Forgejo" (spec "Setup"): one row per forge CLI, or per host
// for a CLI signed in to several. Every label comes from the Rust table (`ForgeRow`), so a third
// forge is a table entry and no change here. Terse: no prose.
import { useState } from "react";
import { openExternal } from "@/lib/link-activation";
import type { ForgeRow, GitStatus, SignInResult } from "../ipc";
import { BUTTON } from "./sync-parts";

const ROW = "flex items-center justify-between gap-4 px-4 py-3 text-[13px]";
const DIVIDER = "border-t border-[var(--line-subtler)]";
const MUTED = "text-[var(--text-muted)]";

/** The CLI can answer git for this vault: signed in, and to the remote's host (`remoteHost`, from
 *  Rust, port included) when it has hosts. */
export const forgeUsable = (forge: ForgeRow, status: GitStatus): boolean =>
  forge.state === "signed-in" &&
  (forge.hosts.length === 0 || forge.hosts.some((h) => h.toLowerCase() === status.remoteHost));

export function ForgeSignInRows({
  forges,
  busy,
  create,
}: {
  forges: ForgeRow[];
  busy: boolean;
  /** Creates the private repository: `host` is `null` for a CLI with one default host. */
  create: (forge: ForgeRow, host: string | null) => void;
}) {
  return (
    <>
      {forges.map((forge) => {
        // a CLI signed in to hosts gets a row each; the others a single row
        const hosts = forge.state === "signed-in" && forge.hosts.length > 0 ? forge.hosts : [null];
        return hosts.map((host) => (
          <div
            key={`${forge.id}:${host ?? ""}`}
            className={`${ROW} ${DIVIDER}`}
            data-forge={forge.id}
          >
            <span>
              {forge.signIn}
              {host && <span className={`${MUTED} ml-2`}>{host}</span>}
            </span>
            {forge.state === "missing" ? (
              <button
                type="button"
                className={BUTTON}
                onClick={() => void openExternal(forge.installUrl)}
              >
                {forge.install}
              </button>
            ) : forge.state === "signed-out" ? (
              <span className={MUTED}>Run {forge.login}</span>
            ) : (
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => create(forge, host)}
              >
                Create private repository
              </button>
            )}
          </div>
        ));
      })}
    </>
  );
}

const STEP_LABELS: Record<string, string> = {
  remote: "Remote",
  credential: "Sign-in",
  push: "First push",
};

const INPUT =
  "min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus-visible:outline-none focus-visible:border-[var(--accent)]";

/** What "Sign in with ..." did, step by step; the first failure is the last step shown, the rest
 *  wait. A taken name offers "Link existing <name>" or another name. Every step carries its
 *  `kind`, so a "Show logs" button next to a failed one is a single line here. */
export function SignInSteps({
  result,
  busy,
  retry,
}: {
  result: SignInResult;
  busy: boolean;
  /** Runs the action again: another `name`, or `link` the existing repository of that name. */
  retry: (name: string, link: boolean) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div data-sign-in-steps className={`${DIVIDER} px-4 py-3 text-[13px]`}>
      <ol className="flex flex-col gap-1">
        {result.steps.map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            data-state={step.state}
            data-kind={step.kind || undefined}
            className="flex items-baseline justify-between gap-4"
          >
            <span>{STEP_LABELS[step.id] ?? step.id}</span>
            <span
              role={step.state === "failed" ? "alert" : undefined}
              className={step.state === "pending" ? MUTED : undefined}
            >
              {step.state === "pending" ? "Waiting" : step.line}
            </span>
          </li>
        ))}
      </ol>
      {result.taken && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => retry(result.taken ?? "", true)}
          >
            Link existing {result.taken}
          </button>
          <input
            aria-label="Repository name"
            className={INPUT}
            placeholder="Another name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !name.trim()}
            onClick={() => retry(name.trim(), false)}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}
