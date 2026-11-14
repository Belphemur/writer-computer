import {
  usePluginSettingTabs,
  usePluginsActionError,
  usePluginsBootError,
  usePluginsSnapshot,
  useOpenPluginBrowser,
  useRequestPluginsTrust,
  useSetPluginEnabled,
  useSetPluginsTrusted,
} from "@/hooks/use-plugins";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { BooleanControl } from "@/components/settings-panel/setting-control";
import { useOpenPluginSettings } from "@/hooks/use-tabs";

const ROW = "flex items-start justify-between gap-4 px-4 py-3.5";
const TITLE = "text-[13px] font-medium text-[var(--text-primary)]";
const SUBTITLE = "mt-0.5 text-[13px] text-[var(--text-muted)]";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)]";

export function CommunityPluginsSection() {
  const root = useWorkspaceRoot();
  const snapshot = usePluginsSnapshot();
  const bootError = usePluginsBootError();
  const actionError = usePluginsActionError();
  const settingTabs = usePluginSettingTabs();
  const setTrusted = useSetPluginsTrusted();
  const setEnabled = useSetPluginEnabled();
  const requestTrust = useRequestPluginsTrust();
  const openBrowser = useOpenPluginBrowser();
  const openPluginSettings = useOpenPluginSettings();

  // Community plugins belong to a vault: nothing to configure without a workspace.
  if (!root || !snapshot) return null;

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
        <div className={`${ROW} border-t border-[var(--line-subtler)]`}>
          <div className="min-w-0 flex-1">
            <div className={TITLE}>Browse community plugins</div>
            <div className={SUBTITLE}>
              Find, install and update plugins from the community catalog. Installing never turns a
              plugin on.
            </div>
          </div>
          <button type="button" className={BUTTON} onClick={openBrowser}>
            Browse…
          </button>
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
            No plugins installed in this vault (.obsidian/plugins). Use Browse to find some.
          </div>
        )}
        {snapshot.installed.map((plugin) => {
          const status = snapshot.status[plugin.id] ?? { state: "disabled" as const };
          const firstTab = settingTabs.find((t) => t.owner === plugin.id);
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
                  {firstTab && (
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() =>
                        openPluginSettings({
                          pluginId: plugin.id,
                          pluginName: plugin.name,
                          tabId: firstTab.tab.id,
                        })
                      }
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
            </div>
          );
        })}
      </div>
    </section>
  );
}
