// Secrets store: the single write path between Settings > Secrets and the OS credential store.
// It holds secret NAMES only. Values go in through `save` (write-only) and are never kept here.
// After a write it mirrors the change into the running plugin host's cache (`syncSecret`) so a
// plugin's getSecret/SecretComponent sees it without a restart.
import { create } from "zustand";
import { tauriSecretsClient, type SecretsClient } from "@/lib/secrets-client";
import { emitSecretChanged, emitSecretsReady } from "@/lib/features/workspace-events";

const messageOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^IO error:\s*/i, "");

interface SecretsState {
  ids: readonly string[];
  /** "error" = the credential store could not be read (`error` says why). */
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Last failed set/delete. */
  actionError: string | null;
  busy: boolean;

  refresh: () => Promise<void>;
  /** Creates or replaces a secret. Resolves true on success. */
  save: (id: string, value: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

let client: SecretsClient = tauriSecretsClient;
/** Test seam. */
export function setSecretsClient(next: SecretsClient): void {
  client = next;
}

export const useSecretsStore = create<SecretsState>((set, get) => {
  let seq = 0;
  async function write(run: () => Promise<void>, mirror: () => void): Promise<boolean> {
    if (get().busy) return false;
    set({ busy: true, actionError: null });
    try {
      await run();
      mirror();
    } catch (e) {
      set({ busy: false, actionError: messageOf(e) });
      await get().refresh();
      return false;
    }
    set({ busy: false });
    await get().refresh();
    return true;
  }
  return {
    ids: [],
    status: "idle",
    error: null,
    actionError: null,
    busy: false,

    refresh: async () => {
      const mine = ++seq;
      if (get().status !== "ready") set({ status: "loading", error: null });
      try {
        const ids = await client.listIds();
        if (mine === seq) set({ ids, status: "ready", error: null });
        // The Rust side has the document now, so a host that hydrated empty can fill its cache.
        await emitSecretsReady();
      } catch (e) {
        if (mine === seq) set({ status: "error", error: messageOf(e) });
      }
    },
    save: (id, value) =>
      write(
        () => client.set(id, value),
        () => void emitSecretChanged(id, value),
      ),
    remove: (id) =>
      write(
        () => client.delete(id),
        () => void emitSecretChanged(id, null),
      ),
  };
});
