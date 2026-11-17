import { useState } from "react";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useAllSettings, useSetSetting } from "@/hooks/use-settings";
import { enabledKey, FEATURE_MANIFESTS, isFeatureEnabled } from "@/lib/features/manifests";
import type { FeatureManifest } from "@/lib/features/types";
import { FEATURE_SETTINGS } from "@/lib/settings-schema";
import { BooleanControl } from "./setting-control";
import { SettingRows } from "./setting-rows";

/** Does the feature have a Rust half whose state survives a toggle until the next launch? */
function hasRustHalf(m: FeatureManifest): boolean {
  return (
    (m.rust?.commands?.length ?? 0) > 0 ||
    (m.rust?.events?.length ?? 0) > 0 ||
    (m.rust?.hooks?.length ?? 0) > 0
  );
}

function FeatureRow({ manifest }: { manifest: FeatureManifest }) {
  const settings = useAllSettings();
  const setSetting = useSetSetting();
  const [open, setOpen] = useState(false);
  const failure = useFeatureHealth((s) => s.failures[manifest.id]);
  const sessionOff = useFeatureHealth((s) => s.sessionOff[manifest.id] === true);
  const crash = useFeatureHealth((s) => s.crashDisabled.find((c) => c.id === manifest.id));
  const clear = useFeatureHealth((s) => s.clear);
  const enabled = isFeatureEnabled(manifest, settings);
  // "Turn back on": the setting a crash turned off (the narrowest one) is set again, and the
  // session failure state is cleared, so the web half returns at once and the Rust half after a restart.
  const turnBackOn = () => {
    clear(manifest.id);
    void setSetting(crash?.setting ?? enabledKey(manifest.id), true);
  };
  // Everything under the feature comes from its settings fragment: no per-feature code here.
  const defs = FEATURE_SETTINGS[manifest.id] ?? [];

  return (
    <section
      data-feature={manifest.id}
      className="overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]"
    >
      <div className="flex items-start justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">
            {manifest.name}{" "}
            <span className="font-normal text-[var(--text-muted)]">v{manifest.version}</span>
          </div>
          <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">{manifest.description}</div>
          {manifest.memory && (
            <div className="mt-1 text-[12px] text-[var(--text-muted)]">
              Memory: {manifest.memory.level}. {manifest.memory.note}
            </div>
          )}
          {(failure || crash) && (
            <div
              role="alert"
              data-feature-failure={manifest.id}
              className="mt-1.5 text-[12px] text-[var(--text-primary)]"
            >
              {crash
                ? `Turned off after a crash (${crash.boundary}).`
                : `Failed in ${failure?.boundary} at ${new Date(failure?.at ?? 0).toLocaleTimeString()}${sessionOff ? " and turned off until Writer restarts" : ""}.`}{" "}
              <button
                type="button"
                onClick={turnBackOn}
                className="text-[var(--link-color)] hover:underline"
              >
                Turn back on
              </button>
            </div>
          )}
          {hasRustHalf(manifest) && (
            <div className="mt-1 text-[12px] text-[var(--text-muted)]">
              Switching it off stops its background services after a restart; the interface part
              switches at once.
            </div>
          )}
          {defs.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="mt-2 text-[13px] text-[var(--link-color)] hover:underline"
            >
              {open ? "Hide" : "Show"} settings ({defs.length})
            </button>
          )}
        </div>
        <BooleanControl
          value={enabled}
          label={`${manifest.name} feature`}
          onChange={(v) => {
            if (v) clear(manifest.id);
            void setSetting(enabledKey(manifest.id), v);
          }}
        />
      </div>
      {open && defs.length > 0 && (
        <div className="border-t border-[var(--line-subtler)] p-3">
          <SettingRows defs={defs} />
        </div>
      )}
    </section>
  );
}

/** Settings > Features: one row per built-in feature, generated from the manifests. */
export function FeaturesSection() {
  return (
    <div className="flex flex-col gap-3">
      <p className="mb-1 text-[13px] text-[var(--text-muted)]">
        Turn features off to save memory. Core editing, tabs and the sidebar always run.
      </p>
      {FEATURE_MANIFESTS.map((m) => (
        <FeatureRow key={m.id} manifest={m} />
      ))}
    </div>
  );
}
