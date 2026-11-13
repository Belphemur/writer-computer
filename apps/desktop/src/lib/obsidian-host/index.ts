// Public surface of the Obsidian plugin host. See README.md.
export { PluginHost, domScriptLoader, domStyleSink } from "./loader";
export type {
  HostSnapshot,
  PluginHostOptions,
  PluginState,
  PluginStatus,
  ScriptLoader,
  StyleSink,
} from "./loader";
export { tauriHostIpc, pluginScriptUrl } from "./ipc";
export type { HostIpc, InstalledPlugin, PluginAssetKind, PluginsState } from "./ipc";
export { createObsidianModule } from "./obsidian-module";
export type { ObsidianModule } from "./obsidian-module";
export { makeRequire, UnsupportedModuleError } from "./modules";
export type { RequireFn } from "./modules";
export {
  primeSyncFileContents,
  registerSyncProbePaths,
  setNodeIpc,
  setOpenExternal,
  tauriNodeIpc,
} from "./node";
export type { NodeIpc, NodeOsInfo, ProcEvent, ProcSpawnRequest, FsProbe } from "./node";

export { App, FileManager, createApp } from "./api/app";
export type { AppDeps } from "./api/app";
export {
  CommandRegistry,
  Component,
  Events,
  Keymap,
  Notice,
  OwnedRegistry,
  Plugin,
  Scope,
  createHostServices,
} from "./api/core";
export type {
  Command,
  EventRef,
  HostServices,
  Hotkey,
  PluginDataStore,
  PluginManifest,
  Registration,
  RegisteredCommand,
  RibbonItem,
  SettingTabEntry,
  SettingTabLike,
  StatusBarItem,
} from "./api/core";
export { createEl, installDomHelpers } from "./api/dom";
export {
  Platform,
  addIcon,
  debounce,
  getIcon,
  moment,
  normalizePath,
  parseYaml,
  requestUrl,
  setIcon,
  setMarkdownRenderer,
  stringifyYaml,
} from "./api/functions";
export { MarkdownRenderChild, MarkdownRenderer } from "./api/markdown";
export {
  ButtonComponent,
  DropdownComponent,
  FuzzySuggestModal,
  Menu,
  MenuItem,
  Modal,
  PluginSettingTab,
  Setting,
  SliderComponent,
  SuggestModal,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
} from "./api/ui";
export {
  DataAdapter,
  FileSystemAdapter,
  MetadataCache,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  getAllTags,
  parseNoteMetadata,
} from "./api/vault";
export type { CachedMetadata, VaultEntry, VaultIo, VaultStat } from "./api/vault";
export { createTauriVaultIo } from "./api/vault-io-tauri";
export {
  Editor,
  ItemView,
  MarkdownView,
  View,
  Workspace,
  WorkspaceLeaf,
  detachedBridge,
} from "./api/views";
export type { EditorBackend, LeafPlacement, WorkspaceBridge } from "./api/views";
