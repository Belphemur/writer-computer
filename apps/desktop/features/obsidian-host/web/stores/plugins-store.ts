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
} from "../host";
import type { LeafPlacement, WorkspaceBridge, WorkspaceLeaf } from "../host/api/views";
import { findEditorView } from "@/lib/editor-views";
import { setPluginEditorExtensions } from "../host/editor-bridge";
import { recordPluginError } from "../host/error-log";
import {
  createWorkspaceBridge,
  toAbsolutePath,
  toVaultPath,
  type AppWorkspace,
} from "../host/workspace-bridge";
import * as editorApi from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { getFileName } from "@/lib/paths";
import { clearFileViewResolver, setFileViewResolver } from "@/lib/file-views";
import { confirmAction } from "@/lib/tauri";
import { defaultStoreClient, type StorePluginsState } from "../host/store-client";
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
    const { PluginHost } = await import("../host");
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
  /**
   * The plugin leaf behind each file-bound tab (page kind `plugin-file`), by tab id: created by
   * the tab body (`ensureFileLeaf`), or adopted from a leaf a plugin opened itself.
   */
  fileLeaves: ReadonlyMap<string, FileLeafState>;
  /** The host finished loading plugins (or there is none): a tab whose view is missing falls back. */
  fileViewsReady: boolean;
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
  /** Gives a `plugin-file` tab its leaf: opens the file through the registered view (idempotent). */
  ensureFileLeaf: (tabId: string, target: { path: string; viewType: string }) => Promise<void>;
  /** Mirrors a Settings > Secrets change into the running host (null = deleted). */
  syncSecret: (id: string, value: string | null) => void;
  /** Re-attempts the host's keychain read after a denial; no-op when it already succeeded. */
  retrySecrets: () => Promise<void>;
}

/** What a `plugin-file` tab shows: its leaf once open, or why there is none. */
export interface FileLeafState {
  path: string;
  viewType: string;
  status: "opening" | "ready" | "error" | "no-view";
  leaf: WorkspaceLeaf | null;
  error?: string;
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
  fileLeaves: new Map<string, FileLeafState>(),
  fileViewsReady: false,
  leafRevision: 0,
  isPaneOpen: false,
} satisfies Partial<PluginsState>;

const appWorkspace: AppWorkspace = {
  getRoot: getWorkspaceRoot,
  getActiveFilePath: editorApi.getActiveFilePath,
  getEditorView: findEditorView,
  // `navigateToFile` never replaces a plugin view's tab (it opens a new tab instead).
  openFile: (path, { newLeaf, activate }) =>
    newLeaf
      ? editorApi.openFileInNewTab(path, { activate: activate !== false })
      : editorApi.navigateToFile(path),
};

/** The path a leaf's file view shows, for the views that are file views (`FileView.file`). */
const leafFilePath = (leaf: WorkspaceLeaf): string | null => {
  const file = (leaf.view as { file?: { path?: unknown } | null }).file;
  return typeof file?.path === "string" ? file.path : null;
};

