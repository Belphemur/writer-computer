import { useEffect, useState } from "react";
import * as logActions from "@/lib/log-actions";
import { getLogInfo, type LogInfo } from "@/lib/tauri";

const ROW = "flex items-center justify-between gap-4 px-4 py-3";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";

/** Settings > Logs: where the local log files are, and the two actions that use them. */
export function LogsSection() {
  const [info, setInfo] = useState<LogInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getLogInfo()
      .then((i) => live && setInfo(i))
      .catch((e) => live && setMessage(`Could not find the log folder: ${String(e)}`));
    return () => {
      live = false;
    };
  }, []);

  async function copy() {
    try {
      setMessage(logActions.copyResultMessage(await logActions.copyRecentErrors()));
    } catch (e) {
      setMessage(`Could not copy the logs: ${String(e)}`);
    }
  }

  async function open() {
    try {
      await logActions.openLogFolder();
    } catch (e) {
      setMessage(`Could not open the log folder: ${String(e)}`);
    }
  }

  return (
    <section className="mb-10" data-logs>
      <p className="mb-4 text-[13px] text-[var(--text-muted)]">
        Writer keeps the last three days of errors and warnings in local log files, so problems can
        be diagnosed after the fact. Paths are shortened and secrets are removed; the files never
        leave this computer.
      </p>
      <div className="overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        <div className={ROW}>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--text-primary)]">Log folder</div>
            <div
              data-log-dir
              className="mt-0.5 select-text break-all font-mono text-[12px] text-[var(--text-muted)]"
            >
              {info?.dir ?? "…"}
            </div>
            {info?.envOverride && (
              <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                WRITER_LOG is set and overrides the level above.
              </div>
            )}
          </div>
          <button type="button" className={BUTTON} onClick={() => void open()}>
            Open log folder
          </button>
        </div>
        <div className={`${ROW} border-t border-[var(--line-subtler)]`}>
          <div className="text-[13px] text-[var(--text-primary)]">
            Copy the latest errors to attach to a bug report
          </div>
          <button type="button" className={BUTTON} onClick={() => void copy()}>
            Copy recent errors
          </button>
        </div>
      </div>
      {message && (
        <div role="status" data-logs-message className="mt-3 text-[13px] text-[var(--text-muted)]">
          {message}
        </div>
      )}
    </section>
  );
}
