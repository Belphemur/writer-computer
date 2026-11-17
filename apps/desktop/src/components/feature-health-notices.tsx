import { FEATURE_MANIFESTS } from "@/lib/features/manifests";
import { featuresRestartNormally } from "@/lib/tauri";
import { logger } from "@/lib/logger";
import { useFeatureHealth } from "@/stores/feature-health-store";

const nameOf = (id: string) => FEATURE_MANIFESTS.find((m) => m.id === id)?.name ?? id;

function Notice({ id, text, onClose }: { id: string; text: string; onClose?: () => void }) {
  return (
    <div
      role="status"
      data-notice={id}
      className="pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-xl border border-[var(--line-subtle)] bg-[var(--surface-card)] px-3.5 py-2.5 text-[13px] text-[var(--text-primary)] shadow-lg"
    >
      <span className="min-w-0 flex-1">{text}</span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Safe-mode banner, "turned off after a crash" and "turned off for this session" notices
 *  (SPECs/builtin-plugins-spec.md section 16). Reads the health store only. */
export function FeatureHealthNotices() {
  const safeMode = useFeatureHealth((s) => s.safeMode);
  const crashDisabled = useFeatureHealth((s) => s.crashDisabled);
  const sessionOff = useFeatureHealth((s) => s.sessionOff);
  const dismissed = useFeatureHealth((s) => s.dismissed);
  const dismiss = useFeatureHealth((s) => s.dismiss);

  const crashed = crashDisabled.filter((c) => !dismissed[`crash:${c.setting}`]);
  const failed = Object.keys(sessionOff).filter((id) => !dismissed[`session:${id}`]);
  if (!safeMode && crashed.length === 0 && failed.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {safeMode && (
        <div
          role="alert"
          data-notice="safe-mode"
          className="pointer-events-auto flex max-w-[420px] flex-col gap-2 rounded-xl border border-[var(--line-subtle)] bg-[var(--surface-card)] px-3.5 py-2.5 text-[13px] text-[var(--text-primary)] shadow-lg"
        >
          <span>
            Safe mode: Writer did not finish starting twice in a row, so every feature is off for
            this run. Editing, files and settings still work.
          </span>
          <button
            type="button"
            onClick={() =>
              void featuresRestartNormally().catch((e) =>
                logger.error("app", `restart normally failed: ${String(e)}`),
              )
            }
            className="self-start rounded-md border border-[var(--line-subtle)] px-2.5 py-1 hover:bg-[var(--item-hover-bg)]"
          >
            Restart normally
          </button>
        </div>
      )}
      {crashed.map((c) => (
        <Notice
          key={c.setting}
          id={`crash:${c.id}`}
          text={`${nameOf(c.id)} was turned off after a crash. Turn it back on in Settings > Features.`}
          onClose={() => dismiss(`crash:${c.setting}`)}
        />
      ))}
      {failed.map((id) => (
        <Notice
          key={id}
          id={`session:${id}`}
          text={`${nameOf(id)} failed and is turned off until Writer restarts. Details are in Settings > Features.`}
          onClose={() => dismiss(`session:${id}`)}
        />
      ))}
    </div>
  );
}
