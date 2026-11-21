// Types of the built-in feature host (SPECs/builtin-plugins-spec.md section 6). Only the
// contribution points that have a host today are accepted by `defineFeature`; the others are in
// the spec's list and are rejected with a clear error until their registry exists.
import type { ComponentType } from "react";
import type { CommandContext } from "@/components/command-palette/commands";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { IconSvgElement } from "@hugeicons/react";
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import type { DirEntry } from "@/types/fs";
import type { Keybinding } from "@/lib/keybindings/registry";
import type { FeatureSecrets } from "@/stores/feature-secrets-store";
import type { PaletteCommandSource } from "./palette";
import type { ServiceContribution } from "./services";
import type { SlotContribution } from "./slots";
import type { WorkspaceListenerContribution } from "./workspace-events";

export type Dispose = () => void;

/** The contribution points whose `feature.json` entry is a plain list of ids. */
export type ContributionIdPoint =
  | "docks"
  | "sidebarPanels"
  | "sidebarActions"
  | "statusItems"
  | "overlays"
  | "fileTreeDecorations"
  | "beforeSave";

/** The static facts in `src-tauri/src/features/<id>/feature.json` that the web side may read. */
export interface FeatureManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  enabledByDefault?: boolean;
  /** Activation events: `onStartup`, `onWorkspaceOpen`, `onFileKind:<kind>`, ... */
  activation?: string[];
  /** Shown in Settings > Features so users see what the feature costs. */
  memory?: { level: "low" | "medium" | "high"; note: string };
  /** Service ids the feature registers (`contributes.services`). */
  provides?: string[];
  /** Points of other features (or `core.*`) this feature adds behaviour to (ADR 2026-11-20). */
  extends?: string[];
  /** Per extended point, what stops when the feature is off (shown in Settings > Features). */
  offNotes?: Record<string, string>;
  rust?: { commands?: string[]; events?: string[]; hooks?: string[] };
  /** Only the part the settings UI reads; the rest of `contributes` is the loader's. The id lists
   *  (`docks`, `sidebarPanels`, ...) name what the web half registers; a contract test ties them. */
  contributes?: {
    secrets?: FeatureSecretDecl[];
    menus?: Partial<Record<MenuSurface, string[]>>;
  } & Partial<Record<ContributionIdPoint, string[]>>;
}

/** `contributes.secrets` of `feature.json`: the key is `features.<id>.<name>`. */
export interface FeatureSecretDecl {
  key: string;
  label: string;
  description?: string;
}

/** Everything a feature registers while active; `dispose` tears it down in reverse order. */
export interface DisposableStore {
  add(dispose: Dispose): Dispose;
  dispose(): void;
  readonly size: number;
}

export interface FeatureContext {
  readonly id: string;
  /** Owned by the feature: disposed on deactivate. */
  readonly disposables: DisposableStore;
  /** `<id>:<name>` events; the listener is removed on deactivate. */
  listen<T = unknown>(name: string, fn: (payload: T) => void): Dispose;
  /** The feature's own declared secrets; Rust refuses a key another feature (or nobody) declares. */
  readonly secrets: FeatureSecrets;
}

export interface CommandContribution {
  /** `<feature id>.<name>`. */
  id: string;
  label: string;
  description?: string;
  when?: (ctx: CommandContext) => boolean;
  keepOpen?: boolean;
  /** Runs after the feature has activated (the first call activates it). */
  run: (ctx: CommandContext, feature: FeatureContext) => void | Promise<void>;
}

export interface KeybindingContribution extends Omit<Keybinding, "run" | "phase" | "category"> {
  category?: Keybinding["category"];
  run: (feature: FeatureContext, e: KeyboardEvent) => void | Promise<void>;
}

export interface EditorExtensionContribution {
  /** `<feature id>.<name>`. */
  id: string;
  when?: () => boolean;
  /** A dynamic import: not called until an editor needs the extension. */
  load: () => Promise<Extension>;
}

/** Where a feature can add context-menu items, and what the surface hands the feature. One key
 *  per surface in `contributes.menus` and in the one menu registry (`lib/features/menus.ts`). */
