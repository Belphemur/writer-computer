// Settings > Git: "Sign commits [ ]". Git's own configuration decides whether Writer signs; the
// switch writes `commit.gpgsign` to this vault's config only. When the repository looks like it
// signs (signed history, a push refused for missing signatures) a one-line reason shows above it.
import { useState } from "react";
import { BooleanControl } from "@/components/settings-panel/setting-control";
import { describeError, logger } from "@/lib/logger";
import { setSigning, type GitStatus } from "../ipc";
import { useGitStatus } from "../lib/status-store";
import { CARD, MUTED, ROW } from "./section-parts";

export const SIGNING_SUGGESTION = "This repo uses signed commits";
export const SIGNING_KEY_HINT = "Set up a signing key in git first";

export function SigningRow({ signing }: { signing: GitStatus["signing"] }) {
  const apply = useGitStatus((s) => s.apply);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const change = async (on: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      apply(await setSigning(on));
    } catch (e) {
      logger.warn("git", "changing commit signing failed");
      setFailure(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const hint = signing.suggested ? (signing.key ? SIGNING_SUGGESTION : SIGNING_KEY_HINT) : null;
  return (
    <div data-git-signing className={CARD}>
      <div className={ROW}>
        <span>Sign commits</span>
        <BooleanControl
          value={signing.on}
          disabled={busy || (!signing.on && !signing.key)}
          label="Sign commits"
          onChange={(v) => void change(v)}
        />
      </div>
      {hint && (
        <p data-git-signing-hint className={`px-4 pb-3 text-xs ${MUTED}`}>
          {hint}
        </p>
      )}
      {!hint && !signing.on && !signing.key && (
        <p className={`px-4 pb-3 text-xs ${MUTED}`}>{SIGNING_KEY_HINT}</p>
      )}
      {failure && (
        <p role="alert" className="px-4 pb-3 text-xs">
          {failure}
        </p>
      )}
    </div>
  );
}
