// The light bridge between the feature's lifetime and the chat store, which is heavy and loads
// lazily with the pane. The feature's `activate` attaches its `ctx` here; the store registers how to
// wire itself to that `ctx` (its store subscriptions) and how to reset (unsubscribe from the
// runtime, save and drop the chats). Whatever the order the two arrive in, the store is wired
// while the feature is active and reset when it deactivates, so a turned-off agent keeps no
// `agent:event` listener and no subscription, and a turned-on one starts clean. Importing this
// file never loads the store.
import type { Dispose, FeatureContext } from "@/lib/features/types";

export interface AgentStoreHooks {
  wire(ctx: FeatureContext): void;
  reset(): void;
}

let hooks: AgentStoreHooks | null = null;
let attached: FeatureContext | null = null;

/** The feature activated: wire the store (if loaded) and reset it when the feature deactivates. */
export function attachAgentStore(ctx: FeatureContext): Dispose {
  attached = ctx;
  hooks?.wire(ctx);
  return ctx.onDispose(() => {
    attached = null;
    hooks?.reset();
  });
}

/** Test seam: wires the store to a bare `ctx` (no feature host in the test) once. */
export function attachAgentStoreForTests(): void {
  if (attached) return;
  const bare = {
    subscribe: (store: { subscribe: (l: never) => Dispose }, fn: never) => store.subscribe(fn),
    onDispose: (fn: Dispose) => fn,
  } as unknown as FeatureContext;
  attachAgentStore(bare);
}

/** The store module loaded: wire it now when the feature is active. */
export function registerAgentStore(h: AgentStoreHooks): void {
  hooks = h;
  if (attached) h.wire(attached);
}
