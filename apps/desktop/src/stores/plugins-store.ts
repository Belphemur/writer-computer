// Plugins store: the single write path between the UI and the Obsidian plugin host.
//
// It owns one `PluginHost` per open workspace window and mirrors what the UI renders (host
// snapshot, command/ribbon/status/setting-tab registries, plugin pane leaves). All trust, enable
// and disable changes go through the actions below; components never talk to the host directly.
//
// Lifecycle: `attach(root)` creates the host and only boots (loads plugins) when the backend says
// the vault is trusted. Plugins run with the app's privileges (there is no in-page sandbox; see
// SPECs/obsidian-plugins-spec.md). `attach`/`detach` are serialized and generation-
// checked so a fast workspace switch can never leave two live hosts.
import { create } from "zustand";
import type { Extension } from "@codemirror/state";
import type {
  HostSnapshot,
  PluginHost,
  RegisteredCommand,
  RibbonItem,
  SettingTabEntry,
  StatusBarItem,
} from "@/lib/obsidian-host";
import type { LeafPlacement, WorkspaceBridge, WorkspaceLeaf } from "@/lib/obsidian-host/api/views";
import { setPluginEditorExtensions, findEditorView } from "@/lib/obsidian-host/editor-bridge";
import { recordPluginError } from "@/lib/obsidian-host/error-log";
import {
  createWorkspaceBridge,
  toVaultPath,
  type AppWorkspace,
} from "@/lib/obsidian-host/workspace-bridge";
import * as editorApi from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { getFileName } from "@/lib/paths";
import { confirmAction } from "@/lib/tauri";
import { defaultStoreClient, type StorePluginsState } from "@/lib/obsidian-host/store-client";
import { useEditorStore } from "@/stores/editor-store";
import { pluginSectionId } from "@/components/settings-panel/settings-sections";

export const PANE_MIN_WIDTH = 280;
export const PANE_MAX_WIDTH = 640;
const PANE_DEFAULT_WIDTH = 360;

/** Injection points; production uses the defaults, tests pass fakes. */
export interface PluginsDeps {
  /** Builds the host. Default: lazy-imports the shim and uses the Tauri-backed vault IO. */
  createHost?: (root: string, name: string, bridge: WorkspaceBridge) => Promise<PluginHost>;
  /** Reads the backend's trust/enabled/installed state (the marketplace writes it directly). */
  readState?: () => Promise<StorePluginsState>;
}

export const TRUST_MESSAGE =
  "Community plugins are code written by third parties. They run with full access to this " +
  "vault and to Writer's commands and are not sandboxed. Only turn this on for vaults and " +
  "plugins you trust.";

export interface ReconcilePlan {
  unload: string[];
  load: string[];
}

/**
 * What the running host must do to match the backend after the marketplace changed it behind
 * the host's back (install/update/uninstall/enable/disable). `loaded` maps each plugin that is
 * currently running to the version that was loaded. Nothing changes while the vault is
 * untrusted (trust revocation already unloaded everything).
 */
export function planReconcile(
  loaded: ReadonlyMap<string, string>,
  state: Pick<StorePluginsState, "trusted" | "enabled"> & {
    installed: readonly { id: string; manifest: { version: string } }[];
  },
): ReconcilePlan {
  if (!state.trusted) return { unload: [], load: [] };
  const versions = new Map(state.installed.map((p) => [p.id, p.manifest.version]));
  const enabled = new Set(state.enabled);
  const wanted = (id: string) => enabled.has(id) && versions.has(id);
  const unload = [...loaded]
    .filter(([id, v]) => !wanted(id) || versions.get(id) !== v)
    .map(([id]) => id);
  const unloaded = new Set(unload);
  const load = [...versions.keys()].filter(
    (id) => wanted(id) && (!loaded.has(id) || unloaded.has(id)),
  );
  return { unload, load };
}

/**
 * Resolves what a plugin passed to `app.setting.openTabById(id)`: a setting-tab id as registered
 * (`<pluginId>:<tabId>`), a plugin id (its first tab), or a bare tab id. Null when nothing matches.
 */
export function resolveSettingTarget(
  entries: readonly SettingTabEntry[],
  id: string,
): SettingTabEntry | null {
  return (
    entries.find((e) => `${e.owner}:${e.tab.id}` === id) ??
    entries.find((e) => e.owner === id) ??
    entries.find((e) => e.tab.id === id) ??
    null
  );
}

