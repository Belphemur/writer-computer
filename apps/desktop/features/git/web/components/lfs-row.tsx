// Settings > Git > Advanced: "Large files (LFS) [ ] over [100] MB". One row for the two settings;
// the switch is disabled with a one-line hint while `git-lfs` is not installed.
import { BooleanControl, NumberControl } from "@/components/settings-panel/setting-control";
import { useAllSettings, useSetSetting } from "@/hooks/use-settings";
import type { GitStatus } from "../ipc";
import { CARD, defsFor, KEYS, MUTED, ROW } from "./section-parts";

export function LfsRow({ lfs }: { lfs: GitStatus["lfs"] }) {
  const settings = useAllSettings();
  const setSetting = useSetSetting();
  const [on, threshold] = defsFor(KEYS.lfs, KEYS.lfsThreshold);
  const raw = settings[KEYS.lfsThreshold];
  // the schema's default is the one source of the 100
  const mb = typeof raw === "number" ? raw : Number(threshold?.default ?? 0);
  return (
    <div data-git-lfs className={CARD}>
      <div className={ROW}>
        <span>{on?.label}</span>
        <span className={`flex items-center gap-2 ${MUTED}`}>
          <BooleanControl
            value={settings[KEYS.lfs] === true}
            disabled={!lfs.available}
            label={on?.label}
            onChange={(v) => setSetting(KEYS.lfs, v)}
          />
          <span>over</span>
          <NumberControl value={mb} onChange={(v) => setSetting(KEYS.lfsThreshold, v)} />
          <span>MB</span>
        </span>
      </div>
      {!lfs.available && (
        <p data-git-lfs-hint className={`px-4 pb-3 text-xs ${MUTED}`}>
          Install git-lfs to use this
        </p>
      )}
    </div>
  );
}
