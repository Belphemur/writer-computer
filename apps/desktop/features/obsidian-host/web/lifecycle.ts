// The Obsidian host's lifecycle, owned by the `obsidian-host` feature (it was the
// `usePluginHostLifecycle` hook mounted in `App.tsx`): attach the plugin host when a workspace
// window is ready, detach when the workspace changes or closes or the feature is switched off.
// The trust gate is unchanged: `attach` only loads plugins when the backend says the vault is
// trusted (SPECs/obsidian-plugins-spec.md, ADR trust-vaults-before-running-plugins).
import { getWorkspaceChromeMode } from "@/lib/compact-mode";
import { failFeature } from "@/lib/features/health";
import type { Dispose } from "@/lib/features/types";
import { usePluginsStore } from "./stores/plugins-store";
import { useUpdatesStore } from "./stores/plugin-updates-store";
import { usePluginBrowserStore } from "./stores/plugin-browser-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export const OBSIDIAN_HOST_ID = "obsidian-host";

/** The vault root the host belongs to: set once startup resolved, in a workspace window (never
 *  the standalone compact window or the welcome screen). */
export function hostRoot(s: {
  root: string | null;
  chromeMode: Parameters<typeof getWorkspaceChromeMode>[1];
  isStartupResolved: boolean;
}): string | null {
  if (!s.isStartupResolved || s.root === null) return null;
  return getWorkspaceChromeMode(s.root, s.chromeMode) === "workspace" ? s.root : null;
}

export interface LifecycleDeps {
  workspace?: Pick<typeof useWorkspaceStore, "getState" | "subscribe">;
  plugins?: Pick<typeof usePluginsStore, "getState">;
  updates?: Pick<typeof useUpdatesStore, "getState">;
  /** A host that could not boot is a feature failure: off for the session, with the notice. */
  onBootFailure?: (message: string) => void;
}

/** Starts following the workspace; the returned dispose detaches the host and stops. */
export function startHostLifecycle({
  workspace = useWorkspaceStore,
  plugins = usePluginsStore,
  updates = useUpdatesStore,
  onBootFailure = () => failFeature(OBSIDIAN_HOST_ID, "boot"),
}: LifecycleDeps = {}): Dispose {
  let attached: { root: string; stop: () => void } | null = null;

  const stopCurrent = () => {
    attached?.stop();
    attached = null;
  };

  const start = (root: string) => {
    void plugins
      .getState()
      .attach(root)
      .then(() => {
        const failure = plugins.getState().bootError;
        if (failure && attached?.root === root) onBootFailure(failure);
      });
    // Update state is bound to the same vault; the scheduler checks shortly after start and
    // then every few hours (throttled by the persisted timestamp, silent on failure).
    const u = updates.getState();
    void u.attachRoot(root);
    const stopChecks = u.startScheduler();
    attached = {
      root,
      stop: () => {
        stopChecks();
        void updates.getState().attachRoot(null);
        void plugins.getState().detach();
        usePluginBrowserStore.getState().close();
      },
    };
  };

  const sync = () => {
    const root = hostRoot(workspace.getState());
    if (attached?.root === root) return;
    stopCurrent();
    if (root !== null) start(root);
  };

  sync();
  const unsubscribe = workspace.subscribe(sync);
  return () => {
    unsubscribe();
    stopCurrent();
  };
}
