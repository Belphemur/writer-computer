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
import { useEditorStore } from "@/stores/editor-store";

export const PANE_MIN_WIDTH = 280;
export const PANE_MAX_WIDTH = 640;
const PANE_DEFAULT_WIDTH = 360;

/** Injection points; production uses the defaults, tests pass fakes. */
export interface PluginsDeps {
  /** Builds the host. Default: lazy-imports the shim and uses the Tauri-backed vault IO. */
  createHost?: (root: string, name: string, bridge: WorkspaceBridge) => Promise<PluginHost>;
}

const defaultDeps: Required<PluginsDeps> = {
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
  leaves: readonly WorkspaceLeaf[];
  activeLeaf: WorkspaceLeaf | null;
  /** Bumped when a leaf's title or icon changes, so the pane header re-renders. */
  leafRevision: number;
  isPaneOpen: boolean;
  paneWidth: number;

  attach: (root: string, deps?: PluginsDeps) => Promise<void>;
  detach: () => Promise<void>;
  setTrusted: (trusted: boolean) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Re-reads the installed list (after a marketplace install/uninstall). */
  refresh: () => Promise<void>;
  notifyExternal: (kind: "create" | "modify" | "delete", absPath: string) => Promise<void>;
  clearActionError: () => void;
  togglePane: () => void;
  closePane: () => void;
  setPaneWidth: (width: number) => void;
  selectLeaf: (leaf: WorkspaceLeaf) => void;
}

interface Session {
  host: PluginHost;
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
  activeLeaf: null,
  leafRevision: 0,
  isPaneOpen: false,
} satisfies Partial<PluginsState>;

const appWorkspace: AppWorkspace = {
  getRoot: getWorkspaceRoot,
  getActiveFilePath: editorApi.getActiveFilePath,
  getEditorView: findEditorView,
  openFile: (path, { newLeaf }) =>
    newLeaf ? editorApi.openFileInNewTab(path) : editorApi.navigateToFile(path),
};

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

  function paneFor(gen: number) {
    const current = (fn: () => void) => ifCurrent(gen, fn)();
    return {
      mountLeaf(leaf: WorkspaceLeaf, _placement: LeafPlacement) {
        current(() =>
          set((s) =>
            s.leaves.includes(leaf)
              ? s
              : { leaves: [...s.leaves, leaf], activeLeaf: s.activeLeaf ?? leaf },
          ),
        );
      },
      revealLeaf(leaf: WorkspaceLeaf) {
        current(() =>
          set((s) => ({
            leaves: s.leaves.includes(leaf) ? s.leaves : [...s.leaves, leaf],
            activeLeaf: leaf,
            isPaneOpen: true,
          })),
        );
      },
      leafChanged(_leaf: WorkspaceLeaf) {
        current(() => set((s) => ({ leafRevision: s.leafRevision + 1 })));
      },
      detachLeaf(leaf: WorkspaceLeaf) {
        current(() =>
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
          }),
        );
      },
    };
  }

  /** Mirrors host registries into the store and applies editor extensions. */
  function wire(gen: number, host: PluginHost): () => void {
    const { services } = host;
    const sync = (fn: () => void) => ifCurrent(gen, fn);
    let appliedExtensions: Extension[] = [];
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
      useEditorStore.subscribe((state, prev) => {
        if (gen !== generation || state.activeFilePath === prev.activeFilePath) return;
        host.app.workspace.trigger("file-open", host.app.workspace.getActiveFile());
      }),
    ];
    return () => {
      for (const u of unsubs) u();
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

    attach: (root, deps) => {
      const gen = ++generation;
      return enqueue(async () => {
        await teardown();
        if (gen !== generation) return;
        const { createHost } = { ...defaultDeps, ...deps };
        set({ root });
        let host: PluginHost | null = null;
        try {
          const bridge = createWorkspaceBridge(appWorkspace, paneFor(gen));
          host = await createHost(root, getFileName(root), bridge);
          if (gen !== generation) {
            await host.shutdown();
            return;
          }
          const current: Session = { host, unsubscribe: wire(gen, host) };
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

    refresh: () => runAction("Refreshing plugins", (current) => current.host.refresh()),

    notifyExternal: async (kind, absPath) => {
      const current = session;
      const root = get().root;
      const snapshot = current?.host.getSnapshot();
      if (!current || !root || !snapshot?.trusted || !snapshot.booted) return;
      const path = toVaultPath(root, absPath);
      if (path === null) return;
      try {
        await current.host.app.vault.notifyExternal(kind, path);
      } catch (e) {
        console.error("[plugins] notifyExternal failed:", e);
      }
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
