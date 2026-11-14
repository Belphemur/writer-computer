// Adapted from opensidian (GPL-3.0-or-later).
// PluginHost: boots trusted plugins, enables/disables them with full teardown, and keeps the
// status map the settings UI reads.
//
// How plugin code gets in (the page CSP has no `unsafe-eval`, no blob:):
//   1. load(id) injects <script src="writer-plugin://localhost/<id>/main.js?n=K">. Rust serves
//      it only for a trusted vault and an enabled id, wrapped as
//        __writerPluginDefine("<id>", function (module, exports, require, process, global, Buffer) { ... })
//      (`require`/`process`/`Buffer` are the Node surface in ./node/, also installed as globals while a
//      plugin is loaded)
//   2. __writerPluginDefine hands the factory to the load that is PENDING for that id; a define
//      nobody asked for is ignored.
//   3. the factory runs with a fresh module/exports and a per-plugin `require`. Any throw (a
//      refused require, a top-level bug, onload) fails THAT plugin: status "failed", the app
//      keeps running, everything it registered is swept.
import { createApp, type App } from "./api/app";
import { createHostServices, Plugin, type HostServices, type PluginManifest } from "./api/core";
import { createTauriVaultIo } from "./api/vault-io-tauri";
import type { VaultIo } from "./api/vault";
import type { WorkspaceBridge } from "./api/views";
import { tauriHostIpc, pluginScriptUrl, type HostIpc, type PluginsState } from "./ipc";
import { makeRequire } from "./modules";
import { createObsidianModule, type ObsidianModule } from "./obsidian-module";
import { installDomHelpers } from "./api/dom";
import { Buffer as NodeBuffer } from "./node/buffer";
import type { NodeIpc } from "./node/ipc";
import { getSharedProcess } from "./node/process";
import { ensureDeviceId } from "./node/device-id";
import { configuredAgentPaths, primeConfiguredAgentPaths } from "./node/agent-clis";
import { installExternalLinks } from "./node/external-links";
import { installNodeGlobals, preloadNodeRuntime } from "./node/runtime";
import { installObsidianTheme } from "./api/theme-compat";
import { installPopupGuard } from "./popup-guard";
import { recordPluginError } from "./error-log";
import { seedCopilotDataIfAbsent } from "./node/seed-plugin-data";
import { getNodeIpc } from "./node/state";
import { installGlobalFetch, pluginScopedFetch } from "./api/network";

export type PluginState = "enabled" | "failed" | "disabled";

export interface PluginStatus {
  state: PluginState;
  error?: string;
}

export interface HostSnapshot {
  trusted: boolean;
  booted: boolean;
  installed: readonly PluginManifest[];
  status: Readonly<Record<string, PluginStatus>>;
}

/** Injects the plugin script and resolves once it has been evaluated (or rejects). */
export type ScriptLoader = (url: string) => Promise<void>;

/** Where a plugin's styles.css lives while the plugin is enabled. */
export interface StyleSink {
  add(pluginId: string, css: string): () => void;
}

export interface PluginHostOptions {
  ipc?: HostIpc;
  io: VaultIo;
  bridge?: WorkspaceBridge;
  loadScript?: ScriptLoader;
  styles?: StyleSink;
  /** Backend of the Node surface (child processes, os info, fs probes). Default: Tauri. */
  nodeIpc?: NodeIpc;
  /** Where `process`/`Buffer`/`require` globals are installed. Default: `globalThis`. */
  nodeGlobalTarget?: object;
}

type DefineFactory = (...args: unknown[]) => void;

const PLUGIN_DIR_PREFIX = ".obsidian/plugins/";
const DEFINE_NAME = "__writerPluginDefine";
const PLUGIN_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const pendingDefines = new Map<string, (factory: DefineFactory) => void>();

