import { useEffect, useState } from "react";
import { cliStatus, installCli, uninstallCli, type CliInstallStatus } from "@/lib/tauri";

const ROW = "flex items-center justify-between gap-4 px-4 py-3";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";

/** One line for each state of the link, from the status Rust reports. */
export function cliStateLabel(status: CliInstallStatus): string {
  if (status.package) return "Installed by the package";
  switch (status.state) {
    case "installed":
      return "Installed";
    case "stale":
      return "Points at another copy of Writer";
    case "foreign":
      return "Another file is in the way";
    case "missing":
      return "Not installed";
  }
}

/** The folder of `target`, for the "not on your PATH" hint. */
function folderOf(target: string): string {
  return target.slice(0, target.lastIndexOf("/")) || "/";
}

/** Settings > Command line: link `writer` into a folder on the PATH, or remove it again. */
export function CliSection() {
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    cliStatus()
      .then((s) => live && setStatus(s))
      .catch((e) => live && setMessage(`Could not read the command status: ${String(e)}`));
    return () => {
      live = false;
    };
  }, []);

  async function run(action: () => Promise<CliInstallStatus>, failure: string) {
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await action());
    } catch (e) {
      setMessage(`${failure}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const needsPathHint = status !== null && status.installed && !status.onPath;

  return (
    <section className="mb-10" data-cli>
      <div className="overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        <div className={ROW}>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--text-primary)]">writer command</div>
            <div data-cli-state className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              {status ? cliStateLabel(status) : "…"}
            </div>
            {status && (
              <div
                data-cli-target
                className="mt-0.5 select-text break-all font-mono text-[12px] text-[var(--text-muted)]"
              >
                {status.target}
              </div>
            )}
          </div>
          {status && !status.package && (
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() =>
                void (status.installed
                  ? run(uninstallCli, "Could not remove the command")
                  : run(installCli, "Could not install the command"))
              }
            >
              {status.installed ? "Remove" : "Install"}
            </button>
          )}
        </div>
      </div>
      {needsPathHint && (
        <div role="status" data-cli-path-hint className="mt-3 text-[13px] text-[var(--text-muted)]">
          {folderOf(status.target)} is not on your PATH.
        </div>
      )}
      {message && (
        <div role="status" data-cli-message className="mt-3 text-[13px] text-[var(--text-muted)]">
          {message}
        </div>
      )}
    </section>
  );
}
