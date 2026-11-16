// `app.secretStorage` (Obsidian's keychain API, sync). Plugins such as Copilot refuse to run key
// features, and raise unhandled rejections at startup, when it is absent. The public API stays
// synchronous (plugins call getSecret inside onload): reads come from an in-memory cache that
// `hydrate` fills once from the OS credential store (Rust `plugin_secrets`), and writes update the
// cache first, then go to the store on a serial chain so they never reorder. Nothing is written
// to disk, localStorage or a plugin's data.json by the host.
//
// Failures are explicit, never swallowed: they are recorded in the plugin error log and warned
// on the console, and the in-memory value stays so the plugin keeps working for the app run.
import { recordPluginError } from "../error-log";

/** Obsidian's rule for secret ids: lowercase letters, digits and dashes. The Rust command
 *  `secrets_set` (Settings > Secrets) enforces the same rule. */
export const SECRET_ID_RE = /^[a-z0-9-]+$/;
export const isValidSecretId = (id: string): boolean => SECRET_ID_RE.test(id);

export interface SecretBackend {
  secretsLoad(): Promise<Record<string, string>>;
  secretSet(id: string, secret: string): Promise<void>;
  secretDelete(id: string): Promise<void>;
}

export class SecretStorage {
  private readonly secrets = new Map<string, string>();
  /** Ids the plugin wrote or deleted since construction: hydrate must not clobber them. */
  private readonly touched = new Set<string>();
  private backend: SecretBackend | null = null;
  private hydrating: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  getSecret(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  setSecret(id: string, secret: string): void {
    this.secrets.set(id, secret);
    this.touched.add(id);
    this.enqueue(`set:${id}`, (b) => b.secretSet(id, secret));
  }

  deleteSecret(id: string): void {
    this.secrets.delete(id);
    this.touched.add(id);
    this.enqueue(`delete:${id}`, (b) => b.secretDelete(id));
  }

  /**
   * Mirrors a change the Settings > Secrets page already persisted (`value` null = deleted) into
   * the cache so a running plugin sees it, without a second backend write.
   */
  applyExternal(id: string, value: string | null): void {
    if (value === null) this.secrets.delete(id);
    else this.secrets.set(id, value);
    this.touched.add(id);
  }

  listSecrets(): string[] {
    return [...this.secrets.keys()];
  }

  /**
   * Loads the persisted secrets once (idempotent: later calls share the first promise) and
   * attaches the backend for write-through. Never rejects: on failure the storage stays
   * memory-only for this run. Writes made before it finished win over loaded values.
   */
  hydrate(backend: SecretBackend): Promise<void> {
    this.hydrating ??= this.doHydrate(backend);
    return this.hydrating;
  }

  private async doHydrate(backend: SecretBackend): Promise<void> {
    // Attach first so writes made while the load is in flight are persisted too.
    this.backend = backend;
    try {
      const loaded = await backend.secretsLoad();
      for (const [id, value] of Object.entries(loaded)) {
        if (!this.touched.has(id)) this.secrets.set(id, value);
      }
    } catch (e) {
      this.report("hydrate", e);
    }
  }

  private enqueue(what: string, run: (b: SecretBackend) => Promise<void>): void {
    const backend = this.backend;
    if (!backend) return; // no backend (yet or ever): memory-only
    this.writes = this.writes.then(() => run(backend).catch((e) => this.report(what, e)));
  }

  private report(phase: string, e: unknown): void {
    console.warn(`[plugin] secretStorage ${phase} failed; secrets stay in memory only:`, e);
    recordPluginError("secretStorage", phase, e);
  }

  /** Resolves when every queued backend write has settled (tests, shutdown). */
  flush(): Promise<void> {
    return this.writes;
  }
}