/** `app.setting.open()` with no id waits this long for a following `openTabById` (Copilot calls
 *  `open()` then `openTabById("copilot")` a frame later) before settling for the Settings page. */
export const SETTING_OPEN_GRACE_MS = 150;

const defaultDeps: Required<PluginsDeps> = {
  readState: () => defaultStoreClient.state(),
  createHost: async (root, name, bridge) => {
    const { PluginHost } = await import("@/lib/obsidian-host");
    return PluginHost.forWorkspace(root, name, bridge);
  },
};

interface PluginsState {
  root: string | null;
  snapshot: HostSnapshot | null;
  /** Why plugins are not running (boot failure). Null when fine. */
  bootError: string | null;
  /** Last failed user action (enable/disable/trust) or rejected editor extension. */
  actionError: string | null;
  commands: readonly RegisteredCommand[];
  ribbon: readonly RibbonItem[];
  statusItems: readonly StatusBarItem[];
  settingTabs: readonly SettingTabEntry[];
  /** Side-pane leaves (placement left/right). */
  leaves: readonly WorkspaceLeaf[];
  /** Main-area leaves; each one that shows a view is an editor tab (page kind `plugin-view`). */
  mainLeaves: readonly WorkspaceLeaf[];
  activeLeaf: WorkspaceLeaf | null;
  /** Bumped when a leaf's title or icon changes, so the pane header re-renders. */
  leafRevision: number;
  isPaneOpen: boolean;
  paneWidth: number;

  attach: (root: string, deps?: PluginsDeps) => Promise<void>;
  detach: () => Promise<void>;
  setTrusted: (trusted: boolean) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Confirmation dialog, then `setTrusted(true)`. The one trust flow for every surface. */
  requestTrust: () => Promise<void>;
  /** Aligns the running host with the backend after marketplace changes (load/unload). */
  reconcile: () => Promise<void>;
  /** Re-reads the installed list (after a marketplace install/uninstall). */
  refresh: () => Promise<void>;
  notifyExternal: (kind: "create" | "modify" | "delete", absPath: string) => Promise<void>;
  clearActionError: () => void;
  togglePane: () => void;
  closePane: () => void;
  setPaneWidth: (width: number) => void;
  selectLeaf: (leaf: WorkspaceLeaf) => void;
  /** Mirrors a Settings > Secrets change into the running host (null = deleted). */
  syncSecret: (id: string, value: string | null) => void;
}

