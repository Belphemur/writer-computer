// Feature secrets store: the single write path for a built-in feature's secrets, shared by
// Settings > Features and `ctx.secrets`. It holds which declared keys are set, never a value:
// values go in through `save` (write-only) and come out only through `featureSecrets(id).get`
// to the owning feature.
import { create } from "zustand";
import { tauriFeatureSecretsClient, type FeatureSecretsClient } from "@/lib/feature-secrets-client";

const messageOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^IO error:\s*/i, "");

interface FeatureSecretsState {
  /** Feature id -> declared keys that hold a value. */
  keysSet: Readonly<Record<string, readonly string[]>>;
  /** Feature id -> last failed read or write. */
  errors: Readonly<Record<string, string>>;
  busy: boolean;

  refresh: (id: string) => Promise<void>;
  /** Creates or replaces a secret. Resolves true on success. */
  save: (id: string, key: string, value: string) => Promise<boolean>;
  remove: (id: string, key: string) => Promise<boolean>;
}

let client: FeatureSecretsClient = tauriFeatureSecretsClient;
/** Test seam. */
export function setFeatureSecretsClient(next: FeatureSecretsClient): void {
  client = next;
}

export const useFeatureSecretsStore = create<FeatureSecretsState>((set, get) => {
  const setError = (id: string, error: string | null) =>
    set((s) => {
      const { [id]: _, ...rest } = s.errors;
      return { errors: error === null ? rest : { ...rest, [id]: error } };
    });
  async function write(id: string, run: () => Promise<void>): Promise<boolean> {
    if (get().busy) return false;
    set({ busy: true });
    setError(id, null);
    let ok = true;
    try {
      await run();
    } catch (e) {
      ok = false;
      setError(id, messageOf(e));
    }
    set({ busy: false });
    await get().refresh(id);
    return ok;
  }
  return {
    keysSet: {},
    errors: {},
    busy: false,

    refresh: async (id) => {
      try {
        const keys = await client.keysSet(id);
        set((s) => ({ keysSet: { ...s.keysSet, [id]: keys } }));
      } catch (e) {
        setError(id, messageOf(e));
      }
    },
    save: (id, key, value) => write(id, () => client.set(id, key, value)),
    remove: (id, key) => write(id, () => client.delete(id, key)),
  };
});

/** What `ctx.secrets` is: the feature's own secrets, by declared key. Rust refuses any other key. */
export interface FeatureSecrets {
  get(key: string): Promise<string | null>;
  /** Rejects when the write failed (a key the manifest does not declare, a locked keychain or keyring). */
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function featureSecrets(id: string): FeatureSecrets {
  const store = useFeatureSecretsStore.getState;
  const orThrow = async (ok: Promise<boolean>) => {
    if (!(await ok)) throw new Error(store().errors[id] ?? `feature ${id}: secret write failed`);
  };
  return {
    get: (key) => client.get(id, key),
    set: (key, value) => orThrow(store().save(id, key, value)),
    delete: (key) => orThrow(store().remove(id, key)),
  };
}
