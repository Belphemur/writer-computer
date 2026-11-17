// Types of the built-in feature host (SPECs/builtin-plugins-spec.md section 6). Only the
// contribution points that have a host today are accepted by `defineFeature`; the others are in
// the spec's list and are rejected with a clear error until their registry exists.
import type { ComponentType } from "react";
import type { CommandContext } from "@/components/command-palette/commands";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import type { Keybinding } from "@/lib/keybindings/registry";

export type Dispose = () => void;

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
  rust?: { commands?: string[]; events?: string[]; hooks?: string[] };
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

export interface EditorBodyMenuContribution {
  /** `<feature id>.<name>`. */
  id: string;
  items: (view: EditorView, event: MouseEvent) => MenuItemSpec[] | Promise<MenuItemSpec[]>;
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

export interface Contributions {
  commands?: readonly CommandContribution[];
  keybindings?: readonly KeybindingContribution[];
  editorExtensions?: readonly EditorExtensionContribution[];
  menus?: { "editor-body"?: readonly EditorBodyMenuContribution[] };
  docks?: readonly DockContribution[];
  // Declared by the spec, no host registry yet (each lands with its first pilot).
  settingsBlocks?: Record<string, ComponentType>;
  sidebar?: readonly unknown[];
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
