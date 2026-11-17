// Types of the built-in feature host (SPECs/builtin-plugins-spec.md section 6). Only the
// contribution points that have a host today are accepted by `defineFeature`; the others are in
// the spec's list and are rejected with a clear error until their registry exists.
import type { ComponentType } from "react";
import type { CommandContext } from "@/components/command-palette/commands";
import type { Keybinding } from "@/lib/keybindings/registry";

export type Dispose = () => void;

/** The static facts in `src-tauri/src/features/<id>/feature.json` that the web side may read. */
export interface FeatureManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  enabledByDefault?: boolean;
  rust?: { commands?: string[]; events?: string[] };
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

export interface Contributions {
  commands?: readonly CommandContribution[];
  keybindings?: readonly KeybindingContribution[];
  // Declared by the spec, no host registry yet (each lands with its first pilot).
  settingsBlocks?: Record<string, ComponentType>;
  sidebar?: readonly unknown[];
  docks?: readonly unknown[];
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