export interface MenuSurfaces {
  /** Right-click in the editor body at `event`. */
  "editor-body": [view: EditorView, event: MouseEvent];
  /** Right-click on a file row of the sidebar (tree, Pinned and Recents). */
  "sidebar-file": [entry: DirEntry];
  /** Right-click on a folder row of the sidebar. */
  "sidebar-folder": [entry: DirEntry];
  /** The "New …" section of the sidebar menus (after New Note and New Folder), for the folder
   *  the new file goes in (absolute path): a folder row, or the vault root on the empty area. */
  "sidebar-create": [folder: string];
  /** Right-click on a multi-selection of the sidebar. */
  "sidebar-bulk": [paths: readonly string[]];
  /** Right-click on a tab that shows a file (`path` is absolute). */
  "editor-tab": [path: string];
}
export type MenuSurface = keyof MenuSurfaces;

export interface MenuContribution<S extends MenuSurface = MenuSurface> {
  /** `<feature id>.<name>`. */
  id: string;
  /** Items for the right-click; empty when the feature has nothing to offer there. */
  items: (...args: MenuSurfaces[S]) => MenuItemSpec[] | Promise<MenuItemSpec[]>;
}

/** A pane docked at the right edge (the agent pane). The layout shows the open dock with the
 *  highest `priority`, or the plugin pane when none is open, and reserves `width()` for it. */
export interface DockContribution {
  /** `<feature id>.<name>`. */
  id: string;
  /** Higher wins when more than one dock is open. */
  priority: number;
  isOpen: () => boolean;
  /** Width of the column in pixels while open. */
  width: () => number;
  /** Called when another pane opens over this one. */
  close: () => void;
  /** Notifies when `isOpen` or `width` may have changed. */
  subscribe: (listener: () => void) => Dispose;
  /** A dynamic import: the pane's chunk loads when the dock first opens. */
  load: () => Promise<ComponentType>;
}

/** A page in the Settings sidebar, contributed by a feature (the Agent section). Shown only while
 *  the feature is on; the component is a dynamic import, so its chunk loads when the page opens. */
export interface SettingsSectionContribution {
  /** Sidebar id (also the remembered selection); must not repeat a core section's id. */
  id: string;
  label: string;
  /** Sidebar position among all sections (core ones have fixed orders, `settings-sections.ts`). */
  order: number;
  load: () => Promise<{ default: ComponentType }>;
  /** The sidebar group: the feature's own "Features" group by default, or the "Community plugins"
   *  group (the Obsidian host's pages, which keep their place after the Features group). */
  group?: "Community plugins";
  /** Hidden when no workspace is open (the page belongs to a vault). */
  requiresWorkspace?: boolean;
  /** A small count next to the label (plugin updates). Re-register the section to change it. */
  badge?: number;
  /** A plain button after the last group while this page is in the sidebar ("Browse plugins..."). */
  footer?: { label: string; run: () => void };
}

/** A panel in the left sidebar next to Files (a feature's own list or tree). Shown only while the
 *  feature is on; the component is a dynamic import, so its chunk loads when the panel is first
 *  selected, and it renders inside the feature's error boundary. */
export interface SidebarPanelContribution {
  /** `<feature id>.<name>`. */
  id: string;
  label: string;
  icon: IconSvgElement;
  /** Position in the panel switcher; Files is core and always first. Ties break on `id`. */
  order: number;
  load: () => Promise<ComponentType>;
}

/** A button in the sidebar header toolbar. */
export interface SidebarActionContribution {
  /** `<feature id>.<name>`. */
  id: string;
  label: string;
  icon: IconSvgElement;
  /** Position among the toolbar buttons, left to right. Ties break on `id`. */
  order: number;
  /** Runs after the feature has activated (the first click activates it). */
  run: (feature: FeatureContext) => void | Promise<void>;
}

/** What a status item component receives: the note the footer belongs to. */
export interface StatusItemProps {
  filePath: string;
}

/** An item in the document footer, after the built-in word and character counts. */
export interface StatusItemContribution {
  /** `<feature id>.<name>`. */
  id: string;
  /** Position among the footer items, left to right. Ties break on `id`. */
  order: number;
  load: () => Promise<ComponentType<StatusItemProps>>;
}

/** A component mounted once at the app root while the feature is on (a global dialog, such as the
 *  plugin browser). It renders nothing until its own state opens it, inside the feature's error
 *  boundary, and is unmounted with the feature. */
