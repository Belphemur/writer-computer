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
import { featureEventName } from "./events";
import { assertFeatureId } from "./id";
import { editorExtensionContributions } from "./editor-extensions";
import { dockContributions } from "./docks";
import { editorBodyMenuContributions } from "./menus";
import { featurePaletteCommands } from "./palette";
import type {
  Dispose,
  DisposableStore,
  FeatureContext,
  FeatureDefinition,
  FeatureState,
} from "./types";

export function defineFeature<T extends FeatureDefinition>(def: T): T {
  assertFeatureId(def.id);
  const c = def.contributes ?? {};
  for (const point of ["settingsBlocks", "sidebar"] as const) {
    if (c[point] !== undefined) {
      throw new Error(`feature ${def.id}: contribution point "${point}" has no host yet`);
    }
  }
  const ids = [
    ...(c.commands ?? []),
    ...(c.keybindings ?? []),
    ...(c.editorExtensions ?? []),
    ...(c.menus?.["editor-body"] ?? []),
    ...(c.docks ?? []),
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

const owner = (id: string) => `builtin:${id}`;

export interface FeatureHostDeps {
  onError?: (id: string, phase: string, error: unknown) => void;
  listen?: typeof tauriListen;
}

export function createFeatureHost({
  onError = (id, phase, error) =>
    logger.error("app", `feature ${id} ${phase} failed: ${String(error)}`, { plugin: id, phase }),
  listen = tauriListen,
}: FeatureHostDeps = {}) {
  const entries = new Map<string, Entry>();

  function makeContext(id: string, disposables: DisposableStore): FeatureContext {
    return {
      id,
      disposables,
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
    featurePaletteCommands.removeOwner(owner(id));
    keybindings.removeOwner(owner(id));
    editorExtensionContributions.removeOwner(owner(id));
    editorBodyMenuContributions.removeOwner(owner(id));
    dockContributions.removeOwner(owner(id));
  }

  /** First use of a contribution: activate, then run it. A failure is logged, never thrown at a key press. */
  function whenActive(id: string, run: () => void | Promise<void>): void {
    host
      .activate(id)
      .then(run)
      .catch((e) => onError(id, "contribution", e));
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
      const o = owner(def.id);
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
        for (const m of def.contributes?.menus?.["editor-body"] ?? []) {
          editorBodyMenuContributions.add(m.id, { ...m, owner: o });
        }
        for (const d of def.contributes?.docks ?? []) {
          dockContributions.add(d.id, { ...d, owner: o });
        }
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
          onError(id, "activate", e);
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
