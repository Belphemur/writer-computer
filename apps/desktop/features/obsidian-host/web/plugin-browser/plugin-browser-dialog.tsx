import { useEffect } from "react";
import { ModalShell } from "@/components/modal-shell";
import { PluginBrowser } from ".";
import {
  useClosePluginBrowser,
  useIsPluginBrowserOpen,
  useReconcilePlugins,
  useRequestPluginsTrust,
} from "../use-plugins";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { pluginCatalogStore } from "../stores/plugin-store-catalog";

/** Full-window modal hosting the community-plugin marketplace. Opened from Settings and the
 *  command palette via the UI store; Escape and the backdrop close it. */
export function PluginBrowserDialog() {
  const root = useWorkspaceRoot();
  const isOpen = useIsPluginBrowserOpen();
  const close = useClosePluginBrowser();
  const requestTrust = useRequestPluginsTrust();
  const reconcile = useReconcilePlugins();

  // A workspace switch must not leave the previous vault's marketplace open.
  useEffect(() => {
    if (!root) close();
  }, [root, close]);

  if (!isOpen || !root) return null;

  async function handleRequestTrust() {
    await requestTrust();
    await pluginCatalogStore.getState().refreshState();
  }

  return (
    <ModalShell
      labelledBy="plugin-browser-title"
      onClose={close}
      className="flex max-h-[calc(100vh-3rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]"
    >
      <div className="flex items-center justify-between gap-4 px-5 py-3.5">
        <h2
          id="plugin-browser-title"
          className="text-[15px] font-semibold text-[var(--text-primary)]"
        >
          Browse community plugins
        </h2>
        <button
          type="button"
          className="rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={close}
        >
          Close
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto px-5 pb-5">
        <PluginBrowser
          onRequestTrust={() => void handleRequestTrust()}
          onPluginsChanged={() => void reconcile()}
        />
      </div>
    </ModalShell>
  );
}
