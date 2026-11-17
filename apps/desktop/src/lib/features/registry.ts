// The built-in feature host: `defineFeature` declares a feature, `featureHost` registers its
// static contributions and activates it lazily.
//
//   registered --first use of a contribution / activate()--> activating --> active
//   active --deactivate()--> registered      (disposes what activation created; can start again)
//   activating, throws --> failed            (contributions removed, error logged, terminal)
//   unregister()                             (deactivate + drop every contribution: the "switched off" path)
//
// "Not activated" means not loaded: a command or keybinding is a few bytes of data until it is used,
// and `activate` (where heavy modules are imported) runs on the first use only.
import { keybindings } from "@/lib/keybindings/registry";
import { logger } from "@/lib/logger";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { featureSecrets } from "@/stores/feature-secrets-store";
import { featureEventName } from "./events";
import { assertFeatureId, ownerOf } from "./id";
import { recordFailure } from "./health";
import { editorExtensionContributions } from "./editor-extensions";
import { dockContributions } from "./docks";
import { menuContributions, menuKey } from "./menus";
import { featurePaletteCommands } from "./palette";
import { settingsSectionContributions } from "./settings-sections";
import { sidebarActionContributions, sidebarPanelContributions } from "./sidebar";
import { statusItemContributions } from "./status-items";
import type {
  Dispose,
  DisposableStore,
  FeatureContext,
  FeatureDefinition,
  FeatureState,
  MenuSurface,
} from "./types";

export function defineFeature<T extends FeatureDefinition>(def: T): T {
  assertFeatureId(def.id);
  const c = def.contributes ?? {};
  for (const point of ["settingsBlocks"] as const) {
    if (c[point] !== undefined) {
      throw new Error(`feature ${def.id}: contribution point "${point}" has no host yet`);
    }
  }
  const ids = [
    ...(c.commands ?? []),
    ...(c.keybindings ?? []),
    ...(c.editorExtensions ?? []),
    ...Object.values(c.menus ?? {}).flat(),
    ...(c.docks ?? []),
    ...(c.sidebarPanels ?? []),
    ...(c.sidebarActions ?? []),
    ...(c.statusItems ?? []),
  ].map((x) => x.id);
  for (const id of ids) {
    if (!id.startsWith(`${def.id}.`)) {
      throw new Error(`feature ${def.id}: contribution id "${id}" must start with "${def.id}."`);
    }
  }
  return def;
}

export function createDisposableStore(onError: (e: unknown) => void = () => {}): DisposableStore {
  const items: Dispose[] = [];
  return {
    add(dispose) {
      items.push(dispose);
      return dispose;
    },
    dispose() {
      for (const d of items.splice(0).reverse()) {
        try {
          d();
        } catch (e) {
          onError(e);
        }
      }
    },
    get size() {
      return items.length;
    },
  };
}

interface Entry {
  def: FeatureDefinition;
  state: FeatureState;
  ctx: FeatureContext;
  disposables: DisposableStore;
  pending?: Promise<void>;
  error?: unknown;
}

export interface FeatureHostDeps {
  onError?: (id: string, phase: string, error: unknown) => void;
  /** Counts a failure toward the session limit (`stores/feature-health-store.ts`). */
  onFailure?: (id: string, boundary: string) => void;
  listen?: typeof tauriListen;
}