/** Waits (bounded) for the text of `path` to reach the disk before a plugin reads it. */
async function waitForSaved(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const file = useEditorStore.getState().openFiles.get(path);
    if (!file || !file.isDirty) return;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

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
let tearingDown = false;
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
  const host = (): PluginHost | null => session?.host ?? null;
  // Tab locations hold absolute paths, the plugins' vault speaks vault-relative ones.
  const toAbs = (vaultPath: string): string => {
    const root = get().root;
    return root ? toAbsolutePath(root, vaultPath) : vaultPath;
  };
  const toRel = (absPath: string): string | null => {
    const root = get().root;
    return root ? toVaultPath(root, absPath) : null;
  };

  /** Sets or (with null) removes the file-leaf state of a `plugin-file` tab. */
  function setFileLeaf(tabId: string, entry: FileLeafState | null): void {
    set((s) => {
      const next = new Map(s.fileLeaves);
      if (entry) next.set(tabId, entry);
      else next.delete(tabId);
      return { fileLeaves: next };
    });
  }

  /** Resolves when the tab's leaf finished opening (or failed), bounded so a hung view cannot stall. */
  function waitForFileLeaf(tabId: string, timeoutMs = 10_000): Promise<void> {
    const settled = () => {
      const st = get().fileLeaves.get(tabId)?.status;
      return st !== undefined && st !== "opening";
    };
    if (settled()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const unsubscribe = usePluginsStore.subscribe(() => {
        if (settled()) done();
      });
    });
  }

  /** An unbound leaf a plugin opened that already shows this file through this view type. */
  function findAdoptable(target: { path: string; viewType: string }): WorkspaceLeaf | null {
    const rel = toRel(target.path);
    return (
      get().mainLeaves.find(
        (l) =>
          l.tabId === null &&
          !l.detached &&
          l.view.getViewType() === target.viewType &&
          leafFilePath(l) === rel,
      ) ?? null
    );
  }

  function paneFor(gen: number) {
    const current = (fn: () => void) => ifCurrent(gen, fn)();
    /** Shows a main-area leaf as an editor tab once it has a view; re-titles an existing tab. */
    const syncMainTab = (leaf: WorkspaceLeaf, focus: boolean) => {
      if (!hasView(leaf) || !get().mainLeaves.includes(leaf)) return;
      // A leaf bound to a tab already has it (the tab body made the leaf).
      if (leaf.tabId !== null) return;
      // A plugin opened a file view itself (`getLeaf("tab")` + `setViewState`): the tab shows the
      // file like any other file tab (persisted, restored), not as a transient plugin view.
      const vaultPath = leafFilePath(leaf);
      if (vaultPath !== null && !tabbed.has(leaf.id)) {
        const path = toAbs(vaultPath);
        const tabId = editorApi.openPluginFileTab({ path, viewType: leaf.view.getViewType() });
        if (tabId !== null && leaf.tabId === null) {
          leaf.tabId = tabId;
          setFileLeaf(tabId, { path, viewType: leaf.view.getViewType(), status: "ready", leaf });
          if (focus) host()?.app.workspace.setActiveLeaf(leaf);
          return;
        }
      }
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
            const tabId = leaf.tabId;
            const entry = tabId === null ? undefined : get().fileLeaves.get(tabId);
            if (tabId !== null && entry?.leaf === leaf) {
              // The leaf went away under a live tab: its plugin was disabled (the file falls back to
              // the text editor) or the view closed itself (the tab goes with it).
              setFileLeaf(tabId, null);
              if (!tearingDown && editorApi.getTabLocation(tabId)?.kind === "plugin-file") {
                if (leaf.ownerRemoved)
                  void editorApi.replaceTabLocation(tabId, { kind: "file", path: entry.path });
                else editorApi.closeTab(tabId);
              }
            } else if (tabId === null) editorApi.closePluginViewTab(leaf.id);
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
        const activeTabId = useEditorStore.getState().activeTabId;
        if (activeTabId !== null && editorApi.getTabLocation(activeTabId)?.kind === "plugin-file")
          return get().fileLeaves.get(activeTabId)?.leaf ?? null;
        const id = editorApi.getPluginViewTabLeafIds().active;
        return id === null ? null : (get().mainLeaves.find((l) => l.id === id) ?? null);
      },
      async showLeafAsText(leaf: WorkspaceLeaf, path: string) {
        if (leaf.tabId === null) return;
        await editorApi.replaceTabLocation(leaf.tabId, { kind: "file", path: toAbs(path) });
      },
      async showFileAsView(vaultPath: string, viewType: string) {
        const tabId = useEditorStore.getState().activeTabId;
        if (tabId === null) throw new Error("No tab to show the view in");
        const path = toAbs(vaultPath);
        // The text editor's pending save lands first: the plugin reads the file from disk.
        await waitForSaved(path);
        await editorApi.replaceTabLocation(tabId, { kind: "plugin-file", path, viewType });
        // The tab body asks for the leaf too (idempotent); do not depend on it being mounted.
        await get().ensureFileLeaf(tabId, { path, viewType });
        await waitForFileLeaf(tabId);
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
    const resolver = (path: string) => {
      const rel = toRel(path);
      if (rel === null) return null;
      try {
        return host.app.workspace.resolveFileView(rel);
      } catch (e) {
        // A misbehaving plugin patch must not make a file unopenable: fall back to the text editor.
        recordPluginError("(host)", "file-view-resolve", e);
        return null;
      }
    };
    setFileViewResolver(resolver);
    const unsubs = [
      host.subscribe(sync(() => set({ snapshot: host.getSnapshot() }))),
      services.commands.subscribe(sync(() => set({ commands: services.commands.list() }))),
      services.ribbon.subscribe(sync(() => set({ ribbon: services.ribbon.list() }))),
      services.statusBar.subscribe(sync(() => set({ statusItems: services.statusBar.list() }))),
      services.settingTabs.subscribe(sync(() => set({ settingTabs: services.settingTabs.list() }))),
      services.registrations.subscribe(
        sync(() => {
          const regs = services.registrations.list().filter((r) => r.kind === "editorExtension");
          const next = regs.map((r) => r.value as Extension);
          if (
            next.length === appliedExtensions.length &&
            next.every((x, i) => x === appliedExtensions[i])
          )
            return;
          appliedExtensions = next;
          const failure = setPluginEditorExtensions(
            next,
            regs.map((r) => r.owner),
          );
          if (failure)
            set({ actionError: `A plugin editor extension was rejected: ${failure.message}` });
        }),
      ),
      // The ONE place Writer's navigation becomes plugin events (file-open, active-leaf-change,
      // layout-change); the workspace dedupes, so every kind of navigation just flows through here.
      useEditorStore.subscribe((state, prev) => {
        if (gen !== generation) return;
        if (state.tabs !== prev.tabs) {
          // A file tab that closed, navigated to another file or turned into the text editor
          // releases its plugin leaf (the view saves and closes).
          for (const [tabId, entry] of get().fileLeaves) {
            const loc = state.tabs.find((t) => t.id === tabId)?.location;
            if (
              loc?.kind === "plugin-file" &&
              loc.path === entry.path &&
              loc.viewType === entry.viewType
            )
              continue;
            setFileLeaf(tabId, null);
            entry.leaf?.detach();
          }
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
      clearFileViewResolver(resolver);
      cancelPendingOpen();
      host.app.setting.openRequested = null;
    };
  }

  async function teardown(): Promise<void> {
    const current = session;
    session = null;
    if (current) {
      // The host going away is not "plugin disabled": file tabs keep their kind and reopen their
      // views when the next host is up (see detachLeaf).
      tearingDown = true;
      try {
        await current.host.shutdown();
      } catch (e) {
        console.error("[plugins] host shutdown failed:", e);
      } finally {
        tearingDown = false;
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
    retrySecrets: async () => void (await session?.host.app.secretStorage.retry()),

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
          // Plugins are loaded (or none will be): file tabs can open their views or fall back.
          set({ fileViewsReady: true });
        } catch (e) {
          if (gen === generation) set({ fileViewsReady: true });
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

    ensureFileLeaf: async (tabId, target) => {
      const current = session;
      const existing = get().fileLeaves.get(tabId);
      if (
        existing &&
        existing.path === target.path &&
        existing.viewType === target.viewType &&
        existing.status !== "no-view"
      )
        return;
      if (!current || !get().fileViewsReady) return;
      const workspace = current.host.app.workspace;
      const entry = { path: target.path, viewType: target.viewType, leaf: null };
      // A leaf a plugin opened itself for this very file (its tab was created just now).
      const adopted = findAdoptable(target);
      if (adopted) {
        adopted.tabId = tabId;
        setFileLeaf(tabId, { ...entry, status: "ready", leaf: adopted });
        return;
      }
      if (!workspace.viewCreator(target.viewType)) {
        setFileLeaf(tabId, { ...entry, status: "no-view" });
        return;
      }
      setFileLeaf(tabId, { ...entry, status: "opening" });
      const stale = () => {
        const now = get().fileLeaves.get(tabId);
        return session !== current || !now || now.path !== target.path || now.status !== "opening";
      };
      try {
        const rel = toRel(target.path);
        if (rel === null) throw new Error(`${target.path} is outside the workspace`);
        // The plugin reads the file's frontmatter from the metadata cache while it loads it.
        await current.host.app.vault.ensureIndexed(rel);
        const file = current.host.app.vault.getFileByPath(rel);
        if (file && file.extension === "md" && !current.host.app.metadataCache.getFileCache(file))
          await current.host.app.metadataCache.indexFile(file);
        const leaf = await workspace.openFileView(rel, target.viewType, tabId);
        if (stale()) {
          leaf.detach();
          return;
        }
        setFileLeaf(tabId, { ...entry, status: "ready", leaf });
        if (useEditorStore.getState().activeTabId === tabId) {
          workspace.syncActiveDocument().catch((e) => recordPluginError("(host)", "file-view", e));
        }
      } catch (e) {
        console.error("[plugins] opening a file view failed:", e);
        recordPluginError(target.viewType, "open-file-view", e);
        if (!stale()) setFileLeaf(tabId, { ...entry, status: "error", error: messageOf(e) });
      }
    },
  };
});
