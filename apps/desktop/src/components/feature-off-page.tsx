import type { ReactNode } from "react";
import { useSetSetting } from "@/hooks/use-settings";
import { enabledKey, FEATURE_MANIFESTS } from "@/lib/features/manifests";

/** The body of a tab whose view belongs to a built-in feature that is switched off: say so and
 *  offer the way back (`actions` are the caller's, such as "Open as text"). */
export function FeatureOffPage({ feature, actions }: { feature: string; actions?: ReactNode }) {
  const setSetting = useSetSetting();
  const name = FEATURE_MANIFESTS.find((m) => m.id === feature)?.name ?? feature;
  const button =
    "rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]";
  return (
    <div
      data-feature-off={feature}
      className="flex h-full min-w-0 flex-col items-start gap-2 p-6 text-[13px] text-[var(--text-muted)]"
    >
      <div className="text-[var(--text-primary)]">{name} is turned off</div>
      <div>Turn it on to show this page, or open the file as text.</div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void setSetting(enabledKey(feature), true)}
          className={button}
        >
          Turn on
        </button>
        {actions}
      </div>
    </div>
  );
}
