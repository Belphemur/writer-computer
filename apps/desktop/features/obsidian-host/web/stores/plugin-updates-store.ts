// Plugin updates store: the single owner of "which installed community plugins have a newer
// version" and of running those updates. The backend (plugin_store.rs) does the real work and
// all the safety checks (GitHub-only host allowlist, sha256, minAppVersion); this store only
// sequences calls:
//   check  -> `detail(id)` per installed plugin (its `update` flag compares installed vs. the
//             release manifest), results persisted per vault with the check time.
//   update -> `install(id)` (the same call the marketplace's Update button makes) then
//             `plugins-store.reconcile()`, which unloads the old version and reloads it only if
//             the plugin was enabled. Nothing here ever enables a plugin.
// Checks and update runs never overlap (`status` is the lock). Automatic checks are throttled by
// the persisted timestamp and stay silent on failure; only manual checks surface an error.
import { create } from "zustand";
import { getPreference, setPreference } from "@/lib/preferences";
import { defaultStoreClient, errorMessage, type PluginStoreClient } from "../host/store-client";
import { useSettingsStore } from "@/stores/settings-store";
import { usePluginsStore } from "./plugins-store";

export const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const UPDATE_CHECK_START_DELAY_MS = 30_000;
export const UPDATE_CHECK_PREFERENCE = "plugins.update-checks";
export const AUTO_CHECK_SETTING = "plugins.auto-check-updates";

export interface AvailableUpdate {
  name: string;
  installed: string;
  latest: string;
}

export type UpdateProgress =
  | { state: "pending" | "updating" | "done" }
  | { state: "failed"; error: string };

interface PersistedChecks {
  [root: string]: { checkedAt: number; available: Record<string, AvailableUpdate> };
}

export interface UpdatesDeps {
  client: PluginStoreClient;
  now: () => number;
  autoEnabled: () => boolean;
  reconcile: () => Promise<void>;
  load: () => Promise<PersistedChecks>;
  save: (checks: PersistedChecks) => Promise<void>;
}

const defaultDeps: UpdatesDeps = {
  client: defaultStoreClient,
  now: () => Date.now(),
  autoEnabled: () => useSettingsStore.getState().settings[AUTO_CHECK_SETTING] !== false,
  reconcile: () => usePluginsStore.getState().reconcile(),
  load: async () => {
    const raw = await getPreference<unknown>(UPDATE_CHECK_PREFERENCE, {});
    return raw && typeof raw === "object" ? (raw as PersistedChecks) : {};
  },
  save: (checks) => setPreference(UPDATE_CHECK_PREFERENCE, checks),
};

interface UpdatesState {
  root: string | null;
  status: "idle" | "checking" | "updating";
  available: Record<string, AvailableUpdate>;
  lastCheckedAt: number | null;
  /** Error of the last MANUAL check. Automatic checks never set it. */
  checkError: string | null;
  progress: Record<string, UpdateProgress>;

  /** Binds to a vault: restores its persisted result. Resets everything when `root` changes. */
  attachRoot: (root: string | null) => Promise<void>;
  check: (opts?: { manual?: boolean }) => Promise<void>;
  /** Updates the given plugins (default: every one with an update), one after another. */
  update: (ids?: string[]) => Promise<void>;
  /** Starts the start-up + periodic automatic checks; returns the stop function. */
  startScheduler: () => () => void;
  /** Test seam. */
  configure: (deps: Partial<UpdatesDeps>) => void;
}

const IDLE = {
  root: null,
  status: "idle" as const,
  available: {},
  lastCheckedAt: null,
  checkError: null,
  progress: {},
};

export const useUpdatesStore = create<UpdatesState>((set, get) => {
  let deps = defaultDeps;
  let attachSeq = 0;

  async function persist(root: string): Promise<void> {
    try {
      const all = await deps.load();
      all[root] = { checkedAt: get().lastCheckedAt ?? 0, available: get().available };
      await deps.save(all);
    } catch (e) {
      console.warn("[plugin-updates] could not persist the check result:", e);
    }
  }

  return {
    ...IDLE,

    configure: (next) => {
      deps = { ...defaultDeps, ...next };
    },

    attachRoot: async (root) => {
      if (get().root === root) return;
      const mine = ++attachSeq;
      set({ ...IDLE, root });
      if (!root) return;
      try {
        const saved = (await deps.load())[root];
        if (mine !== attachSeq || !saved || get().root !== root) return;
        set({ lastCheckedAt: saved.checkedAt, available: saved.available ?? {} });
      } catch (e) {
        console.warn("[plugin-updates] could not read the last check:", e);
      }
    },

    check: async ({ manual = false } = {}) => {
      const { root } = get();
      if (!root || get().status !== "idle") return;
      if (!manual) {
        if (!deps.autoEnabled()) return;
        const last = get().lastCheckedAt;
        if (last !== null && deps.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
      }
      set({ status: "checking", checkError: null });
      try {
        const state = await deps.client.state();
        const available: Record<string, AvailableUpdate> = {};
        let ok = 0;
        let failed = 0;
        let lastError: unknown = null;
        // Sequential: each detail call is a few GitHub requests, and a list of a dozen plugins
        // should not burst them.
        for (const plugin of state.installed) {
          try {
            const d = await deps.client.detail(plugin.id);
            ok++;
            if (d.update && d.latest) {
              available[plugin.id] = {
                name: plugin.manifest.name || plugin.id,
                installed: d.installed ?? plugin.manifest.version,
                latest: d.latest.version,
              };
            }
          } catch (e) {
            // A plugin that is not in the catalog (hand-installed) fails alone; only a run
            // where nothing could be checked counts as a failed check.
            failed++;
            lastError = e;
          }
        }
        if (get().root !== root) return;
        if (ok === 0 && failed > 0) throw lastError;
        set({ available, lastCheckedAt: deps.now() });
        await persist(root);
      } catch (e) {
        if (manual) set({ checkError: errorMessage(e) });
        else console.warn("[plugin-updates] automatic check failed:", e);
      } finally {
        if (get().root === root) set({ status: "idle" });
      }
    },

    update: async (ids) => {
      const { root } = get();
      if (!root || get().status !== "idle") return;
      const targets = (ids ?? Object.keys(get().available)).filter((id) => id in get().available);
      if (targets.length === 0) return;
      set({
        status: "updating",
        progress: Object.fromEntries(targets.map((id) => [id, { state: "pending" } as const])),
      });
      for (const id of targets) {
        if (get().root !== root) return;
        set((s) => ({ progress: { ...s.progress, [id]: { state: "updating" } } }));
        try {
          await deps.client.install(id);
          // Reload only what the backend says is enabled; a failure here is the plugin
          // host's (plugins-store shows it), the files on disk are already the new version.
          await deps.reconcile();
          set((s) => {
            const { [id]: _done, ...rest } = s.available;
            return { available: rest, progress: { ...s.progress, [id]: { state: "done" } } };
          });
        } catch (e) {
          set((s) => ({
            progress: { ...s.progress, [id]: { state: "failed", error: errorMessage(e) } },
          }));
        }
      }
      if (get().root !== root) return;
      set({ status: "idle" });
      await persist(root);
    },

    startScheduler: () => {
      const run = () => void get().check();
      const first = setTimeout(run, UPDATE_CHECK_START_DELAY_MS);
      const every = setInterval(run, UPDATE_CHECK_INTERVAL_MS);
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    },
  };
});
