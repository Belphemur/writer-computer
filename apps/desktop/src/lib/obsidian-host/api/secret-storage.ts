// `app.secretStorage` (Obsidian's keychain API, sync). Plugins such as Copilot refuse to run key
// features, and raise unhandled rejections at startup, when it is absent. The public API stays
// synchronous (plugins call getSecret inside onload): reads come from an in-memory cache that
// `hydrate` fills once from the OS credential store (Rust `plugin_secrets`), and writes update the
// cache first, then go to the store on a serial chain so they never reorder. Nothing is written
// to disk, localStorage or a plugin's data.json by the host.
//
// Failures are explicit, never swallowed: they are recorded in the plugin error log and warned
// on the console, and the in-memory value stays so the plugin keeps working for the app run.
import { logger } from "@/lib/logger";
import { recordPluginError } from "../error-log";

/** `unavailable`: the credential store could not be read (denied prompt, locked keychain, backend
 *  error). Plugins then run without their keys until `retry` succeeds. */
export type SecretStatus =
  | { state: "idle" }
  | { state: "ready" }
  | { state: "unavailable"; reason: string };

const reasonOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^IO error:\s*/i, "");

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
  private current: SecretStatus = { state: "idle" };
  private readonly listeners = new Set<() => void>();
  private warned = false;
  /** Changes made while unavailable (null = delete). Not sent to the store, so a failed read can
   *  never lead to a partial overwrite; replayed by a successful `retry`. */
  private readonly pending = new Map<string, string | null>();

  get status(): SecretStatus {
    return this.current;
  }

  /** Notified when the status changes or a retry filled the cache. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  getSecret(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  setSecret(id: string, secret: string): void {
    this.secrets.set(id, secret);
    this.touched.add(id);
    if (this.deferWrite(id, secret)) return;
    this.enqueue(`set:${id}`, (b) => b.secretSet(id, secret));
  }

  deleteSecret(id: string): void {
    this.secrets.delete(id);
    this.touched.add(id);
    if (this.deferWrite(id, null)) return;
    this.enqueue(`delete:${id}`, (b) => b.secretDelete(id));
  }

  /** While unavailable a write fails clearly (logged, kept in memory) instead of being dropped. */
  private deferWrite(id: string, value: string | null): boolean {
    if (this.current.state !== "unavailable") return false;
    this.pending.set(id, value);
    this.report(
      `${value === null ? "delete" : "set"}:${id}`,
      new Error("the keychain is unavailable; the change is kept in memory until Retry succeeds"),
    );
    return true;
  }

  /**
   * Mirrors a change the Settings > Secrets page already persisted (`value` null = deleted) into
   * the cache so a running plugin sees it, without a second backend write.
   */
  applyExternal(id: string, value: string | null): void {
    if (value === null) this.secrets.delete(id);
    else this.secrets.set(id, value);
    this.touched.add(id);
    this.pending.delete(id);
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
    await this.load(backend);
  }

  /** Reads the store; sets the status. Never throws. */
  private async load(backend: SecretBackend): Promise<void> {
    try {
      const loaded = await backend.secretsLoad();
      for (const [id, value] of Object.entries(loaded)) {
        if (!this.touched.has(id)) this.secrets.set(id, value);
      }
      this.current = { state: "ready" };
    } catch (e) {
      const reason = reasonOf(e);
      this.current = { state: "unavailable", reason };
      this.report("hydrate", e);
      if (!this.warned) {
        this.warned = true;
        logger.warn(
          "plugin",
          `secret storage unavailable, plugins run without secrets: ${reason}`,
          {
            phase: "secrets",
          },
        );
      }
    }
    this.emit();
  }

  /**
   * Re-reads the store after an `unavailable` hydrate. On success the cache is filled (a later
   * `getSecret` sees the values), changes made meanwhile are written, and subscribers are told.
   * No-op once ready or before the first hydrate.
   */
  async retry(): Promise<SecretStatus> {
    const backend = this.backend;
    if (!backend || this.current.state !== "unavailable") return this.current;
    await this.load(backend);
    if (this.status.state === "ready") {
      for (const [id, value] of this.pending) {
        if (value === null) this.enqueue(`delete:${id}`, (b) => b.secretDelete(id));
        else this.enqueue(`set:${id}`, (b) => b.secretSet(id, value));
      }
      this.pending.clear();
    }
    return this.current;
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
