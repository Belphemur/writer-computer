// `app.secretStorage` (Obsidian's keychain API, sync). Plugins such as Copilot refuse to run key
// features, and raise unhandled rejections at startup, when it is absent. Secrets live in memory
// ONLY for the app run: they are never written to disk, localStorage or a plugin's data.json.
// Persisting them needs an OS-keychain backend in Rust (not done; see the spec's open risks).

export class SecretStorage {
  private readonly secrets = new Map<string, string>();

  getSecret(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  setSecret(id: string, secret: string): void {
    this.secrets.set(id, secret);
  }

  deleteSecret(id: string): void {
    this.secrets.delete(id);
  }

  listSecrets(): string[] {
    return [...this.secrets.keys()];
  }
}
