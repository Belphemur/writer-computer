// Client for Settings > Secrets. Names only: no command returns a value to the UI, and the UI
// has no way to read one. Tests fake `SecretsClient`; the default uses Tauri's `invoke`.
import { invoke } from "@tauri-apps/api/core";

/** Obsidian's rule for secret ids: lowercase letters, digits and dashes. The Rust command
 *  `secrets_set` (Settings > Secrets) enforces the same rule; the plugin host's `SecretStorage`
 *  imports this one definition. */
export const SECRET_ID_RE = /^[a-z0-9-]+$/;
export const isValidSecretId = (id: string): boolean => SECRET_ID_RE.test(id);

export interface SecretsClient {
  listIds(): Promise<string[]>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export const tauriSecretsClient: SecretsClient = {
  listIds: () => invoke("secrets_list_ids"),
  set: (id, secret) => invoke("secrets_set", { id, secret }),
  delete: (id) => invoke("secrets_delete", { id }),
};