export function createFeatureHost({
  onError = (id, phase, error) =>
    logger.error("app", `feature ${id} ${phase} failed: ${String(error)}`, { plugin: id, phase }),
  onFailure = recordFailure,
  listen = tauriListen,
}: FeatureHostDeps = {}) {
  const entries = new Map<string, Entry>();

  /** A failure of the feature's own code: logged, and counted toward the session limit. */
  function fail(id: string, boundary: string, error: unknown) {
    onError(id, boundary, error);
    onFailure(id, boundary);
  }

  function makeContext(id: string, disposables: DisposableStore): FeatureContext {
    return {
      id,
      disposables,
      secrets: featureSecrets(id),
      listen(name, fn) {
        let un: Dispose | undefined;
        let disposed = false;
        listen<never>(featureEventName(id, name), (e) => fn(e.payload as never)).then(
          (u) => (disposed ? u() : (un = u)),
          (e) => onError(id, "listen", e),
        );
        return disposables.add(() => {
          disposed = true;
          un?.();
        });
      },
    };
  }

  function removeContributions(id: string) {
    featurePaletteCommands.removeOwner(ownerOf(id));
    keybindings.removeOwner(ownerOf(id));
    editorExtensionContributions.removeOwner(ownerOf(id));
    menuContributions.removeOwner(ownerOf(id));
    dockContributions.removeOwner(ownerOf(id));
    settingsSectionContributions.removeOwner(ownerOf(id));
    sidebarPanelContributions.removeOwner(ownerOf(id));
    sidebarActionContributions.removeOwner(ownerOf(id));
    statusItemContributions.removeOwner(ownerOf(id));
  }

  /** First use of a contribution: activate, then run it. A failure is logged, never thrown at a key press. */
  function whenActive(id: string, run: () => void | Promise<void>): void {
    host
      .activate(id)
      .then(run)
      .catch((e) => fail(id, "command", e));
  }

  const host = {
    /** Adds the static contributions. Throws (and registers nothing) on a duplicate id or a key conflict. */
    register(def: FeatureDefinition): void {
      if (entries.has(def.id)) throw new Error(`feature ${def.id} is already registered`);
      const disposables = createDisposableStore((e) => onError(def.id, "dispose", e));
      const entry: Entry = {
        def,
        state: "registered",
        ctx: makeContext(def.id, disposables),
        disposables,
      };
      const o = ownerOf(def.id);
      try {
        for (const c of def.contributes?.commands ?? []) {
          featurePaletteCommands.add(c.id, {
            owner: o,
            id: c.id,
            label: c.label,
            description: c.description ?? "Command",
            when: c.when,
            keepOpen: c.keepOpen,
            run: (ctx) => whenActive(def.id, () => c.run(ctx, entry.ctx)),
          });
        }
        for (const k of def.contributes?.keybindings ?? []) {
          keybindings.add(o, {
            ...k,
            category: k.category ?? "Feature",
            run: (e) => whenActive(def.id, () => k.run(entry.ctx, e)),
          });
        }
        for (const x of def.contributes?.editorExtensions ?? []) {
          editorExtensionContributions.add(x.id, { ...x, owner: o });
        }
        for (const [surface, items] of Object.entries(def.contributes?.menus ?? {})) {
          for (const m of items) {
            menuContributions.add(menuKey(surface as MenuSurface, m.id), {
              ...m,
              surface: surface as MenuSurface,
              owner: o,
            });
          }
        }
        for (const d of def.contributes?.docks ?? []) {
          dockContributions.add(d.id, { ...d, owner: o });
        }
        for (const p of def.contributes?.sidebarPanels ?? []) {
          sidebarPanelContributions.add(p.id, { ...p, owner: o });
        }
        for (const a of def.contributes?.sidebarActions ?? []) {
          sidebarActionContributions.add(a.id, {
            ...a,
            owner: o,
            run: () => whenActive(def.id, () => a.run(entry.ctx)),
          });
        }
        for (const x of def.contributes?.statusItems ?? []) {
          statusItemContributions.add(x.id, { ...x, owner: o });
        }
        const section = def.contributes?.settingsSection;
        if (section) settingsSectionContributions.add(section.id, { ...section, owner: o });
      } catch (e) {
        removeContributions(def.id);
        throw e;
      }
      entries.set(def.id, entry);
    },

    /** Idempotent; concurrent callers share one activation. Rejects when activation failed. */
    activate(id: string): Promise<void> {
      const entry = entries.get(id);
      if (!entry) return Promise.reject(new Error(`feature ${id} is not registered`));
      if (entry.state === "active") return Promise.resolve();
      if (entry.state === "failed") return Promise.reject(entry.error);
      if (entry.pending) return entry.pending;
      entry.state = "activating";
      entry.pending = (async () => {
        try {
          const dispose = await entry.def.activate?.(entry.ctx);
          if (dispose) entry.disposables.add(dispose);
          entry.state = "active";
        } catch (e) {
          entry.state = "failed";
          entry.error = e;
          entry.disposables.dispose();
          removeContributions(id);
          fail(id, "activate", e);
          throw e;
        } finally {
          entry.pending = undefined;
        }
      })();
      return entry.pending;
    },

    /** Frees what activation created; the contributions stay, so the next use activates again. */
    async deactivate(id: string): Promise<void> {
      const entry = entries.get(id);
      if (!entry) return;
      await entry.pending?.catch(() => {});
      if (entry.state !== "active") return;
      entry.state = "deactivating";
      try {
        entry.def.deactivate?.();
      } catch (e) {
        onError(id, "deactivate", e);
      }
      entry.disposables.dispose();
      entry.state = "registered";
    },

    /** Deactivate and drop every contribution (the feature is switched off). */
    async unregister(id: string): Promise<void> {
      await host.deactivate(id);
      removeContributions(id);
      entries.delete(id);
    },

    state: (id: string): FeatureState | undefined => entries.get(id)?.state,
    isActive: (id: string): boolean => entries.get(id)?.state === "active",
    list: (): string[] => [...entries.keys()],
  };
  return host;
}

export const featureHost = createFeatureHost();