/** Installs the global the Rust wrapper calls. Non-writable: plugin code cannot swap it. */
function installDefineGlobal(): void {
  const g = globalThis as Record<string, unknown>;
  if ((g[DEFINE_NAME] as { __writerHost?: boolean } | undefined)?.__writerHost) return;
  const define = Object.assign(
    (id: unknown, factory: unknown): void => {
      const resolve = typeof id === "string" ? pendingDefines.get(id) : undefined;
      if (!resolve || typeof factory !== "function") return; // unsolicited define: ignored
      pendingDefines.delete(id as string);
      resolve(factory as DefineFactory);
    },
    { __writerHost: true },
  );
  Object.defineProperty(g, DEFINE_NAME, {
    value: define,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

/** Default loader: a `<script>` element, removed once settled. */
export const domScriptLoader: ScriptLoader = (url) =>
  new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.onload = () => {
      s.remove();
      resolve();
    };
    s.onerror = () => {
      s.remove();
      reject(
        new Error("main.js refused or missing (restricted mode, not enabled, or not installed)"),
      );
    };
    s.src = url;
    document.head.appendChild(s);
  });

/** Default style sink: one `<style data-writer-plugin>` tag per plugin. */
export const domStyleSink: StyleSink = {
  add(pluginId, css) {
    const el = document.createElement("style");
    el.dataset.writerPlugin = pluginId;
    el.textContent = css;
    document.head.appendChild(el);
    return () => el.remove();
  },
};

interface PluginRecord {
  plugin: Plugin;
  removeStyle: (() => void) | null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PluginHost {
  readonly app: App;
  readonly services: HostServices;
  private readonly ipc: HostIpc;
  private readonly loadScript: ScriptLoader;
  private readonly styles: StyleSink;
  private readonly obsidian: ObsidianModule = createObsidianModule();
  private readonly records = new Map<string, PluginRecord>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private manifests = new Map<string, PluginManifest>();
  private enabledIds = new Set<string>();
  private statuses: Record<string, PluginStatus> = {};
  private trusted = false;
  private booted = false;
  private starting: Promise<void> | null = null;
  private seq = 0;
  private snapshot: HostSnapshot;
  private uninstallDom: (() => void) | null = null;
  private uninstallTheme: (() => void) | null = null;
  private uninstallFetch: (() => void) | null = null;
  private uninstallPopupGuard: (() => void) | null = null;
  private uninstallNode: (() => void) | null = null;
  private uninstallExternalLinks: (() => void) | null = null;
  private nodeReady: Promise<void> | null = null;
  private readonly io: VaultIo;
  private readonly options: PluginHostOptions;
  private loading = 0;

  constructor(options: PluginHostOptions) {
    this.options = options;
    this.io = options.io;
    this.ipc = options.ipc ?? tauriHostIpc;
    this.loadScript = options.loadScript ?? domScriptLoader;
    this.styles = options.styles ?? domStyleSink;
    this.services = createHostServices({
      read: async (id) => {
        const raw = await this.ipc.dataRead(id);
        if (raw === null || raw === undefined || raw.trim() === "") return null;
        try {
          return JSON.parse(raw) as unknown;
        } catch (e) {
          throw new Error(`${id}: data.json is not valid JSON (${messageOf(e)})`);
        }
      },
      write: (id, data) => this.ipc.dataWrite(id, JSON.stringify(data === undefined ? null : data)),
    });
    this.app = createApp({ io: options.io, services: this.services, bridge: options.bridge });
    this.snapshot = this.buildSnapshot();
    installDefineGlobal();
  }

  /** Convenience for the real app: Tauri-backed vault IO for the workspace at `root`. */
  static forWorkspace(root: string, name: string, bridge?: WorkspaceBridge): PluginHost {
    return new PluginHost({ io: createTauriVaultIo(root, name), bridge });
  }

  // ---------------------------------------------------------------- state (useSyncExternalStore-shaped)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): HostSnapshot => this.snapshot;

  getStatus(id: string): PluginStatus {
    return this.statuses[id] ?? { state: "disabled" };
  }

  getPlugin(id: string): Plugin | null {
    return this.records.get(id)?.plugin ?? null;
  }

  private buildSnapshot(): HostSnapshot {
    return {
      trusted: this.trusted,
      booted: this.booted,
      installed: [...this.manifests.values()],
      status: this.statuses,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of Array.from(this.listeners)) l();
  }

  private setStatus(id: string, status: PluginStatus): void {
    this.statuses = { ...this.statuses, [id]: status };
    this.publish();
  }

  private applyState(state: PluginsState): void {
    this.trusted = state.trusted;
    this.enabledIds = new Set(state.enabled);
    this.manifests = new Map(state.installed.map((i) => [i.id, { ...i.manifest, id: i.id }]));
    const next: Record<string, PluginStatus> = {};
    for (const id of this.manifests.keys()) next[id] = this.statuses[id] ?? { state: "disabled" };
    this.statuses = next;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Reads backend state. Plugins only load when the vault is trusted; otherwise nothing runs. */
  async boot(): Promise<void> {
    this.applyState(await this.ipc.state());
    this.booted = true;
    this.publish();
    if (!this.trusted) return;
    await this.ensureStarted();
    await this.loadEnabled();
  }

  /** Re-reads the installed list (after a store install/uninstall). Does not load anything. */
  async refresh(): Promise<void> {
    this.applyState(await this.ipc.state());
    this.publish();
  }

  async enable(id: string): Promise<void> {
    if (!this.manifests.has(id)) await this.refresh();
    if (!this.trusted)
      throw new Error("Plugins are disabled in restricted mode: trust this vault first");
    await this.ipc.setEnabled(id, true);
    this.enabledIds.add(id);
    await this.ensureStarted();
    await this.queue(id, () => this.load(id));
  }

  async disable(id: string): Promise<void> {
    await this.queue(id, async () => {
      await this.teardown(id);
      await this.ipc.setEnabled(id, false);
      this.enabledIds.delete(id);
      this.setStatus(id, { state: "disabled" });
    });
  }

  /** Revoking trust unloads every plugin; granting it loads the enabled ones. */
  async setTrust(trusted: boolean): Promise<void> {
    await this.ipc.setTrust(trusted);
    this.trusted = trusted;
    if (!trusted) {
      await Promise.all(
        [...this.records.keys()].map((id) =>
          this.queue(id, async () => {
            await this.teardown(id);
            this.setStatus(id, { state: "disabled" });
          }),
        ),
      );
      this.publish();
      return;
    }
    await this.refresh();
    await this.ensureStarted();
    await this.loadEnabled();
  }

  /** Unloads everything (window close, vault switch). Does not change what is enabled. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.records.keys()].map((id) => this.queue(id, () => this.teardown(id))),
    );
    this.app.metadataCache.dispose();
  }

  private ensureStarted(): Promise<void> {
    this.starting ??= this.app.start().catch((e) => {
      this.starting = null; // allow a retry
      throw e;
    });
    return this.starting;
  }

  private async loadEnabled(): Promise<void> {
    for (const id of this.manifests.keys()) {
      if (this.enabledIds.has(id)) await this.queue(id, () => this.load(id));
    }
  }

  /** Serializes enable/disable/load per plugin id. */
  private queue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.chains.set(id, run);
    return run;
  }

  private async load(id: string): Promise<void> {
    if (this.records.has(id)) return;
    const manifest = this.manifests.get(id);
    if (!manifest) {
      this.setStatus(id, { state: "failed", error: "not installed" });
      return;
    }
    this.loading++;
    try {
      // The Node surface must be seeded (os info, login PATH, sync-fs cache) before any plugin
      // script evaluates; it never rejects.
      await this.ensureNodeRuntime();
      // Plugins read secrets synchronously in onload: the cache must be filled first.
      await this.app.secretStorage.hydrate(this.ipc);
      await this.seedPluginData(id);
      await this.primeAgentPaths(id);
      this.installDom();
      const exports = await this.evaluate(id);
      const Ctor = resolvePluginClass(id, exports);
      const css = await this.readStyles(id);
      const plugin = new Ctor(this.app, { ...manifest, dir: `.obsidian/plugins/${id}` });
      // Recorded before onload so a throwing onload is torn down like any other failure.
      const record: PluginRecord = { plugin, removeStyle: css ? this.styles.add(id, css) : null };
      this.records.set(id, record);
      this.app.plugins.plugins[id] = plugin;
      this.app.plugins.manifests[id] = plugin.manifest;
      await plugin.loadAsync();
      this.setStatus(id, { state: "enabled" });
    } catch (e) {
      console.error(`[plugin] ${id} failed:`, e);
      recordPluginError(id, "load", e);
      await this.teardown(id);
      this.setStatus(id, { state: "failed", error: messageOf(e) });
    } finally {
      this.loading--;
      this.removeDomWhenIdle();
    }
  }

  /** Idempotent: removes everything the plugin put into the app. */
  private async teardown(id: string): Promise<void> {
    const record = this.records.get(id);
    this.records.delete(id);
    delete this.app.plugins.plugins[id];
    delete this.app.plugins.manifests[id];
    if (record) {
      try {
        record.plugin.unload();
      } catch (e) {
        console.error(`[plugin] ${id} unload threw:`, e);
        recordPluginError(id, "unload", e);
      }
      record.removeStyle?.();
    }
    this.services.sweep(id);
    // The prototype patches and globals plugins rely on live only while a plugin is loaded.
    this.removeDomWhenIdle();
  }

  /** Seeds Copilot's data.json on its first enable (never overwrites); failures are not fatal. */
  private async seedPluginData(id: string): Promise<void> {
    if (id !== "copilot") return;
    try {
      await seedCopilotDataIfAbsent({
        pluginId: id,
        dataExists: async () => ((await this.ipc.dataRead(id)) ?? "").trim() !== "",
        writeData: (json) => this.ipc.dataWrite(id, json),
        claudePath: await getNodeIpc()
          .which("claude")
          .catch(() => null),
        // Through the app's own localStorage API (vault-scoped key, JSON-encoded): that is what
        // Copilot's `getDeviceId` reads, so the deviceProfiles key we seed is the one it looks up.
        deviceId: ensureDeviceId({
          getItem: (k) => {
            const v = this.app.loadLocalStorage(k);
            return typeof v === "string" ? v : null;
          },
          setItem: (k, v) => this.app.saveLocalStorage(k, v),
        }),
      });
    } catch (e) {
      console.warn(`[plugin] ${id}: settings seed skipped: ${messageOf(e)}`);
      recordPluginError(id, "seed", e);
    }
  }

  /** Agent CLI paths a user configured earlier stay visible to the sync fs cache after a restart. */
  private async primeAgentPaths(id: string): Promise<void> {
    if (id !== "copilot") return;
    try {
      await primeConfiguredAgentPaths(configuredAgentPaths(await this.ipc.dataRead(id)));
    } catch (e) {
      console.warn(`[plugin] ${id}: configured agent paths not primed: ${messageOf(e)}`);
      recordPluginError(id, "prime-agent-paths", e);
    }
  }

  private ensureNodeRuntime(): Promise<void> {
    this.nodeReady ??= preloadNodeRuntime({
      ipc: this.options.nodeIpc,
      basePath: this.io.basePath,
    });
    return this.nodeReady;
  }

  private installDom(): void {
    // `process`/`Buffer`/`require` globals: bundled SDKs read the bare globals at module load.
    this.uninstallNode ??= installNodeGlobals(
      makeRequire("host", this.obsidian, { io: this.io, global: true }),
      this.options.nodeGlobalTarget,
    );
    if (typeof window === "undefined") return;
    this.uninstallDom ??= installDomHelpers();
    this.uninstallTheme ??= installObsidianTheme();
    this.uninstallFetch ??= installGlobalFetch();
    this.uninstallPopupGuard ??= installPopupGuard();
    this.uninstallExternalLinks ??= installExternalLinks();
  }

  private removeDomWhenIdle(): void {
    if (this.records.size > 0 || this.loading > 0) return;
    this.uninstallDom?.();
    this.uninstallDom = null;
    this.uninstallTheme?.();
    this.uninstallTheme = null;
    this.uninstallFetch?.();
    this.uninstallFetch = null;
    this.uninstallPopupGuard?.();
    this.uninstallPopupGuard = null;
    this.uninstallExternalLinks?.();
    this.uninstallExternalLinks = null;
    this.uninstallNode?.();
    this.uninstallNode = null;
  }

  private async readStyles(id: string): Promise<string> {
    try {
      return await this.ipc.readAsset(id, "styles");
    } catch {
      return ""; // styles.css is optional
    }
  }

  private evaluate(id: string): Promise<unknown> {
    if (!PLUGIN_ID_RE.test(id)) return Promise.reject(new Error("bad plugin id"));
    if (pendingDefines.has(id)) return Promise.reject(new Error("already loading"));
    return new Promise<unknown>((resolve, reject) => {
      pendingDefines.set(id, (factory) => {
        const module: { exports: unknown } = { exports: {} };
        try {
          factory.call(
            module.exports,
            module,
            module.exports,
            makeRequire(id, this.obsidian, { io: this.io }),
            getSharedProcess(),
            globalThis,
            NodeBuffer,
            Error,
            `${PLUGIN_DIR_PREFIX}${id}/main.js`,
            `${PLUGIN_DIR_PREFIX}${id}`,
            (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer ?? ArrayBuffer,
            pluginScopedFetch,
          );
          resolve(module.exports);
        } catch (e) {
          reject(e);
        }
      });
      this.loadScript(pluginScriptUrl(id, ++this.seq)).then(
        () => {
          // The define runs synchronously while the script evaluates, before onload fires.
          if (pendingDefines.delete(id))
            reject(new Error("main.js did not define a plugin (syntax error?)"));
        },
        (e: unknown) => {
          pendingDefines.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }
}

type PluginCtor = new (app: App, manifest: PluginManifest) => Plugin;

function resolvePluginClass(id: string, exports: unknown): PluginCtor {
  const candidate =
    exports && typeof exports === "object" && "default" in exports
      ? (exports as { default: unknown }).default
      : exports;
  if (typeof candidate !== "function" || !(candidate.prototype instanceof Plugin)) {
    throw new Error(`${id}: main.js does not export a class extending Plugin`);
  }
  return candidate as PluginCtor;
}