interface Session {
  host: PluginHost;
  readState: () => Promise<StorePluginsState>;
  unsubscribe: () => void;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const IDLE = {
  root: null,
  snapshot: null,
  bootError: null,
  actionError: null,
  commands: [],
  ribbon: [],
  statusItems: [],
  settingTabs: [],
  leaves: [],
  mainLeaves: [],
  activeLeaf: null,
  leafRevision: 0,
  isPaneOpen: false,
} satisfies Partial<PluginsState>;

const appWorkspace: AppWorkspace = {
  getRoot: getWorkspaceRoot,
  getActiveFilePath: editorApi.getActiveFilePath,
  getEditorView: findEditorView,
  // `navigateToFile` never replaces a plugin view's tab (it opens a new tab instead).
  openFile: (path, { newLeaf }) =>
    newLeaf ? editorApi.openFileInNewTab(path) : editorApi.navigateToFile(path),
};

/** An empty leaf (nothing opened in it yet) has no tab. */
const hasView = (leaf: WorkspaceLeaf): boolean => {
  const type = leaf.view.getViewType();
  return type !== "empty" && type !== "markdown";
};

const leafTitle = (leaf: WorkspaceLeaf): string =>
  leaf.view.getDisplayText() || leaf.view.getViewType() || "Plugin view";

/** Watcher events waiting for the plugin vault (see `notifyExternal`). */
interface ExternalEvent {
  kind: "create" | "modify" | "delete";
  absPath: string;
  started: boolean;
  done: Promise<void>;
  resolve: () => void;
}
const externalQueue: ExternalEvent[] = [];
const externalLast = new Map<string, ExternalEvent>();
let externalDraining = false;
const EXTERNAL_YIELD_EVERY = 16;

async function deliverExternalEvent(state: PluginsState, e: ExternalEvent): Promise<void> {
  const current = session;
  const root = state.root;
  const snapshot = current?.host.getSnapshot();
  if (!current || !root || !snapshot?.trusted || !snapshot.booted) return;
  const path = toVaultPath(root, e.absPath);
  if (path === null) return;
  try {
    await current.host.app.vault.notifyExternal(e.kind, path);
  } catch (err) {
    console.error("[plugins] notifyExternal failed:", err);
  }
}

async function drainExternalQueue(deliver: (e: ExternalEvent) => Promise<void>): Promise<void> {
  let handled = 0;
  try {
    for (let e = externalQueue.shift(); e; e = externalQueue.shift()) {
      e.started = true;
      if (externalLast.get(e.absPath) === e) externalLast.delete(e.absPath);
      try {
        await deliver(e);
      } finally {
        e.resolve();
      }
      if (++handled % EXTERNAL_YIELD_EVERY === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } finally {
    externalDraining = false;
  }
}

let session: Session | null = null;
let generation = 0;
// attach/detach run strictly one after another; `generation` lets a superseded attach bail out.
let lifecycle: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = lifecycle.catch(() => undefined).then(task);
  lifecycle = run;
  return run;
}

export const usePluginsStore = create<PluginsState>((set, get) => {
  const ifCurrent =
    (gen: number, fn: () => void): (() => void) =>
    () => {
      if (gen === generation) fn();
    };

  // Ids of main-area leaves that currently have an editor tab (to notice tabs the user closed).
  const tabbed = new Set<string>();

  function paneFor(gen: number) {
    const current = (fn: () => void) => ifCurrent(gen, fn)();
    /** Shows a main-area leaf as an editor tab once it has a view; re-titles an existing tab. */
    const syncMainTab = (leaf: WorkspaceLeaf, focus: boolean) => {
      if (!hasView(leaf) || !get().mainLeaves.includes(leaf)) return;
      const title = leafTitle(leaf);
      if (tabbed.has(leaf.id)) {
        editorApi.updatePluginViewTab(leaf.id, title);
        if (focus) editorApi.openPluginViewTab({ leafId: leaf.id, title });
        return;
      }
      tabbed.add(leaf.id);
      editorApi.openPluginViewTab({ leafId: leaf.id, title });
    };
    return {
      mountLeaf(leaf: WorkspaceLeaf, placement: LeafPlacement) {
        current(() =>
          set((s) => {
            if (placement === "main")
              return s.mainLeaves.includes(leaf) ? s : { mainLeaves: [...s.mainLeaves, leaf] };
            return s.leaves.includes(leaf)
              ? s
              : { leaves: [...s.leaves, leaf], activeLeaf: s.activeLeaf ?? leaf };
          }),
        );
      },
      revealLeaf(leaf: WorkspaceLeaf) {
        current(() => {
          if (leaf.placement === "main") {
            // The editor leaf is already the active document tab; empty leaves have nothing yet.
            syncMainTab(leaf, true);
            return;
          }
          set((s) => ({
            leaves: s.leaves.includes(leaf) ? s.leaves : [...s.leaves, leaf],
            activeLeaf: leaf,
            isPaneOpen: true,
          }));
        });
      },
      leafChanged(leaf: WorkspaceLeaf) {
        current(() => {
          set((s) => ({ leafRevision: s.leafRevision + 1 }));
          if (leaf.placement === "main") syncMainTab(leaf, false);
        });
      },
      detachLeaf(leaf: WorkspaceLeaf) {
        current(() => {
          if (leaf.placement === "main") {
            tabbed.delete(leaf.id);
            editorApi.closePluginViewTab(leaf.id);
            set((s) =>
              s.mainLeaves.includes(leaf)
                ? { mainLeaves: s.mainLeaves.filter((l) => l !== leaf) }
                : s,
            );
            return;
          }
          set((s) => {
            if (!s.leaves.includes(leaf)) return s;
            const leaves = s.leaves.filter((l) => l !== leaf);
            const activeLeaf =
              s.activeLeaf === leaf ? (leaves[leaves.length - 1] ?? null) : s.activeLeaf;
            return {
              leaves,
              activeLeaf,
              isPaneOpen: leaves.length === 0 ? false : s.isPaneOpen,
            };
          });
        });
      },
      activePluginLeaf(): WorkspaceLeaf | null {
        const id = editorApi.getPluginViewTabLeafIds().active;
        return id === null ? null : (get().mainLeaves.find((l) => l.id === id) ?? null);
      },
    };
  }

  /** Mirrors host registries into the store and applies editor extensions. */
  function wire(gen: number, host: PluginHost): () => void {
    const { services } = host;
    const sync = (fn: () => void) => ifCurrent(gen, fn);
    let appliedExtensions: Extension[] = [];
    let pendingOpen: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingOpen = () => {
      if (pendingOpen !== null) clearTimeout(pendingOpen);
      pendingOpen = null;
    };
    host.app.setting.openRequested = (id) => {
      cancelPendingOpen();
      if (gen !== generation) return;
      if (id === null) {
        pendingOpen = setTimeout(() => {
          pendingOpen = null;
          if (gen === generation) editorApi.openSettings();
        }, SETTING_OPEN_GRACE_MS);
        return;
      }
      const entry = resolveSettingTarget(services.settingTabs.list(), id);
      if (!entry) {
        recordPluginError("(host)", "setting.openTabById", new Error(`no setting tab "${id}"`));
        editorApi.openSettings();
        return;
      }
      editorApi.openSettings(pluginSectionId(entry.owner, entry.tab.id));
    };
    const unsubs = [
      host.subscribe(sync(() => set({ snapshot: host.getSnapshot() }))),
      services.commands.subscribe(sync(() => set({ commands: services.commands.list() }))),
      services.ribbon.subscribe(sync(() => set({ ribbon: services.ribbon.list() }))),
      services.statusBar.subscribe(sync(() => set({ statusItems: services.statusBar.list() }))),
      services.settingTabs.subscribe(sync(() => set({ settingTabs: services.settingTabs.list() }))),
      services.registrations.subscribe(
        sync(() => {
          const next = services.registrations
            .list()
            .filter((r) => r.kind === "editorExtension")
            .map((r) => r.value as Extension);
          if (
            next.length === appliedExtensions.length &&
            next.every((x, i) => x === appliedExtensions[i])
          )
            return;
          appliedExtensions = next;
          const failure = setPluginEditorExtensions(next);
          if (failure)
            set({ actionError: `A plugin editor extension was rejected: ${failure.message}` });
        }),
      ),
      // The ONE place Writer's navigation becomes plugin events (file-open, active-leaf-change,
      // layout-change); the workspace dedupes, so every kind of navigation just flows through here.
      useEditorStore.subscribe((state, prev) => {
        if (gen !== generation) return;
        if (state.tabs !== prev.tabs) {
          // A tab the user closed (or navigation replaced) takes its plugin leaf with it.
          const open = new Set(editorApi.getPluginViewTabLeafIds().open);
          for (const leaf of get().mainLeaves)
            if (tabbed.has(leaf.id) && !open.has(leaf.id)) {
              tabbed.delete(leaf.id);
              leaf.detach();
            }
        }
        if (state.activeFilePath === prev.activeFilePath && state.activeTabId === prev.activeTabId)
          return;
        host.app.workspace.syncActiveDocument().catch((e) => {
          console.error("[plugins] active document sync failed:", e);
          recordPluginError("(host)", "active-document", e);
        });
      }),
    ];
    return () => {
      for (const u of unsubs) u();
      cancelPendingOpen();
      host.app.setting.openRequested = null;
    };
  }

  async function teardown(): Promise<void> {
    const current = session;
    session = null;
    if (current) {
      try {
        await current.host.shutdown();
      } catch (e) {
        console.error("[plugins] host shutdown failed:", e);
      }
      current.unsubscribe();
    }
    setPluginEditorExtensions([]);
    tabbed.clear();
    set({ ...IDLE });
  }

  async function runAction(label: string, fn: (current: Session) => Promise<void>): Promise<void> {
    const current = session;
    if (!current) {
      set({ actionError: `${label}: no workspace is open` });
      return;
    }
    set({ actionError: null });
    try {
      await fn(current);
    } catch (e) {
      console.error(`[plugins] ${label} failed:`, e);
      if (session === current) set({ actionError: `${label}: ${messageOf(e)}` });
    }
  }

  return {
    ...IDLE,
    paneWidth: PANE_DEFAULT_WIDTH,

    syncSecret: (id, value) => session?.host.app.secretStorage.applyExternal(id, value),

    attach: (root, deps) => {
      const gen = ++generation;
      return enqueue(async () => {
        await teardown();
        if (gen !== generation) return;
        const { createHost, readState } = { ...defaultDeps, ...deps };
        set({ root });
        let host: PluginHost | null = null;
        try {
          const bridge = createWorkspaceBridge(appWorkspace, paneFor(gen));
          host = await createHost(root, getFileName(root), bridge);
          if (gen !== generation) {
            await host.shutdown();
            return;
          }
          const current: Session = { host, readState, unsubscribe: wire(gen, host) };
          session = current;
          // Read-only: lists what is installed and whether this vault is trusted.
          await host.refresh();
          set({ snapshot: host.getSnapshot() });
          if (host.getSnapshot().trusted) {
            await host.boot();
            if (gen !== generation) return;
            host.app.workspace.markLayoutReady();
          }
        } catch (e) {
          console.error("[plugins] boot failed:", e);
          if (gen === generation) {
            recordPluginError("(host)", "boot", e);
            set({ bootError: `Plugins failed to start: ${messageOf(e)}` });
          }
        }
      });
    },

    detach: () => {
      generation++;
      return enqueue(teardown);
    },

    setTrusted: (trusted) =>
      runAction(
        trusted ? "Trusting community plugins" : "Restricting community plugins",
        async (current) => {
          set({ bootError: null });
          await current.host.setTrust(trusted);
          if (trusted) current.host.app.workspace.markLayoutReady();
        },
      ),

    setEnabled: (id, enabled) =>
      runAction(`${enabled ? "Enabling" : "Disabling"} plugin ${id}`, async (current) => {
        if (enabled) {
          await current.host.enable(id);
          current.host.app.workspace.markLayoutReady();
        } else {
          await current.host.disable(id);
        }
      }),

    requestTrust: async () => {
      let confirmed = false;
      try {
        confirmed = await confirmAction(TRUST_MESSAGE, "Turn on community plugins?");
      } catch (e) {
        // A failed dialog must not look like a dead button.
        console.error("[plugins] trust confirmation failed:", e);
        set({ actionError: `Could not show the confirmation: ${messageOf(e)}` });
        return;
      }
      if (confirmed) await get().setTrusted(true);
    },

    reconcile: () =>
      runAction("Reloading plugins", async ({ host, readState }) => {
        const before = host.getSnapshot();
        const loaded = new Map<string, string>();
        for (const m of before.installed) {
          if (before.status[m.id]?.state === "enabled") loaded.set(m.id, m.version);
        }
        // A plugin uninstalled meanwhile is absent from `installed` but may still be running.
        for (const [id, status] of Object.entries(before.status)) {
          if (status.state === "enabled" && !loaded.has(id)) loaded.set(id, "");
        }
        await host.refresh();
        const plan = planReconcile(loaded, await readState());
        for (const id of plan.unload) await host.disable(id);
        for (const id of plan.load) await host.enable(id);
        if (plan.load.length > 0) host.app.workspace.markLayoutReady();
      }),

    refresh: () => runAction("Refreshing plugins", (current) => current.host.refresh()),

    notifyExternal: (kind, absPath) => {
      // One watcher burst reports the same path several times (the file, its parent folder,
      // metadata and data records). A repeat of the newest pending event for a path collapses
      // into it (order across different events is kept), and the queue is fed to the vault one
      // event at a time, yielding regularly, so a flood (a plugin seeding a folder, another app
      // rewriting it) cannot starve the UI thread.
      const last = externalLast.get(absPath);
      if (last && last.kind === kind && !last.started) return last.done;
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      const entry: ExternalEvent = { kind, absPath, started: false, done, resolve };
      externalQueue.push(entry);
      externalLast.set(absPath, entry);
      if (!externalDraining) {
        externalDraining = true;
        // Next microtask: a burst reported in one tick is queued whole, so repeats can collapse.
        void Promise.resolve().then(() =>
          drainExternalQueue((e) => deliverExternalEvent(get(), e)),
        );
      }
      return done;
    },

    clearActionError: () => set({ actionError: null }),
    togglePane: () => set((s) => (s.leaves.length === 0 ? s : { isPaneOpen: !s.isPaneOpen })),
    closePane: () => set((s) => (s.isPaneOpen ? { isPaneOpen: false } : s)),
    setPaneWidth: (width) => {
      const next = Math.max(PANE_MIN_WIDTH, Math.min(PANE_MAX_WIDTH, Math.round(width)));
      set((s) => (s.paneWidth === next ? s : { paneWidth: next }));
    },
    selectLeaf: (leaf) => set((s) => (s.activeLeaf === leaf ? s : { activeLeaf: leaf })),
  };
});
