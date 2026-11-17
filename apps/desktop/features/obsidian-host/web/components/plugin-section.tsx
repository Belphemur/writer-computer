import { useEffect, useRef, useState } from "react";
import "./plugin-settings.css";
import { mountSettingTab } from "./mount-setting-tab";
import type { SettingTabEntry } from "../host/api/core";

/**
 * Hosts one plugin PluginSettingTab: attaches its containerEl, then display(); hide() on cleanup
 * (section change, Settings tab close, plugin disable). display() errors are shown inline,
 * never a blank pane.
 */
export function PluginSectionContent({ entry }: { entry: SettingTabEntry }) {
  const { owner, tab } = entry;
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mounted = mountSettingTab(host, owner, tab);
    setError(mounted.error);
    return mounted.dispose;
  }, [owner, tab]);
  return (
    <>
      {error && (
        <div role="alert" className="mb-3 text-[13px] text-red-500">
          This plugin's options failed to render: {error}
        </div>
      )}
      <div
        ref={hostRef}
        data-plugin-settings-host={owner}
        className="plugin-settings vertical-tab-content-container text-[13px] text-[var(--text-primary)]"
      />
    </>
  );
}
