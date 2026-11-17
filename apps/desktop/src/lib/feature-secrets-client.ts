// Client for a built-in feature's secrets (Settings > Features and `ctx.secrets`). The scope check
// (the feature's manifest declares the key) is in Rust: `features::secrets`. Only `get` returns a
// value, and only to the feature that owns the key; the settings UI uses `keysSet` and never `get`.
// Tests fake `FeatureSecretsClient`; the default uses Tauri's `invoke`.
import { invoke } from "@tauri-apps/api/core";

export interface FeatureSecretsClient {
  /** The feature's declared keys that hold a value. */
  keysSet(id: string): Promise<string[]>;
  get(id: string, key: string): Promise<string | null>;
  set(id: string, key: string, secret: string): Promise<void>;
  delete(id: string, key: string): Promise<void>;
}

export const tauriFeatureSecretsClient: FeatureSecretsClient = {
  keysSet: (id) => invoke("feature_secret_keys_set", { id }),
  get: (id, key) => invoke("feature_secret_get", { id, key }),
  set: (id, key, secret) => invoke("feature_secret_set", { id, key, secret }),
  delete: (id, key) => invoke("feature_secret_delete", { id, key }),
};