export interface OverlayContribution {
  /** `<feature id>.<name>`. */
  id: string;
  load: () => Promise<ComponentType>;
}

/** A badge at the end of a sidebar tree row: an icon with a tooltip. Core draws it (one look for
 *  every feature); the feature only says whether and what. */
export interface FileTreeBadge {
  /** Tooltip and accessible name. */
  label: string;
  icon: IconSvgElement;
  /** A CSS color for the icon (a `var(--token)`); the muted default when absent. */
  color?: string;
  testId?: string;
}

/** A badge per sidebar tree entry (the agent's project badge on a project folder). */
export interface FileTreeDecorationContribution {
  /** `<feature id>.<name>`. */
  id: string;
  /** A React hook, called once per rendered row from a component of its own, so it may read
   *  stores; sync (rows render at once), so keep its module small. `null` draws nothing. */
  useBadge: (entry: DirEntry) => FileTreeBadge | null;
}

/** Work done to a note just before the save engine reads it (`lib/features/before-save.ts`). */
export interface BeforeSaveContribution {
  /** `<feature id>.<name>`. */
  id: string;
  /** `path` is the note's absolute path. Dispatch to the editor showing it (the write that
   *  follows carries the edit); never write the file. May be async; a throw is reported to the
   *  feature's health and the save goes on. */
  run: (path: string) => void | Promise<void>;
}

/** Palette commands computed each time the palette opens (a source of dynamic commands). */
export interface CommandSourceContribution {
  /** `<feature id>.<name>`. */
  id: string;
  /** Called while the palette is open; return only what can run now. */
  list: PaletteCommandSource["list"];
}

export interface IpcRequestContribution {
  /** `<feature id>.<name>`. */
  id: string;
  /** The socket command this answers: `<feature id>:<name>`, a name the feature's Rust
   *  `Feature::ipc_commands` declares. */
  topic: string;
  /** Runs in the window the `writer` CLI asked, after the feature is activated. The answer goes
   *  back to the CLI: JSON, and never note text beyond what the command is meant to return. */
  handle: (payload: unknown, feature: FeatureContext) => unknown | Promise<unknown>;
}

export interface Contributions {
  commands?: readonly CommandContribution[];
  keybindings?: readonly KeybindingContribution[];
  editorExtensions?: readonly EditorExtensionContribution[];
  menus?: { [S in MenuSurface]?: readonly MenuContribution<S>[] };
  docks?: readonly DockContribution[];
  settingsSection?: SettingsSectionContribution;
  sidebarPanels?: readonly SidebarPanelContribution[];
  sidebarActions?: readonly SidebarActionContribution[];
  statusItems?: readonly StatusItemContribution[];
  overlays?: readonly OverlayContribution[];
  /** Badges on sidebar tree rows (`lib/features/file-tree.ts`). */
  fileTreeDecorations?: readonly FileTreeDecorationContribution[];
  /** Work done to a note before it is saved (`lib/features/before-save.ts`). */
  beforeSave?: readonly BeforeSaveContribution[];
  /** Components mounted in named places of core UI (`lib/features/slots.ts`). */
  slots?: readonly SlotContribution[];
  commandSources?: readonly CommandSourceContribution[];
  /** Listeners for what core tells features about the workspace (`workspace-events.ts`). */
  workspaceListeners?: readonly WorkspaceListenerContribution[];
  /** What this window answers to the feature's `ipc_commands` over the CLI socket
   *  (`ipc-requests.ts`). */
  ipcRequests?: readonly IpcRequestContribution[];
  /** Typed capabilities other code finds through `getService` (`services.ts`). */
  services?: readonly ServiceContribution[];
  // Declared by the spec, no host registry yet (lands with its first pilot).
  settingsBlocks?: Record<string, ComponentType>;
}

export interface FeatureDefinition {
  /** Same string as feature.json `id` and the Tauri plugin name. */
  id: string;
  contributes?: Contributions;
  /** Runs on first use of any contribution. May dynamic-import heavy modules. */
  activate?: (ctx: FeatureContext) => void | Dispose | Promise<void | Dispose>;
  /** Extra teardown beyond `ctx.disposables`; rarely needed. */
  deactivate?: () => void;
}

export type FeatureState = "registered" | "activating" | "active" | "deactivating" | "failed";
