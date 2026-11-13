import { useEffect, useRef, useState } from "react";
import {
  usePluginSettingTabs,
  usePluginsActionError,
  usePluginsBootError,
  usePluginsSnapshot,
  useSetPluginEnabled,
  useSetPluginsTrusted,
} from "@/hooks/use-plugins";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { confirmAction } from "@/lib/tauri";
import { BooleanControl } from "@/components/settings-panel/setting-control";
import type { SettingTabLike } from "@/lib/obsidian-host/api/core";

const TRUST_MESSAGE =
  "Community plugins are code written by third parties. They run with full access to this " +
  "vault and to Writer's commands and are not sandboxed. Only turn this on for vaults and " +
  "plugins you trust.";

const ROW = "flex items-start justify-between gap-4 px-4 py-3.5";
const TITLE = "text-[13px] font-medium text-[var(--text-primary)]";
const SUBTITLE = "mt-0.5 text-[13px] text-[var(--text-muted)]";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)]";

/** Hosts a plugin's PluginSettingTab: display() on mount, hide() on unmount. */
function PluginSettingsTab({ tab }: { tab: SettingTabLike }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(tab.containerEl);
    try {
      tab.display();
      setError(null);
    } catch (e) {
      console.error(`[plugin] settings tab ${tab.id} display threw:`, e);
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => {
      try {
        tab.hide();
      } catch (e) {
        console.error(`[plugin] settings tab ${tab.id} hide threw:`, e);
      }
      if (tab.containerEl.parentElement === host) tab.containerEl.remove();
    };
  }, [tab]);
  return (
    <div className="border-t border-[var(--line-subtler)] px-4 py-3.5">
      {error && <div className="mb-2 text-[13px] text-red-500">{error}</div>}
      <div ref={hostRef} className="text-[13px] text-[var(--text-primary)]" />
    </div>
  );
}

export function CommunityPluginsSection() {
  const root = useWorkspaceRoot();
  const snapshot = usePluginsSnapshot();
  const bootError = usePluginsBootError();
  const actionError = usePluginsActionError();
  const settingTabs = usePluginSettingTabs();
  const setTrusted = useSetPluginsTrusted();
  const setEnabled = useSetPluginEnabled();
  const [selected, setSelected] = useState<string | null>(null);

  // Community plugins belong to a vault: nothing to configure without a workspace.
  if (!root || !snapshot) return null;

  async function requestTrust() {
    if (await confirmAction(TRUST_MESSAGE, "Turn on community plugins?")) await setTrusted(true);
  }

  const selectedTab = selected ? settingTabs.find((t) => t.owner === selected) : undefined;

  return (
    <section className="mb-10" data-community-plugins>
      <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">Community plugins</h2>
      <div className="-mx-4 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        <div className={ROW}>
          <div className="min-w-0 flex-1">
            <div className={TITLE}>
              {snapshot.trusted ? "Community plugins are on" : "Restricted mode"}
            </div>
            <div className={SUBTITLE}>
              {snapshot.trusted
                ? "Enabled plugins run in this vault. Turn this off to unload all of them."
                : "Plugins in this vault are not loaded. Turn on community plugins only if you trust the plugins installed here."}
            </div>
          </div>
          {snapshot.trusted ? (
            <button type="button" className={BUTTON} onClick={() => void setTrusted(false)}>
              Turn off
            </button>
          ) : (
            <button type="button" className={BUTTON} onClick={() => void requestTrust()}>
              Turn on…
            </button>
          )}
        </div>
        {(bootError || actionError) && (
          <div
            role="alert"
            className="border-t border-[var(--line-subtler)] px-4 py-3 text-[13px] text-red-500"
          >
            {bootError ?? actionError}
          </div>
        )}
        {snapshot.installed.length === 0 && (
          <div className="border-t border-[var(--line-subtler)] px-4 py-3.5 text-[13px] text-[var(--text-muted)]">
            No plugins installed in this vault (.obsidian/plugins).
          </div>
        )}
        {snapshot.installed.map((plugin) => {
          const status = snapshot.status[plugin.id] ?? { state: "disabled" as const };
          const hasTab = settingTabs.some((t) => t.owner === plugin.id);
          return (
            <div key={plugin.id} className="border-t border-[var(--line-subtler)]">
              <div className={ROW}>
                <div className="min-w-0 flex-1">
                  <div className={TITLE}>
                    {plugin.name} <span className="text-[var(--text-muted)]">{plugin.version}</span>
                  </div>
                  {plugin.description && <div className={SUBTITLE}>{plugin.description}</div>}
                  {status.state === "failed" && (
                    <div className="mt-0.5 text-[13px] text-red-500">Failed: {status.error}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {hasTab && (
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() => setSelected(selected === plugin.id ? null : plugin.id)}
                    >
                      Options
                    </button>
                  )}
                  <BooleanControl
                    value={status.state === "enabled"}
                    label={`Enable ${plugin.name}`}
                    onChange={(next) => void setEnabled(plugin.id, next)}
                  />
                </div>
              </div>
              {selectedTab && selectedTab.owner === plugin.id && (
                <PluginSettingsTab tab={selectedTab.tab} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
