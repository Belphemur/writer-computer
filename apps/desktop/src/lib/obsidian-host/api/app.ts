// Adapted from opensidian (GPL-3.0-or-later).
// `App`: the object a plugin receives as `this.app`. It owns the vault, metadata cache,
// workspace and the host services; it is created once per PluginHost.
import { SecretStorage } from "./secret-storage";
import { parseFrontmatter, serializeFile } from "@/lib/frontmatter";
import {
  type CommandRegistry,
  Keymap,
  Scope,
  type HostServices,
  type Plugin,
  type PluginManifest,
  type RegisteredCommand,
} from "./core";
import { parseYaml, stringifyYaml } from "./functions";
import type { Modal } from "./ui";
import { MetadataCache, Vault, type TAbstractFile, type TFile, type VaultIo } from "./vault";
import { detachedBridge, Workspace, type WorkspaceBridge } from "./views";

export interface AppDeps {
  io: VaultIo;
  services: HostServices;
  bridge?: WorkspaceBridge;
}

export class FileManager {
  constructor(private app: App) {}

  renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    return this.app.vault.rename(file, newPath);
  }
  trashFile(file: TAbstractFile): Promise<void> {
    return this.app.vault.trash(file, false);
  }
  getNewFileParent(_sourcePath: string): ReturnType<Vault["getRoot"]> {
    return this.app.vault.getRoot();
  }
  /** Reads the note, hands `fn` the parsed frontmatter object, writes back what `fn` left. */
  async processFrontMatter(file: TFile, fn: (frontmatter: any) => void): Promise<void> {
    await this.app.vault.process(file, (raw) => {
      const parsed = parseFrontmatter(raw);
      const fm = (parsed.frontmatter ? (parseYaml(parsed.frontmatter) as any) : null) ?? {};
      fn(fm);
      const yaml = stringifyYaml(fm).replace(/\n$/, "");
      return serializeFile(Object.keys(fm).length > 0 ? yaml : null, parsed.body);
    });
  }
}

function commandsFacade(registry: () => CommandRegistry) {
  return {
    executeCommandById: (id: string): boolean => registry().execute(id),
    findCommand: (id: string): RegisteredCommand | undefined => registry().get(id),
    listCommands: (): RegisteredCommand[] => registry().list(),
    /** Snapshot keyed by command id (Obsidian exposes a plain object; consumers accept a Map too). */
    get commands(): Record<string, RegisteredCommand> {
      return Object.fromEntries(
        registry()
          .list()
          .map((c) => [c.id, c]),
      );
    },
  };
}

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  workspace: Workspace;
  fileManager: FileManager;
  keymap = new Keymap();
  scope = new Scope();
  lastEvent: Event | null = null;
  appId: string;
  /** Open Modals; the host closes them when a plugin is disabled. */
  modals = new Set<Modal>();

  /** Plugin instances currently loaded, by id (filled by the PluginHost). */
  plugins: {
    plugins: Record<string, Plugin>;
    /** Manifests of the loaded plugins, by id. */
    manifests: Record<string, PluginManifest>;
    /** Ids of the loaded (enabled and running) plugins. */
    readonly enabledPlugins: Set<string>;
    getPlugin(id: string): Plugin | null;
  } = {
    plugins: {},
    manifests: {},
    get enabledPlugins() {
      return new Set(Object.keys(this.plugins));
    },
    getPlugin(id) {
      return this.plugins[id] ?? null;
    },
  };

  /** Minimal Settings facade; `openRequested` is how the host learns a plugin asked for a tab. */
  setting = {
    openRequested: null as ((tabId: string | null) => void) | null,
    open: (): void => this.setting.openRequested?.(null),
    close: (): void => {},
    openTabById: (id: string): void => this.setting.openRequested?.(id),
  };

  /** Sync cache over the OS credential store; the loader hydrates it before any plugin runs. */
  secretStorage = new SecretStorage();

  /** Undocumented in the d.ts but plugins feature-detect these (Copilot, command palettes). */
  commands = commandsFacade(() => this.services.commands);

  constructor(
    public services: HostServices,
    deps: AppDeps,
  ) {
    this.vault = new Vault(deps.io);
    this.metadataCache = new MetadataCache(this.vault);
    this.workspace = new Workspace(this, deps.bridge ?? detachedBridge);
    this.fileManager = new FileManager(this);
    this.appId = `writer-${deps.io.basePath}`;
    services.commands.setEditorProvider(() => this.workspace.getEditorContext());
    services.addSweeper((owner) => {
      this.workspace.removeOwner(owner);
      // Modals carry no owner; closing all of them on a plugin disable is the safe choice.
      for (const m of Array.from(this.modals)) m.close();
    });
  }

  /** Builds the vault index and starts the metadata cache. Idempotent per call. */
  async start(): Promise<void> {
    await this.vault.load();
    this.metadataCache.start();
    void this.metadataCache
      .indexAll()
      .catch((e) => console.error("[plugin] metadata indexing failed:", e));
  }

  isDarkMode(): boolean {
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  }

  loadLocalStorage(key: string): unknown {
    try {
      const raw = localStorage.getItem(`${this.appId}:${key}`);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }
  saveLocalStorage(key: string, data: unknown): void {
    try {
      if (data === null || data === undefined) localStorage.removeItem(`${this.appId}:${key}`);
      else localStorage.setItem(`${this.appId}:${key}`, JSON.stringify(data));
    } catch (e) {
      console.error("[plugin] saveLocalStorage failed:", e);
    }
  }
}

/** Convenience: services + app in one call. */
export function createApp(deps: AppDeps): App {
  return new App(deps.services, deps);
}
