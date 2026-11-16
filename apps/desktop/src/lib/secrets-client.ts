// Client for Settings > Secrets. Names only: no command returns a value to the UI, and the UI
// has no way to read one. Tests fake `SecretsClient`; the default uses Tauri's `invoke`.
import { invoke } from "@tauri-apps/api/core";

export { isValidSecretId } from "@/lib/obsidian-host/api/secret-storage";

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
