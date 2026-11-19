// Adapted from opensidian (GPL-3.0-or-later).
// `App`: the object a plugin receives as `this.app`. It owns the vault, metadata cache,
// workspace and the host services; it is created once per PluginHost.
import { SecretStorage } from "./secret-storage";
import { parseFrontmatter, serializeFile } from "@/lib/frontmatter";
import {
  PROPERTY_TYPE_IDS,
  PROPERTY_TYPES,
  typeKey,
  type PropertyType,
} from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import {
  type CommandRegistry,
  Keymap,
  type HostServices,
  type Plugin,
  type PluginManifest,
  type RegisteredCommand,
} from "./core";
import { electronModule } from "../node/misc";
import { registerPluginBasesView } from "./bases-view";
import { parseYaml, stringifyYaml } from "./functions";
import type { Modal } from "./ui";
import { MetadataCache, Vault, type TAbstractFile, type TFile, type VaultIo } from "./vault";
import { createCanvasPluginStub } from "./canvas-compat";
import { HotkeyManager } from "./hotkey-manager";
import { createViewRegistry, detachedBridge, Workspace, type WorkspaceBridge } from "./views";

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
  /** `[[link]]` (or `![[embed]]` for non-notes) text for `file`, as `fileToLinktext` shortens it. */
  generateMarkdownLink(file: TFile, sourcePath: string, subpath = "", alias?: string): string {
    const base = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    const target = `${base}${subpath}`;
    const embed = file.extension !== "md" ? "!" : "";
    return `${embed}[[${target}${alias ? `|${alias}` : ""}]]`;
  }
  /** A free `<attachments folder>/<name>.<ext>` path (the folder is the file's own, Writer has no attachment setting). */
  async getAvailablePathForAttachment(filename: string, sourcePath: string): Promise<string> {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    const slash = sourcePath.lastIndexOf("/");
    const dir = slash > 0 ? `${sourcePath.slice(0, slash)}/` : "";
    for (let i = 0; ; i++) {
      const candidate = `${dir}${stem}${i === 0 ? "" : ` ${i}`}${ext}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
  }
  /** Confirmation is the caller's UI in Writer; this always reports "go ahead". */
  async promptForDeletion(_file: TAbstractFile): Promise<boolean> {
    return true;
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
  scope = this.keymap.getRootScope();
  /** Undocumented: plugins register their default hotkeys here. */
  hotkeyManager = new HotkeyManager();
  /** Public `App.isMobile`: Writer is the desktop app. */
  isMobile = false;
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

  /**
   * Undocumented `internalPlugins`: Copilot's "Open Copilot folder" asks the File Explorer to
   * reveal a folder. Writer has no such plugin, so the folder is revealed in the system file
   * manager (the same `shell.showItemInFolder` a plugin gets from `require("electron")`).
   */
  internalPlugins = {
    /** Core plugins by id; only the Canvas stand-in Excalidraw's embedded notes reach for. */
    plugins: { canvas: createCanvasPluginStub(() => this) } as Record<string, unknown>,
    getPluginById: (id: string) =>
      id === "file-explorer"
        ? {
            enabled: true,
            instance: {
              revealInFolder: (item: { path: string }): void =>
                electronModule.shell.showItemInFolder(`${this.basePath}/${item.path}`),
            },
          }
        : undefined,
    getEnabledPluginById: (_id: string) => null,
  };

  /**
   * Undocumented `metadataTypeManager` (Tasks, Meta Bind, Dataview-adjacent plugins): the vault's
   * property types from Writer's one source (see `MetadataTypeManager`); `setType` records the
   * type in `.writer/property-types.json`.
   */
  metadataTypeManager = new MetadataTypeManager();

  private readonly basePath: string;

  /** Undocumented in the d.ts but plugins feature-detect these (Copilot, command palettes). */
  commands = commandsFacade(() => this.services.commands);

  /**
   * Undocumented `viewRegistry`: which view type opens a file extension, from the plugins'
   * `registerExtensions` calls (removed with the plugin).
   */
  viewRegistry = createViewRegistry(() => this.services.registrations.list());

  constructor(
    public services: HostServices,
    deps: AppDeps,
  ) {
    this.basePath = deps.io.basePath.replace(/\/+$/, "");
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
    await this.metadataTypeManager.load().catch(() => {}); // no index yet: types stay empty
    await this.vault.load();
    this.metadataCache.start();
    void this.metadataCache
      .indexAll()
      .catch((e) => console.error("[plugin] metadata indexing failed:", e));
  }

  /** `Plugin.registerBasesView`: the host side (see `bases-view.ts`). */
  registerBasesView(pluginId: string, viewId: string, registration: unknown): boolean {
    return registerPluginBasesView(this, pluginId, viewId, registration);
  }

  /** The accent colour of the active theme (`--interactive-accent`, else Writer's accent). */
  getAccentColor(): string {
    if (typeof document === "undefined") return "";
    const style = getComputedStyle(document.documentElement);
    return (
      style.getPropertyValue("--interactive-accent").trim() ||
      style.getPropertyValue("--accent").trim() ||
      "#7c3aed"
    );
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

export interface PropertyInfo {
  name: string;
  type: string;
  count: number;
}

/** Property registry over Writer's one property-type source (`app.metadataTypeManager`): the
 *  vault's recorded types (`.writer/property-types.json` over a read-only `.obsidian/types.json`),
 *  else inferred, as served by the backend and held in `usePropertyTypesStore`. `setType` writes
 *  Writer's record, never `.obsidian`. */
export class MetadataTypeManager {
  /** Loads the types; the host calls it before plugins start so the sync getters have data. */
  load(): Promise<void> {
    return usePropertyTypesStore.getState().load(true);
  }

  /** Keyed by lower-cased property name, like Obsidian. */
  getAllProperties(): Record<string, PropertyInfo> {
    const out: Record<string, PropertyInfo> = {};
    for (const [key, info] of Object.entries(usePropertyTypesStore.getState().byKey)) {
      out[key] = { name: info.key, type: info.obsidianType, count: info.count };
    }
    return out;
  }
  getAllPropertyInfos(): Record<string, PropertyInfo> {
    return this.getAllProperties();
  }
  getPropertyInfo(name: string): PropertyInfo | undefined {
    return this.getAllProperties()[typeKey(name)];
  }
  getAssignedType(name: string): string | null {
    const info = usePropertyTypesStore.getState().byKey[typeKey(name)];
    return info && info.source !== "inferred" ? info.obsidianType : null;
  }
  getAssignedWidget(name: string): string | null {
    return this.getAssignedType(name);
  }
  async setType(name: string, type: string): Promise<void> {
    // Writer-only types (`relationships`, `enum`, `object`, `url`): a plugin sees them as multitext / text and
    // cannot assign them.
    if (
      !(PROPERTY_TYPE_IDS as string[]).includes(type) ||
      PROPERTY_TYPES[type as PropertyType].writerOnly
    )
      throw new Error(`Unknown property type "${type}"`);
    await usePropertyTypesStore.getState().setType(name, type as PropertyType);
  }
  getTypeInfo(): undefined {
    return undefined;
  }
}
