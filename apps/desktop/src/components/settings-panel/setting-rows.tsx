import { useAllSettings, useResetSetting, useSetSetting } from "@/hooks/use-settings";
import type { SettingDef } from "@/lib/settings-schema";
import { SettingControl } from "./setting-control";

/** The one renderer of a list of schema entries: a card with a `SettingControl` per entry. Used by
 *  the category blocks, the Agent section's generic rows and the Features section. */
export function SettingRows({ defs }: { defs: readonly SettingDef[] }) {
  const settings = useAllSettings();
  const setSetting = useSetSetting();
  const resetSetting = useResetSetting();
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
      {defs.map((def, i) => (
        <div
          key={def.key}
          className={i === 0 ? undefined : "border-t border-[var(--line-subtler)]"}
        >
          <SettingControl
            def={def}
            value={settings[def.key]}
            onChange={(value) => setSetting(def.key, value)}
            onReset={() => void resetSetting(def.key)}
            isModified={JSON.stringify(settings[def.key]) !== JSON.stringify(def.default)}
          />
        </div>
      ))}
    </div>
  );
}
