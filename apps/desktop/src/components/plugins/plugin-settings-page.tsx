import { useEffect, useRef, useState } from "react";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import type { PluginSettingsLocation } from "@/components/editor-area/page-kinds";
import { usePluginSettingTabs, usePluginsSnapshot, useSetPluginEnabled } from "@/hooks/use-plugins";
import { mountSettingTab } from "./mount-setting-tab";
import type { SettingTabLike } from "@/lib/obsidian-host/api/core";

const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)]";

/**
 * Hosts one plugin PluginSettingTab: attaches its containerEl, then display(); hide() on cleanup
 * (unmount, tab switch, plugin disable). display() errors are shown inline, never a blank page.
 */
export function PluginSettingTabHost({ pluginId, tab }: { pluginId: string; tab: SettingTabLike }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mounted = mountSettingTab(host, pluginId, tab);
    setError(mounted.error);
    return mounted.dispose;
  }, [pluginId, tab]);
  return (
    <>
      {error && (
        <div role="alert" className="mb-3 text-[13px] text-red-500">
          This plugin's options failed to render: {error}
        </div>
      )}
      <div
        ref={hostRef}
        data-plugin-settings-host={pluginId}
        className="vertical-tab-content-container text-[13px] text-[var(--text-primary)]"
      />
    </>
  );
}

export function PluginSettingsPage({
  location,
  isActive,
}: {
  location: PluginSettingsLocation;
  isActive: boolean;
}) {
  const snapshot = usePluginsSnapshot();
  const allTabs = usePluginSettingTabs();
  const setEnabled = useSetPluginEnabled();
  const [chosen, setChosen] = useState<string | undefined>(location.tabId);
  const entries = allTabs.filter((t) => t.owner === location.pluginId);
  const entry = entries.find((t) => t.tab.id === chosen) ?? entries[0];
  const title = location.pluginName || location.pluginId;

  let body;
  if (entry) {
    body = (
      <>
        {entries.length > 1 && (
          <div role="tablist" className="mb-4 flex gap-1">
            {entries.map((t) => (
              <button
                key={t.tab.id}
                type="button"
                role="tab"
                aria-selected={t === entry}
                onClick={() => setChosen(t.tab.id)}
                className="rounded-md px-2.5 py-1 text-[13px] text-[var(--text-muted)] aria-selected:bg-[var(--surface-card)] aria-selected:text-[var(--text-primary)]"
              >
                {t.tab.name || t.tab.id}
              </button>
            ))}
          </div>
        )}
        <PluginSettingTabHost pluginId={location.pluginId} tab={entry.tab} />
      </>
    );
  } else if (!snapshot) {
    body = <p className="text-[13px] text-[var(--text-muted)]">Loading plugins…</p>;
  } else {
    const status = snapshot.status[location.pluginId]?.state ?? "disabled";
    const installed = snapshot.installed.some((p) => p.id === location.pluginId);
    body = (
      <div data-plugin-not-loaded className="text-[13px] text-[var(--text-muted)]">
        <p className="mb-3">
          {!installed
            ? `${title} is not installed in this vault.`
            : status === "enabled"
              ? `${title} is loaded but has no options.`
              : !snapshot.trusted
                ? `Plugin not loaded: community plugins are off in this vault (Settings > Community plugins).`
                : `Plugin not loaded: ${title} is disabled. Enable it to see its options.`}
        </p>
        {installed && snapshot.trusted && status !== "enabled" && (
          <button
            type="button"
            className={BUTTON}
            onClick={() => void setEnabled(location.pluginId, true)}
          >
            Enable {title}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      data-plugin-settings-page={location.pluginId}
      className={
        isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none h-full"
      }
      aria-hidden={!isActive}
    >
      <EditorScrollContainer>
        <div className="mx-auto max-w-3xl px-8 pt-32 pb-24 md:pt-[9rem]">
          <h1 className="mb-8 text-2xl font-semibold text-[var(--text-primary)]">
            {title} options
          </h1>
          {body}
        </div>
      </EditorScrollContainer>
    </div>
  );
}
